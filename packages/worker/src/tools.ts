import { checkCommandRun, commandProposal, recordHardDenial, reportCommandOutcome, reviewBeforeDispatch } from "./command-guard.js";
import { authorizeCommand, commandRepeatHash, extractHosts as execExtractHosts, isRepeatExemptCommand } from "@gongyuai/exec";
import { execRuntimeFor } from "./exec-runtime.js";
import { parseShellOutput } from "./tool-output.js";
import {
  buildInstallShellCommand,
  findInstalledBinary,
  invalidateBinaryHealth,
  resolveInstallPlan,
  validateToolInstallSpec,
  type InstallMethod,
} from "./tool-installer.js";
import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { appendFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AuthCapability, WorkerManifest } from "@gongyuai/contracts";
import { isBudgetHit, targetAllows } from "@gongyuai/contracts";
import { writeEvidenceFile, type HistoryStore } from "@gongyuai/history";

const CAPABILITY_RANK: Record<AuthCapability, number> = {
  observe: 0,
  scan: 1,
  "active-lab": 2,
  full: 3,
};


/**
 * P15-C2 — repeated-command circuit breaker.
 *
 * AutoRedTeam stops a loop after the same execution hash runs more than three
 * times. We keep the same idea but make the limit configurable and exempt
 * read-only polling. The counter lives in History, so it survives restarts and
 * covers shell / shell_job / PTY write / C2 task.
 */
export function repeatCommandLimit(): number {
  const raw = Number(process.env.GY_REPEAT_COMMAND_LIMIT ?? 4);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 4;
}

export function assertRepeatAllowed(
  ctx: ToolContext,
  command: string,
): number {
  if (isRepeatExemptCommand(command)) return 0;
  const hash = commandRepeatHash(command);
  const seen = ctx.history.commandAttemptCount(ctx.manifest.taskId, hash);
  const limit = repeatCommandLimit();
  if (seen >= limit) {
    throw new Error(
      `repeat-guard: 同一命令已执行 ${seen} 次（上限 ${limit}）。` +
        "改参数/换手法；确需重跑由操作员先 gy command-reset 再继续，不要重复爆破。",
    );
  }
  return ctx.history.recordCommandAttempt(ctx.manifest.taskId, hash);
}

/** True if task capability is at least `need`. */
export function capabilityAtLeast(
  have: AuthCapability | undefined,
  need: AuthCapability,
): boolean {
  const h = CAPABILITY_RANK[have ?? "observe"] ?? 0;
  return h >= CAPABILITY_RANK[need];
}

/**
 * Tool-surface gate by auth.capability ladder.
 * Host VPN/proxy mutations remain denied at every level.
 */
export function assertCapabilityAllows(
  manifest: WorkerManifest,
  action: "shell" | "install" | "asset_search" | "mcp-scan" | "mcp-active",
): void {
  // New tasks default to observe via schema; legacy manifests without the field keep full.
  const cap = manifest.auth.capability ?? "full";
  if (action === "shell" && !capabilityAtLeast(cap, "scan")) {
    throw new Error(
      `denied: shell requires auth.capability≥scan (have ${cap}); observe is read-only`,
    );
  }
  if (action === "install" && !capabilityAtLeast(cap, "scan")) {
    throw new Error(`denied: install_tool requires auth.capability≥scan (have ${cap})`);
  }
  if (action === "asset_search" && !capabilityAtLeast(cap, "scan")) {
    throw new Error(`denied: asset_search requires auth.capability≥scan (have ${cap})`);
  }
  if (action === "mcp-scan" && !capabilityAtLeast(cap, "scan")) {
    throw new Error(`denied: scan MCP requires auth.capability≥scan (have ${cap})`);
  }
  if (action === "mcp-active" && !capabilityAtLeast(cap, "active-lab")) {
    throw new Error(
      `denied: active MCP requires auth.capability≥active-lab (have ${cap})`,
    );
  }
}

/** Fallback when the manifest does not carry a per-server capability. */
const SCAN_MCP_IDS = new Set(["nmap", "httpx", "gobuster", "ffuf"]);

/**
 * P15 — per-MCP capability comes from mcp.json (`capability`), not a hardcoded
 * id list. The legacy set remains only for manifests without metadata.
 */
export function mcpActionForServer(
  serverId: string,
  manifest?: WorkerManifest,
): "mcp-scan" | "mcp-active" {
  const cfg =
    manifest?.mcpPool?.find((server) => server.id === serverId) ??
    manifest?.mcpServers?.find((server) => server.id === serverId);
  if (cfg?.capability === "active-lab" || cfg?.capability === "full") {
    return "mcp-active";
  }
  if (cfg?.capability === "scan" || cfg?.capability === "observe") {
    return "mcp-scan";
  }
  return SCAN_MCP_IDS.has(serverId) ? "mcp-scan" : "mcp-active";
}

export type ToolContext = {
  manifest: WorkerManifest;
  history: HistoryStore;
  usage: { toolCalls: number; installs: number };
};

/** Formal scope match (CIDR / wildcard / suffix / *) — see @gongyuai/contracts scope. */
export function hostInTargets(
  targets: string[],
  host: string,
  outOfScope: string[] = [],
): boolean {
  return targetAllows(targets, host, outOfScope);
}

export function extractHosts(command: string): string[] {
  return execExtractHosts(command).filter((h) => h !== "localhost" && h !== "127.0.0.1");
}

export function assertCommandAllowed(manifest: WorkerManifest, command: string): void {
  assertCapabilityAllows(manifest, "shell");
  const verdict = authorizeCommand(manifest.auth, command);
  if (verdict.allowed) return;
  if (verdict.klass === "host-network") {
    throw new Error(
      "denied: host network/VPN/proxy mutation is forbidden; connect lab VPN before the task",
    );
  }
  if (verdict.klass === "destructive") throw new Error("denied: destructive host command");
  const oos = verdict.outOfScopeHits[0];
  if (oos) throw new Error(`target host ${oos} not in task targets`);
  throw new Error(`denied: ${verdict.reason}`);
}

/**
 * Record one scope/capability decision before dispatch. Keep arguments and
 * credentials out of the audit metadata.
 */
export function gateTool<T>(
  ctx: ToolContext,
  tool: string,
  check: () => T,
  detail?: Record<string, unknown>,
): T {
  let authorized: T;
  try {
    authorized = check();
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    // Autonomous durable workers (`durableDb` present) receive localized tool_result errors
    // so the model can self-correct typos/flags without killing the whole task; only host-network
    // / destructive violations or unguided standalone callers escalate to supervisor pause.
    const isCriticalHostViolation =
      reason.includes("host network") || reason.includes("destructive");
    const isStandaloneCaller = !ctx.manifest.durableDb;
    if (
      ["shell", "install", "mcp"].includes(tool) &&
      (isCriticalHostViolation ||
        (isStandaloneCaller && (/^denied:/.test(reason) || reason.includes("not in task targets"))))
    ) {
      recordHardDenial(ctx.manifest, tool, reason);
    }
    ctx.history.recordToolGate(ctx.manifest.taskId, {
      tool,
      ok: false,
      reason: err instanceof Error ? err.message : String(err),
      detail,
    });
    throw err;
  }
  ctx.history.recordToolGate(ctx.manifest.taskId, { tool, ok: true, detail });
  return authorized;
}

/** Preserve the worker's existing tool-call limit and accounting semantics. */
export function chargeToolCall(ctx: ToolContext): void {
  ctx.usage.toolCalls += 1;
  if (isBudgetHit(ctx.usage.toolCalls, ctx.manifest.budget.maxToolCalls)) {
    throw new Error("maxToolCalls exceeded");
  }
}

const DEFAULT_SHELL_INLINE_BYTES = 4 * 1024;

function shellInlineBytes(): number {
  const limit = Number(process.env.GY_SHELL_INLINE_OUTPUT_BYTES);
  return Number.isSafeInteger(limit) && limit > 0 ? limit : DEFAULT_SHELL_INLINE_BYTES;
}

function previewShellOutput(bytes: Buffer, edgeBytes: number): string {
  if (bytes.length <= edgeBytes * 2) return bytes.toString("utf8");
  if (edgeBytes === 0) return "";

  // Move inward to UTF-8 character boundaries so neither preview cuts a character.
  let headEnd = edgeBytes;
  while ((bytes[headEnd]! & 0xc0) === 0x80) headEnd -= 1;
  let tailStart = bytes.length - edgeBytes;
  while ((bytes[tailStart]! & 0xc0) === 0x80) tailStart += 1;
  return `${bytes.toString("utf8", 0, headEnd)}\n…（省略 ${tailStart - headEnd} 字节）…\n${bytes.toString("utf8", tailStart)}`;
}

function recordShellOutput(
  evidenceRoot: string,
  audit: string,
  result: { stdout: string; stderr: string; truncated: boolean; timedOut: boolean; durationMs: number },
): { stdout: string; stderr: string } {
  mkdirSync(evidenceRoot, { recursive: true });
  if (!lstatSync(evidenceRoot).isDirectory()) throw new Error("invalid evidence directory");
  const directory = join(evidenceRoot, "exec");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (!lstatSync(directory).isDirectory()) throw new Error("invalid shell evidence directory");

  const base = `cmd-${randomUUID()}`;
  const privateFile = { mode: 0o600, flag: "wx" };
  const { stdout, stderr } = result;
  const stdoutBytes = Buffer.byteLength(stdout);
  const stderrBytes = Buffer.byteLength(stderr);
  const inlineBytes = shellInlineBytes();
  if (!result.truncated && stdoutBytes + stderrBytes <= inlineBytes) {
    writeFileSync(
      join(directory, `${base}.md`),
      `${audit}\n## stdout\n\n\`\`\`\n${stdout}\n\`\`\`\n\n## stderr\n\n\`\`\`\n${stderr}\n\`\`\`\n`,
      privateFile,
    );
    return { stdout, stderr };
  }

  const staging = mkdtempSync(join(directory, ".cmd-"));
  const status = `[shell] stdout=${stdoutBytes} B, stderr=${stderrBytes} B, timedOut=${result.timedOut}, durationMs=${result.durationMs}`;
  const capture = result.truncated ? `${status}\n[shell] 执行器已达到采集上限，证据仅包含已捕获文本。` : status;
  const descriptions: string[] = [];
  const shown = { stdout: capture, stderr: "" };
  const previewEdge = Math.floor(Math.min(inlineBytes, 1024) / 4);
  try {
    for (const stream of ["stdout", "stderr"] as const) {
      if (!result[stream]) continue;
      const bytes = Buffer.from(result[stream], "utf8");
      const fileName = `${stream}.txt`;
      const path = `exec/${base}/${fileName}`;
      const sha256 = createHash("sha256").update(bytes).digest("hex");
      writeFileSync(join(staging, fileName), bytes, privateFile);
      const description = `${stream} ${bytes.length} B · SHA-256 ${sha256} · ${path}`;
      descriptions.push(description);
      const preview = previewShellOutput(bytes, previewEdge);
      const reference = `[shell] ${description}\n可从任务证据下载，按字节区间分段查阅。`;
      shown[stream] = [shown[stream], reference, preview].filter(Boolean).join("\n");
    }
    writeFileSync(join(staging, "command.md"), `${audit}\n${capture}\n${descriptions.join("\n")}\n`, privateFile);
    renameSync(staging, join(directory, base));
    return shown;
  } catch (error) {
    rmSync(staging, { recursive: true, force: true });
    throw error;
  }
}

export async function runShell(
  ctx: ToolContext,
  command: string,
  timeoutMs = 120_000,
): Promise<{
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut?: boolean;
  durationMs?: number;
}> {
  const verdict = gateTool(ctx, "shell", () => {
    assertCommandAllowed(ctx.manifest, command);
    chargeToolCall(ctx);
    const verdict = authorizeCommand(ctx.manifest.auth, command);
    assertRepeatAllowed(ctx, command);
    return verdict;
  });
  checkCommandRun(ctx.manifest);
  const proposal = {
    ...commandProposal("shell", command, [], true),
    summary: verdict.hosts.length ? verdict.hosts.join(",").slice(0, 80) : "本地命令",
    command,
    hosts: verdict.hosts,
    need: verdict.need,
  };
  const ticketId = ctx.manifest.commandFence ? await reviewBeforeDispatch(ctx.manifest, proposal) : null;
  checkCommandRun(ctx.manifest);
  const runtime = execRuntimeFor(ctx.manifest);
  try {
    const result = await runtime.run(command, {
      cwd: ctx.manifest.workspaceDir,
      timeoutMs,
      maxBytes: 400_000,
    });
    if (ticketId) {
      reportCommandOutcome(
        ctx.manifest,
        ticketId,
        (result.exitCode ?? 1) === 0 && !result.timedOut,
        (result.stdout || result.stderr || "").slice(0, 200),
      );
    }
    const output = recordShellOutput(
      ctx.manifest.evidenceDir,
      `# 命令执行\n\n- 命令：\`${command}\`\n- 目录：${ctx.manifest.workspaceDir}\n- 退出码：${result.exitCode}\n- 超时：${result.timedOut}\n- 耗时：${result.durationMs}ms\n- 范围：${verdict.reason}\n`,
      result,
    );
    const parserNote = parseShellOutput(ctx, command, result.stdout);
    return {
      exitCode: result.exitCode ?? (result.timedOut ? 124 : 1),
      stdout: `${output.stdout}${parserNote}`,
      stderr: output.stderr,
      timedOut: result.timedOut,
      durationMs: result.durationMs,
    };
  } finally {
    /* 运行时按运行复用，不在这里关闭 */
  }
}

export function writeEvidence(
  ctx: ToolContext,
  relativePath: string,
  content: string,
): string {
  return writeEvidenceFile(ctx.manifest.evidenceDir, relativePath, content);
}

export async function installTool(
  ctx: ToolContext,
  spec: { name: string; method?: InstallMethod | "which"; package?: string },
): Promise<{ ok: boolean; detail: string; alreadyPresent?: boolean; method?: string; path?: string }> {
  const name = spec.name.trim();
  const rawMethod: InstallMethod =
    spec.method && spec.method !== "which" ? spec.method : "auto";
  const initialPkg = spec.package?.trim() || name;
  try {
    gateTool(ctx, "install", () => {
      assertCapabilityAllows(ctx.manifest, "install");
      validateToolInstallSpec(name, initialPkg, rawMethod);
    }, { name: name.slice(0, 80), method: rawMethod });
  } catch (err) {
    return {
      ok: false,
      detail: err instanceof Error ? err.message : String(err),
    };
  }

  // 0) Kali-first zero-redundant-download check: reuse existing binary or Kali alias.
  const existing = findInstalledBinary(name);
  if (existing.found) {
    invalidateBinaryHealth(name);
    ctx.history.recordInstall(ctx.manifest.taskId, name, {
      alreadyPresent: true,
      binary: existing.binary,
      path: existing.path,
      alias: existing.alias,
    });
    return {
      ok: true,
      alreadyPresent: true,
      path: existing.path,
      detail: existing.alias
        ? `${name} already satisfied by Kali-integrated ${existing.binary} at ${existing.path} (no download needed)`
        : `${name} already present at ${existing.path}`,
    };
  }

  // Check install budget only when an actual install is required.
  try {
    gateTool(ctx, "install", () => {
      if (isBudgetHit(ctx.usage.installs + 1, ctx.manifest.budget.maxInstalls)) {
        throw new Error("maxInstalls exceeded");
      }
    }, { name: name.slice(0, 80), phase: "budget" });
  } catch (err) {
    return {
      ok: false,
      detail: err instanceof Error ? err.message : String(err),
    };
  }

  const plan = resolveInstallPlan({
    name,
    package: spec.package,
    method: rawMethod,
  });
  try {
    validateToolInstallSpec(name, plan.package, plan.method);
  } catch (err) {
    return {
      ok: false,
      detail: err instanceof Error ? err.message : String(err),
    };
  }

  if (ctx.manifest.commandFence) {
    await reviewBeforeDispatch(ctx.manifest, {
      ...commandProposal("install_tool", name, [plan.method, plan.package]),
      command: `${plan.method} install ${plan.package}`,
      hosts: [],
      need: "scan",
    });
  }

  ctx.usage.installs += 1;

  // Explicit mock / test stub mode only (never silently stub on real macOS).
  if (ctx.manifest.mock || process.env.GY_ALLOW_STUB_INSTALL === "1") {
    const binDir = join(ctx.manifest.workspaceDir, ".bin");
    mkdirSync(binDir, { recursive: true });
    const stub = join(binDir, name);
    writeFileSync(
      stub,
      `#!/usr/bin/env bash\necho "${name} stub (dev install)"\nexit 0\n`,
      { mode: 0o755 },
    );
    const pathFile = join(ctx.manifest.workspaceDir, ".path");
    appendFileSync(pathFile, `${binDir}\n`);
    process.env.PATH = `${binDir}:${process.env.PATH ?? ""}`;
    invalidateBinaryHealth(name);
    ctx.history.recordInstall(ctx.manifest.taskId, name, {
      method: "stub",
      path: stub,
    });
    writeEvidence(
      ctx,
      `installs/${name}.txt`,
      `installed stub for ${name} at ${stub}\n`,
    );
    return { ok: true, method: "stub", path: stub, detail: `stub-installed ${name} (dev)` };
  }

  const cmd = buildInstallShellCommand(plan.method, plan.package);
  const result = spawnSync("bash", ["-lc", cmd], {
    encoding: "utf8",
    timeout: 600_000,
  });
  const ok = (result.status ?? 1) === 0;
  invalidateBinaryHealth(name);
  const verify = findInstalledBinary(name);
  const present = verify.found;
  ctx.history.recordInstall(ctx.manifest.taskId, name, {
    method: plan.method,
    source: plan.source,
    package: plan.package,
    ok: ok && present,
    path: verify.found ? verify.path : undefined,
    stdout: (result.stdout ?? "").slice(-2000),
    stderr: (result.stderr ?? "").slice(-2000),
  });
  writeEvidence(
    ctx,
    `installs/${name}.txt`,
    `method=${plan.method}\nsource=${plan.source}\npackage=${plan.package}\nok=${ok && present}\n${result.stdout}\n${result.stderr}\n`,
  );
  return {
    ok: ok && present,
    method: plan.method,
    path: verify.found ? verify.path : undefined,
    detail: present
      ? `installed ${name} via ${plan.method} (${plan.source}) at ${verify.path}`
      : `install failed (${plan.method} ${plan.package}): ${(result.stderr || result.stdout || "").slice(0, 600)}`,
  };
}

/** 北京时间戳 */
export function beijingStamp(d = new Date(), withMilliseconds = false): string {
  const t = new Date(d.getTime() + 8 * 3600_000);
  return t.toISOString().slice(0, withMilliseconds ? 23 : 16).replace("T", " ");
}

/** Mirror progress into dataDir/worker.log so the Logs tab matches Live. */
function mirrorProgressToWorkerLog(workspaceDir: string, stampedLine: string): void {
  try {
    appendFileSync(join(workspaceDir, "..", "worker.log"), `[progress] ${stampedLine}\n`);
  } catch {
    /* log mirror must not break the loop */
  }
}

export function appendProgress(workspaceDir: string, line: string): void {
  const stamp = beijingStamp(new Date(), true);
  const stamped = `${stamp} ${line}`;
  const path = join(workspaceDir, "PROGRESS.md");
  if (!existsSync(path)) {
    writeFileSync(path, `# 执行进度\n\n`);
  }
  appendFileSync(path, `- ${stamped}\n`);
  mirrorProgressToWorkerLog(workspaceDir, stamped);
}

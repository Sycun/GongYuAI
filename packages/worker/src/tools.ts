import { checkCommandRun, commandProposal, recordHardDenial, reportCommandOutcome, reviewBeforeDispatch } from "./command-guard.js";
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync, existsSync, appendFileSync } from "node:fs";
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

/** Core recon MCP ids allowed at scan; the rest need active-lab+. */
const SCAN_MCP_IDS = new Set(["nmap", "httpx", "gobuster", "ffuf"]);

export function mcpActionForServer(serverId: string): "mcp-scan" | "mcp-active" {
  return SCAN_MCP_IDS.has(serverId) ? "mcp-scan" : "mcp-active";
}

export type ToolContext = {
  manifest: WorkerManifest;
  history: HistoryStore;
  usage: { toolCalls: number; installs: number };
};

/** Host-network / proxy mutations — always denied (lab VPN must be pre-connected). */
const HOST_NETWORK_DENY =
  /\b(route\s+(add|delete|change|flush)|ip\s+route\s+(add|del|change|replace)|networksetup\b|scutil\s+--nc|pfctl\b|iptables\b|ip6tables\b|nft\s+|sysctl\s+.*\bnet\.|launchctl\s+(load|unload).*vpn|osascript[^\n]*Viscosity|viscosity\s+(connect|disconnect)|set\s+system\s+proxy|networksetup\s+-set(web|secureweb|socks)proxy|mitmproxy\s+--mode\s+local|proxychains|tsocks\b)/i;

const DESTRUCTIVE_DENY =
  /\b(rm\s+-rf\s+\/|mkfs\.|dd\s+if=.*of=\/dev\/|diskutil\s+erase|shutdown\b|reboot\b|halt\b)\b/i;

/** Formal scope match (CIDR / wildcard / suffix / *) — see @gongyuai/contracts scope. */
export function hostInTargets(
  targets: string[],
  host: string,
  outOfScope: string[] = [],
): boolean {
  return targetAllows(targets, host, outOfScope);
}

export function extractHosts(command: string): string[] {
  const hosts = new Set<string>();
  const patterns = [
    /https?:\/\/([^/\s:]+)/gi,
    /\b(?:curl|wget|nc|ncat|nmap|ffuf|httpx)\b[^\n]*?\s(?:-H\s+\S+\s+)*['"]?(?:https?:\/\/)?(\d{1,3}(?:\.\d{1,3}){3})(?:[:/\s'"]|$)/gi,
    /\b(?:curl|wget)\s+[^\n]*?\s(\d{1,3}(?:\.\d{1,3}){3})(?:[:/\s]|$)/gi,
  ];
  for (const re of patterns) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(command))) {
      const host = m[1]?.toLowerCase();
      if (host && host !== "localhost" && host !== "127.0.0.1") hosts.add(host);
    }
  }
  return [...hosts];
}

export function assertCommandAllowed(manifest: WorkerManifest, command: string): void {
  assertCapabilityAllows(manifest, "shell");
  if (HOST_NETWORK_DENY.test(command)) {
    throw new Error(
      "denied: host network/VPN/proxy mutation is forbidden; connect lab VPN before the task",
    );
  }
  if (DESTRUCTIVE_DENY.test(command)) {
    throw new Error("denied: destructive host command");
  }

  const targets = manifest.auth.targets;
  if (!targets.length) {
    throw new Error("auth.targets is empty");
  }

  const hosts = extractHosts(command);
  const outOfScope = manifest.auth.outOfScope ?? [];
  for (const host of hosts) {
    if (!hostInTargets(targets, host, outOfScope)) {
      throw new Error(`target host ${host} not in auth.targets`);
    }
  }
}

/**
 * Record one authorization decision before dispatch. Keep arguments and
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
    if (["shell", "install", "mcp"].includes(tool) && (/^denied:/.test(reason) || reason.includes("not in auth.targets"))) {
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

export async function runShell(
  ctx: ToolContext,
  command: string,
  timeoutMs = 120_000,
): Promise<{
  exitCode: number;
  stdout: string;
  stderr: string;
}> {
  gateTool(ctx, "shell", () => {
    assertCommandAllowed(ctx.manifest, command);
    chargeToolCall(ctx);
  });
  checkCommandRun(ctx.manifest);
  const literal = /^(printf|echo) ([a-zA-Z0-9_.]+)$/.exec(command);
  if (literal) return { exitCode: 0, stdout: literal[2]! + (literal[1] === "echo" ? "\n" : ""), stderr: "" };
  if (command === "pwd") return { exitCode: 0, stdout: ctx.manifest.workspaceDir + "\n", stderr: "" };
  const action = commandProposal("shell", command, [], true);
  const ticketId = await reviewBeforeDispatch(ctx.manifest, action);
  checkCommandRun(ctx.manifest);
  if (!action.localProbe) throw new Error("命令需要人工处理");
  const [name, flag] = action.localProbe.split(" ");
  const result = spawnSync(name === "date" ? "/bin/date" : "/usr/bin/uname", [flag!], {
    cwd: ctx.manifest.workspaceDir, encoding: "utf8", timeout: timeoutMs,
    env: { PATH: "/usr/bin:/bin", LC_ALL: "C" },
  });
  if (ticketId) {
    reportCommandOutcome(ctx.manifest, ticketId, (result.status ?? 1) === 0,
      (result.stdout ?? result.stderr ?? "").trim());
  }
  return {
    exitCode: result.status ?? 1,
    stdout: (result.stdout ?? "").slice(0, 32_000),
    stderr: (result.stderr ?? "").slice(0, 8_000),
  };
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
  spec: { name: string; method?: "apt" | "which"; package?: string },
): Promise<{ ok: boolean; detail: string }> {
  const name = spec.name;
  const pkg = spec.package ?? name;
  const method = spec.method ?? "apt";
  try {
    gateTool(ctx, "install", () => {
      assertCapabilityAllows(ctx.manifest, "install");
      if (!/^[\w][\w.+-]*$/.test(name) || !/^[\w][\w.+:~=-]*$/.test(pkg)) {
        throw new Error("invalid tool or package name");
      }
      if (isBudgetHit(ctx.usage.installs + 1, ctx.manifest.budget.maxInstalls)) {
        throw new Error("maxInstalls exceeded");
      }
    }, { name: name.slice(0, 80) });
  } catch (err) {
    return {
      ok: false,
      detail: err instanceof Error ? err.message : String(err),
    };
  }
  await reviewBeforeDispatch(ctx.manifest, commandProposal("install_tool", name, [method, pkg]));
  const which = spawnSync("bash", ["-lc", `command -v ${JSON.stringify(name)}`], {
    encoding: "utf8",
  });
  if ((which.status ?? 1) === 0) {
    ctx.history.recordInstall(ctx.manifest.taskId, name, { alreadyPresent: true });
    return { ok: true, detail: `${name} already present at ${which.stdout.trim()}` };
  }

  ctx.usage.installs += 1;
  let cmd: string;
  if (method === "apt") {
    cmd = `sudo DEBIAN_FRONTEND=noninteractive apt-get update -qq && sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq ${pkg}`;
  } else {
    return { ok: false, detail: `unknown install method ${method}` };
  }

  // Local/dev fallback: create a stub shim so smoke can proceed without root/apt
  if (ctx.manifest.mock || process.env.GY_ALLOW_STUB_INSTALL === "1" || process.platform === "darwin") {
    const binDir = join(ctx.manifest.workspaceDir, ".bin");
    mkdirSync(binDir, { recursive: true });
    const stub = join(binDir, name);
    writeFileSync(
      stub,
      `#!/usr/bin/env bash\necho \"${name} stub (dev install)\"\nexit 0\n`,
      { mode: 0o755 },
    );
    const pathFile = join(ctx.manifest.workspaceDir, ".path");
    appendFileSync(pathFile, `${binDir}\n`);
    process.env.PATH = `${binDir}:${process.env.PATH ?? ""}`;
    ctx.history.recordInstall(ctx.manifest.taskId, name, {
      method: "stub",
      path: stub,
    });
    writeEvidence(
      ctx,
      `installs/${name}.txt`,
      `installed stub for ${name} at ${stub}\n`,
    );
    return { ok: true, detail: `stub-installed ${name} (dev)` };
  }

  const result = spawnSync("bash", ["-lc", cmd], {
    encoding: "utf8",
    timeout: 600_000,
  });
  const ok = (result.status ?? 1) === 0;
  const verify = spawnSync("bash", ["-lc", `command -v ${JSON.stringify(name)}`], {
    encoding: "utf8",
  });
  const present = (verify.status ?? 1) === 0;
  ctx.history.recordInstall(ctx.manifest.taskId, name, {
    method,
    package: pkg,
    ok: ok && present,
    stdout: (result.stdout ?? "").slice(-2000),
    stderr: (result.stderr ?? "").slice(-2000),
  });
  writeEvidence(
    ctx,
    `installs/${name}.txt`,
    `method=${method}\nok=${ok && present}\n${result.stdout}\n${result.stderr}\n`,
  );
  return {
    ok: ok && present,
    detail: present
      ? `installed ${name}`
      : `install failed: ${result.stderr || result.stdout}`,
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

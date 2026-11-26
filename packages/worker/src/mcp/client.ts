import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { commandProposal, reviewBeforeDispatch } from "../command-guard.js";
import {
  cidrContains,
  cidrContainsCidr,
  cidrOverlaps,
  isIpv4Cidr,
  targetAllows,
  type ToolCatalogEntry,
  type WorkerManifest,
  type WorkerMcpServer,
} from "@gongyuai/contracts";
import type { ToolContext } from "../tools.js";
import {
  appendProgress,
  assertCapabilityAllows,
  capabilityAtLeast,
  chargeToolCall,
  gateTool,
  installTool,
  mcpActionForServer,
} from "../tools.js";
import { builtinBinaryAvailable, invalidateBinaryHealth } from "../tool-installer.js";
import { loadToolsRuntime, saveToolsRuntime } from "../tools-runtime.js";
import { createBuiltinFromRoot } from "./builtin/from-manifest.js";
import { parseAndRecord, parseSummaryLine, toolForServer } from "../tool-output.js";
import { openHttpSession } from "./http-session.js";
import {
  mcpToolName,
  parseMcpToolName,
  type McpServerSession,
  type OpenAiFunctionTool,
} from "./types.js";

export type McpFailureCode =
  | "missing-binary"
  | "port-failure"
  | "timeout"
  | "config"
  | "unreachable"
  | "startup-failed";

export class McpStartupError extends Error {
  readonly code: McpFailureCode;
  readonly serverId: string;
  constructor(serverId: string, code: McpFailureCode, readonly reason: string) {
    super(`${reason} {"code":"${code}","serverId":"${serverId}"}`);
    this.name = "McpStartupError";
    this.code = code;
    this.serverId = serverId;
  }
}

export type McpHealth =
  | { ok: true }
  | { ok: false; code: McpFailureCode; reason: string };

/** Startup probe budget. Explicit short tool timeouts stay short; long tool budgets do not block startup. */
export function startupBudget(cfg: { timeoutMs?: number }): number {
  const requested = cfg.timeoutMs ?? 8_000;
  if (!Number.isFinite(requested) || requested <= 0) return 8_000;
  return Math.min(Math.max(Math.floor(requested), 50), 8_000);
}

function commandExists(command: string): boolean {
  if (command.includes("/") || command.includes("\\")) {
    try {
      accessSync(command, constants.X_OK);
      return true;
    } catch {
      return false;
    }
  }
  const found = spawnSync("bash", ["-lc", `command -v ${JSON.stringify(command)}`], {
    encoding: "utf8",
    timeout: 2_000,
  });
  return (found.status ?? 1) === 0 && Boolean(found.stdout?.trim());
}

function failureCode(err: unknown): McpFailureCode {
  const cause = err instanceof Error ? (err as Error & { cause?: { code?: string } }).cause : undefined;
  const code = cause?.code ?? (err as { code?: string }).code ?? "";
  const name = err instanceof Error ? err.name : "";
  if (code === "ECONNREFUSED" || code === "ECONNRESET" || code === "EADDRNOTAVAIL") return "port-failure";
  if (code === "ENOTFOUND" || code === "EAI_AGAIN") return "unreachable";
  if (code === "ETIMEDOUT" || code === "UND_ERR_CONNECT_TIMEOUT" || name === "TimeoutError" || name === "AbortError") {
    return "timeout";
  }
  return "unreachable";
}

async function probeHttp(url: string, timeoutMs: number): Promise<McpHealth> {
  try {
    const response = await fetch(url, {
      method: "POST",
      redirect: "manual",
      signal: AbortSignal.timeout(timeoutMs),
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 0,
        method: "initialize",
        params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "gongyuai-health", version: "0" } },
      }),
    });
    if (response.status === 502 || response.status === 503) {
      return { ok: false, code: "port-failure", reason: `HTTP ${response.status}` };
    }
    return { ok: true };
  } catch (err) {
    const code = failureCode(err);
    const reason = err instanceof Error ? err.message : String(err);
    return { ok: false, code, reason };
  }
}

/** Lightweight check before a session is kept. Does not mutate process environment. */
export async function probeMcpHealth(cfg: WorkerMcpServer, timeoutMs = startupBudget(cfg)): Promise<McpHealth> {
  if (cfg.transport === "builtin") {
    if (!cfg.rootDir) return { ok: false, code: "config", reason: "缺少 rootDir" };
    if (cfg.binary && !builtinBinaryAvailable(cfg.binary, { refresh: true })) {
      return { ok: false, code: "missing-binary", reason: `MCP 二进制不存在：${cfg.binary}（未安装或自动安装失败）` };
    }
    return { ok: true };
  }
  if (cfg.transport === "stdio") {
    if (!cfg.command) return { ok: false, code: "config", reason: "缺少 command" };
    if (!commandExists(cfg.command)) {
      return { ok: false, code: "missing-binary", reason: `MCP 二进制不存在：${cfg.command}` };
    }
    return { ok: true };
  }
  if (cfg.transport === "http") {
    if (!cfg.url) return { ok: false, code: "config", reason: "缺少 url" };
    return probeHttp(cfg.url, timeoutMs);
  }
  return { ok: false, code: "config", reason: "未知 MCP transport" };
}

export type McpHub = {
  openaiTools: OpenAiFunctionTool[];
  promptLines: string[];
  catalogLines(): string[];
  enabledIds(): string[];
  hasServer(id: string): boolean;
  /** Hot-register a newly installed MCP server into the live pool/catalog. */
  register(cfg: WorkerMcpServer, catalogEntry?: ToolCatalogEntry): void;
  enable(id: string, reason: string, opts?: { autoInstall?: boolean }): Promise<string>;
  disable(id: string, reason: string): Promise<string>;
  call(fullName: string, args: Record<string, unknown>): Promise<string>;
  /** Call by serverId + toolName (for Pi after mid-run unlock). */
  invoke(serverId: string, toolName: string, args: Record<string, unknown>): Promise<string>;
  /** Same call, plus the untruncated stdout for the parser lane (P15-C4). */
  invokeWithRaw(serverId: string, toolName: string, args: Record<string, unknown>): Promise<{ text: string; raw?: string }>;
  close(): Promise<void>;
};

export { invalidateBinaryHealth };

export async function openMcpHub(
  manifest: WorkerManifest,
  ctx: ToolContext,
): Promise<McpHub> {
  const pool = new Map<string, WorkerMcpServer>();
  for (const cfg of manifest.mcpPool?.length ? manifest.mcpPool : manifest.mcpServers ?? []) {
    pool.set(cfg.id, cfg);
  }
  // Ensure initially enabled servers are in the pool.
  for (const cfg of manifest.mcpServers ?? []) {
    if (!pool.has(cfg.id)) pool.set(cfg.id, cfg);
  }

  const startCall = ctx.history.trackIntegrationCalls(manifest.taskId);
  const sessions = new Map<string, McpServerSession>();
  const blocked = new Map<string, McpStartupError>();
  const openaiTools: OpenAiFunctionTool[] = [];
  const promptLines: string[] = [];
  const enabled = new Set<string>();

  const runtime = loadToolsRuntime(manifest.dataDir);
  const initialIds = new Set<string>([
    ...(manifest.mcpServers ?? []).map((s) => s.id),
    ...(runtime?.mcpEnabledIds ?? []),
  ]);

  const catalogEntries = new Map<string, ToolCatalogEntry>();
  for (const c of manifest.mcpCatalog ?? []) {
    catalogEntries.set(c.id, c);
  }
  for (const cfg of pool.values()) {
    if (!catalogEntries.has(cfg.id)) {
      catalogEntries.set(cfg.id, {
        id: cfg.id,
        name: cfg.name,
        description: cfg.whenToUse ?? "",
        category: "general",
      });
    }
  }

  async function attach(
    id: string,
    opts?: { autoInstall?: boolean },
  ): Promise<string> {
    const cfg = gateTool(ctx, "enable_mcp", () => {
      const server = pool.get(id);
      if (!server) throw new Error(`未知 MCP id：${id}（不在 mcpPool/目录中）`);
      assertCapabilityAllows(manifest, mcpActionForServer(id, manifest));
      return server;
    }, { serverId: id });
    const prior = blocked.get(cfg.id);
    if (prior) {
      const healed = prior.code === "missing-binary"
        && Boolean(cfg.binary)
        && builtinBinaryAvailable(cfg.binary, { refresh: true });
      if (!healed) throw prior;
      blocked.delete(cfg.id);
    }

    let autoInstalledNote = "";
    if (cfg.transport === "builtin" && !builtinBinaryAvailable(cfg.binary, { refresh: true })) {
      const canAutoInstall =
        opts?.autoInstall !== false &&
        Boolean(cfg.binary) &&
        !cfg.binary!.includes("/") &&
        capabilityAtLeast(manifest.auth.capability, "scan");
      if (canAutoInstall) {
        const installed = await installTool(ctx, {
          name: cfg.binary!,
          method: "auto",
        });
        invalidateBinaryHealth(cfg.binary);
        if (installed.ok && builtinBinaryAvailable(cfg.binary, { refresh: true })) {
          autoInstalledNote = `（已自动安装二进制 ${cfg.binary}：${installed.detail}）`;
        }
      }
      if (!builtinBinaryAvailable(cfg.binary, { refresh: true })) {
        const err = new McpStartupError(
          cfg.id,
          "missing-binary",
          `MCP 二进制不存在：${cfg.binary ?? cfg.id}（未安装或自动安装失败）`,
        );
        blocked.set(cfg.id, err);
        throw err;
      }
    }
    const health = await probeMcpHealth(cfg, startupBudget(cfg));
    if (!health.ok) {
      const err = new McpStartupError(cfg.id, health.code, health.reason);
      blocked.set(cfg.id, err);
      throw err;
    }
    blocked.delete(cfg.id);

    if (sessions.has(cfg.id)) {
      enabled.add(cfg.id);
      return `MCP ${cfg.id} 已启用${autoInstalledNote}`;
    }
    let session: McpServerSession | null = null;
    let tools: Awaited<ReturnType<McpServerSession["listTools"]>>;
    try {
      session = await openOne(cfg, ctx);
      if (!session) return `MCP ${cfg.id} 无法连接（配置不全或 adapter 缺失）`;
      tools = await session.listTools();
    } catch (err) {
      await session?.close().catch(() => {});
      const wrapped = err instanceof McpStartupError
        ? err
        : new McpStartupError(cfg.id, "startup-failed", err instanceof Error ? err.message : String(err));
      blocked.set(cfg.id, wrapped);
      throw wrapped;
    }
    sessions.set(cfg.id, session);
    enabled.add(cfg.id);
    const names: string[] = [];
    for (const t of tools) {
      const full = mcpToolName(cfg.id, t.name);
      names.push(t.name);
      if (!openaiTools.some((x) => x.function.name === full)) {
        openaiTools.push({
          type: "function",
          function: {
            name: full,
            description: `[MCP:${cfg.id}] ${t.description}`,
            parameters: t.inputSchema,
          },
        });
      }
    }
    const line = `- MCP \`${cfg.id}\`（${cfg.name}）: ${names.map((n) => mcpToolName(cfg.id, n)).join(", ") || "（无工具）"}`;
    if (!promptLines.some((l) => l.includes(`\`${cfg.id}\``))) {
      promptLines.push(line);
    }
    return `已启用 MCP ${cfg.id}${autoInstalledNote}；工具：${names.map((n) => mcpToolName(cfg.id, n)).join(", ") || "无"}（也可通过 mcp_invoke(serverId="${cfg.id}", toolName="${names[0] ?? "run"}") 调用）`;
  }

  function persist(): void {
    const live = loadToolsRuntime(manifest.dataDir);
    saveToolsRuntime(manifest.dataDir, {
      mcpEnabledIds: [...enabled],
      skillEnabledIds:
        live?.skillEnabledIds ??
        runtime?.skillEnabledIds ??
        (manifest.skillPacks ?? []).map((s) => s.id),
    });
  }

  function catalogLines(): string[] {
    const lines: string[] = [];
    for (const c of catalogEntries.values()) {
      if (enabled.has(c.id)) continue;
      const cfg = pool.get(c.id);
      const unavailable =
        cfg?.transport === "builtin" && !builtinBinaryAvailable(cfg.binary)
          ? "（未安装，enable_mcp 时自动尝试 Kali/官方源安装）"
          : "";
      lines.push(
        `- \`${c.id}\` [${c.category}] ${c.name}${unavailable}${c.description ? ` — ${c.description}` : ""}`,
      );
    }
    return lines;
  }

  for (const id of initialIds) {
    try {
      const msg = await attach(id, { autoInstall: false });
      if (msg.includes("无法")) {
        appendProgress(manifest.workspaceDir, msg);
      }
    } catch (err) {
      appendProgress(
        manifest.workspaceDir,
        `MCP ${id} 失败：${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  persist();

  async function invokeWithRaw(
    serverId: string,
    toolName: string,
    args: Record<string, unknown>,
  ): Promise<{ text: string; raw?: string }> {
    const finish = startCall("mcp", serverId, toolName);
    let success = false;
    try {
      const prior = blocked.get(serverId);
      if (prior) {
        return { text: JSON.stringify({ ok: false, code: prior.code, serverId, reason: prior.message }) };
      }
      const session = gateTool(ctx, "mcp", () => {
        assertCapabilityAllows(manifest, mcpActionForServer(serverId, manifest));
        if (!enabled.has(serverId)) {
          throw new Error(`MCP 未启用: ${serverId}。先调用 enable_mcp。`);
        }
        const active = sessions.get(serverId);
        if (!active) throw new Error(`MCP 会话丢失: ${serverId}`);
        if (!openaiTools.some((tool) => tool.function.name === mcpToolName(serverId, toolName))) {
          throw new Error(`未知 MCP 工具: ${serverId}/${toolName}`);
        }
        const builtin = pool.get(serverId)?.transport === "builtin";
        if (builtin || typeof args.target === "string") {
          const rawTarget = typeof args.target === "string" ? args.target.trim() : "";
          if (!rawTarget) {
            throw new Error("invalid args: MCP call requires a non-empty string 'target' parameter");
          }
          const { targets, outOfScope } = manifest.auth;
          const parts = rawTarget.split(",").map((p) => p.trim()).filter(Boolean);
          const allowed = parts.length > 0 && parts.every((part) => {
            if (/\s|\*/.test(part)) return false;
            if (isIpv4Cidr(part)) {
              const blockedByOos = (outOfScope ?? []).some((o) =>
                isIpv4Cidr(o) ? cidrOverlaps(o, part) : cidrContains(part, o),
              );
              if (blockedByOos) return false;
              return targets.some((t) => {
                const trimmed = t.trim();
                return trimmed === "*" || (isIpv4Cidr(trimmed) && cidrContainsCidr(trimmed, part));
              });
            }
            return targetAllows(targets, part, outOfScope);
          });
          if (!allowed) throw new Error("denied: MCP target is outside the authorized scope");
        }
        chargeToolCall(ctx);
        return active;
      }, { serverId, toolName });
      if (pool.get(serverId)?.transport !== "builtin") {
        const declaredTarget = typeof args.target === "string" ? args.target.trim() : "";
        await reviewBeforeDispatch(manifest, {
          ...commandProposal("mcp", serverId + "/" + toolName, args),
          ...(declaredTarget ? { hosts: [declaredTarget] } : {}),
        });
      }
      const budget = Math.min(Math.max(pool.get(serverId)?.timeoutMs ?? 120_000, 50), 30 * 60_000);
      let result;
      try {
        result = await withTimeout(session.callTool(toolName, args), budget, serverId, toolName);
      } catch (err) {
        if (err instanceof McpStartupError && err.code === "timeout") {
          return {
            text: JSON.stringify({ ok: false, code: "timeout", serverId, toolName, reason: err.message }),
          };
        }
        throw err;
      }
      success = result.ok;
      return {
        text: result.text.slice(0, 12_000),
        ...(result.raw !== undefined ? { raw: result.raw } : {}),
      };
    } finally {
      finish(success);
    }
  }

  async function invoke(
    serverId: string,
    toolName: string,
    args: Record<string, unknown>,
  ): Promise<string> {
    return (await invokeWithRaw(serverId, toolName, args)).text;
  }

  return {
    openaiTools,
    promptLines,
    catalogLines,
    enabledIds: () => [...enabled],
    hasServer: (id) => pool.has(id),
    register(cfg, catalogEntry) {
      pool.set(cfg.id, cfg);
      if (!manifest.mcpPool.some((s) => s.id === cfg.id)) {
        manifest.mcpPool.push(cfg);
      }
      catalogEntries.set(
        cfg.id,
        catalogEntry ?? {
          id: cfg.id,
          name: cfg.name,
          description: cfg.whenToUse ?? "",
          category: "user",
        },
      );
    },
    async enable(id, reason, opts) {
      const msg = await attach(id, opts);
      persist();
      appendProgress(manifest.workspaceDir, `enable_mcp ${id} · ${reason.slice(0, 120)}`);
      ctx.history.appendFact({
        taskId: manifest.taskId,
        layer: "summary",
        title: `解锁 MCP ${id}`,
        summary: reason.slice(0, 500),
        tags: ["system", "mcp"],
      });
      return `${msg}。理由：${reason.slice(0, 200)}`;
    },
    async disable(id, reason) {
      if (!enabled.has(id)) return `MCP ${id} 未启用`;
      const session = sessions.get(id);
      if (session) {
        try {
          await session.close();
        } catch {
          /* ignore */
        }
        sessions.delete(id);
      }
      enabled.delete(id);
      // Remove tool schemas for this server
      for (let i = openaiTools.length - 1; i >= 0; i--) {
        if (openaiTools[i]!.function.name.startsWith(`mcp__${id}__`)) {
          openaiTools.splice(i, 1);
        }
      }
      for (let i = promptLines.length - 1; i >= 0; i--) {
        if (promptLines[i]!.includes(`\`${id}\``)) promptLines.splice(i, 1);
      }
      persist();
      appendProgress(manifest.workspaceDir, `disable_mcp ${id} · ${reason.slice(0, 120)}`);
      ctx.history.appendFact({
        taskId: manifest.taskId,
        layer: "summary",
        title: `关闭 MCP ${id}`,
        summary: reason.slice(0, 500),
        tags: ["system", "mcp"],
      });
      return `已关闭 MCP ${id}`;
    },
    async call(fullName, args) {
      const parsed = parseMcpToolName(fullName);
      if (!parsed) {
        return gateTool(ctx, "mcp", () => {
          throw new Error(`不是 MCP 工具: ${fullName}`);
        });
      }
      const called = await invokeWithRaw(parsed.serverId, parsed.toolName, args);
      // P15-C4: direct MCP tool calls get the same parser lane as mcp_invoke.
      const parserTool = toolForServer(parsed.serverId);
      if (!parserTool) return called.text;
      return called.text + parseSummaryLine(
        parseAndRecord(ctx, parserTool, called.raw ?? called.text, {
          intentId: null,
        }),
      );
    },
    invoke,
    invokeWithRaw,
    async close() {
      for (const s of sessions.values()) {
        try {
          await s.close();
        } catch {
          /* ignore */
        }
      }
      sessions.clear();
    },
  };
}

async function openOne(
  cfg: WorkerMcpServer,
  ctx: ToolContext,
): Promise<McpServerSession | null> {
  if (cfg.transport === "builtin") {
    if (!cfg.rootDir) return null;
    return createBuiltinFromRoot(cfg.id, cfg.rootDir, ctx);
  }
  if (cfg.transport === "stdio") {
    if (!cfg.command) return null;
    if (!commandExists(cfg.command)) {
      throw new McpStartupError(cfg.id, "missing-binary", `MCP 二进制不存在：${cfg.command}`);
    }
    if (ctx.manifest.commandFence) {
      await reviewBeforeDispatch(ctx.manifest, {
        ...commandProposal("stdio", cfg.command, cfg.args ?? []),
        command: [cfg.command, ...(cfg.args ?? [])].join(" "),
        hosts: [],
        need: "scan",
      });
    }
    return openStdioDeadline(cfg.id, cfg.command, cfg.args ?? [], cfg.env ?? {}, startupBudget(cfg));
  }
  if (cfg.transport === "http") {
    if (!cfg.url) return null;
    return openHttpSession(cfg.id, cfg.url, cfg.env ?? {});
  }
  return null;
}

export function isMcpToolName(name: string): boolean {
  return Boolean(parseMcpToolName(name));
}

function withTimeout<T>(work: Promise<T>, timeoutMs: number, serverId: string, toolName: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new McpStartupError(serverId, "timeout", `${toolName} exceeded ${timeoutMs}ms`));
    }, timeoutMs);
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

class DeadlineRpc {
  private nextId = 1;
  private buffer: Buffer = Buffer.alloc(0);
  private bodyLength?: number;
  private stderrTail = "";
  private ended?: Error;
  private readonly pending = new Map<number, { resolve: (value: unknown) => void; reject: (err: Error) => void }>();

  constructor(
    private readonly child: ChildProcessWithoutNullStreams,
    private readonly serverId: string,
    private readonly env: Record<string, string>,
  ) {
    child.stdout.on("data", (chunk: Buffer) => this.onData(chunk));
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      this.stderrTail = (this.stderrTail + chunk).slice(-2048);
    });
    child.on("error", (err) => this.end(err));
    // Keep draining stdout and stderr until close, even after the child exits.
    child.on("close", (code, signal) => {
      this.end(new Error(`MCP process exited (${signal ?? code ?? "unknown"})`));
    });
    child.stdin.on("error", () => {}); // Write callbacks report failures without an unhandled EPIPE.
  }

  private end(err: Error): void {
    this.ended ??= err;
    for (const pending of this.pending.values()) pending.reject(this.ended);
    this.pending.clear();
  }

  diagnostic(reason: string): string {
    let stderr = this.stderrTail;
    for (const [key, value] of Object.entries(this.env)) {
      if (value && /token|password|passwd|secret|key|cookie|authorization/i.test(key)) {
        stderr = stderr.replaceAll(value, "[redacted]");
      }
    }
    stderr = stderr.replace(/[\x00-\x1f\x7f]+/g, " ").trim();
    return stderr ? `${reason} · stderr tail: ${stderr}` : reason;
  }

  private onData(chunk: Buffer): void {
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk;
    while (true) {
      if (this.bodyLength !== undefined) {
        if (this.buffer.length < this.bodyLength) return;
        const body = this.buffer.subarray(0, this.bodyLength);
        this.buffer = this.buffer.subarray(this.bodyLength);
        this.bodyLength = undefined;
        this.parseMessage(body);
        continue;
      }
      const nl = this.buffer.indexOf(0x0a);
      if (nl < 0) return;
      const line = this.buffer.toString("utf8", 0, nl);
      // Choose the framing at the stream head, not from a delimiter in a later frame.
      if (/^content-(?:length|type):/i.test(line)) {
        const headerEnd = this.buffer.indexOf("\r\n\r\n");
        if (headerEnd < 0) return;
        const header = this.buffer.toString("ascii", 0, headerEnd);
        const match = /^content-length:[ \t]*(\d+)[ \t]*\r?$/im.exec(header);
        const length = match ? Number(match[1]) : NaN;
        this.buffer = this.buffer.subarray(headerEnd + 4);
        if (Number.isSafeInteger(length)) this.bodyLength = length;
        continue;
      }
      const body = this.buffer.subarray(0, nl);
      this.buffer = this.buffer.subarray(nl + 1);
      this.parseMessage(body);
    }
  }

  private parseMessage(body: Buffer): void {
    let msg: unknown;
    try { msg = JSON.parse(body.toString("utf8")); } catch { return; }
    if (msg && typeof msg === "object") this.handleMessage(msg as Record<string, unknown>);
  }

  private handleMessage(msg: Record<string, unknown>): void {
    if (typeof msg.id !== "number" || !this.pending.has(msg.id)) return;
    const pending = this.pending.get(msg.id)!;
    this.pending.delete(msg.id);
    if (msg.error) pending.reject(new Error(JSON.stringify(msg.error)));
    else pending.resolve(msg.result);
  }

  request(method: string, params: unknown, timeoutMs: number): Promise<unknown> {
    if (this.ended) return Promise.reject(this.ended);
    const id = this.nextId++;
    const payload = JSON.stringify({ jsonrpc: "2.0", id, method, params });
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!this.pending.has(id)) return;
        this.pending.delete(id);
        reject(new McpStartupError(this.serverId, "timeout", `${method} exceeded ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (err) => {
          clearTimeout(timer);
          reject(err);
        },
      });
      this.child.stdin.write(payload + "\n", (err) => {
        if (!err) return;
        clearTimeout(timer);
        this.pending.delete(id);
        reject(err);
      });
    });
  }

  notify(method: string, params: unknown): Promise<void> {
    if (this.ended) return Promise.reject(this.ended);
    const payload = JSON.stringify({ jsonrpc: "2.0", method, params });
    return new Promise((resolve, reject) => {
      this.child.stdin.write(payload + "\n", (err) => err ? reject(err) : resolve());
    });
  }

  close(): void {
    try {
      this.child.stdin.end();
    } catch {
      /* ignore */
    }
  }
}

async function openStdioDeadline(
  serverId: string,
  command: string,
  args: string[],
  env: Record<string, string>,
  timeoutMs: number,
): Promise<McpServerSession> {
  const child = spawn(command, args, {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, ...env },
  });
  const rpc = new DeadlineRpc(child, serverId, env);
  const kill = () => {
    try { child.kill("SIGKILL"); } catch { /* already gone */ }
  };
  const startupError = (err: unknown) => {
    if (err instanceof McpStartupError) {
      return new McpStartupError(serverId, err.code, rpc.diagnostic(err.reason));
    }
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return new McpStartupError(serverId, "missing-binary", `MCP 二进制不存在：${command}`);
    return new McpStartupError(serverId, "startup-failed", rpc.diagnostic(err instanceof Error ? err.message : String(err)));
  };
  const startedAt = Date.now();
  const remaining = () => Math.max(1, timeoutMs - (Date.now() - startedAt));
  try {
    await rpc.request("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "gongyuai-worker", version: "0.1.0" },
    }, timeoutMs);
    await withTimeout(rpc.notify("notifications/initialized", {}), remaining(), serverId, "notifications/initialized");
  } catch (err) {
    kill();
    throw startupError(err);
  }
  return {
    serverId,
    async listTools() {
      const res = await rpc.request("tools/list", {}, remaining()).catch((err) => {
        throw startupError(err);
      }) as {
        tools?: Array<{ name: string; description?: string; inputSchema?: Record<string, unknown> }>;
      };
      return (res.tools ?? []).map((tool) => ({
        name: tool.name,
        description: tool.description ?? tool.name,
        inputSchema: tool.inputSchema ?? { type: "object", properties: {} },
      }));
    },
    async callTool(name, toolArgs) {
      try {
        const res = await rpc.request("tools/call", { name, arguments: toolArgs }, 60_000) as {
          content?: Array<{ text?: string }>;
          isError?: boolean;
        };
        const text = (res.content ?? []).map((item) => item.text ?? "").filter(Boolean).join("\n");
        return { ok: !res.isError, text: text || JSON.stringify(res) };
      } catch (err) {
        return { ok: false, text: err instanceof McpStartupError ? startupError(err).message : err instanceof Error ? err.message : String(err) };
      }
    },
    async close() {
      rpc.close();
      kill();
    },
  };
}

/**
 * Unified Worker Tool Catalog & Deterministic Gate ("一主两辅" 收敛层).
 *
 * Eliminates the dual ~1,500-line tool declarations/switches across Pi Durable and
 * OpenAI fallback loops, fixes optional-parameter schema generation for Pi Durable,
 * enforces static Leader/Follower tool boundaries, and triggers Follower per-Intent
 * session isolation upon `intent_conclude`.
 */
import { isExploreLeader, type WorkerManifest } from "@gongyuai/contracts";
import { readEvidenceFile, type openHistory } from "@gongyuai/history";
import type { CheckpointStore, CheckpointState } from "./checkpoint.js";
import { runAssetSearch } from "./asset-collectors.js";
import { hasBenchmarkHarness } from "./board-policy.js";
import { c2Tool, shellJob, shellSession } from "./exec-tools.js";
import { formatShellResult } from "./execution-trace.js";
import {
  FOLLOWER_EXCLUDED_TOOLS,
  FOLLOWER_ONLY_EXEC_TOOLS,
  GRAPH_PHASE_TOOLS,
  asGraphPhase,
  executionIntentDenial,
  executionRequiresActiveIntent,
  filterOpenAiTools,
  handleGraphTool,
  resolveWorkerRole,
  roleAllowedToolNames,
  syncGraphPhase,
  type GraphToolCtx,
  type WorkerRole,
} from "./graph-phase.js";
import { httpRequestTool } from "./http-tools.js";
import { isMcpToolName, type McpHub } from "./mcp/client.js";
import { oastHitsTool, oastIssueTool } from "./oast-tools.js";
import {
  attackGraphRecordTool,
  bloodhoundImportTool,
  changeListTool,
  changeRecordTool,
  cloudRecordTool,
  consultTool,
  credentialListTool,
  credentialRecordTool,
  hostProfileListTool,
  hostProfileParseTool,
  hostProfileRecordTool,
  skillDisableTool,
  skillEnableTool,
} from "./ops-tools.js";
import type { SkillHub } from "./skills/runtime.js";
import { INSTALL_METHODS, type InstallMethod } from "./tool-installer.js";
import { parseAndRecord, parseSummaryLine, toolForServer } from "./tool-output.js";
import {
  appendProgress,
  installTool,
  runShell,
  writeEvidence,
  type ToolContext,
} from "./tools.js";
import { runTrafficTool } from "./traffic-tools.js";
import { installMcp, installSkill } from "./trusted-registry.js";
import { tsecbenchTool } from "./tsecbench-tools.js";
import { tunnelCloseTool, tunnelListTool, tunnelOpenTool } from "./tunnel-tools.js";
import { isUntrustedTool, markUntrusted } from "./untrusted.js";

export type ToolParamSpec = {
  type: "string" | "number";
  description?: string;
  enum?: readonly string[];
  required?: boolean;
};

export type UnifiedToolOutcome = {
  text: string;
  /** Already wrapped with `markUntrusted(...)` if true. */
  alreadyMarkedUntrusted?: boolean;
  details?: Record<string, unknown>;
  control?: {
    handoff?: string;
    terminate?: boolean;
  };
  /** Shell execution metadata for execution-trace recording in OpenAI fallback loop. */
  shellMeta?: {
    shellResult: string;
    exitCode: number | null;
    durationMs: number | null;
  };
};

export type UnifiedToolSpec = {
  name: string;
  description: string;
  params: Record<string, ToolParamSpec>;
  replay: "safe" | "none";
  execute: (args: Record<string, unknown>) => Promise<UnifiedToolOutcome>;
};

export type ToolCatalogEnv = {
  manifest: WorkerManifest;
  ctx: ToolContext;
  state: CheckpointState;
  ckpt: CheckpointStore;
  mcpHub: McpHub;
  skillHub: SkillHub;
  readPoolSize: () => number;
  flushUsage: () => void;
  renderHistoryOverview: () => string;
  onRelay: (args: Record<string, string>) => Promise<{ text: string; handoff?: string }> | { text: string; handoff?: string };
  onFollowerIntentFinished?: (intentId: string) => void;
  onCatalogChanged?: () => void;
};

/** Preserve leading headers and trailing diagnostics/tracebacks on large tool outputs. */
export function smartTruncateToolOutput(text: string, maxChars = 12_000): string {
  if (text.length <= maxChars) return text;
  const head = Math.floor(maxChars * 0.67);
  const tail = maxChars - head;
  const omitted = text.length - head - tail;
  return `${text.slice(0, head)}\n\n... [已省略中间 ${omitted} 字符，完整原始输出见 evidence/] ...\n\n${text.slice(-tail)}`;
}

function asStr(v: unknown): string {
  return typeof v === "string" ? v : v == null ? "" : String(v);
}

function optStr(v: unknown): string | undefined {
  return typeof v === "string" && v !== "" ? v : undefined;
}

function strMap(args: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(args)) {
    if (v !== undefined && v !== null) out[k] = String(v);
  }
  return out;
}

function safeSyncText(fn: () => string): UnifiedToolOutcome {
  try {
    return { text: fn() };
  } catch (err) {
    return { text: `错误: ${err instanceof Error ? err.message : String(err)}` };
  }
}

/**
 * Single deterministic Worker tool gate shared by Pi Durable (`beforeTool`) and OpenAI loop:
 * 1. `operator_consult` is never blocked;
 * 2. Role + phase allowlist (`roleAllowedToolNames`);
 * 3. Active claimed `Intent` binding for execution tools + automatic lease heartbeat.
 */
export function evaluateWorkerToolGate(opts: {
  ctx: ToolContext;
  state: CheckpointState;
  name: string;
  mcpHub: McpHub;
  args?: Record<string, unknown>;
  poolSizeOverride?: number;
}): string | undefined {
  const { ctx, state, name, mcpHub, args } = opts;
  const taskId = ctx.manifest.taskId;
  const leader = isExploreLeader(ctx.manifest);
  const workerCount = opts.poolSizeOverride ?? ctx.manifest.workerCount ?? 1;
  const role: WorkerRole = resolveWorkerRole({ leader, workerCount });

  state.phase = syncGraphPhase(ctx.history, taskId, state.phase, {
    leader,
    workerCount,
    activeIntentId: state.activeIntentId,
  });
  const phase = asGraphPhase(state.phase);
  const mcpNames = mcpHub.openaiTools.map((tool) => tool.function.name);
  const workerId = ctx.manifest.workerId || `worker-${taskId.slice(0, 8)}`;

  const deny = (reason: string): string => {
    ctx.history.recordToolGate(taskId, { tool: name, ok: false, reason, detail: { phase, role } });
    return reason;
  };

  if (name === "operator_consult") {
    return undefined;
  }

  // Multi-worker leader delegates Explore execution; only allow finishing a pre-scale-up activeIntentId.
  if (
    executionRequiresActiveIntent(name, args) &&
    role === "leader" &&
    !state.activeIntentId
  ) {
    return deny(`denied: leader does not execute ${name}; follower Explore owns tools`);
  }
  if (name === "assert_goal" && !leader) {
    return deny("denied: assert_goal is leader-only; follower reports findings via Fact");
  }

  const allowed = roleAllowedToolNames(
    phase,
    // Preserve pre-scale-up in-flight Intent execution on slot 0 until concluded.
    role === "leader" && state.activeIntentId ? "solo" : role,
    mcpNames,
  );
  if (!allowed.has(name)) {
    const dynamicMcpAllowed =
      isMcpToolName(name) &&
      (phase === "explore" || phase === "relay") &&
      (role !== "leader" || Boolean(state.activeIntentId));
    if (!dynamicMcpAllowed) {
      return deny(`denied: tool ${name} not allowed in phase=${phase}`);
    }
  }

  const intentDenial = executionIntentDenial({
    history: ctx.history,
    taskId,
    workerId,
    state,
    name,
    args,
  });
  if (intentDenial) return deny(intentDenial);

  if (state.activeIntentId) {
    ctx.history.heartbeatIntent(taskId, state.activeIntentId, workerId);
  }
  return undefined;
}

/** Build the single-source-of-truth Worker tool catalog for a task worker slot. */
export function buildWorkerToolCatalog(env: ToolCatalogEnv): UnifiedToolSpec[] {
  const { manifest, ctx, state, ckpt, mcpHub, skillHub } = env;

  const opsCtx = () => ({
    manifest,
    history: ctx.history,
    workerId: manifest.workerId || `worker-${manifest.taskId.slice(0, 8)}`,
    activeIntentId: state.activeIntentId,
  });

  const graphCtx = (): GraphToolCtx => ({
    history: ctx.history,
    taskId: manifest.taskId,
    workspaceDir: manifest.workspaceDir,
    state,
    workerId: manifest.workerId || `worker-${manifest.taskId.slice(0, 8)}`,
    execution: manifest.execution,
    leader: isExploreLeader(manifest),
    workerCount: env.readPoolSize(),
    trafficDir: manifest.dataDir,
    save: () => {
      state.toolCalls = ctx.usage.toolCalls;
      state.installs = ctx.usage.installs;
      ckpt.save(state);
    },
  });

  // 1. Convert declarative GRAPH_PHASE_TOOLS into UnifiedToolSpecs.
  const graphSpecs: UnifiedToolSpec[] = GRAPH_PHASE_TOOLS.map((t) => {
    const fn = t.function;
    const rawProps = (
      fn.parameters as unknown as {
        properties?: Record<string, { type?: string; description?: string } | undefined>;
      }
    ).properties ?? {};
    const reqSet = new Set<string>(
      ((fn.parameters as { required?: readonly string[] }).required ?? []),
    );
    const params: Record<string, ToolParamSpec> = {};
    for (const [k, prop] of Object.entries(rawProps)) {
      params[k] = {
        type: prop?.type === "number" ? "number" : "string",
        ...(prop?.description ? { description: prop.description } : {}),
        required: reqSet.has(k),
      };
    }
    return {
      name: fn.name,
      description: fn.description,
      params,
      replay: "safe",
      execute: async (args) => {
        const prevActive = state.activeIntentId;
        const workerCount = env.readPoolSize();
        const role = resolveWorkerRole({
          leader: isExploreLeader(manifest),
          workerCount,
        });
        const text = handleGraphTool(fn.name, strMap(args), graphCtx()) ?? `未知图工具 ${fn.name}`;
        // Follower per-Intent clean session isolation: concluding an active Intent ends this turn cleanly.
        if (
          fn.name === "intent_conclude" &&
          role === "follower" &&
          prevActive != null &&
          state.activeIntentId === null
        ) {
          env.onFollowerIntentFinished?.(prevActive);
          return {
            text,
            control: { terminate: true },
          };
        }
        return { text };
      },
    };
  });

  const coreSpecs: UnifiedToolSpec[] = [
    {
      name: "shell",
      description: "Run a bash command inside the authorized workspace",
      params: { command: { type: "string", required: true } },
      replay: "none",
      execute: async (args) => {
        const r = await runShell(ctx, asStr(args.command));
        state.toolCalls = ctx.usage.toolCalls;
        state.installs = ctx.usage.installs;
        env.flushUsage();
        try {
          ckpt.save(state);
        } catch {
          /* best-effort; usage already flushed */
        }
        const fullFormatted = formatShellResult(r);
        const truncatedFormatted = formatShellResult({
          ...r,
          stdout: smartTruncateToolOutput(r.stdout, 12_000),
          stderr: smartTruncateToolOutput(r.stderr, 4_000),
        });
        return {
          text: markUntrusted(truncatedFormatted, { tool: "shell" }),
          alreadyMarkedUntrusted: true,
          details: {
            shellResult: fullFormatted,
            exitCode: r.exitCode,
            durationMs: r.durationMs ?? null,
          },
          shellMeta: {
            shellResult: fullFormatted,
            exitCode: r.exitCode,
            durationMs: r.durationMs ?? null,
          },
        };
      },
    },
    {
      name: "shell_job",
      description:
        "Run a shell command as a background job that outlives this tool call (long scans, listeners, brute force). action=start|poll|wait|list|kill; poll reads incremental stdout by offset.",
      params: {
        action: { type: "string", required: true },
        command: { type: "string" },
        jobId: { type: "string" },
        label: { type: "string" },
        offset: { type: "string" },
        waitMs: { type: "string" },
      },
      replay: "none",
      execute: async (args) => {
        const raw = await shellJob(ctx, {
          action: (optStr(args.action) as "start" | "poll" | "wait" | "list" | "kill") ?? "poll",
          ...(optStr(args.command) ? { command: asStr(args.command) } : {}),
          ...(optStr(args.jobId) ? { jobId: asStr(args.jobId) } : {}),
          ...(optStr(args.label) ? { label: asStr(args.label) } : {}),
          ...(optStr(args.offset) ? { offset: Number(args.offset) } : {}),
          ...(optStr(args.waitMs) ? { waitMs: Number(args.waitMs) } : {}),
        });
        return {
          text: markUntrusted(raw.slice(0, 24_000), { tool: "shell_job" }),
          alreadyMarkedUntrusted: true,
          details: { shellResult: raw },
        };
      },
    },
    {
      name: "shell_session",
      description:
        "Open and drive a persistent PTY shell session (interactive ssh, msfconsole, nc, password prompts). action=open|write|read|wait|close|list; write sends a line, wait blocks for pattern or idle and returns new output.",
      params: {
        action: { type: "string", required: true },
        sessionId: { type: "string" },
        data: { type: "string" },
        pattern: { type: "string" },
        offset: { type: "string" },
        waitMs: { type: "string" },
        idleMs: { type: "string" },
      },
      replay: "none",
      execute: async (args) => {
        const raw = await shellSession(ctx, {
          action: (optStr(args.action) as "open" | "write" | "read" | "wait" | "close" | "list") ?? "list",
          ...(optStr(args.sessionId) ? { sessionId: asStr(args.sessionId) } : {}),
          ...(args.data !== undefined && args.data !== "" ? { data: asStr(args.data) } : {}),
          ...(optStr(args.pattern) ? { pattern: asStr(args.pattern) } : {}),
          ...(optStr(args.offset) ? { offset: Number(args.offset) } : {}),
          ...(optStr(args.waitMs) ? { waitMs: Number(args.waitMs) } : {}),
          ...(optStr(args.idleMs) ? { idleMs: Number(args.idleMs) } : {}),
        });
        return {
          text: markUntrusted(raw.slice(0, 24_000), { tool: "shell_session" }),
          alreadyMarkedUntrusted: true,
          details: { shellResult: raw },
        };
      },
    },
    {
      name: "c2",
      description:
        "C2 listener/session control for authorized targets: listen (tcp/tls), sessions, task (exec on raw or agent session), read, write, note, close. Session peers are scope-checked before any task is dispatched.",
      params: {
        action: { type: "string", required: true },
        bindHost: { type: "string" },
        bindPort: { type: "string" },
        kind: { type: "string" },
        certPath: { type: "string" },
        keyPath: { type: "string" },
        sessionId: { type: "string" },
        command: { type: "string" },
        data: { type: "string" },
        note: { type: "string" },
        listenerId: { type: "string" },
        offset: { type: "string" },
        waitMs: { type: "string" },
        marker: { type: "string" },
        remotePath: { type: "string" },
        sha256: { type: "string" },
      },
      replay: "none",
      execute: async (args) => {
        const raw = await c2Tool(ctx, {
          action:
            (optStr(args.action) as
              | "listen"
              | "list"
              | "sessions"
              | "task"
              | "read"
              | "write"
              | "note"
              | "close"
              | "close-listener"
              | "file-put"
              | "file-get"
              | "blob-get") ?? "sessions",
          ...(optStr(args.bindHost) ? { bindHost: asStr(args.bindHost) } : {}),
          ...(optStr(args.bindPort) ? { bindPort: Number(args.bindPort) } : {}),
          ...(args.kind === "tls" || args.kind === "tcp" ? { kind: args.kind } : {}),
          ...(optStr(args.certPath) ? { certPath: asStr(args.certPath) } : {}),
          ...(optStr(args.keyPath) ? { keyPath: asStr(args.keyPath) } : {}),
          ...(optStr(args.sessionId) ? { sessionId: asStr(args.sessionId) } : {}),
          ...(optStr(args.command) ? { command: asStr(args.command) } : {}),
          ...(args.data !== undefined && args.data !== "" ? { data: asStr(args.data) } : {}),
          ...(optStr(args.note) ? { note: asStr(args.note) } : {}),
          ...(optStr(args.listenerId) ? { listenerId: asStr(args.listenerId) } : {}),
          ...(optStr(args.offset) ? { offset: Number(args.offset) } : {}),
          ...(optStr(args.waitMs) ? { waitMs: Number(args.waitMs) } : {}),
          ...(optStr(args.marker) ? { marker: asStr(args.marker) } : {}),
          ...(optStr(args.remotePath) ? { remotePath: asStr(args.remotePath) } : {}),
          ...(optStr(args.sha256) ? { sha256: asStr(args.sha256) } : {}),
        });
        return {
          text: markUntrusted(raw.slice(0, 24_000), { tool: "c2" }),
          alreadyMarkedUntrusted: true,
          details: { shellResult: raw },
        };
      },
    },
    {
      name: "history_overview",
      description: "Observe History: Goals + title-layer Facts + open Intents (+ Session Relay π)",
      params: {},
      replay: "safe",
      execute: async () => ({ text: env.renderHistoryOverview() }),
    },
    {
      name: "history_read_fact",
      description:
        "Drill into one Fact by id with same-intent neighbors. recordedAt is History write time — never invent event time.",
      params: { factId: { type: "string", required: true } },
      replay: "safe",
      execute: async (args) => ({
        text: JSON.stringify(ctx.history.formatFactDrill(manifest.taskId, asStr(args.factId))),
      }),
    },
    {
      name: "history_list_layer",
      description: "List Facts for one layer (summary|evidence|title) on demand",
      params: { layer: { type: "string", required: true } },
      replay: "safe",
      execute: async (args) => {
        const layer = asStr(args.layer) as "title" | "summary" | "evidence";
        if (!["title", "summary", "evidence"].includes(layer)) {
          return { text: `invalid layer: ${asStr(args.layer)}` };
        }
        return { text: JSON.stringify(ctx.history.listFacts(manifest.taskId, layer).slice(-30)) };
      },
    },
    {
      name: "history_append_fact",
      description: "Append a fact to History",
      params: {
        layer: { type: "string", required: true },
        title: { type: "string", required: true },
        summary: { type: "string" },
        evidencePath: { type: "string" },
        tags: { type: "string" },
      },
      replay: "safe",
      execute: async (args) => {
        const fact = ctx.history.appendFact({
          taskId: manifest.taskId,
          layer: (optStr(args.layer) as "title" | "summary" | "evidence") ?? "summary",
          title: optStr(args.title) ?? "未命名",
          summary: asStr(args.summary),
          evidencePath: optStr(args.evidencePath) ?? null,
          tags: asStr(args.tags)
            .split(/[,\s]+/)
            .map((t) => t.trim())
            .filter(Boolean),
        });
        return { text: JSON.stringify(fact) };
      },
    },
    {
      name: "asset_list",
      description: "List the bidirectional asset inventory (seed + discovered). Same rows as console 资产表.",
      params: {},
      replay: "safe",
      execute: async () => ({ text: JSON.stringify(ctx.history.listAssets(manifest.taskId)) }),
    },
    {
      name: "asset_record",
      description:
        "Record a discovered host/URL into the asset inventory. Auto-admits against auth.targets (CIDR / *.domain / suffix); out-of-scope → oos. Set live=true after probe confirms up.",
      params: {
        address: { type: "string", required: true },
        summary: { type: "string" },
        live: { type: "string" },
        assetType: { type: "string" },
        parent: { type: "string" },
        weight: { type: "string" },
      },
      replay: "safe",
      execute: async (args) => {
        const liveStr = asStr(args.live);
        const live = liveStr === "true" || liveStr === "1" || liveStr === "yes";
        const at = optStr(args.assetType);
        const assetType =
          at === "domain" || at === "ip" || at === "service" || at === "endpoint" ? at : null;
        const wRaw = optStr(args.weight);
        const weight = wRaw === undefined ? undefined : Math.min(5, Math.max(0, Number(wRaw) || 0));
        const r = ctx.history.recordAsset({
          taskId: manifest.taskId,
          address: asStr(args.address),
          auth: manifest.auth,
          summary: optStr(args.summary),
          live,
          source: "discover",
          intentId: state.activeIntentId,
          ...(assetType ? { assetType } : {}),
          ...(optStr(args.parent) ? { parentAddress: asStr(args.parent) } : {}),
          ...(weight === undefined ? {} : { weight }),
        });
        return { text: JSON.stringify(r) };
      },
    },
    {
      name: "asset_search",
      description:
        "Query an enabled asset collector (FOFA / 鹰图 Hunter / custom). Hits are auto-recorded into the asset inventory (admit/oos). Prefer this over browser scraping when configured.",
      params: {
        collectorId: { type: "string", required: true },
        query: { type: "string", required: true },
        size: { type: "string" },
      },
      replay: "none",
      execute: async (args) => {
        const sizeRaw = optStr(args.size);
        const size = sizeRaw ? Number(sizeRaw) : 50;
        const r = await runAssetSearch(ctx, {
          collectorId: asStr(args.collectorId),
          query: asStr(args.query),
          size: Number.isFinite(size) ? size : 50,
          intentId: state.activeIntentId,
        });
        state.toolCalls = ctx.usage.toolCalls;
        ckpt.save(state);
        return { text: JSON.stringify(r) };
      },
    },
    {
      name: "write_evidence",
      description: "Write an evidence file under evidence/",
      params: {
        relativePath: { type: "string", required: true },
        content: { type: "string", required: true },
      },
      replay: "safe",
      execute: async (args) => ({
        text: writeEvidence(ctx, optStr(args.relativePath) ?? "note.txt", asStr(args.content)),
      }),
    },
    {
      name: "install_tool",
      description:
        "Install a missing pentest CLI tool (Kali-first: reuses already-installed/Kali binaries, then Kali APT, then official go/pipx/npm/brew; method=auto by default).",
      params: {
        name: { type: "string", required: true },
        package: { type: "string" },
        method: { type: "string", enum: ["auto", "apt", "pip", "pipx", "go", "npm", "brew"] },
      },
      replay: "none",
      execute: async (args) => {
        const mRaw = optStr(args.method);
        const method: InstallMethod =
          mRaw && (INSTALL_METHODS as readonly string[]).includes(mRaw)
            ? (mRaw as InstallMethod)
            : "auto";
        const r = await installTool(ctx, {
          name: asStr(args.name),
          package: optStr(args.package),
          method,
        });
        state.installs = ctx.usage.installs;
        ckpt.save(state);
        if (r.ok) env.onCatalogChanged?.();
        return { text: JSON.stringify(r) };
      },
    },
    {
      name: "install_mcp",
      description:
        "Install & hot-register an MCP server from official or high-star (>=500 stars) community sources. Automatically reuses Kali-integrated builtin MCPs without redundant downloads.",
      params: {
        id: { type: "string", required: true },
        source: { type: "string" },
        reason: { type: "string", required: true },
      },
      replay: "none",
      execute: async (args) => {
        const r = await installMcp(ctx, mcpHub, {
          id: asStr(args.id),
          source: optStr(args.source),
          reason: optStr(args.reason) ?? "needed",
        });
        state.installs = ctx.usage.installs;
        ckpt.save(state);
        if (r.ok) env.onCatalogChanged?.();
        return { text: JSON.stringify(r) };
      },
    },
    {
      name: "install_skill",
      description:
        "Install & hot-register a Skill from official or high-star (>=500 stars) community GitHub sources. Reuses local skills without redundant downloads.",
      params: {
        id: { type: "string", required: true },
        source: { type: "string" },
        reason: { type: "string", required: true },
      },
      replay: "none",
      execute: async (args) => {
        const r = await installSkill(ctx, skillHub, {
          id: asStr(args.id),
          source: optStr(args.source),
          reason: optStr(args.reason) ?? "needed",
        });
        state.installs = ctx.usage.installs;
        ckpt.save(state);
        if (r.ok) env.onCatalogChanged?.();
        return { text: r.content ? `${r.detail}\n\n${r.content}` : JSON.stringify(r) };
      },
    },
    ...(hasBenchmarkHarness(manifest)
      ? ([
          {
            name: "tsecbench",
            description:
              "TSecBench 平台入口（清板任务必用）：action=list 拿题单与 container_addr；start 开容器(≤3)；submit 交 flag；close 释放；status 查单题。真实目标只来自 start 的 addr，预检地址勿攻击。",
            params: {
              action: { type: "string", enum: ["list", "start", "submit", "close", "status"], required: true },
              code: { type: "string" },
              flag: { type: "string" },
            },
            replay: "none",
            execute: async (args) => {
              const raw = await tsecbenchTool(ctx, {
                action: optStr(args.action) ?? "list",
                ...(optStr(args.code) ? { code: asStr(args.code) } : {}),
                ...(optStr(args.flag) ? { flag: asStr(args.flag) } : {}),
              });
              state.toolCalls = ctx.usage.toolCalls;
              ckpt.save(state);
              return {
                text: markUntrusted(raw, { tool: "tsecbench", target: asStr(args.code) }),
                alreadyMarkedUntrusted: true,
              };
            },
          },
        ] satisfies UnifiedToolSpec[])
      : []),
    {
      name: "assert_goal",
      description: "Mark a goal passed only with evidence files",
      params: {
        goalId: { type: "string", required: true },
        evidencePaths: { type: "string", required: true },
      },
      replay: "safe",
      execute: async (args) => {
        const paths = asStr(args.evidencePaths)
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean);
        return { text: JSON.stringify(ctx.history.assertGoal(manifest.taskId, asStr(args.goalId), paths)) };
      },
    },
    {
      name: "enable_mcp",
      description: "Unlock an MCP from the catalog for this task only (progressive).",
      params: {
        id: { type: "string", required: true },
        reason: { type: "string", required: true },
      },
      replay: "none",
      execute: async (args) => {
        const text = await mcpHub.enable(asStr(args.id), optStr(args.reason) ?? "needed");
        env.onCatalogChanged?.();
        return { text };
      },
    },
    {
      name: "disable_mcp",
      description: "Disable a previously unlocked MCP for this task.",
      params: {
        id: { type: "string", required: true },
        reason: { type: "string", required: true },
      },
      replay: "none",
      execute: async (args) => {
        const text = await mcpHub.disable(asStr(args.id), optStr(args.reason) ?? "no longer needed");
        env.onCatalogChanged?.();
        return { text };
      },
    },
    {
      name: "load_skill",
      description:
        "Load full SKILL.md (or optional ref under references/) for one skill id from the routing table (on-demand; do not load all).",
      params: {
        id: { type: "string", required: true },
        reason: { type: "string", required: true },
        ref: { type: "string" },
      },
      replay: "none",
      execute: async (args) => ({
        text: skillHub.load(
          asStr(args.id),
          optStr(args.reason) ?? "needed for current phase",
          optStr(args.ref),
        ),
      }),
    },
    {
      name: "enable_skill",
      description: "按 id 加载 Skill 正文（等价 load_skill；路由表常驻）。",
      params: {
        id: { type: "string", required: true },
        reason: { type: "string" },
      },
      replay: "none",
      execute: async (args) => ({
        text: skillEnableTool(skillHub, {
          id: asStr(args.id),
          reason: optStr(args.reason) ?? "needed",
        }),
      }),
    },
    {
      name: "disable_skill",
      description: "Skill 无需 disable（正文仅按需加载）。",
      params: { id: { type: "string" } },
      replay: "none",
      execute: async (args) => ({ text: skillDisableTool({ id: optStr(args.id) }) }),
    },
    {
      name: "relay",
      description:
        "写 Session Relay π（交班快照：位置/网络图/试过什么/foothold/未测面）。History 仍是真相源。",
      params: {
        reason: { type: "string", required: true },
        current_position: { type: "string" },
        network_map: { type: "string" },
        tried: { type: "string" },
        active_sessions: { type: "string" },
        foothold: { type: "string" },
        unexplored_surface: { type: "string" },
      },
      replay: "none",
      execute: async (args) => {
        const res = await env.onRelay(strMap(args));
        return {
          text: res.text,
          ...(res.handoff ? { control: { handoff: res.handoff } } : {}),
        };
      },
    },
    {
      name: "operator_consult",
      description:
        "向操作员求助（blocking 24h 后自动转非阻塞）。用于影响/坐标事实判断不了时；不替代证据。",
      params: {
        question: { type: "string", required: true },
        context: { type: "string" },
        options: { type: "string" },
        blocking: { type: "string" },
        relatedIntentId: { type: "string" },
      },
      replay: "none",
      execute: async (args) => safeSyncText(() => consultTool(opsCtx(), strMap(args))),
    },
    {
      name: "change_record",
      description:
        "动手前登记对目标的改动（webshell/account/config/persistence/db/network/file）+ 回滚命令；只登记不执行回滚。",
      params: {
        kind: { type: "string", required: true },
        asset: { type: "string", required: true },
        location: { type: "string", required: true },
        rollbackCmd: { type: "string", required: true },
        beforePath: { type: "string" },
        note: { type: "string" },
        credentialId: { type: "string" },
        intentId: { type: "string" },
      },
      replay: "none",
      execute: async (args) => safeSyncText(() => changeRecordTool(opsCtx(), strMap(args))),
    },
    {
      name: "change_list",
      description: "列出本任务已登记的改动与回滚命令（交付残留风险原料）。",
      params: {},
      replay: "safe",
      execute: async () => safeSyncText(() => changeListTool(opsCtx())),
    },
    {
      name: "credential_record",
      description:
        "登记凭据指针（secretRef=证据路径/环境变量名；绝不收明文）+ 资产 + 类型；verified 只用于真实认证成功。",
      params: {
        kind: { type: "string", required: true },
        asset: { type: "string", required: true },
        secretRef: { type: "string", required: true },
        username: { type: "string" },
        secretHmac: { type: "string" },
        sourceFindingId: { type: "string" },
        verified: { type: "string" },
        expiresAt: { type: "string" },
      },
      replay: "none",
      execute: async (args) => safeSyncText(() => credentialRecordTool(opsCtx(), strMap(args))),
    },
    {
      name: "credential_list",
      description: "列出本任务凭据元数据（不回显明文；按 secretRef 读证据文件再用）。",
      params: {},
      replay: "safe",
      execute: async () => safeSyncText(() => credentialListTool(opsCtx())),
    },
    {
      name: "parse_tool_output",
      description:
        "P14 解析：把 evidence/ 下的 nmap/httpx/nuclei/ffuf 机器可读输出解析成资产与 tentative finding（只搬运不改结论）。",
      params: {
        tool: { type: "string", required: true },
        evidencePath: { type: "string", required: true },
      },
      replay: "safe",
      execute: async (args) => {
        const t = asStr(args.tool).toLowerCase();
        if (!["nmap", "httpx", "nuclei", "ffuf"].includes(t)) {
          return { text: `错误: unsupported tool ${t}` };
        }
        try {
          const content = readEvidenceFile(manifest.evidenceDir, asStr(args.evidencePath));
          const parsed = parseAndRecord(ctx, t as "nmap" | "httpx" | "nuclei" | "ffuf", content, {
            intentId: state.activeIntentId,
          });
          return { text: JSON.stringify(parsed) };
        } catch (err) {
          return { text: `错误: ${err instanceof Error ? err.message : String(err)}` };
        }
      },
    },
    {
      name: "tunnel_open",
      description:
        "P14 内网推进：起本地监听隧道（socat/ssh-local/ssh-socks/chisel-socks），只绑 127.0.0.1；目标与跳板主机必须在本任务 scope/pivot 内。返回 localPort 与 tunnel id。",
      params: {
        kind: { type: "string", required: true },
        targetHost: { type: "string" },
        targetPort: { type: "string" },
        localPort: { type: "string" },
        via: { type: "string" },
      },
      replay: "none",
      execute: async (args) => {
        try {
          return { text: await tunnelOpenTool(ctx, strMap(args)) };
        } catch (err) {
          return { text: `错误: ${err instanceof Error ? err.message : String(err)}` };
        }
      },
    },
    {
      name: "tunnel_list",
      description: "P14 列出本地隧道（状态/本地端口/目标/pid）。",
      params: {},
      replay: "safe",
      execute: async () => ({ text: tunnelListTool(ctx) }),
    },
    {
      name: "tunnel_close",
      description: "P14 关闭一个隧道（进程组 kill，幂等）。",
      params: { id: { type: "string", required: true } },
      replay: "none",
      execute: async (args) => ({ text: await tunnelCloseTool(ctx, { id: optStr(args.id) }) }),
    },
    {
      name: "host_profile_record",
      description:
        "P14 内网推进：登记 foothold 主机画像（OS/域/用户/权限/服务/共享/AV 信号）。字段逗号分隔；只登记，不下结论。",
      params: {
        asset: { type: "string", required: true },
        hostname: { type: "string" },
        os: { type: "string" },
        domain: { type: "string" },
        users: { type: "string" },
        privileges: { type: "string" },
        services: { type: "string" },
        shares: { type: "string" },
        av: { type: "string" },
        evidencePath: { type: "string" },
        source: { type: "string" },
      },
      replay: "none",
      execute: async (args) => safeSyncText(() => hostProfileRecordTool(opsCtx(), strMap(args))),
    },
    {
      name: "host_profile_parse",
      description:
        "P17 解析只读主机枚举输出（Linux id/uname/os-release/sudo -l/getcap/ss；Windows systeminfo/whoami /all/net localgroup/net user/net share/ipconfig）为 HostProfile。未识别时返回 skipped，不编造。",
      params: {
        asset: { type: "string", required: true },
        text: { type: "string", required: true },
        evidencePath: { type: "string" },
      },
      replay: "none",
      execute: async (args) => safeSyncText(() => hostProfileParseTool(opsCtx(), strMap(args))),
    },
    {
      name: "host_profile_list",
      description: "P14 列出本任务 foothold 主机画像。",
      params: {},
      replay: "safe",
      execute: async () => safeSyncText(() => hostProfileListTool(opsCtx())),
    },
    {
      name: "attack_graph_record",
      description:
        "P17 记录一个 AD/云攻击图节点或边（Fact 投影）。type=node|edge；json 为 {id,kind,name,domain?,provider?,account?,owned?} 或 {from,to,kind}。",
      params: {
        type: { type: "string", required: true },
        json: { type: "string", required: true },
      },
      replay: "none",
      execute: async (args) => safeSyncText(() => attackGraphRecordTool(opsCtx(), strMap(args))),
    },
    {
      name: "bloodhound_import",
      description:
        "P17 导入 BloodHound/SharpHound JSON（users/groups/computers/domains + Members/Aces/Sessions/LocalAdmins），写 AD 图并返回最短 Domain Admin 路径。",
      params: { text: { type: "string", required: true } },
      replay: "none",
      execute: async (args) => safeSyncText(() => bloodhoundImportTool(opsCtx(), strMap(args))),
    },
    {
      name: "cloud_record",
      description:
        "P17 记录云资产/角色/策略节点，可选同时记录一条边（provider/kind/id/name/account + edgeFrom/edgeTo/edgeKind）。",
      params: {
        provider: { type: "string", required: true },
        id: { type: "string", required: true },
        kind: { type: "string" },
        name: { type: "string" },
        account: { type: "string" },
        edgeFrom: { type: "string" },
        edgeTo: { type: "string" },
        edgeKind: { type: "string" },
      },
      replay: "none",
      execute: async (args) => safeSyncText(() => cloudRecordTool(opsCtx(), strMap(args))),
    },
    {
      name: "http_request",
      description:
        "P14 事务证据与对照分析：发 HTTP 请求并封存内容寻址证据（返回 ref=http:<id> 供 finding_verify 引用）。支持 session（命名 Cookie 会话隔离，用于多角色越权与有状态业务流验证）与 compareWith（传入基线 http:<id> 做确定性响应差分）。",
      params: {
        url: { type: "string", required: true },
        method: { type: "string" },
        headers: { type: "string" },
        body: { type: "string" },
        follow: { type: "string" },
        timeoutMs: { type: "string" },
        note: { type: "string" },
        session: { type: "string" },
        compareWith: { type: "string" },
      },
      replay: "none",
      execute: async (args) => {
        const raw = await httpRequestTool(ctx, strMap(args), { intentId: state.activeIntentId });
        state.toolCalls = ctx.usage.toolCalls;
        ckpt.save(state);
        return {
          text: markUntrusted(raw, { tool: "http_request", target: asStr(args.url) }),
          alreadyMarkedUntrusted: true,
        };
      },
    },
    {
      name: "traffic_search",
      description:
        "检索本地 MITM 代理与 http_request 捕获的目标 HTTP/HTTPS 流量索引（可按 host/method/status/keyword/intentId 过滤，返回证据引用 http:<id>）。",
      params: {
        host: { type: "string" },
        method: { type: "string" },
        status: { type: "number" },
        keyword: { type: "string" },
        intentId: { type: "string" },
        offset: { type: "number" },
        limit: { type: "number" },
      },
      replay: "none",
      execute: async (args) =>
        safeSyncText(() => runTrafficTool(manifest.dataDir, manifest.taskId, "traffic_search", args)),
    },
    {
      name: "traffic_get",
      description: "读取单条录制流量的完整请求头、响应头、blob 元数据与证据引用 http:<id>。",
      params: { id: { type: "string", required: true } },
      replay: "none",
      execute: async (args) =>
        safeSyncText(() => runTrafficTool(manifest.dataDir, manifest.taskId, "traffic_get", args)),
    },
    {
      name: "traffic_blob",
      description: "按字节 offset 分段读取录制流量的请求体或响应体（side=req|res，防大包撑爆上下文）。",
      params: {
        id: { type: "string", required: true },
        side: { type: "string", enum: ["req", "res"], required: true },
        offset: { type: "number" },
        maxBytes: { type: "number" },
      },
      replay: "none",
      execute: async (args) =>
        safeSyncText(() => runTrafficTool(manifest.dataDir, manifest.taskId, "traffic_blob", args)),
    },
    {
      name: "oast_issue",
      description:
        "P14 带外：签发回调令牌（auth.oast 未配置时返回 oast_unavailable，不造假命中）。把 callback 放进 SSRF/盲注/XXE payload。",
      params: {
        kind: { type: "string" },
        note: { type: "string" },
      },
      replay: "none",
      execute: async (args) => ({ text: await oastIssueTool(ctx, strMap(args)) }),
    },
    {
      name: "oast_hits",
      description: "P14 带外：查令牌命中（时间/来源/路径）。命中证明目标发起回调，hit≠可利用。",
      params: { token: { type: "string" } },
      replay: "safe",
      execute: async (args) => ({ text: oastHitsTool(ctx, strMap(args)) }),
    },
    {
      name: "mcp_invoke",
      description: "Call any enabled MCP tool by serverId + toolName (use after enable_mcp).",
      params: {
        serverId: { type: "string", required: true },
        toolName: { type: "string", required: true },
        argsJson: { type: "string" },
      },
      replay: "none",
      execute: async (args) => {
        let parsed: Record<string, unknown> = {};
        const rawJson = optStr(args.argsJson);
        if (rawJson) {
          try {
            parsed = JSON.parse(rawJson) as Record<string, unknown>;
          } catch {
            parsed = { raw: rawJson };
          }
        }
        const serverId = asStr(args.serverId);
        const { text, raw } = await mcpHub.invokeWithRaw(serverId, asStr(args.toolName), parsed);
        state.toolCalls = ctx.usage.toolCalls;
        ckpt.save(state);
        const parserTool = toolForServer(serverId);
        const parsedLine = parserTool
          ? parseSummaryLine(
              parseAndRecord(ctx, parserTool, raw ?? text, {
                intentId: state.activeIntentId,
              }),
            )
          : "";
        return {
          text: markUntrusted(text + parsedLine, { tool: "mcp_invoke", target: serverId }),
          alreadyMarkedUntrusted: true,
        };
      },
    },
  ];

  // Dynamic unlocked MCP tools (`mcp__*`)
  const mcpSpecs: UnifiedToolSpec[] = mcpHub.openaiTools.map((t) => {
    const fullName = t.function.name;
    return {
      name: fullName,
      description: `${t.function.description} Pass JSON object as argsJson.`,
      params: { argsJson: { type: "string" } },
      replay: "none",
      execute: async (args) => {
        let parsed: Record<string, unknown> = {};
        const rawJson = optStr(args.argsJson);
        if (rawJson) {
          try {
            parsed = JSON.parse(rawJson) as Record<string, unknown>;
          } catch {
            parsed = { raw: rawJson };
          }
        }
        const text = await mcpHub.call(fullName, parsed);
        state.toolCalls = ctx.usage.toolCalls;
        ckpt.save(state);
        return {
          text: markUntrusted(text, { tool: fullName }),
          alreadyMarkedUntrusted: true,
        };
      },
    };
  });

  return [...coreSpecs, ...graphSpecs, ...mcpSpecs];
}

/**
 * Build Pi Durable tool registrations from the unified catalog.
 * Uses `opt(...)` on optional properties so models are never forced to send empty strings!
 */
export function buildPiToolsFromCatalog(opts: {
  catalog: readonly UnifiedToolSpec[];
  role: WorkerRole;
  piSchema: {
    obj: (props: Record<string, unknown>) => unknown;
    str: (ann?: Record<string, unknown>) => unknown;
    num: (ann?: Record<string, unknown>) => unknown;
    opt: (s: unknown) => unknown;
  };
  definePiTool: (spec: never) => unknown;
  wrapExecute: <T>(toolName: string, out: T) => T;
}): unknown[] {
  const { catalog, role, piSchema, definePiTool, wrapExecute } = opts;
  const filtered =
    role === "leader"
      ? catalog.filter((s) => !FOLLOWER_ONLY_EXEC_TOOLS.has(s.name) && !isMcpToolName(s.name))
      : role === "follower"
        ? catalog.filter((s) => !FOLLOWER_EXCLUDED_TOOLS.has(s.name))
        : catalog;

  return filtered.map((spec) => {
    const props: Record<string, unknown> = {};
    for (const [key, param] of Object.entries(spec.params)) {
      const base =
        param.type === "number"
          ? piSchema.num(param.description ? { description: param.description } : undefined)
          : piSchema.str(param.description ? { description: param.description } : undefined);
      props[key] = param.required ? base : piSchema.opt(base);
    }
    return definePiTool({
      name: spec.name,
      description: spec.description,
      parameters: piSchema.obj(props),
      replay: spec.replay === "safe" ? "safe" : "unsafe",
      execute: async (args: Record<string, unknown>) => {
        const out = await spec.execute(args ?? {});
        const resultPayload = {
          ...(out.details ? { details: out.details } : {}),
          output: [{ type: "text" as const, text: out.text }],
          ...(out.control ? { control: out.control } : {}),
        };
        return wrapExecute(spec.name, resultPayload);
      },
    } as never);
  });
}

/** Build OpenAI function schemas filtered by current phase + static WorkerRole. */
export function buildOpenAiToolsFromCatalog(opts: {
  catalog: readonly UnifiedToolSpec[];
  history: ReturnType<typeof openHistory>;
  manifest: WorkerManifest;
  state: CheckpointState;
  mcpHub: McpHub;
  workerCount: number;
}): Array<{ type: "function"; function: { name: string; description: string; parameters: Record<string, unknown> } }> {
  const { catalog, history, manifest, state, mcpHub, workerCount } = opts;
  const leader = isExploreLeader(manifest);
  const role = resolveWorkerRole({ leader, workerCount });
  state.phase = syncGraphPhase(history, manifest.taskId, state.phase, {
    leader,
    workerCount,
    activeIntentId: state.activeIntentId,
  });
  const mcpNames = mcpHub.openaiTools.map((t) => t.function.name);
  const allowed = roleAllowedToolNames(
    state.phase,
    role === "leader" && state.activeIntentId ? "solo" : role,
    mcpNames,
  );

  // Exclude pre-wrapped `mcp__*` specs when appending raw `mcpHub.openaiTools` (which carry native MCP JSON schemas).
  const nonDynamicSpecs = catalog.filter((s) => !isMcpToolName(s.name));
  const schemas = nonDynamicSpecs.map((spec) => {
    const properties: Record<string, Record<string, unknown>> = {};
    const required: string[] = [];
    for (const [key, param] of Object.entries(spec.params)) {
      properties[key] = {
        type: param.type,
        ...(param.description ? { description: param.description } : {}),
        ...(param.enum ? { enum: param.enum } : {}),
      };
      if (param.required) required.push(key);
    }
    return {
      type: "function" as const,
      function: {
        name: spec.name,
        description: spec.description,
        parameters: {
          type: "object",
          properties,
          ...(required.length ? { required } : {}),
        },
      },
    };
  });

  return filterOpenAiTools([...schemas, ...mcpHub.openaiTools], allowed) as Array<{
    type: "function";
    function: { name: string; description: string; parameters: Record<string, unknown> };
  }>;
}

/** Execute a single OpenAI tool call against the unified catalog (or dynamic MCP tool). */
export async function executeOpenAiCatalogCall(opts: {
  catalog: readonly UnifiedToolSpec[];
  mcpHub: McpHub;
  ctx: ToolContext;
  state: CheckpointState;
  ckpt: CheckpointStore;
  name: string;
  args: Record<string, unknown>;
}): Promise<UnifiedToolOutcome> {
  const { catalog, mcpHub, ctx, state, ckpt, name, args } = opts;
  const found = catalog.find((s) => s.name === name);
  if (found && !isMcpToolName(name)) {
    const out = await found.execute(args);
    const marked =
      !out.alreadyMarkedUntrusted && isUntrustedTool(name)
        ? markUntrusted(out.text, { tool: name })
        : out.text;
    return {
      ...out,
      text: smartTruncateToolOutput(marked, 12_000),
      alreadyMarkedUntrusted: true,
    };
  }
  if (isMcpToolName(name)) {
    const raw = await mcpHub.call(name, args);
    state.toolCalls = ctx.usage.toolCalls;
    ckpt.save(state);
    return {
      text: smartTruncateToolOutput(markUntrusted(raw, { tool: name }), 12_000),
      alreadyMarkedUntrusted: true,
    };
  }
  return { text: `未知工具 ${name}` };
}

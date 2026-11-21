/**
 * Graph-driven Bootstrap → Explore → Reason protocol (P2 / handbook polish).
 * History remains authoritative; phase only gates Worker tool surface.
 */
import type { WorkerPhase } from "@gongyuai/contracts";
import type { HistoryStore, ConcludeFactInput } from "@gongyuai/history";
import type { CheckpointState } from "./checkpoint.js";
import { appendProgress } from "./tools.js";

/** Tools always available (observe / handoff / skill catalog). */
const ALWAYS = new Set([
  "history_overview",
  "history_read_fact",
  "history_list_layer",
  "asset_list",
  "asset_record",
  "load_skill",
  "enable_skill",
  "disable_skill",
  "phase_set",
  "relay",
]);

const BOOTSTRAP = new Set([
  ...ALWAYS,
  "history_append_fact",
  "intent_propose",
  "write_evidence",
  "asset_search",
  "enable_mcp",
  "disable_mcp",
]);

const EXPLORE = new Set([
  ...ALWAYS,
  "history_append_fact",
  "intent_propose",
  "intent_claim",
  "intent_conclude",
  "technique_transfer",
  "write_evidence",
  "asset_search",
  "shell",
  "install_tool",
  "assert_goal",
  "enable_mcp",
  "disable_mcp",
  "mcp_invoke",
]);

const REASON = new Set([
  ...ALWAYS,
  "history_append_fact",
  "intent_propose",
  "technique_transfer",
  "write_evidence",
  "assert_goal",
  "enable_mcp",
  "disable_mcp",
]);

/** Normalize Durable phases used by the graph scheduler. */
export function asGraphPhase(phase: WorkerPhase): WorkerPhase {
  if (phase === "loop" || phase === "init") return "bootstrap";
  return phase;
}

/**
 * Reason mutex + Explore stickiness from open Intents.
 * Does not invent π; does not override relay/report/done.
 */
export function syncGraphPhase(
  history: HistoryStore,
  taskId: string,
  phase: WorkerPhase,
): WorkerPhase {
  const p = asGraphPhase(phase);
  if (p === "relay" || p === "report" || p === "done") return p;

  const open = history.openIntents(taskId);
  const hasActive = open.some((i) =>
    ["proposed", "claimed", "running"].includes(i.status),
  );

  if (hasActive && p === "reason") return "explore";
  if (hasActive && p === "bootstrap") return "explore";
  return p;
}

export function phaseDirective(
  phase: WorkerPhase,
  opts: { openIntentCount: number; activeIntentId: string | null },
): string {
  const p = asGraphPhase(phase);
  const lines = [
    `当前图相位 phase=${p}（Bootstrap → Explore → Reason；Relay 为会话边界）。`,
    `open Intents=${opts.openIntentCount}；activeIntentId=${opts.activeIntentId ?? "—"}。`,
  ];
  if (p === "bootstrap") {
    lines.push(
      "Bootstrap：确认资产清单（auth.targets 已 seed）→ 若已配置资产收集 API 可用 asset_search（FOFA/鹰图/自定义）扩发现 → 写首批 Fact / asset_record → intent_propose（须 sourceFactIds）→ phase_set(explore)。禁止 shell / assert_goal。",
    );
  } else if (p === "explore") {
    lines.push(
      "Explore：一次只 claim 一个 Intent（本 worker 的 activeIntentId）→ 工具验证 → intent_conclude（成功须附 ≥1 Fact）。多 Explore 并发时靠 History CAS 抢 Intent，勿重复做已 claimed 的工作。FOFA/鹰图/自定义收集用 asset_search；其它枚举发现的主机用 asset_record 写入清单（自动 CIDR/通配准入）。有 open Explore 时禁止进入 Reason。",
    );
  } else if (p === "reason") {
    lines.push(
      "Reason：读资产清单 + Hint + 可迁移打法 + 新 Fact → Complete / 有界扇出新 Intent / technique_transfer 同族广播 / no-op。对 admitted/live 资产挂 sourceFactIds 继续测；oos 不扇出利用。无 open Explore 时才可运行。禁止 shell / MCP 执行。",
    );
  }
  return lines.join("\n");
}

export function allowedToolNames(
  phase: WorkerPhase,
  mcpToolNames: string[] = [],
): Set<string> {
  const p = asGraphPhase(phase);
  let base: Set<string>;
  if (p === "bootstrap") base = BOOTSTRAP;
  else if (p === "reason") base = REASON;
  else if (p === "report" || p === "done") base = new Set([...ALWAYS, "assert_goal"]);
  else base = EXPLORE; // explore | relay (relay is transient; explore tools ok)

  const out = new Set(base);
  if (p === "explore" || p === "relay") {
    for (const n of mcpToolNames) out.add(n);
  }
  return out;
}

export function filterOpenAiTools(
  tools: Array<{ type: "function"; function: { name: string; [k: string]: unknown } }>,
  allowed: Set<string>,
): typeof tools {
  return tools.filter((t) => allowed.has(t.function.name));
}

export const GRAPH_PHASE_TOOLS = [
  {
    type: "function" as const,
    function: {
      name: "phase_set",
      description:
        "Advance graph phase: bootstrap|explore|reason|report. Reason blocked while open Intents exist.",
      parameters: {
        type: "object",
        properties: {
          phase: { type: "string" },
          reason: { type: "string" },
        },
        required: ["phase"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "intent_propose",
      description:
        "Propose Intent anchored on sourceFactIds (comma-separated Fact ids or origin). Required before Explore.",
      parameters: {
        type: "object",
        properties: {
          title: { type: "string" },
          summary: { type: "string" },
          sourceFactIds: { type: "string" },
        },
        required: ["title", "sourceFactIds"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "intent_claim",
      description:
        "CAS-claim one proposed Intent for this Explore (at most one active).",
      parameters: {
        type: "object",
        properties: { intentId: { type: "string" } },
        required: ["intentId"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "intent_conclude",
      description:
        "Conclude claimed Intent. status=succeeded requires factsJson array (≥1 Fact with layer/title).",
      parameters: {
        type: "object",
        properties: {
          intentId: { type: "string" },
          status: { type: "string" },
          conclusion: { type: "string" },
          factsJson: { type: "string" },
        },
        required: ["intentId", "status", "conclusion"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "technique_transfer",
      description:
        "P4 同族迁移：把已验证打法写成 transferable Fact，并为对端非 oos 资产扇出 Intent（可选 targetAddresses 逗号列表；空=全部）。",
      parameters: {
        type: "object",
        properties: {
          sourceFactIds: { type: "string" },
          title: { type: "string" },
          summary: { type: "string" },
          familyKey: { type: "string" },
          targetAddresses: { type: "string" },
        },
        required: ["sourceFactIds", "title", "summary"],
      },
    },
  },
];

function parseFactIds(raw: string): string[] {
  return raw
    .split(/[,;\s]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function parseFactsJson(raw: string | undefined): ConcludeFactInput[] {
  if (!raw?.trim()) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((x): x is Record<string, unknown> => !!x && typeof x === "object")
      .map((x) => ({
        layer: (String(x.layer ?? "title") as ConcludeFactInput["layer"]) || "title",
        title: String(x.title ?? "untitled"),
        summary: x.summary != null ? String(x.summary) : undefined,
        evidencePath: x.evidencePath != null ? String(x.evidencePath) : undefined,
      }));
  } catch {
    return [];
  }
}

export type GraphToolCtx = {
  history: HistoryStore;
  taskId: string;
  workspaceDir: string;
  state: CheckpointState;
  workerId?: string;
  save: () => void;
};

export function handleGraphTool(
  name: string,
  args: Record<string, string>,
  ctx: GraphToolCtx,
): string | null {
  const workerId = ctx.workerId ?? "gy-worker";

  if (name === "phase_set") {
    const next = String(args.phase ?? "").trim() as WorkerPhase;
    const allowed = new Set<WorkerPhase>([
      "bootstrap",
      "explore",
      "reason",
      "report",
    ]);
    if (!allowed.has(next)) {
      return `invalid phase: ${args.phase ?? ""} (want bootstrap|explore|reason|report)`;
    }
    const open = ctx.history.openIntents(ctx.taskId);
    if (next === "reason" && open.length > 0) {
      return `denied: Reason 互斥 — ${open.length} open Intent(s); finish Explore first`;
    }
    if (next === "explore" && asGraphPhase(ctx.state.phase) === "bootstrap") {
      // ok
    }
    ctx.state.phase = next;
    ctx.save();
    appendProgress(ctx.workspaceDir, `phase=${next}${args.reason ? ` (${args.reason})` : ""}`);
    return JSON.stringify({ ok: true, phase: next });
  }

  if (name === "intent_propose") {
    const sourceFactIds = parseFactIds(args.sourceFactIds ?? "");
    try {
      const intent = ctx.history.proposeIntent({
        taskId: ctx.taskId,
        title: args.title ?? "untitled",
        summary: args.summary ?? "",
        sourceFactIds,
      });
      return JSON.stringify(intent);
    } catch (err) {
      return `错误: ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  if (name === "intent_claim") {
    if (ctx.state.activeIntentId) {
      return `denied: already exploring intent ${ctx.state.activeIntentId}; conclude it first`;
    }
    const claimed = ctx.history.claimIntent(
      ctx.taskId,
      args.intentId ?? "",
      workerId,
    );
    if (!claimed) return `claim failed (not proposed?): ${args.intentId ?? ""}`;
    ctx.state.activeIntentId = claimed.id;
    ctx.state.phase = "explore";
    ctx.save();
    appendProgress(ctx.workspaceDir, `phase=explore claim=${claimed.id}`);
    return JSON.stringify(claimed);
  }

  if (name === "intent_conclude") {
    const statusRaw = (args.status ?? "").toLowerCase();
    const status =
      statusRaw === "succeeded" || statusRaw === "success" || statusRaw === "ok"
        ? "succeeded"
        : statusRaw === "failed" || statusRaw === "fail"
          ? "failed"
          : null;
    if (!status) return `invalid status: ${args.status ?? ""} (succeeded|failed)`;
    const facts = parseFactsJson(args.factsJson);
    try {
      const done = ctx.history.concludeIntent(
        ctx.taskId,
        args.intentId ?? "",
        status,
        args.conclusion ?? "",
        { facts },
      );
      if (!done) return `conclude failed: ${args.intentId ?? ""}`;
      if (ctx.state.activeIntentId === done.id) ctx.state.activeIntentId = null;
      // After conclude: if no open intents → reason; else stay explore
      const open = ctx.history.openIntents(ctx.taskId);
      ctx.state.phase = open.length > 0 ? "explore" : "reason";
      ctx.save();
      appendProgress(
        ctx.workspaceDir,
        `intent_conclude ${done.id} → ${status}; phase=${ctx.state.phase}`,
      );
      return JSON.stringify(done);
    } catch (err) {
      return `错误: ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  if (name === "technique_transfer") {
    const sourceFactIds = parseFactIds(args.sourceFactIds ?? "");
    const targets = (args.targetAddresses ?? "")
      .split(/[,;\s]+/)
      .map((s) => s.trim())
      .filter(Boolean);
    try {
      const out = ctx.history.broadcastTechnique({
        taskId: ctx.taskId,
        sourceFactIds,
        title: args.title ?? "可迁移打法",
        summary: args.summary ?? "",
        familyKey: args.familyKey?.trim() || undefined,
        targetAddresses: targets.length ? targets : undefined,
      });
      // New Intents → stay/return Explore
      ctx.state.phase = "explore";
      ctx.save();
      appendProgress(
        ctx.workspaceDir,
        `technique_transfer ${out.techniqueFact.id} → intents=${out.intents.length} skipped=${out.skipped.length}`,
      );
      return JSON.stringify({
        ok: true,
        techniqueFactId: out.techniqueFact.id,
        intentIds: out.intents.map((i) => i.id),
        skipped: out.skipped,
      });
    } catch (err) {
      return `错误: ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  return null;
}

export function kickoffUserMessage(phase: WorkerPhase): string {
  const p = asGraphPhase(phase);
  if (p === "bootstrap") {
    return "从 Bootstrap 开始：写入首批 Fact、提出候选 Intent，然后 phase_set(explore)。完成语义以 assert_goal / evidence gate 为准；禁止口头 DONE；禁止改主机网络/VPN/代理。";
  }
  return "按当前图相位推进未通过 Goals。Explore 一次一个 Intent；Reason 在无 open Explore 时运行。全部 assert_goal 成功后可回复 DONE。禁止改主机网络/VPN/代理。";
}

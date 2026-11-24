/**
 * Graph-driven Bootstrap → Explore → Reason protocol (P2 / handbook polish).
 * History remains authoritative; phase only gates Worker tool surface.
 */
import type { ExecutionConfig, FindingConfidence, FindingSeverity, WorkerPhase } from "@gongyuai/contracts";
import {
  DEFAULT_MAX_INTENTS_PER_ASSET_ROOT,
  DEFAULT_MAX_INTENTS_PER_REASON,
  DEFAULT_REASON_LEASE_MS,
  PlanSetInputSchema,
} from "@gongyuai/contracts";
import type { ConcludeFactInput, FanoutPolicy, HistoryStore } from "@gongyuai/history";
import type { CheckpointState } from "./checkpoint.js";
import { appendProgress } from "./tools.js";

export function fanoutPolicyFromExecution(
  execution?: Partial<ExecutionConfig> | null,
): FanoutPolicy {
  return {
    maxIntentsPerReason:
      execution?.maxIntentsPerReason ?? DEFAULT_MAX_INTENTS_PER_REASON,
    maxIntentsPerAssetRoot:
      execution?.maxIntentsPerAssetRoot ?? DEFAULT_MAX_INTENTS_PER_ASSET_ROOT,
  };
}

/** Tools always available (observe / handoff / skill catalog). */
const ALWAYS = new Set([
  "history_overview",
  "history_read_fact",
  "history_list_layer",
  "asset_list",
  "asset_record",
  "finding_list",
  "load_skill",
  "enable_skill",
  "disable_skill",
  "phase_set",
  "engagement_audit",
  "relay",
  "operator_consult",
  "credential_list",
  "change_list",
  "plan_list",
  "oast_hits",
  "host_profile_list",
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
  "finding_record",
  "finding_verify",
  "finding_validate",
  "finding_retract",
  "finding_retest_context",
  "finding_retest_conclude",
  "write_evidence",
  "asset_search",
  "shell",
  "shell_job",
  "shell_session",
  "c2",
  "http_request",
  "oast_issue",
  "host_profile_record",
  "host_profile_parse",
  "attack_graph_record",
  "bloodhound_import",
  "cloud_record",
  "tunnel_open",
  "tunnel_list",
  "tunnel_close",
  "parse_tool_output",
  "change_record",
  "credential_record",
  "install_tool",
  "assert_goal",
  "enable_mcp",
  "disable_mcp",
  "mcp_invoke",
]);

const REASON = new Set([
  ...ALWAYS,
  "plan_set",
  "plan_update",
  "history_append_fact",
  "intent_propose",
  "technique_transfer",
  "finding_record",
  "finding_verify",
  "finding_validate",
  "finding_retract",
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
      "Bootstrap（渗透建图）：确认资产清单（auth.targets 已 seed）→ 若已配置资产收集 API 可用 asset_search 扩发现 → 写首批 Fact / asset_record（主机/服务，不只题号）→ intent_propose（须 sourceFactIds）→ phase_set(explore)。禁止 shell / assert_goal。",
    );
  } else if (p === "explore") {
    lines.push(
      "Explore（验证影响）：拿到 foothold 先 host_profile_record（OS/域/用户/权限/服务/共享），再按 T1046/T1069/T1087/T1135/T1021/T1550 族验证内网推进；一次只 claim 一个 Intent → 工具验证 → intent_conclude（succeeded 须附可复核 Fact/evidencePath；禁止占位 flag）。发现主机立即 asset_record；发现漏洞线索立即 finding_record，复现后 finding_verify（附 evidence/ 文件 + repro）才可进交付；high/critical 另找 worker/operator 用 finding_validate 独立确认（同一 worker 自证会被拒）。nmap/httpx/nuclei/ffuf 必须用机读输出（-oX - / -json / -jsonl / -of json），看到 [parser] mandatory 就重跑。foothold/凭据写 transferable 供横向。约 25 次工具无验证进展则 failed 换面。有 open Explore 时禁止进入 Reason。",
    );
  } else if (p === "reason") {
    lines.push(
      "Reason（战役调度）：先读观察员/作业记分卡（engagement_audit）→ 读资产清单 + Hint + transferable + Findings 台账 + 作战计划（plan_list）→ 有 ready 步骤时 intent_propose 必须带 planStepId（计划≠授权）→ 扇出跨资产 Intent / technique_transfer / 更新 engagement 叙事。repeat-failure / duplicate-open / stalled / tentative-backlog / unexplored-asset 出现时先处理，不要继续磨。对 admitted/live 资产挂 sourceFactIds 继续测；oos 禁止作利用唯一前驱。扇出硬顶 maxIntentsPerReason / 同根 maxIntentsPerAssetRoot。交付叙述只引用 verified finding；high/critical 须有独立确认。无 open Explore 时才可运行。禁止 shell / MCP 执行。",
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
      name: "engagement_audit",
      description:
        "Read-only deterministic audit: repeat failures, duplicate/stalled Intents, tentative backlog, untouched high-weight assets, idle credentials + engagement scorecard (confirmation rate / gaps). Suggestions only — no dispatch, no scope change.",
      parameters: {
        type: "object",
        properties: {},
        required: [],
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
          technique: { type: "string" },
          assetRoot: { type: "string" },
          planStepId: { type: "string" },
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
        "同族迁移：写 transferable Fact 并为对端非 oos 资产扇出 Intent。familyKey 可省略（系统按指纹/组件/同源启发式补全）。受 maxIntentsPerReason / 同根硬顶约束。",
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
  {
    type: "function" as const,
    function: {
      name: "finding_record",
      description:
        "Record a vuln lead as a tentative Finding (dedup idempotent by asset|vulnClass|endpoint). severity=info|low|medium|high|critical; vulnClass like CWE-89. tentative 不进交付；复现后用 finding_verify。",
      parameters: {
        type: "object",
        properties: {
          title: { type: "string" },
          asset: { type: "string" },
          vulnClass: { type: "string" },
          severity: { type: "string" },
          endpoint: { type: "string" },
          confidence: { type: "string" },
          cvss: { type: "string" },
          dedupKey: { type: "string" },
          factIds: { type: "string" },
          impact: { type: "string" },
          fix: { type: "string" },
        },
        required: ["title", "asset", "vulnClass", "severity"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "finding_verify",
      description:
        "Promote a tentative Finding to verified. Requires ≥1 evidence file under evidence/ (comma-separated paths, SHA-256 sealed) AND non-empty repro steps. Only verified findings enter the delivery report.",
      parameters: {
        type: "object",
        properties: {
          findingId: { type: "string" },
          evidencePaths: { type: "string" },
          repro: { type: "string" },
          impact: { type: "string" },
          fix: { type: "string" },
          cvss: { type: "string" },
        },
        required: ["findingId", "evidencePaths", "repro"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "finding_validate",
      description:
        "P15-C1 independent validation of an already-verified Finding. The calling worker must NOT be the verifier; History refuses self-validation. verdict=confirmed|refuted|inconclusive|out-of-scope; method=evidence-only|replay|control-compare|manual. confirmed/refuted require evidence; rows are append-only and do not mutate the Finding.",
      parameters: {
        type: "object",
        properties: {
          findingId: { type: "string" },
          verdict: { type: "string" },
          method: { type: "string" },
          evidencePaths: { type: "string" },
          note: { type: "string" },
        },
        required: ["findingId", "verdict", "method"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "finding_retract",
      description:
        "Retract a false-positive Finding (row retained for audit; terminal state). Requires reason.",
      parameters: {
        type: "object",
        properties: {
          findingId: { type: "string" },
          reason: { type: "string" },
        },
        required: ["findingId", "reason"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "finding_list",
      description:
        "List the Finding ledger (severity desc; includes tentative/retracted with status). Optional status filter.",
      parameters: {
        type: "object",
        properties: {
          status: { type: "string" },
        },
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "finding_retest_context",
      description:
        "P14 复测：读取单个 finding 的原始证据、repro、状态与历史复测（只复测这一条，不扩面）。",
      parameters: {
        type: "object",
        properties: { findingId: { type: "string" } },
        required: ["findingId"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "finding_retest_conclude",
      description:
        "P14 复测结论：verdict=reproduced|fixed|inconclusive。fixed 需 repro+证据；一次请求失败不能证明已修复；只有 fixed 会推进 finding 状态。",
      parameters: {
        type: "object",
        properties: {
          findingId: { type: "string" },
          verdict: { type: "string" },
          evidencePaths: { type: "string" },
          repro: { type: "string" },
          note: { type: "string" },
          reviewer: { type: "string" },
        },
        required: ["findingId", "verdict"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "plan_set",
      description:
        "P14 计划链：用有序步骤替换任务计划（最多 20 步）。每步可声明 needsFactIds/needsIntentIds/needsFindingIds；只有依赖已满足的最小步骤可派单。计划≠授权。",
      parameters: {
        type: "object",
        properties: { stepsJson: { type: "string" } },
        required: ["stepsJson"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "plan_update",
      description: "改计划步骤的标题/备注（状态由系统派生，不接受自报完成）。",
      parameters: {
        type: "object",
        properties: { stepId: { type: "string" }, title: { type: "string" }, summary: { type: "string" } },
        required: ["stepId"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "plan_list",
      description: "列出当前计划步骤与派生状态（ready 才是可派单的下一步）。",
      parameters: { type: "object", properties: {} },
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
  /** From task execution config; drives Reason/transfer hard caps + leases. */
  execution?: Partial<ExecutionConfig> | null;
};

export function handleGraphTool(
  name: string,
  args: Record<string, string>,
  ctx: GraphToolCtx,
): string | null {
  const workerId = ctx.workerId ?? "gy-worker";

  const fanout = fanoutPolicyFromExecution(ctx.execution);
  const reasonLeaseMs = ctx.execution?.reasonLeaseMs ?? DEFAULT_REASON_LEASE_MS;

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
    if (next === "reason" && reasonLeaseMs > 0) {
      const lease = ctx.history.tryAcquireReasonLease(
        ctx.taskId,
        workerId,
        reasonLeaseMs,
      );
      if (!lease.ok) {
        return `denied: Reason lease held by ${lease.owner} until ${lease.until}`;
      }
    }
    if (next !== "reason" && asGraphPhase(ctx.state.phase) === "reason") {
      ctx.history.releaseReasonLease(ctx.taskId, workerId);
    }
    ctx.state.phase = next;
    ctx.save();
    appendProgress(ctx.workspaceDir, `phase=${next}${args.reason ? ` (${args.reason})` : ""}`);
    return JSON.stringify({ ok: true, phase: next });
  }

  if (name === "engagement_audit") {
    // Read-only: no Intent / Fact / Goal write, no lease, no scope mutation.
    return JSON.stringify(ctx.history.engagementAudit(ctx.taskId));
  }

  if (name === "intent_propose") {
    const sourceFactIds = parseFactIds(args.sourceFactIds ?? "");
    const inReason = asGraphPhase(ctx.state.phase) === "reason";
    if (inReason && reasonLeaseMs > 0) {
      const lease = ctx.history.tryAcquireReasonLease(
        ctx.taskId,
        workerId,
        reasonLeaseMs,
      );
      if (!lease.ok) {
        return `错误: Reason lease held by ${lease.owner} until ${lease.until}`;
      }
    }
    try {
      const intent = ctx.history.proposeIntent({
        taskId: ctx.taskId,
        title: args.title ?? "untitled",
        summary: args.summary ?? "",
        sourceFactIds,
        ...(args.technique ? { technique: args.technique } : {}),
        ...(args.assetRoot ? { assetRoot: args.assetRoot } : {}),
        ...(args.planStepId ? { planStepId: args.planStepId } : {}),
        rejectOosOnly: true,
        fanout: inReason ? fanout : undefined,
      });
      return JSON.stringify(intent);
    } catch (err) {
      return `错误: ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  if (name === "finding_retest_context") {
    const finding = ctx.history.getFinding(ctx.taskId, args.findingId ?? "");
    if (!finding) return `错误: unknown finding ${args.findingId ?? ""}`;
    return JSON.stringify({
      finding,
      retests: ctx.history.listFindingRetests(ctx.taskId, finding.id),
      transactions: ctx.history
        .listHttpTransactions(ctx.taskId, 100)
        .filter((tx) => tx.host === finding.asset)
        .slice(0, 10),
      note: "只复测这一条；证据用 http:<id> 或 evidence 文件；一次失败≠已修复。",
    });
  }

  if (name === "finding_retest_conclude") {
    const verdictRaw = (args.verdict ?? "").trim().toLowerCase();
    const verdict =
      verdictRaw === "reproduced" || verdictRaw === "still-present" ? "reproduced"
        : verdictRaw === "fixed" || verdictRaw === "still-fixed" ? "fixed"
          : verdictRaw === "inconclusive" ? "inconclusive"
            : null;
    if (!verdict) return `错误: verdict must be reproduced|fixed|inconclusive`;
    try {
      const { retest, finding } = ctx.history.recordFindingRetest(
        ctx.taskId,
        args.findingId ?? "",
        {
          verdict,
          evidencePaths: parseFactIds(args.evidencePaths ?? ""),
          repro: args.repro ?? "",
          note: args.note ?? "",
          reviewer: args.reviewer || ctx.workerId || "worker",
        },
      );
      return JSON.stringify({ ok: true, retest, finding });
    } catch (err) {
      return `错误: ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  if (name === "plan_set") {
    try {
      const parsed = JSON.parse(args.stepsJson ?? "[]") as unknown;
      const input = PlanSetInputSchema.parse({ steps: parsed });
      const plan = ctx.history.setPlan(ctx.taskId, input.steps);
      return JSON.stringify({ ok: true, steps: plan });
    } catch (err) {
      return `错误: ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  if (name === "plan_update") {
    try {
      const step = ctx.history.updatePlanStep(ctx.taskId, args.stepId ?? "", {
        ...(args.title ? { title: args.title } : {}),
        ...(args.summary ? { summary: args.summary } : {}),
      });
      return JSON.stringify(step);
    } catch (err) {
      return `错误: ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  if (name === "plan_list") {
    return JSON.stringify(ctx.history.listPlan(ctx.taskId));
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
    ctx.state.activeIntentClaimedAt = new Date().toISOString();
    ctx.state.toolsAtIntentClaim = ctx.state.toolCalls;
    ctx.state.lastSoftSurfaceMilestone = 0;
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
      if (ctx.state.activeIntentId === done.id) {
        ctx.state.activeIntentId = null;
        ctx.state.activeIntentClaimedAt = null;
        ctx.state.toolsAtIntentClaim = null;
        ctx.state.lastSoftSurfaceMilestone = 0;
      }
      const open = ctx.history.openIntents(ctx.taskId);
      ctx.state.phase = open.length > 0 ? "explore" : "reason";
      if (ctx.state.phase === "reason" && reasonLeaseMs > 0) {
        ctx.history.tryAcquireReasonLease(ctx.taskId, workerId, reasonLeaseMs);
      }
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
        fanout,
      });
      ctx.state.phase = "explore";
      ctx.history.releaseReasonLease(ctx.taskId, workerId);
      ctx.save();
      appendProgress(
        ctx.workspaceDir,
        `technique_transfer ${out.techniqueFact.id} family=${out.familyKey ?? "—"} → intents=${out.intents.length} skipped=${out.skipped.length}`,
      );
      return JSON.stringify({
        ok: true,
        techniqueFactId: out.techniqueFact.id,
        familyKey: out.familyKey,
        familyKeyVia: out.familyKeyVia,
        intentIds: out.intents.map((i) => i.id),
        skipped: out.skipped,
      });
    } catch (err) {
      return `错误: ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  if (name === "finding_record") {
    const severity = String(args.severity ?? "").toLowerCase();
    if (!["info", "low", "medium", "high", "critical"].includes(severity)) {
      return `invalid severity: ${args.severity ?? ""} (info|low|medium|high|critical)`;
    }
    const confidence = args.confidence?.trim().toLowerCase();
    if (confidence && confidence !== "tentative" && confidence !== "firm") {
      return `invalid confidence: ${args.confidence} (tentative|firm)`;
    }
    try {
      const r = ctx.history.recordFinding({
        taskId: ctx.taskId,
        title: args.title ?? "",
        asset: args.asset ?? "",
        vulnClass: args.vulnClass ?? "",
        severity: severity as FindingSeverity,
        confidence: (confidence as FindingConfidence | undefined) ?? undefined,
        endpoint: args.endpoint?.trim() || null,
        cvss: args.cvss?.trim() || null,
        dedupKey: args.dedupKey?.trim() || undefined,
        factIds: parseFactIds(args.factIds ?? ""),
        intentId: ctx.state.activeIntentId,
        impact: args.impact ?? "",
        fix: args.fix ?? "",
      });
      appendProgress(
        ctx.workspaceDir,
        `finding_record ${r.finding.id} (${r.finding.severity}/${r.finding.status}) ${r.finding.title}${r.created ? "" : " [dedup]"}`,
      );
      return JSON.stringify(r);
    } catch (err) {
      return `错误: ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  if (name === "finding_verify") {
    try {
      const finding = ctx.history.verifyFinding(
        ctx.taskId,
        args.findingId ?? "",
        {
          evidencePaths: parseFactIds(args.evidencePaths ?? ""),
          repro: args.repro ?? "",
          impact: args.impact,
          fix: args.fix,
          cvss: args.cvss?.trim() || undefined,
          verifiedBy: workerId,
        },
      );
      appendProgress(
        ctx.workspaceDir,
        `finding_verify ${finding.id} → ${finding.status} evidence=${finding.evidence.length}`,
      );
      return JSON.stringify(finding);
    } catch (err) {
      return `错误: ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  if (name === "finding_validate") {
    const verdictRaw = (args.verdict ?? "").trim().toLowerCase();
    const verdict =
      verdictRaw === "confirmed" || verdictRaw === "refuted" ||
      verdictRaw === "inconclusive" || verdictRaw === "out-of-scope"
        ? verdictRaw
        : null;
    const methodRaw = (args.method ?? "").trim().toLowerCase();
    const method =
      methodRaw === "evidence-only" || methodRaw === "replay" ||
      methodRaw === "control-compare" || methodRaw === "manual"
        ? methodRaw
        : null;
    if (!verdict) return "错误: verdict must be confirmed|refuted|inconclusive|out-of-scope";
    if (!method) return "错误: method must be evidence-only|replay|control-compare|manual";
    try {
      const result = ctx.history.recordFindingValidation(
        ctx.taskId,
        args.findingId ?? "",
        {
          verdict,
          method,
          evidencePaths: parseFactIds(args.evidencePaths ?? ""),
          note: args.note ?? "",
          validator: workerId,
        },
      );
      appendProgress(
        ctx.workspaceDir,
        `finding_validate ${result.validation.findingId} → ${result.validation.verdict} by ${workerId}`,
      );
      return JSON.stringify(result);
    } catch (err) {
      return `错误: ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  if (name === "finding_retract") {
    try {
      const finding = ctx.history.retractFinding(
        ctx.taskId,
        args.findingId ?? "",
        args.reason ?? "",
      );
      appendProgress(ctx.workspaceDir, `finding_retract ${finding.id}`);
      return JSON.stringify(finding);
    } catch (err) {
      return `错误: ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  if (name === "finding_list") {
    const status = args.status?.trim().toLowerCase();
    const all = ctx.history.listFindings(ctx.taskId);
    const findings = status ? all.filter((f) => f.status === status) : all;
    return JSON.stringify({ ok: true, count: findings.length, findings });
  }

  return null;
}

export function kickoffUserMessage(phase: WorkerPhase): string {
  const p = asGraphPhase(phase);
  if (p === "bootstrap") {
    return "从 Bootstrap 建图开始：asset_record / Fact → intent_propose → phase_set(explore)。按授权渗透测试作业推进（攻击面、验证影响、可审计 finding），不是夺旗。长程任务禁止因预算/时间估计提前收口。完成语义以 assert_goal / evidence gate 为准；禁止口头 DONE；禁止改主机网络/VPN/代理。";
  }
  return "按当前图相位以渗透测试节奏推进未通过 Goals（建图→验证→写 finding→横向/换面；长程勿提前收口）。Explore 一次一个 Intent；Reason 在无 open Explore 时运行。全部 assert_goal 成功后可回复 DONE。禁止改主机网络/VPN/代理。";
}

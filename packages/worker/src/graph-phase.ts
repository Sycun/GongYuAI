/**
 * Graph-driven Bootstrap → Explore → Reason protocol (P2 / handbook polish).
 * History remains authoritative; phase only gates Worker tool surface.
 */
import type {
  ExecutionConfig,
  Finding,
  FindingConfidence,
  FindingQualification,
  FindingSeverity,
  WorkerPhase,
} from "@gongyuai/contracts";
import {
  DEFAULT_MAX_CONCURRENT_EXPLORES,
  DEFAULT_MAX_INTENTS_PER_ASSET_ROOT,
  DEFAULT_MAX_INTENTS_PER_REASON,
  DEFAULT_REASON_LEASE_MS,
  PlanSetInputSchema,
} from "@gongyuai/contracts";
import {
  closeFindingWindow,
  getTrafficLive,
  promoteTrafficForFinding,
  readTrafficBodyLive,
  targetHostOf,
  type PromoteTrafficResult,
} from "@gongyuai/exec";
import type { ConcludeFactInput, FanoutPolicy, HistoryStore } from "@gongyuai/history";
import type { CheckpointState } from "./checkpoint.js";
import { appendProgress } from "./tools.js";

export function fanoutPolicyFromExecution(
  execution?: Partial<ExecutionConfig> | null,
): FanoutPolicy {
  const configuredExplores =
    execution?.maxConcurrentExplores ?? DEFAULT_MAX_CONCURRENT_EXPLORES;
  const basePerReason =
    execution?.maxIntentsPerReason ?? DEFAULT_MAX_INTENTS_PER_REASON;
  return {
    maxIntentsPerReason: Math.max(basePerReason, configuredExplores),
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
  "tunnel_list",
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
  "tsecbench",
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
  "fact_draft",
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
  "install_mcp",
  "install_skill",
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
 * Converged Super-agent role model ("一主两辅"):
 * - `solo`: single-process worker (`workerCount <= 1`), owns Bootstrap → Explore → Reason → Report.
 * - `leader`: multi-worker coordinator (`slot 0`, `workerCount > 1`), pure Planner/Validator/Reporter (no exec tools).
 * - `follower`: multi-worker executor (`slot 1..N`), runs isolated single-Intent Explore turns.
 */
export type WorkerRole = "solo" | "leader" | "follower";

export function resolveWorkerRole(opts: {
  leader?: boolean;
  workerCount?: number;
}): WorkerRole {
  if ((opts.workerCount ?? 1) <= 1) return "solo";
  return opts.leader !== false ? "leader" : "follower";
}

/**
 * Tool schema published to the model.
 * Slot 0 keeps the solo surface while it still holds a pre-scale Intent;
 * once that Intent is gone and the pool is N, the schema becomes leader-only.
 */
export function piToolSurfaceRole(opts: {
  leader?: boolean;
  workerCount?: number;
  activeIntentId?: string | null;
}): WorkerRole {
  const role = resolveWorkerRole(opts);
  if (role === "leader" && opts.activeIntentId) return "solo";
  return role;
}

/** Execution tools physically stripped from a multi-worker Leader ("脑手分离"). */
export const FOLLOWER_ONLY_EXEC_TOOLS = new Set([
  "shell",
  "shell_job",
  "shell_session",
  "c2",
  "http_request",
  "tunnel_open",
  "tunnel_close",
  "mcp_invoke",
]);

/**
 * Planning, campaign-audit, relay, and validator tools physically stripped from
 * multi-worker Explore Followers ("探索期工具面减负 / 去文书税").
 */
export const FOLLOWER_EXCLUDED_TOOLS = new Set([
  "assert_goal",
  "phase_set",
  "engagement_audit",
  "relay",
  "plan_list",
  "plan_set",
  "plan_update",
  "technique_transfer",
  "finding_validate",
  "finding_retest_context",
  "finding_retest_conclude",
  "enable_skill",
  "disable_skill",
  "change_list",
]);

/**
 * Reason mutex + Explore stickiness from open Intents.
 * Does not invent π; does not override relay/report/done.
 */
export function syncGraphPhase(
  history: HistoryStore,
  taskId: string,
  phase: WorkerPhase,
  opts?: { leader?: boolean; workerCount?: number; activeIntentId?: string | null },
): WorkerPhase {
  const p = asGraphPhase(phase);
  if (p === "relay" || p === "report" || p === "done") return p;

  if (opts?.leader === false) {
    return "explore";
  }

  const multiWorkerLeader = opts?.leader === true && (opts.workerCount ?? 1) > 1;
  if (multiWorkerLeader) {
    // Multi-worker leader owns Bootstrap/Reason/Report and delegates Explore to followers.
    // Never kick leader into Explore mid-fanout just because followers' Intents exist.
    if (p === "bootstrap" || p === "reason") return p;
    if (p === "explore" && !opts?.activeIntentId) return "reason";
    return p;
  }

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
  opts: {
    openIntentCount: number;
    activeIntentId: string | null;
    leader?: boolean;
    workerCount?: number;
    maxConcurrentExplores?: number;
  },
): string {
  const p = asGraphPhase(phase);
  const multiWorkerLeader = opts.leader === true && (opts.workerCount ?? 1) > 1;
  const exploreSlots = Math.max(1, (opts.workerCount ?? 1) - 1);
  const lines = [
    `当前图相位 phase=${p}（Bootstrap → Explore → Reason；Relay 为会话边界）。`,
    `open Intents=${opts.openIntentCount}；activeIntentId=${opts.activeIntentId ?? "—"}${multiWorkerLeader ? `；角色=Leader 调度（管理 ${exploreSlots} 路并发 Follower）` : ""}。`,
  ];
  if (p === "bootstrap") {
    if (multiWorkerLeader) {
      lines.push(
        `Bootstrap（多节点并发开局）：你是 slot 0 Leader，拥有 ${exploreSlots} 个并发 Explore Follower。先确认/开启首批目标坐标（靶场任务先调 tsecbench list，优先按 difficulty 由易到难 easy → medium → hard 挑题，避免开局全压硬题阻塞流水线；多目标任务连续 start 最多 3 台未完成靶机填满并发槽位）→ 扇出 ${exploreSlots} 条独立 Intent（勿传 claim='true'，严禁多目标混塞同一 Intent；若当前活跃可测主机少于 ${exploreSlots} 台——如单目标重点渗透或尾盘攻坚——直接对同一重点 assetRoot 按正交 technique 并行拆出 2～3 条独立 Intent，如 recon-surface / greybox-auth-logic / known-cve-poc 同时推进）→ 随后 phase_set('reason') 进入驻留监听。禁止 shell / assert_goal。`,
      );
    } else {
      const wantScale = (opts.maxConcurrentExplores ?? DEFAULT_MAX_CONCURRENT_EXPLORES) > 1;
      lines.push(
        `Bootstrap（建图启动）：确认目标坐标（靶场任务先调 tsecbench list，优先按 easy → medium → hard 梯队 start，系统会自动准入容器地址并建 live 资产 Fact${wantScale ? "；已开启自动并发扩容：多资产时为每台资产分别 intent_propose，单重点资产时也可按正交 technique 并行拆出 2～3 条独立 Intent（兄弟单不传 claim='true'），控制面会自动拉起并发 Follower 并行接单" : ""}）→ 写首批 Fact 或直接 intent_propose（单路串行时可传 claim='true' 一步直入 Explore）。禁止 shell / assert_goal。`,
      );
    }
  } else if (p === "explore") {
    lines.push(
      "Explore（轻装试错 · 客观收束）：先读 Observe 中的委托简报（预置账号/内部域名/多目标数）与「存活持久连接与后台设施」（跨 Intent 直接复用已有 SOCKS 隧道、PTY shell_session 与后台监听），一次只 claim 一个 Intent → 高速验证（同目标多路并行时工作区临时文件/Cookie 按 <host>-<technique>-* 隔离命名；随时用 fact_draft 更新草稿防超时丢失；平时不写长篇台账报告）→ 仅在拿到实质突破（可复现漏洞/有效凭据/立足点/内网新主机）或进入 3 步收尾保护窗时集中入账（finding_verify / credential_record / host_profile_record / asset_record，支持 tunnel_open / proxychains 内网横移）→ intent_conclude（未完全达成时只准客观陈述测试接口、响应状态码/特征、产物路径及存活会话/隧道标识，严禁写“无漏洞/此路不通/已穷尽”绝对否定结论）。",
    );
  } else if (p === "reason") {
    lines.push(
      `Reason（战役调度）：先读观察员/作业记分卡（engagement_audit）→ 读资产清单 + 存活隧道/会话 + Hint + transferable + Findings 台账 + 作战计划（plan_list）→ 优先为 0 Intent 未触达资产补单；当活跃可测主机少于并发槽位或面对复杂重点资产/跳板内网时，主动对同一 assetRoot 按不同正交 technique 并行扇出 2～3 条短 Intent（如 recon-ports-fingerprint、greybox-auth-logic、known-cve-poc、intranet-pivot 并行推进，复用已建立的隧道与会话）→ 更新 engagement 叙事。${multiWorkerLeader ? `当前 ${exploreSlots} 路并发 Follower 在岗：靶场已解题或本轮时间盒耗尽容器先 tsecbench(close) 腾槽，优先按 easy → medium → hard 梯队 start 新题（首探 12m 快扫建图，二探 30m 攻坚长链，三探+ 45m 纵深决战，阶段突破自动续期 20m），尾盘题少时单题多路正交并进保持 ${exploreSlots} 路满槽（勿传 claim='true'）。` : "单节点下 intent_propose 可传 claim='true' 直接切入 Explore。"}repeat-failure / duplicate-open / stalled / tentative-backlog / unexplored-asset 出现时先处理，不要继续磨。可质疑子会话失败结论的完整性并换正交维度重测；oos 禁止作利用唯一前驱。交付叙述只引用 verified finding。禁止 shell / MCP 执行。`,
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

/**
 * Effective tool surface combining graph phase + static worker role:
 * - `leader` never receives follower execution tools or dynamic `mcp__*` tools;
 * - `follower` strips planning, campaign-audit, relay, validator, and goal-assertion tools
 *   so tactical exploration stays lean and KV-cache-friendly.
 */
export function roleAllowedToolNames(
  phase: WorkerPhase,
  role: WorkerRole,
  mcpToolNames: string[] = [],
): Set<string> {
  const out = allowedToolNames(
    phase,
    role === "leader" ? [] : mcpToolNames,
  );
  if (role === "leader") {
    for (const execTool of FOLLOWER_ONLY_EXEC_TOOLS) {
      out.delete(execTool);
    }
  } else if (role === "follower") {
    for (const excluded of FOLLOWER_EXCLUDED_TOOLS) {
      out.delete(excluded);
    }
  }
  return out;
}

export function filterOpenAiTools(
  tools: Array<{ type: "function"; function: { name: string; [k: string]: unknown } }>,
  allowed: Set<string>,
): typeof tools {
  return tools.filter((t) => allowed.has(t.function.name));
}

const EXECUTION_TOOLS = new Set([
  "shell",
  "shell_job",
  "shell_session",
  "c2",
  "http_request",
  "oast_issue",
  "tunnel_open",
  "tunnel_close",
  "install_tool",
  "install_mcp",
  "install_skill",
  "mcp_invoke",
]);

const READONLY_ACTIONS: Record<string, Set<string>> = {
  shell_job: new Set(["poll", "wait", "list"]),
  shell_session: new Set(["read", "wait", "list"]),
  c2: new Set(["list", "sessions", "read", "note", "blob-get"]),
};

export function executionRequiresActiveIntent(
  name: string,
  args?: Record<string, unknown>,
): boolean {
  if (name === "mcp_invoke" || name.startsWith("mcp__")) return true;
  if (!EXECUTION_TOOLS.has(name)) return false;
  const readonly = READONLY_ACTIONS[name];
  if (readonly) {
    const action = String(args?.action ?? "").trim().toLowerCase();
    if (action && readonly.has(action)) return false;
  }
  return true;
}

export function executionIntentDenial(opts: {
  history: HistoryStore;
  taskId: string;
  workerId: string;
  state: CheckpointState;
  name: string;
  args?: Record<string, unknown>;
}): string | undefined {
  if (!executionRequiresActiveIntent(opts.name, opts.args)) return undefined;
  const intentId = opts.state.activeIntentId;
  if (!intentId) {
    return `denied: ${opts.name} requires an active claimed Intent; intent_claim first`;
  }
  const intent = opts.history.getIntent(opts.taskId, intentId);
  if (!intent || !["claimed", "running"].includes(intent.status)) {
    return `denied: active Intent ${intentId} is not claimed/running`;
  }
  if (intent.claimedBy !== opts.workerId) {
    return `denied: active Intent ${intentId} claimed by ${intent.claimedBy ?? "nobody"}, not ${opts.workerId}`;
  }
  return undefined;
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
        "Propose Intent anchored on sourceFactIds (comma-separated Fact ids or origin). Set claim='true' in single-worker mode to immediately claim & enter Explore in one step.",
      parameters: {
        type: "object",
        properties: {
          title: { type: "string" },
          summary: { type: "string" },
          sourceFactIds: { type: "string" },
          technique: { type: "string" },
          assetRoot: { type: "string" },
          planStepId: { type: "string" },
          claim: { type: "string" },
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
      name: "fact_draft",
      description:
        "Save or overwrite an incremental objective discovery draft during Explore (auto-rescued on timeout or used on intent_conclude). Record tested inputs, observed status/responses, workspace file paths, and live session/listener info; never write absolute negative claims.",
      parameters: {
        type: "object",
        properties: {
          title: { type: "string" },
          summary: { type: "string" },
          evidencePath: { type: "string" },
        },
        required: ["title", "summary"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "intent_conclude",
      description:
        "Conclude claimed Intent. status=succeeded requires factsJson array (≥1 Fact with layer/title, or a prior fact_draft). When status=failed, conclusion must state objective tested inputs, observed responses, and saved file/session refs — never declare a surface 'impossible' or 'exhausted'.",
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
        "Record a vuln lead as a tentative Finding (dedup idempotent by asset|vulnClass|endpoint). severity=info|low|medium|high|critical; vulnClass like CWE-89. tentative 不进交付；复现后用 finding_verify 补齐结构化步骤、根因与修复建议。",
      parameters: {
        type: "object",
        properties: {
          title: { type: "string", description: "明确含『目标组件 + 漏洞点 + 漏洞类型 + 实际危害』的可读标题。" },
          asset: { type: "string" },
          vulnClass: { type: "string", description: "CWE 编号或分类标识（如 CWE-89 / CWE-306 / AUTHZ-BOLA）。" },
          severity: { type: "string" },
          endpoint: { type: "string", description: "受影响的完整协议端点/接口路径与关键参数。" },
          confidence: { type: "string" },
          cvss: { type: "string" },
          dedupKey: { type: "string" },
          factIds: { type: "string" },
          summary: { type: "string", description: "一句话概述：是什么漏洞、位于何处、可造成什么后果。" },
          affectedScope: { type: "string", description: "受影响范围与利用前提（资产/接口/参数/组件版本/所需权限）。" },
          rootCause: { type: "string", description: "成因与技术机理（如缺失鉴权、拼接 SQL、危险配置暴露等）。" },
          repro: { type: "string", description: "初步验证或复现步骤（建议按 ### 步骤 1：... 分步记录）。" },
          impact: { type: "string", description: "业务影响与危害评估及严重等级依据。" },
          fix: { type: "string", description: "具体可落地的修复与加固建议。" },
          pocCurl: {
            type: "string",
            description: "Optional reproducible curl command or PoC script for independent verification.",
          },
          qualification: {
            type: "string",
            description: "Optional Dark-Moon qualification: unconfirmed | confirmed | exploited.",
          },
          trafficIds: {
            type: "string",
            description: "Optional comma-separated traffic ids (from traffic_search, http:<id> ok) to persist with this finding. Recent same-intent/same-host traffic is kept automatically.",
          },
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
        "Promote a tentative Finding to verified with ARTEX-grade report details. Requires ≥1 evidence item (evidence/ path, http:<id>, or oast:<token>, SHA-256 sealed) AND structured repro steps. Always populate summary, affectedScope, rootCause, impact, fix, and pocCurl based on real verified evidence.",
      parameters: {
        type: "object",
        properties: {
          findingId: { type: "string" },
          evidencePaths: { type: "string", description: "逗号分隔的封存证据路径或引用（如 findings/poc.txt, http:<id>, oast:<token>）。" },
          summary: { type: "string", description: "一句话漏洞概述：是什么漏洞、在哪、造成什么实际后果。" },
          affectedScope: { type: "string", description: "受影响的资产、接口、参数、组件版本及前置利用条件。" },
          repro: {
            type: "string",
            description: "可照做复现的分步操作，使用『### 步骤 1：<动作标题>』『### 步骤 2：<动作标题>』编号展开，每步写明操作输入/请求或命令、实际输出回显及对应证据来源。",
          },
          rootCause: {
            type: "string",
            description: "漏洞根因分析：从代码逻辑、协议机制或安全配置层面说明漏洞产生原因（如缺参数化绑定、未授权暴露 FastCGI 端口等）。",
          },
          impact: {
            type: "string",
            description: "影响与危害：结合业务与系统架构说明已证实的最坏后果（RCE/数据泄露/越权接管/内网横向等）及定级依据。",
          },
          fix: {
            type: "string",
            description: "修复建议：针对根因给出具体、可落地的代码/配置整改措施与加固建议（避免空泛套话）。",
          },
          cvss: { type: "string" },
          pocCurl: {
            type: "string",
            description: "可直接复用的完整利用命令、curl 报文或 PoC 脚本。",
          },
          report: {
            type: "string",
            description: "可选：完整 ARTEX 风格单漏洞详细报告（Markdown，含 ## 概述 / ## 影响与危害 / ## 受影响范围 / ## 复现步骤 / ## 证据 / ## PoC / ## 根因分析 / ## 修复建议）。",
          },
          qualification: {
            type: "string",
            description: "Optional Dark-Moon qualification: unconfirmed | confirmed | exploited.",
          },
          trafficIds: { type: "string", description: "Optional comma-separated traffic ids of the reproduction." },
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
  /** slot 0 leader owns Bootstrap/Reason/Report; followers only Explore. */
  leader?: boolean;
  workerCount?: number;
  /** Task data dir holding traffic/ (proxy taskDir). Enables finding traffic capture. */
  trafficDir?: string;
};

type CapturedTraffic = {
  trafficIds: string[];
  finding: Finding | null;
  summary: { trafficIds: string[]; promoted: number; window: PromoteTrafficResult["window"] };
};

/**
 * Persist the traffic around a finding: promote matching recent exchanges
 * from the in-memory ring and open (or converge) the post-window. Best-effort:
 * never fails the finding tool.
 */
const REDACTED_CURL_HEADERS = new Set([
  "authorization",
  "proxy-authorization",
  "cookie",
  "set-cookie",
  "x-api-key",
  "x-auth-token",
]);

const SKIP_CURL_HEADERS = new Set([
  "host",
  "content-length",
  "connection",
  "accept-encoding",
  "transfer-encoding",
]);

function shellSingleQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function parseQualification(raw: string | undefined): FindingQualification | undefined {
  const v = raw?.trim().toLowerCase();
  if (v === "unconfirmed" || v === "confirmed" || v === "exploited") return v;
  return undefined;
}

/** Synthesize a safe, reproducible curl command from the most relevant captured exchange. */
export function buildPocCurlFromTraffic(trafficDir: string, trafficIds: readonly string[]): string | null {
  for (let i = trafficIds.length - 1; i >= 0; i--) {
    const id = trafficIds[i]!;
    const ex = getTrafficLive(trafficDir, id);
    if (!ex || !/^https?:\/\//i.test(ex.url)) continue;
    const parts = ["curl", "-sS"];
    const method = (ex.method || "GET").toUpperCase();
    if (method !== "GET") parts.push("-X", method);
    for (const [rawKey, rawVal] of Object.entries(ex.reqHeaders ?? {})) {
      const key = rawKey.toLowerCase();
      if (SKIP_CURL_HEADERS.has(key)) continue;
      const val = REDACTED_CURL_HEADERS.has(key)
        ? "<redacted>"
        : Array.isArray(rawVal)
          ? rawVal.join(", ")
          : String(rawVal);
      if (!val.trim()) continue;
      parts.push("-H", shellSingleQuote(`${rawKey}: ${val.slice(0, 240)}`));
    }
    if (ex.reqBodyBlob && ex.reqBodyBlob.size > 0 && ex.reqBodyBlob.size <= 4096) {
      const slice = readTrafficBodyLive(trafficDir, id, "req", 0, 2048);
      if (slice?.body && !/\u0000/.test(slice.body)) {
        parts.push("--data-raw", shellSingleQuote(slice.body));
      }
    }
    parts.push(shellSingleQuote(ex.url));
    return parts.join(" ");
  }
  return null;
}

function captureFindingTraffic(
  ctx: GraphToolCtx,
  finding: Finding,
  opts: { trafficIds?: string[]; converge?: boolean },
): CapturedTraffic | null {
  if (!ctx.trafficDir) return null;
  try {
    const endpointHost = finding.endpoint ? targetHostOf(finding.endpoint) : undefined;
    const endpointIsUrl = !!finding.endpoint && /^[a-z][a-z0-9+.-]*:\/\//i.test(finding.endpoint);
    const res = promoteTrafficForFinding(ctx.trafficDir, {
      findingId: finding.id,
      intentId: finding.intentId ?? ctx.state.activeIntentId ?? null,
      host: (endpointIsUrl ? endpointHost : undefined) ?? targetHostOf(finding.asset) ?? null,
      asset: finding.asset,
      trafficIds: opts.trafficIds ?? [],
      ...(opts.converge ? { converge: true } : {}),
    });
    let linked = res.trafficIds.length
      ? ctx.history.linkFindingTraffic(ctx.taskId, finding.id, res.trafficIds)
      : null;
    if (res.trafficIds.length && !(linked?.pocCurl ?? finding.pocCurl)) {
      const synthesized = buildPocCurlFromTraffic(ctx.trafficDir, res.trafficIds);
      if (synthesized) {
        linked = ctx.history.updateFindingPocCurl(ctx.taskId, finding.id, synthesized) ?? linked;
      }
    }
    return {
      trafficIds: res.trafficIds,
      finding: linked,
      summary: { trafficIds: res.trafficIds, promoted: res.promoted, window: res.window },
    };
  } catch {
    return null;
  }
}

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
    if (ctx.leader === false && next !== "explore") {
      return "denied: follower only Explore; leader owns Bootstrap/Reason/Report";
    }
    const multiWorkerLeader = ctx.leader === true && (ctx.workerCount ?? 1) > 1;
    const open = ctx.history.openIntents(ctx.taskId);
    if (next === "explore" && multiWorkerLeader) {
      return "denied: multi-worker leader delegates Explore; propose Intents for followers in Bootstrap/Reason";
    }
    if (next === "explore" && open.length === 0 && !ctx.state.activeIntentId) {
      return "denied: Explore requires ≥1 open Intent; intent_propose first";
    }
    if (next === "reason" && open.length > 0 && !multiWorkerLeader) {
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
    // Lane D — asset_root 边界校验：只能落在已确认/已登记资产上，不许凭意图发明资产。
    let assetRoot: string | undefined;
    const rawAssetRoot = args.assetRoot?.trim();
    if (rawAssetRoot) {
      const grounding = ctx.history.groundedAssetRoot(ctx.taskId, rawAssetRoot, sourceFactIds);
      if (!grounding.ok) return `错误: asset_root 边界校验失败 — ${grounding.reason}`;
      assetRoot = grounding.address;
    }
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
        ...(assetRoot ? { assetRoot } : {}),
        ...(args.planStepId ? { planStepId: args.planStepId } : {}),
        rejectOosOnly: true,
        fanout: inReason ? fanout : undefined,
      });
      const wantClaim =
        (args.claim === "true" || args.claim === "1" || args.claim === "yes") &&
        !(ctx.leader === true && (ctx.workerCount ?? 1) > 1) &&
        !ctx.state.activeIntentId;
      if (wantClaim) {
        const claimed = ctx.history.claimIntent(ctx.taskId, intent.id, workerId);
        if (claimed) {
          if (inReason) ctx.history.releaseReasonLease(ctx.taskId, workerId);
          // Lane D — 自动传递 activeIntentId：claim 即绑定，Explore 内不传 intentId 的写入自动挂父节点。
          ctx.history.bindActiveIntent(ctx.taskId, claimed.id);
          ctx.state.activeIntentId = claimed.id;
          ctx.state.activeIntentClaimedAt = new Date().toISOString();
          ctx.state.toolsAtIntentClaim = ctx.state.toolCalls;
          ctx.state.lastSoftSurfaceMilestone = 0;
          ctx.state.phase = "explore";
          ctx.save();
          appendProgress(ctx.workspaceDir, `phase=explore propose+claim=${claimed.id}`);
          return JSON.stringify({ ...claimed, autoClaimed: true });
        }
      }
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
    if (ctx.leader === true && (ctx.workerCount ?? 1) > 1) {
      return "denied: leader delegates Explore; follower claims Intent";
    }
    if (ctx.state.activeIntentId) {
      return `denied: already exploring intent ${ctx.state.activeIntentId}; conclude it first`;
    }
    const claimed = ctx.history.claimIntent(
      ctx.taskId,
      args.intentId ?? "",
      workerId,
    );
    if (!claimed) return `claim failed (not proposed?): ${args.intentId ?? ""}`;
    // Lane D — claim 即绑定（history 层 claimIntent 也会绑；这里显式对齐 checkpoint 状态）。
    ctx.history.bindActiveIntent(ctx.taskId, claimed.id);
    ctx.state.activeIntentId = claimed.id;
    ctx.state.activeIntentClaimedAt = new Date().toISOString();
    ctx.state.toolsAtIntentClaim = ctx.state.toolCalls;
    ctx.state.lastSoftSurfaceMilestone = 0;
    ctx.state.phase = "explore";
    ctx.save();
    appendProgress(ctx.workspaceDir, `phase=explore claim=${claimed.id}`);
    return JSON.stringify(claimed);
  }

  if (name === "fact_draft") {
    const title = (args.title ?? "").trim();
    const summary = (args.summary ?? "").trim();
    if (!title) return "错误: fact_draft requires non-empty title";
    ctx.state.factDraft = {
      title,
      summary,
      ...(args.evidencePath?.trim() ? { evidencePath: args.evidencePath.trim() } : {}),
      updatedAt: new Date().toISOString(),
    };
    ctx.save();
    return JSON.stringify({ ok: true, draft: ctx.state.factDraft });
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
    const intentId = args.intentId ?? "";
    if (ctx.state.activeIntentId !== intentId) {
      return `denied: conclude only active Intent ${ctx.state.activeIntentId ?? "—"}; claim it first`;
    }
    const parsedFacts = parseFactsJson(args.factsJson);
    const facts: ConcludeFactInput[] =
      parsedFacts.length > 0
        ? parsedFacts
        : ctx.state.factDraft?.title
          ? [
              {
                layer: "title",
                title: ctx.state.factDraft.title,
                summary: ctx.state.factDraft.summary,
                ...(ctx.state.factDraft.evidencePath
                  ? { evidencePath: ctx.state.factDraft.evidencePath }
                  : {}),
                tags: ["partial", "draft-rescued"],
              },
            ]
          : [];
    const conclusionText =
      (args.conclusion ?? "").trim() ||
      (ctx.state.factDraft ? `${ctx.state.factDraft.title}: ${ctx.state.factDraft.summary}` : "");
    try {
      const done = ctx.history.concludeIntent(
        ctx.taskId,
        intentId,
        status,
        conclusionText,
        { facts, workerId },
      );
      if (!done) return `conclude failed: ${args.intentId ?? ""}`;
      // Lane D — Explore 结束即解绑：conclude 之后写的 Fact 不再继承（宁可不挂，不乱挂）。
      ctx.history.bindActiveIntent(ctx.taskId, null);
      if (ctx.state.activeIntentId === done.id) {
        ctx.state.activeIntentId = null;
        ctx.state.activeIntentClaimedAt = null;
        ctx.state.toolsAtIntentClaim = null;
        ctx.state.lastSoftSurfaceMilestone = 0;
        ctx.state.drainIntentId = null;
        ctx.state.drainStepsRemaining = null;
        ctx.state.factDraft = null;
      }
      const open = ctx.history.openIntents(ctx.taskId);
      // Followers never enter Reason or acquire the project-level Reason lease.
      const canReason = ctx.leader !== false;
      ctx.state.phase = open.length > 0 || !canReason ? "explore" : "reason";
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
        intentId: ctx.state.activeIntentId ?? undefined,
        summary: args.summary ?? undefined,
        affectedScope: (args.affectedScope ?? args.affected_scope) ?? undefined,
        rootCause: (args.rootCause ?? args.root_cause) ?? undefined,
        repro: args.repro ?? "",
        impact: args.impact ?? "",
        fix: args.fix ?? "",
        pocCurl: (args.pocCurl ?? args.poc_curl)?.trim() || null,
        report: args.report ?? undefined,
        qualification: parseQualification(args.qualification),
      });
      const traffic = captureFindingTraffic(ctx, r.finding, {
        trafficIds: parseFactIds(args.trafficIds ?? ""),
      });
      appendProgress(
        ctx.workspaceDir,
        `finding_record ${r.finding.id} (${r.finding.severity}/${r.finding.status}) ${r.finding.title}${r.created ? "" : " [dedup]"}${traffic?.trafficIds.length ? ` traffic=${traffic.trafficIds.length}` : ""}`,
      );
      if (!traffic) return JSON.stringify(r);
      return JSON.stringify({ ...r, finding: traffic.finding ?? r.finding, traffic: traffic.summary });
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
          summary: args.summary ?? undefined,
          affectedScope: (args.affectedScope ?? args.affected_scope) ?? undefined,
          rootCause: (args.rootCause ?? args.root_cause) ?? undefined,
          impact: args.impact,
          fix: args.fix,
          cvss: args.cvss?.trim() || undefined,
          verifiedBy: workerId,
          intentId: ctx.state.activeIntentId ?? undefined,
          pocCurl: (args.pocCurl ?? args.poc_curl)?.trim() || undefined,
          report: args.report ?? undefined,
          qualification: parseQualification(args.qualification),
        },
      );
      // Verified: keep the reproduction traffic, then converge the post-window
      // to a few confirmation captures.
      const traffic = captureFindingTraffic(ctx, finding, {
        trafficIds: parseFactIds(args.trafficIds ?? ""),
        converge: true,
      });
      appendProgress(
        ctx.workspaceDir,
        `finding_verify ${finding.id} → ${finding.status} evidence=${finding.evidence.length}${traffic?.trafficIds.length ? ` traffic=${traffic.trafficIds.length}` : ""}`,
      );
      if (!traffic) return JSON.stringify(finding);
      return JSON.stringify({ ...(traffic.finding ?? finding), traffic: traffic.summary });
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
      if (ctx.trafficDir) closeFindingWindow(ctx.trafficDir, finding.id);
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

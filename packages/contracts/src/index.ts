import { z } from "zod";
import { ChatProfileSchema } from "./chat-models.js";
import { ModelRefSchema, ModelTiersSchema } from "./model-routing.js";
import { OastConfigSchema, PivotPolicySchema } from "./scope.js";
export * from "./chat-models.js";
export * from "./chat-input.js";
export { selectableChatModels, chatThinkingEfforts, isDeepSeekThinkingModel } from "./chat-model-options.js";
export * from "./knowledge.js";
export * from "./engagement-audit.js";
export * from "./host-enum.js";
export * from "./attack-graph.js";
export * from "./model-routing.js";
export * from "./capability-eval.js";
import { KnowledgeEmbeddingSettingsSchema } from "./knowledge.js";
import { CoverageStatusSchema } from "./coverage-audit.js";
import {
  BUSINESS_RECONCILE_KIND,
  BusinessReconcileConfigSchema,
  ReconcileGateSchema,
  reconcileGateFromConfig,
  reconcileResultPattern,
  type BusinessReconcileConfig,
} from "./reconcile.js";
export {
  CoverageReferenceSchema,
  CoverageSnapshotSchema,
  type CoverageSnapshot,
  type CoverageStatus,
} from "./coverage-audit.js";
export {
  BUSINESS_RECONCILE_KIND,
  BusinessReconcileConfigSchema,
  GoalReconcileRequestSchema,
  ReconcileInputRefSchema,
  ReconcileInputStampSchema,
  ReconcileMaterialSchema,
  ReconcileRequestSchema,
  ReconcileGateSchema,
  ReconcileRevisionIdPattern,
  ReconcileRevisionSchema,
  businessConfigFromRequest,
  nextReconcileRevisionId,
  reconcileConfigCanonical,
  reconcileConfigDigest,
  reconcileGateFromConfig,
  reconcileInputDigest,
  reconcileResultPattern,
  type BusinessReconcileConfig,
  type GoalReconcileRequest,
  type ReconcileGate,
  type ReconcileInputRef,
  type ReconcileInputStamp,
  type ReconcileCounts,
  type ReconcileFieldChange,
  type ReconcileItem,
  type ReconcileItemStatus,
  type ReconcileMaterial,
  type ReconcileRequest,
  type ReconcileResult,
  type ReconcileRevision,
  type ParsedMaterial,
  type MaterialRow,
  parseMaterial,
  reconcileMaterials,
  summarizeReconcile,
} from "./reconcile.js";
export {
  PeerReviewDecisionSchema,
  PeerReviewSchema,
  RetestRequestSchema,
  type PeerReview,
  type PeerReviewDecision,
  type PeerReviewInput,
  type RetestRequest,
  type RetestRequestInput,
  type RetestRequestStatus,
} from "./collaboration.js";
export {
  ExecutionStepSchema,
  type ExecutionStep,
  type ExecutionTracePage,
  type ShellTraceCall,
} from "./execution-trace.js";
export * from "./integration-usage.js";
import {
  DEFAULT_EXPLORE_TIMEOUT_MS,
  DEFAULT_MAX_INTENTS_PER_ASSET_ROOT,
  DEFAULT_MAX_INTENTS_PER_REASON,
  DEFAULT_REASON_LEASE_MS,
} from "./fanout.js";

/** Reserved for multi-user; MVP always "default". */
export const TenantIdSchema = z.string().min(1).default("default");
export type TenantId = z.infer<typeof TenantIdSchema>;

/**
 * Active = the watchdog may keep the task alive / restart its workers.
 * `pause_requested` and `stopping` are transitional active states: workers are
 * being drained, but the pool is not yet confirmed gone.
 */
const ACTIVE_TASK_STATUSES = [
  "queued",
  "initializing",
  "running",
  "recovering",
  "pause_requested",
  "stopping",
] as const;
/** Non-terminal and intentionally not active: no worker may be (re)started. */
const PAUSED_TASK_STATUSES = ["paused"] as const;
const TERMINAL_TASK_STATUSES = [
  "completed",
  "failed",
  "budget_exhausted",
  /** Loop ended without all goals and without hitting a hard budget gate. */
  "incomplete",
  "stopped",
] as const;

export const TaskStatusSchema = z.enum([
  ...ACTIVE_TASK_STATUSES,
  ...PAUSED_TASK_STATUSES,
  ...TERMINAL_TASK_STATUSES,
]);
export type TaskStatus = z.infer<typeof TaskStatusSchema>;
export type TerminalTaskStatus = (typeof TERMINAL_TASK_STATUSES)[number];

const activeTaskStatuses = new Set<string>(ACTIVE_TASK_STATUSES);
const pausedTaskStatuses = new Set<string>(PAUSED_TASK_STATUSES);
const terminalTaskStatuses = new Set<string>(TERMINAL_TASK_STATUSES);

export function isActiveTaskStatus(status: TaskStatus): boolean {
  return activeTaskStatuses.has(status);
}

/** Paused is a durable operator intent: neither "active" nor "terminal". */
export function isPausedTaskStatus(status: TaskStatus): boolean {
  return pausedTaskStatuses.has(status);
}

/** States where the operator has asked the pool to drain. */
export function isDrainingTaskStatus(status: TaskStatus): boolean {
  return status === "pause_requested" || status === "stopping";
}

export function isTerminalTaskStatus(status: unknown): status is TerminalTaskStatus {
  return typeof status === "string" && terminalTaskStatuses.has(status);
}

/**
 * Archivable set: paused or terminal. Archiving is a soft-hide flag only —
 * status, checkpoints and history are untouched, so a paused task keeps its
 * "resume" semantics after unarchive.
 */
export function isArchivableTaskStatus(status: unknown): boolean {
  return typeof status === "string" && (pausedTaskStatuses.has(status) || terminalTaskStatuses.has(status));
}

export type TaskArchiveState = Pick<TaskRecord, "id" | "name" | "status" | "archivedAt"> & {
  createdAt?: string;
  updatedAt?: string;
  submissionKey?: string;
};

export const TaskArchiveBatchSchema = z.object({
  taskIds: z.array(z.string().uuid()).nonempty(),
  archived: z.boolean(),
});

/**
 * Budget hard gates. **0 = unlimited** (default): no wall/tool/token/install ceiling;
 * the worker runs until goals pass, fatal error, or operator stop.
 * Pass a positive value via CLI/API only when you want an explicit cap.
 */
export const BUDGET_UNLIMITED = 0;

export function isBudgetUnlimited(max: number | null | undefined): boolean {
  return max == null || max <= 0;
}

/** True when `used` has hit a finite gate. Unlimited max never trips. */
export function isBudgetHit(used: number, max: number | null | undefined): boolean {
  if (isBudgetUnlimited(max)) return false;
  return used >= (max as number);
}

/** True when wall clock since `startedAtMs` exceeds a finite maxWallMs. */
export function isWallHit(
  startedAtMs: number,
  maxWallMs: number | null | undefined,
  nowMs = Date.now(),
): boolean {
  if (isBudgetUnlimited(maxWallMs)) return false;
  return nowMs - startedAtMs >= (maxWallMs as number);
}

/** Optional finite presets (only if you opt in via --max-*). */
export const LONG_RUN_MAX_WALL_MS = 3 * 24 * 60 * 60 * 1000; // 259_200_000
export const LONG_RUN_MAX_TOOL_CALLS = 100_000;
export const LONG_RUN_MAX_TOKENS = 50_000_000;
export const LONG_RUN_MAX_INSTALLS = 200;

export const BudgetSchema = z.object({
  /** 0 = unlimited */
  maxTokens: z.number().int().nonnegative().default(BUDGET_UNLIMITED),
  /** 0 = unlimited */
  maxWallMs: z.number().int().nonnegative().default(BUDGET_UNLIMITED),
  /** 0 = unlimited */
  maxToolCalls: z.number().int().nonnegative().default(BUDGET_UNLIMITED),
  /** 0 = unlimited */
  maxInstalls: z.number().int().nonnegative().default(BUDGET_UNLIMITED),
  /**
   * Session Relay auto-trigger: cumulative tokens since last π.
   * Override with env GY_RELAY_TOKEN_THRESHOLD. Default 30_000 (CHAP-aligned, conservative).
   */
  relayTokenThreshold: z.number().int().positive().default(30_000),
  /** Min tool calls between two Relays (guard against empty handoffs). */
  relayMinToolCalls: z.number().int().nonnegative().default(2),
});
export type Budget = z.infer<typeof BudgetSchema>;

/** Capability ladder (P3): tools filtered by level; VPN/proxy mutations always denied. */
export const AuthCapabilitySchema = z.enum([
  "observe",
  "scan",
  "active-lab",
  "full",
]);
export type AuthCapability = z.infer<typeof AuthCapabilitySchema>;

export const AuthScopeSchema = z.object({
  /** P16 — optional operational note. Authorization is a usage precondition, not a task field. */
  authorizationNote: z.string().trim().max(2000).default(""),
  /**
   * Task target coordinates: host, URL host, IPv4 CIDR (`10.0.0.0/8`),
   * wildcard (`*.example.com`), bare domain (covers subdomains), or `*`.
   * Targets entering the task are authorized by definition (red-team-positioning.md).
   * Matching is formalized in `scope.ts` (`targetAllows` / `admitAddress`).
   */
  targets: z.array(z.string().min(1)).min(1),
  /** Operator exclusions; always deny even if they also match targets. */
  outOfScope: z.array(z.string()).default([]),
  /** Operational gear (tool surface visibility), not a target-legality review. */
  capability: AuthCapabilitySchema.default("active-lab"),
  /** P16 — operator intent free text (RoE); injected into the worker prompt, never parsed as rules. */
  roe: z.string().trim().max(4000).optional(),
  /**
   * P14-B0 — free-form pacing guidance from RoE ("production <10 req/s, avoid WAF").
   * Injected into the worker prompt; the model self-judges. Never a hard bucket.
   */
  rateGuidance: z.string().trim().max(2000).optional(),
  /** P14-B2 — out-of-band callback channel; absent = OAST unavailable. */
  oast: OastConfigSchema.optional(),
  /** P14-B4 — internal pivot admission; absent = off, operator-written only. */
  pivotPolicy: PivotPolicySchema.optional(),
});
export type AuthScope = z.infer<typeof AuthScopeSchema>;

/**
 * P16 语义收敛别名（`docs/red-team-positioning.md`）：
 * `task.auth` 线协议字段名保留向后兼容，但其业务语义是单兵红队任务的「操作坐标与档位」，
 * 而非运行时合法性审查或审批门。新代码优先使用 `TaskCoordinates` / `TaskScope` / `TaskCapability`。
 */
export const TaskCapabilitySchema = AuthCapabilitySchema;
export type TaskCapability = AuthCapability;
export const TaskCoordinatesSchema = AuthScopeSchema;
export type TaskCoordinates = AuthScope;
export const TaskScopeSchema = AuthScopeSchema;
export type TaskScope = AuthScope;

export * from "./scope.js";
export * from "./dsml.js";
export * from "./credentials.js";
export * from "./fanout.js";
export * from "./family-key.js";
export * from "./finding.js";
export * from "./http.js";
export * from "./traffic.js";
export * from "./oast.js";
export * from "./plan.js";
export * from "./host-profile.js";
export * from "./tool-output.js";
/** 第九轮：委托边界 / 持久作业 / 人工求助 / 证据语义 / 四图 / 记忆 / 角色与韧性。 */
export * from "./ops.js";
export * from "./authorization.js";
import { AuthorizationRecordSchema } from "./authorization.js";
import { FindingsGateSchema } from "./finding.js";

/** Graph-driven worker phases (P2). Crash recovery still uses Durable; Relay ≠ crash. */
export const WorkerPhaseSchema = z.enum([
  "init",
  "bootstrap",
  "explore",
  "reason",
  "relay",
  "report",
  "done",
  /** Legacy single-loop; treated as explore|reason continuum. */
  "loop",
]);
export type WorkerPhase = z.infer<typeof WorkerPhaseSchema>;

/**
 * Session Relay protocol πₙ (CHAP-aligned). Written to workspace/relay/π{n}.json.
 * Incremental vs prior π; History remains authoritative on conflict.
 */
export const RelayProtocolSchema = z.object({
  generation: z.number().int().nonnegative(),
  createdAt: z.string().datetime(),
  trigger: z.enum(["auto", "agent"]),
  reason: z.string().default(""),
  current_position: z.string().default(""),
  network_map: z.string().default(""),
  tried: z.string().default(""),
  active_sessions: z.string().default(""),
  foothold: z.string().default(""),
  unexplored_surface: z.string().default(""),
  open_intents: z.array(z.string()).default([]),
  budget_spent: z.object({
    tokens: z.number().int().nonnegative().default(0),
    toolCalls: z.number().int().nonnegative().default(0),
    wallMs: z.number().int().nonnegative().default(0),
  }),
});
export type RelayProtocol = z.infer<typeof RelayProtocolSchema>;

const EvidenceChecksSchema = z.array(z.object({
  pattern: z.string().min(1),
  field: z.string().min(1),
  equals: z.union([z.string(), z.number(), z.boolean()]),
})).optional();

export const CreateFactReviewSchema = z.object({
  factId: z.string().uuid(),
  goalId: z.string().min(1),
  decision: z.enum(["confirmed", "retracted"]),
  replacementFactId: z.string().uuid().optional(),
  reviewer: z.string().trim().min(1),
  reason: z.string().trim().min(1),
  evidencePath: z.string().trim().min(1),
}).refine((r) => !r.replacementFactId || (r.decision === "retracted" && r.factId !== r.replacementFactId), {
  message: "Only a retracted fact can point to a distinct replacement",
});
export type CreateFactReview = z.infer<typeof CreateFactReviewSchema>;

export const CoverageReviewSchema = z.object({
  goalId: z.string().min(1),
  status: CoverageStatusSchema,
  reviewer: z.string().trim().min(1),
  reason: z.string().trim().min(1),
  evidencePath: z.string().trim().min(1).optional(),
}).refine((r) => !["partial", "tested"].includes(r.status) || !!r.evidencePath, {
  message: "已测或部分覆盖需要证据文件",
});
export type CoverageReviewInput = z.infer<typeof CoverageReviewSchema>;
export { coverageLabels } from "./coverage.js";
export type CoverageReview = CoverageReviewInput & { id: string; createdAt: string; sha256?: string };

export const GoalSpecSchema = z
  .object({
    id: z.string().min(1),
    title: z.string().min(1),
    description: z.string().min(1),
    /**
     * 目标类型。`file`（默认）= 普通材料留存目标，按 evidencePatterns 验收；
     * `business-reconcile` = 业务核算目标，必须由一份满足 reconcileGate 的核算
     * 结果满足。类型由建档界面显式选择，不从目标措辞里猜；省略按 `file` 处理
     * （旧调用方的请求不需要改）。
     */
    kind: z.enum(["file", BUSINESS_RECONCILE_KIND]).optional(),
    /**
     * 业务核算配置（基线 / 当前材料 / 主键 / 检查项 / 判定阈值）。业务目标由
     * 系统据此派生 evidencePatterns 与 reconcileGate，操作员不用手写 JSON。
     */
    business: BusinessReconcileConfigSchema.optional(),
    /**
     * Assets this goal is accountable for (normalized host / CIDR / wildcard /
     * URL host). Goal-scoped findings gates only count findings on these assets.
     * Also used by delivery to state "this goal's scope".
     */
    assets: z.array(z.string().min(1)).optional(),
    /**
     * Glob patterns under evidence/ that must exist before pass.
     * 业务核算目标可省略：由核算配置派生为 reconcile/<name>-*.json。
     */
    evidencePatterns: z.array(z.string().min(1)).default([]),
    evidenceChecks: EvidenceChecksSchema,
    /**
     * P6-E1: require ≥N verified findings (severity/class filtered) to pass.
     * Default scope is `goal`: only findings on the goal's declared assets count.
     * Use `scope: "task"` only for a goal that explicitly aggregates the whole
     * engagement.
     */
    findingsGate: FindingsGateSchema.optional(),
    /**
     * 业务完成条件（第七轮）：目标是“完成差异比对”时，必须由一份真实核算结果
     * 满足这里声明的条件——只挂一份差异 JSON 不算完成。
     * 业务核算目标由 `business` 派生，不接受操作员手写。
     */
    reconcileGate: ReconcileGateSchema.optional(),
    /**
     * Optional benchmark semantics. Only `tsecbench` treats a file named
     * `ALL_COMPLETE.json` as a challenge board (every `is_completed === true`).
     * Ordinary engagements interpret the same filename by their declared
     * evidencePatterns / evidenceChecks.
     */
    boardGate: z.enum(["tsecbench"]).optional(),
  })
  .refine(
    (goal) => goal.kind !== BUSINESS_RECONCILE_KIND || Boolean(goal.business),
    { message: "业务核算目标必须带 business 配置（基线材料、当前材料、主键字段）" },
  )
  .refine(
    // kind 省略按 file 处理：普通文件目标必须给 patterns。
    (goal) => (goal.kind ?? "file") !== "file" || goal.evidencePatterns.length > 0,
    { message: "普通文件目标必须声明至少一个 evidencePatterns" },
  );
export type GoalSpec = z.infer<typeof GoalSpecSchema>;

/**
 * 建档请求的统一归一化：业务核算目标由系统派生 evidencePatterns 与
 * reconcileGate，其他类型原样保留。
 *
 * 建档请求、服务端落库（seedGoals）、目标详情与恢复后的任务都以这里为唯一
 * 权威——同一份 business 配置在任何地方派生结果都一致。
 */
export function normalizeGoalSpecs(specs: GoalSpec[]): GoalSpec[] {
  return specs.map((spec) => {
    if (!spec.business) return spec;
    return {
      ...spec,
      kind: BUSINESS_RECONCILE_KIND,
      // 业务目标的验收依据就是核算结果：严格由配置派生，不混入别的文件。
      evidencePatterns: [reconcileResultPattern(spec.business.name)],
      reconcileGate: reconcileGateFromConfig(spec.business),
    };
  });
}

/**
 * P4 — bounded Explore concurrency (user-set at task create).
 * Default 3 = 3 concurrent Explore workers (plus 1 coordinator slot when multi-worker).
 * Hard ceiling 16; effective spawn count is resolved at start and dynamically scaled.
 */
export const DEFAULT_MAX_CONCURRENT_EXPLORES = 3 as const;
export const MAX_CONCURRENT_EXPLORES = 16 as const;

export const ExecutionConfigSchema = z.object({
  /**
   * Max concurrent Explore workers for this task.
   * Shared History + Intent CAS; each worker keeps its own Durable checkpoint.
   */
  maxConcurrentExplores: z
    .number()
    .int()
    .min(1)
    .max(MAX_CONCURRENT_EXPLORES)
    .default(DEFAULT_MAX_CONCURRENT_EXPLORES),
  /**
   * Hard cap on Intents proposed during a single Reason wave
   * (open proposed+claimed+running count while phase=reason).
   */
  maxIntentsPerReason: z
    .number()
    .int()
    .min(1)
    .max(64)
    .default(DEFAULT_MAX_INTENTS_PER_REASON),
  /**
   * Max open Intents whose primary asset shares the same root
   * (registrable domain or IPv4 /24).
   */
  maxIntentsPerAssetRoot: z
    .number()
    .int()
    .min(1)
    .max(32)
    .default(DEFAULT_MAX_INTENTS_PER_ASSET_ROOT),
  /**
   * Claimed Explore Intent wall timeout. On expiry Worker force-concludes
   * with a partial Fact (Cairn dual-stage). 0 = disabled.
   */
  exploreTimeoutMs: z
    .number()
    .int()
    .nonnegative()
    .default(DEFAULT_EXPLORE_TIMEOUT_MS),
  /** Reason project-level lease TTL for multi-Explore CAS. 0 = disabled. */
  reasonLeaseMs: z
    .number()
    .int()
    .nonnegative()
    .default(DEFAULT_REASON_LEASE_MS),
  /** P17 — per-tier model overrides (reason/explore/execute). */
  models: ModelTiersSchema.optional(),
  /** P17 — ordered provider fallback pool. */
  providers: z.array(ModelRefSchema).max(8).optional(),
});
export type ExecutionConfig = z.infer<typeof ExecutionConfigSchema>;

/** Resolve how many Explore workers can execute concurrently (never above configured or target/asset count). */
export function resolveExploreWorkerCount(opts: {
  maxConcurrentExplores: number;
  targetCount: number;
  /** Distinct admitted/live asset addresses; grows effective concurrency beyond seed targets. */
  assetCount?: number;
}): number {
  const configured = Math.min(
    MAX_CONCURRENT_EXPLORES,
    Math.max(1, Math.floor(opts.maxConcurrentExplores) || 1),
  );
  const targets = Math.max(1, Math.floor(opts.targetCount) || 1);
  const assets = Math.max(0, Math.floor(opts.assetCount ?? 0) || 0);
  return Math.min(configured, Math.max(targets, assets));
}

/**
 * Resolve total worker process slots for `exploreCount` concurrent explores:
 * - 1 explore → 1 solo slot (slot 0 runs Bootstrap + Explore + Reason + Report).
 * - N ≥ 2 explores → N + 1 slots (slot 0 coordinator + slots 1..N concurrent Explore followers).
 */
export function resolveWorkerSlotCount(exploreCount: number): number {
  const explores = Math.min(
    MAX_CONCURRENT_EXPLORES,
    Math.max(1, Math.floor(exploreCount) || 1),
  );
  return explores <= 1 ? 1 : explores + 1;
}

export const CreateTaskRequestSchema = z.object({
  tenantId: z.string().min(1).default("default"),
  name: z.string().min(1).default("untitled"),
  /**
   * 委托标识。同一业务委托下的多个任务共享该值，跨任务署名复核只在同
   * engagementId 内成立；省略时该任务自成一委托。
   */
  engagementId: z.string().trim().min(1).max(128).optional(),
  auth: AuthScopeSchema,
  goals: z.array(GoalSpecSchema).min(1).refine(
    (goals) => new Set(goals.map((goal) => goal.id)).size === goals.length,
    { message: "目标 ID 必须唯一" },
  ),
  budget: BudgetSchema.optional().default({
    maxTokens: BUDGET_UNLIMITED,
    maxWallMs: BUDGET_UNLIMITED,
    maxToolCalls: BUDGET_UNLIMITED,
    maxInstalls: BUDGET_UNLIMITED,
    relayTokenThreshold: 30_000,
    relayMinToolCalls: 2,
  }),
  /** Parallel Explore pool size + Reason fanout / Explore timeout (defaults filled). */
  execution: ExecutionConfigSchema.default({
    maxConcurrentExplores: DEFAULT_MAX_CONCURRENT_EXPLORES,
    maxIntentsPerReason: DEFAULT_MAX_INTENTS_PER_REASON,
    maxIntentsPerAssetRoot: DEFAULT_MAX_INTENTS_PER_ASSET_ROOT,
    exploreTimeoutMs: DEFAULT_EXPLORE_TIMEOUT_MS,
    reasonLeaseMs: DEFAULT_REASON_LEASE_MS,
  }),
  /** When true, worker uses scripted mock agent (no LLM). */
  mock: z.boolean().default(false),
}).transform((req) => ({
  // 建档请求出口处归一化一次：业务核算目标在这里拿到系统派生的
  // evidencePatterns 与 reconcileGate，后续落库/详情/恢复都读这份结果。
  ...req,
  goals: normalizeGoalSpecs(req.goals),
}));
export type CreateTaskRequest = z.infer<typeof CreateTaskRequestSchema>;

export const GoalStateSchema = z.object({
  id: z.string(),
  title: z.string(),
  description: z.string(),
  /** 目标类型；旧档缺失时按普通文件目标解释。 */
  kind: z.enum(["file", BUSINESS_RECONCILE_KIND]).optional(),
  /** 业务核算配置（含基线/当前材料与判定阈值），业务目标与普通目标都可能有。 */
  business: BusinessReconcileConfigSchema.optional(),
  assets: z.array(z.string()).optional(),
  evidencePatterns: z.array(z.string()),
  evidenceChecks: EvidenceChecksSchema,
  findingsGate: FindingsGateSchema.optional(),
  reconcileGate: ReconcileGateSchema.optional(),
  boardGate: z.enum(["tsecbench"]).optional(),
  passes: z.boolean(),
  evidencePaths: z.array(z.string()).default([]),
  assertedAt: z.string().datetime().nullable().default(null),
});
export type GoalState = z.infer<typeof GoalStateSchema>;

const UsageCountersSchema = z.object({
  tokens: z.number().int().nonnegative(),
  toolCalls: z.number().int().nonnegative(),
  installs: z.number().int().nonnegative(),
});

export const TaskRecordSchema = z.object({
  id: z.string().uuid(),
  tenantId: z.string(),
  name: z.string(),
  /** 委托标识；旧任务缺失时由控制面归一化为任务自身的 id。 */
  engagementId: z.string().default(""),
  status: TaskStatusSchema,
  auth: AuthScopeSchema,
  /** Chat thread this task belongs to; resume binds a follow-up message to it. */
  threadId: z.string().default(""),
  /** Task this run continues (resume / authorization follow-up), if any. */
  parentTaskId: z.string().nullable().default(null),
  /** Authorization ledger record in force for this task (projection; `auth` stays authoritative). */
  authorization: AuthorizationRecordSchema.nullable().default(null),
  goals: z.array(GoalStateSchema),
  budget: BudgetSchema,
  execution: ExecutionConfigSchema.default({
    maxConcurrentExplores: DEFAULT_MAX_CONCURRENT_EXPLORES,
    maxIntentsPerReason: DEFAULT_MAX_INTENTS_PER_REASON,
    maxIntentsPerAssetRoot: DEFAULT_MAX_INTENTS_PER_ASSET_ROOT,
    exploreTimeoutMs: DEFAULT_EXPLORE_TIMEOUT_MS,
    reasonLeaseMs: DEFAULT_REASON_LEASE_MS,
  }),
  mock: z.boolean(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  startedAt: z.string().datetime().nullable(),
  finishedAt: z.string().datetime().nullable(),
  /** Soft-hide from the default task list; evidence/report/logs retained. */
  archivedAt: z.string().datetime().nullable().default(null),
  leaseOwner: z.string().nullable(),
  leaseUntil: z.string().datetime().nullable(),
  fence: z.number().int().nonnegative(),
  containerId: z.string().nullable(),
  /** Leader / primary worker pid (slot 0); see workerPids for the full pool. */
  workerPid: z.number().int().nullable(),
  /** All local Explore worker pids (slot order). Empty when docker runtime. */
  workerPids: z.array(z.number().int()).default([]),
  /** Docker container ids when runtime=docker (one per Explore slot). */
  containerIds: z.array(z.string()).default([]),
  dataDir: z.string(),
  error: z.string().nullable(),
  assignment: z.object({
    requestId: z.string(),
    inputHash: z.string(),
    model: z.string(),
    ownerPid: z.number().optional(),
    ownerHost: z.string().optional(),
  }).optional(),
  commandReview: z.object({
    id: z.string(),
    fence: z.number().optional(),
    tool: z.string(),
    summary: z.string().default(""),
    at: z.string(),
    reason: z.string(),
    decision: z.enum([
      "block", "unavailable", "waiting",
      "executed", "failed", "rejected", "cancelled", "expired",
    ]),
    model: z.string(),
    outcome: z.string().optional(),
    mode: z.enum(["auto", "manual"]).optional(),
  }).optional(),
  /** Cumulative counters at the start of this operator-initiated run. */
  runStartUsage: UsageCountersSchema.optional(),
  /** Counters previously visible only in a sidecar or the control record. */
  usageOffset: UsageCountersSchema.optional(),
  usage: UsageCountersSchema,
  /**
   * Monotonic scope revision. Every operator scope update bumps it; a resumed
   * worker is started from the latest revision, never from a stale copy.
   */
  scopeVersion: z.number().int().positive().default(1),
  /** Operator asked to pause at this time; cleared on resume. */
  pauseRequestedAt: z.string().datetime().nullable().default(null),
  /** Confirmed pause: workers are gone and the checkpoint is retained. */
  pausedAt: z.string().datetime().nullable().default(null),
  /** Last time the control plane observed a live worker / fresh status file. */
  lastHeartbeatAt: z.string().datetime().nullable().default(null),
});
export type TaskRecord = z.infer<typeof TaskRecordSchema>;

/**
 * Stage 2 — operator scope revision. The newest written scope is the only
 * authorization a resumed or handed-off worker may act on; historical facts,
 * model suggestions and memory never widen it.
 */
export const UpdateScopeRequestSchema = z.object({
  auth: AuthScopeSchema,
  reason: z.string().trim().min(1),
});
export type UpdateScopeRequest = z.infer<typeof UpdateScopeRequestSchema>;

export const FactLayerSchema = z.enum(["title", "summary", "evidence"]);
export type FactLayer = z.infer<typeof FactLayerSchema>;

export const FactSchema = z.object({
  id: z.string().uuid(),
  taskId: z.string().uuid(),
  layer: FactLayerSchema,
  title: z.string().min(1),
  summary: z.string().default(""),
  evidencePath: z.string().nullable().default(null),
  tags: z.array(z.string()).default([]),
  createdAt: z.string().datetime(),
  intentId: z.string().uuid().nullable().default(null),
});
export type Fact = z.infer<typeof FactSchema>;

export const IntentStatusSchema = z.enum([
  "proposed",
  "claimed",
  "running",
  "succeeded",
  "failed",
  "expired",
]);
export type IntentStatus = z.infer<typeof IntentStatusSchema>;

/** Pseudo Fact id: Intent may hang on origin before any real Fact exists. */
export const ORIGIN_FACT_ID = "origin";

export const IntentSchema = z.object({
  id: z.string().uuid(),
  taskId: z.string().uuid(),
  title: z.string().min(1),
  summary: z.string().default(""),
  status: IntentStatusSchema,
  /** Predecessor Fact ids (or `origin`); empty forbidden — no causeless explore. */
  sourceFactIds: z.array(z.string().min(1)).min(1),
  /** 测试类（CWE-* / OWASP-* / ATT&CK Txxxx）；覆盖矩阵的列。 */
  technique: z.string().trim().min(1).max(80).nullable().default(null),
  /** 资产根（规范化地址）；缺省时由 sourceFactIds 的资产标签派生。 */
  assetRoot: z.string().trim().min(1).max(255).nullable().default(null),
  claimedBy: z.string().nullable().default(null),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  concludedAt: z.string().datetime().nullable().default(null),
  conclusion: z.string().nullable().default(null),
});
export type Intent = z.infer<typeof IntentSchema>;

export const HistoryEventKindSchema = z.enum([
  "fact_appended",
  "intent_proposed",
  "intent_claimed",
  "intent_concluded",
  "intent_expired",
  "goal_asserted",
  "goal_assert_rejected",
  "tool_installed",
  "tool_gate",
  "lease_acquired",
  "lease_lost",
  "worker_started",
  "worker_stopped",
  "budget_tick",
  "report_written",
  "relay_written",
  "hint_appended",
  "technique_broadcast",
  "reason_lease",
  "explore_timeout_conclude",
  "explore_scaled",
  "finding_recorded",
  "finding_verified",
  "finding_status_changed",
  "finding_retracted",
  "finding_retested",
  "finding_validated",
  "finding_accepted",
  "scope_updated",
  "task_pause_requested",
  "task_paused",
  "task_resumed",
  "delivery_corrected",
  "delivery_correction_notice",
  "retest_requested",
  "peer_review_recorded",
  /** 第八轮：核算材料的导入/替换与撤回都留痕，复核时能还原操作顺序。 */
  "evidence_written",
  "evidence_removed",
  /** 操作员从控制台触发的目标判定（与 worker 自动判定同一条实现）。 */
  "goal_assert_requested",
  /** 第九轮：持久作业 / 人工求助 / 材料 / 台账 / 记忆 / 飞轮 / 角色 / 韧性。 */
  "job_submitted",
  "job_started",
  "job_finished",
  "job_delivered",
  "job_paused",
  "job_reconcile_after_boot",
  "job_late_result",
  "consult_opened",
  "consult_answered",
  "consult_released",
  "material_imported",
  "change_registered",
  "change_confirmed",
  "memory_injected",
  "memory_reviewed",
  "proposal_decided",
  "proposal_promoted",
  "proposal_rolled_back",
  "role_work_finished",
  "provider_fault_handled",
  "evaluation_recorded",
  "graph_projected",
  "material_citation_recorded",
  /** P14：凭据、事务、带外、计划、复测。 */
  "credential_recorded",
  "credential_reused",
  "http_transaction_recorded",
  "oast_token_issued",
  "oast_hit",
  "plan_updated",
  "finding_retest_concluded",
  "host_profile_recorded",
]);
export type HistoryEventKind = z.infer<typeof HistoryEventKindSchema>;

/** Human / system tactical injection (Cairn Hint). Absorbed via Observe. */
export const HintSourceSchema = z.enum(["human", "system", "family"]);
export type HintSource = z.infer<typeof HintSourceSchema>;

export const HintSchema = z.object({
  id: z.string().uuid(),
  taskId: z.string().uuid(),
  text: z.string().min(1).max(4000),
  source: HintSourceSchema.default("human"),
  tags: z.array(z.string()).default([]),
  createdAt: z.string().datetime(),
});
export type Hint = z.infer<typeof HintSchema>;

export const CreateHintRequestSchema = z.object({
  text: z.string().min(1).max(4000),
  source: HintSourceSchema.optional().default("human"),
  tags: z.array(z.string()).default([]),
});
export type CreateHintRequest = z.infer<typeof CreateHintRequestSchema>;

/** Mark a confirmed technique Fact as reusable across peer assets (同族迁移). */
export const TRANSFERABLE_TAG = "transferable";
export const familyTag = (key: string) => `family:${key.trim().toLowerCase()}`;

export const HistoryEventSchema = z.object({
  id: z.string().uuid(),
  taskId: z.string().uuid(),
  kind: HistoryEventKindSchema,
  payload: z.record(z.string(), z.unknown()).default({}),
  createdAt: z.string().datetime(),
  /** P17 — previous event hash in this task's append-only chain. */
  prevHash: z.string().nullable().optional(),
  /** P17 — sha256 over prev + event fields. */
  hash: z.string().nullable().optional(),
});
export type HistoryEvent = z.infer<typeof HistoryEventSchema>;

/** One MCP = one tool directory under mcp/builtin|user. Never a monolithic kali-mcp. */
export const McpTransportSchema = z.enum(["builtin", "stdio", "http"]);
export type McpTransport = z.infer<typeof McpTransportSchema>;

export const McpServerConfigSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  description: z.string().default(""),
  category: z.string().default("general"),
  enabled: z.boolean().default(true),
  builtin: z.boolean().default(false),
  source: z.enum(["builtin", "user"]).default("user"),
  transport: McpTransportSchema.default("stdio"),
  rootDir: z.string().optional(),
  command: z.string().optional(),
  args: z.array(z.string()).default([]),
  url: z.string().optional(),
  env: z.record(z.string(), z.string()).default({}),
  /** P15 — executable name for health probe (builtin only). */
  binary: z.string().optional(),
  defaultFlags: z.string().optional(),
  /** Flag that introduces the target (e.g. -u, -d, -H); empty = bare positional. */
  targetFlag: z.string().optional(),
  /** Minimum capability required to enable/invoke this server. */
  capability: z.enum(["observe", "scan", "active-lab", "full"]).optional(),
  /** Machine-readable parser lane key; omitted for free-text tools. */
  parser: z.enum(["nmap", "httpx", "nuclei", "ffuf"]).optional(),
  timeoutMs: z.number().int().positive().optional(),
  whenToUse: z.string().optional(),
});
export type McpServerConfig = z.infer<typeof McpServerConfigSchema>;

export const SkillPackConfigSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  description: z.string().default(""),
  enabled: z.boolean().default(true),
  builtin: z.boolean().default(false),
  source: z.enum(["builtin", "user"]).default("user"),
  rootDir: z.string().min(1),
});
export type SkillPackConfig = z.infer<typeof SkillPackConfigSchema>;

export const WorkerMcpServerSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  transport: McpTransportSchema,
  rootDir: z.string().optional(),
  command: z.string().optional(),
  args: z.array(z.string()).default([]),
  url: z.string().optional(),
  env: z.record(z.string(), z.string()).default({}),
  binary: z.string().optional(),
  defaultFlags: z.string().optional(),
  targetFlag: z.string().optional(),
  capability: z.enum(["observe", "scan", "active-lab", "full"]).optional(),
  parser: z.enum(["nmap", "httpx", "nuclei", "ffuf"]).optional(),
  timeoutMs: z.number().int().positive().optional(),
  whenToUse: z.string().optional(),
});
export type WorkerMcpServer = z.infer<typeof WorkerMcpServerSchema>;

export const WorkerSkillPackSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  rootDir: z.string().min(1),
});
export type WorkerSkillPack = z.infer<typeof WorkerSkillPackSchema>;

/** Short catalog entry so the model can unlock tools it has not enabled yet. */
export const ToolCatalogEntrySchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  description: z.string().default(""),
  category: z.string().default("general"),
});
export type ToolCatalogEntry = z.infer<typeof ToolCatalogEntrySchema>;

/** Always-on MCP core for progressive unlock (task start). */
export const CORE_MCP_IDS = ["nmap", "httpx", "nuclei"] as const;
/** Always-on skill core. */
export const CORE_SKILL_IDS = [
  "auth-scope-discipline",
  "evidence-first",
  "recon",
] as const;

/** Passive asset discovery APIs (FOFA / 鹰图 Hunter / user-built). */
export const AssetCollectorKindSchema = z.enum(["fofa", "hunter", "custom"]);
export type AssetCollectorKind = z.infer<typeof AssetCollectorKindSchema>;

export const AssetCollectorConfigSchema = z.object({
  id: z.string().min(1).regex(/^[a-z0-9][a-z0-9_-]{0,63}$/i),
  name: z.string().min(1),
  kind: AssetCollectorKindSchema,
  enabled: z.boolean().default(false),
  builtin: z.boolean().default(false),
  /** FOFA email; unused for hunter/custom unless custom auth needs it. */
  email: z.string().default(""),
  apiKey: z.string().default(""),
  baseUrl: z.string().default(""),
  /** custom only */
  method: z.enum(["GET", "POST"]).default("GET"),
  authHeader: z.string().default(""),
  authQueryParam: z.string().default(""),
  queryParam: z.string().default("q"),
  queryEncoding: z.enum(["plain", "base64"]).default("plain"),
  bodyTemplate: z.string().default(""),
  resultPath: z.string().default(""),
  addressFields: z.array(z.string()).default(["host", "ip", "domain", "url"]),
});
export type AssetCollectorConfig = z.infer<typeof AssetCollectorConfigSchema>;

/** Worker-facing collector (secrets via env, not plaintext in manifest). */
export const WorkerAssetCollectorSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  kind: AssetCollectorKindSchema,
  enabled: z.boolean(),
  baseUrl: z.string(),
  emailEnv: z.string().optional(),
  apiKeyEnv: z.string(),
  method: z.enum(["GET", "POST"]).default("GET"),
  authHeader: z.string().default(""),
  authQueryParam: z.string().default(""),
  queryParam: z.string().default("q"),
  queryEncoding: z.enum(["plain", "base64"]).default("plain"),
  bodyTemplate: z.string().default(""),
  resultPath: z.string().default(""),
  addressFields: z.array(z.string()).default(["host", "ip", "domain", "url"]),
});
export type WorkerAssetCollector = z.infer<typeof WorkerAssetCollectorSchema>;

export const BUILTIN_ASSET_COLLECTORS: AssetCollectorConfig[] = [
  {
    id: "fofa",
    name: "FOFA",
    kind: "fofa",
    enabled: false,
    builtin: true,
    email: "",
    apiKey: "",
    baseUrl: "https://fofa.info/api/v1/search/all",
    method: "GET",
    authHeader: "",
    authQueryParam: "",
    queryParam: "qbase64",
    queryEncoding: "base64",
    bodyTemplate: "",
    resultPath: "results",
    addressFields: ["host", "ip", "domain"],
  },
  {
    id: "hunter",
    name: "鹰图 (Hunter)",
    kind: "hunter",
    enabled: false,
    builtin: true,
    email: "",
    apiKey: "",
    baseUrl: "https://hunter.qianxin.com/openApi/search",
    method: "GET",
    authHeader: "",
    authQueryParam: "",
    queryParam: "search",
    queryEncoding: "base64",
    bodyTemplate: "",
    resultPath: "data.arr",
    addressFields: ["url", "domain", "ip"],
  },
];

/** Keep builtin FOFA/Hunter; preserve user credentials + enabled; append custom. */
export function mergeAssetCollectors(
  existing: AssetCollectorConfig[],
): AssetCollectorConfig[] {
  const prev = new Map(existing.map((c) => [c.id, c]));
  const out: AssetCollectorConfig[] = [];
  const seen = new Set<string>();
  for (const item of BUILTIN_ASSET_COLLECTORS) {
    const old = prev.get(item.id);
    out.push(
      AssetCollectorConfigSchema.parse({
        ...item,
        enabled: old?.enabled ?? item.enabled,
        email: old?.email ?? item.email,
        apiKey: old?.apiKey ?? item.apiKey,
        baseUrl: old?.baseUrl || item.baseUrl,
      }),
    );
    seen.add(item.id);
  }
  for (const rest of existing) {
    if (seen.has(rest.id)) continue;
    out.push(
      AssetCollectorConfigSchema.parse({
        ...rest,
        builtin: false,
        kind: rest.kind === "custom" ? "custom" : rest.kind,
      }),
    );
  }
  return out;
}

export function assetCollectorEnvNames(id: string): {
  emailEnv: string;
  apiKeyEnv: string;
} {
  const slug = id.toUpperCase().replace(/[^A-Z0-9]+/g, "_");
  return {
    emailEnv: `GY_ASSET_${slug}_EMAIL`,
    apiKeyEnv: `GY_ASSET_${slug}_KEY`,
  };
}

export const WorkerManifestSchema = z.object({
  taskId: z.string().uuid(),
  /** Delegation id (consultations / change ledger scope). Defaults to taskId. */
  engagementId: z.string().optional(),
  dataDir: z.string(),
  historyDb: z.string(),
  durableDb: z.string(),
  evidenceDir: z.string(),
  workspaceDir: z.string(),
  auth: AuthScopeSchema,
  /** Authorization revision this manifest was built from (Stage 2). */
  scopeVersion: z.number().int().positive().default(1),
  goals: z.array(GoalStateSchema),
  budget: BudgetSchema,
  execution: ExecutionConfigSchema.default({
    maxConcurrentExplores: DEFAULT_MAX_CONCURRENT_EXPLORES,
    maxIntentsPerReason: DEFAULT_MAX_INTENTS_PER_REASON,
    maxIntentsPerAssetRoot: DEFAULT_MAX_INTENTS_PER_ASSET_ROOT,
    exploreTimeoutMs: DEFAULT_EXPLORE_TIMEOUT_MS,
    reasonLeaseMs: DEFAULT_REASON_LEASE_MS,
  }),
  /** Stable id for Intent claim CAS (unique per Explore slot). */
  workerId: z.string().min(1).default("w0"),
  /** 0-based Explore slot; slot 0 is bootstrap/reason/report leader. */
  workerSlot: z.number().int().nonnegative().default(0),
  /** Total Explore workers spawned for this task. */
  workerCount: z.number().int().positive().default(1),
  /** Command-approval epoch. Older manifests omit it and cannot dispatch guarded commands. */
  commandFence: z.number().int().nonnegative().optional(),
  /** 命令执行前的确认方式：manual 时 worker 对范围内命令长等待用户确认。 */
  commandConfirmation: z.enum(["auto", "manual"]).default("auto"),
  mock: z.boolean(),
  model: z
    .object({
      provider: z.string(),
      modelId: z.string(),
      baseUrl: z.string().optional(),
      apiKeyEnv: z.string().default("OPENAI_API_KEY"),
      visionEnabled: z.boolean().default(true),
      visionModelId: z.string().optional(),
    })
    .optional(),
  /** Initially enabled MCP servers (settings ∪ core). */
  mcpServers: z.array(WorkerMcpServerSchema).default([]),
  /** Full pool for task-local enable_mcp. */
  mcpPool: z.array(WorkerMcpServerSchema).default([]),
  mcpCatalog: z.array(ToolCatalogEntrySchema).default([]),
  /** Initially enabled skills. */
  skillPacks: z.array(WorkerSkillPackSchema).default([]),
  skillPool: z.array(WorkerSkillPackSchema).default([]),
  skillCatalog: z.array(ToolCatalogEntrySchema).default([]),
  /** Enabled asset collectors (FOFA / 鹰图 / custom) for asset_search. */
  assetCollectors: z.array(WorkerAssetCollectorSchema).default([]),
});
export type WorkerManifest = z.infer<typeof WorkerManifestSchema>;

/** True when this process should run Bootstrap / Reason / Report. */
export function isExploreLeader(manifest: Pick<WorkerManifest, "workerSlot" | "workerCount">): boolean {
  return (manifest.workerCount ?? 1) <= 1 || (manifest.workerSlot ?? 0) === 0;
}

export const ModelSettingsSchema = z.object({
  provider: z.string().default("openai"),
  modelId: z.string().min(1).default("gpt-4.1-mini"),
  baseUrl: z.string().default("https://api.openai.com/v1"),
  apiKey: z.string().default(""),
  visionEnabled: z.boolean().default(true),
  visionModelId: z.string().default(""),
});
export type ModelSettings = z.infer<typeof ModelSettingsSchema>;

export const UpdateSettingsSchema = z.object({
  githubUrl: z.string().default("https://github.com/Sycun/GongYuAI"),
  branch: z.string().default("main"),
  githubToken: z.string().default(""),
  lastCheckedAt: z.string().nullable().default(null),
  lastUpdatedAt: z.string().nullable().default(null),
  lastCommit: z.string().nullable().default(null),
});
export type UpdateSettings = z.infer<typeof UpdateSettingsSchema>;

/** Catalog from disk wins metadata; existing wins enabled when ids match. */
export function mergeMcpServers(
  existing: McpServerConfig[],
  catalog: McpServerConfig[],
): McpServerConfig[] {
  const prev = new Map(existing.map((s) => [s.id, s]));
  const out: McpServerConfig[] = [];
  const seen = new Set<string>();
  for (const item of catalog) {
    const old = prev.get(item.id);
    out.push(
      McpServerConfigSchema.parse({
        ...item,
        enabled: old ? old.enabled : item.enabled,
      }),
    );
    seen.add(item.id);
  }
  for (const rest of existing) {
    if (seen.has(rest.id)) continue;
    if (rest.rootDir) continue;
    out.push(McpServerConfigSchema.parse(rest));
  }
  return out;
}

export function mergeSkillPacks(
  existing: SkillPackConfig[],
  catalog: SkillPackConfig[],
): SkillPackConfig[] {
  const prev = new Map(existing.map((s) => [s.id, s]));
  const out: SkillPackConfig[] = [];
  const seen = new Set<string>();
  for (const item of catalog) {
    const old = prev.get(item.id);
    out.push(
      SkillPackConfigSchema.parse({
        ...item,
        enabled: old ? old.enabled : item.enabled,
      }),
    );
    seen.add(item.id);
  }
  for (const rest of existing) {
    if (seen.has(rest.id)) continue;
    out.push(SkillPackConfigSchema.parse(rest));
  }
  return out;
}

export const ChatApprovalSchema = z.object({
  scope: z.enum(["read-only", "local-validation"]),
  /** 命令执行前的确认方式；旧设置缺省时沿用自动审批行为。 */
  confirmation: z.enum(["auto", "manual"]).default("auto"),
  reviewer: z.object({ profileId: z.string().min(1).max(80), modelId: z.string().min(1).max(256) }).strict().nullable(),
}).strict();

export const AppSettingsSchema = z.object({
  chatApproval: ChatApprovalSchema.default({ scope: "read-only", confirmation: "auto", reviewer: null }),
  chatProfiles: z.array(ChatProfileSchema).default([]),
  defaultChatProfile: z.string().optional(),
  model: ModelSettingsSchema.default({
    provider: "openai",
    modelId: "gpt-4.1-mini",
    baseUrl: "https://api.openai.com/v1",
    apiKey: "",
    visionEnabled: true,
    visionModelId: "",
  }),
  update: UpdateSettingsSchema.default({
    githubUrl: "https://github.com/Sycun/GongYuAI",
    branch: "main",
    githubToken: "",
    lastCheckedAt: null,
    lastUpdatedAt: null,
    lastCommit: null,
  }),
  mcpServers: z.array(McpServerConfigSchema).default([]),
  skillPacks: z.array(SkillPackConfigSchema).default([]),
  assetCollectors: z.array(AssetCollectorConfigSchema).default([]),
  knowledgeEmbedding: KnowledgeEmbeddingSettingsSchema.default({
    enabled: true,
    provider: "local",
    local: {
      baseUrl: "http://127.0.0.1:8000/v1",
      model: "bge-m3-mlx-4bit",
      apiKeyEnv: "OMLX_API_KEY",
      apiKey: "",
      batchSize: 16,
      timeoutMs: 30_000,
    },
    cloud: {
      baseUrl: "",
      model: "",
      apiKeyEnv: "GY_CLOUD_EMBEDDING_API_KEY",
      apiKey: "",
      batchSize: 16,
      timeoutMs: 30_000,
    },
    cloudEngagements: [],
  }),
});
export type AppSettings = z.infer<typeof AppSettingsSchema>;

export const ModelSettingsPatchSchema = ModelSettingsSchema.partial();
export type ModelSettingsPatch = z.infer<typeof ModelSettingsPatchSchema>;

export const UpdateSettingsPatchSchema = UpdateSettingsSchema.partial();
export type UpdateSettingsPatch = z.infer<typeof UpdateSettingsPatchSchema>;

export const AssetCollectorPatchSchema = AssetCollectorConfigSchema.partial().extend({
  id: z.string().min(1),
});
export type AssetCollectorPatch = z.infer<typeof AssetCollectorPatchSchema>;

export const AddAssetCollectorSchema = AssetCollectorConfigSchema.omit({
  builtin: true,
}).extend({
  kind: z.literal("custom"),
  builtin: z.literal(false).default(false),
  enabled: z.boolean().default(true),
});
export type AddAssetCollector = z.infer<typeof AddAssetCollectorSchema>;

export const AddUserMcpSchema = z.object({
  id: z.string().min(1).regex(/^[a-z0-9][a-z0-9_-]{0,63}$/i),
  name: z.string().min(1),
  enabled: z.boolean().default(true),
  transport: z.enum(["stdio", "http"]),
  command: z.string().optional(),
  args: z.array(z.string()).default([]),
  url: z.string().optional(),
  env: z.record(z.string(), z.string()).default({}),
});
export type AddUserMcp = z.infer<typeof AddUserMcpSchema>;

export const ImportSkillSchema = z.object({
  id: z.string().min(1).regex(/^[a-z0-9][a-z0-9_-]{0,63}$/i),
  name: z.string().min(1),
  enabled: z.boolean().default(true),
  rootDir: z.string().optional(),
  skillMarkdown: z.string().optional(),
});
export type ImportSkill = z.infer<typeof ImportSkillSchema>;

export const ToggleToolsItemSchema = z.object({
  kind: z.enum(["mcp", "skill"]),
  id: z.string().min(1),
  enabled: z.boolean(),
});
export type ToggleToolsItem = z.infer<typeof ToggleToolsItemSchema>;

export const ToolsSettingsPatchSchema = z.object({
  mcpServers: z.array(McpServerConfigSchema).optional(),
  skillPacks: z.array(SkillPackConfigSchema).optional(),
});
export type ToolsSettingsPatch = z.infer<typeof ToolsSettingsPatchSchema>;

export function goalsFromSpecs(specs: GoalSpec[]): GoalState[] {
  // 建档请求已在 CreateTaskRequestSchema 里归一化；这里再走一次是幂等的，
  // 覆盖直接构造 GoalSpec 的调用方（测试、CLI、runner 恢复）。
  return normalizeGoalSpecs(specs).map((g) => ({
    id: g.id,
    title: g.title,
    description: g.description,
    kind: g.business ? BUSINESS_RECONCILE_KIND : (g.kind ?? "file"),
    ...(g.business ? { business: g.business } : {}),
    ...(g.assets?.length ? { assets: g.assets } : {}),
    evidencePatterns: g.evidencePatterns,
    evidenceChecks: g.evidenceChecks,
    findingsGate: g.findingsGate,
    ...(g.reconcileGate ? { reconcileGate: g.reconcileGate } : {}),
    ...(g.boardGate ? { boardGate: g.boardGate } : {}),
    passes: false,
    evidencePaths: [],
    assertedAt: null,
  }));
}

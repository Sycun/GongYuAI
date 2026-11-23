/**
 * 第九轮契约：委托边界、持久资料作业、人工求助、证据语义、四图 DTO、
 * 记忆与飞轮、角色分层与供应商韧性。
 *
 * 设计纪律（与 MASTER-DESIGN 一致）：
 * - 这里是**只有一份**的契约与纯函数；History / 控制面 / CLI / 验收共用。
 * - 纯函数不读环境、不读写磁盘，全部显式传参（便于用可控时钟复算）。
 * - 任何“完成/已验证”都必须来自证据；格式不支持、归属不明、材料过期
 *   分别表达，不允许静默升级为 verified。
 */
import { z } from "zod";
import { normalizeEndpointAddress, normalizeHost, targetAllows } from "./scope.js";

/* ------------------------------------------------------------------ *
 * 1. 委托边界（客户 / 委托 / 任务 / 材料 同一套可见性规则）
 * ------------------------------------------------------------------ */

export const VisibilityRoleSchema = z.enum(["operator", "reviewer", "viewer"]);
export type VisibilityRole = z.infer<typeof VisibilityRoleSchema>;

/**
 * 可见性上下文。`engagementId` 省略 = 平台级视图（仅限显式声明为平台级的
 * 调用方，例如全局记忆索引）；普通业务查询必须带上委托。
 */
export const VisibilityContextSchema = z.object({
  tenantId: z.string().min(1).default("default"),
  engagementId: z.string().min(1).optional(),
  operator: z.string().min(1).optional(),
  role: VisibilityRoleSchema.default("operator"),
  customerId: z.string().min(1).optional(),
});
export type VisibilityContext = z.infer<typeof VisibilityContextSchema>;

/** 任务记录里参与边界判断的最小字段集（不依赖 TaskRecord，避免循环导入）。 */
export type TaskBoundary = { id: string; tenantId: string; engagementId: string };

export type BoundaryDenial = {
  code: "tenant-mismatch" | "engagement-mismatch" | "engagement-required";
  message: string;
};

export class BoundaryError extends Error {
  readonly code: BoundaryDenial["code"];
  constructor(denial: BoundaryDenial) {
    super(denial.message);
    this.name = "BoundaryError";
    this.code = denial.code;
  }
}

export function taskBoundary(task: { id: string; tenantId?: string; engagementId?: string }): TaskBoundary {
  return {
    id: task.id,
    tenantId: task.tenantId ?? "default",
    // 旧任务缺少委托归属时自成一委托（与 store 建档口径一致）。
    engagementId: task.engagementId && task.engagementId.length > 0 ? task.engagementId : task.id,
  };
}

export function visibilityDenial(
  ctx: VisibilityContext,
  task: { id: string; tenantId?: string; engagementId?: string },
): BoundaryDenial | null {
  const boundary = taskBoundary(task);
  if ((ctx.tenantId ?? "default") !== boundary.tenantId) {
    return {
      code: "tenant-mismatch",
      message: `任务 ${task.id} 属于租户 ${boundary.tenantId}，当前上下文为 ${ctx.tenantId}`,
    };
  }
  if (ctx.engagementId && ctx.engagementId !== boundary.engagementId) {
    return {
      code: "engagement-mismatch",
      message: `任务 ${task.id} 属于委托 ${boundary.engagementId}，当前上下文为 ${ctx.engagementId}`,
    };
  }
  return null;
}

export function canSeeTask(
  ctx: VisibilityContext,
  task: { id: string; tenantId?: string; engagementId?: string },
): boolean {
  return visibilityDenial(ctx, task) === null;
}

/** 供所有新查询统一使用：越界直接抛错（不得静默返回空列表）。 */
export function assertVisible(
  ctx: VisibilityContext,
  task: { id: string; tenantId?: string; engagementId?: string },
): void {
  const denial = visibilityDenial(ctx, task);
  if (denial) throw new BoundaryError(denial);
}

export function filterVisible<T extends { id: string; tenantId?: string; engagementId?: string }>(
  ctx: VisibilityContext,
  tasks: readonly T[],
): T[] {
  return tasks.filter((task) => canSeeTask(ctx, task));
}

/** 资产身份：同一委托内按规范化主机名唯一；跨委托同名资产不得互相命中。 */
export function assetIdentity(engagementId: string, address: string): string {
  return `${engagementId}::${normalizeHost(address)}`;
}

/* ------------------------------------------------------------------ *
 * 2. 持久资料作业
 * ------------------------------------------------------------------ */

export const JobKindSchema = z.enum([
  "material-check",
  "evidence-pack",
  "parse-import",
  "role-plan",
  "role-review",
]);
export type JobKind = z.infer<typeof JobKindSchema>;

export const JobStatusSchema = z.enum([
  "queued",
  "running",
  "paused",
  "draining",
  "succeeded",
  "failed",
  "canceled",
  "unknown",
]);
export type JobStatus = z.infer<typeof JobStatusSchema>;

export const JobInputRefSchema = z.object({
  path: z.string().min(1),
  sha256: z.string().length(64).nullable().default(null),
  version: z.string().min(1).optional(),
});
export type JobInputRef = z.infer<typeof JobInputRefSchema>;

export const JobArtifactSchema = z.object({
  path: z.string().min(1),
  sha256: z.string().length(64),
  bytes: z.number().int().nonnegative().optional(),
});
export type JobArtifact = z.infer<typeof JobArtifactSchema>;

export const BackgroundJobSchema = z.object({
  id: z.string().uuid(),
  taskId: z.string().uuid(),
  engagementId: z.string().min(1),
  kind: JobKindSchema,
  label: z.string().min(1),
  status: JobStatusSchema,
  /** 作业登记时的范围版本；范围收缩后用于识别“迟到结果”。 */
  scopeVersion: z.number().int().positive(),
  asset: z.string().nullable().default(null),
  submittedBy: z.string().min(1),
  /** 作业参数（口径/目标/节奏等），提交时冻结，执行时原样读取。 */
  options: z.record(z.string(), z.unknown()).default({}),
  inputs: z.array(JobInputRefSchema).default([]),
  progress: z.object({
    done: z.number().int().nonnegative().default(0),
    total: z.number().int().nonnegative().default(0),
    message: z.string().default(""),
  }),
  artifacts: z.array(JobArtifactSchema).default([]),
  error: z.string().nullable().default(null),
  /** 幂等投递键：同一 job 的回执只记一次。 */
  receiptKey: z.string().min(1),
  deliveredAt: z.string().datetime().nullable().default(null),
  attempt: z.number().int().nonnegative().default(0),
  /** 执行该作业的控制面进程 bootId；重启后 running 变 unknown 的依据。 */
  bootId: z.string().nullable().default(null),
  startedAt: z.string().datetime().nullable().default(null),
  finishedAt: z.string().datetime().nullable().default(null),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  /** 迟到结果：完成时范围版本已前进，仍保留但标记。 */
  lateResult: z.boolean().default(false),
  /** 暂停时的处置：已停止 / 正在收尾 / 状态未知。 */
  pauseState: z.enum(["none", "stopped", "draining", "unknown"]).default("none"),
  result: z.record(z.string(), z.unknown()).nullable().default(null),
});
export type BackgroundJob = z.infer<typeof BackgroundJobSchema>;

export const SubmitJobSchema = z.object({
  kind: JobKindSchema,
  label: z.string().min(1).max(200),
  asset: z.string().min(1).optional(),
  submittedBy: z.string().min(1).default("operator"),
  inputs: z.array(JobInputRefSchema).min(1),
  options: z.record(z.string(), z.unknown()).default({}),
});
export type SubmitJobInput = z.infer<typeof SubmitJobSchema>;

export const JobReceiptSchema = z.object({
  jobId: z.string().uuid(),
  deliveryKey: z.string().min(1),
  status: JobStatusSchema,
  deliveredBy: z.string().min(1),
  note: z.string().default(""),
  at: z.string().datetime(),
});
export type JobReceipt = z.infer<typeof JobReceiptSchema>;

export const AckJobSchema = z.object({
  deliveryKey: z.string().min(1),
  deliveredBy: z.string().min(1).default("operator"),
  note: z.string().default(""),
});
export type AckJobInput = z.infer<typeof AckJobSchema>;

/** 暂停语义：已停止 / 正在收尾 / 状态未知，三态必须能分开。 */
export function jobPauseDisposition(
  status: JobStatus,
  inFlight: boolean,
): "stopped" | "draining" | "unknown" | "unchanged" {
  if (status === "running") return inFlight ? "draining" : "stopped";
  if (status === "queued") return "stopped";
  if (status === "draining" || status === "unknown") return "unknown";
  return "unchanged";
}

/** 重启对账：上一代 bootId 的 running 作业不可能还在跑 → unknown（不假装成功）。 */
export function reconcileJobAfterBoot(
  job: { status: JobStatus; bootId: string | null },
  currentBootId: string,
): JobStatus | null {
  if (job.status !== "running" && job.status !== "draining") return null;
  if (job.bootId && job.bootId !== currentBootId) return "unknown";
  return null;
}

export function jobReceiptKey(jobId: string, attempt: number): string {
  return `${jobId}:${attempt}`;
}

/* ------------------------------------------------------------------ *
 * 3. 人工求助与交接
 * ------------------------------------------------------------------ */

export const CONSULT_BLOCKING_TTL_MS = 24 * 60 * 60 * 1000;

export const ConsultationSchema = z.object({
  id: z.string().uuid(),
  taskId: z.string().uuid(),
  engagementId: z.string().min(1),
  question: z.string().min(1),
  options: z.array(z.string()).default([]),
  context: z.string().default(""),
  blocking: z.boolean().default(true),
  status: z.enum(["open", "answered", "superseded"]).default("open"),
  /** 与创建时范围版本绑定：范围变化后仍须人工确认原来的问题。 */
  scopeVersion: z.number().int().positive(),
  createdAt: z.string().datetime(),
  dueAt: z.string().datetime(),
  /** 24h 到期转非阻塞的时间点；问题本身仍然 open。 */
  releasedAt: z.string().datetime().nullable().default(null),
  answeredAt: z.string().datetime().nullable().default(null),
  answeredBy: z.string().nullable().default(null),
  answer: z.string().nullable().default(null),
  relatedIntentId: z.string().nullable().default(null),
  relatedJobId: z.string().nullable().default(null),
});
export type Consultation = z.infer<typeof ConsultationSchema>;

export const CreateConsultSchema = z.object({
  question: z.string().min(1).max(4000),
  options: z.array(z.string().min(1)).default([]),
  context: z.string().default(""),
  blocking: z.boolean().default(true),
  askedBy: z.string().min(1).default("agent"),
  relatedIntentId: z.string().optional(),
  relatedJobId: z.string().optional(),
});
export type CreateConsultInput = z.infer<typeof CreateConsultSchema>;

export const AnswerConsultSchema = z.object({
  answer: z.string().min(1).max(8000),
  answeredBy: z.string().min(1),
  /** 回填为 Hint（source=human），默认 true。 */
  injectHint: z.boolean().default(true),
});
export type AnswerConsultInput = z.infer<typeof AnswerConsultSchema>;

export function consultDueAt(createdAtMs: number, ttlMs = CONSULT_BLOCKING_TTL_MS): string {
  return new Date(createdAtMs + ttlMs).toISOString();
}

/**
 * 24h 无回复：**只解除阻塞**，不关闭问题，也不改写任何事实。
 * 需要明确答复的事项仍留在 handoff 的 openQuestions 里。
 */
export function sweepConsult(
  consult: Consultation,
  nowMs: number,
): { changed: boolean; next: Consultation; reason: string | null } {
  if (consult.status !== "open" || !consult.blocking) {
    return { changed: false, next: consult, reason: null };
  }
  if (nowMs < Date.parse(consult.dueAt)) {
    return { changed: false, next: consult, reason: null };
  }
  return {
    changed: true,
    next: {
      ...consult,
      blocking: false,
      releasedAt: new Date(nowMs).toISOString(),
    },
    reason: "blocking-consult-24h-timeout",
  };
}

export function consultBlocks(consult: Consultation): boolean {
  return consult.status === "open" && consult.blocking;
}

export const HandoffQuestionSchema = z.object({
  id: z.string().uuid(),
  question: z.string(),
  blocking: z.boolean(),
  dueAt: z.string(),
  releasedAt: z.string().datetime().nullable(),
  scopeVersion: z.number().int().positive(),
});
export type HandoffQuestion = z.infer<typeof HandoffQuestionSchema>;

export type HandoffBlocked = {
  kind: "consult" | "job" | "goal" | "finding" | "scope";
  id: string;
  detail: string;
  /** 需要人工明确答复才能继续的事项为 true。 */
  needsAnswer: boolean;
};

export const HandoffPacketSchema = z.object({
  taskId: z.string().uuid(),
  engagementId: z.string().min(1),
  tenantId: z.string().min(1),
  generatedAt: z.string().datetime(),
  scopeVersion: z.number().int().positive(),
  scope: z.object({
    targets: z.array(z.string()),
    outOfScope: z.array(z.string()),
    capability: z.string(),
    version: z.number().int().positive(),
    updatedAt: z.string().datetime().nullable(),
  }),
  status: z.string(),
  completed: z.array(z.object({ id: z.string(), title: z.string(), assertedAt: z.string().nullable() })),
  blocked: z.array(
    z.object({
      kind: z.enum(["consult", "job", "goal", "finding", "scope"]),
      id: z.string(),
      detail: z.string(),
      needsAnswer: z.boolean(),
    }),
  ),
  latestRetractions: z.array(
    z.object({ kind: z.enum(["fact", "finding", "evidence"]), id: z.string(), reason: z.string(), at: z.string() }),
  ),
  openQuestions: z.array(HandoffQuestionSchema),
  jobs: z.array(
    z.object({
      id: z.string().uuid(),
      kind: JobKindSchema,
      status: JobStatusSchema,
      label: z.string(),
      scopeVersion: z.number().int().positive(),
      lateResult: z.boolean(),
    }),
  ),
  nextOwner: z.string().nullable(),
  notes: z.array(z.string()).default([]),
});
export type HandoffPacket = z.infer<typeof HandoffPacketSchema>;

/* ------------------------------------------------------------------ *
 * 4. 材料导入与证据语义
 * ------------------------------------------------------------------ */

export const MaterialKindSchema = z.enum([
  "asset-inventory",
  "config-check",
  "http-transaction",
  "manual-retest",
]);
export type MaterialKind = z.infer<typeof MaterialKindSchema>;

export const MaterialStatusSchema = z.enum(["accepted", "unsupported", "unknown-owner", "expired"]);
export type MaterialStatus = z.infer<typeof MaterialStatusSchema>;

export const EvidenceImportSchema = z.object({
  id: z.string().uuid(),
  taskId: z.string().uuid(),
  engagementId: z.string().min(1),
  kind: MaterialKindSchema.nullable().default(null),
  status: MaterialStatusSchema,
  source: z.string().min(1),
  parser: z.object({ name: z.string().min(1), version: z.string().min(1) }).nullable().default(null),
  importedAt: z.string().datetime(),
  observedAt: z.string().datetime(),
  asset: z.string().nullable().default(null),
  materialPath: z.string().min(1),
  sha256: z.string().length(64),
  locator: z.string().default(""),
  sensitivity: z.enum(["public", "redacted", "controlled-ref"]).default("redacted"),
  /** 受控引用：只存指针，不存明文。 */
  secretRef: z.string().nullable().default(null),
  reason: z.string().nullable().default(null),
  scopeVersion: z.number().int().positive(),
});
export type EvidenceImport = z.infer<typeof EvidenceImportSchema>;

export const ImportMaterialSchema = z.object({
  path: z.string().min(1),
  content: z.string(),
  kind: MaterialKindSchema.optional(),
  source: z.string().min(1).default("operator-import"),
  parser: z.object({ name: z.string().min(1), version: z.string().min(1) }).optional(),
  observedAt: z.string().datetime().optional(),
  asset: z.string().optional(),
  locator: z.string().default(""),
  secretRef: z.string().optional(),
  sensitivity: z.enum(["public", "redacted", "controlled-ref"]).default("redacted"),
  ttlDays: z.number().positive().optional(),
});
export type ImportMaterialInput = z.infer<typeof ImportMaterialSchema>;

const MATERIAL_TTL_DAYS: Record<MaterialKind, number> = {
  "asset-inventory": 14,
  "config-check": 14,
  "http-transaction": 7,
  "manual-retest": 30,
};

export function materialTtlDays(kind: MaterialKind): number {
  return MATERIAL_TTL_DAYS[kind];
}

const KIND_PATTERNS: Array<{ kind: MaterialKind; re: RegExp }> = [
  { kind: "asset-inventory", re: /(^|\/)(assets?|inventory|hosts?)[^/]*\.(csv|json|txt)$/i },
  { kind: "config-check", re: /(^|\/)(config|checks?|baseline)[^/]*\.(json|ya?ml)$/i },
  { kind: "http-transaction", re: /(^|\/)(http|transaction|req|res)[^/]*\.(txt|http|json)$/i },
  { kind: "manual-retest", re: /(^|\/)(retest|manual|复测)[^/]*\.(md|txt|json)$/i },
];

export function detectMaterialKind(path: string, content: string): MaterialKind | null {
  for (const { kind, re } of KIND_PATTERNS) {
    if (re.test(path)) return kind;
  }
  const head = content.trim().slice(0, 400);
  if (/^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s+\S+\s+HTTP\/1\.[01]/m.test(head)) return "http-transaction";
  if (/^[^,\n]+\n[^,\n]+,[^,\n]+/m.test(head) && /(host|asset|address|ip)/i.test(head)) return "asset-inventory";
  if (/"checks?"\s*:/.test(head)) return "config-check";
  if (/(复测|retest|manual verification)/i.test(head)) return "manual-retest";
  return null;
}

/** 敏感字段不得以明文进入台账；只允许受控引用。 */
export function looksLikeSecret(content: string): boolean {
  return /(password|passwd|secret|token|api[_-]?key|authorization:\s*bearer)\s*[:=]\s*\S{6,}/i.test(content);
}

export type MaterialClassification = {
  kind: MaterialKind | null;
  status: MaterialStatus;
  reason: string | null;
  asset: string | null;
  scopeVersionMatched: boolean;
};

/**
 * 材料分类。顺序固定：格式不支持 → 归属不明 → 过期 → accepted。
 * 任何一步失败都保留原始字节与原因，绝不降级成“已验证”。
 */
export function classifyMaterial(input: {
  path: string;
  content: string;
  declaredKind?: MaterialKind;
  asset?: string | null;
  targets: readonly string[];
  outOfScope?: readonly string[];
  observedAt: string;
  nowMs: number;
  ttlDays?: number;
  parserKnown?: boolean;
}): MaterialClassification {
  const kind = input.declaredKind ?? detectMaterialKind(input.path, input.content);
  if (!kind) {
    return { kind: null, status: "unsupported", reason: "unrecognized-material-format", asset: input.asset ?? null, scopeVersionMatched: false };
  }
  if (input.parserKnown === false) {
    return { kind, status: "unsupported", reason: "parser-unavailable", asset: input.asset ?? null, scopeVersionMatched: false };
  }
  const asset = input.asset ? normalizeHost(input.asset) : null;
  if (!asset) {
    return { kind, status: "unknown-owner", reason: "asset-not-declared", asset: null, scopeVersionMatched: false };
  }
  const allowed =
    targetAllows([...input.targets], asset) &&
    !(input.outOfScope ?? []).some((pattern) => targetAllows([pattern], asset));
  if (!allowed) {
    return { kind, status: "unknown-owner", reason: "asset-not-in-scope", asset, scopeVersionMatched: false };
  }
  const observedMs = Date.parse(input.observedAt);
  if (!Number.isFinite(observedMs)) {
    return { kind, status: "unsupported", reason: "invalid-observed-at", asset, scopeVersionMatched: false };
  }
  const ttl = (input.ttlDays ?? materialTtlDays(kind)) * 24 * 60 * 60 * 1000;
  if (input.nowMs - observedMs > ttl) {
    return {
      kind,
      status: "expired",
      reason: `material-older-than-${Math.round(ttl / 86_400_000)}d`,
      asset,
      scopeVersionMatched: false,
    };
  }
  return { kind, status: "accepted", reason: null, asset, scopeVersionMatched: true };
}

/* ------------------------------------------------------------------ *
 * 5. 覆盖矩阵（资产 × 检查项）与事实时效
 * ------------------------------------------------------------------ */

export const CoverageStateSchema = z.enum([
  "unknown",
  "material",
  "attempted",
  "manual",
  "verified",
  "retracted",
]);
export type CoverageState = z.infer<typeof CoverageStateSchema>;

export const CoverageCellSchema = z.object({
  asset: z.string(),
  technique: z.string(),
  state: CoverageStateSchema,
  materialRefs: z.array(z.string()).default([]),
  findingIds: z.array(z.string()).default([]),
  manualRefs: z.array(z.string()).default([]),
  /** 仅由被撤回证据支撑时为 true（独立依据则为 false）。 */
  retractedOnly: z.boolean().default(false),
  independentSupport: z.number().int().nonnegative().default(0),
  notes: z.array(z.string()).default([]),
});
export type CoverageCell = z.infer<typeof CoverageCellSchema>;

export type CoverageInput = {
  assets: readonly string[];
  /** P14-B3 — endpoint-level surface units (full URLs); cells keep the path. */
  endpoints?: readonly string[];
  techniques: readonly string[];
  materials: ReadonlyArray<{ asset: string | null; kind: MaterialKind | null; status: MaterialStatus; materialPath: string; sha256: string }>;
  findings: ReadonlyArray<{
    id: string;
    asset: string;
    vulnClass: string;
    status: string;
    evidence: ReadonlyArray<{ path: string; sha256: string }>;
    /** P14-B3 — finding endpoint (full URL) for endpoint-level cells. */
    endpoint?: string | null;
  }>;
  intents: ReadonlyArray<{ technique: string | null; asset: string | null; status: string }>;
  manual: ReadonlyArray<{ asset: string; technique: string; state: "manual" | "verified"; evidenceRefs: readonly string[] }>;
  retractedEvidence?: readonly string[];
};

/**
 * 矩阵派生规则（高到低）：
 * verified（有 verified/retested/accepted finding 且至少一条未撤回证据）
 * > manual（人工覆盖登记）> attempted（Intent 试过）> retracted（唯一依据被撤回）
 * > material（材料存在）> unknown。
 * 材料状态 unsupported/unknown-owner/expired 不计入 material。
 */
export function coverageStateRank(state: CoverageState): number {
  switch (state) {
    case "verified":
      return 5;
    case "manual":
      return 4;
    case "attempted":
      return 3;
    case "retracted":
      return 2;
    case "material":
      return 1;
    default:
      return 0;
  }
}

export function deriveCoverageMatrix(input: CoverageInput): CoverageCell[] {
  const retracted = new Set(input.retractedEvidence ?? []);
  const materialBy = new Map<string, string[]>();
  for (const material of input.materials) {
    if (material.status !== "accepted" || !material.asset) continue;
    const key = `${normalizeHost(material.asset)}::${material.kind ?? "unknown"}`;
    const list = materialBy.get(key) ?? [];
    list.push(material.materialPath);
    materialBy.set(key, list);
  }
  const cells: CoverageCell[] = [];
  for (const assetRaw of input.assets) {
    const asset = normalizeHost(assetRaw);
    for (const technique of input.techniques) {
      const materialRefs: string[] = [];
      for (const kind of ["asset-inventory", "config-check", "http-transaction", "manual-retest"] as MaterialKind[]) {
        materialRefs.push(...(materialBy.get(`${asset}::${kind}`) ?? []));
      }
      const findings = input.findings.filter(
        (finding) => normalizeHost(finding.asset) === asset && finding.vulnClass === technique,
      );
      const verifiedFindings = findings.filter((finding) => ["verified", "retested", "accepted"].includes(finding.status));
      const findingIds = findings.map((finding) => finding.id);
      // 证据身份以路径为主、哈希为辅：撤回一份材料时，引用同一路径的结论不再有依据。
      const evidenceEntries = verifiedFindings.flatMap((finding) => finding.evidence);
      const freshEvidence = evidenceEntries
        .filter((ev) => !retracted.has(ev.path) && !retracted.has(ev.sha256))
        .map((ev) => ev.path);
      const retractedOnlyFinding = verifiedFindings.length > 0 && freshEvidence.length === 0;
      const manual = input.manual.filter(
        (entry) => normalizeHost(entry.asset) === asset && entry.technique === technique,
      );
      const manualRefs = manual.flatMap((entry) => [...entry.evidenceRefs]);
      const freshManual = manualRefs.filter((ref) => !retracted.has(ref));
      const attempted = input.intents.some(
        (intent) =>
          intent.technique === technique &&
          intent.asset !== null &&
          normalizeHost(intent.asset) === asset &&
          ["claimed", "running", "succeeded", "failed", "expired"].includes(intent.status),
      );
      const retractedFindings = findings.filter((finding) => finding.status === "retracted");

      let state: CoverageState = "unknown";
      if (verifiedFindings.length > 0 && !retractedOnlyFinding) state = "verified";
      else if (manual.length > 0) {
        // 人工覆盖没有附证据也算"已人工覆盖"；只有附了证据且全被撤回才降为 retracted。
        state = manualRefs.length === 0 || freshManual.length > 0 ? "manual" : "retracted";
      } else if (attempted) state = "attempted";
      // 依据被撤回优先于“材料存在”：材料在架不等于结论仍成立。
      else if (retractedOnlyFinding || retractedFindings.length > 0) state = "retracted";
      else if (materialRefs.length > 0) state = "material";

      const notes: string[] = [];
      if (retractedOnlyFinding) notes.push("唯一支持证据已撤回，待复核");
      if (retractedFindings.length > 0 && state !== "retracted") notes.push(`另有 ${retractedFindings.length} 条被撤回的 finding`);
      if (materialRefs.length > 0 && state === "unknown") notes.push("材料存在但未登记检查");

      cells.push({
        asset,
        technique,
        state,
        materialRefs,
        findingIds,
        manualRefs,
        retractedOnly: retractedOnlyFinding,
        independentSupport: Math.max(
          retractedOnlyFinding ? 0 : freshEvidence.length,
          freshManual.length,
        ),
        notes,
      });
    }
  }

  // P14-B3 — endpoint rows: a Web path is a surface unit of its own. Only
  // findings/evidence testify here; intents still anchor at the host level.
  for (const rawEndpoint of input.endpoints ?? []) {
    const endpoint = normalizeEndpointAddress(rawEndpoint);
    if (!endpoint) continue;
    for (const technique of input.techniques) {
      const findings = input.findings.filter(
        (finding) =>
          finding.endpoint != null &&
          normalizeEndpointAddress(finding.endpoint) === endpoint &&
          finding.vulnClass === technique,
      );
      if (!findings.length) continue;
      const verifiedFindings = findings.filter((finding) =>
        ["verified", "retested", "accepted"].includes(finding.status),
      );
      const evidenceEntries = verifiedFindings.flatMap((finding) => finding.evidence);
      const freshEvidence = evidenceEntries
        .filter((ev) => !retracted.has(ev.path) && !retracted.has(ev.sha256))
        .map((ev) => ev.path);
      const retractedFindings = findings.filter((finding) => finding.status === "retracted");
      const retractedOnlyFinding = verifiedFindings.length > 0 && freshEvidence.length === 0;
      let state: CoverageState = "unknown";
      if (verifiedFindings.length > 0 && !retractedOnlyFinding) state = "verified";
      else if (retractedOnlyFinding || retractedFindings.length > 0) state = "retracted";
      cells.push({
        asset: endpoint,
        technique,
        state,
        materialRefs: [],
        findingIds: findings.map((finding) => finding.id),
        manualRefs: [],
        retractedOnly: retractedOnlyFinding,
        independentSupport: retractedOnlyFinding ? 0 : freshEvidence.length,
        notes: [retractedOnlyFinding ? "端点唯一证据已撤回" : ""].filter(Boolean),
      });
    }
  }
  return cells;
}

export const ManualCoverageSchema = z.object({
  asset: z.string().min(1),
  technique: z.string().min(1),
  state: z.enum(["manual", "verified"]),
  reviewer: z.string().min(1),
  reason: z.string().min(1),
  evidenceRefs: z.array(z.string()).default([]),
});
export type ManualCoverage = z.infer<typeof ManualCoverageSchema> & { id: string; createdAt: string };

export const FRESHNESS_NEEDS_REVIEW = "needs-review" as const;
export const FactFreshnessSchema = z.object({
  factId: z.string(),
  state: z.enum(["fresh", "needs-review"]),
  ageMs: z.number().nonnegative(),
  ttlMs: z.number().positive(),
  freshUntil: z.string().datetime(),
  reason: z.string().nullable().default(null),
});
export type FactFreshness = z.infer<typeof FactFreshnessSchema>;

const DAY_MS = 24 * 60 * 60 * 1000;
export const FACT_TTL_MS: Record<string, number> = {
  asset: 7 * DAY_MS,
  finding: 14 * DAY_MS,
  scope: 365 * DAY_MS,
  default: 30 * DAY_MS,
};

/** 事实保鲜：TTL 只产生“待复核”派生态，永不删除或改写原 Fact。 */
export function freshnessOf(
  fact: { id: string; tags?: readonly string[]; createdAt: string },
  nowMs: number,
  ttlByKind: Record<string, number> = FACT_TTL_MS,
  nowIso?: string,
): FactFreshness {
  const tags = fact.tags ?? [];
  const kind = tags.includes("asset") ? "asset" : tags.some((tag) => tag.startsWith("finding")) ? "finding" : tags.includes("scope") ? "scope" : "default";
  const ttlMs = ttlByKind[kind] ?? FACT_TTL_MS.default!;
  const createdMs = Date.parse(fact.createdAt);
  const ageMs = Number.isFinite(createdMs) ? Math.max(0, nowMs - createdMs) : 0;
  const stale = Number.isFinite(createdMs) && nowMs - createdMs > ttlMs;
  return {
    factId: fact.id,
    state: stale ? "needs-review" : "fresh",
    ageMs,
    ttlMs,
    freshUntil: new Date((Number.isFinite(createdMs) ? createdMs : nowMs) + ttlMs).toISOString(),
    reason: stale ? `fact-older-than-${Math.round(ttlMs / DAY_MS)}d` : null,
  };
}

/* ------------------------------------------------------------------ *
 * 6. 变更台账
 * ------------------------------------------------------------------ */

export const ChangeKindSchema = z.enum(["webshell", "account", "config", "persistence", "db", "network", "file"]);
export const ChangeRecordSchema = z.object({
  id: z.string().uuid(),
  taskId: z.string().uuid(),
  engagementId: z.string().min(1),
  kind: ChangeKindSchema,
  asset: z.string().min(1),
  location: z.string().min(1),
  beforeSha256: z.string().length(64).nullable().default(null),
  rollbackCmd: z.string().min(1),
  appliedAt: z.string().datetime(),
  registeredBy: z.string().min(1),
  credentialId: z.string().nullable().default(null),
  intentId: z.string().nullable().default(null),
  materials: z.array(z.object({ path: z.string(), sha256: z.string().length(64) })).default([]),
  confirmedBy: z.string().nullable().default(null),
  closedAt: z.string().datetime().nullable().default(null),
  note: z.string().default(""),
  scopeVersion: z.number().int().positive(),
});
export type ChangeRecord = z.infer<typeof ChangeRecordSchema>;

export const RegisterChangeSchema = z.object({
  kind: ChangeKindSchema,
  asset: z.string().min(1),
  location: z.string().min(1),
  rollbackCmd: z.string().min(1),
  appliedAt: z.string().datetime().optional(),
  registeredBy: z.string().min(1).default("operator"),
  credentialId: z.string().optional(),
  intentId: z.string().optional(),
  beforeMaterial: z.object({ path: z.string(), content: z.string() }).optional(),
  note: z.string().default(""),
});
export type RegisterChangeInput = z.infer<typeof RegisterChangeSchema>;

/** 回滚脚本：逆序，只生成不执行。 */
export function rollbackScript(changes: readonly ChangeRecord[]): string {
  const lines = [
    "#!/usr/bin/env bash",
    "# 由 GongYuAI 生成的回滚清单（只生成，不执行）。执行前须人工复核。",
    "set -euo pipefail",
  ];
  for (const change of [...changes].reverse()) {
    lines.push(
      `# ${change.appliedAt} ${change.kind} ${change.asset} ${change.location} by ${change.registeredBy}`,
    );
    lines.push(change.rollbackCmd);
  }
  if (changes.length === 0) lines.push("# 未登记改动");
  return lines.join("\n") + "\n";
}

/* ------------------------------------------------------------------ *
 * 7. 图视图 DTO（只读投影，稳定 ID）
 * ------------------------------------------------------------------ */

export const GraphViewNameSchema = z.enum(["assets", "surface", "execution", "memory"]);
export type GraphViewName = z.infer<typeof GraphViewNameSchema>;

export const GraphNodeSchema = z.object({
  id: z.string().min(1),
  kind: z.string().min(1),
  label: z.string(),
  badge: z.string().nullable().default(null),
  data: z.record(z.string(), z.unknown()).default({}),
});
export type GraphNode = z.infer<typeof GraphNodeSchema>;

export const GraphEdgeSchema = z.object({
  id: z.string().min(1),
  from: z.string().min(1),
  to: z.string().min(1),
  kind: z.string().min(1),
  label: z.string().default(""),
  broken: z.boolean().default(false),
});
export type GraphEdge = z.infer<typeof GraphEdgeSchema>;

export const GraphViewSchema = z.object({
  taskId: z.string().uuid(),
  engagementId: z.string().min(1),
  view: GraphViewNameSchema,
  generatedAt: z.string().datetime(),
  empty: z.boolean().default(false),
  emptyReason: z.string().nullable().default(null),
  nodes: z.array(GraphNodeSchema).default([]),
  edges: z.array(GraphEdgeSchema).default([]),
  notes: z.array(z.string()).default([]),
});
export type GraphView = z.infer<typeof GraphViewSchema>;

export function graphNodeId(kind: string, stable: string): string {
  return `${kind}:${stable}`;
}

/** 断点：缺依据的边必须显式标注，不编造。 */
export function brokenEdge(
  from: string,
  to: string,
  kind: string,
  label: string,
  reason: string,
): GraphEdge {
  return { id: `${from}->${to}:${kind}`, from, to, kind, label: `${label}（${reason}）`, broken: true };
}

export const TodayWorkSchema = z.object({
  generatedAt: z.string().datetime(),
  engagementId: z.string().nullable(),
  tenantId: z.string(),
  tasks: z.array(
    z.object({
      taskId: z.string(),
      name: z.string(),
      status: z.string(),
      scopeVersion: z.number().int().positive(),
      openQuestions: z.number().int().nonnegative(),
      runningJobs: z.number().int().nonnegative(),
      lateJobs: z.number().int().nonnegative(),
      blockedGoals: z.number().int().nonnegative(),
      staleFacts: z.number().int().nonnegative(),
      nextAction: z.string(),
    }),
  ),
});
export type TodayWork = z.infer<typeof TodayWorkSchema>;

/* ------------------------------------------------------------------ *
 * 8. 全局记忆（女娲繁衍层）
 * ------------------------------------------------------------------ */

export const MemoryKindSchema = z.enum(["lesson", "playbook", "counterexample", "tool-artifact"]);
export type MemoryKind = z.infer<typeof MemoryKindSchema>;

export const MemoryStatusSchema = z.enum(["draft", "confirmed", "retracted", "superseded"]);
export type MemoryStatus = z.infer<typeof MemoryStatusSchema>;

export const MatchKeySchema = z.object({
  kind: z.enum(["family", "stack", "cwe", "asset-class", "technique"]),
  value: z.string().min(1),
  strength: z.enum(["hard", "soft"]).default("soft"),
});
export type MatchKey = z.infer<typeof MatchKeySchema>;

export const ProvenanceSchema = z.object({
  taskId: z.string().uuid(),
  engagementId: z.string().min(1),
  refKind: z.enum(["fact", "finding", "evidence", "report"]),
  refId: z.string().min(1),
  path: z.string().nullable().default(null),
  sha256: z.string().length(64).nullable().default(null),
});
export type Provenance = z.infer<typeof ProvenanceSchema>;

export const MemoryNodeSchema = z.object({
  id: z.string().uuid(),
  kind: MemoryKindSchema,
  title: z.string().min(1).max(200),
  body: z.string().default(""),
  status: MemoryStatusSchema.default("draft"),
  matchKeys: z.array(MatchKeySchema).min(1),
  /** 无源不记忆：至少一条溯源指针。 */
  provenance: z.array(ProvenanceSchema).min(1),
  contradicts: z.string().uuid().nullable().default(null),
  supersedes: z.string().uuid().nullable().default(null),
  supersededBy: z.string().uuid().nullable().default(null),
  reviewer: z.string().nullable().default(null),
  reviewedAt: z.string().datetime().nullable().default(null),
  reviewReason: z.string().nullable().default(null),
  reuseCount: z.number().int().nonnegative().default(0),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  /** 依据被撤回时置位，待复核；节点保留。 */
  supportRetracted: z.boolean().default(false),
});
export type MemoryNode = z.infer<typeof MemoryNodeSchema>;

export const CreateMemoryDraftSchema = z.object({
  kind: MemoryKindSchema,
  title: z.string().min(1).max(200),
  body: z.string().default(""),
  matchKeys: z.array(MatchKeySchema).min(1),
  provenance: z.array(ProvenanceSchema).min(1),
  contradicts: z.string().uuid().optional(),
  supersedes: z.string().uuid().optional(),
  createdBy: z.string().min(1).default("operator"),
});
export type CreateMemoryDraftInput = z.infer<typeof CreateMemoryDraftSchema>;

export const ReviewMemorySchema = z.object({
  decision: z.enum(["confirm", "retract"]),
  reviewer: z.string().min(1),
  reason: z.string().default(""),
});
export type ReviewMemoryInput = z.infer<typeof ReviewMemorySchema>;

export const MemoryInjectionSchema = z.object({
  id: z.string().uuid(),
  memoryId: z.string().uuid(),
  taskId: z.string().uuid(),
  engagementId: z.string().min(1),
  hintId: z.string().uuid().nullable().default(null),
  layer: z.enum(["bootstrap", "explore-extra"]),
  matchedKeys: z.array(z.string()).default([]),
  reason: z.string().default(""),
  injectedAt: z.string().datetime(),
});
export type MemoryInjection = z.infer<typeof MemoryInjectionSchema>;

export const MEMORY_INJECTION_TITLE_LIMIT = 5;
export const MEMORY_INJECTION_ASSET_EXTRA = 2;

export type MemoryMatchContext = {
  familyKey?: string | null;
  stack?: readonly string[];
  cwes?: readonly string[];
  assetClass?: string | null;
  assetKey?: string | null;
  techniques?: readonly string[];
};

export type MemoryMatch = { node: MemoryNode; layer: "bootstrap" | "explore-extra"; matched: string[]; hard: boolean };

/**
 * 分层匹配：硬键命中 → 正常注入；仅 ≥2 个软键命中 → 低置信参考。
 * 只取 confirmed；draft/retracted/superseded 一律不注入。
 * 上限：title 层 N=5；命中当前资产时最多再追加 2 条。
 */
export function matchMemory(
  nodes: readonly MemoryNode[],
  ctx: MemoryMatchContext,
  opts: { limit?: number; assetExtra?: number; alreadyInjected?: readonly string[] } = {},
): MemoryMatch[] {
  const limit = opts.limit ?? MEMORY_INJECTION_TITLE_LIMIT;
  const assetExtra = opts.assetExtra ?? MEMORY_INJECTION_ASSET_EXTRA;
  const injected = new Set(opts.alreadyInjected ?? []);
  const scored: Array<MemoryMatch & { score: number }> = [];
  for (const node of nodes) {
    if (node.status !== "confirmed" || injected.has(node.id)) continue;
    const matched: string[] = [];
    let hard = false;
    let soft = 0;
    for (const key of node.matchKeys) {
      const value = key.value.toLowerCase();
      const hit =
        (key.kind === "family" && (ctx.familyKey ?? "").toLowerCase() === value) ||
        (key.kind === "stack" && (ctx.stack ?? []).some((entry) => entry.toLowerCase() === value)) ||
        (key.kind === "cwe" && (ctx.cwes ?? []).some((entry) => entry.toLowerCase() === value)) ||
        (key.kind === "asset-class" && (ctx.assetClass ?? "").toLowerCase() === value) ||
        (key.kind === "technique" && (ctx.techniques ?? []).some((entry) => entry.toLowerCase() === value));
      if (!hit) continue;
      matched.push(`${key.kind}:${key.value}`);
      if (key.strength === "hard") hard = true;
      else soft += 1;
    }
    if (!hard && soft < 2) continue;
    scored.push({ node, layer: "bootstrap", matched, hard, score: (hard ? 100 : 0) + soft });
  }
  scored.sort((a, b) => b.score - a.score || a.node.createdAt.localeCompare(b.node.createdAt));
  const primary = scored.slice(0, limit);
  const assetKey = (ctx.assetKey ?? "").toLowerCase();
  const primaryIds = new Set(primary.map((match) => match.node.id));
  // Explore 追加：命中当前资产的节点即使只有一个软键也允许“参考”，但仍受 +2 上限。
  const extra: MemoryMatch[] = [];
  if (assetKey && assetExtra > 0) {
    for (const node of nodes) {
      if (node.status !== "confirmed" || injected.has(node.id) || primaryIds.has(node.id)) continue;
      const matched = node.matchKeys
        .filter((key) => key.kind === "asset-class" && key.value.toLowerCase() === assetKey)
        .map((key) => `${key.kind}:${key.value}`);
      if (matched.length === 0) continue;
      extra.push({ node, layer: "explore-extra", matched, hard: false });
      if (extra.length >= assetExtra) break;
    }
  }
  return [
    ...primary.map(({ score: _score, ...rest }) => rest),
    ...extra,
  ];
}

export const ArchiveContactHitSchema = z.object({
  taskId: z.string().uuid(),
  engagementId: z.string().min(1),
  name: z.string(),
  status: z.string(),
  finishedAt: z.string().datetime().nullable(),
  findings: z.number().int().nonnegative(),
  verifiedFindings: z.number().int().nonnegative(),
  retractedFindings: z.number().int().nonnegative(),
  pointer: z.object({ kind: z.string(), id: z.string(), sha256: z.string().nullable().default(null) }),
  mayHaveDrifted: z.boolean().default(false),
  sameAsset: z.boolean().default(false),
});
export type ArchiveContactHit = z.infer<typeof ArchiveContactHitSchema>;

/* ------------------------------------------------------------------ *
 * 9. 飞轮：Finding 级评测、趋势、提案
 * ------------------------------------------------------------------ */

export const FindingEvalCaseSchema = z.object({
  id: z.string().min(1),
  asset: z.string().default(""),
  vulnClass: z.string().default(""),
  expectedPresent: z.boolean(),
  expectedSeverity: z.enum(["info", "low", "medium", "high", "critical"]).nullable().default(null),
  actualPresent: z.boolean(),
  actualSeverity: z.enum(["info", "low", "medium", "high", "critical"]).nullable().default(null),
  actualStatus: z.enum(["tentative", "verified", "retested", "accepted", "retracted"]).nullable().default(null),
  /** 人工裁决：pending 单列，不混进 FP/FN。 */
  adjudication: z.enum(["pending", "confirmed", "dismissed"]).default("pending"),
});
export type FindingEvalCase = z.infer<typeof FindingEvalCaseSchema>;

export type FindingMetrics = {
  tp: number;
  fp: number;
  fn: number;
  pending: number;
  adjudicated: number;
  precision: number | null;
  recall: number | null;
  severityAgreement: number | null;
  denominators: { expected: number; reported: number; adjudicated: number; pending: number };
};

/**
 * Finding 级指标：误报/漏项/待裁决各自有分母，待裁决不并入 FP/FN。
 * retracted 的实际上报按“未上报”计，但单独计入 reportedRetracted 说明。
 */
export function findingMetrics(cases: readonly FindingEvalCase[]): FindingMetrics {
  let tp = 0;
  let fp = 0;
  let fn = 0;
  let pending = 0;
  const adjudicatedCases = cases.filter((entry) => entry.adjudication !== "pending");
  for (const entry of cases) {
    if (entry.adjudication === "pending") {
      pending += 1;
      continue;
    }
    const actual = entry.actualPresent && entry.actualStatus !== "retracted";
    if (entry.expectedPresent && actual) tp += 1;
    else if (entry.expectedPresent && !actual) fn += 1;
    else if (!entry.expectedPresent && actual) fp += 1;
  }
  const adjudicated = adjudicatedCases.length;
  const severityCases = adjudicatedCases.filter(
    (entry) => entry.expectedPresent && entry.expectedSeverity && entry.actualPresent,
  );
  const severityHits = severityCases.filter((entry) => entry.actualSeverity === entry.expectedSeverity).length;
  const expected = cases.filter((entry) => entry.expectedPresent).length;
  const reported = cases.filter((entry) => entry.actualPresent && entry.actualStatus !== "retracted").length;
  return {
    tp,
    fp,
    fn,
    pending,
    adjudicated,
    precision: tp + fp === 0 ? null : tp / (tp + fp),
    // 待裁决样本不进 recall 分母（否则把“还没人判”算成漏项）。
    recall: tp + fn === 0 ? null : tp / (tp + fn),
    severityAgreement: severityCases.length === 0 ? null : severityHits / severityCases.length,
    denominators: { expected, reported, adjudicated, pending },
  };
}

export const TrendPointSchema = z.object({
  batch: z.string().min(1),
  taskId: z.string().uuid().nullable().default(null),
  engagementId: z.string().nullable().default(null),
  at: z.string().datetime(),
  goalsPassed: z.number().int().nonnegative(),
  goalsTotal: z.number().int().nonnegative(),
  verifiedFindings: z.number().int().nonnegative(),
  retractedFindings: z.number().int().nonnegative(),
  tokens: z.number().int().nonnegative(),
  wallMs: z.number().int().nonnegative(),
  reuseCount: z.number().int().nonnegative().default(0),
});
export type TrendPoint = z.infer<typeof TrendPointSchema>;

export const ProposalKindSchema = z.enum(["memory", "skill", "param", "prompt", "tool"]);
export const ProposalStatusSchema = z.enum(["draft", "approved", "rejected", "promoted", "rolled-back"]);
export type ProposalKind = z.infer<typeof ProposalKindSchema>;
export type ProposalStatus = z.infer<typeof ProposalStatusSchema>;
export const ProposalEvidenceSchema = z.object({
  taskId: z.string().min(1),
  pointer: z.string().min(1),
  sha256: z.string().length(64).nullable().default(null),
});
export const ProposalSchema = z.object({
  id: z.string().uuid(),
  kind: ProposalKindSchema,
  title: z.string().min(1).max(200),
  body: z.string().default(""),
  status: ProposalStatusSchema.default("draft"),
  /** 无证据不提案：至少一条证据链接。 */
  evidence: z.array(ProposalEvidenceSchema).min(1),
  expectedGain: z.string().default(""),
  configKey: z.string().nullable().default(null),
  proposedValue: z.string().nullable().default(null),
  previousValue: z.string().nullable().default(null),
  version: z.number().int().positive().default(1),
  approvedBy: z.string().nullable().default(null),
  approvedAt: z.string().datetime().nullable().default(null),
  rejectedReason: z.string().nullable().default(null),
  promotedAt: z.string().datetime().nullable().default(null),
  rolledBackAt: z.string().datetime().nullable().default(null),
  evaluationRunId: z.string().nullable().default(null),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type Proposal = z.infer<typeof ProposalSchema>;

export const CreateProposalSchema = z.object({
  kind: ProposalKindSchema,
  title: z.string().min(1).max(200),
  body: z.string().default(""),
  evidence: z.array(ProposalEvidenceSchema).min(1),
  expectedGain: z.string().default(""),
  configKey: z.string().optional(),
  proposedValue: z.string().optional(),
  previousValue: z.string().optional(),
  createdBy: z.string().min(1).default("operator"),
});
export type CreateProposalInput = z.infer<typeof CreateProposalSchema>;

export const DecideProposalSchema = z.object({
  decision: z.enum(["approve", "reject"]),
  decidedBy: z.string().min(1),
  reason: z.string().default(""),
});

export const EvaluationRunSchema = z.object({
  id: z.string().uuid(),
  suite: z.string().min(1),
  group: z.string().min(1),
  order: z.number().int().nonnegative().default(0),
  frozen: z.boolean(),
  seed: z.string().nullable().default(null),
  taskIds: z.array(z.string()).default([]),
  cases: z.array(FindingEvalCaseSchema).default([]),
  metrics: z.object({
    tp: z.number().int().nonnegative(),
    fp: z.number().int().nonnegative(),
    fn: z.number().int().nonnegative(),
    pending: z.number().int().nonnegative(),
    adjudicated: z.number().int().nonnegative(),
    precision: z.number().nullable(),
    recall: z.number().nullable(),
    severityAgreement: z.number().nullable(),
    denominators: z.object({
      expected: z.number().int().nonnegative(),
      reported: z.number().int().nonnegative(),
      adjudicated: z.number().int().nonnegative(),
      pending: z.number().int().nonnegative(),
    }),
  }),
  /** 组间隔离：本组运行期间禁止读取这些组的产物。 */
  isolatedFrom: z.array(z.string()).default([]),
  startedAt: z.string().datetime(),
  finishedAt: z.string().datetime(),
  notes: z.array(z.string()).default([]),
});
export type EvaluationRun = z.infer<typeof EvaluationRunSchema>;

export const RunEvaluationSchema = z.object({
  suite: z.string().min(1),
  group: z.string().min(1),
  order: z.number().int().nonnegative().default(0),
  frozen: z.boolean().default(true),
  seed: z.string().optional(),
  cases: z.array(FindingEvalCaseSchema).min(1),
  taskIds: z.array(z.string()).default([]),
  isolatedFrom: z.array(z.string()).default([]),
});
export type RunEvaluationInput = z.infer<typeof RunEvaluationSchema>;

/* ------------------------------------------------------------------ *
 * 10. 角色分层（Planner / Reviewer / Assistant）与供应商韧性
 * ------------------------------------------------------------------ */

export const RoleKindSchema = z.enum(["planner", "reviewer", "assistant", "executor"]);
export type RoleKind = z.infer<typeof RoleKindSchema>;

export const RoleAuthoritySchema = z.object({
  canPropose: z.boolean(),
  canReview: z.boolean(),
  canRequestPause: z.boolean(),
  canPause: z.boolean(),
  canStop: z.boolean(),
  canExpandScope: z.boolean(),
  canDispatchIntent: z.boolean(),
});
export type RoleAuthority = z.infer<typeof RoleAuthoritySchema>;

export const ROLE_AUTHORITY: Record<RoleKind, RoleAuthority> = {
  planner: { canPropose: true, canReview: false, canRequestPause: false, canPause: false, canStop: false, canExpandScope: false, canDispatchIntent: false },
  reviewer: { canPropose: false, canReview: true, canRequestPause: false, canPause: false, canStop: false, canExpandScope: false, canDispatchIntent: false },
  // 辅助者：有 pause 权（保活层安全动作），无 stop/resume/扩 scope/派单。
  assistant: { canPropose: false, canReview: false, canRequestPause: true, canPause: true, canStop: false, canExpandScope: false, canDispatchIntent: false },
  executor: { canPropose: true, canReview: false, canRequestPause: false, canPause: false, canStop: false, canExpandScope: false, canDispatchIntent: true },
};

export type RoleAction = "propose" | "review" | "request-pause" | "pause" | "stop" | "expand-scope" | "dispatch-intent";

export function enforceRoleAction(role: RoleKind, action: RoleAction): { allowed: boolean; reason: string | null } {
  const authority = ROLE_AUTHORITY[role];
  const map: Record<RoleAction, keyof RoleAuthority> = {
    propose: "canPropose",
    review: "canReview",
    "request-pause": "canRequestPause",
    pause: "canPause",
    stop: "canStop",
    "expand-scope": "canExpandScope",
    "dispatch-intent": "canDispatchIntent",
  };
  const key = map[action];
  return authority[key]
    ? { allowed: true, reason: null }
    : { allowed: false, reason: `role ${role} 无 ${action} 权限` };
}

export const RoleWorkItemSchema = z.object({
  id: z.string().uuid(),
  taskId: z.string().uuid(),
  engagementId: z.string().min(1),
  role: RoleKindSchema,
  kind: z.enum(["plan", "review", "incident"]),
  status: z.enum(["queued", "running", "succeeded", "failed", "blocked"]),
  input: z.record(z.string(), z.unknown()).default({}),
  output: z
    .object({
      summary: z.string().default(""),
      proposals: z.array(z.object({ title: z.string(), basis: z.string(), intentHint: z.string().nullable().default(null) })).default([]),
      opinions: z.array(z.object({ claim: z.string(), basis: z.string(), verdict: z.enum(["support", "challenge", "needs-evidence"]) })).default([]),
      pauseRequested: z.boolean().default(false),
      pauseReason: z.string().nullable().default(null),
    })
    .nullable()
    .default(null),
  authority: RoleAuthoritySchema,
  modelRoute: z.object({
    provider: z.enum(["simulated", "configured"]),
    model: z.string().nullable().default(null),
    note: z.string().default(""),
  }),
  cost: z.object({
    tokens: z.number().int().nonnegative().nullable().default(null),
    billing: z.enum(["none", "usage-only", "billed"]).default("none"),
  }),
  /** 与单模型基线对照的口径说明；真实表现未验证时写清楚。 */
  baseline: z.enum(["single-model", "not-run"]).default("single-model"),
  authenticity: z.enum(["simulated", "real-provider"]).default("simulated"),
  createdAt: z.string().datetime(),
  finishedAt: z.string().datetime().nullable().default(null),
});
export type RoleWorkItem = z.infer<typeof RoleWorkItemSchema>;

export const RunRoleWorkSchema = z.object({
  role: RoleKindSchema,
  kind: z.enum(["plan", "review", "incident"]),
  input: z.record(z.string(), z.unknown()).default({}),
  /** 模拟适配器使用的确定性输入（无真实模型调用）。 */
  simulated: z.boolean().default(true),
});

export const ProviderFaultSchema = z.enum(["rate-limit", "timeout", "insufficient-balance", "egress-denied"]);
export type ProviderFault = z.infer<typeof ProviderFaultSchema>;

export const ProviderPolicySchema = z.object({
  providers: z.array(
    z.object({
      name: z.string().min(1),
      priority: z.number().int().nonnegative(),
      allowedDataClasses: z.array(z.string()).default([]),
    }),
  ).min(1),
  engagementId: z.string().min(1),
  materialDataClass: z.string().default("customer-material"),
});
export type ProviderPolicy = z.infer<typeof ProviderPolicySchema>;

export type ProviderAttemptPlan = {
  action: "retry" | "failover" | "blocked";
  backoffMs: number | null;
  nextProvider: string | null;
  reason: string;
  /** 切换供应商是否满足本委托的数据外发约定。 */
  egressAllowed: boolean;
  costVisible: boolean;
  billing: "none" | "usage-only" | "billed";
};

/**
 * 故障处置：429/超时退避重试；余额不足直接切换；外发受限**禁止**切换
 * （否则等于绕过委托的数据外发约定），只能 blocked 等人。
 */
export function planProviderAttempt(input: {
  policy: ProviderPolicy;
  provider: string;
  fault: ProviderFault;
  attempt: number;
  billing?: "none" | "usage-only" | "billed";
}): ProviderAttemptPlan {
  const billing = input.billing ?? "none";
  const candidates = [...input.policy.providers]
    .filter((entry) => entry.name !== input.provider)
    .sort((a, b) => a.priority - b.priority);
  const eligible = candidates.find((entry) =>
    entry.allowedDataClasses.includes(input.policy.materialDataClass),
  );
  const egressAllowed = Boolean(eligible);
  const base = { egressAllowed, costVisible: billing !== "none", billing };
  switch (input.fault) {
    case "rate-limit":
      if (input.attempt < 2) {
        return { ...base, action: "retry", backoffMs: 500 * 2 ** input.attempt, nextProvider: null, reason: "429-backoff" };
      }
      return eligible
        ? { ...base, action: "failover", backoffMs: null, nextProvider: eligible.name, reason: "429-exhausted" }
        : { ...base, action: "blocked", backoffMs: null, nextProvider: null, reason: "egress-policy-denied-for-failover" };
    case "timeout":
      if (input.attempt < 1) {
        return { ...base, action: "retry", backoffMs: 1000, nextProvider: null, reason: "timeout-retry" };
      }
      return eligible
        ? { ...base, action: "failover", backoffMs: null, nextProvider: eligible.name, reason: "timeout-failover" }
        : { ...base, action: "blocked", backoffMs: null, nextProvider: null, reason: "egress-policy-denied-for-failover" };
    case "insufficient-balance":
      return eligible
        ? { ...base, action: "failover", backoffMs: null, nextProvider: eligible.name, reason: "quota-exhausted" }
        : { ...base, action: "blocked", backoffMs: null, nextProvider: null, reason: "no-eligible-provider" };
    case "egress-denied":
      // 当前 provider 本身无权接收该材料：不得切换成另一个（同样未获准的）通道。
      return { ...base, action: "blocked", backoffMs: null, nextProvider: null, reason: "egress-policy-denied" };
  }
}

export const ProviderAttemptSchema = z.object({
  id: z.string().uuid(),
  taskId: z.string().uuid(),
  engagementId: z.string().min(1),
  provider: z.string().min(1),
  fault: ProviderFaultSchema.nullable().default(null),
  attempt: z.number().int().nonnegative(),
  action: z.enum(["succeeded", "retry", "failover", "blocked"]),
  nextProvider: z.string().nullable().default(null),
  backoffMs: z.number().int().nonnegative().nullable().default(null),
  reason: z.string().default(""),
  egressAllowed: z.boolean().default(false),
  billing: z.enum(["none", "usage-only", "billed"]).default("none"),
  tokens: z.number().int().nonnegative().nullable().default(null),
  duplicateAccounting: z.boolean().default(false),
  at: z.string().datetime(),
});
export type ProviderAttempt = z.infer<typeof ProviderAttemptSchema>;

export function noProgressAlarm(input: {
  toolCallsSinceFact: number;
  threshold: number;
  waitingOnConsult: boolean;
}): { alarm: boolean; reason: string | null } {
  if (input.waitingOnConsult) return { alarm: false, reason: null };
  if (input.toolCallsSinceFact >= input.threshold) {
    return { alarm: true, reason: `no-new-fact-after-${input.toolCallsSinceFact}-tool-calls` };
  }
  return { alarm: false, reason: null };
}

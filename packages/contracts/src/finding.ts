import { z } from "zod";
import { JobStatusSchema } from "./ops.js";
import { matchTarget, normalizeTargetPattern } from "./scope.js";

/**
 * P6-E1 — Finding 一等公民：漏洞是图对象，不是聊天叙述。
 * tentative 线索不得进交付；verified 必须带 repro + 封存证据。
 */
export const FindingSeveritySchema = z.enum([
  "info",
  "low",
  "medium",
  "high",
  "critical",
]);
export type FindingSeverity = z.infer<typeof FindingSeveritySchema>;

export const FINDING_SEVERITY_RANK: Record<FindingSeverity, number> = {
  info: 0,
  low: 1,
  medium: 2,
  high: 3,
  critical: 4,
};

export const FindingStatusSchema = z.enum([
  "tentative",
  "verified",
  "retested",
  "accepted",
  "retracted",
]);
export type FindingStatus = z.infer<typeof FindingStatusSchema>;

/** Evidence qualification recorded independently of the finding lifecycle. */
export const FindingQualificationSchema = z.enum(["exploited", "confirmed", "unconfirmed"]);
export type FindingQualification = z.infer<typeof FindingQualificationSchema>;

/** One-way lifecycle; retracted is terminal and rows are never deleted. */
const FINDING_STATUS_ORDER: FindingStatus[] = [
  "tentative",
  "verified",
  "retested",
  "accepted",
];

export function findingStatusAllows(
  from: FindingStatus,
  to: FindingStatus,
): boolean {
  if (to === "retracted") return from !== "retracted";
  const i = FINDING_STATUS_ORDER.indexOf(from);
  const j = FINDING_STATUS_ORDER.indexOf(to);
  return i >= 0 && j > i;
}

export const FindingConfidenceSchema = z.enum(["tentative", "firm"]);
export type FindingConfidence = z.infer<typeof FindingConfidenceSchema>;

/** P13-A3 / P14-B1 — what a piece of evidence is for. Missing = proof (legacy). */
export const EvidenceRoleSchema = z.enum(["baseline", "proof", "verification", "supporting"]);
export type EvidenceRole = z.infer<typeof EvidenceRoleSchema>;

export const FindingEvidenceSchema = z.object({
  /** File path under evidence/, or a ref: `http:<id>` / `oast:<token>` / `tool:<id>`. */
  path: z.string().min(1),
  /** Content hash; refs are resolved to the underlying transaction/hit/artifact at verify time. */
  sha256: z.string().length(64),
  role: EvidenceRoleSchema.optional(),
  note: z.string().optional(),
  version: z.number().int().positive().optional(),
});

export const FindingSchema = z.object({
  id: z.string().uuid(),
  taskId: z.string().uuid(),
  title: z.string().min(1),
  /** Normalized asset address (scope.normalizeHost). */
  asset: z.string().min(1),
  /** CWE-89 / CWE-79 / AUTHZ-BOLA … */
  vulnClass: z.string().min(1),
  severity: FindingSeveritySchema,
  /** CVSS 3.1 vector 原文；不自动算分当真相。 */
  cvss: z.string().nullable().default(null),
  confidence: FindingConfidenceSchema,
  status: FindingStatusSchema,
  /** scheme://host:port/path?param */
  endpoint: z.string().nullable().default(null),
  /** asset|vulnClass|endpoint — dedup idempotency key. */
  dedupKey: z.string().min(1),
  intentId: z.string().uuid().nullable().default(null),
  factIds: z.array(z.string()).default([]),
  evidence: z.array(FindingEvidenceSchema).default([]),
  repro: z.string().default(""),
  impact: z.string().default(""),
  fix: z.string().default(""),
  createdAt: z.string().datetime(),
  verifiedAt: z.string().datetime().nullable().default(null),
  /** P15-C1 — worker/operator that moved tentative → verified. */
  verifiedBy: z.string().nullable().default(null),
  rootCause: z.string().optional(),
  /** Existing evidence excerpt for human readers of the report. */
  pocCurl: z.string().optional(),
  trafficIds: z.array(z.string().uuid()).optional(),
  qualification: FindingQualificationSchema.optional(),
});
export type Finding = z.infer<typeof FindingSchema>;
export const FindingRecordSchema = FindingSchema;
export type FindingRecord = Finding;

/**
 * P15-C1 — Finder ≠ Validator.
 *
 * A validation is an append-only opinion about an already-verified finding:
 * - `confirmed`     independent replay/control shows the conclusion stands;
 * - `refuted`       the evidence does not support the conclusion;
 * - `inconclusive`  target/evidence unavailable; neither confirms nor refutes;
 * - `out-of-scope`  reproduction would require exceeding the original authorization.
 *
 * `validator` must differ from `Finding.verifiedBy`; the history layer rejects
 * self-validation. `independent` is derived by the store, not trusted from input.
 */
export const FindingValidationVerdictSchema = z.enum([
  "confirmed",
  "refuted",
  "inconclusive",
  "out-of-scope",
]);
export type FindingValidationVerdict = z.infer<typeof FindingValidationVerdictSchema>;

export const FindingValidationMethodSchema = z.enum([
  "evidence-only",
  "replay",
  "control-compare",
  "manual",
]);
export type FindingValidationMethod = z.infer<typeof FindingValidationMethodSchema>;

export const FindingValidationSchema = z.object({
  id: z.string().uuid(),
  taskId: z.string().uuid(),
  findingId: z.string().uuid(),
  verdict: FindingValidationVerdictSchema,
  method: FindingValidationMethodSchema,
  evidence: z.array(FindingEvidenceSchema).default([]),
  note: z.string().default(""),
  /** Worker id, `operator:<name>`, or external reviewer identity. */
  validator: z.string().min(1),
  /** Derived: validator !== finding.verifiedBy. */
  independent: z.boolean(),
  createdAt: z.string().datetime(),
});
export type FindingValidation = z.infer<typeof FindingValidationSchema>;

export const FindingValidationDraftSchema = z.object({
  verdict: FindingValidationVerdictSchema,
  method: FindingValidationMethodSchema,
  /** Evidence files / refs; confirmed/refuted require at least one. */
  evidencePaths: z.array(z.string()).default([]),
  note: z.string().default(""),
  validator: z.string().min(1),
});
export type FindingValidationDraft = z.infer<typeof FindingValidationDraftSchema>;

/** Requests independent review of a finding's archived evidence. */
export const FindingValidateRunRequestSchema = z.strictObject({
  findingId: z.string().uuid(),
  /** Re-review the archived evidence even when a prior review exists. */
  force: z.boolean().optional(),
});
export type FindingValidateRunRequest = z.infer<typeof FindingValidateRunRequestSchema>;

export const FindingValidateRunResponseSchema = z.object({
  jobId: z.string().uuid(),
  status: JobStatusSchema,
  validationId: z.string().uuid().optional(),
});
export type FindingValidateRunResponse = z.infer<typeof FindingValidateRunResponseSchema>;

/**
 * Goal 级 finding 闸：assert_goal 时按 findings 表实测。
 * 只有 verified/retested 计数；minSeverity / vulnClasses 进一步收窄。
 *
 * `scope` 决定"谁的发现能替这个目标作证"：
 * - `goal`（默认）：只计目标声明资产（gate.assets ?? goal.assets）上的发现；
 *   未声明资产时拒绝断言，而不是悄悄退化为全任务累计。
 * - `task`：显式声明"本目标统计整个委托的发现"（汇总目标）。
 */
export const FindingsGateSchema = z.object({
  minVerified: z.number().int().min(1),
  minSeverity: FindingSeveritySchema.optional(),
  vulnClasses: z.array(z.string().min(1)).optional(),
  scope: z.enum(["goal", "task"]).default("goal"),
  /** Explicit asset set for a goal-scoped gate; overrides goal.assets. */
  assets: z.array(z.string().min(1)).optional(),
  /** P15-C1 — every supporting finding needs a `confirmed` independent validation. */
  requireIndependent: z.boolean().optional(),
});
export type FindingsGate = z.infer<typeof FindingsGateSchema>;

/** Pure predicate over one finding; asset scope is applied by the caller. */
export function findingSatisfiesGate(
  finding: Pick<Finding, "status" | "severity" | "vulnClass">,
  gate: FindingsGate,
): boolean {
  // accepted = 客户风险处置后的结论，仍是已验证证据；不能因为处置动作
  // 让历史目标失去依据。
  if (
    finding.status !== "verified" &&
    finding.status !== "retested" &&
    finding.status !== "accepted"
  ) {
    return false;
  }
  if (
    gate.minSeverity &&
    FINDING_SEVERITY_RANK[finding.severity] <
      FINDING_SEVERITY_RANK[gate.minSeverity]
  ) {
    return false;
  }
  if (gate.vulnClasses?.length && !gate.vulnClasses.includes(finding.vulnClass)) {
    return false;
  }
  return true;
}

/**
 * Assets accountable for a goal-scoped findings gate.
 * Returns `null` for an explicitly task-scoped gate. Throws when a goal-scoped
 * gate declares no assets at all: silently counting the whole task is exactly
 * the A1 bug (甲资产的发现替乙的专项目标通过).
 */
export function resolveGateAssets(
  gate: FindingsGate,
  goalAssets?: string[] | null,
): string[] | null {
  if (gate.scope === "task") return null;
  const declared = gate.assets?.length ? gate.assets : goalAssets ?? [];
  const normalized = [...new Set(declared.map((a) => normalizeTargetPattern(a)).filter(Boolean))];
  if (!normalized.length) {
    throw new Error(
      "goal-scoped findings gate requires goal.assets or findingsGate.assets; " +
        "use findingsGate.scope:\"task\" for an explicit engagement-wide aggregate",
    );
  }
  if (normalized.includes("*")) {
    throw new Error(
      "goal-scoped findings gate must declare concrete assets; " +
        "assets:[\"*\"] equals a task-wide aggregate and requires scope:\"task\"",
    );
  }
  return normalized;
}

/** True when a finding's asset is covered by the goal's declared assets. */
export function findingAssetInScope(asset: string, assets: string[]): boolean {
  if (!assets.length) return false;
  return matchTarget(assets, asset).ok;
}

/** Default dedup key when the caller does not supply one. */
export function findingDedupKey(input: {
  asset: string;
  vulnClass: string;
  endpoint?: string | null;
}): string {
  return [
    input.asset.trim().toLowerCase(),
    input.vulnClass.trim().toLowerCase(),
    (input.endpoint ?? "").trim().toLowerCase(),
  ].join("|");
}
/**
 * P14-B6 — remediation retest verdict. Only `fixed` moves the finding forward;
 * one failed request never proves a fix.
 */
export const RetestVerdictSchema = z.enum(["reproduced", "fixed", "inconclusive"]);
export type RetestVerdict = z.infer<typeof RetestVerdictSchema>;

export const FindingRetestSchema = z.object({
  id: z.string().uuid(),
  taskId: z.string().uuid(),
  findingId: z.string().uuid(),
  verdict: RetestVerdictSchema,
  evidence: z.array(FindingEvidenceSchema).default([]),
  repro: z.string().default(""),
  note: z.string().default(""),
  reviewer: z.string().min(1),
  createdAt: z.string().datetime(),
});
export type FindingRetest = z.infer<typeof FindingRetestSchema>;

import { createHash } from "node:crypto";
import type { CoverageStatus, FindingStatus, GoalState } from "@gongyuai/contracts";
import { FINDING_SEVERITY_RANK, findingAssetInScope, findingSatisfiesGate } from "@gongyuai/contracts";

/**
 * F1 / A4 / A5 — 交付记分卡与可复算快照。
 *
 * 两个数必须分开报：
 * - 曾通过目标数（历史，append-only 的首次通过记录）
 * - 当前证据足以支持的目标数（今天重新核对）
 *
 * 快照是不可变 JSON；`scorecardFromSnapshot` 只读输入、纯函数，任何人拿到
 * 同一份快照都能复算出同样的分子/分母（A5）。旧档缺归属时分子单列
 * `unknownAttribution`，不猜、不补（A4）。
 */

export type SnapshotGoal = Pick<
  GoalState,
  "id" | "title" | "passes" | "evidencePatterns" | "evidencePaths" | "assertedAt"
> & {
  assets?: string[];
  evidenceChecks?: Array<{ pattern: string; field: string; equals: string | number | boolean }>;
  findingsGate?: GoalState["findingsGate"];
  reconcileGate?: GoalState["reconcileGate"];
  boardGate?: GoalState["boardGate"];
};

export type SnapshotFinding = {
  id: string;
  title: string;
  asset: string;
  vulnClass: string;
  severity: keyof typeof FINDING_SEVERITY_RANK;
  status: string;
  evidence: Array<{ path: string; sha256: string }>;
};

export type SnapshotGoalFinding = {
  goalId: string;
  findingId: string;
  statusAtAssert: string;
  evidence: Array<{ path: string; sha256: string }>;
  createdAt: string;
};

export type SnapshotProof = { goalId: string; path: string; sha256: string };

export type SnapshotCoverage = {
  goalId: string;
  status: CoverageStatus;
  reviewer: string;
  reason: string;
  evidencePath?: string;
  sha256?: string;
  createdAt: string;
};

export type DeliverySnapshot = {
  version: 1;
  taskId: string;
  capturedAt: string;
  goals: SnapshotGoal[];
  proofs: SnapshotProof[];
  goalFindings: SnapshotGoalFinding[];
  findings: SnapshotFinding[];
  coverage: SnapshotCoverage[];
  /** sha256 of the canonical payload (all fields above except this one). */
  sha256?: string;
};

export type GoalVerdict =
  | "supported"
  | "unsupported-no-evidence"
  | "supported-by-retracted-only"
  | "unknown-attribution"
  | "not-passed";

export type ScorecardGoal = {
  goalId: string;
  title: string;
  historicalPass: boolean;
  currentSupported: boolean;
  verdict: GoalVerdict;
  proofCount: number;
  supportFindingIds: string[];
  retractedSupportFindingIds: string[];
  /**
   * 人工登记的最新覆盖意见。`unregistered` = 从未登记任何覆盖意见——附件在
   * 也不代表覆盖已知。登记为未测（untested）与从未登记是两件事。
   */
  coverage: CoverageStatus | "unregistered";
  missingAttribution: boolean;
};

export type CoverageCounts = {
  tested: number;
  partial: number;
  blocked: number;
  untested: number;
  /** 从未登记覆盖意见的目标（附件存在也算未登记）。 */
  unregistered: number;
};

export type Scorecard = {
  taskId: string;
  /** 采集时点：同一快照永远是同一个时点；不同请求的快照不保证相同。 */
  capturedAt: string;
  snapshotSha256: string;
  /** 共同分母：本次约定目标总数。 */
  denominator: number;
  totalGoals: number;
  /** denominator 为 0 → 不适用 */
  applicable: boolean;
  /** 历史通过数（分子），分母为 denominator。 */
  historicallyPassed: number;
  /** 当前证据足以支持数（分子），分母为 denominator。 */
  currentlySupported: number;
  /** 原依据归属未知（分子），分母为 denominator。 */
  unknownAttribution: number;
  /** 当前被撤回依据引用的数量（不是目标数）。 */
  retractedReferences: number;
  /** 人工覆盖：六类互斥，合计等于 denominator。 */
  /** 人工覆盖：五类互斥，合计等于 denominator。 */
  coverage: CoverageCounts;
  findings: { verified: number; tentative: number; retracted: number; other: number };
  goals: ScorecardGoal[];
};

const LIVE_FINDING_STATUSES = new Set(["verified", "retested", "accepted"]);

function canonical(snapshot: DeliverySnapshot): string {
  const { sha256: _ignored, ...payload } = snapshot;
  return JSON.stringify(payload);
}

export function snapshotSha256(snapshot: DeliverySnapshot): string {
  return createHash("sha256").update(canonical(snapshot)).digest("hex");
}

export function finalizeSnapshot(snapshot: DeliverySnapshot): DeliverySnapshot {
  return { ...snapshot, sha256: snapshotSha256(snapshot) };
}

/**
 * Pure recomputation. No DB, no clock, no file IO: identical input → identical
 * numerators/denominators.
 */
export function computeScorecard(snapshot: DeliverySnapshot): Scorecard {
  const findings = new Map(snapshot.findings.map((f) => [f.id, f]));
  // Snapshot coverage is row-ordered: the last entry per goal is the current one.
  const coverage = new Map<string, CoverageStatus>();
  for (const entry of snapshot.coverage) coverage.set(entry.goalId, entry.status);
  const counts: CoverageCounts = {
    untested: 0, partial: 0, tested: 0, blocked: 0, unregistered: 0,
  };
  const findingCounts = { verified: 0, tentative: 0, retracted: 0, other: 0 };
  for (const finding of snapshot.findings) {
    if (finding.status === "verified" || finding.status === "retested" || finding.status === "accepted") {
      findingCounts.verified += 1;
    } else if (finding.status === "tentative") findingCounts.tentative += 1;
    else if (finding.status === "retracted") findingCounts.retracted += 1;
    else findingCounts.other += 1;
  }

  const goals: ScorecardGoal[] = snapshot.goals.map((goal) => {
    const supports = snapshot.goalFindings.filter((s) => s.goalId === goal.id);
    const proofs = snapshot.proofs.filter((p) => p.goalId === goal.id);
    const registered = coverage.get(goal.id);
    const coverageStatus: CoverageStatus | "unregistered" = registered ?? "unregistered";
    if (registered) counts[registered] += 1;
    else counts.unregistered += 1;

    const supportFindingIds: string[] = [];
    const retractedSupportFindingIds: string[] = [];
    let liveThatStillSatisfy = 0;
    for (const support of supports) {
      const finding = findings.get(support.findingId);
      supportFindingIds.push(support.findingId);
      const statusNow = finding?.status ?? support.statusAtAssert;
      if (statusNow === "retracted") {
        retractedSupportFindingIds.push(support.findingId);
        continue;
      }
      const declaredAssets = goal.findingsGate && goal.findingsGate.scope !== "task"
        ? (goal.findingsGate.assets?.length ? goal.findingsGate.assets : goal.assets ?? [])
        : null;
      const assetStillInScope = !declaredAssets || findingAssetInScope(finding?.asset ?? "", declaredAssets);
      if (finding && assetStillInScope && LIVE_FINDING_STATUSES.has(finding.status) &&
          (!goal.findingsGate ||
            findingSatisfiesGate(
              { status: finding.status as FindingStatus, severity: finding.severity, vulnClass: finding.vulnClass },
              goal.findingsGate,
            ))) {
        liveThatStillSatisfy += 1;
      }
    }

    let verdict: GoalVerdict;
    let currentSupported: boolean;
    const missingAttribution = goal.passes && supports.length === 0 && proofs.length === 0;
    if (!goal.passes) {
      verdict = "not-passed";
      currentSupported = false;
    } else if (goal.findingsGate) {
      const enough = liveThatStillSatisfy >= goal.findingsGate.minVerified;
      if (enough) {
        verdict = "supported";
        currentSupported = true;
      } else if (supports.length && liveThatStillSatisfy === 0) {
        verdict = "supported-by-retracted-only";
        currentSupported = false;
      } else {
        verdict = "unsupported-no-evidence";
        currentSupported = false;
      }
    } else if (missingAttribution) {
      // A4: a legacy pass with no sealed proof and no finding attribution keeps
      // its historical result, but it is *not* counted as currently supported:
      // there is no re-computable basis for "today".
      verdict = "unknown-attribution";
      currentSupported = false;
    } else {
      verdict = "supported";
      currentSupported = true;
    }

    return {
      goalId: goal.id,
      title: goal.title,
      historicalPass: goal.passes,
      currentSupported,
      verdict,
      proofCount: proofs.length,
      supportFindingIds,
      retractedSupportFindingIds,
      coverage: coverageStatus,
      missingAttribution,
    };
  });

  const historicallyPassed = goals.filter((g) => g.historicalPass).length;
  return {
    taskId: snapshot.taskId,
    capturedAt: snapshot.capturedAt,
    snapshotSha256: snapshot.sha256 ?? snapshotSha256(snapshot),
    denominator: goals.length,
    totalGoals: goals.length,
    applicable: goals.length > 0,
    historicallyPassed,
    currentlySupported: goals.filter((g) => g.currentSupported).length,
    unknownAttribution: goals.filter((g) => g.missingAttribution).length,
    retractedReferences: goals.reduce((n, g) => n + g.retractedSupportFindingIds.length, 0),
    coverage: counts,
    findings: findingCounts,
    goals,
  };
}

/** Recompute from a snapshot file's parsed JSON, optionally verifying its seal. */
export function scorecardFromSnapshot(
  parsed: unknown,
): { ok: true; scorecard: Scorecard; sealValid: boolean } | { ok: false; reason: string } {
  if (!parsed || typeof parsed !== "object") return { ok: false, reason: "快照不是对象" };
  const snapshot = parsed as DeliverySnapshot;
  if (snapshot.version !== 1) return { ok: false, reason: `未知快照版本 ${String(snapshot.version)}` };
  if (!Array.isArray(snapshot.goals)) return { ok: false, reason: "快照缺少 goals" };
  const sealValid = snapshot.sha256 ? snapshot.sha256 === snapshotSha256(snapshot) : false;
  return { ok: true, scorecard: computeScorecard(snapshot), sealValid };
}

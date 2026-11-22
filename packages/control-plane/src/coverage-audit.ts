import { createHash } from "node:crypto";
import { CoverageReferenceSchema, CoverageSnapshotSchema, type CoverageSnapshot, type CoverageReview } from "@gongyuai/contracts";
import { openHistory } from "@gongyuai/history";
import { taskDataDir, taskPaths } from "./paths.js";

export function coverageDigest(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function captureCoverage(dataRoot: string, taskId: string): CoverageSnapshot {
  // Task IDs become directory names. Validate before resolving a path or opening SQLite.
  CoverageSnapshotSchema.shape.taskId.parse(taskId);
  const paths = taskPaths(taskDataDir(dataRoot, taskId));
  const history = openHistory({ dbPath: paths.historyDb, evidenceDir: paths.evidenceDir, readOnly: true });
  try {
    return history.withReportTransaction(() => {
      const goals = history.listGoals(taskId);
      if (!goals.length) throw new Error("History 中没有该任务的目标记录");
      const latest = new Map(history.listCoverage(taskId).map((r) => [r.goalId, r]));
      const verified = new Map<string, "missing" | "invalid" | "verified">();
      function check(review?: CoverageReview) {
        const sha = review?.sha256;
        if (!sha) {
          const needsProof = review?.evidencePath || review?.status === "tested" || review?.status === "partial";
          return needsProof ? "missing" : "none";
        }
        const cached = verified.get(sha);
        if (cached) return cached;
        const original = history.readProofVersion(taskId, sha);
        const result = !original ? "missing" : coverageDigest(original) === sha ? "verified" : "invalid";
        verified.set(sha, result);
        return result;
      }
      return CoverageSnapshotSchema.parse({
        version: 1, taskId, capturedAt: new Date().toISOString(),
        goals: goals.map((g) => {
          const review = latest.get(g.id);
          return { goalId: g.id, status: review?.status ?? "unknown", proof: check(review), sha256: review?.sha256 ?? null };
        }),
      });
    });
  } finally {
    history.close();
  }
}

export function compareCoverage(snapshotBytes: Buffer, referenceBytes: Buffer, pins: { snapshot: string; reference: string }) {
  const snapshotSha256 = coverageDigest(snapshotBytes);
  const referenceSha256 = coverageDigest(referenceBytes);
  if (snapshotSha256 !== pins.snapshot.toLowerCase()) throw new Error("快照 SHA-256 不符");
  if (referenceSha256 !== pins.reference.toLowerCase()) throw new Error("人工底稿 SHA-256 不符");
  const snapshot = CoverageSnapshotSchema.parse(JSON.parse(snapshotBytes.toString("utf8")));
  const reference = CoverageReferenceSchema.parse(JSON.parse(referenceBytes.toString("utf8")));
  if (snapshot.taskId !== reference.taskId) throw new Error("快照与人工底稿的任务 ID 不同");

  const remaining = new Map(snapshot.goals.map((g) => [g.goalId, g]));
  const extent = { tested: 2, partial: 1, untested: 0, blocked: 0 } as const;
  const goals = reference.goals.map((expected) => {
    const actual = remaining.get(expected.goalId);
    remaining.delete(expected.goalId);
    let agreement: string;
    if (!actual) agreement = "missing-goal";
    else if (actual.status === "unknown") agreement = "unknown";
    else if (actual.status === expected.status) agreement = "match";
    else if (extent[actual.status] > extent[expected.status]) agreement = "overstated";
    else if (extent[actual.status] < extent[expected.status]) agreement = "understated";
    else agreement = "different-status"; // A blocked goal and an untested goal are distinct.

    const proof = actual?.proof ?? "none";
    const sourceMatches = expected.evidenceSha256 ? expected.evidenceSha256 === actual?.sha256 : null;
    const evidenceOK = proof !== "invalid" && proof !== "missing" && sourceMatches !== false;
    return { goalId: expected.goalId, expected: expected.status, actual: actual?.status ?? null,
      agreement, proof, sha256: actual?.sha256 ?? null, expectedSha256: expected.evidenceSha256 ?? null,
      sourceMatches, accepted: agreement === "match" && evidenceOK };
  });
  const acceptedGoals = goals.filter((goal) => goal.accepted).length;
  return {
    version: 1, taskId: snapshot.taskId, split: reference.split, capturedAt: snapshot.capturedAt,
    snapshotSha256, referenceSha256, referenceGoals: goals.length,
    matchingStatuses: goals.filter((goal) => goal.agreement === "match").length,
    overstatedGoals: goals.filter((goal) => goal.agreement === "overstated").length,
    unknownGoals: goals.filter((goal) => goal.agreement === "unknown").length,
    acceptedGoals, wholeTaskMatch: acceptedGoals === goals.length && remaining.size === 0,
    goals, unexpectedGoalIds: [...remaining.keys()],
  };
}

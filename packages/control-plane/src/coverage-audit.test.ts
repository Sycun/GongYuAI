import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { goalsFromSpecs, type CoverageReviewInput } from "@gongyuai/contracts";
import { openHistory, writeEvidenceFile } from "@gongyuai/history";
import { captureCoverage, compareCoverage, coverageDigest } from "./coverage-audit.js";
import { taskDataDir, taskPaths } from "./paths.js";

const taskId = "90ae45d3-6406-4860-a494-395dcdac3007";
const json = (value: unknown) => Buffer.from(JSON.stringify(value));
const compare = (snapshot: unknown, reference: unknown) => {
  const snap = json(snapshot);
  const ref = json(reference);
  return compareCoverage(snap, ref, { snapshot: coverageDigest(snap), reference: coverageDigest(ref) });
};
const reference = (goals: object[]) => ({ version: 1, taskId, split: "development", goals });

test("handoff freezes coverage and source bytes; later reviews cannot repair the old handoff", (t) => {
  const root = mkdtempSync(join(tmpdir(), "gy-coverage-audit-"));
  const paths = taskPaths(taskDataDir(root, taskId));
  const h = openHistory({ dbPath: paths.historyDb, evidenceDir: paths.evidenceDir });
  t.after(() => { h.close(); rmSync(root, { recursive: true, force: true }); });
  const ids = ["inventory", "archive", "approval", "unreviewed"];
  h.seedGoals(taskId, goalsFromSpecs(ids.map((id) => ({ id, title: id, description: id, evidencePatterns: ["receipt.txt"] }))));
  const record = (goalId: string, status: CoverageReviewInput["status"]) => h.recordCoverage(taskId, {
    goalId, status, reason: "独立核对原始档案", reviewer: "档案员", evidencePath: "receipt.txt",
  });
  writeEvidenceFile(paths.evidenceDir, "receipt.txt", "original");
  for (const goal of ["inventory", "archive", "approval"]) record(goal, "tested");
  // Goal acceptance and the number of files must not fill in an absent operator assessment.
  assert.equal(h.assertGoal(taskId, "unreviewed", ["receipt.txt"]).ok, true);
  const sha = coverageDigest(Buffer.from("original"));
  const baseline = reference([
    { goalId: "inventory", status: "tested", evidenceSha256: sha },
    { goalId: "archive", status: "tested" },
    { goalId: "approval", status: "blocked" },
    { goalId: "unreviewed", status: "untested" },
  ]);
  writeEvidenceFile(paths.evidenceDir, "receipt.txt", "new working copy");
  const handoff = captureCoverage(root, taskId);
  const result = compare(handoff, baseline);
  assert.equal(result.acceptedGoals, 2);
  assert.equal(result.overstatedGoals, 1);
  assert.equal(result.unknownGoals, 1);
  assert.equal(result.wholeTaskMatch, false);
  assert.deepEqual(result.goals.map((g) => g.agreement), ["match", "match", "overstated", "unknown"]);
  assert.equal(result.goals[0]!.sha256, sha);

  record("approval", "blocked");
  record("unreviewed", "untested");
  assert.equal(compare(captureCoverage(root, taskId), baseline).wholeTaskMatch, true);
  assert.deepEqual(compare(handoff, baseline), result);

  // Keep the advertised digest and replace just its archived bytes in this fixture.
  const db = new DatabaseSync(paths.historyDb);
  try { db.prepare("UPDATE evidence_versions SET content = ? WHERE sha256 = ?").run(Buffer.from("damaged"), sha); }
  finally { db.close(); }
  const damaged = compare(captureCoverage(root, taskId), baseline);
  assert.equal(damaged.matchingStatuses, 4);
  assert.equal(damaged.acceptedGoals, 2);
  assert.equal(damaged.goals[0]!.proof, "invalid");
  assert.equal(damaged.wholeTaskMatch, false);
});

test("scoring retains missing and extra goals, and distinguishes type of disagreement", () => {
  const sha = "a".repeat(64);
  const snapshot = { version: 1, taskId, capturedAt: "2026-01-01T00:00:00.000Z", goals: [
    { goalId: "match", status: "tested", proof: "verified", sha256: sha },
    { goalId: "under", status: "partial", proof: "verified", sha256: sha },
    { goalId: "kind", status: "blocked", proof: "none", sha256: null },
    { goalId: "extra", status: "untested", proof: "none", sha256: null },
  ] };
  const baseline = reference([
    { goalId: "match", status: "tested", evidenceSha256: "b".repeat(64) },
    { goalId: "missing", status: "untested" },
    { goalId: "under", status: "tested" },
    { goalId: "kind", status: "untested" },
  ]);
  const report = compare(snapshot, baseline);
  assert.deepEqual(report.unexpectedGoalIds, ["extra"]);
  assert.equal(report.referenceGoals, 4);
  assert.equal(report.matchingStatuses, 1);
  assert.equal(report.goals[0]!.sourceMatches, false);
  assert.equal(report.acceptedGoals, 0);
  assert.deepEqual(report.goals.map((g) => g.agreement), ["match", "missing-goal", "understated", "different-status"]);
  const subset = reference([{ goalId: "match", status: "tested" }]);
  const extraOnly = compare(snapshot, subset);
  assert.equal(extraOnly.acceptedGoals, 1);
  assert.equal(extraOnly.wholeTaskMatch, false);
  assert.throws(() => compare(snapshot, { ...baseline, taskId: "11bba230-7ff0-4bad-ac84-77b8d3136019" }), /任务 ID/);
  assert.throws(() => compare(snapshot, reference([baseline.goals[0]!, baseline.goals[0]!])), /重复/);
  assert.throws(() => compare({ ...snapshot, goals: [snapshot.goals[0], snapshot.goals[0]] }, baseline), /重复/);
  const pins = { snapshot: coverageDigest(json(snapshot)), reference: coverageDigest(json(baseline)) };
  assert.throws(() => compareCoverage(json(snapshot), Buffer.concat([json(baseline), Buffer.from("\n")]), pins), /底稿 SHA/);
  assert.throws(() => compareCoverage(Buffer.concat([json(snapshot), Buffer.from("\n")]), json(baseline), pins), /快照 SHA/);
});

test("legacy passed goals without a coverage table stay unknown and the archive is not migrated", (t) => {
  const root = mkdtempSync(join(tmpdir(), "gy-legacy-coverage-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const paths = taskPaths(taskDataDir(root, taskId));
  const h = openHistory({ dbPath: paths.historyDb, evidenceDir: paths.evidenceDir });
  try {
    const goals = goalsFromSpecs([{ id: "legacy", title: "旧台账", description: "归档", evidencePatterns: ["receipt.txt"] }]);
    h.seedGoals(taskId, goals.map((g) => ({ ...g, passes: true })));
  } finally { h.close(); }
  const db = new DatabaseSync(paths.historyDb);
  try {
    db.exec("DROP TABLE coverage_reviews; DROP TABLE goal_checks");
    assert.deepEqual(captureCoverage(root, taskId).goals, [
      { goalId: "legacy", status: "unknown", proof: "none", sha256: null },
    ]);
    assert.equal(db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name = 'coverage_reviews'").get()?.n, 0);
  } finally { db.close(); }
});

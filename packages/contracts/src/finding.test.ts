import { test } from "node:test";
import assert from "node:assert/strict";
import {
  FINDING_SEVERITY_RANK,
  FindingSchema,
  FindingsGateSchema,
  GoalSpecSchema,
  findingDedupKey,
  findingSatisfiesGate,
  findingStatusAllows,
} from "./index.js";

test("FindingSchema fills defaults and keeps cvss vector as raw text", () => {
  const parsed = FindingSchema.parse({
    id: "0b9d6a5e-1111-4a2b-9c3d-000000000001",
    taskId: "0b9d6a5e-1111-4a2b-9c3d-000000000002",
    title: "SQLi in login",
    asset: "lab.example.com",
    vulnClass: "CWE-89",
    severity: "high",
    confidence: "tentative",
    status: "tentative",
    dedupKey: "lab.example.com|cwe-89|",
    createdAt: new Date().toISOString(),
  });
  assert.equal(parsed.cvss, null);
  assert.equal(parsed.endpoint, null);
  assert.deepEqual(parsed.evidence, []);
  assert.equal(parsed.repro, "");
  assert.equal(parsed.verifiedAt, null);
});

test("finding lifecycle is one-way and retracted is terminal", () => {
  assert.ok(findingStatusAllows("tentative", "verified"));
  assert.ok(findingStatusAllows("verified", "retested"));
  assert.ok(findingStatusAllows("retested", "accepted"));
  assert.ok(findingStatusAllows("tentative", "retracted"));
  assert.ok(findingStatusAllows("accepted", "retracted"));
  assert.ok(!findingStatusAllows("verified", "tentative"));
  assert.ok(!findingStatusAllows("retracted", "verified"));
  assert.ok(!findingStatusAllows("retracted", "retracted"));
  assert.ok(!findingStatusAllows("verified", "verified"));
});

test("findingsGate requires minVerified>=1 and filters by severity/class", () => {
  assert.ok(!FindingsGateSchema.safeParse({ minVerified: 0 }).success);
  const gate = FindingsGateSchema.parse({
    minVerified: 1,
    minSeverity: "high",
    vulnClasses: ["CWE-89"],
  });
  const base = { status: "verified" as const, severity: "high" as const, vulnClass: "CWE-89" };
  assert.ok(findingSatisfiesGate(base, gate));
  assert.ok(!findingSatisfiesGate({ ...base, status: "tentative" }, gate));
  assert.ok(!findingSatisfiesGate({ ...base, status: "retracted" }, gate));
  assert.ok(!findingSatisfiesGate({ ...base, severity: "medium" }, gate));
  assert.ok(!findingSatisfiesGate({ ...base, vulnClass: "CWE-79" }, gate));
  assert.ok(findingSatisfiesGate({ ...base, status: "retested" }, gate));
  assert.ok(
    findingSatisfiesGate(
      { status: "verified", severity: "low", vulnClass: "CWE-79" },
      { minVerified: 1, scope: "task" },
    ),
  );
});

test("severity rank orders info < low < medium < high < critical", () => {
  const ordered = ["info", "low", "medium", "high", "critical"] as const;
  for (let i = 1; i < ordered.length; i++) {
    assert.ok(
      FINDING_SEVERITY_RANK[ordered[i]!] > FINDING_SEVERITY_RANK[ordered[i - 1]!],
    );
  }
});

test("dedupKey normalizes case and joins asset|class|endpoint", () => {
  assert.equal(
    findingDedupKey({ asset: "LAB.example.com", vulnClass: "CWE-89", endpoint: "/Login" }),
    "lab.example.com|cwe-89|/login",
  );
  assert.equal(
    findingDedupKey({ asset: "a.com", vulnClass: "CWE-79" }),
    "a.com|cwe-79|",
  );
});

test("GoalSpec carries optional findingsGate", () => {
  const spec = GoalSpecSchema.parse({
    id: "g1",
    title: "t",
    description: "d",
    evidencePatterns: ["goals/*.md"],
    findingsGate: { minVerified: 2, minSeverity: "medium" },
  });
  assert.deepEqual(spec.findingsGate, { minVerified: 2, minSeverity: "medium", scope: "goal" });
  const bare = GoalSpecSchema.parse({
    id: "g2",
    title: "t",
    description: "d",
    evidencePatterns: ["x.txt"],
  });
  assert.equal(bare.findingsGate, undefined);
});
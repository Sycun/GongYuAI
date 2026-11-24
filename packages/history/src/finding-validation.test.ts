import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { openHistory } from "./index.js";

function setup(prefix: string) {
  const root = mkdtempSync(join(tmpdir(), prefix));
  const evidenceDir = join(root, "evidence");
  mkdirSync(evidenceDir, { recursive: true });
  const store = openHistory({ dbPath: join(root, "history.sqlite"), evidenceDir });
  return { root, evidenceDir, store };
}

function writeEvidence(evidenceDir: string, path: string, body: string) {
  mkdirSync(join(evidenceDir, path, ".."), { recursive: true });
  writeFileSync(join(evidenceDir, path), body);
}

function verified(store: ReturnType<typeof openHistory>, evidenceDir: string, taskId: string) {
  writeEvidence(evidenceDir, "finding/proof.txt", "GET /?id=1' HTTP/1.1\n200 error in SQL\n");
  const { finding } = store.recordFinding({
    taskId,
    title: "SQL injection in id parameter",
    asset: "lab.example.com",
    vulnClass: "CWE-89",
    severity: "high",
    endpoint: "https://lab.example.com/item?id=1",
  });
  return store.verifyFinding(taskId, finding.id, {
    evidencePaths: ["finding/proof.txt"],
    repro: "curl 'https://lab.example.com/item?id=1%27'",
    verifiedBy: "worker-a",
  });
}

test("self-validation is refused; a distinct validator is recorded as independent", () => {
  const { root, evidenceDir, store } = setup("gy-validation-");
  const taskId = randomUUID();
  try {
    const finding = verified(store, evidenceDir, taskId);
    assert.equal(finding.verifiedBy, "worker-a");

    assert.throws(
      () =>
        store.recordFindingValidation(taskId, finding.id, {
          verdict: "confirmed",
          method: "replay",
          evidencePaths: ["finding/proof.txt"],
          note: "same worker",
          validator: "worker-a",
        }),
      /self-validation refused/,
    );

    const { validation, finding: after } = store.recordFindingValidation(taskId, finding.id, {
      verdict: "confirmed",
      method: "replay",
      evidencePaths: ["finding/proof.txt"],
      note: "独立重放，响应一致",
      validator: "worker-b",
    });
    assert.equal(validation.independent, true);
    assert.equal(validation.verdict, "confirmed");
    assert.equal(validation.evidence.length, 1);
    assert.equal(after.status, "verified", "validation must not mutate the finding");
    assert.equal(store.hasConfirmedValidation(taskId, finding.id), true);
    assert.equal(store.listFindingValidations(taskId, finding.id).length, 1);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("confirmed and refuted require evidence; inconclusive may stand alone", () => {
  const { root, evidenceDir, store } = setup("gy-validation-evidence-");
  const taskId = randomUUID();
  try {
    const finding = verified(store, evidenceDir, taskId);
    assert.throws(
      () =>
        store.recordFindingValidation(taskId, finding.id, {
          verdict: "confirmed",
          method: "evidence-only",
          evidencePaths: [],
          note: "",
          validator: "operator:alice",
        }),
      /requires ≥1 evidence/,
    );
    const inconclusive = store.recordFindingValidation(taskId, finding.id, {
      verdict: "inconclusive",
      method: "manual",
      evidencePaths: [],
      note: "目标不可达，无法重放",
      validator: "operator:alice",
    });
    assert.equal(inconclusive.validation.verdict, "inconclusive");
    assert.equal(store.hasConfirmedValidation(taskId, finding.id), false);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("requireIndependent gate: unconfirmed fails, confirmed passes, later inconclusive revokes", () => {
  const { root, evidenceDir, store } = setup("gy-validation-gate-");
  const taskId = randomUUID();
  try {
    store.seedGoals(taskId, [
      {
        id: "g",
        title: "high findings independently confirmed",
        description: "至少一条独立确认的高危发现",
        evidencePatterns: ["report.md"],
        findingsGate: { minVerified: 1, scope: "task", requireIndependent: true },
        passes: false,
        evidencePaths: [],
        assertedAt: null,
      },
    ]);
    writeEvidence(evidenceDir, "report.md", "# report\n");
    const finding = verified(store, evidenceDir, taskId);

    const blocked = store.assertGoal(taskId, "g", ["report.md"]);
    assert.equal(blocked.ok, false);
    if (!blocked.ok) assert.match(blocked.reason, /缺独立确认/);

    store.recordFindingValidation(taskId, finding.id, {
      verdict: "confirmed",
      method: "control-compare",
      evidencePaths: ["finding/proof.txt"],
      note: "有对照：单引号触发 500，正常请求 200",
      validator: "worker-b",
    });
    const passed = store.assertGoal(taskId, "g", ["report.md"]);
    assert.equal(passed.ok, true, JSON.stringify(passed));

    // A later independent inconclusive revokes the gate view (latest wins).
    store.recordFindingValidation(taskId, finding.id, {
      verdict: "inconclusive",
      method: "manual",
      evidencePaths: [],
      note: "环境变更，无法再次确认",
      validator: "operator:alice",
    });
    assert.equal(store.hasConfirmedValidation(taskId, finding.id), false);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

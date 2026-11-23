import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { openHistory } from "./index.js";

const TASK_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

function setup(prefix: string) {
  const root = mkdtempSync(join(tmpdir(), prefix));
  const evidenceDir = join(root, "evidence");
  mkdirSync(evidenceDir, { recursive: true });
  const store = openHistory({ dbPath: join(root, "history.sqlite"), evidenceDir });
  return { root, store, evidenceDir };
}

function verifiedFinding(store: ReturnType<typeof openHistory>, evidenceDir: string) {
  const { finding } = store.recordFinding({
    taskId: TASK_ID,
    title: "SQLi in login",
    asset: "lab.example.com",
    vulnClass: "CWE-89",
    severity: "high",
  });
  const proof = "HTTP/1.1 200\n\nSQL syntax error";
  writeFileSync(join(evidenceDir, "proof.txt"), proof);
  store.verifyFinding(TASK_ID, finding.id, {
    evidencePaths: ["proof.txt"],
    repro: "curl the login with payload",
  });
  return store.getFinding(TASK_ID, finding.id)!;
}

test("fixed retest requires proof and moves finding to retested", () => {
  const { root, store, evidenceDir } = setup("gy-retest-fixed-");
  try {
    const finding = verifiedFinding(store, evidenceDir);
    writeFileSync(join(evidenceDir, "fixed.txt"), "HTTP/1.1 200\n\nhandled input");
    const { retest, finding: updated } = store.recordFindingRetest(TASK_ID, finding.id, {
      verdict: "fixed",
      evidencePaths: ["fixed.txt"],
      repro: "same payload, now sanitized",
      reviewer: "retester",
    });
    assert.equal(retest.verdict, "fixed");
    assert.equal(retest.evidence.length, 1);
    assert.equal(updated.status, "retested");
    assert.equal(store.listFindingRetests(TASK_ID, finding.id).length, 1);
    const kinds = store.listEvents(TASK_ID).map((e) => e.kind);
    assert.ok(kinds.includes("finding_retest_concluded"));
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("reproduced / inconclusive never move the finding status", () => {
  const { root, store, evidenceDir } = setup("gy-retest-keep-");
  try {
    const finding = verifiedFinding(store, evidenceDir);
    const reproduced = store.recordFindingRetest(TASK_ID, finding.id, {
      verdict: "reproduced",
      repro: "payload still triggers",
      note: "still present",
      reviewer: "retester",
    });
    assert.equal(reproduced.finding.status, "verified");

    const inconclusive = store.recordFindingRetest(TASK_ID, finding.id, {
      verdict: "inconclusive",
      note: "WAF blocked the request; cannot compare",
      reviewer: "retester",
    });
    assert.equal(inconclusive.finding.status, "verified");
    assert.equal(store.listFindingRetests(TASK_ID, finding.id).length, 2);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("fixed without evidence is rejected (one failed request ≠ fixed)", () => {
  const { root, store, evidenceDir } = setup("gy-retest-reject-");
  try {
    const finding = verifiedFinding(store, evidenceDir);
    assert.throws(
      () =>
        store.recordFindingRetest(TASK_ID, finding.id, {
          verdict: "fixed",
          repro: "request now returns 200",
          reviewer: "retester",
        }),
      /requires repro/,
    );
    assert.throws(
      () =>
        store.recordFindingRetest(TASK_ID, finding.id, {
          verdict: "inconclusive",
          reviewer: "retester",
        }),
      /requires note/,
    );
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

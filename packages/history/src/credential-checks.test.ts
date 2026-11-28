import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { openHistory } from "./index.js";

const TASK_ID = "66666666-6666-4666-8666-666666666666";

function setup(prefix: string) {
  const root = mkdtempSync(join(tmpdir(), prefix));
  const evidenceDir = join(root, "evidence");
  mkdirSync(evidenceDir, { recursive: true });
  const store = openHistory({ dbPath: join(root, "history.sqlite"), evidenceDir });
  return { root, store };
}

test("recordCredentialCheck upserts one matrix cell, consumes the credential, and augments reuseCount", () => {
  const { root, store } = setup("gy-cred-check-");
  try {
    const { credential } = store.recordCredential({
      taskId: TASK_ID,
      kind: "password",
      asset: "10.0.0.10",
      username: "svc",
      secretRef: "creds/svc.txt",
      verified: true,
    });
    const first = store.recordCredentialCheck({
      taskId: TASK_ID,
      credentialId: credential.id,
      targetAsset: "10.0.0.11",
      service: "SSH",
      verdict: "invalid",
      note: "first probe",
      checkedBy: "w1",
    });
    assert.equal(first.service, "ssh");
    assert.equal(first.verdict, "invalid");

    const second = store.recordCredentialCheck({
      taskId: TASK_ID,
      credentialId: credential.id,
      targetAsset: "10.0.0.11",
      service: "ssh",
      verdict: "valid",
      evidencePath: "creds/10.0.0.11-ssh.txt",
      note: "second probe",
      checkedBy: "w2",
    });
    assert.equal(second.id, first.id, "同一单元格重复验证必须幂等更新而不追加行");
    assert.equal(second.verdict, "valid");
    assert.equal(second.note, "second probe");
    assert.equal(second.evidencePath, "creds/10.0.0.11-ssh.txt");
    assert.equal(second.checkedBy, "w2");

    const checks = store.listCredentialChecks(TASK_ID);
    assert.equal(checks.length, 1);
    assert.equal(checks[0]!.verdict, "valid");

    const refreshed = store.getCredential(TASK_ID, credential.id);
    assert.equal(refreshed?.reuseCount, 2, "每次验证（含幂等更新）都自动计一次凭据消费");
    assert.ok(refreshed?.lastUsedAt);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("valid cross-host probe appends an auth Fact; same-host valid / foreign invalid do not", () => {
  const { root, store } = setup("gy-cred-authfact-");
  try {
    const { credential } = store.recordCredential({
      taskId: TASK_ID,
      kind: "password",
      asset: "10.0.0.10",
      username: "svc",
      secretRef: "creds/svc.txt",
      verified: true,
    });
    store.recordCredentialCheck({
      taskId: TASK_ID,
      credentialId: credential.id,
      targetAsset: "10.0.0.21",
      service: "ssh",
      verdict: "valid",
      checkedBy: "w1",
    });
    store.recordCredentialCheck({
      taskId: TASK_ID,
      credentialId: credential.id,
      targetAsset: "10.0.0.10",
      service: "ssh",
      verdict: "valid",
      checkedBy: "w1",
    });
    store.recordCredentialCheck({
      taskId: TASK_ID,
      credentialId: credential.id,
      targetAsset: "10.0.0.22",
      service: "ssh",
      verdict: "invalid",
      checkedBy: "w1",
    });

    const authFacts = store.listFacts(TASK_ID, "auth");
    assert.equal(authFacts.length, 1, "只有跨主机 valid 才应追加 auth Fact");
    assert.match(authFacts[0]!.title, /跨主机凭据复用确认/);
    assert.ok(authFacts[0]!.tags.includes("auth-reuse"));
    assert.ok(authFacts[0]!.tags.includes(`credential.id:${credential.id}`));
    assert.match(authFacts[0]!.summary, /10\.0\.0\.21/);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("engagement audit retires only conclusively probed (credential, live host) cells", () => {
  const { root, store } = setup("gy-cred-audit-");
  try {
    const auth = { targets: ["10.0.0.0/24"], outOfScope: [] };
    for (const address of ["10.0.0.10", "10.0.0.11", "10.0.0.12"]) {
      store.recordAsset({ taskId: TASK_ID, address, auth, live: true });
    }
    const { credential } = store.recordCredential({
      taskId: TASK_ID,
      kind: "password",
      asset: "10.0.0.10",
      username: "svc",
      secretRef: "creds/svc.txt",
      verified: true,
    });

    const baseline = store.engagementAudit(TASK_ID).scorecard.credentials;
    assert.equal(baseline.total, 1);
    assert.equal(baseline.verified, 1);
    assert.equal(baseline.sprayBacklog, 2, "自有主机不计入喷洒矩阵");

    store.recordCredentialCheck({
      taskId: TASK_ID,
      credentialId: credential.id,
      targetAsset: "10.0.0.11",
      service: "ssh",
      verdict: "valid",
      checkedBy: "w1",
    });
    assert.equal(store.engagementAudit(TASK_ID).scorecard.credentials.sprayBacklog, 1);

    // `error` 是探测未触达（服务不可达），单元格仍应留在积压里。
    store.recordCredentialCheck({
      taskId: TASK_ID,
      credentialId: credential.id,
      targetAsset: "10.0.0.12",
      service: "ssh",
      verdict: "error",
      checkedBy: "w1",
    });
    assert.equal(store.engagementAudit(TASK_ID).scorecard.credentials.sprayBacklog, 1);

    // invalid 属于结论性验证，同样退休该单元格。
    store.recordCredentialCheck({
      taskId: TASK_ID,
      credentialId: credential.id,
      targetAsset: "10.0.0.12",
      service: "ssh",
      verdict: "invalid",
      checkedBy: "w1",
    });
    assert.equal(store.engagementAudit(TASK_ID).scorecard.credentials.sprayBacklog, 0);
    const observe = store.observe(TASK_ID);
    assert.match(observe, /待测矩阵 0/);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});
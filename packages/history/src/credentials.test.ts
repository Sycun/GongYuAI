import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import { openHistory } from "./index.js";

const TASK_ID = "44444444-4444-4444-8444-444444444444";

function setup(prefix: string) {
  const root = mkdtempSync(join(tmpdir(), prefix));
  const evidenceDir = join(root, "evidence");
  mkdirSync(evidenceDir, { recursive: true });
  const store = openHistory({ dbPath: join(root, "history.sqlite"), evidenceDir });
  return { root, store };
}

test("recordCredential stores pointers only and is dedup-idempotent", () => {
  const { root, store } = setup("gy-cred-dedup-");
  try {
    const first = store.recordCredential({
      taskId: TASK_ID,
      kind: "password",
      asset: "https://lab.example.com/login",
      username: "admin",
      secretRef: "credentials/cred-1.txt",
      secretHmac: "a".repeat(64),
      verified: true,
    });
    assert.equal(first.created, true);
    assert.equal(first.credential.asset, "lab.example.com");
    assert.equal(first.credential.username, "admin");
    assert.equal(first.credential.secretRef, "credentials/cred-1.txt");
    assert.ok(first.credential.verifiedAt);

    const again = store.recordCredential({
      taskId: TASK_ID,
      kind: "password",
      asset: "lab.example.com",
      username: "admin",
      secretRef: "credentials/cred-1.txt",
    });
    assert.equal(again.created, false);
    assert.equal(again.credential.id, first.credential.id);

    const listed = store.listCredentials(TASK_ID);
    assert.equal(listed.length, 1);
    // P14-B4 bridge: the credential is also a Fact usable as an Intent predecessor.
    assert.ok(first.credential.factId);
    const fact = store.getFact(TASK_ID, first.credential.factId!);
    assert.ok(fact);
    assert.ok(fact!.tags.includes("credential"));
    assert.equal(fact!.title.includes("password"), true);
    const intent = store.proposeIntent({
      taskId: TASK_ID,
      title: "reuse credential on peer host",
      sourceFactIds: [first.credential.factId!],
    });
    assert.equal(intent.sourceFactIds[0], first.credential.factId);
    // The row never carries the secret itself — only the pointer/fingerprint.
    assert.equal(listed[0]!.secretHmac, "a".repeat(64));
    assert.equal(JSON.stringify(listed).includes("hunter2"), false);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("touchCredential increments reuse and records lastUsedAt", () => {
  const { root, store } = setup("gy-cred-reuse-");
  try {
    const { credential } = store.recordCredential({
      taskId: TASK_ID,
      kind: "hash",
      asset: "10.0.0.5",
      username: "svc",
      secretRef: "credentials/cred-2.txt",
    });
    assert.equal(credential.reuseCount, 0);
    const used = store.touchCredential(TASK_ID, credential.id);
    assert.equal(used.reuseCount, 1);
    assert.ok(used.lastUsedAt);
    assert.equal(store.touchCredential(TASK_ID, credential.id).reuseCount, 2);
    const events = store.listEvents(TASK_ID).map((e) => e.kind);
    assert.ok(events.includes("credential_recorded"));
    assert.ok(events.includes("credential_reused"));
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("recordCredential rejects unknown source finding and empty pointer", () => {
  const { root, store } = setup("gy-cred-reject-");
  try {
    assert.throws(
      () =>
        store.recordCredential({
          taskId: TASK_ID,
          kind: "token",
          asset: "lab.example.com",
          secretRef: "credentials/x.txt",
          sourceFindingId: "55555555-5555-4555-8555-555555555555",
        }),
      /unknown credential source finding/,
    );
    assert.throws(
      () =>
        store.recordCredential({
          taskId: TASK_ID,
          kind: "token",
          asset: "lab.example.com",
          secretRef: "   ",
        }),
      /secretRef required/,
    );
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

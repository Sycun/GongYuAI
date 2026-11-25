import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
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
    assert.equal(first.credential.tier, "L2");
    assert.equal(first.credential.impactSummary, null);

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
    assert.equal(credential.tier, "L1");
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

const LEGACY_CREDENTIALS = `
  CREATE TABLE credentials (
    id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    asset TEXT NOT NULL,
    username TEXT,
    secret_ref TEXT NOT NULL,
    secret_hmac TEXT,
    source_finding_id TEXT,
    fact_id TEXT,
    verified_at TEXT,
    last_used_at TEXT,
    reuse_count INTEGER NOT NULL DEFAULT 0,
    expires_at TEXT,
    created_at TEXT NOT NULL
  );
`;

function insertLegacy(db: DatabaseSync, id: string, secretRef: string, verifiedAt: string | null): void {
  db.prepare(
    `INSERT INTO credentials
      (id, task_id, kind, asset, username, secret_ref, verified_at, reuse_count, created_at)
     VALUES (?, ?, 'token', 'lab.example.com', 'user', ?, ?, 0, ?)`,
  ).run(id, TASK_ID, secretRef, verifiedAt, "2026-11-24T00:00:00.000Z");
}

test("legacy credentials table gains tier and impact_summary without dropping rows", () => {
  const root = mkdtempSync(join(tmpdir(), "gy-cred-migrate-"));
  const evidenceDir = join(root, "evidence");
  mkdirSync(evidenceDir, { recursive: true });
  const dbPath = join(root, "history.sqlite");
  const verifiedId = "66666666-6666-4666-8666-666666666666";
  const plainId = "77777777-7777-4777-8777-777777777777";
  const raw = new DatabaseSync(dbPath);
  try {
    raw.exec(LEGACY_CREDENTIALS);
    insertLegacy(raw, verifiedId, "credentials/verified.txt", "2026-11-24T00:00:00.000Z");
    insertLegacy(raw, plainId, "credentials/plain.txt", null);
  } finally {
    raw.close();
  }
  const store = openHistory({ dbPath, evidenceDir });
  try {
    const rows = store.listCredentials(TASK_ID);
    assert.equal(rows.length, 2);
    assert.equal(rows.find((row) => row.id === verifiedId)?.tier, "L2");
    assert.equal(rows.find((row) => row.id === plainId)?.tier, "L1");
    assert.equal(rows.every((row) => row.impactSummary === null), true);

    const upgraded = store.updateCredential(TASK_ID, plainId, {
      tier: "L3",
      impactSummary: "可读取目标邮箱",
    });
    assert.equal(upgraded.tier, "L3");
    assert.equal(upgraded.impactSummary, "可读取目标邮箱");
    assert.equal(store.getCredential(TASK_ID, verifiedId)?.tier, "L2");

    const again = store.recordCredential({
      taskId: TASK_ID,
      kind: "token",
      asset: "lab.example.com",
      username: "user",
      secretRef: "credentials/plain.txt",
      tier: "L1",
    });
    assert.equal(again.created, false);
    assert.equal(again.credential.id, plainId);
    assert.equal(again.credential.tier, "L3");
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("read-only legacy credentials infer tier and leave the table unchanged", () => {
  const root = mkdtempSync(join(tmpdir(), "gy-cred-ro-"));
  const evidenceDir = join(root, "evidence");
  mkdirSync(evidenceDir, { recursive: true });
  const dbPath = join(root, "history.sqlite");
  const verifiedId = "88888888-8888-4888-8888-888888888888";
  const plainId = "99999999-9999-4999-8999-999999999999";
  const raw = new DatabaseSync(dbPath);
  try {
    raw.exec(LEGACY_CREDENTIALS);
    insertLegacy(raw, verifiedId, "credentials/verified.txt", "2026-11-24T00:00:00.000Z");
    insertLegacy(raw, plainId, "credentials/plain.txt", null);
  } finally {
    raw.close();
  }
  const store = openHistory({ dbPath, evidenceDir, readOnly: true });
  try {
    const rows = store.listCredentials(TASK_ID);
    assert.equal(rows.find((row) => row.id === verifiedId)?.tier, "L2");
    assert.equal(rows.find((row) => row.id === plainId)?.tier, "L1");
    assert.equal(rows.find((row) => row.id === plainId)?.impactSummary, null);
  } finally {
    store.close();
  }
  const check = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const names = (check.prepare("PRAGMA table_info(credentials)").all() as Array<{ name: string }>)
      .map((column) => column.name);
    assert.equal(names.includes("tier"), false);
    assert.equal(names.includes("impact_summary"), false);
  } finally {
    check.close();
    rmSync(root, { recursive: true, force: true });
  }
});

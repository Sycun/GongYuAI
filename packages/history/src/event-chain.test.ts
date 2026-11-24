import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { openHistory } from "./index.js";
import { randomUUID } from "node:crypto";

function setup(prefix: string) {
  const root = mkdtempSync(join(tmpdir(), prefix));
  const evidenceDir = join(root, "evidence");
  mkdirSync(evidenceDir, { recursive: true });
  const dbPath = join(root, "history.sqlite");
  const store = openHistory({ dbPath, evidenceDir });
  return { root, dbPath, store };
}

test("events form a verifiable hash chain and tampering is detected", () => {
  const { root, dbPath, store } = setup("gy-chain-");
  const taskId = randomUUID();
  try {
    store.recordEvent(taskId, "worker_started", { slot: 0 });
    store.recordEvent(taskId, "intent_proposed", { title: "probe" });
    store.recordEvent(taskId, "intent_claimed", { by: "w0" });
    const events = store.listEvents(taskId, 10);
    assert.equal(events.length, 3);
    assert.ok(events.every((event) => /^[a-f0-9]{64}$/.test(event.hash ?? "")));
    assert.equal(events[0]!.prevHash, events[1]!.hash);
    const verified = store.verifyEventChain(taskId);
    assert.equal(verified.ok, true);
    assert.equal(verified.length, 3);
    assert.match(verified.head ?? "", /^[a-f0-9]{64}$/);

    // Tamper with the middle event directly in SQLite.
    const raw = new DatabaseSync(dbPath);
    try {
      const middle = raw
        .prepare("SELECT id FROM events WHERE task_id = ? ORDER BY rowid LIMIT 1 OFFSET 1")
        .get(taskId) as { id: string };
      raw.prepare("UPDATE events SET payload_json = ? WHERE id = ?").run(
        JSON.stringify({ title: "tampered" }),
        middle.id,
      );
    } finally {
      raw.close();
    }
    const broken = store.verifyEventChain(taskId);
    assert.equal(broken.ok, false);
    assert.equal(broken.reason, "hash mismatch");
    assert.ok(broken.brokenAt);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("legacy unsealed events are backfilled on open", () => {
  const { root, dbPath } = setup("gy-chain-migrate-");
  const taskId = randomUUID();
  try {
    // Simulate a pre-P17 DB: close the store, insert rows with NULL hashes.
    const seed = openHistory({ dbPath, evidenceDir: join(root, "evidence") });
    seed.close();
    const raw = new DatabaseSync(dbPath);
    try {
      const insert = raw.prepare(
        "INSERT INTO events (id, task_id, kind, payload_json, created_at) VALUES (?, ?, ?, ?, ?)",
      );
      insert.run(randomUUID(), taskId, "worker_started", "{}", "2026-11-24T00:00:00.000Z");
      insert.run(randomUUID(), taskId, "intent_proposed", "{\"title\":\"old\"}", "2026-11-24T00:00:01.000Z");
    } finally {
      raw.close();
    }
    const reopened = openHistory({ dbPath, evidenceDir: join(root, "evidence") });
    try {
      const verified = reopened.verifyEventChain(taskId);
      assert.equal(verified.ok, true, JSON.stringify(verified));
      assert.equal(verified.length, 2);
      assert.match(verified.head ?? "", /^[a-f0-9]{64}$/);
    } finally {
      reopened.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

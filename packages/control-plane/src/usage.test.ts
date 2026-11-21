import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { mergeUsageFromDisk } from "./usage.js";

describe("mergeUsageFromDisk", () => {
  it("prefers the max of status sidecar, checkpoint, and current", () => {
    const dir = join(tmpdir(), `gy-usage-${Date.now()}`);
    mkdirSync(dir, { recursive: true });
    try {
      writeFileSync(
        join(dir, "worker-status.json"),
        JSON.stringify({
          status: "running",
          usage: { tokens: 10, toolCalls: 3, installs: 0 },
        }),
      );
      const ckpt = join(dir, "durable.sqlite.ckpt.sqlite");
      const db = new DatabaseSync(ckpt);
      db.exec(`
        CREATE TABLE checkpoint (
          id INTEGER PRIMARY KEY CHECK (id = 1),
          json TEXT NOT NULL
        );
      `);
      db.prepare(`INSERT INTO checkpoint (id, json) VALUES (1, ?)`).run(
        JSON.stringify({
          tokens: 100,
          toolCalls: 50,
          installs: 2,
        }),
      );
      db.close();

      const merged = mergeUsageFromDisk(dir, {
        tokens: 5,
        toolCalls: 1,
        installs: 1,
      });
      assert.equal(merged.tokens, 100);
      assert.equal(merged.toolCalls, 50);
      assert.equal(merged.installs, 2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("falls back to checkpoint when worker-status is stale zeros", () => {
    const dir = join(tmpdir(), `gy-usage-stale-${Date.now()}`);
    mkdirSync(dir, { recursive: true });
    try {
      writeFileSync(
        join(dir, "worker-status.json"),
        JSON.stringify({
          status: "running",
          usage: { tokens: 0, toolCalls: 0, installs: 0 },
          updatedAt: "2026-11-21T11:56:08.081Z",
        }),
      );
      const ckpt = join(dir, "durable.sqlite.ckpt.sqlite");
      const db = new DatabaseSync(ckpt);
      db.exec(`
        CREATE TABLE checkpoint (
          id INTEGER PRIMARY KEY CHECK (id = 1),
          json TEXT NOT NULL
        );
      `);
      db.prepare(`INSERT INTO checkpoint (id, json) VALUES (1, ?)`).run(
        JSON.stringify({ toolCalls: 607, installs: 1, tokens: 0 }),
      );
      db.close();

      const merged = mergeUsageFromDisk(dir, {
        tokens: 0,
        toolCalls: 0,
        installs: 0,
      });
      assert.equal(merged.toolCalls, 607);
      assert.equal(merged.installs, 1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

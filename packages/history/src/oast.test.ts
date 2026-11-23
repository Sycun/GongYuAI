import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { openHistory } from "./index.js";

const TASK_ID = "88888888-8888-4888-8888-888888888888";

function setup(prefix: string) {
  const root = mkdtempSync(join(tmpdir(), prefix));
  const evidenceDir = join(root, "evidence");
  mkdirSync(evidenceDir, { recursive: true });
  const store = openHistory({ dbPath: join(root, "history.sqlite"), evidenceDir });
  return { root, store };
}

test("oast token issue + hit correlation", () => {
  const { root, store } = setup("gy-oast-");
  try {
    const token = store.recordOastToken({
      token: "abcdef1234567890",
      taskId: TASK_ID,
      kind: "http",
      callback: "http://10.0.0.9:8799/t/abcdef1234567890",
      expiresAt: new Date(Date.now() + 3600_000).toISOString(),
    });
    assert.equal(token.hits, 0);
    const hit = store.recordOastHit(TASK_ID, {
      token: token.token,
      sourceIp: "10.0.0.5",
      method: "GET",
      path: "/t/abcdef1234567890",
      userAgent: "curl/8",
    });
    assert.equal(hit.token, token.token);
    assert.equal(store.listOastHits(TASK_ID).length, 1);
    assert.equal(store.getOastToken(TASK_ID, token.token)!.hits, 1);
    const events = store.listEvents(TASK_ID).map((e) => e.kind);
    assert.ok(events.includes("oast_token_issued"));
    assert.ok(events.includes("oast_hit"));
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("oast hit for unknown token is rejected (no fake hits)", () => {
  const { root, store } = setup("gy-oast-reject-");
  try {
    assert.throws(
      () => store.recordOastHit(TASK_ID, { token: "deadbeefdeadbeef" }),
      /unknown oast token/,
    );
    assert.equal(store.listOastHits(TASK_ID).length, 0);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { MEMORY_REVIEW_UNAVAILABLE } from "./memory-access.js";
import { PlatformStore } from "./platform.js";
import { bootControlPlane } from "./index.js";

const TITLE = "虚构星澜备忘";
const BODY = "星澜备忘正文仅授权复核可见";
const ENGAGEMENT = "eng-fictional-starlan";

function persisted(dataRoot: string, id: string) {
  const db = new DatabaseSync(join(dataRoot, "platform.sqlite"), { readOnly: true });
  try {
    const node = db.prepare(`SELECT json, status, updated_at FROM memory_nodes WHERE id = ?`).get(id) as {
      json: string;
      status: string;
      updated_at: string;
    };
    const events = db.prepare(
      `SELECT action, actor, reason, at, task_id FROM memory_events WHERE memory_id = ? ORDER BY at, id`,
    ).all(id);
    return { node, events };
  } finally {
    db.close();
  }
}

test("an unauthorized memory review returns 403 and does not change the node", async (t) => {
  const previous = {
    GY_DATA_DIR: process.env.GY_DATA_DIR,
    GY_HOST: process.env.GY_HOST,
    GY_PORT: process.env.GY_PORT,
  };
  const dataRoot = mkdtempSync(join(tmpdir(), "gy-memory-review-"));
  const platform = new PlatformStore(dataRoot);
  const node = platform.createDraft({
    kind: "lesson",
    title: TITLE,
    body: BODY,
    matchKeys: [{ kind: "cwe", value: "CWE-89", strength: "hard" }],
    provenance: [{
      taskId: randomUUID(),
      engagementId: ENGAGEMENT,
      refKind: "evidence",
      refId: "fictional-ref",
      path: null,
      sha256: null,
    }],
    createdBy: "fictional-operator",
  }, "2026-11-23T04:00:00.000Z");
  platform.close();
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(dataRoot, { recursive: true, force: true });
  });

  const plane = await bootControlPlane({ dataRoot, host: "127.0.0.1", port: 0, isolated: true });
  t.after(() => plane.close());
  const before = persisted(dataRoot, node.id);
  assert.match(before.node.json, new RegExp(TITLE));
  assert.match(before.node.json, new RegExp(BODY));
  assert.equal(before.node.status, "draft");

  const review = {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-tenant-id": "default",
      "x-engagement-id": ENGAGEMENT,
    },
    body: JSON.stringify({ decision: "confirm", reviewer: "不应写入的复核人", reason: "这条请求没有复核权限" }),
  };
  const denied = await fetch(
    `${plane.url}/memory/nodes/${node.id}/review?tenantId=default&engagementId=${ENGAGEMENT}`,
    review,
  );
  const deniedText = await denied.text();
  const missing = await fetch(`${plane.url}/memory/nodes/${randomUUID()}/review`, review);
  const missingText = await missing.text();
  const after = persisted(dataRoot, node.id);

  assert.equal(denied.status, 403);
  assert.deepEqual(JSON.parse(deniedText), MEMORY_REVIEW_UNAVAILABLE);
  assert.equal(deniedText.includes(TITLE), false);
  assert.equal(deniedText.includes(BODY), false);
  assert.equal(deniedText.includes("不应写入的复核人"), false);
  assert.equal(missing.status, 403);
  assert.equal(missingText.includes(TITLE), false);
  assert.equal(missingText.includes(BODY), false);
  assert.deepEqual(after, before);
});
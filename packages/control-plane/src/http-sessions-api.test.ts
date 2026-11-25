import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { CreateTaskRequestSchema } from "@gongyuai/contracts";
import { bootControlPlane } from "./index.js";

const COOKIE_SECRET = "api-cookie-secret-value";
const HEADER_SECRET = "api-header-secret-value";

async function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), "gy-http-session-api-"));
  const plane = await bootControlPlane({
    dataRoot: root,
    host: "127.0.0.1",
    port: 0,
    runtime: "local",
    isolated: true,
    watchdogMs: 60_000,
  });
  t.after(async () => {
    await plane.close();
    rmSync(root, { recursive: true, force: true });
  });
  const task = plane.store.createTask(CreateTaskRequestSchema.parse({
    name: "http session",
    auth: { targets: ["lab.example"], authorizationNote: "local session api fixture" },
    goals: [{ id: "g1", title: "覆盖", description: "session", evidencePatterns: ["*"] }],
    mock: true,
  }));
  return { task, base: `${plane.url}/tasks/${task.id}/http-sessions` };
}

test("http session import list and delete hide secret values", async (t) => {
  const { task, base } = await fixture(t);
  writeFileSync(join(task.dataDir, "http-sessions.json"), JSON.stringify({
    legacy: { "lab.example": { sid: COOKIE_SECRET } },
  }));

  const imported = await fetch(base, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      name: "admin",
      host: "https://lab.example/login",
      cookie: `sid=${COOKIE_SECRET}; csrf=token`,
      headers: { Authorization: HEADER_SECRET, "X-CSRF-Token": "csrf-token" },
    }),
  });
  const importedText = await imported.text();
  const importedBody = JSON.parse(importedText) as {
    session: { name: string; host: string; cookieKeys: string[]; headerKeys: string[] };
  };
  assert.equal(imported.status, 200, importedText);
  assert.equal(importedBody.session.name, "admin");
  assert.equal(importedBody.session.host, "lab.example");
  assert.deepEqual(importedBody.session.cookieKeys, ["csrf", "sid"]);
  assert.deepEqual(importedBody.session.headerKeys, ["Authorization", "X-CSRF-Token"]);
  assert.equal(JSON.stringify(importedBody).includes(COOKIE_SECRET), false);
  assert.equal(JSON.stringify(importedBody).includes(HEADER_SECRET), false);

  const listed = await fetch(base);
  const listedText = await listed.text();
  assert.equal(listed.status, 200);
  const listedBody = JSON.parse(listedText) as {
    sessions: Array<{ name: string; host: string; cookieKeys: string[]; headerKeys: string[] }>;
  };
  assert.equal(listedText.includes(COOKIE_SECRET), false);
  assert.equal(listedText.includes(HEADER_SECRET), false);
  assert.ok(listedBody.sessions.some((row) =>
    row.name === "legacy" && row.host === "lab.example" && row.cookieKeys.includes("sid") && row.headerKeys.length === 0,
  ));
  assert.ok(listedBody.sessions.some((row) =>
    row.name === "admin" && row.cookieKeys.includes("sid") && row.headerKeys.includes("Authorization"),
  ));

  const removed = await fetch(`${base}/${encodeURIComponent("admin")}`, { method: "DELETE" });
  assert.equal(removed.status, 200);
  const after = await fetch(base);
  const afterBody = await after.json() as { sessions: Array<{ name: string }> };
  assert.equal(afterBody.sessions.some((row) => row.name === "admin"), false);
  assert.equal(afterBody.sessions.some((row) => row.name === "legacy"), true);
});

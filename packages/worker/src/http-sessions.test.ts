import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { WorkerManifest } from "@gongyuai/contracts";
import { openHistory } from "@gongyuai/history";
import { listHttpSessionSummaries, upsertHttpSession } from "@gongyuai/exec";
import type { ToolContext } from "./tools.js";
import { httpRequestTool } from "./http-tools.js";

const TASK_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const COOKIE_SECRET = "legacy-cookie-secret";
const OTHER_SECRET = "other-host-cookie-secret";
const STORED_AUTH = "stored-authorization-secret";
const CALLER_AUTH = "caller-authorization-secret";
const CSRF_SECRET = "csrf-header-secret";

test("http_request keeps legacy jars, header priority, host isolation, and raw evidence", async () => {
  const root = mkdtempSync(join(tmpdir(), "gy-http-session-tool-"));
  const evidenceDir = join(root, "evidence");
  mkdirSync(evidenceDir, { recursive: true });
  const history = openHistory({ dbPath: join(root, "history.sqlite"), evidenceDir });
  const manifest: WorkerManifest = {
    taskId: TASK_ID,
    engagementId: "eng-session",
    dataDir: root,
    historyDb: join(root, "history.sqlite"),
    durableDb: join(root, "durable.sqlite"),
    evidenceDir,
    workspaceDir: join(root, "workspace"),
    auth: {
      authorizationNote: "local session fixture",
      targets: ["127.0.0.1"],
      outOfScope: [],
      capability: "active-lab",
    },
    scopeVersion: 1,
    goals: [],
    budget: { maxTokens: 0, maxWallMs: 0, maxToolCalls: 0, maxInstalls: 0, relayTokenThreshold: 30_000, relayMinToolCalls: 2 },
    execution: { maxConcurrentExplores: 1, maxIntentsPerReason: 4, maxIntentsPerAssetRoot: 2, exploreTimeoutMs: 900_000, reasonLeaseMs: 120_000 },
    commandConfirmation: "auto",
    workerId: "w0-session",
    workerSlot: 0,
    workerCount: 1,
    mock: false,
    mcpServers: [],
    mcpPool: [],
    mcpCatalog: [],
    skillPacks: [],
    skillPool: [],
    skillCatalog: [],
    assetCollectors: [],
  };
  const ctx: ToolContext = { manifest, history, usage: { toolCalls: 0, installs: 0 } };
  writeFileSync(join(root, "http-sessions.json"), JSON.stringify({
    user: {
      "127.0.0.1": { sid: COOKIE_SECRET },
      "other.test": { sid: OTHER_SECRET },
    },
  }));
  const server = createServer((req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({
      cookie: req.headers.cookie ?? "",
      authorization: req.headers.authorization ?? "",
      csrf: req.headers["x-csrf-token"] ?? "",
    }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  try {
    const first = JSON.parse(await httpRequestTool(ctx, {
      url: `http://127.0.0.1:${port}/echo`,
      session: "user",
    })) as { ok: boolean; bodyHead: string };
    assert.equal(first.ok, true);
    const anon = JSON.parse(first.bodyHead) as { cookie: string; authorization: string; csrf: string };
    assert.match(anon.cookie, new RegExp(`sid=${COOKIE_SECRET}`));
    assert.equal(anon.cookie.includes(OTHER_SECRET), false);
    assert.equal(anon.authorization, "");

    upsertHttpSession(root, {
      name: "user",
      host: "127.0.0.1",
      headers: { Authorization: STORED_AUTH, "X-CSRF-Token": CSRF_SECRET },
    });
    upsertHttpSession(root, {
      name: "user",
      host: "other.test",
      headers: { Authorization: OTHER_SECRET },
    });
    const second = JSON.parse(await httpRequestTool(ctx, {
      url: `http://127.0.0.1:${port}/echo`,
      session: "user",
      headers: JSON.stringify({ Authorization: CALLER_AUTH }),
    })) as { ok: boolean; bodyHead: string };
    assert.equal(second.ok, true);
    const authed = JSON.parse(second.bodyHead) as { cookie: string; authorization: string; csrf: string };
    assert.equal(authed.authorization, CALLER_AUTH);
    assert.equal(authed.csrf, CSRF_SECRET);
    assert.match(authed.cookie, new RegExp(`sid=${COOKIE_SECRET}`));
    assert.equal(authed.authorization.includes(STORED_AUTH), false);
    assert.equal(JSON.stringify(authed).includes(OTHER_SECRET), false);

    const listed = JSON.stringify(listHttpSessionSummaries(root));
    assert.match(listed, /"sid"/);
    assert.match(listed, /"Authorization"/);
    assert.equal(listed.includes(COOKIE_SECRET), false);
    assert.equal(listed.includes(STORED_AUTH), false);
    assert.equal(listed.includes(CALLER_AUTH), false);
    assert.equal(listed.includes(CSRF_SECRET), false);

    const evidence = readdirSync(join(evidenceDir, "http"))
      .filter((name) => name.endsWith(".res.txt"))
      .map((name) => readFileSync(join(evidenceDir, "http", name), "utf8"))
      .join("\n");
    assert.match(evidence, new RegExp(COOKIE_SECRET));
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    history.close();
    rmSync(root, { recursive: true, force: true });
  }
});

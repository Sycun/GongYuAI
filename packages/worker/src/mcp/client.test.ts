import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { WorkerManifest } from "@gongyuai/contracts";
import { openHistory } from "@gongyuai/history";
import { openMcpHub, probeMcpHealth } from "./client.js";
import type { ToolContext } from "../tools.js";

function manifest(root: string): WorkerManifest {
  return {
    taskId: "11111111-1111-4111-8111-111111111111",
    dataDir: root,
    historyDb: join(root, "history.sqlite"),
    durableDb: join(root, "durable.sqlite"),
    evidenceDir: join(root, "evidence"),
    workspaceDir: join(root, "workspace"),
    auth: {
      authorizationNote: "lab auth note for tests",
      targets: ["127.0.0.1"],
      outOfScope: [],
      capability: "full",
    },
    scopeVersion: 1,
    goals: [],
    budget: {
      maxTokens: 1000,
      maxWallMs: 60_000,
      maxToolCalls: 10,
      maxInstalls: 2,
      relayTokenThreshold: 30_000,
      relayMinToolCalls: 2,
    },
    execution: {
      maxConcurrentExplores: 1,
      maxIntentsPerReason: 4,
      maxIntentsPerAssetRoot: 2,
      exploreTimeoutMs: 900_000,
      reasonLeaseMs: 120_000,
    },
    workerId: "w0",
    workerSlot: 0,
    commandConfirmation: "auto",
    workerCount: 1,
    mock: true,
    mcpServers: [],
    mcpPool: [],
    mcpCatalog: [],
    skillPacks: [],
    skillPool: [],
    skillCatalog: [],
    assetCollectors: [],
  };
}

test("MCP health distinguishes a missing binary, a closed port, and a timeout", async () => {
  const missing = await probeMcpHealth({
    id: "httpx",
    name: "httpx",
    transport: "stdio",
    command: "/nonexistent/httpx",
    args: [],
    env: {},
  });
  assert.equal(missing.ok, false);
  if (!missing.ok) {
    assert.equal(missing.code, "missing-binary");
    assert.match(missing.reason, /二进制不存在/);
  }

  const closed = createServer();
  await new Promise<void>((resolve) => closed.listen(0, "127.0.0.1", () => resolve()));
  const closedAddress = closed.address();
  if (!closedAddress || typeof closedAddress === "string") throw new Error("no port");
  await new Promise<void>((resolve) => closed.close(() => resolve()));
  const refused = await probeMcpHealth({
    id: "httpx",
    name: "httpx",
    transport: "http",
    url: `http://127.0.0.1:${closedAddress.port}`,
    args: [],
    env: {},
  }, 500);
  assert.equal(refused.ok, false);
  if (!refused.ok) assert.equal(refused.code, "port-failure");

  const hung = createServer(() => {});
  await new Promise<void>((resolve) => hung.listen(0, "127.0.0.1", () => resolve()));
  const hungAddress = hung.address();
  if (!hungAddress || typeof hungAddress === "string") throw new Error("no port");
  try {
    const timed = await probeMcpHealth({
      id: "nmap",
      name: "nmap",
      transport: "http",
      url: `http://127.0.0.1:${hungAddress.port}/mcp`,
      args: [],
      env: {},
      timeoutMs: 200,
    });
    assert.equal(timed.ok, false);
    if (!timed.ok) assert.equal(timed.code, "timeout");
  } finally {
    hung.close();
  }
});

test("a stdio MCP that never answers is killed and later calls fail fast", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "gy-mcp-health-"));
  const pidFile = join(root, "pid");
  const history = openHistory({ dbPath: join(root, "history.sqlite"), evidenceDir: join(root, "evidence") });
  const m = manifest(root);
  m.mcpPool = [{
    id: "sleeper",
    name: "Sleeper",
    transport: "stdio",
    command: process.execPath,
    args: ["-e", "require('fs').writeFileSync(process.argv[1], String(process.pid)); setInterval(() => {}, 1000);", pidFile],
    env: {},
    timeoutMs: 300,
  }];
  const ctx: ToolContext = { manifest: m, history, usage: { toolCalls: 0, installs: 0 } };
  const hub = await openMcpHub(m, ctx);
  t.after(async () => {
    await hub.close();
    history.close();
    rmSync(root, { recursive: true, force: true });
  });
  await assert.rejects(hub.enable("sleeper", "health"), /timeout/);
  const pid = Number(readFileSync(pidFile, "utf8"));
  const stat = spawnSync("ps", ["-o", "stat=", "-p", String(pid)], { encoding: "utf8" }).stdout.trim();
  assert.equal(/^[SR]/.test(stat), false, `sleeper still running: ${stat || "none"}`);
  const started = Date.now();
  const again = JSON.parse(await hub.invoke("sleeper", "run", {})) as { ok: boolean; code: string };
  assert.equal(again.ok, false);
  assert.equal(again.code, "timeout");
  assert.ok(Date.now() - started < 200);
});

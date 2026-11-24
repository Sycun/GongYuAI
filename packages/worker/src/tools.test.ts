import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { openHistory } from "@gongyuai/history";
import {
  appendProgress,
  assertCommandAllowed,
  extractHosts,
  hostInTargets,
  runShell,
  mcpActionForServer,
  type ToolContext,
} from "./tools.js";
import { writeTerminalReport } from "./report.js";
import { parseShellOutput } from "./tool-output.js";
import { openMcpHub } from "./mcp/client.js";
import { openSkillHub } from "./skills/runtime.js";
import { runAssetSearch } from "./asset-collectors.js";
import type { WorkerManifest } from "@gongyuai/contracts";

function manifest(targets: string[]): WorkerManifest {
  return {
    taskId: "11111111-1111-4111-8111-111111111111",
    dataDir: "/tmp",
    historyDb: "/tmp/h.sqlite",
    durableDb: "/tmp/d.sqlite",
    evidenceDir: "/tmp/e",
    workspaceDir: "/tmp/w",
    auth: {
      authorizationNote: "lab auth note for tests",
      targets,
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
    execution: { maxConcurrentExplores: 1, maxIntentsPerReason: 4, maxIntentsPerAssetRoot: 2, exploreTimeoutMs: 900_000, reasonLeaseMs: 120_000 },
    workerId: "w0",
    workerSlot: 0,
    commandConfirmation: "auto",
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
}

test("capability ladder blocks shell at observe", () => {
  const m = manifest(["example.com"]);
  m.auth.capability = "observe";
  assert.throws(() => assertCommandAllowed(m, "curl -s http://example.com"), /observe/);
  m.auth.capability = "scan";
  assert.doesNotThrow(() => assertCommandAllowed(m, "curl -s http://example.com"));
});

test("hostInTargets supports CIDR, wildcard, and exact host", () => {
  assert.equal(hostInTargets(["10.0.0.0/8"], "10.0.188.64"), true);
  assert.equal(hostInTargets(["10.0.0.0/8"], "11.0.0.1"), false);
  assert.equal(hostInTargets(["http://10.0.188.64"], "10.0.188.64"), true);
  assert.equal(hostInTargets(["*.example.com"], "api.example.com"), true);
  assert.equal(hostInTargets(["example.com"], "www.example.com"), true);
  assert.equal(hostInTargets(["*"], "1.2.3.4"), true);
  assert.equal(hostInTargets(["10.0.0.0/8"], "10.0.0.1", ["10.0.0.1"]), false);
});

test("extractHosts finds curl targets", () => {
  const hosts = extractHosts("curl -s http://10.0.188.64/login");
  assert.ok(hosts.includes("10.0.188.64"));
});

test("assertCommandAllowed denies host network mutation even with *", () => {
  assert.throws(
    () => assertCommandAllowed(manifest(["*"]), "sudo route add -net 10.0.0.0/8 -interface utun4"),
    /host network/,
  );
  assert.throws(
    () => assertCommandAllowed(manifest(["*"]), "networksetup -setwebproxy Wi-Fi 127.0.0.1 8080"),
    /host network/,
  );
});

test("assertCommandAllowed denies out-of-scope hosts", () => {
  assert.throws(
    () => assertCommandAllowed(manifest(["10.0.0.0/8"]), "curl -s https://example.com/"),
    /not in auth.targets/,
  );
  assert.doesNotThrow(() =>
    assertCommandAllowed(manifest(["10.0.0.0/8"]), "curl -s http://10.0.188.64/"),
  );
});

test("appendProgress mirrors into worker.log for Logs tab", () => {
  const root = mkdtempSync(join(tmpdir(), "gy-progress-"));
  const workspaceDir = join(root, "workspace");
  mkdirSync(workspaceDir, { recursive: true });
  try {
    appendProgress(workspaceDir, "phase=bootstrap");
    const progress = readFileSync(join(workspaceDir, "PROGRESS.md"), "utf8");
    const log = readFileSync(join(root, "worker.log"), "utf8");
    assert.match(progress, /- \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3} phase=bootstrap/);
    assert.match(log, /\[progress\].*phase=bootstrap/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("shell authorization and budget decisions are each audited once", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "gy-gate-"));
  const evidenceDir = join(root, "evidence");
  const workspaceDir = join(root, "workspace");
  mkdirSync(evidenceDir, { recursive: true });
  mkdirSync(workspaceDir, { recursive: true });
  const history = openHistory({
    dbPath: join(root, "history.sqlite"),
    evidenceDir,
  });
  t.after(() => {
    history.close();
    rmSync(root, { recursive: true, force: true });
  });
  const m = manifest(["example.com"]);
  m.taskId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  m.dataDir = root;
  m.workspaceDir = workspaceDir;
  m.evidenceDir = evidenceDir;
  m.auth.capability = "observe";
  const ctx: ToolContext = { manifest: m, history, usage: { toolCalls: 0, installs: 0 } };
  await assert.rejects(() => runShell(ctx, "printf allowed"), /observe/);
  const denied = history.listEvents(m.taskId).filter((e) => e.kind === "tool_gate");
  assert.equal(denied.length, 1);
  assert.equal(denied[0]!.payload.ok, false);

  m.auth.capability = "scan";
  assert.equal((await runShell(ctx, "printf allowed")).stdout, "allowed");
  m.budget.maxToolCalls = 2;
  await assert.rejects(() => runShell(ctx, "printf blocked"), /maxToolCalls/);
  const gates = history.listEvents(m.taskId).filter((e) => e.kind === "tool_gate");
  assert.equal(gates.length, 3);
  assert.equal(gates.filter((g) => g.payload.ok).length, 1);
  assert.ok(gates.some((g) => g.payload.reason === "maxToolCalls exceeded"));

  writeTerminalReport(m, history, {
    status: "budget_exhausted",
    reason: "maxToolCalls exceeded",
  });
  const report = readFileSync(join(root, "report.md"), "utf8");
  assert.match(report, /Status: budget_exhausted/);
  assert.match(report, /maxToolCalls exceeded/);

});

test("MCP aliases share authorization, scope and budget auditing with a local fixture", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "gy-mcp-gate-"));
  const m = manifest(["safe.invalid"]);
  m.dataDir = root;
  m.workspaceDir = join(root, "workspace");
  m.evidenceDir = join(root, "evidence");
  m.auth.capability = "observe";
  m.budget.maxToolCalls = 3;
  mkdirSync(m.workspaceDir);
  const history = openHistory({ dbPath: join(root, "history.sqlite"), evidenceDir: m.evidenceDir });
  t.after(() => {
    history.close();
    rmSync(root, { recursive: true, force: true });
  });
  writeFileSync(join(root, "mcp.json"), JSON.stringify({ binary: "/usr/bin/printf" }));
  m.mcpServers = [{
    id: "nmap",
    name: "Local fixture",
    transport: "builtin",
    rootDir: root,
    args: [],
    env: {},
  }];
  const ctx: ToolContext = { manifest: m, history, usage: { toolCalls: 0, installs: 0 } };
  const hub = await openMcpHub(m, ctx);
  try {
    assert.deepEqual(hub.enabledIds(), []);
    await assert.rejects(hub.enable("nmap", "test"), /observe/);
    await assert.rejects(runAssetSearch(ctx, { collectorId: "fixture", query: "test" }), /observe/);
    await assert.rejects(hub.call("mcp__nmap__run", { target: "safe.invalid" }), /observe/);
    m.auth.capability = "scan";
    await assert.rejects(hub.invoke("nmap", "run", { target: "safe.invalid" }), /未启用/);
    await hub.enable("nmap", "local fixture");
    await assert.rejects(hub.invoke("nmap", "run", { target: "outside.invalid" }), /scope/);
    assert.match(await hub.call("mcp__nmap__run", { target: "safe.invalid" }), /safe\.invalid/);
    assert.match(await hub.invoke("nmap", "run", { target: "safe.invalid" }), /safe\.invalid/);
    await assert.rejects(hub.call("mcp__nmap__run", { target: "safe.invalid" }), /maxToolCalls/);

    const events = history.listEvents(m.taskId).filter((e) => e.kind === "tool_gate");
    const calls = events.filter((e) => e.payload.tool === "mcp");
    assert.equal(calls.length, 6);
    assert.equal(calls.filter((e) => e.payload.ok).length, 2);
    assert.ok(events.some((e) => e.payload.tool === "asset_search" && e.payload.ok === false));
    assert.ok(calls.every((e) => e.payload.serverId === "nmap" && e.payload.toolName === "run"));
    assert.deepEqual(history.integrationUsage(m.taskId).rows, [
      { kind: "mcp", name: "nmap", method: "run", calls: 6, succeeded: 2, failed: 4 },
    ]);
  } finally {
    await hub.close();
  }
});

test("skill and MCP outcomes follow returned content and protocol status", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "gy-usage-outcomes-"));
  const m = manifest(["archive.invalid"]);
  m.dataDir = root;
  m.workspaceDir = root;
  m.evidenceDir = join(root, "evidence");
  m.skillPool = [{ id: "receipt", name: "收件复核", rootDir: root }];
  writeFileSync(join(root, "mcp.json"), JSON.stringify({ binary: "/usr/bin/printf", defaultFlags: "receipt%" }));
  m.mcpServers = [
    { id: "archive", name: "Archive", transport: "http", url: "http://archive.invalid", args: [], env: {} },
    { id: "local-receipt", name: "Receipt fixture", transport: "builtin", rootDir: root, args: [], env: {} },
  ];
  const history = openHistory({ dbPath: join(root, "history.sqlite"), evidenceDir: join(root, "evidence") });
  t.after(() => { history.close(); rmSync(root, { recursive: true, force: true }); });
  t.mock.method(globalThis, "fetch", async (_url: string, options: RequestInit) => {
    const { method } = JSON.parse(String(options.body));
    const result = method === "tools/list" ? { tools: [{ name: "read" }] }
      : { isError: true, content: [{ text: "receipt unavailable" }] };
    return Response.json({ result });
  });
  const ctx: ToolContext = { manifest: m, history, usage: { toolCalls: 0, installs: 0 } };
  const mcp = await openMcpHub(m, ctx);
  try {
    await assert.rejects(mcp.call("mcp__archive__read", {}), /审批/);
    const partial = JSON.parse(await mcp.invoke("local-receipt", "run", { target: "archive.invalid" }));
    assert.notEqual(partial.exitCode, 0);
    assert.equal(partial.stdout, "receipt");
    const skill = openSkillHub(m, history);
    skill.suggestForGoals();
    skill.routingTable();
    skill.load("receipt", "缺少文件");
    writeFileSync(join(root, "SKILL.md"), "# 收件复核");
    skill.load("receipt", "第一批");
    skill.load("receipt", "第二批");
    assert.deepEqual(history.integrationUsage(m.taskId).rows, [
      { kind: "mcp", name: "archive", method: "read", calls: 1, succeeded: 0, failed: 1 },
      { kind: "mcp", name: "local-receipt", method: "run", calls: 1, succeeded: 0, failed: 1 },
      { kind: "skill", name: "receipt", method: "", calls: 3, succeeded: 2, failed: 1 },
    ]);
  } finally {
    await mcp.close();
  }
});

test("repeated-command breaker blocks the same attempt but exempts polling", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "gy-repeat-"));
  const evidenceDir = join(root, "evidence");
  const workspaceDir = join(root, "workspace");
  mkdirSync(evidenceDir, { recursive: true });
  mkdirSync(workspaceDir, { recursive: true });
  const history = openHistory({
    dbPath: join(root, "history.sqlite"),
    evidenceDir,
  });
  t.after(() => {
    history.close();
    rmSync(root, { recursive: true, force: true });
  });
  const m = manifest(["example.com"]);
  m.taskId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  m.dataDir = root;
  m.workspaceDir = workspaceDir;
  m.evidenceDir = evidenceDir;
  m.auth.capability = "full";
  m.budget.maxToolCalls = 100;
  const ctx: ToolContext = { manifest: m, history, usage: { toolCalls: 0, installs: 0 } };

  const previous = process.env.GY_REPEAT_COMMAND_LIMIT;
  process.env.GY_REPEAT_COMMAND_LIMIT = "3";
  try {
    for (let i = 0; i < 3; i += 1) {
      assert.equal((await runShell(ctx, "printf repeat")).stdout, "repeat");
    }
    await assert.rejects(() => runShell(ctx, "printf repeat"), /repeat-guard/);
    // Different arguments are a different attempt.
    assert.equal((await runShell(ctx, "printf repeat-2")).stdout, "repeat-2");
    // Polling is exempt.
    for (let i = 0; i < 5; i += 1) {
      assert.equal((await runShell(ctx, "sleep 0")).exitCode, 0);
    }
    history.resetCommandAttempts(m.taskId, "test reset");
    assert.equal((await runShell(ctx, "printf repeat")).stdout, "repeat");
  } finally {
    if (previous === undefined) delete process.env.GY_REPEAT_COMMAND_LIMIT;
    else process.env.GY_REPEAT_COMMAND_LIMIT = previous;
  }
});

test("shell parser lane: machine-readable nmap is transported, free text gets a mandatory flag hint", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "gy-shell-parse-"));
  const evidenceDir = join(root, "evidence");
  const workspaceDir = join(root, "workspace");
  mkdirSync(evidenceDir, { recursive: true });
  mkdirSync(workspaceDir, { recursive: true });
  const history = openHistory({
    dbPath: join(root, "history.sqlite"),
    evidenceDir,
  });
  t.after(() => {
    history.close();
    rmSync(root, { recursive: true, force: true });
  });
  const m = manifest(["lab.example.com"]);
  m.taskId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
  m.dataDir = root;
  m.workspaceDir = workspaceDir;
  m.evidenceDir = evidenceDir;
  const ctx: ToolContext = { manifest: m, history, usage: { toolCalls: 0, installs: 0 } };

  const xml = `<?xml version="1.0"?>
<nmaprun scanner="nmap" args="nmap -oX - lab.example.com">
  <host><status state="up"/><address addr="lab.example.com" addrtype="ipv4"/>
    <ports><port protocol="tcp" portid="443"><state state="open"/><service name="https"/></port></ports>
  </host>
</nmaprun>`;
  const good = parseShellOutput(ctx, "nmap -oX - lab.example.com", xml);
  assert.match(good, /\[parser\] assets=1/);
  assert.equal(history.listAssets(m.taskId).length, 1);

  const bad = parseShellOutput(ctx, "nmap -sV lab.example.com", "PORT STATE SERVICE\n443/tcp open https");
  assert.match(bad, /mandatory/);
  assert.match(bad, /-oX -/);
});

test("per-MCP capability metadata drives the gate; missing binaries are marked unavailable", async (t) => {
  assert.equal(
    mcpActionForServer("sqlmap", {
      mcpPool: [{ id: "sqlmap", capability: "active-lab" }],
    } as unknown as WorkerManifest),
    "mcp-active",
  );
  assert.equal(
    mcpActionForServer("nmap", {
      mcpPool: [{ id: "nmap", capability: "scan" }],
    } as unknown as WorkerManifest),
    "mcp-scan",
  );

  const root = mkdtempSync(join(tmpdir(), "gy-mcp-health-"));
  const m = manifest(["health.invalid"]);
  m.dataDir = root;
  m.workspaceDir = join(root, "workspace");
  m.evidenceDir = join(root, "evidence");
  m.auth.capability = "active-lab";
  mkdirSync(m.workspaceDir);
  mkdirSync(m.evidenceDir, { recursive: true });
  const history = openHistory({ dbPath: join(root, "history.sqlite"), evidenceDir: m.evidenceDir });
  t.after(() => {
    history.close();
    rmSync(root, { recursive: true, force: true });
  });
  writeFileSync(join(root, "mcp.json"), JSON.stringify({ binary: "/nonexistent/dalfox" }));
  m.mcpServers = [{
    id: "dalfox",
    name: "Dalfox fixture",
    transport: "builtin",
    rootDir: root,
    binary: "/nonexistent/dalfox",
    capability: "active-lab",
    args: [],
    env: {},
  }];
  const ctx: ToolContext = { manifest: m, history, usage: { toolCalls: 0, installs: 0 } };
  const hub = await openMcpHub(m, ctx);
  try {
    assert.match(hub.catalogLines().join("\n"), /未安装/);
    await assert.rejects(hub.enable("dalfox", "health probe"), /二进制不存在/);
  } finally {
    await hub.close();
  }
});

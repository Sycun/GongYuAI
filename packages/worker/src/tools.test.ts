import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { openHistory } from "@gongyuai/history";
import {
  appendProgress,
  assertCommandAllowed,
  extractHosts,
  gateCommand,
  hostInTargets,
  type ToolContext,
} from "./tools.js";
import { writeTerminalReport } from "./report.js";
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
    goals: [],
    budget: {
      maxTokens: 1000,
      maxWallMs: 60_000,
      maxToolCalls: 10,
      maxInstalls: 2,
      relayTokenThreshold: 30_000,
      relayMinToolCalls: 2,
    },
    execution: { maxConcurrentExplores: 1 },
    workerId: "w0",
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
    assert.match(progress, /phase=bootstrap/);
    assert.match(log, /\[progress\].*phase=bootstrap/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("gateCommand audits deny and allow on History", () => {
  const root = mkdtempSync(join(tmpdir(), "gy-gate-"));
  const evidenceDir = join(root, "evidence");
  const workspaceDir = join(root, "workspace");
  mkdirSync(evidenceDir, { recursive: true });
  mkdirSync(workspaceDir, { recursive: true });
  const history = openHistory({
    dbPath: join(root, "history.sqlite"),
    evidenceDir,
  });
  const m = manifest(["example.com"]);
  m.taskId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  m.dataDir = root;
  m.workspaceDir = workspaceDir;
  m.evidenceDir = evidenceDir;
  m.auth.capability = "observe";
  const ctx: ToolContext = { manifest: m, history, usage: { toolCalls: 0, installs: 0 } };
  assert.throws(
    () =>
      gateCommand(ctx, "shell", "curl -s http://example.com", () =>
        assertCommandAllowed(m, "curl -s http://example.com"),
      ),
    /observe/,
  );
  const denied = history.listEvents(m.taskId).filter((e) => e.kind === "tool_gate");
  assert.equal(denied.length, 1);
  assert.equal(denied[0]!.payload.ok, false);

  m.auth.capability = "scan";
  gateCommand(ctx, "shell", "curl -s http://example.com", () =>
    assertCommandAllowed(m, "curl -s http://example.com"),
  );
  const gates = history.listEvents(m.taskId).filter((e) => e.kind === "tool_gate");
  assert.equal(gates.length, 2);
  // listEvents is newest-first
  assert.equal(gates[0]!.payload.ok, true);
  assert.equal(gates[1]!.payload.ok, false);

  writeTerminalReport(m, history, {
    status: "budget_exhausted",
    reason: "maxToolCalls exceeded",
  });
  const report = readFileSync(join(root, "report.md"), "utf8");
  assert.match(report, /Status: budget_exhausted/);
  assert.match(report, /maxToolCalls exceeded/);

  history.close();
  rmSync(root, { recursive: true, force: true });
});

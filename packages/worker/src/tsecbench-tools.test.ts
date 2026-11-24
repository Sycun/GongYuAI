import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { WorkerManifest } from "@gongyuai/contracts";
import { openHistory } from "@gongyuai/history";
import { boardClearPolicyBlock, hasBenchmarkHarness } from "./board-policy.js";
import { assertCommandAllowed } from "./tools.js";
import { autoAdmitContainerTargets, parseContainerAddresses } from "./tsecbench-tools.js";

function makeManifest(dir: string): WorkerManifest {
  return {
    taskId: "22222222-2222-4222-8222-222222222222",
    dataDir: dir,
    historyDb: join(dir, "history.sqlite"),
    durableDb: join(dir, "durable.sqlite"),
    evidenceDir: join(dir, "evidence"),
    workspaceDir: join(dir, "workspace"),
    auth: {
      authorizationNote: "",
      targets: ["10.0.100.58"],
      outOfScope: [],
      capability: "active-lab",
    },
    scopeVersion: 1,
    goals: [
      {
        id: "clear-board",
        title: "TSecBench 全部挑战清板",
        description: "clear all",
        evidencePatterns: ["ALL_COMPLETE.json"],
        passes: false,
        evidencePaths: [],
        assertedAt: null,
      },
    ],
    budget: {
      maxTokens: 0,
      maxWallMs: 0,
      maxToolCalls: 0,
      maxInstalls: 0,
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
    workerCount: 1,
    commandConfirmation: "auto",
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

test("autoAdmitContainerTargets admits dynamic target into manifest, generic CP sidecar, and History live assets", () => {
  const dir = mkdtempSync(join(tmpdir(), "gy-tsec-admit-"));
  const m = makeManifest(dir);
  writeFileSync(join(dir, "manifest.json"), JSON.stringify(m, null, 2));
  const history = openHistory({ dbPath: m.historyDb, evidenceDir: m.evidenceDir });
  try {
    const parsed = parseContainerAddresses("http://10.0.200.99:32888, 10.0.200.100:8080");
    assert.equal(parsed.length, 2);
    assert.equal(parsed[0]!.host, "10.0.200.99");

    assert.throws(() => assertCommandAllowed(m, "curl -s http://10.0.200.99:32888/"), /not in task targets/);

    const admitted = autoAdmitContainerTargets(
      { manifest: m, history, usage: { toolCalls: 0, installs: 0 } },
      "WEB-001",
      "http://10.0.200.99:32888",
    );
    assert.equal(admitted.length, 1);
    assert.doesNotThrow(() => assertCommandAllowed(m, "curl -s http://10.0.200.99:32888/"));

    const sidecar = JSON.parse(readFileSync(join(dir, "admitted-targets.json"), "utf8")) as string[];
    assert.ok(sidecar.includes("10.0.200.99"));

    const assets = history.listAssets(m.taskId);
    assert.ok(assets.some((a) => a.kind === "live" && a.address.includes("10.0.200.99")));
  } finally {
    history.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("boardClearPolicyBlock centers on root-cause vulnerability discovery and isolates benchmark adapters", () => {
  const dir = mkdtempSync(join(tmpdir(), "gy-policy-mode-"));
  const prevUrl = process.env.BENCHMARK_BASE_URL;
  const prevTok = process.env.BENCHMARK_TOKEN;
  delete process.env.BENCHMARK_BASE_URL;
  delete process.env.BENCHMARK_TOKEN;
  try {
    const engagement = makeManifest(dir);
    engagement.goals = [
      {
        id: "engagement-report",
        title: "企业授权渗透评估",
        description: "report",
        evidencePatterns: ["engagement/report.md"],
        passes: false,
        evidencePaths: [],
        assertedAt: null,
      },
    ];
    assert.equal(hasBenchmarkHarness(engagement), false);
    const engagementPolicy = boardClearPolicyBlock(engagement);
    assert.match(engagementPolicy, /深度漏洞挖掘纪律/);
    assert.match(engagementPolicy, /finding_verify/);
    assert.match(engagementPolicy, /compareWith/);
    assert.doesNotMatch(engagementPolicy, /tsecbench/);

    const benchmark = makeManifest(dir);
    assert.equal(hasBenchmarkHarness(benchmark), true);
    const benchmarkPolicy = boardClearPolicyBlock(benchmark);
    assert.match(benchmarkPolicy, /深度漏洞挖掘纪律/);
    assert.match(benchmarkPolicy, /外部靶场环境适配器说明/);
  } finally {
    if (prevUrl !== undefined) process.env.BENCHMARK_BASE_URL = prevUrl;
    if (prevTok !== undefined) process.env.BENCHMARK_TOKEN = prevTok;
    rmSync(dir, { recursive: true, force: true });
  }
});

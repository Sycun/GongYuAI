import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { WorkerManifest } from "@gongyuai/contracts";
import { openHistory } from "@gongyuai/history";
import { clearTrafficRing, closeTrafficDb, getTraffic, pushTrafficRing, trafficLabelUuid } from "@gongyuai/exec";
import { boardClearPolicyBlock, hasBenchmarkHarness } from "./board-policy.js";
import { assertCommandAllowed } from "./tools.js";
import {
  autoAdmitContainerTargets,
  captureSolveTraffic,
  parseContainerAddresses,
  resolveChallengeHosts,
  submitCorrect,
  tsecbenchTool,
} from "./tsecbench-tools.js";

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

test("tsecbench correct submit keeps the solve traffic window under tsecbench:<code>", () => {
  const dir = mkdtempSync(join(tmpdir(), "gy-tsec-solve-"));
  const m = makeManifest(dir);
  writeFileSync(join(dir, "manifest.json"), JSON.stringify(m, null, 2));
  const history = openHistory({ dbPath: m.historyDb, evidenceDir: m.evidenceDir });
  try {
    assert.equal(submitCorrect({ correct: true }), true);
    assert.equal(submitCorrect({ data: { correct: true } }), true);
    assert.equal(submitCorrect({ correct: false }), false);
    assert.equal(submitCorrect("ok"), false);

    const ctx = { manifest: m, history, usage: { toolCalls: 0, installs: 0 } };
    autoAdmitContainerTargets(ctx, "WEB-777", "http://10.0.200.77:32888");
    const push = (n: number, host: string) => pushTrafficRing(dir, {
      id: `77777777-7777-4777-8777-${String(n).padStart(12, "0")}`,
      write: {
        taskId: m.taskId,
        method: "GET",
        url: `http://${host}:32888/flag`,
        host,
        path: "/flag",
        status: 200,
        durationMs: 2,
        startedAt: new Date().toISOString(),
        reqHeaders: {},
        resHeaders: { "content-type": "text/plain" },
      },
      resBody: { head: Buffer.from(`flag-${n}`), size: 6, sha256: "2".repeat(64) },
    });
    push(1, "10.0.200.77");
    push(2, "10.0.200.88");

    const kept = captureSolveTraffic(ctx, "WEB-777");
    assert.ok(kept);
    assert.equal(kept.label, "tsecbench:WEB-777");
    assert.equal(kept.findingId, trafficLabelUuid("tsecbench:WEB-777"));
    assert.deepEqual(kept.trafficIds, ["77777777-7777-4777-8777-000000000001"]);
    assert.deepEqual(getTraffic(dir, kept.trafficIds[0]!)?.findingIds, [kept.findingId]);
    // Unknown code falls back to the most recent challenge host.
    const fallback = captureSolveTraffic(ctx, "UNKNOWN");
    assert.equal(fallback?.findingId, trafficLabelUuid("tsecbench:UNKNOWN"));
    assert.deepEqual(fallback?.trafficIds, ["77777777-7777-4777-8777-000000000001"]);
    assert.equal(getTraffic(dir, "77777777-7777-4777-8777-000000000002"), null);
  } finally {
    clearTrafficRing(dir);
    closeTrafficDb(dir);
    history.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("multi-worker follower cannot start/close tsecbench containers so slot 0 leader owns the 3-slot cap", async () => {
  const dir = mkdtempSync(join(tmpdir(), "gy-tsec-role-"));
  const follower = makeManifest(dir);
  follower.workerId = "w1";
  follower.workerSlot = 1;
  follower.workerCount = 4;
  const history = openHistory({ dbPath: follower.historyDb, evidenceDir: follower.evidenceDir });
  try {
    const startRes = JSON.parse(
      await tsecbenchTool({ manifest: follower, history, usage: { toolCalls: 0, installs: 0 } }, { action: "start", code: "a-01" }),
    ) as { error?: string };
    assert.equal(startRes.error, "leader_owns_container_lifecycle");
    const closeRes = JSON.parse(
      await tsecbenchTool({ manifest: follower, history, usage: { toolCalls: 0, installs: 0 } }, { action: "close", code: "a-01" }),
    ) as { error?: string };
    assert.equal(closeRes.error, "leader_owns_container_lifecycle");

    // Cross-process sync: leader admits an out-of-initial-CIDR host (172.18.0.55) for WEB-999;
    // a separate follower manifest picks up both command authorization AND challenge host mapping via sidecars.
    const leader = makeManifest(dir);
    leader.workerCount = 4;
    autoAdmitContainerTargets(
      { manifest: leader, history, usage: { toolCalls: 0, installs: 0 } },
      "WEB-999",
      "http://172.18.0.55:8080",
    );
    const freshFollower = makeManifest(dir);
    freshFollower.workerId = "w2";
    freshFollower.workerSlot = 2;
    freshFollower.workerCount = 4;
    assert.deepEqual(freshFollower.auth.targets, ["10.0.100.58"]);
    assert.doesNotThrow(() => assertCommandAllowed(freshFollower, "curl -s http://172.18.0.55:8080/"));
    assert.deepEqual(
      resolveChallengeHosts({ manifest: freshFollower, history, usage: { toolCalls: 0, installs: 0 } }, "WEB-999"),
      ["172.18.0.55"],
    );
  } finally {
    history.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

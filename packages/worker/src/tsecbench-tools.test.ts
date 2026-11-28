import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { WorkerManifest } from "@gongyuai/contracts";
import { openHistory } from "@gongyuai/history";
import { clearTrafficRing, closeTrafficDb, getTraffic, pushTrafficRing, trafficLabelUuid } from "@gongyuai/exec";
import { boardClearPolicyBlock, hasBenchmarkHarness } from "./board-policy.js";
import { CheckpointStore } from "./checkpoint.js";
import { handleGraphTool } from "./graph-phase.js";
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

test("OpenAPI string[] container_addr auto-admits live assets, unblocks Leader intent_propose assetRoot, and drops recycled IPs on restart", async () => {
  const dir = mkdtempSync(join(tmpdir(), "gy-tsec-array-"));
  const leader = makeManifest(dir);
  leader.auth.targets = ["10.0.0.0/8"];
  leader.workerCount = 4;
  writeFileSync(join(dir, "manifest.json"), JSON.stringify(leader, null, 2));

  const history = openHistory({ dbPath: leader.historyDb, evidenceDir: leader.evidenceDir });
  const ckpt = new CheckpointStore(join(dir, "leader.ckpt.sqlite"));
  const prevUrl = process.env.BENCHMARK_BASE_URL;
  const prevTok = process.env.BENCHMARK_TOKEN;
  const origFetch = globalThis.fetch;
  process.env.BENCHMARK_BASE_URL = "http://10.0.100.1:8000";
  process.env.BENCHMARK_TOKEN = "test-benchmark-token";

  let startedIp = "10.0.1.5:8080";
  globalThis.fetch = (async (input: string | URL | Request) => {
    const u = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (u.includes("/openapi/v1/challenges/start")) {
      return new Response(
        JSON.stringify({
          unique_code: "web_sql_injection_01",
          container_addr: [startedIp, "[fd00::1]:9090"],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    return new Response(
      JSON.stringify([
        {
          unique_code: "web_sql_injection_01",
          difficulty: "easy",
          total_score: 100,
          flag_count: 1,
          correct_flag_count: 0,
          is_completed: false,
          container_status: "available",
          container_addr: [startedIp],
        },
      ]),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as typeof fetch;

  try {
    // 1. Direct unit checks on array / JSON-array / object-wrapped shapes
    assert.deepEqual(parseContainerAddresses(["10.0.1.5:8080", "http://10.0.1.6:8081/app"]), [
      { endpoint: "10.0.1.5:8080", host: "10.0.1.5" },
      { endpoint: "http://10.0.1.6:8081/app", host: "10.0.1.6" },
    ]);
    assert.deepEqual(parseContainerAddresses('["10.0.1.7:80"]'), [
      { endpoint: "10.0.1.7:80", host: "10.0.1.7" },
    ]);
    assert.deepEqual(parseContainerAddresses([{ addr: "10.0.1.8:8080" }]), [
      { endpoint: "10.0.1.8:8080", host: "10.0.1.8" },
    ]);

    history.seedGoals(leader.taskId, leader.goals);
    history.seedAssetsFromAuth(leader.taskId, leader.auth);
    const state = ckpt.load();
    state.phase = "bootstrap";
    ckpt.save(state);

    const ctx = { manifest: leader, history, usage: { toolCalls: 0, installs: 0 } };
    const startRaw = await tsecbenchTool(ctx, { action: "start", code: "web_sql_injection_01" });
    const startOut = JSON.parse(startRaw) as {
      autoAdmittedAssets?: Array<{ address: string; factId: string }>;
    };
    assert.ok(startOut.autoAdmittedAssets && startOut.autoAdmittedAssets.length >= 1);
    assert.equal(startOut.autoAdmittedAssets[0]!.address, "10.0.1.5");

    // 2. Multi-worker Leader can immediately propose an Intent anchored on "10.0.1.5:8080" even with sourceFactIds="origin"
    const proposeOut = handleGraphTool(
      "intent_propose",
      {
        title: "Explore web_sql_injection_01",
        summary: "Verify SQLi on container",
        assetRoot: "10.0.1.5:8080",
        sourceFactIds: "origin",
      },
      {
        history,
        taskId: leader.taskId,
        workspaceDir: leader.workspaceDir,
        state,
        workerId: leader.workerId,
        execution: leader.execution,
        leader: true,
        workerCount: 4,
        save: () => ckpt.save(state),
      },
    );
    assert.ok(proposeOut && !proposeOut.startsWith("错误:"), `expected intent JSON, got: ${proposeOut}`);
    const proposedIntent = JSON.parse(proposeOut!) as { id: string; assetRoot?: string; status: string };
    assert.equal(proposedIntent.assetRoot, "10.0.1.5");
    assert.equal(proposedIntent.status, "proposed");

    // 3. Restarting the same challenge with a newly assigned container IP drops the old recycled IP
    startedIp = "10.0.1.99:8080";
    await tsecbenchTool(ctx, { action: "start", code: "web_sql_injection_01" });
    const hostsAfterRestart = resolveChallengeHosts(ctx, "web_sql_injection_01");
    assert.ok(hostsAfterRestart.includes("10.0.1.99"));
    assert.ok(!hostsAfterRestart.includes("10.0.1.5"));

    // 4. Grey-box scope-brief, recycled IP boundary Fact. start/list must NOT unlock foothold-private.
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify([
          {
            unique_code: "a-11",
            title: "企业办公系统",
            description: "2008年老旧OA系统。预置测试账号工号：2001，密码：Sys@Oa123",
            difficulty: "hard",
            total_score: 500,
            flag_count: 1,
            correct_flag_count: 0,
            is_completed: false,
            container_status: "running",
            container_addr: ["10.0.1.99:80"],
          },
          {
            unique_code: "e1-04",
            title: "未启动靶机",
            description: "某业务系统在边界部署了带检测能力的反向代理过滤请求",
            difficulty: "medium",
            total_score: 200,
            flag_count: 1,
            correct_flag_count: 0,
            is_completed: false,
            container_status: "stopped",
            container_addr: [],
          },
        ]),
        { status: 200, headers: { "content-type": "application/json" } },
      )) as typeof fetch;

    const listRaw = await tsecbenchTool(ctx, { action: "list" });
    const listItems = JSON.parse(listRaw) as Array<{ code: string; description?: string; title?: string }>;
    assert.equal(listItems[0]?.code, "a-11");
    assert.match(listItems[0]?.description ?? "", /2001.*Sys@Oa123/);

    const facts = history.listFacts(leader.taskId);
    const brief = facts.find((f) => f.tags.includes("scope-brief") && f.tags.includes("challenge:a-11"));
    assert.ok(brief, "scope-brief Fact must be created with preset grey-box credentials");
    assert.match(brief.summary, /Sys@Oa123/);
    const boundary = facts.find((f) => f.tags.includes("instance-boundary") && f.tags.includes("challenge:a-11"));
    assert.ok(boundary, "recycled IP 10.0.1.99 must record an instance-boundary Fact");
    const unstartedBrief = facts.find((f) => f.tags.includes("challenge:e1-04"));
    assert.equal(unstartedBrief, undefined, "unstarted challenge with empty container_addr [] must NOT create orphan scope-brief Fact");

    assert.equal(existsSync(join(dir, "admitted-pivot.json")), false);
    const follower = makeManifest(dir);
    follower.workerSlot = 1;
    follower.workerCount = 4;
    assert.throws(
      () => assertCommandAllowed(follower, "proxychains curl -s http://172.19.0.4:8080/"),
      /not in task targets|越界|denied/,
    );

    // 5. HTTP 409 already finished writes environment-terminal sidecar and blocks post-window intent_propose drift
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({ code: "invalid_state", message: "task task_202611pnxk28u19i already finished" }),
        { status: 409, headers: { "content-type": "application/json" } },
      )) as typeof fetch;

    const termRaw = await tsecbenchTool(ctx, { action: "list" });
    const termJson = JSON.parse(termRaw) as { error?: string; terminal?: boolean; evidencePath?: string };
    assert.equal(termJson.error, "environment_terminal");
    assert.equal(termJson.terminal, true);
    assert.equal(existsSync(join(dir, "environment-terminal.json")), true);
    assert.equal(existsSync(join(leader.evidenceDir, "tsecbench/task-terminal.json")), true);

    const blockedPropose = handleGraphTool(
      "intent_propose",
      {
        title: "Post-stop TeX QA drift",
        summary: "Mutate verify-all.sh",
        assetRoot: "10.0.1.99",
        sourceFactIds: "origin",
      },
      {
        history,
        taskId: leader.taskId,
        workspaceDir: leader.workspaceDir,
        trafficDir: leader.dataDir,
        state,
        workerId: leader.workerId,
        execution: leader.execution,
        leader: true,
        workerCount: 4,
        save: () => ckpt.save(state),
      },
    );
    assert.match(blockedPropose ?? "", /目标环境已进入终态.*禁止再派发/);
  } finally {
    globalThis.fetch = origFetch;
    if (prevUrl === undefined) delete process.env.BENCHMARK_BASE_URL;
    else process.env.BENCHMARK_BASE_URL = prevUrl;
    if (prevTok === undefined) delete process.env.BENCHMARK_TOKEN;
    else process.env.BENCHMARK_TOKEN = prevTok;
    ckpt.close();
    history.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { WorkerManifest } from "@gongyuai/contracts";
import { openHistory } from "@gongyuai/history";
import {
  canRelay,
  countRelayableCalls,
  formatGateSpinRecoveryHint,
  formatRelayInjection,
  listRelayProtocols,
  midSubmissionRelayGate,
  relayHardResetEnabled,
  relaySnapshotStepInterval,
  shouldSnapshotRelay,
  writeRelayProtocol,
} from "./relay.js";

function manifest(workspaceDir: string): WorkerManifest {
  return {
    taskId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    dataDir: workspaceDir,
    historyDb: join(workspaceDir, "h.sqlite"),
    durableDb: join(workspaceDir, "d.sqlite"),
    evidenceDir: join(workspaceDir, "evidence"),
    workspaceDir,
    auth: {
      authorizationNote: "relay unit test auth note",
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
      relayTokenThreshold: 100,
      relayMinToolCalls: 2,
    },
    execution: { maxConcurrentExplores: 1, maxIntentsPerReason: 4, maxIntentsPerAssetRoot: 2, exploreTimeoutMs: 900_000, reasonLeaseMs: 120_000 },
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

test("canRelay enforces min tool calls then auto threshold", () => {
  const prevMin = process.env.GY_RELAY_MIN_TOOL_CALLS;
  const prevThr = process.env.GY_RELAY_TOKEN_THRESHOLD;
  delete process.env.GY_RELAY_MIN_TOOL_CALLS;
  delete process.env.GY_RELAY_TOKEN_THRESHOLD;
  const m = manifest("/tmp");
  assert.equal(
    canRelay({
      manifest: m,
      tokensSinceRelay: 999,
      toolCallsSinceRelay: 0,
      forceAgent: true,
    }).ok,
    false,
  );
  assert.equal(
    canRelay({
      manifest: m,
      tokensSinceRelay: 50,
      toolCallsSinceRelay: 2,
      forceAgent: false,
    }).ok,
    false,
  );
  const auto = canRelay({
    manifest: m,
    tokensSinceRelay: 100,
    toolCallsSinceRelay: 2,
    forceAgent: false,
  });
  assert.equal(auto.ok, true);
  if (auto.ok) assert.equal(auto.trigger, "auto");
  const agent = canRelay({
    manifest: m,
    tokensSinceRelay: 1,
    toolCallsSinceRelay: 2,
    forceAgent: true,
  });
  assert.equal(agent.ok, true);
  if (agent.ok) assert.equal(agent.trigger, "agent");
  if (prevMin !== undefined) process.env.GY_RELAY_MIN_TOOL_CALLS = prevMin;
  else delete process.env.GY_RELAY_MIN_TOOL_CALLS;
  if (prevThr !== undefined) process.env.GY_RELAY_TOKEN_THRESHOLD = prevThr;
  else delete process.env.GY_RELAY_TOKEN_THRESHOLD;
});

test("writeRelayProtocol appends πn.json and injection lists foothold", () => {
  const root = mkdtempSync(join(tmpdir(), "gy-relay-"));
  const m = manifest(root);
  const history = openHistory({
    dbPath: m.historyDb,
    evidenceDir: m.evidenceDir,
  });
  try {
    const p0 = writeRelayProtocol(m, history, {
      trigger: "agent",
      reason: "foothold",
      foothold: "ssh user@10.0.0.5",
      unexplored_surface: "10.0.0.6:445",
      tokens: 10,
      toolCalls: 3,
      generation: 0,
    });
    assert.equal(p0.generation, 0);
    assert.equal(p0.foothold, "ssh user@10.0.0.5");
    const listed = listRelayProtocols(root);
    assert.equal(listed.length, 1);
    const text = formatRelayInjection(listed);
    assert.match(text, /foothold: ssh user@10\.0\.0\.5/);
    assert.match(text, /unexplored_surface: 10\.0\.0\.6:445/);

    for (let g = 1; g <= 5; g++) {
      writeRelayProtocol(m, history, {
        trigger: "auto",
        reason: `gen-${g}`,
        foothold: `host-${g}`,
        unexplored_surface: `port-${g}`,
        tokens: g * 100,
        toolCalls: g * 3,
        generation: g,
      });
    }
    const bounded = formatRelayInjection(listRelayProtocols(root));
    assert.match(bounded, /早期交接摘要（π0\.\.π2，共 3 代已折叠）/);
    assert.match(bounded, /### π5 · auto · gen-5/);
    assert.doesNotMatch(bounded, /### π0 · agent/);

    // Multi-worker follower slots write into isolated relay-w<slot>/ directories (never clobbering slot 0).
    const m1 = { ...m, workerId: "w1", workerSlot: 1, workerCount: 4 };
    writeRelayProtocol(m1, history, {
      trigger: "agent",
      reason: "follower-1",
      foothold: "10.0.0.99",
      tokens: 42,
      toolCalls: 4,
      generation: 0,
    });
    assert.equal(listRelayProtocols(root, 0).length, 6);
    assert.equal(listRelayProtocols(root, 1).length, 1);
    assert.equal(listRelayProtocols(root, 1)[0]?.foothold, "10.0.0.99");
    assert.equal(listRelayProtocols(root, 0)[0]?.foothold, "ssh user@10.0.0.5");
  } finally {
    history.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("活会话长 turn：>2 工具调用且 >30k token 不触发 beforeTool 硬拦截（默认硬重置关闭）", () => {
  const prevHard = process.env.GY_RELAY_HARD_RESET;
  const prevMin = process.env.GY_RELAY_MIN_TOOL_CALLS;
  const prevThr = process.env.GY_RELAY_TOKEN_THRESHOLD;
  delete process.env.GY_RELAY_HARD_RESET;
  delete process.env.GY_RELAY_MIN_TOOL_CALLS;
  delete process.env.GY_RELAY_TOKEN_THRESHOLD;
  try {
    const m = manifest("/tmp");
    assert.equal(relayHardResetEnabled(), false);
    // Long session far exceeds the legacy 2-tool / 30k-token auto threshold.
    const auto = canRelay({
      manifest: m,
      tokensSinceRelay: 100_000,
      toolCallsSinceRelay: 8,
      forceAgent: false,
    });
    assert.equal(auto.ok, true);
    // Default live-session mode: the beforeTool gate never blocks, regardless of relayPending.
    assert.equal(
      midSubmissionRelayGate({ hardReset: false, relayPending: false, toolName: "shell" }),
      undefined,
    );
    assert.equal(
      midSubmissionRelayGate({ hardReset: false, relayPending: true, toolName: "shell" }),
      undefined,
    );
    // Explicit hard-reset mode (opt-in) still interrupts non-relay tools once pending.
    const blocked = midSubmissionRelayGate({ hardReset: true, relayPending: true, toolName: "shell" });
    assert.ok(blocked && /硬重置模式/.test(blocked.block));
    assert.equal(
      midSubmissionRelayGate({ hardReset: true, relayPending: true, toolName: "relay" }),
      undefined,
    );
    assert.equal(
      midSubmissionRelayGate({ hardReset: true, relayPending: true, toolName: "intent_conclude" }),
      undefined,
    );
    assert.equal(
      midSubmissionRelayGate({ hardReset: true, relayPending: true, toolName: "operator_consult" }),
      undefined,
    );
    // Blocked calls and relay itself never inflate toolCallsSinceRelay (prevents π8→π64 empty spin).
    assert.equal(countRelayableCalls(["intent_propose", "phase_set"], 2), 0);
    assert.equal(countRelayableCalls(["relay", "relay"], 0), 0);
    assert.equal(countRelayableCalls(["history_overview", "shell", "relay"], 1), 1);
    assert.match(
      formatGateSpinRecoveryHint({ phase: "reason", activeIntentId: null, leader: true, workerCount: 1 }),
      /intent_propose/,
    );
    process.env.GY_RELAY_HARD_RESET = "1";
    assert.equal(relayHardResetEnabled(), true);
  } finally {
    if (prevHard === undefined) delete process.env.GY_RELAY_HARD_RESET;
    else process.env.GY_RELAY_HARD_RESET = prevHard;
    if (prevMin === undefined) delete process.env.GY_RELAY_MIN_TOOL_CALLS;
    else process.env.GY_RELAY_MIN_TOOL_CALLS = prevMin;
    if (prevThr === undefined) delete process.env.GY_RELAY_TOKEN_THRESHOLD;
    else process.env.GY_RELAY_TOKEN_THRESHOLD = prevThr;
  }
});

test("后台 π 快照按步数节奏落盘，而非每 30k token；GY_DIFF_NO_RELAY 关闭", () => {
  const prevInt = process.env.GY_RELAY_SNAPSHOT_STEP_INTERVAL;
  const prevDiff = process.env.GY_DIFF_NO_RELAY;
  const prevMin = process.env.GY_RELAY_MIN_TOOL_CALLS;
  delete process.env.GY_RELAY_SNAPSHOT_STEP_INTERVAL;
  delete process.env.GY_DIFF_NO_RELAY;
  delete process.env.GY_RELAY_MIN_TOOL_CALLS;
  try {
    const m = manifest("/tmp");
    const interval = relaySnapshotStepInterval();
    assert.ok(interval >= 100); // default is a coarse step interval, not a per-turn token trigger
    // Below the step interval: no snapshot even with huge token accumulation.
    assert.equal(
      shouldSnapshotRelay({ manifest: m, step: interval - 1, lastSnapshotStep: 0, toolCallsSinceRelay: 999 }),
      false,
    );
    // Reached the interval with enough activity: snapshot.
    assert.equal(
      shouldSnapshotRelay({ manifest: m, step: interval, lastSnapshotStep: 0, toolCallsSinceRelay: 5 }),
      true,
    );
    // Interval measured from the last snapshot, not absolute step.
    assert.equal(
      shouldSnapshotRelay({ manifest: m, step: interval + 10, lastSnapshotStep: interval, toolCallsSinceRelay: 5 }),
      false,
    );
    // Min-tool guard: an idle session does not snapshot.
    assert.equal(
      shouldSnapshotRelay({ manifest: m, step: interval * 2, lastSnapshotStep: 0, toolCallsSinceRelay: 0 }),
      false,
    );
    process.env.GY_RELAY_SNAPSHOT_STEP_INTERVAL = "40";
    assert.equal(relaySnapshotStepInterval(), 40);
    assert.equal(
      shouldSnapshotRelay({ manifest: m, step: 40, lastSnapshotStep: 0, toolCallsSinceRelay: 5 }),
      true,
    );
    process.env.GY_DIFF_NO_RELAY = "1";
    assert.equal(
      shouldSnapshotRelay({ manifest: m, step: 1000, lastSnapshotStep: 0, toolCallsSinceRelay: 5 }),
      false,
    );
  } finally {
    if (prevInt === undefined) delete process.env.GY_RELAY_SNAPSHOT_STEP_INTERVAL;
    else process.env.GY_RELAY_SNAPSHOT_STEP_INTERVAL = prevInt;
    if (prevDiff === undefined) delete process.env.GY_DIFF_NO_RELAY;
    else process.env.GY_DIFF_NO_RELAY = prevDiff;
    if (prevMin === undefined) delete process.env.GY_RELAY_MIN_TOOL_CALLS;
    else process.env.GY_RELAY_MIN_TOOL_CALLS = prevMin;
  }
});

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { openHistory } from "@gongyuai/history";
import type { WorkerManifest } from "@gongyuai/contracts";
import type { ToolContext } from "./tools.js";
import { CheckpointStore } from "./checkpoint.js";
import {
  SUPERVISOR_PULSE_COOLDOWN_MS,
  findAnomalousActiveIntents,
  poolTurnYieldDirective,
  waitForPoolTurn,
  type PoolSweepState,
} from "./loop-shared.js";

const TASK_ID = "99999999-9999-4999-8999-999999999999";
const NOW = Date.parse("2026-11-28T12:00:00.000Z");
const ago = (minutes: number) => new Date(NOW - minutes * 60_000).toISOString();

const intent = (
  id: string,
  overrides: Partial<{ status: string; createdAt: string; updatedAt: string; claimedAt: string | null }> = {},
) => ({
  id,
  status: "claimed",
  createdAt: ago(15),
  claimedAt: ago(3),
  updatedAt: ago(1),
  ...overrides,
});

const tx = (intentId: string, status: number, minutesAgo: number) => ({
  intentId,
  status,
  startedAt: ago(minutesAgo),
});

test("findAnomalousActiveIntents: error storms and silent spins wake the leader, with cooldowns", () => {
  const stormId = randomUUID();
  const stormTxs = [
    tx(stormId, 500, 6),
    tx(stormId, 502, 5),
    tx(stormId, 504, 4),
    tx(stormId, 403, 3),
    tx(stormId, 0, 2),
    tx(stormId, 500, 1),
  ];

  const hit = findAnomalousActiveIntents({
    activeIntents: [intent(stormId)],
    facts: [{ intentId: stormId, createdAt: ago(10) }],
    httpTransactions: stormTxs,
    recentAdvisories: [],
    nowMs: NOW,
    lastSupervisorWakeByIntent: new Map(),
  });
  assert.equal(hit.length, 1);
  assert.equal(hit[0]!.code, "error-storm");

  // Recent fact inside the 3-minute quiet window suppresses the storm hit.
  const quietMiss = findAnomalousActiveIntents({
    activeIntents: [intent(stormId)],
    facts: [{ intentId: stormId, createdAt: ago(1) }],
    httpTransactions: stormTxs,
    recentAdvisories: [],
    nowMs: NOW,
    lastSupervisorWakeByIntent: new Map(),
  });
  assert.equal(quietMiss.length, 0);

  // Per-intent 3-minute wake cooldown.
  const cooled = findAnomalousActiveIntents({
    activeIntents: [intent(stormId)],
    facts: [],
    httpTransactions: stormTxs,
    recentAdvisories: [],
    nowMs: NOW,
    lastSupervisorWakeByIntent: new Map([[stormId, NOW - 60_000]]),
  });
  assert.equal(cooled.length, 0);

  // An advisory already sent to this intent inside 3 minutes also cools it.
  const advised = findAnomalousActiveIntents({
    activeIntents: [intent(stormId)],
    facts: [],
    httpTransactions: stormTxs,
    recentAdvisories: [{ targetIntentId: stormId, createdAt: ago(1) }],
    nowMs: NOW,
    lastSupervisorWakeByIntent: new Map(),
  });
  assert.equal(advised.length, 0);

  // After the cooldown expires it fires again.
  const rewoken = findAnomalousActiveIntents({
    activeIntents: [intent(stormId)],
    facts: [],
    httpTransactions: stormTxs,
    recentAdvisories: [],
    nowMs: NOW,
    lastSupervisorWakeByIntent: new Map([[stormId, NOW - SUPERVISOR_PULSE_COOLDOWN_MS - 1]]),
  });
  assert.equal(rewoken.length, 1);

  // Silent spin: 7 minutes since claim with zero Facts MUST fire even when `updatedAt`
  // was just refreshed 10s ago by live `heartbeatIntent` tool calls!
  const spinId = randomUUID();
  const spin = findAnomalousActiveIntents({
    activeIntents: [intent(spinId, { claimedAt: ago(7), updatedAt: ago(0.2) })],
    facts: [],
    httpTransactions: [],
    recentAdvisories: [],
    nowMs: NOW,
    lastSupervisorWakeByIntent: new Map(),
  });
  assert.equal(spin.length, 1);
  assert.equal(spin[0]!.code, "silent-spin");

  const spinWithFact = findAnomalousActiveIntents({
    activeIntents: [intent(spinId, { claimedAt: ago(7), updatedAt: ago(0.2) })],
    facts: [{ intentId: spinId, createdAt: ago(2) }],
    httpTransactions: [],
    recentAdvisories: [],
    nowMs: NOW,
    lastSupervisorWakeByIntent: new Map(),
  });
  assert.equal(spinWithFact.length, 0);

  // Freshly claimed inside 6 minutes never counts as silent even if proposed 15m ago.
  const fresh = findAnomalousActiveIntents({
    activeIntents: [intent(spinId, { createdAt: ago(15), claimedAt: ago(2), updatedAt: ago(0.2) })],
    facts: [],
    httpTransactions: [],
    recentAdvisories: [],
    nowMs: NOW,
    lastSupervisorWakeByIntent: new Map(),
  });
  assert.equal(fresh.length, 0);
});

test("poolTurnYieldDirective lets a pulse-woken leader run at most its supervision budget", () => {
  const open = [
    { id: "i1", status: "claimed" },
    { id: "i2", status: "claimed" },
  ];
  const base = {
    leader: true,
    workerCount: 3,
    phase: "reason",
    activeIntentId: null,
    openIntents: open,
    allGoalsPass: false,
  };
  assert.match(
    poolTurnYieldDirective({ ...base, toolName: "engagement_audit", supervisionBudget: 0 }) ?? "",
    /YIELD/,
  );
  assert.equal(
    poolTurnYieldDirective({ ...base, toolName: "engagement_audit", supervisionBudget: 1 }),
    undefined,
  );
  assert.equal(
    poolTurnYieldDirective({ ...base, toolName: "history_overview", supervisionBudget: 2 }),
    undefined,
  );
  assert.match(
    poolTurnYieldDirective({ ...base, toolName: "intent_propose", supervisionBudget: 2 }) ?? "",
    /YIELD/,
    "督导预算不得放大到派单/其它工具",
  );
});

test("waitForPoolTurn wakes a saturated leader on an anomalous follower pulse", async () => {
  const root = mkdtempSync(join(tmpdir(), "gy-pulse-"));
  const evidenceDir = join(root, "evidence");
  mkdirSync(evidenceDir, { recursive: true });
  const history = openHistory({ dbPath: join(root, "history.sqlite"), evidenceDir });
  const store = new CheckpointStore(join(root, "durable.sqlite"));
  try {
    const leaderManifest: WorkerManifest = {
      taskId: TASK_ID,
      engagementId: "eng-pulse",
      dataDir: root,
      historyDb: join(root, "history.sqlite"),
      durableDb: join(root, "durable.sqlite"),
      evidenceDir,
      workspaceDir: join(root, "workspace"),
      auth: {
        authorizationNote: "pulse fixture",
        targets: ["10.0.0.0/24"],
        outOfScope: [],
        capability: "active-lab",
      },
      scopeVersion: 1,
      goals: [],
      budget: { maxTokens: 0, maxWallMs: 0, maxToolCalls: 0, maxInstalls: 0, relayTokenThreshold: 30_000, relayMinToolCalls: 2 },
      execution: { maxConcurrentExplores: 2, maxIntentsPerReason: 4, maxIntentsPerAssetRoot: 2, exploreTimeoutMs: 900_000, reasonLeaseMs: 120_000 },
      commandConfirmation: "auto",
      workerId: "w0-leader",
      workerSlot: 0,
      workerCount: 2,
      mock: false,
      mcpServers: [],
      mcpPool: [],
      mcpCatalog: [],
      skillPacks: [],
      skillPool: [],
      skillCatalog: [],
      assetCollectors: [],
    };
    const ctx: ToolContext = { manifest: leaderManifest, history, usage: { toolCalls: 0, installs: 0 } };
    const asset = history.recordAsset({
      taskId: TASK_ID,
      address: "10.0.0.5",
      auth: leaderManifest.auth,
      live: true,
    }).fact;
    const open = history.proposeIntent({
      taskId: TASK_ID,
      title: "follower stuck in error storm",
      sourceFactIds: [asset.id],
      technique: "web-login-probe",
      assetRoot: "10.0.0.5",
    });
    history.claimIntent(TASK_ID, open.id, "w1-follower");
    const statuses = [500, 502, 504, 403, 0, 500];
    const pulseInputs: Array<{ intentId: string; status: number; startedAt: string }> = [];
    for (let i = 0; i < statuses.length; i += 1) {
      const startedAt = new Date(Date.now() - (6 - i) * 1_000).toISOString();
      pulseInputs.push({ intentId: open.id, status: statuses[i]!, startedAt });
      history.recordHttpTransaction({
        taskId: TASK_ID,
        intentId: open.id,
        method: "POST",
        url: `http://10.0.0.5/login?attempt=${i}`,
        host: "10.0.0.5",
        path: `/login?attempt=${i}`,
        status: statuses[i]!,
        requestSha256: randomUUID().replace(/-/g, "").padEnd(64, "0"),
        responseSha256: randomUUID().replace(/-/g, "").padEnd(64, "0"),
        requestPath: `http/${i}.req.txt`,
        responsePath: `http/${i}.res.txt`,
        requestBytes: 10,
        responseBytes: 10,
        responseHead: "",
        truncated: false,
        redirects: [],
        note: "",
        startedAt,
        durationMs: 5,
      });
    }

    const state = store.load();
    state.phase = "reason";
    const lastStaleSweep: PoolSweepState = {
      at: Date.now(),
      // Pretend the refill signature was already observed so the regular wake is a no-op.
      lastRefillActiveKey: `${open.id}#0`,
      lastPulseCheckAt: 0,
    };
    const decision = await waitForPoolTurn({
      manifest: leaderManifest,
      ctx,
      state,
      workerStartedAt: Date.now(),
      readPoolSize: () => 2,
      lastStaleSweep,
    });
    assert.equal(decision, "ready");
    assert.equal(lastStaleSweep.supervisionRequested, true);
    assert.match(state.pendingSoftPaceMessage ?? "", /督导脉搏/);
    assert.match(state.pendingSoftPaceMessage ?? "", /error-storm|0\/500\/502\/504\/403|HTTP/);
    assert.equal(lastStaleSweep.lastSupervisorWakeByIntent?.get(open.id) !== undefined, true);

    // Inside the wake cooldown the same follower no longer raises a pulse, so the
    // park loop would sleep again instead of spin-waking the leader.
    const cooled = findAnomalousActiveIntents({
      activeIntents: [
        { id: open.id, status: "claimed", createdAt: open.createdAt, updatedAt: open.updatedAt },
      ],
      facts: [],
      httpTransactions: pulseInputs,
      recentAdvisories: history.listRecentAdvisories(TASK_ID, 20),
      nowMs: Date.now(),
      lastSupervisorWakeByIntent: lastStaleSweep.lastSupervisorWakeByIntent!,
    });
    assert.deepEqual(cooled, []);
  } finally {
    store.close();
    history.close();
    rmSync(root, { recursive: true, force: true });
  }
});
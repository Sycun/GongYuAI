import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { ORIGIN_FACT_ID } from "@gongyuai/contracts";
import { openHistory } from "@gongyuai/history";
import { CheckpointStore, type CheckpointState } from "./checkpoint.js";
import { maybeForceEvidenceStall } from "./evidence-rotation.js";
import { handleGraphTool } from "./graph-phase.js";
import { appendNoteToToolResult } from "./long-turn.js";
import { renderPinnedDispatchContract } from "./prompt-builder.js";
import {
  EXPLORE_TIMEOUT_MIN_INTERVAL_MS,
  accountExploreTimeoutTurn,
  beginExploreTimeoutClock,
  evaluateEnvironmentTerminalExit,
  readEnvironmentTerminal,
  tryAutoClaimFollowerIntent,
  writeEnvironmentTerminal,
  type ExploreTimeoutClock,
} from "./loop-shared.js";

function clockCall(clock: ExploreTimeoutClock, step: number, now: number, active = "intent-1", drain: string | null = null) {
  return accountExploreTimeoutTurn({
    clock,
    step,
    now,
    phase: "explore",
    activeIntentId: active,
    drainIntentId: drain,
  });
}

test("explore timeout is due on a 30s gap or the 5th step, once per model turn", () => {
  const clock = beginExploreTimeoutClock(1_000);
  assert.equal(clockCall(clock, 0, 1_000), false);
  assert.equal(clockCall(clock, 0, 1_000), false);
  assert.equal(clockCall(clock, 1, 2_000), false);
  assert.equal(clockCall(clock, 2, 3_000), false);
  assert.equal(clockCall(clock, 3, 4_000), false);
  assert.equal(clockCall(clock, 4, 5_000), true);
  assert.equal(clockCall(clock, 4, 5_000), false);

  const timed = beginExploreTimeoutClock(10_000);
  assert.equal(clockCall(timed, 8, 10_000 + EXPLORE_TIMEOUT_MIN_INTERVAL_MS), true);
  assert.equal(clockCall(timed, 8, 10_000 + EXPLORE_TIMEOUT_MIN_INTERVAL_MS), false);
});

test("Soft Drain attaches 3/3 on the triggering tool result and parallel calls consume one step", () => {
  const root = mkdtempSync(join(tmpdir(), "gy-drain-turn-"));
  const history = openHistory({ dbPath: join(root, "h.sqlite"), evidenceDir: join(root, "evidence") });
  const prev = process.env.GY_EVIDENCE_STALL_MS;
  delete process.env.GY_EVIDENCE_STALL_MS;
  try {
    const taskId = "t-drain-turn";
    const intent = history.proposeIntent({
      taskId,
      title: "slow scan",
      sourceFactIds: [ORIGIN_FACT_ID],
      assetRoot: "10.9.9.9",
    });
    history.claimIntent(taskId, intent.id, "w1");
    const db = new DatabaseSync(join(root, "h.sqlite"));
    db.prepare("UPDATE intents SET created_at = ? WHERE id = ?").run(
      new Date(Date.now() - 20 * 60_000).toISOString(),
      intent.id,
    );
    db.close();
    const state: CheckpointState = {
      phase: "explore",
      step: 4,
      round: 1,
      bootEpoch: 1,
      toolCalls: 4,
      installs: 0,
      tokens: 0,
      relayGeneration: 0,
      lastRelaySnapshotStep: 0,
      tokensSinceRelay: 0,
      toolCallsSinceRelay: 0,
      activeIntentId: intent.id,
      activeIntentClaimedAt: null,
      lastSoftToolMilestone: 0,
      lastSoftWallMilestone: 0,
      toolsAtIntentClaim: 0,
      lastSoftSurfaceMilestone: 0,
      pendingSoftPaceMessage: null,
      observeFingerprint: {},
      drainIntentId: null,
      drainStepsRemaining: null,
      factDraft: null,
      lastError: null,
      updatedAt: new Date().toISOString(),
    };
    const now = Date.now();
    const clock = beginExploreTimeoutClock(now - EXPLORE_TIMEOUT_MIN_INTERVAL_MS);
    const deliver = (step: number) => {
      const due = accountExploreTimeoutTurn({
        clock,
        step,
        now,
        phase: state.phase,
        activeIntentId: state.activeIntentId,
        drainIntentId: state.drainIntentId ?? null,
        drainStepsRemaining: state.drainStepsRemaining ?? null,
      });
      if (!due) return null;
      const gate = maybeForceEvidenceStall({
        history,
        taskId,
        workerId: "w1",
        workspaceDir: root,
        state,
        drainSteps: 3,
        save: () => {},
        nowMs: now,
      });
      return appendNoteToToolResult(
        { output: [{ type: "text" as const, text: "scan output" }] },
        gate.message ?? "",
      );
    };
    const first = deliver(4);
    const parallelA = deliver(4);
    const parallelB = deliver(4);
    assert.equal(parallelA, null);
    assert.equal(parallelB, null);
    assert.equal(state.drainStepsRemaining, 3);
    const text = JSON.stringify(first);
    assert.match(text, /收尾保护窗 3\/3/);
    assert.match(text, /scan output/);
    const second = deliver(5);
    assert.match(JSON.stringify(second), /2\/3/);
    assert.equal(state.drainStepsRemaining, 2);
    const third = deliver(6);
    assert.match(JSON.stringify(third), /1\/3/);
    assert.equal(state.drainStepsRemaining, 1);
    // Final 1/3 turn defers inline hard-close to afterTools so sibling parallel calls (e.g. intent_conclude) finish cleanly!
    const finalTurnInline = deliver(7);
    assert.equal(finalTurnInline, null);
    assert.equal(history.getIntent(taskId, intent.id)?.status, "claimed");
  } finally {
    if (prev === undefined) delete process.env.GY_EVIDENCE_STALL_MS;
    else process.env.GY_EVIDENCE_STALL_MS = prev;
    history.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("evaluateEnvironmentTerminalExit parks followers immediately, waits for drain, and bounds leader to 1 finalization round", () => {
  const dir = mkdtempSync(join(tmpdir(), "gy-env-term-"));
  try {
    assert.equal(readEnvironmentTerminal(dir), null);
    assert.deepEqual(
      evaluateEnvironmentTerminalExit({
        terminal: null,
        leader: true,
        openIntentsCount: 0,
        activeIntentId: null,
        finalizationRoundsCompleted: 0,
      }),
      { shouldExit: false, runFinalizationRound: false },
    );

    const written = writeEnvironmentTerminal(dir, "409 task already finished", {
      source: "tsecbench",
      status: 409,
    });
    assert.ok(written?.terminal);
    assert.equal(readEnvironmentTerminal(dir)?.status, 409);

    // Idle follower exits immediately; busy follower finishes its active Intent first
    assert.deepEqual(
      evaluateEnvironmentTerminalExit({
        terminal: written,
        leader: false,
        openIntentsCount: 1,
        activeIntentId: "intent-in-flight",
        finalizationRoundsCompleted: 0,
      }),
      { shouldExit: false, runFinalizationRound: false },
    );
    assert.deepEqual(
      evaluateEnvironmentTerminalExit({
        terminal: written,
        leader: false,
        openIntentsCount: 0,
        activeIntentId: null,
        finalizationRoundsCompleted: 0,
      }),
      { shouldExit: true, runFinalizationRound: false },
    );

    // Leader waits while followers drain open Intents, runs 1 finalization round, then exits
    assert.deepEqual(
      evaluateEnvironmentTerminalExit({
        terminal: written,
        leader: true,
        openIntentsCount: 2,
        activeIntentId: null,
        finalizationRoundsCompleted: 0,
      }),
      { shouldExit: false, runFinalizationRound: false },
    );
    assert.deepEqual(
      evaluateEnvironmentTerminalExit({
        terminal: written,
        leader: true,
        openIntentsCount: 0,
        activeIntentId: null,
        finalizationRoundsCompleted: 0,
      }),
      { shouldExit: false, runFinalizationRound: true },
    );
    assert.deepEqual(
      evaluateEnvironmentTerminalExit({
        terminal: written,
        leader: true,
        openIntentsCount: 0,
        activeIntentId: null,
        finalizationRoundsCompleted: 1,
      }),
      { shouldExit: true, runFinalizationRound: false },
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("tryAutoClaimFollowerIntent pre-claims without race, pins DispatchContract, and intent_conclude defaults intentId to active card", () => {
  const dir = mkdtempSync(join(tmpdir(), "gy-preclaim-"));
  const history = openHistory({ dbPath: join(dir, "h.sqlite"), evidenceDir: join(dir, "evidence") });
  const ckpt1 = new CheckpointStore(join(dir, "w1.ckpt.sqlite"));
  const ckpt2 = new CheckpointStore(join(dir, "w2.ckpt.sqlite"));
  try {
    const taskId = "33333333-3333-4333-8333-333333333333";
    history.seedGoals(taskId, [
      {
        id: "clear-board",
        title: "Clear board",
        description: "clear",
        evidencePatterns: ["ALL.json"],
        passes: false,
        evidencePaths: [],
        assertedAt: null,
      },
    ]);
    const brief = history.appendFact({
      taskId,
      layer: "title",
      title: "委托简报 [a-11] OA 系统",
      summary: "预置测试账号：2001 / Sys@Oa123",
      tags: ["scope-brief", "challenge:a-11", "asset.addr:10.0.1.99"],
    });
    const intent = history.proposeIntent({
      taskId,
      title: "Verify OA preset login and IDOR",
      summary: "Login as 2001 and test /api/admin",
      sourceFactIds: [brief.id],
      assetRoot: "10.0.1.99",
      technique: "greybox-authz",
      assignedSurfaces: ["/login", "/api/admin"],
      mutexNote: "Only authz endpoints; leave binary port 9999 to slot 2",
    });

    const baseManifest = {
      taskId,
      dataDir: dir,
      historyDb: join(dir, "h.sqlite"),
      durableDb: join(dir, "d.sqlite"),
      evidenceDir: join(dir, "evidence"),
      workspaceDir: dir,
      auth: { authorizationNote: "", targets: ["10.0.0.0/8"], outOfScope: [], capability: "full" as const },
      scopeVersion: 1,
      goals: [],
      budget: { maxTokens: 0, maxWallMs: 0, maxToolCalls: 0, maxInstalls: 0, relayTokenThreshold: 30_000, relayMinToolCalls: 2 },
      execution: { maxConcurrentExplores: 10, maxIntentsPerReason: 14, maxIntentsPerAssetRoot: 4, exploreTimeoutMs: 900_000, reasonLeaseMs: 120_000 },
      workerId: "w1",
      workerSlot: 1,
      workerCount: 11,
      commandConfirmation: "auto" as const,
      mock: true,
      mcpServers: [],
      mcpPool: [],
      mcpCatalog: [],
      skillPacks: [],
      skillPool: [],
      skillCatalog: [],
      assetCollectors: [],
    };
    const s1 = ckpt1.load();
    const s2 = ckpt2.load();
    const claimedBy1 = tryAutoClaimFollowerIntent({
      manifest: baseManifest,
      ctx: { manifest: baseManifest, history, usage: { toolCalls: 0, installs: 0 } },
      state: s1,
      ckpt: ckpt1,
    });
    const claimedBy2 = tryAutoClaimFollowerIntent({
      manifest: { ...baseManifest, workerId: "w2", workerSlot: 2 },
      ctx: { manifest: { ...baseManifest, workerId: "w2", workerSlot: 2 }, history, usage: { toolCalls: 0, installs: 0 } },
      state: s2,
      ckpt: ckpt2,
    });

    assert.equal(claimedBy1, intent.id, "slot 1 wins pre-claim");
    assert.equal(s1.activeIntentId, intent.id);
    assert.equal(claimedBy2, null, "slot 2 loses CAS cleanly and stays parked with zero LLM turn");
    assert.equal(s2.activeIntentId, null);

    const pinned = renderPinnedDispatchContract(baseManifest, history, s1.activeIntentId);
    assert.match(pinned, /本卡派发契约/);
    assert.match(pinned, /Sys@Oa123/);
    assert.match(pinned, /\/api\/admin/);

    // Conclude WITHOUT passing intentId (auto-resolves from s1.activeIntentId!)
    const concludeRaw = handleGraphTool(
      "intent_conclude",
      {
        status: "failed",
        conclusion: "Tested 2001/Sys@Oa123 on /login -> 200 session cookie, /api/admin -> 403",
      },
      {
        history,
        taskId,
        workspaceDir: baseManifest.workspaceDir,
        state: s1,
        workerId: "w1",
        leader: false,
        workerCount: 11,
        save: () => ckpt1.save(s1),
      },
    );
    const concluded = JSON.parse(concludeRaw!) as { id: string; status: string };
    assert.equal(concluded.id, intent.id);
    assert.equal(concluded.status, "failed");
    assert.equal(s1.activeIntentId, null);
  } finally {
    ckpt1.close();
    ckpt2.close();
    history.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

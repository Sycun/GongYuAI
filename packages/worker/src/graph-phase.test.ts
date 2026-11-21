import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import { ORIGIN_FACT_ID } from "@gongyuai/contracts";
import { openHistory } from "@gongyuai/history";
import {
  allowedToolNames,
  asGraphPhase,
  handleGraphTool,
  syncGraphPhase,
} from "./graph-phase.js";
import type { CheckpointState } from "./checkpoint.js";

function tmpState(phase: CheckpointState["phase"] = "bootstrap"): CheckpointState {
  return {
    phase,
    step: 0,
    toolCalls: 0,
    installs: 0,
    tokens: 0,
    relayGeneration: 0,
    tokensSinceRelay: 0,
    toolCallsSinceRelay: 0,
    activeIntentId: null,
    activeIntentClaimedAt: null,
    lastSoftToolMilestone: 0,
    lastSoftWallMilestone: 0,
    lastError: null,
    updatedAt: new Date().toISOString(),
  };
}

test("syncGraphPhase enforces Reason mutex when open Intents exist", () => {
  const root = mkdtempSync(join(tmpdir(), "gy-phase-"));
  const history = openHistory({
    dbPath: join(root, "h.sqlite"),
    evidenceDir: join(root, "evidence"),
  });
  try {
    const taskId = "t1";
    history.seedGoals(taskId, [
      {
        id: "g1",
        title: "g",
        description: "d",
        evidencePatterns: ["x.txt"],
        passes: false,
        evidencePaths: [],
        assertedAt: null,
      },
    ]);
    history.proposeIntent({
      taskId,
      title: "probe",
      sourceFactIds: [ORIGIN_FACT_ID],
    });
    assert.equal(syncGraphPhase(history, taskId, "reason"), "explore");
    assert.equal(syncGraphPhase(history, taskId, "bootstrap"), "explore");
    assert.equal(asGraphPhase("loop"), "bootstrap");
  } finally {
    history.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("bootstrap tool allowlist excludes shell; explore includes it", () => {
  assert.equal(allowedToolNames("bootstrap").has("shell"), false);
  assert.equal(allowedToolNames("bootstrap").has("intent_propose"), true);
  assert.equal(allowedToolNames("bootstrap").has("asset_record"), true);
  assert.equal(allowedToolNames("bootstrap").has("asset_search"), true);
  assert.equal(allowedToolNames("explore").has("asset_list"), true);
  assert.equal(allowedToolNames("explore").has("asset_search"), true);
  assert.equal(allowedToolNames("explore").has("shell"), true);
  assert.equal(allowedToolNames("reason").has("shell"), false);
  assert.equal(allowedToolNames("reason").has("asset_search"), false);
  assert.equal(allowedToolNames("reason").has("assert_goal"), true);
});

test("intent_claim then conclude advances to reason when no open Intents", () => {
  const root = mkdtempSync(join(tmpdir(), "gy-phase-"));
  const history = openHistory({
    dbPath: join(root, "h.sqlite"),
    evidenceDir: join(root, "evidence"),
  });
  const state = tmpState("explore");
  try {
    const taskId = "t2";
    history.seedGoals(taskId, [
      {
        id: "g1",
        title: "g",
        description: "d",
        evidencePatterns: ["x.txt"],
        passes: false,
        evidencePaths: [],
        assertedAt: null,
      },
    ]);
    const intent = history.proposeIntent({
      taskId,
      title: "one",
      sourceFactIds: [ORIGIN_FACT_ID],
    });
    const ctx = {
      history,
      taskId,
      workspaceDir: root,
      state,
      save: () => {},
    };
    const claimed = handleGraphTool("intent_claim", { intentId: intent.id }, ctx);
    assert.ok(claimed && !claimed.startsWith("denied"));
    assert.equal(state.activeIntentId, intent.id);

    const deniedReason = handleGraphTool(
      "phase_set",
      { phase: "reason" },
      { ...ctx, state },
    );
    assert.match(deniedReason ?? "", /Reason 互斥/);

    const done = handleGraphTool(
      "intent_conclude",
      {
        intentId: intent.id,
        status: "succeeded",
        conclusion: "ok",
        factsJson: JSON.stringify([{ layer: "title", title: "found" }]),
      },
      ctx,
    );
    assert.ok(done && !done.startsWith("错误"));
    assert.equal(state.activeIntentId, null);
    assert.equal(state.phase, "reason");
  } finally {
    history.close();
    rmSync(root, { recursive: true, force: true });
  }
});

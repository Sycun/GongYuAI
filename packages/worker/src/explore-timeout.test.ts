import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import { ORIGIN_FACT_ID } from "@gongyuai/contracts";
import { openHistory } from "@gongyuai/history";
import type { CheckpointState } from "./checkpoint.js";
import { maybeForceExploreTimeout } from "./explore-timeout.js";

function state(partial: Partial<CheckpointState> = {}): CheckpointState {
  return {
    phase: "explore",
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
    toolsAtIntentClaim: null,
    lastSoftSurfaceMilestone: 0,
    pendingSoftPaceMessage: null,
    lastError: null,
    updatedAt: new Date().toISOString(),
    ...partial,
  };
}

test("maybeForceExploreTimeout concludes after wall timeout", () => {
  const root = mkdtempSync(join(tmpdir(), "gy-to-"));
  const history = openHistory({
    dbPath: join(root, "h.sqlite"),
    evidenceDir: join(root, "evidence"),
  });
  try {
    const taskId = "t-timeout";
    const intent = history.proposeIntent({
      taskId,
      title: "hang",
      sourceFactIds: [ORIGIN_FACT_ID],
    });
    history.claimIntent(taskId, intent.id, "w0");
    const claimedAt = new Date(Date.now() - 60_000).toISOString();
    const ckpt = state({
      activeIntentId: intent.id,
      activeIntentClaimedAt: claimedAt,
    });
    const result = maybeForceExploreTimeout({
      history,
      taskId,
      workerId: "w0",
      workspaceDir: root,
      state: ckpt,
      exploreTimeoutMs: 1_000,
      save: () => {},
    });
    assert.equal(result.concluded, true);
    assert.equal(ckpt.activeIntentId, null);
    assert.equal(ckpt.phase, "reason");
  } finally {
    history.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("hard step limit forces rotate even before wall timeout (resume-safe)", () => {
  const root = mkdtempSync(join(tmpdir(), "gy-to-"));
  const history = openHistory({ dbPath: join(root, "h.sqlite"), evidenceDir: join(root, "evidence") });
  try {
    const taskId = "t-steps";
    const intent = history.proposeIntent({ taskId, title: "grind", sourceFactIds: [ORIGIN_FACT_ID] });
    history.claimIntent(taskId, intent.id, "w0");
    const ckpt = state({
      activeIntentId: intent.id,
      activeIntentClaimedAt: new Date().toISOString(), // just claimed: no wall timeout
      toolsAtIntentClaim: 0,
      toolCalls: 25,
    });
    const result = maybeForceExploreTimeout({
      history, taskId, workerId: "w0", workspaceDir: root, state: ckpt,
      exploreTimeoutMs: 900_000, save: () => {}, toolCalls: 25, hardToolLimit: 20,
    });
    assert.equal(result.concluded, true);
    assert.equal(ckpt.activeIntentId, null);
  } finally {
    history.close();
    rmSync(root, { recursive: true, force: true });
  }
});

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { ORIGIN_FACT_ID } from "@gongyuai/contracts";
import { openHistory } from "@gongyuai/history";
import type { CheckpointState } from "./checkpoint.js";
import {
  lastVerifiedEvidenceAt,
  maybeForceEvidenceStall,
} from "./evidence-rotation.js";

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

const AUTH = {
  targets: ["10.0.0.0/8"],
  outOfScope: [] as string[],
  pivotPolicy: { mode: "off" as const, cidrs: [] as string[] },
};

function setup() {
  const root = mkdtempSync(join(tmpdir(), "gy-ev-"));
  const dbPath = join(root, "h.sqlite");
  const history = openHistory({ dbPath, evidenceDir: join(root, "evidence") });
  return { root, dbPath, history };
}

test("evidence stall force-concludes a stale surface (relay-safe: no checkpoint claim)", () => {
  const { root, history } = setup();
  try {
    const taskId = "t-stall";
    const intent = history.proposeIntent({ taskId, title: "grind", sourceFactIds: [ORIGIN_FACT_ID] });
    history.claimIntent(taskId, intent.id, "w0");
    // Simulate post-relay checkpoint: activeIntentId kept, claim timestamp lost.
    const ckpt = state({ activeIntentId: intent.id, activeIntentClaimedAt: null, toolsAtIntentClaim: null });
    const result = maybeForceEvidenceStall({
      history, taskId, workerId: "w0", workspaceDir: root, state: ckpt,
      stallMs: 1000, save: () => {}, nowMs: Date.now() + 5000,
    });
    assert.equal(result.concluded, true);
    assert.equal(ckpt.activeIntentId, null);
    assert.equal(ckpt.phase, "reason");
  } finally {
    history.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("within stall window does not rotate (grace)", () => {
  const { root, history } = setup();
  try {
    const taskId = "t-grace";
    const intent = history.proposeIntent({ taskId, title: "fresh", sourceFactIds: [ORIGIN_FACT_ID] });
    history.claimIntent(taskId, intent.id, "w0");
    const ckpt = state({ activeIntentId: intent.id });
    const result = maybeForceEvidenceStall({
      history, taskId, workerId: "w0", workspaceDir: root, state: ckpt,
      stallMs: 1000, save: () => {}, nowMs: Date.now() + 200,
    });
    assert.equal(result.concluded, false);
    assert.equal(ckpt.activeIntentId, intent.id);
  } finally {
    history.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("no active intent is a no-op", () => {
  const { root, history } = setup();
  try {
    const ckpt = state({ activeIntentId: null });
    const result = maybeForceEvidenceStall({
      history, taskId: "t-none", workerId: "w0", workspaceDir: root, state: ckpt,
      stallMs: 1000, save: () => {}, nowMs: Date.now() + 99999,
    });
    assert.equal(result.concluded, false);
  } finally {
    history.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("fresh verified foothold persists an OLD intent (production: keep traction)", () => {
  const { root, dbPath, history } = setup();
  try {
    const taskId = "t-traction";
    const intent = history.proposeIntent({ taskId, title: "old-surface", sourceFactIds: [ORIGIN_FACT_ID] });
    history.claimIntent(taskId, intent.id, "w0");
    // Backdate the intent so it is "old" relative to fresh evidence.
    const old = new Date(Date.now() - 60_000).toISOString();
    const db = new DatabaseSync(dbPath);
    db.prepare("UPDATE intents SET created_at = ? WHERE id = ?").run(old, intent.id);
    db.close();
    // Fresh verified progress: a newly confirmed live foothold.
    history.recordAsset({ taskId, address: "10.0.0.9", auth: AUTH, live: true, summary: "foothold" });
    const ckpt = state({ activeIntentId: intent.id });
    const result = maybeForceEvidenceStall({
      history, taskId, workerId: "w0", workspaceDir: root, state: ckpt,
      stallMs: 1000, save: () => {}, nowMs: Date.now() + 200,
    });
    assert.equal(result.concluded, false); // fresh evidence anchors recency → persist
    assert.equal(ckpt.activeIntentId, intent.id);
  } finally {
    history.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("lastVerifiedEvidenceAt counts live foothold, ignores out-of-scope", () => {
  const { root, history } = setup();
  try {
    const taskId = "t-signal";
    assert.equal(lastVerifiedEvidenceAt(history, taskId), 0);
    history.recordAsset({ taskId, address: "10.0.0.9", auth: AUTH, live: true });
    const liveAt = lastVerifiedEvidenceAt(history, taskId);
    assert.ok(liveAt > 0);
    // Out-of-scope asset must not count as verified progress.
    history.recordAsset({ taskId, address: "192.0.2.7", auth: AUTH, live: true });
    assert.equal(lastVerifiedEvidenceAt(history, taskId), liveAt);
  } finally {
    history.close();
    rmSync(root, { recursive: true, force: true });
  }
});
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { ORIGIN_FACT_ID } from "@gongyuai/contracts";
import { openHistory, writeEvidenceFile } from "@gongyuai/history";
import type { CheckpointState } from "./checkpoint.js";
import {
  lastVerifiedEvidenceAt,
  maybeForceEvidenceStall,
} from "./evidence-rotation.js";

function state(partial: Partial<CheckpointState> = {}): CheckpointState {
  return {
    phase: "explore",
    step: 0,
    round: 0,
    bootEpoch: 0,
    toolCalls: 0,
    installs: 0,
    tokens: 0,
    relayGeneration: 0,
    lastRelaySnapshotStep: 0,
    tokensSinceRelay: 0,
    toolCallsSinceRelay: 0,
    activeIntentId: null,
    activeIntentClaimedAt: null,
    lastSoftToolMilestone: 0,
    lastSoftWallMilestone: 0,
    toolsAtIntentClaim: null,
    lastSoftSurfaceMilestone: 0,
    pendingSoftPaceMessage: null,
    observeFingerprint: {},
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
/* ------------------------------------------------------------------ *
 * 边界用例：同面无新证据 vs 跨面新证据（lane D 补充）
 *
 * 当前实现（packages/worker/src/evidence-rotation.ts）的牵引信号是**任务级**的
 * 「最新 verified 证据」，不是按资产面（asset root）锚定。这三条用例把边界钉死：
 * - 同一面没有新的 verified 证据 → 必须换面；
 * - 同面只有 tentative 线索（未验证）→ 不算 traction，仍换面；
 * - 跨面出现新的 verified 证据 → 按当前任务级锚点会延续本面 Intent（已知边界，
 *   按面锚定需要改 evidence-rotation.ts，不在本轮写入范围，见 docs 台账「待联调验证」）。
 * ------------------------------------------------------------------ */

/** 把 Intent 的 created_at 提前，制造“这一面已经磨了很久”的时间锚点。 */
function backdateIntent(dbPath: string, intentId: string, msAgo: number): void {
  const db = new DatabaseSync(dbPath);
  db.prepare("UPDATE intents SET created_at = ? WHERE id = ?").run(
    new Date(Date.now() - msAgo).toISOString(),
    intentId,
  );
  db.close();
}

test("边界：同一资产面没有新 verified 证据 → 强制换面", () => {
  const { root, dbPath, history } = setup();
  try {
    const taskId = "t-same-surface-stall";
    const intent = history.proposeIntent({
      taskId,
      title: "同一面磨到底",
      sourceFactIds: [ORIGIN_FACT_ID],
      assetRoot: "10.0.0.0/8",
    });
    history.claimIntent(taskId, intent.id, "w0");
    backdateIntent(dbPath, intent.id, 120_000);
    const ckpt = state({ activeIntentId: intent.id });
    const result = maybeForceEvidenceStall({
      history, taskId, workerId: "w0", workspaceDir: root, state: ckpt,
      stallMs: 1000, save: () => {}, nowMs: Date.now(),
    });
    assert.equal(result.concluded, true);
    assert.equal(result.intentId, intent.id);
    assert.equal(ckpt.activeIntentId, null);
    assert.equal(ckpt.phase, "reason");
  } finally {
    history.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("边界：同面只有 tentative 线索不算 traction，仍换面", () => {
  const { root, dbPath, history } = setup();
  try {
    const taskId = "t-tentative-only";
    const intent = history.proposeIntent({
      taskId,
      title: "只有线索",
      sourceFactIds: [ORIGIN_FACT_ID],
      assetRoot: "10.0.0.0/8",
    });
    history.claimIntent(taskId, intent.id, "w0");
    backdateIntent(dbPath, intent.id, 120_000);
    // tentative 线索：写入时间是新的，但没有 verified 结论。
    const lead = history.recordFinding({
      taskId,
      title: "可能是 SQLi",
      asset: "10.0.0.9",
      vulnClass: "CWE-89",
      severity: "medium",
    });
    assert.equal(lead.finding.status, "tentative");
    const ckpt = state({ activeIntentId: intent.id });
    const result = maybeForceEvidenceStall({
      history, taskId, workerId: "w0", workspaceDir: root, state: ckpt,
      stallMs: 1000, save: () => {}, nowMs: Date.now(),
    });
    assert.equal(result.concluded, true);
    assert.equal(ckpt.activeIntentId, null);
  } finally {
    history.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("边界：跨面新 verified 证据按任务级牵引（已知边界，待联调验证）", () => {
  const { root, dbPath, history } = setup();
  try {
    const taskId = "t-cross-surface";
    const intent = history.proposeIntent({
      taskId,
      title: "本面 exhausted",
      sourceFactIds: [ORIGIN_FACT_ID],
      assetRoot: "10.0.0.0/8",
    });
    history.claimIntent(taskId, intent.id, "w0");
    backdateIntent(dbPath, intent.id, 120_000);
    assert.equal(lastVerifiedEvidenceAt(history, taskId), 0);

    // 另一个资产面（不同 asset root）产生了新的 verified 证据。
    const lead = history.recordFinding({
      taskId,
      title: "跨面 XSS",
      asset: "192.0.2.10",
      vulnClass: "CWE-79",
      severity: "high",
      endpoint: "/search",
    });
    writeEvidenceFile(join(root, "evidence"), "findings/xss.txt", "alert(1) reflected\n");
    const verified = history.verifyFinding(taskId, lead.finding.id, {
      evidencePaths: ["findings/xss.txt"],
      repro: "curl 'https://192.0.2.10/search?q=<script>'",
      verifiedBy: "w0",
    });
    assert.equal(verified.status, "verified");
    assert.ok(lastVerifiedEvidenceAt(history, taskId) > 0);

    const ckpt = state({ activeIntentId: intent.id });
    const result = maybeForceEvidenceStall({
      history, taskId, workerId: "w0", workspaceDir: root, state: ckpt,
      stallMs: 1000, save: () => {}, nowMs: Date.now(),
    });
    // 任务级锚点：跨面 verified 证据也算 traction，本面 Intent 继续。
    assert.equal(result.concluded, false);
    assert.equal(ckpt.activeIntentId, intent.id);
  } finally {
    history.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("graded stall extends grace window when active intent has recent substantive progress", () => {
  const { root, dbPath, history } = setup();
  try {
    const taskId = "t-graded-stall";
    const intent = history.proposeIntent({ taskId, title: "deep-analysis", sourceFactIds: [ORIGIN_FACT_ID] });
    history.claimIntent(taskId, intent.id, "w0");
    // Backdate intent creation by 20 minutes (past 15min stallMs).
    const now = Date.now();
    const db = new DatabaseSync(dbPath);
    db.prepare("UPDATE intents SET created_at = ? WHERE id = ?").run(
      new Date(now - 20 * 60_000).toISOString(),
      intent.id,
    );
    db.close();

    // Append a fresh Fact tied to the active Intent 1 minute ago (substantive progress).
    const fact = history.appendFact({
      taskId,
      layer: "summary",
      title: "Discovered internal admin endpoint",
      summary: "New lead under investigation",
      intentId: intent.id,
    });
    const db2 = new DatabaseSync(dbPath);
    db2.prepare("UPDATE facts SET created_at = ? WHERE id = ?").run(
      new Date(now - 60_000).toISOString(),
      fact.id,
    );
    db2.close();

    const ckpt = state({ activeIntentId: intent.id });
    const extended = maybeForceEvidenceStall({
      history, taskId, workerId: "w0", workspaceDir: root, state: ckpt,
      stallMs: 15 * 60_000, progressGraceMs: 5 * 60_000, save: () => {}, nowMs: now,
    });
    assert.equal(extended.concluded, false);
    assert.equal(extended.extended, true);
    assert.equal(ckpt.activeIntentId, intent.id);

    // Once past hardStallMs (2x stallMs = 30min), it still force-concludes so nothing hangs forever.
    const forced = maybeForceEvidenceStall({
      history, taskId, workerId: "w0", workspaceDir: root, state: ckpt,
      stallMs: 15 * 60_000, progressGraceMs: 5 * 60_000, save: () => {}, nowMs: now + 15 * 60_000,
    });
    assert.equal(forced.concluded, true);
    assert.equal(ckpt.activeIntentId, null);
  } finally {
    history.close();
    rmSync(root, { recursive: true, force: true });
  }
});

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { CheckpointStore } from "./checkpoint.js";
import { piRequestId } from "./pi-loop.js";

const TASK = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

test("CheckpointState 持久化 round / bootEpoch / observeFingerprint / lastRelaySnapshotStep", () => {
  const root = mkdtempSync(join(tmpdir(), "gy-ckpt-"));
  const dbPath = join(root, "d.sqlite.ckpt.sqlite");
  try {
    const ckpt = new CheckpointStore(dbPath);
    const s = ckpt.load();
    assert.equal(s.round, 0);
    assert.equal(s.bootEpoch, 0);
    assert.deepEqual(s.observeFingerprint, {});
    assert.equal(s.lastRelaySnapshotStep, 0);
    s.round = 7;
    s.bootEpoch = 3;
    s.lastRelaySnapshotStep = 250;
    s.observeFingerprint = { "goal:g1": "[未通过] x" };
    ckpt.save(s);
    ckpt.close();

    const reopened = new CheckpointStore(dbPath);
    const s2 = reopened.load();
    assert.equal(s2.round, 7);
    assert.equal(s2.bootEpoch, 3);
    assert.equal(s2.lastRelaySnapshotStep, 250);
    assert.deepEqual(s2.observeFingerprint, { "goal:g1": "[未通过] x" });
    reopened.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("重启恢复后 requestId 不与重启前重复（boot epoch + 持久化 round）", () => {
  const root = mkdtempSync(join(tmpdir(), "gy-ckpt-"));
  const dbPath = join(root, "d.sqlite.ckpt.sqlite");
  try {
    const seen = new Set<string>();
    // Boot 1: mimic runPiLoop epoch bump, then a few continue rounds persisting round each time.
    const boot1 = new CheckpointStore(dbPath);
    const s1 = boot1.load();
    s1.bootEpoch += 1;
    boot1.save(s1);
    let round = s1.round;
    for (let i = 0; i < 5; i++) {
      round += 1;
      s1.round = round;
      boot1.save(s1);
      seen.add(piRequestId(TASK, s1.bootEpoch, round));
    }
    const lastBeforeRestart = piRequestId(TASK, s1.bootEpoch, s1.round);
    boot1.close();

    // Restart (pause/resume or process crash): checkpoint survives; round is NOT reset to 0.
    const boot2 = new CheckpointStore(dbPath);
    const s2 = boot2.load();
    assert.equal(s2.round, 5);
    assert.equal(s2.bootEpoch, 1);
    s2.bootEpoch += 1;
    boot2.save(s2);
    const nextRound = s2.round + 1;
    const firstAfterRestart = piRequestId(TASK, s2.bootEpoch, nextRound);
    assert.notEqual(firstAfterRestart, lastBeforeRestart);
    assert.equal(seen.has(firstAfterRestart), false);
    // Even a low round number in the new epoch cannot collide with any pre-restart id.
    assert.equal(seen.has(piRequestId(TASK, s2.bootEpoch, 1)), false);
    boot2.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("piRequestId 格式含 boot epoch 与 round", () => {
  assert.equal(piRequestId("t1", 2, 9), "gy-t1-e2-r9");
});
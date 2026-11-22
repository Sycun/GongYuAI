import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { CreateTaskRequestSchema } from "@gongyuai/contracts";
import { openHistory } from "@gongyuai/history";
import { WorkerRunner } from "./runner.js";
import { SettingsStore } from "./settings.js";
import { ControlStore } from "./store.js";
import { taskPaths } from "./paths.js";

type FakeChild = { pid: number; on: () => void };

function makeRunner(root: string) {
  const store = new ControlStore(root);
  const settings = new SettingsStore(root, root);
  const runner = new WorkerRunner(store, {
    ownerId: "scale-test",
    leaseMs: 10_000,
    mode: "local",
    workerImage: "",
  }, settings);
  let nextPid = 4_000_000;
  const spawned: number[] = [];
  // Isolate process management: exercise reconcile decisions and disk state only.
  (runner as unknown as { spawnLocalSlot: (task: unknown, slot: number, count: number) => FakeChild })
    .spawnLocalSlot = (_task, slot, _count) => {
      const child: FakeChild = { pid: nextPid++, on: () => {} };
      spawned.push(slot);
      (runner as unknown as { trackChild: (id: string, slot: number, c: FakeChild) => void })
        .trackChild(((_task as { id: string }).id), slot, child);
      return child;
    };
  return { store, runner, spawned };
}

function createTask(store: ControlStore, cap: number) {
  return store.createTask(CreateTaskRequestSchema.parse({
    name: "scale fixture",
    mock: true,
    auth: { authorizationNote: "Local scale fixture only", targets: ["10.0.0.0/24"] },
    goals: [{ id: "g", title: "Synthetic", description: "fixture", evidencePatterns: ["proof.txt"] }],
    execution: { maxConcurrentExplores: cap },
  }));
}

function addAssets(task: { id: string; dataDir: string; auth: { targets: string[]; outOfScope: string[] } }, n: number) {
  const paths = taskPaths(task.dataDir);
  const history = openHistory({ dbPath: paths.historyDb, evidenceDir: paths.evidenceDir });
  try {
    for (let i = 1; i <= n; i++) {
      history.recordAsset({ taskId: task.id, address: `10.0.0.${i}`, auth: task.auth });
    }
  } finally {
    history.close();
  }
}

test("reconcileWorkers scales a single-CIDR task up to admitted asset count, capped by operator", { timeout: 10_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), "gy-scale-"));
  const { store, runner, spawned } = makeRunner(root);
  try {
    const task = createTask(store, 4);
    await runner.start(task.id);
    assert.deepEqual(spawned, [0], "single CIDR target starts one worker");

    addAssets(store.get(task.id)!, 5);
    await runner.reconcileWorkers(task.id);

    const scaled = store.get(task.id)!;
    assert.equal(scaled.workerPids?.length, 4, "min(cap=4, assets=5)");
    assert.deepEqual(spawned, [0, 1, 2, 3]);
    const manifest = JSON.parse(readFileSync(join(task.dataDir, "manifest.json"), "utf8"));
    assert.equal(manifest.workerCount, 4, "leader manifest rewritten with new pool size");
    const follower = JSON.parse(readFileSync(join(task.dataDir, "manifest-w3.json"), "utf8"));
    assert.equal(follower.workerSlot, 3);

    const paths = taskPaths(task.dataDir);
    const history = openHistory({ dbPath: paths.historyDb, evidenceDir: paths.evidenceDir });
    try {
      const events = history.listEvents(task.id).filter((e) => e.kind === "explore_scaled");
      assert.equal(events.length, 1);
      assert.equal(events[0]!.payload.from, 1);
      assert.equal(events[0]!.payload.to, 4);
      assert.equal(events[0]!.payload.assetCount, 5);
    } finally {
      history.close();
    }

    // Throttled second call does nothing.
    await runner.reconcileWorkers(task.id);
    assert.deepEqual(spawned, [0, 1, 2, 3]);

    // Scale-up only: clearing the throttle with fewer assets never shrinks the pool.
    (runner as unknown as { lastScaleCheck: Map<string, number> }).lastScaleCheck.delete(task.id);
    await runner.reconcileWorkers(task.id);
    assert.equal(store.get(task.id)!.workerPids?.length, 4);
    assert.deepEqual(spawned, [0, 1, 2, 3]);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("reconcileWorkers never exceeds the operator cap", { timeout: 10_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), "gy-scale-cap-"));
  const { store, runner, spawned } = makeRunner(root);
  try {
    const task = createTask(store, 2);
    await runner.start(task.id);
    addAssets(store.get(task.id)!, 20);
    await runner.reconcileWorkers(task.id);
    assert.equal(store.get(task.id)!.workerPids?.length, 2);
    assert.deepEqual(spawned, [0, 1]);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("reconcileWorkers skips when slot identity is unknown (no live child map)", { timeout: 10_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), "gy-scale-nomap-"));
  const { store, runner, spawned } = makeRunner(root);
  try {
    const task = createTask(store, 4);
    await runner.start(task.id);
    addAssets(store.get(task.id)!, 5);
    // Simulate control-plane restart: pids survive but the child map is gone.
    (runner as unknown as { children: Map<string, unknown> }).children.clear();
    await runner.reconcileWorkers(task.id);
    assert.deepEqual(spawned, [0], "no duplicate spawn without slot identity");
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});
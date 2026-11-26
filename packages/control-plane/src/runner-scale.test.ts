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
    assert.equal(scaled.workerPids?.length, 5, "1 leader + min(cap=4, assets=5) explore followers");
    assert.deepEqual(spawned, [0, 1, 2, 3, 4]);
    const manifest = JSON.parse(readFileSync(join(task.dataDir, "manifest.json"), "utf8"));
    assert.equal(manifest.workerCount, 5, "leader manifest rewritten with new pool size");
    const follower = JSON.parse(readFileSync(join(task.dataDir, "manifest-w4.json"), "utf8"));
    assert.equal(follower.workerSlot, 4);

    const paths = taskPaths(task.dataDir);
    const history = openHistory({ dbPath: paths.historyDb, evidenceDir: paths.evidenceDir });
    try {
      const events = history.listEvents(task.id).filter((e) => e.kind === "explore_scaled");
      assert.equal(events.length, 1);
      assert.equal(events[0]!.payload.from, 1);
      assert.equal(events[0]!.payload.to, 5);
      assert.equal(events[0]!.payload.assetCount, 5);
    } finally {
      history.close();
    }

    // Throttled second call does nothing.
    await runner.reconcileWorkers(task.id);
    assert.deepEqual(spawned, [0, 1, 2, 3, 4]);

    // Scale-up only: clearing the throttle with fewer assets never shrinks the pool.
    (runner as unknown as { lastScaleCheck: Map<string, number> }).lastScaleCheck.delete(task.id);
    await runner.reconcileWorkers(task.id);
    assert.equal(store.get(task.id)!.workerPids?.length, 5);
    assert.deepEqual(spawned, [0, 1, 2, 3, 4]);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("reconcileWorkers never exceeds the operator cap (1 leader + cap followers) and defaults to 3 explores", { timeout: 10_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), "gy-scale-cap-"));
  const { store, runner, spawned } = makeRunner(root);
  try {
    const task = createTask(store, 2);
    await runner.start(task.id);
    addAssets(store.get(task.id)!, 20);
    await runner.reconcileWorkers(task.id);
    assert.equal(store.get(task.id)!.workerPids?.length, 3);
    assert.deepEqual(spawned, [0, 1, 2]);

    spawned.length = 0;
    const defaultTask = store.createTask(CreateTaskRequestSchema.parse({
      name: "default 3 explores",
      mock: false,
      auth: { authorizationNote: "tsecbench board", targets: ["10.0.0.0/8"] },
      goals: [{ id: "clear-board", title: "清板", description: "board", evidencePatterns: ["ALL.json"], boardGate: "tsecbench" }],
    }));
    assert.equal(defaultTask.execution.maxConcurrentExplores, 3);
    await runner.start(defaultTask.id);
    assert.deepEqual(spawned, [0, 1, 2, 3], "tsecbench starts immediately with 1 leader + 3 explore followers");
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

test("reconcileWorkers respawns only dead follower slot without colliding live slots", { timeout: 10_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), "gy-scale-heal-"));
  const { store, runner, spawned } = makeRunner(root);
  try {
    const task = createTask(store, 4);
    await runner.start(task.id);
    addAssets(store.get(task.id)!, 4);
    await runner.reconcileWorkers(task.id);
    assert.deepEqual(spawned, [0, 1, 2, 3, 4]);

    // Simulate follower slot 1 crashing while slots 0, 2, 3, 4 remain alive.
    const slots = (runner as unknown as { children: Map<string, Map<number, { exitCode?: number | null }>> })
      .children.get(task.id)!;
    slots.get(1)!.exitCode = 1;
    (runner as unknown as { lastScaleCheck: Map<string, number> }).lastScaleCheck.delete(task.id);

    await runner.reconcileWorkers(task.id);
    assert.deepEqual(spawned, [0, 1, 2, 3, 4, 1], "only dead slot 1 is respawned; live slots untouched");
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});
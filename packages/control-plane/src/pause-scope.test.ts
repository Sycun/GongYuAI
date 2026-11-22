/**
 * Stage 2 — pause / resume / scope revision invariants that do not need a real
 * worker process: status semantics, draining states never restart, and a scope
 * revision is refused while a worker is alive.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  CreateTaskRequestSchema,
  isActiveTaskStatus,
  isDrainingTaskStatus,
  isPausedTaskStatus,
  isTerminalTaskStatus,
} from "@gongyuai/contracts";
import { ControlStore } from "./store.js";
import { WorkerRunner } from "./runner.js";
import { Watchdog } from "./watchdog.js";
import type { SettingsStore } from "./settings.js";

function tempStore() {
  const root = mkdtempSync(join(tmpdir(), "gy-pause-scope-"));
  return { root, store: new ControlStore(root) };
}

test("paused is non-terminal and non-active; draining states are active", () => {
  assert.equal(isPausedTaskStatus("paused"), true);
  assert.equal(isActiveTaskStatus("paused"), false);
  assert.equal(isTerminalTaskStatus("paused"), false);
  assert.equal(isDrainingTaskStatus("pause_requested"), true);
  assert.equal(isDrainingTaskStatus("stopping"), true);
  assert.equal(isDrainingTaskStatus("paused"), false);
});

test("watchdog does not restart or promote a draining task", async () => {
  const { root, store } = tempStore();
  try {
    const task = store.createTask(CreateTaskRequestSchema.parse({
      name: "drain",
      mock: true,
      auth: { authorizationNote: "draining fixture note", targets: ["a.example.com"] },
      goals: [{ id: "g", title: "t", description: "d", evidencePatterns: ["x.txt"] }],
    }));
    task.status = "pause_requested";
    task.workerPid = null;
    task.workerPids = [];
    store.save(task);

    const started: string[] = [];
    const fakeRunner = {
      start: async (id: string) => { started.push(id); return store.get(id)!; },
      isAlive: () => false,
      reconcileWorkers: async () => undefined,
      finishWorkerRun: () => store.get(task.id)!,
    };
    const watchdog = new Watchdog(store, fakeRunner as unknown as WorkerRunner, {
      intervalMs: 60_000, leaseMs: 15_000, ownerId: "test",
    });
    await watchdog.tick();
    const after = store.get(task.id)!;
    assert.deepEqual(started, [], "draining task must not be started");
    assert.equal(after.status, "pause_requested");
    assert.notEqual(after.status, "recovering");
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("scope revision is refused while a worker is alive, then increments version", () => {
  const { root, store } = tempStore();
  try {
    const runner = new WorkerRunner(
      store,
      { mode: "local", workerImage: "unused", leaseMs: 15_000, ownerId: "test" },
      {} as SettingsStore,
    );
    const task = store.createTask(CreateTaskRequestSchema.parse({
      name: "scope",
      mock: true,
      auth: { authorizationNote: "scope fixture note", targets: ["a.example.com", "b.example.com"] },
      goals: [{ id: "g", title: "t", description: "d", evidencePatterns: ["x.txt"] }],
    }));
    task.workerPids = [process.pid];
    task.workerPid = process.pid;
    store.save(task);

    assert.throws(
      () => runner.setScope(task.id, {
        authorizationNote: "scope fixture note v2",
        targets: ["a.example.com"],
        outOfScope: [],
        capability: "scan",
      }, "客户修订范围"),
      /先暂停任务/,
    );
    const still = store.get(task.id)!;
    assert.equal(still.scopeVersion, 1);

    still.workerPids = [];
    still.workerPid = null;
    store.save(still);
    const updated = runner.setScope(still.id, {
      authorizationNote: "scope fixture note v2",
      targets: ["a.example.com"],
      outOfScope: [],
      capability: "scan",
    }, "客户修订范围");
    assert.equal(updated.scopeVersion, 2);
    assert.deepEqual(updated.auth.targets, ["a.example.com"]);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

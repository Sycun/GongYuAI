/**
 * 归档条件与归档标记语义：已暂停或终态可归档；归档/取消归档只改
 * archivedAt，任务状态、检查点与历史记录一律不动，暂停任务的可继续
 * 语义不受影响。
 */
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { CreateTaskRequestSchema, isArchivableTaskStatus, type TaskArchiveState } from "@gongyuai/contracts";
import { bootControlPlane } from "./index.js";
import { ControlStore } from "./store.js";

function tempStore() {
  const root = mkdtempSync(join(tmpdir(), "gy-archive-paused-"));
  return { root, store: new ControlStore(root) };
}

function newTask(store: ControlStore, name: string) {
  return store.createTask(CreateTaskRequestSchema.parse({
    name,
    mock: true,
    auth: { authorizationNote: "archive fixture note", targets: ["a.example.com"] },
    goals: [{ id: "g", title: "t", description: "d", evidencePatterns: ["x.txt"] }],
  }));
}

test("archivable set is exactly paused plus terminal statuses", () => {
  for (const status of ["paused", "completed", "failed", "budget_exhausted", "incomplete", "stopped"]) {
    assert.equal(isArchivableTaskStatus(status), true, status);
  }
  for (const status of ["queued", "running", "initializing", "recovering", "pause_requested", "stopping"]) {
    assert.equal(isArchivableTaskStatus(status), false, status);
  }
});

test("a paused task can be archived and unarchived while keeping its status", () => {
  const { root, store } = tempStore();
  try {
    const task = newTask(store, "paused-archive");
    task.status = "paused";
    task.pausedAt = "2026-11-23T00:00:00.000Z";
    store.save(task);

    const archived = store.setArchived(task.id, true)!;
    assert.ok(archived.archivedAt, "archivedAt is set");
    assert.equal(archived.status, "paused", "status untouched by archive");
    assert.equal(archived.pausedAt, "2026-11-23T00:00:00.000Z", "pause record untouched");
    assert.equal(archived.finishedAt, null, "task not terminal");
    // 刷新（重新读取）后仍显示已暂停且已归档。
    const reread = store.get(task.id)!;
    assert.equal(reread.status, "paused");
    assert.equal(reread.archivedAt, archived.archivedAt);

    const unarchived = store.setArchived(task.id, false)!;
    assert.equal(unarchived.archivedAt, null, "unarchive clears the flag only");
    assert.equal(unarchived.status, "paused", "unarchive does not resume the task");
    assert.equal(unarchived.pausedAt, "2026-11-23T00:00:00.000Z");
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("running and queued tasks are refused; terminal tasks still archivable", () => {
  const { root, store } = tempStore();
  try {
    for (const status of ["queued", "running", "pause_requested"] as const) {
      const task = newTask(store, `refuse-${status}`);
      task.status = status;
      store.save(task);
      assert.throws(() => store.setArchived(task.id, true), /仅已暂停或终态任务可归档/, status);
      assert.equal(store.get(task.id)!.archivedAt, null, `${status} stays unarchived`);
    }
    const done = newTask(store, "terminal-archive");
    done.status = "stopped";
    store.save(done);
    assert.ok(store.setArchived(done.id, true)?.archivedAt);
    // 重复归档保持首次时间戳。
    assert.equal(store.setArchived(done.id, true)?.archivedAt, store.get(done.id)!.archivedAt);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("archiving never touches dataDir contents (checkpoints, history, evidence)", () => {
  const { root, store } = tempStore();
  try {
    const task = newTask(store, "data-intact");
    writeFileSync(join(task.dataDir, "durable.sqlite"), "checkpoint-bytes");
    writeFileSync(join(task.dataDir, "evidence", "x.txt"), "proof");
    task.status = "paused";
    store.save(task);
    const before = readdirSync(task.dataDir).sort();

    store.setArchived(task.id, true);
    store.setArchived(task.id, false);
    assert.deepEqual(readdirSync(task.dataDir).sort(), before, "on-disk state preserved");
    assert.equal(store.get(task.id)!.status, "paused");
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("workspace archive batches roll back entirely until all tasks are eligible", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "gy-archive-batch-"));
  const plane = await bootControlPlane({ dataRoot: root, host: "127.0.0.1", port: 0, isolated: true });
  t.after(async () => { await plane.close(); rmSync(root, { recursive: true, force: true }); });
  const first = newTask(plane.store, "first");
  const second = newTask(plane.store, "second");
  first.status = "completed";
  first.assignment = { requestId: "previous-submission", model: "fixture", inputHash: "unused" };
  second.status = "running";
  plane.store.save(first);
  plane.store.save(second);

  const endpoint = plane.url + "/tasks/archives";
  const batch = (archived: boolean) => fetch(endpoint, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ taskIds: [first.id, second.id, first.id], archived }),
  });
  const blocked = await batch(true);
  assert.equal(blocked.status, 400);
  assert.match(await blocked.text(), /second/);
  assert.equal(plane.store.get(first.id)?.archivedAt, null);

  second.status = "paused";
  second.pausedAt = "2026-11-23T00:00:00.000Z";
  plane.store.save(second);
  const response = await batch(true);
  assert.equal(response.status, 200);
  const result = await response.json() as { tasks: TaskArchiveState[] };
  assert.equal(result.tasks.length, 2);
  assert.equal(result.tasks.find(task => task.id === first.id)?.submissionKey, "previous-submission");
  assert.ok(result.tasks.every(task => task.archivedAt));
  const listed = await (await fetch(endpoint)).json() as { tasks: TaskArchiveState[] };
  const byId = (tasks: TaskArchiveState[]) => new Map(tasks.map(task => [task.id, task]));
  assert.deepEqual(byId(listed.tasks), byId(result.tasks));
  assert.deepEqual(await (await batch(true)).json(), result);

  assert.equal((await batch(false)).status, 200);
  const restored = plane.store.get(second.id);
  assert.equal(restored?.archivedAt, null);
  assert.equal(restored?.status, "paused");
  assert.equal(restored?.pausedAt, second.pausedAt);
});

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
import { CreateTaskRequestSchema, isArchivableTaskStatus } from "@gongyuai/contracts";
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

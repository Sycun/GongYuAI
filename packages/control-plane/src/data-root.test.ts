import assert from "node:assert/strict";
import { chmodSync, cpSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { migrateDataRoot, resolveCanonicalDataRoot } from "./data-root.js";

test("resolveCanonicalDataRoot prefers explicit then env then installRoot/.gongyuai", () => {
  const install = "/opt/GongYuAI";
  assert.equal(
    resolveCanonicalDataRoot({ installRoot: install, explicit: "/var/gy", envValue: "/env" }),
    "/var/gy",
  );
  assert.equal(
    resolveCanonicalDataRoot({ installRoot: install, explicit: null, envValue: "/env/gy" }),
    "/env/gy",
  );
  assert.equal(
    resolveCanonicalDataRoot({ installRoot: install, explicit: "  ", envValue: "" }),
    join(install, ".gongyuai"),
  );
});

test("migrateDataRoot copies missing tasks and rewrites dataDir", () => {
  const dest = mkdtempSync(join(tmpdir(), "gy-dest-"));
  const legacy = mkdtempSync(join(tmpdir(), "gy-legacy-"));
  try {
    mkdirSync(join(legacy, "tasks", "t1"), { recursive: true });
    writeFileSync(join(legacy, "tasks", "t1", "report.md"), "ok");
    const ldb = new DatabaseSync(join(legacy, "control.sqlite"));
    ldb.exec(`CREATE TABLE tasks (id TEXT PRIMARY KEY, json TEXT NOT NULL)`);
    ldb
      .prepare(`INSERT INTO tasks (id, json) VALUES (?, ?)`)
      .run(
        "t1",
        JSON.stringify({
          id: "t1",
          name: "demo",
          dataDir: join(legacy, "tasks", "t1"),
          status: "completed",
        }),
      );
    ldb.close();

    const first = migrateDataRoot(legacy, dest);
    assert.equal(first.migrated, 1);
    assert.equal(readFileSync(join(dest, "tasks", "t1", "report.md"), "utf8"), "ok");

    const ddb = new DatabaseSync(join(dest, "control.sqlite"), { readOnly: true });
    const row = ddb.prepare(`SELECT json FROM tasks WHERE id = ?`).get("t1") as { json: string };
    ddb.close();
    const rec = JSON.parse(row.json) as { dataDir: string };
    assert.equal(rec.dataDir, join(dest, "tasks", "t1"));

    const second = migrateDataRoot(legacy, dest);
    assert.equal(second.migrated, 0);
  } finally {
    rmSync(dest, { recursive: true, force: true });
    rmSync(legacy, { recursive: true, force: true });
  }
});

// ── 第七轮：恢复副本的目录归属 ──────────────────────────────────────────────

import { existsSync } from "node:fs";
import { ControlStore } from "./store.js";
import { confineTaskDataDir, rewriteAbsolutePaths } from "./data-root.js";
import { taskPaths } from "./paths.js";

/** 造一个“源数据根”：一个任务目录 + control.sqlite（dataDir 指向源）。 */
function makeSourceRoot(name: string, options: { reportMarker: string; facts: number }): {
  root: string;
  taskId: string;
} {
  const root = mkdtempSync(join(tmpdir(), `gy-src-${name}-`));
  const taskId = "11111111-1111-4111-8111-111111111111";
  const taskDir = join(root, "tasks", taskId);
  mkdirSync(join(taskDir, "evidence"), { recursive: true });
  mkdirSync(join(taskDir, "workspace"), { recursive: true });
  writeFileSync(join(taskDir, "report.md"), `# Report\n\n${options.reportMarker}\n`);
  writeFileSync(join(taskDir, "manifest.json"), JSON.stringify({
    taskId, dataDir: taskDir, evidenceDir: join(taskDir, "evidence"),
  }, null, 2) + "\n");
  const db = new DatabaseSync(join(root, "control.sqlite"));
  db.exec(`CREATE TABLE tasks (id TEXT PRIMARY KEY, json TEXT NOT NULL)`);
  db.prepare(`INSERT INTO tasks (id, json) VALUES (?, ?)`).run(taskId, JSON.stringify({
    id: taskId,
    tenantId: "default",
    name: "restore-fixture",
    engagementId: taskId,
    status: "completed",
    auth: { authorizationNote: "合成夹具", targets: ["fixture.example"], outOfScope: [] },
    goals: [],
    budget: { maxTokens: 0, maxWallMs: 0, maxToolCalls: 0, maxInstalls: 0 },
    mock: true,
    createdAt: "2026-11-22T00:00:00.000Z",
    updatedAt: "2026-11-22T00:00:00.000Z",
    startedAt: null,
    finishedAt: "2026-11-22T00:01:00.000Z",
    leaseOwner: null,
    leaseUntil: null,
    fence: 0,
    containerId: null,
    workerPid: 4242,
    workerPids: [4242],
    containerIds: [],
    dataDir: taskDir,
    error: null,
    usage: { tokens: 0, toolCalls: 0, installs: 0 },
  }));
  db.close();
  // 源目录里放 N 条事实，便于把“两边计数不同”做成可观察量。
  const history = new DatabaseSync(join(taskDir, "history.sqlite"));
  history.close();
  return { root, taskId };
}

test("恢复副本：dataDir 指回源目录时，读取留在副本内并改写记录", () => {
  const source = makeSourceRoot("a", { reportMarker: "SOURCE-MARKER", facts: 1 });
  const copy = mkdtempSync(join(tmpdir(), "gy-copy-"));
  try {
    cpSync(join(source.root, "tasks"), join(copy, "tasks"), { recursive: true });
    cpSync(join(source.root, "control.sqlite"), join(copy, "control.sqlite"));
    // 复制后记录仍指向源目录（旧备份的真实形状）。
    const before = new DatabaseSync(join(copy, "control.sqlite"), { readOnly: true });
    const beforeRec = JSON.parse(String((before.prepare(`SELECT json FROM tasks`).get() as { json: string }).json)) as { dataDir: string };
    before.close();
    assert.equal(beforeRec.dataDir, join(source.root, "tasks", source.taskId), "复制后仍指向源目录");

    const store = new ControlStore(copy);
    try {
      assert.equal(store.rehomed.length, 1, "启动时改写一条记录的目录归属");
      assert.equal(store.rehomed[0]!.to, join(copy, "tasks", source.taskId));
      const task = store.get(source.taskId)!;
      assert.equal(task.dataDir, join(copy, "tasks", source.taskId), "读取留在副本内");
      assert.equal(task.workerPid, null, "旧 worker 指针被清掉，不会续跑到别处");
      // 报告按副本路径读。
      const report = readFileSync(join(taskPaths(task.dataDir).reportPath), "utf8");
      assert.match(report, /SOURCE-MARKER/);
      // 记录被写回复本数据库。
      const after = new DatabaseSync(join(copy, "control.sqlite"), { readOnly: true });
      const afterRec = JSON.parse(String((after.prepare(`SELECT json FROM tasks`).get() as { json: string }).json)) as { dataDir: string };
      after.close();
      assert.equal(afterRec.dataDir, join(copy, "tasks", source.taskId));
    } finally {
      store.close();
    }
  } finally {
    rmSync(source.root, { recursive: true, force: true });
    rmSync(copy, { recursive: true, force: true });
  }
});

test("恢复副本：源目录不可访问时，副本读取照旧成立", () => {
  const source = makeSourceRoot("b", { reportMarker: "COPY-ONLY-MARKER", facts: 1 });
  const copy = mkdtempSync(join(tmpdir(), "gy-copy2-"));
  try {
    cpSync(join(source.root, "tasks"), join(copy, "tasks"), { recursive: true });
    cpSync(join(source.root, "control.sqlite"), join(copy, "control.sqlite"));
    chmodSync(source.root, 0o000);
    const store = new ControlStore(copy);
    try {
      const task = store.get(source.taskId)!;
      assert.equal(task.dataDir, join(copy, "tasks", source.taskId));
      const report = readFileSync(join(taskPaths(task.dataDir).reportPath), "utf8");
      assert.match(report, /COPY-ONLY-MARKER/);
      assert.equal(existsSync(join(source.root, "tasks", source.taskId, "report.md")), false,
        "源目录确实不可访问（否则这条断言不成立）");
    } finally {
      store.close();
    }
  } finally {
    chmodSync(source.root, 0o755);
    rmSync(source.root, { recursive: true, force: true });
    rmSync(copy, { recursive: true, force: true });
  }
});

test("恢复副本：目录末级与任务 ID 不符时拒绝猜测归属", () => {
  const root = mkdtempSync(join(tmpdir(), "gy-bad-"));
  try {
    mkdirSync(join(root, "tasks", "other-task"), { recursive: true });
    assert.throws(
      () => confineTaskDataDir(root, { id: "abc", dataDir: join(root, "tasks", "other-task") }),
      /与任务 ID 不符/,
    );
    // 目标目录不在本数据根内 → 拒绝跨根读取。
    assert.throws(
      () => confineTaskDataDir(root, { id: "abc", dataDir: "/nonexistent/abc" }),
      /拒绝跨根读取/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("恢复副本：manifest 里的旧绝对路径被改成副本路径，只动本副本", () => {
  const dir = mkdtempSync(join(tmpdir(), "gy-rewrite-"));
  try {
    writeFileSync(join(dir, "manifest.json"), JSON.stringify({ evidenceDir: "/old/root/tasks/t1/evidence" }));
    const touched = rewriteAbsolutePaths(dir, "/old/root/tasks/t1", join(dir));
    assert.deepEqual(touched, ["manifest.json"]);
    const after = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")) as { evidenceDir: string };
    assert.equal(after.evidenceDir, join(dir, "evidence"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

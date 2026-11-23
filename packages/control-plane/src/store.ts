import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  ExecutionConfigSchema,
  goalsFromSpecs,
  isActiveTaskStatus,
  isArchivableTaskStatus,
  type CreateTaskRequest,
  type TaskRecord,
  type TerminalTaskStatus,
} from "@gongyuai/contracts";
import { taskDataDir, taskPaths } from "./paths.js";
import { confineTaskDataDir, type RehomeRecord } from "./data-root.js";

export class ControlStore {
  private readonly db: DatabaseSync;
  readonly dataRoot: string;

  /** 本次启动把哪些任务记录从旧绝对路径改到了本数据根。 */
  readonly rehomed: RehomeRecord[] = [];

  constructor(dataRoot: string) {
    this.dataRoot = dataRoot;
    mkdirSync(dataRoot, { recursive: true });
    const dbPath = `${dataRoot}/control.sqlite`;
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.migrate();
    this.confineAll();
  }

  /**
   * 启动时把每条任务记录的 dataDir 收回到本数据根内（恢复副本专用语义）。
   * 旧备份里指向正式实例的绝对路径若原样生效，History / 证据 / 报告 / 快照 /
   * 记分卡都会读到正式数据。这里改的是**本次数据根的记录**，也就是副本。
   */
  private confineAll(): void {
    const rows = this.db.prepare(`SELECT id, json FROM tasks`).all() as Array<{
      id: string;
      json: string;
    }>;
    const update = this.db.prepare(`UPDATE tasks SET json = ? WHERE id = ?`);
    for (const row of rows) {
      let record: TaskRecord;
      try {
        record = JSON.parse(row.json) as TaskRecord;
      } catch {
        continue;
      }
      const { dataDir, rehomed } = confineTaskDataDir(this.dataRoot, record);
      if (!rehomed) continue;
      record.dataDir = dataDir;
      // 跨机器恢复时旧的 worker/lease 指针没有意义，清掉避免自动续跑到别处。
      record.workerPid = null;
      record.workerPids = [];
      record.containerId = null;
      record.containerIds = [];
      record.leaseOwner = null;
      record.leaseUntil = null;
      update.run(JSON.stringify(record), row.id);
      this.rehomed.push(rehomed);
    }
  }

  close(): void {
    this.db.close();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        json TEXT NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS submission_key ON tasks(json_extract(json,'$.assignment.requestId')) WHERE json_extract(json,'$.assignment.requestId') IS NOT NULL;
    `);
  }

  private now(): string {
    return new Date().toISOString();
  }

  findSubmission(key: string): TaskRecord | undefined {
    const row = this.db.prepare("SELECT json FROM tasks WHERE json_extract(json,'$.assignment.requestId')=?").get(key) as
      | { json: string }
      | undefined;
    if (row) return this.normalize(JSON.parse(String(row.json)) as TaskRecord);
    return undefined;
  }

  createTask(req: CreateTaskRequest, assignment?: TaskRecord["assignment"]): TaskRecord {
    const id = randomUUID();
    const dataDir = taskDataDir(this.dataRoot, id);
    mkdirSync(dataDir, { recursive: true });
    const paths = taskPaths(dataDir);
    mkdirSync(paths.evidenceDir, { recursive: true });
    mkdirSync(paths.workspaceDir, { recursive: true });

    const now = this.now();
    const record: TaskRecord = {
      id,
      ...(assignment ? { assignment } : {}),
      tenantId: req.tenantId ?? "default",
      name: req.name,
      engagementId: req.engagementId ?? id,
      status: "queued",
      auth: req.auth,
      threadId: "",
      parentTaskId: null,
      authorization: null,
      goals: goalsFromSpecs(req.goals),
      budget: req.budget,
      execution: req.execution,
      mock: req.mock,
      createdAt: now,
      updatedAt: now,
      startedAt: null,
      finishedAt: null,
      archivedAt: null,
      leaseOwner: null,
      leaseUntil: null,
      fence: 0,
      containerId: null,
      workerPid: null,
      workerPids: [],
      containerIds: [],
      dataDir,
      error: null,
      usage: { tokens: 0, toolCalls: 0, installs: 0 },
      scopeVersion: 1,
      pauseRequestedAt: null,
      pausedAt: null,
      lastHeartbeatAt: null,
    };
    this.save(record);
    return record;
  }

  save(record: TaskRecord): void {
    record.updatedAt = this.now();
    this.db
      .prepare(
        `INSERT INTO tasks (id, json) VALUES (?, ?)
         ON CONFLICT(id) DO UPDATE SET json = excluded.json`,
      )
      .run(record.id, JSON.stringify(record));
  }

  private normalize(record: TaskRecord): TaskRecord {
    // 读取路径一律留在本数据根内：dataDir 由 (dataRoot, taskId) 派生，不信任
    // 记录里可能来自另一台机器的绝对路径。
    record.dataDir = taskDataDir(this.dataRoot, record.id);
    record.execution = ExecutionConfigSchema.parse(record.execution ?? {});
    if (!Array.isArray(record.workerPids)) record.workerPids = [];
    if (!Array.isArray(record.containerIds)) record.containerIds = [];
    if (record.archivedAt === undefined) record.archivedAt = null;
    if (record.scopeVersion === undefined) record.scopeVersion = 1;
    if (record.pauseRequestedAt === undefined) record.pauseRequestedAt = null;
    if (record.pausedAt === undefined) record.pausedAt = null;
    if (record.lastHeartbeatAt === undefined) record.lastHeartbeatAt = null;
    // Legacy tasks predate engagements: a task with no engagement is its own
    // engagement (it can still hold peer reviews of its own conclusions).
    if (!record.engagementId) record.engagementId = record.id;
    return record;
  }

  /** 归档只改软隐藏标记：状态、检查点与历史一律不动，取消归档只清标记。 */
  setArchived(taskId: string, archived: boolean): TaskRecord | null {
    const t = this.get(taskId);
    if (!t) return null;
    if (archived) {
      if (!isArchivableTaskStatus(t.status)) {
        throw new Error("仅已暂停或终态任务可归档");
      }
      if (!t.archivedAt) t.archivedAt = this.now();
    } else {
      t.archivedAt = null;
    }
    this.save(t);
    return t;
  }

  get(taskId: string): TaskRecord | null {
    const row = this.db.prepare(`SELECT json FROM tasks WHERE id = ?`).get(taskId) as
      | { json: string }
      | undefined;
    if (!row) return null;
    return this.normalize(JSON.parse(row.json) as TaskRecord);
  }

  list(): TaskRecord[] {
    const rows = this.db.prepare(`SELECT json FROM tasks`).all() as Array<{ json: string }>;
    return rows
      .map((r) => this.normalize(JSON.parse(r.json) as TaskRecord))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  finishTask(task: TaskRecord, status: TerminalTaskStatus, error: string | null): TaskRecord {
    task.status = status;
    task.error = error;
    task.finishedAt ??= this.now();
    task.leaseOwner = null;
    task.leaseUntil = null;
    task.workerPid = null;
    task.workerPids = [];
    task.containerId = null;
    task.containerIds = [];
    this.save(task);
    return task;
  }

  acquireLease(
    taskId: string,
    owner: string,
    leaseMs: number,
  ): { ok: true; task: TaskRecord } | { ok: false; reason: string } {
    const t = this.get(taskId);
    if (!t) return { ok: false, reason: "not found" };
    const now = Date.now();
    const until = t.leaseUntil ? Date.parse(t.leaseUntil) : 0;
    if (t.leaseOwner && t.leaseOwner !== owner && until > now) {
      return { ok: false, reason: `held by ${t.leaseOwner}` };
    }
    t.leaseOwner = owner;
    t.leaseUntil = new Date(now + leaseMs).toISOString();
    t.fence += 1;
    this.save(t);
    return { ok: true, task: t };
  }

  renewLease(taskId: string, owner: string, fence: number, leaseMs: number): boolean {
    const t = this.get(taskId);
    if (!t) return false;
    if (t.leaseOwner !== owner || t.fence !== fence) return false;
    t.leaseUntil = new Date(Date.now() + leaseMs).toISOString();
    this.save(t);
    return true;
  }

  activeTasks(): TaskRecord[] {
    return this.list().filter((task) => isActiveTaskStatus(task.status));
  }
}

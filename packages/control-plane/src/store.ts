import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  ExecutionConfigSchema,
  goalsFromSpecs,
  isActiveTaskStatus,
  isTerminalTaskStatus,
  type CreateTaskRequest,
  type TaskRecord,
  type TerminalTaskStatus,
} from "@gongyuai/contracts";
import { taskDataDir, taskPaths } from "./paths.js";

export class ControlStore {
  private readonly db: DatabaseSync;
  readonly dataRoot: string;

  constructor(dataRoot: string) {
    this.dataRoot = dataRoot;
    mkdirSync(dataRoot, { recursive: true });
    const dbPath = `${dataRoot}/control.sqlite`;
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.migrate();
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
    `);
  }

  private now(): string {
    return new Date().toISOString();
  }

  createTask(req: CreateTaskRequest): TaskRecord {
    const id = randomUUID();
    const dataDir = taskDataDir(this.dataRoot, id);
    mkdirSync(dataDir, { recursive: true });
    const paths = taskPaths(dataDir);
    mkdirSync(paths.evidenceDir, { recursive: true });
    mkdirSync(paths.workspaceDir, { recursive: true });

    const now = this.now();
    const record: TaskRecord = {
      id,
      tenantId: req.tenantId ?? "default",
      name: req.name,
      status: "queued",
      auth: req.auth,
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
    record.execution = ExecutionConfigSchema.parse(record.execution ?? {});
    if (!Array.isArray(record.workerPids)) record.workerPids = [];
    if (!Array.isArray(record.containerIds)) record.containerIds = [];
    if (record.archivedAt === undefined) record.archivedAt = null;
    if (record.scopeVersion === undefined) record.scopeVersion = 1;
    if (record.pauseRequestedAt === undefined) record.pauseRequestedAt = null;
    if (record.pausedAt === undefined) record.pausedAt = null;
    if (record.lastHeartbeatAt === undefined) record.lastHeartbeatAt = null;
    return record;
  }

  setArchived(taskId: string, archived: boolean): TaskRecord | null {
    const t = this.get(taskId);
    if (!t) return null;
    if (archived) {
      if (!isTerminalTaskStatus(t.status)) {
        throw new Error("仅终态任务可归档");
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

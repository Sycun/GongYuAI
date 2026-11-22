/**
 * 任务级运营状态：持久资料作业、人工求助、材料导入台账、变更台账。
 *
 * 存在每个任务自己的 History 库里（与事实同一份 SQLite，WAL），
 * 这样作业、求助、材料与证据共享同一个可信边界；平台级记忆另存
 * `platform.sqlite`（见 control-plane/platform.ts）。
 */
import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import {
  AckJobSchema,
  ManualCoverageSchema,
  AnswerConsultSchema,
  BackgroundJobSchema,
  ChangeRecordSchema,
  ConsultationSchema,
  CreateConsultSchema,
  EvidenceImportSchema,
  RegisterChangeSchema,
  SubmitJobSchema,
  consultDueAt,
  jobPauseDisposition,
  jobReceiptKey,
  reconcileJobAfterBoot,
  sweepConsult,
  type AckJobInput,
  type AnswerConsultInput,
  type BackgroundJob,
  type ChangeRecord,
  type Consultation,
  type CreateConsultInput,
  type EvidenceImport,
  type JobKind,
  type JobStatus,
  type ManualCoverage,
  type RegisterChangeInput,
  type SubmitJobInput,
} from "@gongyuai/contracts";

export type OpsScope = { taskId: string; engagementId: string; scopeVersion: number };

export type JobPatch = {
  status?: JobStatus;
  progress?: BackgroundJob["progress"];
  artifacts?: BackgroundJob["artifacts"];
  error?: string | null;
  result?: Record<string, unknown> | null;
  pauseState?: BackgroundJob["pauseState"];
};

type Row = Record<string, unknown>;

function json<T>(value: T): string {
  return JSON.stringify(value);
}

function parseJson<T>(raw: unknown, fallback: T): T {
  if (typeof raw !== "string" || raw.length === 0) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export class TaskOperations {
  private readonly db: DatabaseSync;
  private readonly readOnly: boolean;
  private opsTables = true;

  constructor(db: DatabaseSync, opts: { readOnly?: boolean } = {}) {
    this.db = db;
    this.readOnly = opts.readOnly === true;
    if (!this.readOnly) this.migrate();
    else this.opsTables = this.tableExists("background_jobs");
  }

  private tableExists(name: string): boolean {
    const row = this.db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get(name) as Row | undefined;
    return Boolean(row);
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS background_jobs (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        engagement_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        label TEXT NOT NULL,
        status TEXT NOT NULL,
        scope_version INTEGER NOT NULL,
        asset TEXT,
        submitted_by TEXT NOT NULL,
        options_json TEXT NOT NULL DEFAULT '{}',
        inputs_json TEXT NOT NULL,
        progress_json TEXT NOT NULL,
        artifacts_json TEXT NOT NULL,
        error TEXT,
        receipt_key TEXT NOT NULL,
        delivered_at TEXT,
        attempt INTEGER NOT NULL DEFAULT 0,
        boot_id TEXT,
        pause_state TEXT NOT NULL DEFAULT 'none',
        started_at TEXT,
        finished_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        late_result INTEGER NOT NULL DEFAULT 0,
        result_json TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_jobs_task ON background_jobs(task_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_jobs_status ON background_jobs(status);

      CREATE TABLE IF NOT EXISTS job_receipts (
        job_id TEXT NOT NULL,
        delivery_key TEXT NOT NULL,
        status TEXT NOT NULL,
        delivered_by TEXT NOT NULL,
        note TEXT NOT NULL DEFAULT '',
        at TEXT NOT NULL,
        PRIMARY KEY (job_id, delivery_key)
      );

      CREATE TABLE IF NOT EXISTS consultations (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        engagement_id TEXT NOT NULL,
        question TEXT NOT NULL,
        options_json TEXT NOT NULL,
        context TEXT NOT NULL DEFAULT '',
        blocking INTEGER NOT NULL,
        status TEXT NOT NULL,
        scope_version INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        due_at TEXT NOT NULL,
        released_at TEXT,
        answered_at TEXT,
        answered_by TEXT,
        answer TEXT,
        related_intent_id TEXT,
        related_job_id TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_consults_task ON consultations(task_id, created_at);

      CREATE TABLE IF NOT EXISTS evidence_imports (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        engagement_id TEXT NOT NULL,
        kind TEXT,
        status TEXT NOT NULL,
        source TEXT NOT NULL,
        parser_name TEXT,
        parser_version TEXT,
        imported_at TEXT NOT NULL,
        observed_at TEXT NOT NULL,
        asset TEXT,
        material_path TEXT NOT NULL,
        sha256 TEXT NOT NULL,
        locator TEXT NOT NULL DEFAULT '',
        sensitivity TEXT NOT NULL DEFAULT 'redacted',
        secret_ref TEXT,
        reason TEXT,
        scope_version INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_imports_task ON evidence_imports(task_id, imported_at);

      CREATE TABLE IF NOT EXISTS change_ledger (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        engagement_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        asset TEXT NOT NULL,
        location TEXT NOT NULL,
        before_sha256 TEXT,
        rollback_cmd TEXT NOT NULL,
        applied_at TEXT NOT NULL,
        registered_by TEXT NOT NULL,
        credential_id TEXT,
        intent_id TEXT,
        materials_json TEXT NOT NULL,
        confirmed_by TEXT,
        closed_at TEXT,
        note TEXT NOT NULL DEFAULT '',
        scope_version INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_changes_task ON change_ledger(task_id, applied_at);

      CREATE TABLE IF NOT EXISTS manual_coverage (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        asset TEXT NOT NULL,
        technique TEXT NOT NULL,
        state TEXT NOT NULL,
        reviewer TEXT NOT NULL,
        reason TEXT NOT NULL,
        evidence_json TEXT NOT NULL DEFAULT '[]',
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_manual_coverage_task ON manual_coverage(task_id, asset);
    `);
    this.ensureColumn("background_jobs", "options_json", "TEXT NOT NULL DEFAULT '{}'");
  }

  private ensureColumn(table: string, column: string, ddl: string): void {
    const columns = this.db.prepare(`PRAGMA table_info(${table})`).all() as Row[];
    if (columns.some((row) => String(row.name) === column)) return;
    this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
  }

  private emit(taskId: string, kind: string, payload: Record<string, unknown>): void {
    if (this.readOnly) return;
    try {
      this.db
        .prepare(
          `INSERT INTO events (id, task_id, kind, payload_json, created_at)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .run(randomUUID(), taskId, kind, json(payload), new Date().toISOString());
    } catch {
      // 事件表在极旧库里可能缺失；运营状态本身不能因此丢失。
    }
  }

  /* ------------------------------ 作业 ------------------------------ */

  submitJob(scope: OpsScope, input: SubmitJobInput, nowIso: string): BackgroundJob {
    const parsed = SubmitJobSchema.parse(input);
    const id = randomUUID();
    const job: BackgroundJob = {
      id,
      taskId: scope.taskId,
      engagementId: scope.engagementId,
      kind: parsed.kind,
      label: parsed.label,
      status: "queued",
      scopeVersion: scope.scopeVersion,
      asset: parsed.asset ?? null,
      submittedBy: parsed.submittedBy,
      options: parsed.options,
      inputs: parsed.inputs,
      progress: { done: 0, total: parsed.inputs.length, message: "queued" },
      artifacts: [],
      error: null,
      receiptKey: jobReceiptKey(id, 0),
      deliveredAt: null,
      attempt: 0,
      bootId: null,
      pauseState: "none",
      startedAt: null,
      finishedAt: null,
      createdAt: nowIso,
      updatedAt: nowIso,
      lateResult: false,
      result: null,
    };
    this.db
      .prepare(
        `INSERT INTO background_jobs
          (id, task_id, engagement_id, kind, label, status, scope_version, asset, submitted_by,
           options_json, inputs_json, progress_json, artifacts_json, error, receipt_key, delivered_at,
           attempt, boot_id, pause_state, started_at, finished_at, created_at, updated_at,
           late_result, result_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        job.id, job.taskId, job.engagementId, job.kind, job.label, job.status, job.scopeVersion,
        job.asset, job.submittedBy, json(job.options), json(job.inputs), json(job.progress), json(job.artifacts),
        job.error, job.receiptKey, job.deliveredAt, job.attempt, job.bootId, job.pauseState,
        job.startedAt, job.finishedAt, job.createdAt, job.updatedAt, 0, null,
      );
    this.emit(scope.taskId, "job_submitted", { jobId: job.id, kind: job.kind, label: job.label, scopeVersion: job.scopeVersion });
    return job;
  }

  listJobs(taskId: string): BackgroundJob[] {
    if (!this.opsTables) return [];
    const rows = this.db
      .prepare("SELECT * FROM background_jobs WHERE task_id = ? ORDER BY created_at DESC")
      .all(taskId) as Row[];
    return rows.map((row) => this.rowToJob(row));
  }

  getJob(taskId: string, jobId: string): BackgroundJob | null {
    if (!this.opsTables) return null;
    const row = this.db
      .prepare("SELECT * FROM background_jobs WHERE task_id = ? AND id = ?")
      .get(taskId, jobId) as Row | undefined;
    return row ? this.rowToJob(row) : null;
  }

  startJob(taskId: string, jobId: string, bootId: string, nowIso: string): BackgroundJob | null {
    const job = this.getJob(taskId, jobId);
    if (!job || (job.status !== "queued" && job.status !== "paused")) return null;
    this.db
      .prepare(
        `UPDATE background_jobs
            SET status = 'running', boot_id = ?, attempt = attempt + 1, started_at = ?, updated_at = ?,
                pause_state = 'none', progress_json = ?, error = NULL
          WHERE task_id = ? AND id = ?`,
      )
      .run(bootId, nowIso, nowIso, json({ done: 0, total: job.inputs.length, message: "running" }), taskId, jobId);
    this.emit(taskId, "job_started", { jobId, bootId, attempt: job.attempt + 1 });
    return this.getJob(taskId, jobId);
  }

  updateJob(taskId: string, jobId: string, patch: JobPatch, nowIso: string): BackgroundJob | null {
    const job = this.getJob(taskId, jobId);
    if (!job) return null;
    const next: BackgroundJob = {
      ...job,
      ...(patch.status ? { status: patch.status } : {}),
      ...(patch.progress ? { progress: patch.progress } : {}),
      ...(patch.artifacts ? { artifacts: patch.artifacts } : {}),
      ...(patch.error !== undefined ? { error: patch.error } : {}),
      ...(patch.result !== undefined ? { result: patch.result } : {}),
      ...(patch.pauseState ? { pauseState: patch.pauseState } : {}),
      updatedAt: nowIso,
    };
    this.persistJob(next);
    return next;
  }

  finishJob(
    taskId: string,
    jobId: string,
    outcome: {
      status: "succeeded" | "failed";
      artifacts?: BackgroundJob["artifacts"];
      result?: Record<string, unknown> | null;
      error?: string | null;
      scopeVersion: number;
      nowIso: string;
    },
  ): BackgroundJob | null {
    const job = this.getJob(taskId, jobId);
    if (!job) return null;
    const late = outcome.scopeVersion > job.scopeVersion;
    const next: BackgroundJob = {
      ...job,
      status: outcome.status,
      artifacts: outcome.artifacts ?? job.artifacts,
      result: outcome.result ?? null,
      error: outcome.error ?? null,
      finishedAt: outcome.nowIso,
      updatedAt: outcome.nowIso,
      progress: {
        done: job.progress.total,
        total: job.progress.total,
        message: outcome.status === "succeeded" ? "done" : "failed",
      },
      lateResult: late,
      pauseState: "none",
    };
    this.persistJob(next);
    this.emit(taskId, "job_finished", {
      jobId,
      status: next.status,
      artifactPaths: next.artifacts.map((artifact) => artifact.path),
      error: next.error,
    });
    if (late) {
      this.emit(taskId, "job_late_result", {
        jobId,
        submittedScopeVersion: job.scopeVersion,
        currentScopeVersion: outcome.scopeVersion,
      });
    }
    return next;
  }

  /** 暂停：已在执行中的标 draining，未开始的标 stopped；都不谎报成功。 */
  pauseJobs(taskId: string, inFlight: ReadonlySet<string>, nowIso: string): BackgroundJob[] {
    const changed: BackgroundJob[] = [];
    for (const job of this.listJobs(taskId)) {
      const disposition = jobPauseDisposition(job.status, inFlight.has(job.id));
      if (disposition === "unchanged") continue;
      const next: BackgroundJob = {
        ...job,
        status: disposition === "draining" ? "draining" : "paused",
        pauseState: disposition,
        updatedAt: nowIso,
      };
      this.persistJob(next);
      this.emit(taskId, "job_paused", { jobId: job.id, disposition });
      changed.push(next);
    }
    return changed;
  }

  resumeJobs(taskId: string, nowIso: string): BackgroundJob[] {
    const changed: BackgroundJob[] = [];
    for (const job of this.listJobs(taskId)) {
      if (job.status !== "paused" && job.status !== "draining") continue;
      const next: BackgroundJob = { ...job, status: "queued", pauseState: "none", updatedAt: nowIso };
      this.persistJob(next);
      changed.push(next);
    }
    return changed;
  }

  reconcileJobsAfterBoot(taskId: string, bootId: string, nowIso: string): BackgroundJob[] {
    const changed: BackgroundJob[] = [];
    for (const job of this.listJobs(taskId)) {
      const next = reconcileJobAfterBoot(job, bootId);
      if (!next) continue;
      const updated: BackgroundJob = { ...job, status: next, pauseState: "unknown", updatedAt: nowIso };
      this.persistJob(updated);
      this.emit(taskId, "job_reconcile_after_boot", { jobId: job.id, previousBootId: job.bootId, bootId });
      changed.push(updated);
    }
    return changed;
  }

  ackJob(
    taskId: string,
    jobId: string,
    input: AckJobInput,
    nowIso: string,
  ): {
    receipt: { jobId: string; deliveryKey: string; status: JobStatus; deliveredBy: string; note: string; at: string };
    duplicate: boolean;
  } {
    const parsed = AckJobSchema.parse(input);
    const job = this.getJob(taskId, jobId);
    if (!job) throw new Error(`job-not-found:${jobId}`);
    const inserted = this.db
      .prepare(
        `INSERT INTO job_receipts (job_id, delivery_key, status, delivered_by, note, at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(job_id, delivery_key) DO NOTHING`,
      )
      .run(jobId, parsed.deliveryKey, job.status, parsed.deliveredBy, parsed.note, nowIso);
    const duplicate = Number(inserted.changes) === 0;
    if (!duplicate) {
      this.db
        .prepare("UPDATE background_jobs SET delivered_at = ?, updated_at = ? WHERE task_id = ? AND id = ?")
        .run(nowIso, nowIso, taskId, jobId);
      this.emit(taskId, "job_delivered", { jobId, deliveryKey: parsed.deliveryKey, deliveredBy: parsed.deliveredBy });
    }
    return {
      receipt: { jobId, deliveryKey: parsed.deliveryKey, status: job.status, deliveredBy: parsed.deliveredBy, note: parsed.note, at: nowIso },
      duplicate,
    };
  }

  listReceipts(taskId: string, jobId: string): Array<{ deliveryKey: string; status: string; deliveredBy: string; at: string }> {
    if (!this.opsTables) return [];
    const rows = this.db
      .prepare(
        `SELECT r.delivery_key AS deliveryKey, r.status AS status, r.delivered_by AS deliveredBy, r.at AS at
           FROM job_receipts r JOIN background_jobs j ON j.id = r.job_id
          WHERE j.task_id = ? AND r.job_id = ? ORDER BY r.at`,
      )
      .all(taskId, jobId) as Row[];
    return rows.map((row) => ({
      deliveryKey: String(row.deliveryKey),
      status: String(row.status),
      deliveredBy: String(row.deliveredBy),
      at: String(row.at),
    }));
  }

  private persistJob(job: BackgroundJob): void {
    this.db
      .prepare(
        `UPDATE background_jobs
            SET status = ?, progress_json = ?, artifacts_json = ?, error = ?, result_json = ?,
                delivered_at = ?, pause_state = ?, boot_id = ?, started_at = ?, finished_at = ?,
                updated_at = ?, late_result = ?
          WHERE task_id = ? AND id = ?`,
      )
      .run(
        job.status, json(job.progress), json(job.artifacts), job.error, job.result === null ? null : json(job.result),
        job.deliveredAt, job.pauseState, job.bootId, job.startedAt, job.finishedAt, job.updatedAt,
        job.lateResult ? 1 : 0, job.taskId, job.id,
      );
  }

  private rowToJob(row: Row): BackgroundJob {
    return BackgroundJobSchema.parse({
      id: String(row.id),
      taskId: String(row.task_id),
      engagementId: String(row.engagement_id),
      kind: String(row.kind),
      label: String(row.label),
      status: String(row.status),
      scopeVersion: Number(row.scope_version),
      asset: row.asset === null || row.asset === undefined ? null : String(row.asset),
      submittedBy: String(row.submitted_by),
      options: parseJson(row.options_json, {}),
      inputs: parseJson(row.inputs_json, []),
      progress: parseJson(row.progress_json, { done: 0, total: 0, message: "" }),
      artifacts: parseJson(row.artifacts_json, []),
      error: row.error === null || row.error === undefined ? null : String(row.error),
      receiptKey: String(row.receipt_key),
      deliveredAt: row.delivered_at === null || row.delivered_at === undefined ? null : String(row.delivered_at),
      attempt: Number(row.attempt),
      bootId: row.boot_id === null || row.boot_id === undefined ? null : String(row.boot_id),
      pauseState: String(row.pause_state ?? "none"),
      startedAt: row.started_at === null || row.started_at === undefined ? null : String(row.started_at),
      finishedAt: row.finished_at === null || row.finished_at === undefined ? null : String(row.finished_at),
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
      lateResult: Number(row.late_result) === 1,
      result: parseJson<Record<string, unknown> | null>(row.result_json, null),
    });
  }

  /* ---------------------------- 人工求助 ---------------------------- */

  createConsult(scope: OpsScope, input: CreateConsultInput, nowMs: number): Consultation {
    const parsed = CreateConsultSchema.parse(input);
    const id = randomUUID();
    const createdAt = new Date(nowMs).toISOString();
    const consult: Consultation = {
      id,
      taskId: scope.taskId,
      engagementId: scope.engagementId,
      question: parsed.question,
      options: parsed.options,
      context: parsed.context,
      blocking: parsed.blocking,
      status: "open",
      scopeVersion: scope.scopeVersion,
      createdAt,
      dueAt: consultDueAt(nowMs),
      releasedAt: null,
      answeredAt: null,
      answeredBy: null,
      answer: null,
      relatedIntentId: parsed.relatedIntentId ?? null,
      relatedJobId: parsed.relatedJobId ?? null,
    };
    this.db
      .prepare(
        `INSERT INTO consultations
          (id, task_id, engagement_id, question, options_json, context, blocking, status,
           scope_version, created_at, due_at, released_at, answered_at, answered_by, answer,
           related_intent_id, related_job_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        consult.id, consult.taskId, consult.engagementId, consult.question, json(consult.options),
        consult.context, consult.blocking ? 1 : 0, consult.status, consult.scopeVersion,
        consult.createdAt, consult.dueAt, null, null, null, null,
        consult.relatedIntentId, consult.relatedJobId,
      );
    this.emit(scope.taskId, "consult_opened", { consultId: id, blocking: consult.blocking, dueAt: consult.dueAt });
    return consult;
  }

  listConsults(taskId: string): Consultation[] {
    if (!this.opsTables) return [];
    const rows = this.db
      .prepare("SELECT * FROM consultations WHERE task_id = ? ORDER BY created_at DESC")
      .all(taskId) as Row[];
    return rows.map((row) => this.rowToConsult(row));
  }

  answerConsult(taskId: string, consultId: string, input: AnswerConsultInput, nowMs: number): Consultation {
    const parsed = AnswerConsultSchema.parse(input);
    const current = this.listConsults(taskId).find((entry) => entry.id === consultId);
    if (!current) throw new Error(`consult-not-found:${consultId}`);
    if (current.status !== "open") throw new Error(`consult-not-open:${current.status}`);
    const at = new Date(nowMs).toISOString();
    this.db
      .prepare(
        `UPDATE consultations SET status = 'answered', answered_at = ?, answered_by = ?, answer = ?
          WHERE task_id = ? AND id = ?`,
      )
      .run(at, parsed.answeredBy, parsed.answer, taskId, consultId);
    this.emit(taskId, "consult_answered", { consultId, answeredBy: parsed.answeredBy });
    return { ...current, status: "answered", answeredAt: at, answeredBy: parsed.answeredBy, answer: parsed.answer };
  }

  /** 24h 转非阻塞：只解除阻塞，问题保留。 */
  sweepConsults(taskId: string, nowMs: number): Consultation[] {
    const changed: Consultation[] = [];
    for (const consult of this.listConsults(taskId)) {
      const result = sweepConsult(consult, nowMs);
      if (!result.changed) continue;
      this.db
        .prepare("UPDATE consultations SET blocking = ?, released_at = ? WHERE task_id = ? AND id = ?")
        .run(result.next.blocking ? 1 : 0, result.next.releasedAt, taskId, consult.id);
      this.emit(taskId, "consult_released", { consultId: consult.id, reason: result.reason, dueAt: consult.dueAt });
      changed.push(result.next);
    }
    return changed;
  }

  private rowToConsult(row: Row): Consultation {
    return ConsultationSchema.parse({
      id: String(row.id),
      taskId: String(row.task_id),
      engagementId: String(row.engagement_id),
      question: String(row.question),
      options: parseJson(row.options_json, []),
      context: String(row.context ?? ""),
      blocking: Number(row.blocking) === 1,
      status: String(row.status),
      scopeVersion: Number(row.scope_version),
      createdAt: String(row.created_at),
      dueAt: String(row.due_at),
      releasedAt: row.released_at === null || row.released_at === undefined ? null : String(row.released_at),
      answeredAt: row.answered_at === null || row.answered_at === undefined ? null : String(row.answered_at),
      answeredBy: row.answered_by === null || row.answered_by === undefined ? null : String(row.answered_by),
      answer: row.answer === null || row.answer === undefined ? null : String(row.answer),
      relatedIntentId: row.related_intent_id === null || row.related_intent_id === undefined ? null : String(row.related_intent_id),
      relatedJobId: row.related_job_id === null || row.related_job_id === undefined ? null : String(row.related_job_id),
    });
  }

  /* ---------------------------- 材料台账 ---------------------------- */

  recordMaterial(material: EvidenceImport): EvidenceImport {
    const parsed = EvidenceImportSchema.parse(material);
    this.db
      .prepare(
        `INSERT INTO evidence_imports
          (id, task_id, engagement_id, kind, status, source, parser_name, parser_version,
           imported_at, observed_at, asset, material_path, sha256, locator, sensitivity, secret_ref,
           reason, scope_version)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        parsed.id, parsed.taskId, parsed.engagementId, parsed.kind, parsed.status, parsed.source,
        parsed.parser?.name ?? null, parsed.parser?.version ?? null, parsed.importedAt, parsed.observedAt,
        parsed.asset, parsed.materialPath, parsed.sha256, parsed.locator, parsed.sensitivity,
        parsed.secretRef, parsed.reason, parsed.scopeVersion,
      );
    this.emit(parsed.taskId, "material_imported", {
      materialPath: parsed.materialPath,
      kind: parsed.kind,
      status: parsed.status,
      sha256: parsed.sha256,
      reason: parsed.reason,
    });
    return parsed;
  }

  listMaterials(taskId: string): EvidenceImport[] {
    if (!this.opsTables) return [];
    const rows = this.db
      .prepare("SELECT * FROM evidence_imports WHERE task_id = ? ORDER BY imported_at DESC")
      .all(taskId) as Row[];
    return rows.map((row) =>
      EvidenceImportSchema.parse({
        id: String(row.id),
        taskId: String(row.task_id),
        engagementId: String(row.engagement_id),
        kind: row.kind === null || row.kind === undefined ? null : String(row.kind),
        status: String(row.status),
        source: String(row.source),
        parser: row.parser_name ? { name: String(row.parser_name), version: String(row.parser_version ?? "unknown") } : null,
        importedAt: String(row.imported_at),
        observedAt: String(row.observed_at),
        asset: row.asset === null || row.asset === undefined ? null : String(row.asset),
        materialPath: String(row.material_path),
        sha256: String(row.sha256),
        locator: String(row.locator ?? ""),
        sensitivity: String(row.sensitivity ?? "redacted"),
        secretRef: row.secret_ref === null || row.secret_ref === undefined ? null : String(row.secret_ref),
        reason: row.reason === null || row.reason === undefined ? null : String(row.reason),
        scopeVersion: Number(row.scope_version),
      }),
    );
  }

  /* ---------------------------- 变更台账 ---------------------------- */

  recordChange(scope: OpsScope, input: RegisterChangeInput, beforeSha256: string | null, nowIso: string, materials: ChangeRecord["materials"]): ChangeRecord {
    const parsed = RegisterChangeSchema.parse(input);
    const change: ChangeRecord = {
      id: randomUUID(),
      taskId: scope.taskId,
      engagementId: scope.engagementId,
      kind: parsed.kind,
      asset: parsed.asset,
      location: parsed.location,
      beforeSha256,
      rollbackCmd: parsed.rollbackCmd,
      appliedAt: parsed.appliedAt ?? nowIso,
      registeredBy: parsed.registeredBy,
      credentialId: parsed.credentialId ?? null,
      intentId: parsed.intentId ?? null,
      materials,
      confirmedBy: null,
      closedAt: null,
      note: parsed.note,
      scopeVersion: scope.scopeVersion,
    };
    this.db
      .prepare(
        `INSERT INTO change_ledger
          (id, task_id, engagement_id, kind, asset, location, before_sha256, rollback_cmd, applied_at,
           registered_by, credential_id, intent_id, materials_json, confirmed_by, closed_at, note, scope_version)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        change.id, change.taskId, change.engagementId, change.kind, change.asset, change.location,
        change.beforeSha256, change.rollbackCmd, change.appliedAt, change.registeredBy,
        change.credentialId, change.intentId, json(change.materials), null, null, change.note,
        change.scopeVersion,
      );
    this.emit(scope.taskId, "change_registered", {
      changeId: change.id,
      kind: change.kind,
      asset: change.asset,
      location: change.location,
      beforeSha256: change.beforeSha256,
    });
    return change;
  }

  listChanges(taskId: string): ChangeRecord[] {
    if (!this.opsTables) return [];
    const rows = this.db
      .prepare("SELECT * FROM change_ledger WHERE task_id = ? ORDER BY applied_at")
      .all(taskId) as Row[];
    return rows.map((row) =>
      ChangeRecordSchema.parse({
        id: String(row.id),
        taskId: String(row.task_id),
        engagementId: String(row.engagement_id),
        kind: String(row.kind),
        asset: String(row.asset),
        location: String(row.location),
        beforeSha256: row.before_sha256 === null || row.before_sha256 === undefined ? null : String(row.before_sha256),
        rollbackCmd: String(row.rollback_cmd),
        appliedAt: String(row.applied_at),
        registeredBy: String(row.registered_by),
        credentialId: row.credential_id === null || row.credential_id === undefined ? null : String(row.credential_id),
        intentId: row.intent_id === null || row.intent_id === undefined ? null : String(row.intent_id),
        materials: parseJson(row.materials_json, []),
        confirmedBy: row.confirmed_by === null || row.confirmed_by === undefined ? null : String(row.confirmed_by),
        closedAt: row.closed_at === null || row.closed_at === undefined ? null : String(row.closed_at),
        note: String(row.note ?? ""),
        scopeVersion: Number(row.scope_version),
      }),
    );
  }

  confirmChange(taskId: string, changeId: string, by: string, nowIso: string): ChangeRecord | null {
    const existing = this.listChanges(taskId).find((entry) => entry.id === changeId);
    if (!existing) return null;
    this.db
      .prepare("UPDATE change_ledger SET confirmed_by = ?, closed_at = ? WHERE task_id = ? AND id = ?")
      .run(by, nowIso, taskId, changeId);
    this.emit(taskId, "change_confirmed", { changeId, confirmedBy: by });
    return { ...existing, confirmedBy: by, closedAt: nowIso };
  }

  recordManualCoverage(scope: OpsScope, input: unknown, nowIso: string): ManualCoverage {
    const parsed = ManualCoverageSchema.parse(input);
    const row: ManualCoverage = { ...parsed, id: randomUUID(), createdAt: nowIso };
    this.db
      .prepare(
        `INSERT INTO manual_coverage (id, task_id, asset, technique, state, reviewer, reason, evidence_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(row.id, scope.taskId, row.asset, row.technique, row.state, row.reviewer, row.reason, json(row.evidenceRefs), nowIso);
    this.emit(scope.taskId, "change_registered", { coverageManual: row.id, asset: row.asset, technique: row.technique, state: row.state });
    return row;
  }

  listManualCoverage(taskId: string): ManualCoverage[] {
    if (!this.opsTables) return [];
    const rows = this.db
      .prepare("SELECT * FROM manual_coverage WHERE task_id = ? ORDER BY created_at")
      .all(taskId) as Row[];
    return rows.map((row) => ({
      id: String(row.id),
      asset: String(row.asset),
      technique: String(row.technique),
      state: String(row.state) as "manual" | "verified",
      reviewer: String(row.reviewer),
      reason: String(row.reason),
      evidenceRefs: parseJson(row.evidence_json, []),
      createdAt: String(row.created_at),
    }));
  }

  /** 作业统计（今日工作 / 交接用）。 */
  jobSummary(taskId: string): { running: number; queued: number; late: number; blocked: number } {
    const jobs = this.listJobs(taskId);
    return {
      running: jobs.filter((job) => job.status === "running" || job.status === "draining").length,
      queued: jobs.filter((job) => job.status === "queued" || job.status === "paused").length,
      late: jobs.filter((job) => job.lateResult).length,
      blocked: jobs.filter((job) => job.status === "failed" || job.status === "unknown").length,
    };
  }
}

export type { JobKind };

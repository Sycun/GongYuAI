import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type {
  Fact,
  FactLayer,
  GoalState,
  HistoryEvent,
  HistoryEventKind,
  Intent,
  IntentStatus,
} from "@gongyuai/contracts";
import { ORIGIN_FACT_ID } from "@gongyuai/contracts";
import { minimatch } from "./minimatch.js";

export type ConcludeFactInput = {
  layer: FactLayer;
  title: string;
  summary?: string;
  evidencePath?: string | null;
  tags?: string[];
};

export type OpenHistoryOptions = {
  dbPath: string;
  evidenceDir: string;
};

export class HistoryStore {
  readonly dbPath: string;
  readonly evidenceDir: string;
  private readonly db: DatabaseSync;

  constructor(opts: OpenHistoryOptions) {
    this.dbPath = opts.dbPath;
    this.evidenceDir = opts.evidenceDir;
    mkdirSync(dirname(opts.dbPath), { recursive: true });
    mkdirSync(opts.evidenceDir, { recursive: true });
    this.db = new DatabaseSync(opts.dbPath);
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec("PRAGMA foreign_keys = ON;");
    this.migrate();
  }

  close(): void {
    this.db.close();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS facts (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        layer TEXT NOT NULL,
        title TEXT NOT NULL,
        summary TEXT NOT NULL DEFAULT '',
        evidence_path TEXT,
        tags_json TEXT NOT NULL DEFAULT '[]',
        created_at TEXT NOT NULL,
        intent_id TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_facts_task ON facts(task_id, created_at);

      CREATE TABLE IF NOT EXISTS intents (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        title TEXT NOT NULL,
        summary TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL,
        source_fact_ids_json TEXT NOT NULL DEFAULT '["origin"]',
        claimed_by TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        concluded_at TEXT,
        conclusion TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_intents_task ON intents(task_id, status);

      CREATE TABLE IF NOT EXISTS goals (
        id TEXT NOT NULL,
        task_id TEXT NOT NULL,
        title TEXT NOT NULL,
        description TEXT NOT NULL,
        evidence_patterns_json TEXT NOT NULL,
        passes INTEGER NOT NULL DEFAULT 0,
        evidence_paths_json TEXT NOT NULL DEFAULT '[]',
        asserted_at TEXT,
        PRIMARY KEY (task_id, id)
      );

      CREATE TABLE IF NOT EXISTS events (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        payload_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_events_task ON events(task_id, created_at);
    `);
    this.ensureIntentSourceFactIdsColumn();
  }

  /** Migrate pre-P0 DBs that lack source_fact_ids_json. */
  private ensureIntentSourceFactIdsColumn(): void {
    const cols = this.db
      .prepare(`PRAGMA table_info(intents)`)
      .all() as Array<{ name: string }>;
    if (cols.some((c) => c.name === "source_fact_ids_json")) return;
    this.db.exec(
      `ALTER TABLE intents ADD COLUMN source_fact_ids_json TEXT NOT NULL DEFAULT '["origin"]'`,
    );
  }

  private now(): string {
    return new Date().toISOString();
  }

  private emit(
    taskId: string,
    kind: HistoryEventKind,
    payload: Record<string, unknown> = {},
  ): HistoryEvent {
    const event: HistoryEvent = {
      id: randomUUID(),
      taskId,
      kind,
      payload,
      createdAt: this.now(),
    };
    this.db
      .prepare(
        `INSERT INTO events (id, task_id, kind, payload_json, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(event.id, event.taskId, event.kind, JSON.stringify(event.payload), event.createdAt);
    return event;
  }

  seedGoals(taskId: string, goals: GoalState[]): void {
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO goals
        (id, task_id, title, description, evidence_patterns_json, passes, evidence_paths_json, asserted_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    this.db.exec("BEGIN");
    try {
      for (const g of goals) {
        stmt.run(
          g.id,
          taskId,
          g.title,
          g.description,
          JSON.stringify(g.evidencePatterns),
          g.passes ? 1 : 0,
          JSON.stringify(g.evidencePaths),
          g.assertedAt,
        );
      }
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  listGoals(taskId: string): GoalState[] {
    const rows = this.db
      .prepare(`SELECT * FROM goals WHERE task_id = ? ORDER BY id`)
      .all(taskId) as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      id: String(r.id),
      title: String(r.title),
      description: String(r.description),
      evidencePatterns: JSON.parse(String(r.evidence_patterns_json)) as string[],
      passes: Boolean(r.passes),
      evidencePaths: JSON.parse(String(r.evidence_paths_json)) as string[],
      assertedAt: (r.asserted_at as string | null) ?? null,
    }));
  }

  appendFact(input: {
    taskId: string;
    layer: FactLayer;
    title: string;
    summary?: string;
    evidencePath?: string | null;
    tags?: string[];
    intentId?: string | null;
  }): Fact {
    const fact: Fact = {
      id: randomUUID(),
      taskId: input.taskId,
      layer: input.layer,
      title: input.title,
      summary: input.summary ?? "",
      evidencePath: input.evidencePath ?? null,
      tags: input.tags ?? [],
      createdAt: this.now(),
      intentId: input.intentId ?? null,
    };
    this.db
      .prepare(
        `INSERT INTO facts
          (id, task_id, layer, title, summary, evidence_path, tags_json, created_at, intent_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        fact.id,
        fact.taskId,
        fact.layer,
        fact.title,
        fact.summary,
        fact.evidencePath,
        JSON.stringify(fact.tags),
        fact.createdAt,
        fact.intentId,
      );
    this.emit(input.taskId, "fact_appended", {
      factId: fact.id,
      title: fact.title,
      layer: fact.layer,
    });
    return fact;
  }

  listFacts(taskId: string, layer?: FactLayer): Fact[] {
    const rows = layer
      ? (this.db
          .prepare(
            `SELECT * FROM facts WHERE task_id = ? AND layer = ? ORDER BY created_at ASC`,
          )
          .all(taskId, layer) as Array<Record<string, unknown>>)
      : (this.db
          .prepare(`SELECT * FROM facts WHERE task_id = ? ORDER BY created_at ASC`)
          .all(taskId) as Array<Record<string, unknown>>);
    return rows.map((r) => this.rowToFact(r));
  }

  getFact(taskId: string, factId: string): Fact | null {
    const r = this.db
      .prepare(`SELECT * FROM facts WHERE task_id = ? AND id = ?`)
      .get(taskId, factId) as Record<string, unknown> | undefined;
    if (!r) return null;
    return this.rowToFact(r);
  }

  private rowToFact(r: Record<string, unknown>): Fact {
    return {
      id: String(r.id),
      taskId: String(r.task_id),
      layer: r.layer as FactLayer,
      title: String(r.title),
      summary: String(r.summary),
      evidencePath: (r.evidence_path as string | null) ?? null,
      tags: JSON.parse(String(r.tags_json)) as string[],
      createdAt: String(r.created_at),
      intentId: (r.intent_id as string | null) ?? null,
    };
  }

  private validateSourceFactIds(taskId: string, sourceFactIds: string[]): string[] {
    if (!sourceFactIds.length) {
      throw new Error("sourceFactIds required: Intent must hang on ≥1 Fact (or origin)");
    }
    const unique = [...new Set(sourceFactIds.map((id) => id.trim()).filter(Boolean))];
    if (!unique.length) {
      throw new Error("sourceFactIds required: Intent must hang on ≥1 Fact (or origin)");
    }
    for (const id of unique) {
      if (id === ORIGIN_FACT_ID) continue;
      const row = this.db
        .prepare(`SELECT 1 AS ok FROM facts WHERE task_id = ? AND id = ?`)
        .get(taskId, id) as { ok: number } | undefined;
      if (!row) {
        throw new Error(`unknown source fact: ${id}`);
      }
    }
    return unique;
  }

  proposeIntent(input: {
    taskId: string;
    title: string;
    summary?: string;
    sourceFactIds: string[];
  }): Intent {
    const sourceFactIds = this.validateSourceFactIds(input.taskId, input.sourceFactIds);
    const now = this.now();
    const intent: Intent = {
      id: randomUUID(),
      taskId: input.taskId,
      title: input.title,
      summary: input.summary ?? "",
      status: "proposed",
      sourceFactIds,
      claimedBy: null,
      createdAt: now,
      updatedAt: now,
      concludedAt: null,
      conclusion: null,
    };
    this.db
      .prepare(
        `INSERT INTO intents
          (id, task_id, title, summary, status, source_fact_ids_json, claimed_by, created_at, updated_at, concluded_at, conclusion)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        intent.id,
        intent.taskId,
        intent.title,
        intent.summary,
        intent.status,
        JSON.stringify(intent.sourceFactIds),
        intent.claimedBy,
        intent.createdAt,
        intent.updatedAt,
        intent.concludedAt,
        intent.conclusion,
      );
    this.emit(input.taskId, "intent_proposed", {
      intentId: intent.id,
      title: intent.title,
      sourceFactIds: intent.sourceFactIds,
    });
    return intent;
  }

  claimIntent(taskId: string, intentId: string, workerId: string): Intent | null {
    const now = this.now();
    const result = this.db
      .prepare(
        `UPDATE intents
         SET status = 'claimed', claimed_by = ?, updated_at = ?
         WHERE id = ? AND task_id = ? AND status = 'proposed'`,
      )
      .run(workerId, now, intentId, taskId);
    if ((result.changes ?? 0) === 0) return null;
    this.emit(taskId, "intent_claimed", { intentId, workerId });
    return this.getIntent(taskId, intentId);
  }

  /**
   * Conclude an Intent. On `succeeded`, must append ≥1 Fact bound to this Intent
   * (Fact←Intent back-edge) in the same call — no success without graph writeback.
   */
  concludeIntent(
    taskId: string,
    intentId: string,
    status: Extract<IntentStatus, "succeeded" | "failed">,
    conclusion: string,
    opts?: { facts?: ConcludeFactInput[] },
  ): Intent | null {
    const facts = opts?.facts ?? [];
    if (status === "succeeded" && facts.length === 0) {
      throw new Error(
        "conclude(succeeded) requires ≥1 Fact with intentId (Explore writeback)",
      );
    }

    const now = this.now();
    this.db.exec("BEGIN");
    try {
      const result = this.db
        .prepare(
          `UPDATE intents
           SET status = ?, conclusion = ?, concluded_at = ?, updated_at = ?
           WHERE id = ? AND task_id = ? AND status IN ('claimed', 'running', 'proposed')`,
        )
        .run(status, conclusion, now, now, intentId, taskId);
      if ((result.changes ?? 0) === 0) {
        this.db.exec("ROLLBACK");
        return null;
      }

      for (const f of facts) {
        const fact: Fact = {
          id: randomUUID(),
          taskId,
          layer: f.layer,
          title: f.title,
          summary: f.summary ?? "",
          evidencePath: f.evidencePath ?? null,
          tags: f.tags ?? [],
          createdAt: now,
          intentId,
        };
        this.db
          .prepare(
            `INSERT INTO facts
              (id, task_id, layer, title, summary, evidence_path, tags_json, created_at, intent_id)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            fact.id,
            fact.taskId,
            fact.layer,
            fact.title,
            fact.summary,
            fact.evidencePath,
            JSON.stringify(fact.tags),
            fact.createdAt,
            fact.intentId,
          );
        this.emit(taskId, "fact_appended", {
          factId: fact.id,
          title: fact.title,
          layer: fact.layer,
          intentId,
        });
      }

      this.emit(taskId, "intent_concluded", { intentId, status, conclusion });
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
    return this.getIntent(taskId, intentId);
  }

  getIntent(taskId: string, intentId: string): Intent | null {
    const r = this.db
      .prepare(`SELECT * FROM intents WHERE task_id = ? AND id = ?`)
      .get(taskId, intentId) as Record<string, unknown> | undefined;
    if (!r) return null;
    return this.rowToIntent(r);
  }

  listIntents(taskId: string, status?: IntentStatus): Intent[] {
    const rows = status
      ? (this.db
          .prepare(`SELECT * FROM intents WHERE task_id = ? AND status = ? ORDER BY created_at`)
          .all(taskId, status) as Array<Record<string, unknown>>)
      : (this.db
          .prepare(`SELECT * FROM intents WHERE task_id = ? ORDER BY created_at`)
          .all(taskId) as Array<Record<string, unknown>>);
    return rows.map((r) => this.rowToIntent(r));
  }

  private rowToIntent(r: Record<string, unknown>): Intent {
    let sourceFactIds: string[] = [ORIGIN_FACT_ID];
    try {
      const parsed = JSON.parse(String(r.source_fact_ids_json ?? "[]")) as unknown;
      if (Array.isArray(parsed) && parsed.length > 0) {
        sourceFactIds = parsed.map(String);
      }
    } catch {
      sourceFactIds = [ORIGIN_FACT_ID];
    }
    return {
      id: String(r.id),
      taskId: String(r.task_id),
      title: String(r.title),
      summary: String(r.summary),
      status: r.status as IntentStatus,
      sourceFactIds,
      claimedBy: (r.claimed_by as string | null) ?? null,
      createdAt: String(r.created_at),
      updatedAt: String(r.updated_at),
      concludedAt: (r.concluded_at as string | null) ?? null,
      conclusion: (r.conclusion as string | null) ?? null,
    };
  }

  assertGoal(
    taskId: string,
    goalId: string,
    evidencePaths: string[],
  ): { ok: true; goal: GoalState } | { ok: false; reason: string } {
    const goals = this.listGoals(taskId);
    const goal = goals.find((g) => g.id === goalId);
    if (!goal) return { ok: false, reason: `unknown goal: ${goalId}` };
    if (goal.passes) return { ok: true, goal };

    const normalized = evidencePaths.map((p) => p.replace(/^\.?\/+/, ""));
    for (const pattern of goal.evidencePatterns) {
      const hit = normalized.find((p) => {
        const abs = join(this.evidenceDir, p);
        return existsSync(abs) && minimatch(p, pattern);
      });
      if (!hit) {
        return {
          ok: false,
          reason: `missing evidence for pattern "${pattern}" (provided: ${normalized.join(", ") || "none"})`,
        };
      }
    }

    for (const p of normalized) {
      if (!existsSync(join(this.evidenceDir, p))) {
        return { ok: false, reason: `evidence file missing: ${p}` };
      }
    }

    // Semantic gate: ALL_COMPLETE.json must prove every challenge is_completed.
    for (const p of normalized) {
      if (!/(^|\/)ALL_COMPLETE\.json$/i.test(p)) continue;
      const verdict = validateAllCompleteEvidence(join(this.evidenceDir, p));
      if (verdict) return { ok: false, reason: verdict };
    }

    const assertedAt = this.now();
    this.db
      .prepare(
        `UPDATE goals
         SET passes = 1, evidence_paths_json = ?, asserted_at = ?
         WHERE task_id = ? AND id = ?`,
      )
      .run(JSON.stringify(normalized), assertedAt, taskId, goalId);

    const updated = this.listGoals(taskId).find((g) => g.id === goalId)!;
    this.emit(taskId, "goal_asserted", { goalId, evidencePaths: normalized });
    return { ok: true, goal: updated };
  }

  allGoalsPass(taskId: string): boolean {
    const goals = this.listGoals(taskId);
    return goals.length > 0 && goals.every((g) => g.passes);
  }

  recordInstall(taskId: string, tool: string, detail: Record<string, unknown>): void {
    this.emit(taskId, "tool_installed", { tool, ...detail });
  }

  recordReport(taskId: string, reportPath: string): void {
    this.emit(taskId, "report_written", { reportPath });
  }

  listEvents(taskId: string, limit = 200): HistoryEvent[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM events WHERE task_id = ? ORDER BY created_at DESC LIMIT ?`,
      )
      .all(taskId, limit) as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      id: String(r.id),
      taskId: String(r.task_id),
      kind: r.kind as HistoryEventKind,
      payload: JSON.parse(String(r.payload_json)) as Record<string, unknown>,
      createdAt: String(r.created_at),
    }));
  }

  /**
   * Worker Observe surface: Goals + title-layer Facts + open Intents only.
   * Summary / evidence stay out of the default prompt — drill via getFact / listFacts.
   */
  observe(taskId: string): string {
    const lines = this.observeCore(taskId);
    lines.push(
      "",
      "（Observe 不含 summary/evidence；需要时用 history_read_fact / history_list_layer。）",
    );
    return lines.join("\n");
  }

  /** Human / report view: Observe + recent summaries (not injected into Worker system prompt). */
  overview(taskId: string): string {
    const lines = this.observeCore(taskId);
    const summaries = this.listFacts(taskId, "summary").slice(-20);
    lines.push("", "## 近期摘要");
    if (summaries.length === 0) {
      lines.push("- （无）");
    } else {
      for (const f of summaries) {
        lines.push(`- [${f.id.slice(0, 8)}] ${f.title}: ${f.summary.slice(0, 240)}`);
      }
    }
    return lines.join("\n");
  }

  private observeCore(taskId: string): string[] {
    const goals = this.listGoals(taskId);
    const titles = this.listFacts(taskId, "title").slice(-50);
    const open = this.listIntents(taskId).filter((i) =>
      ["proposed", "claimed", "running"].includes(i.status),
    );

    const lines: string[] = [];
    lines.push("## 目标");
    for (const g of goals) {
      lines.push(`- [${g.passes ? "通过" : "未通过"}] ${g.id}: ${g.title}`);
    }
    lines.push("", "## 事实标题（title 层）");
    for (const f of titles) {
      const intent = f.intentId ? ` ←intent ${f.intentId.slice(0, 8)}` : "";
      lines.push(`- [${f.id.slice(0, 8)}] ${f.title}${intent}`);
    }
    lines.push("", "## 进行中意图");
    if (open.length === 0) {
      lines.push("- （无）");
    } else {
      for (const i of open) {
        const src = i.sourceFactIds.join(",");
        lines.push(`- [${i.id.slice(0, 8)}] (${i.status}) ${i.title} ←facts ${src}`);
      }
    }
    return lines;
  }

  relativeEvidencePath(absPath: string): string {
    return relative(this.evidenceDir, absPath).replace(/\\/g, "/");
  }
}

/** Validate board-clearance evidence used by autonomous TSecBench goals. */
export function validateAllCompleteEvidence(absPath: string): string | null {
  let raw: string;
  try {
    raw = readFileSync(absPath, "utf8");
  } catch {
    return `cannot read ALL_COMPLETE evidence: ${absPath}`;
  }
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return "ALL_COMPLETE.json must be valid JSON";
  }
  if (!Array.isArray(data) || data.length === 0) {
    return "ALL_COMPLETE.json must be a non-empty challenge array";
  }
  const incomplete: string[] = [];
  for (const row of data) {
    if (!row || typeof row !== "object") {
      return "ALL_COMPLETE.json entries must be objects";
    }
    const rec = row as { unique_code?: unknown; is_completed?: unknown };
    const code = typeof rec.unique_code === "string" ? rec.unique_code : "?";
    if (rec.is_completed !== true) incomplete.push(code);
  }
  if (incomplete.length > 0) {
    return `ALL_COMPLETE.json still has incomplete challenges: ${incomplete.slice(0, 12).join(", ")}${incomplete.length > 12 ? "…" : ""}`;
  }
  return null;
}

export function openHistory(opts: OpenHistoryOptions): HistoryStore {
  return new HistoryStore(opts);
}

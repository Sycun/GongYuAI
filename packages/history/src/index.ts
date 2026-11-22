import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname, relative } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type {
  AssetKind,
  AssetRecord,
  AssetSource,
  AuthScope,
  Fact,
  FactLayer,
  GoalState,
  Hint,
  HintSource,
  HistoryEvent,
  HistoryEventKind,
  Intent,
  IntentStatus,
} from "@gongyuai/contracts";
import {
  ASSET_KIND_RANK,
  ASSET_TAG,
  ORIGIN_FACT_ID,
  TRANSFERABLE_TAG,
  admitAddress,
  assetRootKey,
  assetTags,
  familyTag,
  normalizeFamilyKey,
  normalizeTargetPattern,
  parseAssetAddrFromTags,
  parseAssetKindFromTags,
  parseAssetSourceFromTags,
  suggestFamilyKey,
} from "@gongyuai/contracts";
import { captureEvidence, collectGoalEvidence, type EvidenceSnapshot } from "./goal-evidence.js";
import { CreateFactReviewSchema, type CreateFactReview } from "@gongyuai/contracts";

export { collectGoalEvidence, validateAllCompleteEvidence } from "./goal-evidence.js";
export type FactReview = CreateFactReview & { id: string; sha256: string; createdAt: string };
export type GoalProof = { goalId: string; path: string; sha256: string };

export { minimatch } from "./minimatch.js";
export { listExecutionSteps, readExecutionStepCalls, saveExecutionStep } from "./execution-trace.js";
export { listEvidenceFiles, readEvidenceFile, resolveEvidenceFile, writeEvidenceFile } from "./evidence.js";
export { writeTaskReport, type TerminalReportStatus } from "./report.js";

export type FanoutPolicy = {
  maxIntentsPerReason: number;
  maxIntentsPerAssetRoot: number;
};

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
    // Multi-Explore workers share history.sqlite; wait briefly on lock contention.
    this.db.exec("PRAGMA busy_timeout = 5000;");
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

      CREATE TABLE IF NOT EXISTS goal_checks (
        task_id TEXT NOT NULL, goal_id TEXT NOT NULL, checks_json TEXT NOT NULL,
        PRIMARY KEY(task_id, goal_id)
      );
      CREATE TABLE IF NOT EXISTS evidence_versions (
        sha256 TEXT PRIMARY KEY, content BLOB NOT NULL
      );
      CREATE TABLE IF NOT EXISTS goal_proofs (
        task_id TEXT NOT NULL, goal_id TEXT NOT NULL, path TEXT NOT NULL,
        sha256 TEXT NOT NULL REFERENCES evidence_versions(sha256),
        PRIMARY KEY(task_id, goal_id, path)
      );
      CREATE TABLE IF NOT EXISTS fact_reviews (
        id TEXT PRIMARY KEY, task_id TEXT NOT NULL, fact_id TEXT NOT NULL REFERENCES facts(id),
        goal_id TEXT NOT NULL, decision TEXT NOT NULL, replacement_fact_id TEXT REFERENCES facts(id),
        reviewer TEXT NOT NULL, reason TEXT NOT NULL, path TEXT NOT NULL,
        sha256 TEXT NOT NULL REFERENCES evidence_versions(sha256), created_at TEXT NOT NULL,
        FOREIGN KEY(task_id, goal_id) REFERENCES goals(task_id, id)
      );
      CREATE INDEX IF NOT EXISTS idx_reviews_task ON fact_reviews(task_id, goal_id);

      CREATE TABLE IF NOT EXISTS events (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        payload_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_events_task ON events(task_id, created_at);

      CREATE TABLE IF NOT EXISTS hints (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        text TEXT NOT NULL,
        source TEXT NOT NULL DEFAULT 'human',
        tags_json TEXT NOT NULL DEFAULT '[]',
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_hints_task ON hints(task_id, created_at);

      CREATE TABLE IF NOT EXISTS leases (
        task_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        owner TEXT NOT NULL,
        until_iso TEXT NOT NULL,
        PRIMARY KEY (task_id, kind)
      );
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
    // Control-plane snapshots can be older than the worker's evidence assertions.
    const stmt = this.db.prepare(`
      INSERT INTO goals
        (id, task_id, title, description, evidence_patterns_json, passes, evidence_paths_json, asserted_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(task_id, id) DO NOTHING
    `);
    this.db.exec("BEGIN");
    try {
      for (const g of goals) {
        const inserted = stmt.run(
          g.id,
          taskId,
          g.title,
          g.description,
          JSON.stringify(g.evidencePatterns),
          g.passes ? 1 : 0,
          JSON.stringify(g.evidencePaths),
          g.assertedAt,
        );
        if (inserted.changes && g.evidenceChecks?.length) {
          this.db.prepare("INSERT INTO goal_checks VALUES (?, ?, ?)")
            .run(taskId, g.id, JSON.stringify(g.evidenceChecks));
        }
      }
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  /**
   * Idempotent: each auth.targets entry → one seed asset Fact (projection row).
   * Call on task create and again on worker bootstrap; duplicates are skipped.
   */
  seedAssetsFromAuth(taskId: string, auth: Pick<AuthScope, "targets">): Fact[] {
    const written: Fact[] = [];
    for (const raw of auth.targets) {
      const address = normalizeTargetPattern(raw);
      if (!address) continue;
      const existing = this.findAssetFact(taskId, address);
      if (existing) continue;
      written.push(
        this.appendFact({
          taskId,
          layer: "title",
          title: `资产 · seed · ${address}`,
          summary: `授权靶标（auth.targets）：${raw.trim()}`,
          tags: assetTags({ kind: "seed", address, source: "auth" }),
        }),
      );
    }
    return written;
  }

  /**
   * Record a discovered (or promoted) asset. Auto-admits against auth when kind omitted.
   * Append-only: upgrades write a new Fact; listAssets keeps the highest kind per address.
   */
  recordAsset(input: {
    taskId: string;
    address: string;
    auth: Pick<AuthScope, "targets" | "outOfScope">;
    /** Force kind; default = admitAddress result (admitted|oos). */
    kind?: AssetKind;
    source?: AssetSource;
    summary?: string;
    intentId?: string | null;
    /** If true and address is in-scope, write kind=live. */
    live?: boolean;
  }): { fact: Fact; asset: AssetRecord; created: boolean } {
    const address = normalizeTargetPattern(input.address) || input.address.trim().toLowerCase();
    if (!address) throw new Error("asset address required");

    let kind: AssetKind =
      input.kind ??
      admitAddress(
        { targets: input.auth.targets, outOfScope: input.auth.outOfScope },
        address,
      ).kind;
    if (input.live) {
      const gate = admitAddress(
        { targets: input.auth.targets, outOfScope: input.auth.outOfScope },
        address,
      );
      if (gate.kind === "oos") kind = "oos";
      else kind = "live";
    }

    const source: AssetSource = input.source ?? "discover";
    const current = this.listAssets(input.taskId).find((a) => a.address === address);
    if (current && ASSET_KIND_RANK[current.kind] >= ASSET_KIND_RANK[kind]) {
      return {
        fact: this.getFact(input.taskId, current.factId)!,
        asset: current,
        created: false,
      };
    }

    const admission = admitAddress(
      { targets: input.auth.targets, outOfScope: input.auth.outOfScope },
      address,
    );
    const summary =
      input.summary ??
      (kind === "oos"
        ? `范围外（未匹配 auth.targets）`
        : kind === "live"
          ? `已核实存活 · 匹配 ${admission.matchedBy ?? "auth.targets"}`
          : `自动准入 · 匹配 ${admission.matchedBy ?? "auth.targets"}`);

    const fact = this.appendFact({
      taskId: input.taskId,
      layer: "title",
      title: `资产 · ${kind} · ${address}`,
      summary,
      tags: assetTags({ kind, address, source }),
      intentId: input.intentId ?? null,
    });
    return {
      fact,
      asset: this.factToAsset(fact)!,
      created: true,
    };
  }

  /** Deduped inventory: highest kind per address. */
  listAssets(taskId: string): AssetRecord[] {
    const byAddr = new Map<string, AssetRecord>();
    for (const fact of this.listFacts(taskId)) {
      if (!fact.tags.includes(ASSET_TAG)) continue;
      const asset = this.factToAsset(fact);
      if (!asset) continue;
      const prev = byAddr.get(asset.address);
      if (!prev || ASSET_KIND_RANK[asset.kind] > ASSET_KIND_RANK[prev.kind]) {
        byAddr.set(asset.address, asset);
      } else if (
        prev &&
        ASSET_KIND_RANK[asset.kind] === ASSET_KIND_RANK[prev.kind] &&
        asset.createdAt > prev.createdAt
      ) {
        byAddr.set(asset.address, asset);
      }
    }
    return [...byAddr.values()].sort((a, b) => a.address.localeCompare(b.address));
  }

  private findAssetFact(taskId: string, address: string): Fact | null {
    const needle = `asset.addr:${address}`;
    for (const fact of this.listFacts(taskId)) {
      if (fact.tags.includes(ASSET_TAG) && fact.tags.includes(needle)) return fact;
    }
    return null;
  }

  private factToAsset(fact: Fact): AssetRecord | null {
    const kind = parseAssetKindFromTags(fact.tags);
    const address = parseAssetAddrFromTags(fact.tags);
    if (!kind || !address) return null;
    return {
      address,
      kind,
      factId: fact.id,
      title: fact.title,
      summary: fact.summary,
      source: parseAssetSourceFromTags(fact.tags),
      createdAt: fact.createdAt,
      intentId: fact.intentId,
    };
  }

  listGoals(taskId: string): GoalState[] {
    const rows = this.db
      .prepare(`SELECT g.*, c.checks_json FROM goals g LEFT JOIN goal_checks c ON c.goal_id = g.id AND c.task_id = g.task_id WHERE g.task_id = ? ORDER BY g.id`)
      .all(taskId) as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      id: String(r.id),
      title: String(r.title),
      description: String(r.description),
      evidencePatterns: JSON.parse(String(r.evidence_patterns_json)) as string[],
      evidenceChecks: r.checks_json ? JSON.parse(String(r.checks_json)) : undefined,
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

  /**
   * Structured neighborhood for drill-down (Resurface discipline):
   * same `intentId` chain, ordered by write-time. Missing intent → empty neighbors.
   * Never invents event timestamps; `recordedAt` is History write time only.
   */
  getFactNeighborhood(
    taskId: string,
    factId: string,
    window = 2,
  ): {
    fact: Fact | null;
    before: Array<{
      id: string;
      title: string;
      layer: FactLayer;
      intentId: string | null;
      recordedAt: string;
    }>;
    after: Array<{
      id: string;
      title: string;
      layer: FactLayer;
      intentId: string | null;
      recordedAt: string;
    }>;
  } {
    const fact = this.getFact(taskId, factId);
    if (!fact) {
      return { fact: null, before: [], after: [] };
    }
    const win = Math.max(0, Math.min(8, Math.floor(window)));
    if (!fact.intentId) {
      return { fact, before: [], after: [] };
    }
    const chain = this.db
      .prepare(
        `SELECT * FROM facts WHERE task_id = ? AND intent_id = ? ORDER BY created_at ASC, rowid ASC`,
      )
      .all(taskId, fact.intentId) as Array<Record<string, unknown>>;
    const facts = chain.map((r) => this.rowToFact(r));
    const idx = facts.findIndex((f) => f.id === factId);
    if (idx < 0) {
      return { fact, before: [], after: [] };
    }
    const toSummary = (f: Fact) => ({
      id: f.id,
      title: f.title,
      layer: f.layer,
      intentId: f.intentId,
      recordedAt: f.createdAt,
    });
    return {
      fact,
      before: facts.slice(Math.max(0, idx - win), idx).map(toSummary),
      after: facts.slice(idx + 1, idx + 1 + win).map(toSummary),
    };
  }

  /** Drill payload: Fact + neighbors; labels write-time as recordedAt (no invented event time). */
  formatFactDrill(taskId: string, factId: string, window = 2): Record<string, unknown> {
    const { fact, before, after } = this.getFactNeighborhood(taskId, factId, window);
    if (!fact) {
      return { ok: false, reason: `unknown fact: ${factId}` };
    }
    return {
      ok: true,
      fact: {
        id: fact.id,
        taskId: fact.taskId,
        layer: fact.layer,
        title: fact.title,
        summary: fact.summary,
        evidencePath: fact.evidencePath,
        tags: fact.tags,
        intentId: fact.intentId,
        recordedAt: fact.createdAt,
      },
      neighbors: { before, after },
    };
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
    /**
     * When true (default), reject Intents whose only asset predecessors are oos.
     * Intel-only / origin-only Intents still pass.
     */
    rejectOosOnly?: boolean;
    /** Apply Reason fanout hard caps (open count + same-root). */
    fanout?: FanoutPolicy;
  }): Intent {
    const sourceFactIds = this.validateSourceFactIds(input.taskId, input.sourceFactIds);
    if (input.rejectOosOnly !== false) {
      this.assertNotOosOnlyExploit(input.taskId, sourceFactIds);
    }
    if (input.fanout) {
      this.assertFanoutAllows(input.taskId, sourceFactIds, input.fanout);
    }
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

  /** Primary asset address among source facts (first asset.* tag wins). */
  primaryAssetAddress(taskId: string, sourceFactIds: string[]): string | null {
    for (const id of sourceFactIds) {
      if (id === ORIGIN_FACT_ID) continue;
      const fact = this.getFact(taskId, id);
      if (!fact) continue;
      const addr = parseAssetAddrFromTags(fact.tags);
      if (addr) return addr;
    }
    return null;
  }

  private assertNotOosOnlyExploit(taskId: string, sourceFactIds: string[]): void {
    const kinds: AssetKind[] = [];
    for (const id of sourceFactIds) {
      if (id === ORIGIN_FACT_ID) continue;
      const fact = this.getFact(taskId, id);
      if (!fact?.tags.includes(ASSET_TAG)) continue;
      const kind = parseAssetKindFromTags(fact.tags);
      if (kind) kinds.push(kind);
    }
    if (!kinds.length) return;
    if (kinds.every((k) => k === "oos")) {
      throw new Error(
        "oos-only: 不可将范围外资产作为利用 Intent 的唯一前驱（可记账，不可扇出利用）",
      );
    }
  }

  private assertFanoutAllows(
    taskId: string,
    sourceFactIds: string[],
    policy: FanoutPolicy,
  ): void {
    const open = this.openIntents(taskId);
    if (open.length >= policy.maxIntentsPerReason) {
      throw new Error(
        `fanout cap: open Intents=${open.length} ≥ maxIntentsPerReason=${policy.maxIntentsPerReason}`,
      );
    }
    const addr = this.primaryAssetAddress(taskId, sourceFactIds);
    if (!addr) return;
    const root = assetRootKey(addr);
    if (!root) return;
    let sameRoot = 0;
    for (const intent of open) {
      const peer = this.primaryAssetAddress(taskId, intent.sourceFactIds);
      if (peer && assetRootKey(peer) === root) sameRoot += 1;
    }
    if (sameRoot >= policy.maxIntentsPerAssetRoot) {
      throw new Error(
        `fanout cap: root=${root} open=${sameRoot} ≥ maxIntentsPerAssetRoot=${policy.maxIntentsPerAssetRoot}`,
      );
    }
  }

  /**
   * Project-level Reason lease (Cairn Project.reason). CAS via SQLite.
   * Returns true when acquired or refreshed by the same owner.
   */
  tryAcquireReasonLease(
    taskId: string,
    owner: string,
    ttlMs: number,
  ): { ok: true; until: string } | { ok: false; owner: string; until: string } {
    if (ttlMs <= 0) {
      const until = this.now();
      return { ok: true, until };
    }
    const nowMs = Date.now();
    const until = new Date(nowMs + ttlMs).toISOString();
    const row = this.db
      .prepare(`SELECT owner, until_iso FROM leases WHERE task_id = ? AND kind = 'reason'`)
      .get(taskId) as { owner: string; until_iso: string } | undefined;
    if (row) {
      const exp = Date.parse(row.until_iso);
      if (Number.isFinite(exp) && exp > nowMs && row.owner !== owner) {
        return { ok: false, owner: row.owner, until: row.until_iso };
      }
    }
    this.db
      .prepare(
        `INSERT INTO leases (task_id, kind, owner, until_iso) VALUES (?, 'reason', ?, ?)
         ON CONFLICT(task_id, kind) DO UPDATE SET owner = excluded.owner, until_iso = excluded.until_iso`,
      )
      .run(taskId, owner, until);
    this.emit(taskId, "reason_lease", { owner, until, action: "acquire" });
    return { ok: true, until };
  }

  releaseReasonLease(taskId: string, owner: string): boolean {
    const result = this.db
      .prepare(`DELETE FROM leases WHERE task_id = ? AND kind = 'reason' AND owner = ?`)
      .run(taskId, owner);
    if ((result.changes ?? 0) > 0) {
      this.emit(taskId, "reason_lease", { owner, action: "release" });
      return true;
    }
    return false;
  }

  getReasonLease(
    taskId: string,
  ): { owner: string; until: string } | null {
    const row = this.db
      .prepare(`SELECT owner, until_iso FROM leases WHERE task_id = ? AND kind = 'reason'`)
      .get(taskId) as { owner: string; until_iso: string } | undefined;
    if (!row) return null;
    return { owner: row.owner, until: row.until_iso };
  }

  /**
   * Cairn dual-stage: Explore timeout → force conclude with ≥1 partial Fact.
   * Always writes a Fact so the graph keeps the partial result.
   */
  forceConcludeExploreTimeout(input: {
    taskId: string;
    intentId: string;
    workerId: string;
    reason?: string;
  }): Intent | null {
    const intent = this.getIntent(input.taskId, input.intentId);
    if (!intent) return null;
    if (!["claimed", "running", "proposed"].includes(intent.status)) return null;
    const conclusion =
      input.reason?.trim() ||
      `Explore timeout — partial Fact recovered (worker=${input.workerId})`;
    const done = this.concludeIntent(
      input.taskId,
      input.intentId,
      "failed",
      conclusion,
      {
        facts: [
          {
            layer: "title",
            title: `partial · Explore 超时 · ${intent.title}`.slice(0, 200),
            summary: conclusion,
            tags: ["partial", "explore_timeout"],
          },
        ],
      },
    );
    if (done) {
      this.emit(input.taskId, "explore_timeout_conclude", {
        intentId: input.intentId,
        workerId: input.workerId,
      });
    }
    return done;
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

  /**
   * Heartbeat / lease timeout: claimed|running older than maxAgeMs → expired
   * (re-claimable after re-propose, or caller may re-propose). Zero tactical policy.
   */
  expireStaleIntents(taskId: string, maxAgeMs: number): Intent[] {
    const now = Date.now();
    const open = this.listIntents(taskId).filter((i) =>
      ["claimed", "running"].includes(i.status),
    );
    const expired: Intent[] = [];
    for (const intent of open) {
      const updated = Date.parse(intent.updatedAt);
      if (!Number.isFinite(updated) || now - updated < maxAgeMs) continue;
      const result = this.db
        .prepare(
          `UPDATE intents
           SET status = 'expired', updated_at = ?
           WHERE id = ? AND task_id = ? AND status IN ('claimed', 'running')`,
        )
        .run(this.now(), intent.id, taskId);
      if ((result.changes ?? 0) > 0) {
        this.emit(taskId, "intent_expired", { intentId: intent.id });
        const row = this.getIntent(taskId, intent.id);
        if (row) expired.push(row);
      }
    }
    return expired;
  }

  /** Open Explore intents (proposed|claimed|running). */
  openIntents(taskId: string): Intent[] {
    return this.listIntents(taskId).filter((i) =>
      ["proposed", "claimed", "running"].includes(i.status),
    );
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

    let files: EvidenceSnapshot[];
    try {
      files = collectGoalEvidence(this.evidenceDir, goal, evidencePaths);
    } catch (err) {
      return { ok: false, reason: err instanceof Error ? err.message : String(err) };
    }
    const normalized = files.map((f) => f.path);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = this.db
        .prepare(
          `UPDATE goals
           SET passes = 1, evidence_paths_json = ?, asserted_at = ?
           WHERE task_id = ? AND id = ? AND passes = 0`,
        )
        .run(JSON.stringify(normalized), this.now(), taskId, goalId);
      if (result.changes) {
        for (const f of files) {
          this.saveVersion(f);
          this.db.prepare("INSERT INTO goal_proofs VALUES (?, ?, ?, ?)").run(taskId, goalId, f.path, f.sha256);
        }
        this.emit(taskId, "goal_asserted", { goalId, evidencePaths: normalized });
      }
      const updated = this.listGoals(taskId).find((g) => g.id === goalId);
      this.db.exec("COMMIT");
      return updated ? { ok: true, goal: updated } : { ok: false, reason: `unknown goal: ${goalId}` };
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  withReportTransaction<T>(render: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = render();
      this.db.exec("COMMIT");
      return result;
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  private saveVersion(file: EvidenceSnapshot): void {
    this.db.prepare("INSERT INTO evidence_versions(sha256, content) VALUES (?, ?) ON CONFLICT DO NOTHING")
      .run(file.sha256, file.content);
  }

  relayCount(taskId: string): number {
    const row = this.db.prepare("SELECT COUNT(*) AS n FROM events WHERE task_id = ? AND kind = 'relay_written'").get(taskId);
    return Number(row?.n ?? 0);
  }

  listGoalProofs(taskId: string): GoalProof[] {
    return this.db.prepare("SELECT goal_id AS goalId, path, sha256 FROM goal_proofs WHERE task_id = ? ORDER BY goal_id, path")
      .all(taskId) as GoalProof[];
  }

  readProofVersion(taskId: string, sha256: string): Buffer | undefined {
    const row = this.db.prepare(`SELECT content FROM evidence_versions WHERE sha256 = ? AND (
      EXISTS (SELECT 1 FROM goal_proofs WHERE task_id = ? AND sha256 = ?) OR
      EXISTS (SELECT 1 FROM fact_reviews WHERE task_id = ? AND sha256 = ?))`)
      .get(sha256, taskId, sha256, taskId, sha256) as { content: Uint8Array } | undefined;
    return row && Buffer.from(row.content);
  }

  listReviews(taskId: string): FactReview[] {
    const rows = this.db.prepare(`SELECT id, fact_id AS factId, goal_id AS goalId, decision,
      replacement_fact_id AS replacementFactId, reviewer, reason, path AS evidencePath, sha256,
      created_at AS createdAt FROM fact_reviews WHERE task_id = ? ORDER BY rowid`)
      .all(taskId);
    return rows.map(({ replacementFactId, ...r }) => ({
      ...r, ...(replacementFactId ? { replacementFactId } : {}),
    }) as FactReview);
  }

  appendReview(taskId: string, input: CreateFactReview): FactReview {
    const r = CreateFactReviewSchema.parse(input);
    if (!this.getFact(taskId, r.factId) || (r.replacementFactId && !this.getFact(taskId, r.replacementFactId))) {
      throw new Error("review references a fact outside this task or an unknown fact");
    }
    if (!this.listGoals(taskId).some((g) => g.id === r.goalId)) throw new Error("unknown review goal");
    const file = captureEvidence(this.evidenceDir, r.evidencePath);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const prior = this.listReviews(taskId).filter((p) => p.goalId === r.goalId && p.factId === r.factId).at(-1);
      if (prior && prior.decision === r.decision && prior.reviewer === r.reviewer && prior.reason === r.reason &&
          prior.replacementFactId === r.replacementFactId && prior.sha256 === file.sha256 && prior.evidencePath === file.path) {
        this.db.exec("COMMIT");
        return prior;
      }
      const review = { ...r, id: randomUUID(), createdAt: this.now(), evidencePath: file.path, sha256: file.sha256 };
      this.saveVersion(file);
      this.db.prepare(`INSERT INTO fact_reviews
        (id, task_id, fact_id, goal_id, decision, replacement_fact_id, reviewer, reason, path, sha256, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(review.id, taskId, r.factId, r.goalId, r.decision, r.replacementFactId ?? null, r.reviewer,
          r.reason, file.path, file.sha256, review.createdAt);
      this.db.exec("COMMIT");
      return review;
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
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

  recordRelay(taskId: string, generation: number, trigger: string): void {
    this.emit(taskId, "relay_written", { generation, trigger });
  }

  /** P5 tool single-gate audit: allow and deny both recorded. */
  recordToolGate(
    taskId: string,
    input: {
      tool: string;
      ok: boolean;
      reason?: string;
      detail?: Record<string, unknown>;
    },
  ): void {
    this.emit(taskId, "tool_gate", {
      tool: input.tool,
      ok: input.ok,
      ...(input.reason ? { reason: input.reason } : {}),
      ...(input.detail ?? {}),
    });
  }

  /** P4 Hint: human/system tactical injection into the blackboard. */
  appendHint(input: {
    taskId: string;
    text: string;
    source?: HintSource;
    tags?: string[];
  }): Hint {
    const text = input.text.trim();
    if (!text) throw new Error("hint text required");
    const hint: Hint = {
      id: randomUUID(),
      taskId: input.taskId,
      text,
      source: input.source ?? "human",
      tags: input.tags ?? [],
      createdAt: this.now(),
    };
    this.db
      .prepare(
        `INSERT INTO hints (id, task_id, text, source, tags_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        hint.id,
        hint.taskId,
        hint.text,
        hint.source,
        JSON.stringify(hint.tags),
        hint.createdAt,
      );
    this.emit(input.taskId, "hint_appended", {
      hintId: hint.id,
      source: hint.source,
      preview: hint.text.slice(0, 160),
    });
    return hint;
  }

  listHints(taskId: string, limit = 50): Hint[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM hints WHERE task_id = ? ORDER BY created_at DESC LIMIT ?`,
      )
      .all(taskId, limit) as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      id: String(r.id),
      taskId: String(r.task_id),
      text: String(r.text),
      source: r.source as HintSource,
      tags: JSON.parse(String(r.tags_json ?? "[]")) as string[],
      createdAt: String(r.created_at),
    }));
  }

  listTransferableFacts(taskId: string): Fact[] {
    return this.listFacts(taskId).filter((f) => f.tags.includes(TRANSFERABLE_TAG));
  }

  /**
   * P4 同族迁移：把已验证打法写成 transferable Fact，并为对端资产扇出 Intent。
   * 协作只写图（stigmergy），不点对点私聊。
   * familyKey 可省略 → 从 title/summary/tags/资产根启发式补全。
   */
  broadcastTechnique(input: {
    taskId: string;
    sourceFactIds: string[];
    title: string;
    summary: string;
    familyKey?: string;
    /** Empty → all non-oos assets (admitted/live/seed). */
    targetAddresses?: string[];
    fanout?: FanoutPolicy;
  }): {
    techniqueFact: Fact;
    intents: Intent[];
    skipped: string[];
    familyKey: string | null;
    familyKeyVia: string | null;
  } {
    const sources = input.sourceFactIds.map((s) => s.trim()).filter(Boolean);
    if (!sources.length) throw new Error("broadcastTechnique requires sourceFactIds");
    for (const id of sources) {
      if (id === ORIGIN_FACT_ID) continue;
      if (!this.getFact(input.taskId, id)) {
        throw new Error(`unknown source fact: ${id}`);
      }
    }

    const assetsAll = this.listAssets(input.taskId);
    const assets = assetsAll.filter((a) => a.kind !== "oos");
    const wanted = input.targetAddresses?.map((a) => a.trim()).filter(Boolean);
    let peers = wanted?.length
      ? assets.filter((a) => wanted.includes(a.address))
      : assets;

    const sourceTags = sources.flatMap((id) => this.getFact(input.taskId, id)?.tags ?? []);
    const hint = suggestFamilyKey({
      title: input.title,
      summary: input.summary,
      tags: sourceTags,
      addresses: peers.map((p) => p.address),
    });
    const familyKey =
      normalizeFamilyKey(input.familyKey) ?? hint?.key ?? null;
    const familyKeyVia = input.familyKey?.trim()
      ? "explicit"
      : hint
        ? hint.via
        : null;

    const tags = [TRANSFERABLE_TAG];
    if (familyKey) tags.push(familyTag(familyKey));

    const techniqueFact = this.appendFact({
      taskId: input.taskId,
      layer: "title",
      title: input.title.trim() || "可迁移打法",
      summary: input.summary.trim(),
      tags,
    });

    // Prefer peers sharing the family root when key is root:* or stack fingerprint.
    if (familyKey?.startsWith("root:")) {
      const root = familyKey.slice("root:".length);
      const narrowed = peers.filter((p) => assetRootKey(p.address) === root);
      if (narrowed.length) peers = narrowed;
    }

    const fanout = input.fanout;
    const intents: Intent[] = [];
    const skipped: string[] = [];
    const openTitles = new Set(
      this.listIntents(input.taskId)
        .filter((i) => ["proposed", "claimed", "running"].includes(i.status))
        .map((i) => i.title),
    );
    const rootBudget = new Map<string, number>();

    for (const peer of peers) {
      if (fanout && intents.length + this.openIntents(input.taskId).length >= fanout.maxIntentsPerReason) {
        skipped.push(peer.address);
        continue;
      }
      const root = assetRootKey(peer.address);
      if (fanout && root) {
        const used =
          (rootBudget.get(root) ?? 0) +
          this.openIntents(input.taskId).filter((i) => {
            const a = this.primaryAssetAddress(input.taskId, i.sourceFactIds);
            return a != null && assetRootKey(a) === root;
          }).length;
        if (used >= fanout.maxIntentsPerAssetRoot) {
          skipped.push(peer.address);
          continue;
        }
      }
      const title = `同族迁移：在 ${peer.address} 复用「${techniqueFact.title}」`;
      if (openTitles.has(title)) {
        skipped.push(peer.address);
        continue;
      }
      try {
        const intent = this.proposeIntent({
          taskId: input.taskId,
          title,
          summary:
            `将已验证打法迁移到对端资产 ${peer.address}。` +
            (familyKey ? ` family=${familyKey}。` : "") +
            ` 手法摘要：${input.summary.trim().slice(0, 400)}`,
          sourceFactIds: [techniqueFact.id, peer.factId, ...sources].slice(0, 8),
          fanout,
        });
        intents.push(intent);
        openTitles.add(title);
        if (root) rootBudget.set(root, (rootBudget.get(root) ?? 0) + 1);
      } catch {
        skipped.push(peer.address);
      }
    }

    this.emit(input.taskId, "technique_broadcast", {
      techniqueFactId: techniqueFact.id,
      familyKey,
      familyKeyVia,
      intentCount: intents.length,
      skipped,
    });

    this.appendHint({
      taskId: input.taskId,
      text:
        `[同族迁移] ${techniqueFact.title}` +
        (familyKey ? ` (family=${familyKey}${familyKeyVia ? ` via ${familyKeyVia}` : ""})` : "") +
        ` → 已为 ${intents.length} 个资产提出 Intent` +
        (skipped.length ? `；跳过 ${skipped.length}` : ""),
      source: "family",
      tags: [TRANSFERABLE_TAG, ...(familyKey ? [familyTag(familyKey)] : [])],
    });

    return { techniqueFact, intents, skipped, familyKey, familyKeyVia };
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
        lines.push(`- [${f.id}] ${f.title}: ${f.summary.slice(0, 240)}`);
      }
    }
    return lines.join("\n");
  }

  private observeCore(taskId: string): string[] {
    const goals = this.listGoals(taskId);
    const assets = this.listAssets(taskId);
    const titles = this.listFacts(taskId, "title").slice(-50);
    const open = this.listIntents(taskId).filter((i) =>
      ["proposed", "claimed", "running"].includes(i.status),
    );
    const hints = this.listHints(taskId, 20);
    const transferable = this.listTransferableFacts(taskId).slice(-20);

    const lines: string[] = [];
    lines.push("## 目标");
    for (const g of goals) {
      lines.push(`- [${g.passes ? "通过" : "未通过"}] ${g.id}: ${g.title}`);
    }
    lines.push("", `## 资产清单（${assets.length}）`);
    if (assets.length === 0) {
      lines.push("- （无；Bootstrap / seedAssetsFromAuth 应写入 auth.targets）");
    } else {
      for (const a of assets) {
        lines.push(
          `- [${a.kind}] ${a.address} ←fact ${a.factId} · ${a.source}${a.intentId ? ` ←intent ${a.intentId}` : ""}`,
        );
      }
      lines.push(
        "（seed/admitted/live 可作 Intent 前驱继续测；oos 禁止作为利用 Intent 唯一前驱；Reason 扇出受 maxIntentsPerReason / 同根硬顶；发现用 asset_record。）",
      );
    }
    lines.push("", "## Hint（战术注入）");
    if (hints.length === 0) {
      lines.push("- （无）");
    } else {
      for (const h of hints) {
        lines.push(`- [${h.id}] (${h.source}) ${h.text.slice(0, 320)}`);
      }
      lines.push("（人类/同族 Hint 须吸收进下一轮 Explore/Reason；勿忽略。）");
    }
    lines.push("", "## 可迁移打法（同族）");
    if (transferable.length === 0) {
      lines.push("- （无；验证手法后用 technique_transfer 广播）");
    } else {
      for (const f of transferable) {
        lines.push(`- [${f.id}] ${f.title}${f.summary ? `: ${f.summary.slice(0, 160)}` : ""}`);
      }
    }
    lines.push("", "## 事实标题（title 层）");
    for (const f of titles) {
      const intent = f.intentId ? ` ←intent ${f.intentId}` : "";
      lines.push(`- [${f.id}] ${f.title}${intent}`);
    }
    lines.push("", "## 进行中意图");
    if (open.length === 0) {
      lines.push("- （无）");
    } else {
      for (const i of open) {
        const src = i.sourceFactIds.join(",");
        lines.push(`- [${i.id}] (${i.status}) ${i.title} ←facts ${src}`);
      }
    }
    return lines;
  }

  relativeEvidencePath(absPath: string): string {
    return relative(this.evidenceDir, absPath).replace(/\\/g, "/");
  }
}

export function openHistory(opts: OpenHistoryOptions): HistoryStore {
  return new HistoryStore(opts);
}

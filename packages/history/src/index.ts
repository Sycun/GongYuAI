import { createHash, randomUUID } from "node:crypto";
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
  Finding,
  FindingConfidence,
  FindingSeverity,
  FindingStatus,
  FindingsGate,
  GoalState,
  Hint,
  HintSource,
  HistoryEvent,
  HistoryEventKind,
  Intent,
  IntentStatus,
  ReconcileGate,
  ReconcileInputStamp,
  ReconcileRequest,
  ReconcileResult,
  ReconcileRevision,
  BusinessReconcileConfig,
} from "@gongyuai/contracts";
import {
  ASSET_KIND_RANK,
  ASSET_TAG,
  FINDING_SEVERITY_RANK,
  ORIGIN_FACT_ID,
  TRANSFERABLE_TAG,
  admitAddress,
  assetRootKey,
  assetTags,
  familyTag,
  findingAssetInScope,
  findingDedupKey,
  findingSatisfiesGate,
  resolveGateAssets,
  findingStatusAllows,
  normalizeFamilyKey,
  normalizeHost,
  normalizeTargetPattern,
  parseAssetAddrFromTags,
  parseAssetKindFromTags,
  parseAssetSourceFromTags,
  suggestFamilyKey,
  businessConfigFromRequest,
  nextReconcileRevisionId,
  parseMaterial,
  reconcileConfigDigest,
  reconcileInputDigest,
  reconcileMaterials,
  summarizeReconcile,
} from "@gongyuai/contracts";
import {
  captureEvidence,
  collectGoalEvidence,
  describeReconcileState,
  selectAdoptedReconcile,
  verifyRevisionInputs,
  type ArchivedReconcile,
  type EvidenceSnapshot,
  type ReconcileStateReport,
} from "./goal-evidence.js";
import { readEvidenceBytes, resolveEvidenceFile, writeEvidenceFile } from "./evidence.js";
import { TaskOperations } from "./ops.js";
import { readIntegrationUsage, trackIntegrationCalls } from "./integration-usage.js";
import {
  computeScorecard,
  finalizeSnapshot,
  type DeliverySnapshot,
  type Scorecard,
  type SnapshotFinding,
  type SnapshotGoal,
  type SnapshotGoalFinding,
  type SnapshotCoverage,
} from "./scorecard.js";
import { CoverageReviewSchema, type CoverageReview, type CoverageReviewInput, CreateFactReviewSchema, type CreateFactReview } from "@gongyuai/contracts";
import {
  PeerReviewSchema,
  RetestRequestSchema,
  type PeerReview,
  type PeerReviewInput,
  type RetestRequest,
  type RetestRequestInput,
  type RetestRequestStatus,
} from "@gongyuai/contracts";
import {
  MaterialCitationSchema,
  type KnowledgeBodyFormat,
  type KnowledgeSection,
  type KnowledgeSourceKind,
  type MaterialCitation,
  type MaterialCitationInput,
} from "@gongyuai/contracts";

/**
 * 控制面在知识库侧校验通过后交来的定版标签与快照字节。
 * 标签只用于渲染报告；正文仍从密封快照回读，不在这里存第二份真相。
 */
export type MaterialCitationSeal = {
  materialTitle: string;
  publisher: string;
  sourceKind: KnowledgeSourceKind;
  versionNo: number;
  versionLabel: string;
  bodyFormat: KnowledgeBodyFormat;
  sectionHeading: string | null;
  sectionPage: number | null;
  sectionOrdinal: number;
  /** 片段元数据（不含正文）：标题路径、父章节、片序、行号、页码依据。 */
  sectionMeta: Omit<KnowledgeSection, "text">;
  snapshot: Buffer;
};

export { TaskOperations } from "./ops.js";
export type { OpsScope, JobPatch } from "./ops.js";

export {
  collectGoalEvidence,
  describeReconcileState,
  selectAdoptedReconcile,
  verifyRevisionInputs,
  type ArchivedReconcile,
  type ReconcileState,
  type ReconcileStateReport,
} from "./goal-evidence.js";
export type FactReview = CreateFactReview & { id: string; sha256: string; createdAt: string };
export type GoalProof = { goalId: string; path: string; sha256: string };
export type GoalFindingSupport = SnapshotGoalFinding;
export type FindingAction = {
  id: string;
  taskId: string;
  findingId: string;
  action: "retest" | "accept";
  result: string;
  note: string;
  path: string;
  sha256: string;
  createdAt: string;
};
export type DeliveryCorrection = {
  id: string;
  taskId: string;
  number: number;
  reason: string;
  findings: string[];
  goals: string[];
  report: Array<{ path: string; sha256: string }>;
  noticeStatus: "pending" | "notified" | "confirmed";
  evidencePath?: string;
  sha256?: string;
  createdAt: string;
};
export type { DeliverySnapshot, Scorecard, ScorecardGoal } from "./scorecard.js";
export { computeScorecard, finalizeSnapshot, scorecardFromSnapshot, snapshotSha256 } from "./scorecard.js";

export { describeGoalEvidence, formatAccounting, formatCorrections, type GoalEvidenceSupport } from "./delivery.js";
export { minimatch } from "./minimatch.js";
export { listExecutionSteps, readExecutionStepCalls, saveExecutionStep } from "./execution-trace.js";
export {
  listEvidenceFiles,
  readEvidenceBytes,
  readEvidenceFile,
  removeEvidenceFile,
  resolveEvidenceFile,
  writeEvidenceFile,
} from "./evidence.js";
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
  readOnly?: boolean;
  dbPath: string;
  evidenceDir: string;
};

export class HistoryStore {
  readonly dbPath: string;
  readonly evidenceDir: string;
  /** 第九轮：持久作业 / 人工求助 / 材料 / 变更台账（同一任务的库）。 */
  readonly ops: TaskOperations;
  private readonly db: DatabaseSync;

  private readonly archiveTables?: Set<string>;

  constructor(opts: OpenHistoryOptions) {
    this.dbPath = opts.dbPath;
    this.evidenceDir = opts.evidenceDir;
    if (opts.readOnly) {
      this.db = new DatabaseSync(opts.dbPath, { readOnly: true });
      try {
        this.db.exec("PRAGMA busy_timeout = 10000;");
        this.archiveTables = new Set(this.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
          .all().map((row) => String(row.name)));
      } catch (err) {
        this.db.close();
        throw err;
      }
      this.ops = new TaskOperations(this.db, { readOnly: true });
      return;
    }
    mkdirSync(dirname(opts.dbPath), { recursive: true });
    mkdirSync(opts.evidenceDir, { recursive: true });
    this.db = new DatabaseSync(opts.dbPath);
    // busy_timeout MUST be set before any statement that can take a lock:
    // switching the journal mode needs an exclusive moment, and a worker that
    // starts while the control plane is still writing used to die with
    // "database is locked" instead of waiting a few milliseconds.
    this.db.exec("PRAGMA busy_timeout = 10000;");
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec("PRAGMA foreign_keys = ON;");
    this.migrate();
    this.ops = new TaskOperations(this.db);
  }

  close(): void {
    this.db.close();
  }

  trackIntegrationCalls(taskId: string) {
    return trackIntegrationCalls(this.db, taskId);
  }

  integrationUsage(taskId: string) {
    return readIntegrationUsage(this.db, taskId);
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
        technique TEXT,
        asset_root TEXT,
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
      -- 第八轮：核算版本归档。首次判定以这里的顺序为准（版本号单调唯一），
      -- 不靠文件名排序或秒级时间戳；每条都记下对应目标、两侧材料内容哈希
      -- 与采用的核算口径摘要。
      CREATE TABLE IF NOT EXISTS reconcile_revisions (
        task_id TEXT NOT NULL,
        id TEXT NOT NULL,
        revision_json TEXT NOT NULL,
        goal_ids_json TEXT NOT NULL DEFAULT '[]',
        config_digest TEXT NOT NULL,
        evidence_path TEXT NOT NULL,
        evidence_sha256 TEXT NOT NULL,
        counts_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (task_id, id)
      );
      CREATE INDEX IF NOT EXISTS idx_reconcile_revisions_task ON reconcile_revisions(task_id, id);
      CREATE TABLE IF NOT EXISTS coverage_reviews (
        id TEXT PRIMARY KEY, task_id TEXT NOT NULL, goal_id TEXT NOT NULL,
        status TEXT NOT NULL, reviewer TEXT NOT NULL, reason TEXT NOT NULL,
        path TEXT, sha256 TEXT REFERENCES evidence_versions(sha256), created_at TEXT NOT NULL,
        FOREIGN KEY(task_id, goal_id) REFERENCES goals(task_id, id)
      );
      CREATE INDEX IF NOT EXISTS idx_coverage_task ON coverage_reviews(task_id, goal_id);
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

      CREATE TABLE IF NOT EXISTS findings (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        title TEXT NOT NULL,
        asset TEXT NOT NULL,
        vuln_class TEXT NOT NULL,
        severity TEXT NOT NULL,
        cvss TEXT,
        confidence TEXT NOT NULL,
        status TEXT NOT NULL,
        endpoint TEXT,
        dedup_key TEXT NOT NULL,
        intent_id TEXT,
        fact_ids_json TEXT NOT NULL DEFAULT '[]',
        evidence_json TEXT NOT NULL DEFAULT '[]',
        repro TEXT NOT NULL DEFAULT '',
        impact TEXT NOT NULL DEFAULT '',
        fix TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        verified_at TEXT,
        UNIQUE(task_id, dedup_key)
      );
      CREATE INDEX IF NOT EXISTS idx_findings_task ON findings(task_id, status);
      CREATE TABLE IF NOT EXISTS finding_proofs (
        task_id TEXT NOT NULL, finding_id TEXT NOT NULL, path TEXT NOT NULL,
        sha256 TEXT NOT NULL REFERENCES evidence_versions(sha256),
        PRIMARY KEY(task_id, finding_id, path)
      );

      -- A1/A3/A5: which findings supported a goal at first pass, and with which
      -- sealed evidence. Keeping this row is what lets a later reader separate
      -- "what passed then" from "what still stands now".
      CREATE TABLE IF NOT EXISTS goal_findings (
        task_id TEXT NOT NULL,
        goal_id TEXT NOT NULL,
        finding_id TEXT NOT NULL,
        status_at_assert TEXT NOT NULL,
        evidence_json TEXT NOT NULL DEFAULT '[]',
        created_at TEXT NOT NULL,
        PRIMARY KEY (task_id, goal_id, finding_id)
      );
      CREATE INDEX IF NOT EXISTS idx_goal_findings_task ON goal_findings(task_id, goal_id);

      -- Stage 5: delivered-report corrections. Numbered, deduped by the set of
      -- retracted findings they cover; the old report version is never rewritten.
      -- Stage 5: remediation retests and client risk decisions are separate
      -- records from technical verification; both keep sealed evidence.
      CREATE TABLE IF NOT EXISTS finding_actions (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        finding_id TEXT NOT NULL,
        action TEXT NOT NULL,
        result TEXT NOT NULL,
        note TEXT NOT NULL DEFAULT '',
        path TEXT NOT NULL,
        sha256 TEXT NOT NULL REFERENCES evidence_versions(sha256),
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_finding_actions_task ON finding_actions(task_id, finding_id);

      CREATE TABLE IF NOT EXISTS delivery_corrections (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        number INTEGER NOT NULL,
        reason TEXT NOT NULL,
        findings_json TEXT NOT NULL,
        goals_json TEXT NOT NULL,
        report_json TEXT NOT NULL DEFAULT '[]',
        notice_status TEXT NOT NULL DEFAULT 'pending',
        evidence_path TEXT,
        sha256 TEXT,
        dedup_key TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE(task_id, number),
        UNIQUE(task_id, dedup_key)
      );

      -- 阶段 5：客户从正常入口发起的复测申请。请求本身 append-only；
      -- 操作员完成复测后只追加 fulfilled_at/result，不改写原始请求。
      CREATE TABLE IF NOT EXISTS retest_requests (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        requester TEXT NOT NULL,
        role TEXT,
        finding_ids_json TEXT NOT NULL,
        reason TEXT NOT NULL,
        path TEXT,
        sha256 TEXT REFERENCES evidence_versions(sha256),
        status TEXT NOT NULL DEFAULT 'pending',
        fulfilled_at TEXT,
        fulfilled_result TEXT,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_retest_requests_task ON retest_requests(task_id, created_at);

      -- 阶段 5：同一委托内的跨任务署名复核。source_task_id 必须是同
      -- engagement 的任务；跨委托由控制面拒绝，这里只存已校验的记录。
      CREATE TABLE IF NOT EXISTS peer_reviews (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        engagement_id TEXT NOT NULL,
        reviewer TEXT NOT NULL,
        role TEXT NOT NULL,
        source_task_id TEXT NOT NULL,
        finding_id TEXT,
        fact_id TEXT,
        decision TEXT NOT NULL,
        basis TEXT NOT NULL,
        path TEXT,
        sha256 TEXT REFERENCES evidence_versions(sha256),
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_peer_reviews_task ON peer_reviews(task_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_peer_reviews_engagement ON peer_reviews(engagement_id, created_at);

      -- 知识库首版：报告里的定版资料引用。快照字节密封进 evidence_versions，
      -- 因此资料更新、旧版停用、服务重启或上游离线后，旧报告仍能回读原段落。
      CREATE TABLE IF NOT EXISTS material_citations (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        engagement_id TEXT NOT NULL,
        material_id TEXT NOT NULL,
        version_id TEXT NOT NULL,
        locator TEXT NOT NULL,
        claim TEXT NOT NULL,
        body_format TEXT NOT NULL,
        material_title TEXT NOT NULL,
        publisher TEXT NOT NULL,
        source_kind TEXT NOT NULL,
        version_no INTEGER NOT NULL,
        version_label TEXT NOT NULL,
        section_heading TEXT,
        section_page INTEGER,
        section_ordinal INTEGER NOT NULL,
        sha256 TEXT NOT NULL REFERENCES evidence_versions(sha256),
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_material_citations_task ON material_citations(task_id, created_at);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_material_citations_dedup
        ON material_citations(task_id, material_id, version_id, locator, claim);
    `);
    this.ensureIntentSourceFactIdsColumn();
    this.ensureIntentTechniqueColumns();
    this.ensureGoalColumns();
    this.ensureCitationPinColumns();
  }

  /**
   * 定版引用的原文范围与片段校验值。旧行没有这些值，pin_kind 保持 locator，
   * 回读走旧切分，因此升级前后读到的是同一段。
   * section_json 只存片段元数据（不含正文），正文一律从密封快照回读。
   */
  private ensureCitationPinColumns(): void {
    const cols = this.db.prepare(`PRAGMA table_info(material_citations)`).all() as Array<{ name: string }>;
    const have = new Set(cols.map((c) => c.name));
    const add: Record<string, string> = {
      pin_kind: "TEXT NOT NULL DEFAULT 'locator'",
      char_start: "INTEGER",
      char_end: "INTEGER",
      chunk_sha256: "TEXT",
      section_json: "TEXT",
    };
    for (const [name, definition] of Object.entries(add)) {
      if (!have.has(name)) this.db.exec(`ALTER TABLE material_citations ADD COLUMN ${name} ${definition}`);
    }
  }

  /** Migrate older DBs that predate goal-level assets / findings / board gate. */
  private ensureGoalColumns(): void {
    const cols = this.db
      .prepare(`PRAGMA table_info(goals)`)
      .all() as Array<{ name: string }>;
    const have = new Set(cols.map((c) => c.name));
    if (!have.has("findings_gate_json")) {
      this.db.exec(`ALTER TABLE goals ADD COLUMN findings_gate_json TEXT`);
    }
    if (!have.has("assets_json")) {
      this.db.exec(`ALTER TABLE goals ADD COLUMN assets_json TEXT`);
    }
    if (!have.has("board_gate")) {
      this.db.exec(`ALTER TABLE goals ADD COLUMN board_gate TEXT`);
    }
    if (!have.has("reconcile_gate_json")) {
      this.db.exec(`ALTER TABLE goals ADD COLUMN reconcile_gate_json TEXT`);
    }
    if (!have.has("goal_kind")) {
      this.db.exec(`ALTER TABLE goals ADD COLUMN goal_kind TEXT`);
    }
    if (!have.has("business_json")) {
      this.db.exec(`ALTER TABLE goals ADD COLUMN business_json TEXT`);
    }
  }

  /** 第九轮：覆盖矩阵需要 Intent 的测试类与资产根（缺省允许）。 */
  private ensureIntentTechniqueColumns(): void {
    const cols = this.db.prepare(`PRAGMA table_info(intents)`).all() as Array<{ name: string }>;
    const have = new Set(cols.map((column) => column.name));
    if (!have.has("technique")) this.db.exec(`ALTER TABLE intents ADD COLUMN technique TEXT`);
    if (!have.has("asset_root")) this.db.exec(`ALTER TABLE intents ADD COLUMN asset_root TEXT`);
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

  /** 公开的事件写入口（控制面用它记录状态迁移，例如补交后重新判定）。 */
  recordEvent(taskId: string, kind: HistoryEventKind, payload: Record<string, unknown> = {}): HistoryEvent {
    return this.emit(taskId, kind, payload);
  }

  seedGoals(taskId: string, goals: GoalState[]): void {
    // Control-plane snapshots can be older than the worker's evidence assertions.
    const stmt = this.db.prepare(`
      INSERT INTO goals
        (id, task_id, title, description, evidence_patterns_json, passes, evidence_paths_json,
         asserted_at, findings_gate_json, assets_json, board_gate, reconcile_gate_json,
         goal_kind, business_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
          g.findingsGate ? JSON.stringify(g.findingsGate) : null,
          g.assets?.length ? JSON.stringify(g.assets) : null,
          g.boardGate ?? null,
          g.reconcileGate ? JSON.stringify(g.reconcileGate) : null,
          // 目标类型与业务核算配置和 reconcileGate 一起落库：恢复后的任务读的
          // 是同一份配置，不需要操作员再手抄一遍。
          g.kind ?? "file",
          g.business ? JSON.stringify(g.business) : null,
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
    const query = this.archiveTables && !this.archiveTables.has("goal_checks")
      ? "SELECT *, NULL AS checks_json FROM goals WHERE task_id = ? ORDER BY id"
      : "SELECT g.*, c.checks_json FROM goals g LEFT JOIN goal_checks c ON c.goal_id = g.id AND c.task_id = g.task_id WHERE g.task_id = ? ORDER BY g.id";
    const rows = this.db
      .prepare(query)
      .all(taskId) as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      id: String(r.id),
      title: String(r.title),
      description: String(r.description),
      evidencePatterns: JSON.parse(String(r.evidence_patterns_json)) as string[],
      evidenceChecks: r.checks_json ? JSON.parse(String(r.checks_json)) : undefined,
      findingsGate: r.findings_gate_json
        ? (JSON.parse(String(r.findings_gate_json)) as FindingsGate)
        : undefined,
      ...(r.assets_json ? { assets: JSON.parse(String(r.assets_json)) as string[] } : {}),
      ...(r.board_gate === "tsecbench" ? { boardGate: "tsecbench" as const } : {}),
      ...(r.reconcile_gate_json
        ? { reconcileGate: JSON.parse(String(r.reconcile_gate_json)) as ReconcileGate }
        : {}),
      kind: (r.goal_kind as "file" | "business-reconcile" | null) ?? "file",
      ...(r.business_json
        ? { business: JSON.parse(String(r.business_json)) as BusinessReconcileConfig }
        : {}),
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
    technique?: string | null;
    assetRoot?: string | null;
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
      technique: input.technique?.trim() ? input.technique.trim() : null,
      assetRoot: input.assetRoot ? normalizeHost(input.assetRoot) : null,
      claimedBy: null,
      createdAt: now,
      updatedAt: now,
      concludedAt: null,
      conclusion: null,
    };
    this.db
      .prepare(
        `INSERT INTO intents
          (id, task_id, title, summary, status, source_fact_ids_json, claimed_by, technique, asset_root,
           created_at, updated_at, concluded_at, conclusion)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        intent.id,
        intent.taskId,
        intent.title,
        intent.summary,
        intent.status,
        JSON.stringify(intent.sourceFactIds),
        intent.claimedBy,
        intent.technique,
        intent.assetRoot,
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
      technique: (r.technique as string | null) ?? null,
      assetRoot: (r.asset_root as string | null) ?? null,
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
    /**
     * 测试注入点：用来制造“核算完成之后、首次通过提交之前输入又发生变化”
     * 那个窗口（在通过事务内、封存之前触发），验证二次核对能把首次通过整体
     * 回滚。生产路径不传。
     */
    hooks?: { beforeCommit?: () => void },
  ): { ok: true; goal: GoalState } | { ok: false; reason: string } {
    const goals = this.listGoals(taskId);
    const goal = goals.find((g) => g.id === goalId);
    if (!goal) return { ok: false, reason: `unknown goal: ${goalId}` };
    if (goal.passes) return { ok: true, goal };

    let files: EvidenceSnapshot[];
    try {
      files = collectGoalEvidence(this.evidenceDir, goal, evidencePaths, {
        // 业务核算目标由核算条件判定是否缺件，并点名缺哪一份材料。
        deferPatternsToReconcileGate: Boolean(goal.reconcileGate),
      });
    } catch (err) {
      return { ok: false, reason: err instanceof Error ? err.message : String(err) };
    }

    // 第七轮 + 第八轮：目标自报“完成差异比对”时，验收的是**本次首次通过所对应
    // 的那一版输入**算出的结果。只有归档里、口径一致、且两侧材料现在仍然是
    // 核算时那两份字节的核算版本才能支撑首次通过；曾经合格但材料已撤走 /
    // 已替换的旧结果只保留供追溯。重复提交时 passes=1 与事务内的二次核对
    // 一起保证只记一条首次通过事件。
    let adopted: {
      path: string;
      sha256: string;
      name: string;
      counts: ReconcileResult["counts"];
      revision: ReconcileRevision;
    } | null = null;
    if (goal.reconcileGate) {
      const outcome = selectAdoptedReconcile({
        evidenceDir: this.evidenceDir,
        gate: goal.reconcileGate,
        goalId,
        ...(goal.business
          ? { expectedConfigDigest: reconcileConfigDigest(goal.business), goalConfig: goal.business }
          : {}),
        archives: this.listReconcileRevisions(taskId),
      });
      if (!outcome.ok) {
        this.recordGoalRejection(taskId, goalId, outcome.reason);
        return { ok: false, reason: outcome.reason };
      }
      adopted = {
        path: outcome.adopted.path,
        sha256: outcome.adopted.sha256,
        name: outcome.result.name,
        counts: outcome.result.counts,
        revision: outcome.revision,
      };
      files = [outcome.adopted];
    }

    // A1: resolve which assets may testify for this goal *before* opening the
    // write transaction. A goal-scoped gate with no declared assets is refused
    // instead of silently falling back to "any finding in the task".
    let gateAssets: string[] | null = null;
    if (goal.findingsGate) {
      try {
        gateAssets = resolveGateAssets(goal.findingsGate, goal.assets);
      } catch (err) {
        return { ok: false, reason: err instanceof Error ? err.message : String(err) };
      }
    }

    const normalized = files.map((f) => f.path);

    // A3: the findings read and the first pass share one commit order. A
    // retraction committed before this point is invisible to the assertion; a
    // retraction committed after it keeps the historical pass and its支持依据.
    this.db.exec("BEGIN IMMEDIATE");
    try {
      let supporting: Finding[] = [];
      if (goal.findingsGate) {
        const gate = goal.findingsGate;
        const candidates = this.listFindings(taskId).filter((f) => findingSatisfiesGate(f, gate));
        supporting = gateAssets === null
          ? candidates
          : candidates.filter((f) => findingAssetInScope(f.asset, gateAssets!));
        if (supporting.length < gate.minVerified) {
          this.db.exec("ROLLBACK");
          return {
            ok: false,
            reason:
              `findings gate: verified=${supporting.length} < minVerified=${gate.minVerified}` +
              (gate.minSeverity ? ` (≥${gate.minSeverity})` : "") +
              (gate.vulnClasses?.length ? ` [${gate.vulnClasses.join(",")}]` : "") +
              (gateAssets === null ? " scope=task" : ` scope=goal assets=${gateAssets.join(",")}`) +
              ` — 先 finding_record + finding_verify（附证据与 repro）`,
          };
        }
      }

      const result = this.db
        .prepare(
          `UPDATE goals
           SET passes = 1, evidence_paths_json = ?, asserted_at = ?
           WHERE task_id = ? AND id = ? AND passes = 0`,
        )
        .run(JSON.stringify(normalized), this.now(), taskId, goalId);
      if (result.changes) {
        // 核算完成之后、首次通过提交之前的最后一次核对：材料在这期间被撤走
        // 或替换，本次首次通过整体回滚，旧结果保留供追溯。
        hooks?.beforeCommit?.();
        if (adopted) {
          const recheck = verifyRevisionInputs(this.evidenceDir, adopted.revision);
          if (!recheck.ok) {
            this.db.exec("ROLLBACK");
            const reason = `核算结果 ${adopted.path}（版本 ${adopted.revision.id}）不能支撑本次首次通过：${recheck.reason}`;
            this.recordGoalRejection(taskId, goalId, reason);
            return { ok: false, reason };
          }
        }
        for (const f of files) {
          this.saveVersion(f);
          this.db.prepare("INSERT INTO goal_proofs VALUES (?, ?, ?, ?)").run(taskId, goalId, f.path, f.sha256);
        }
        const stamp = this.now();
        for (const finding of supporting) {
          this.db.prepare(
            `INSERT INTO goal_findings (task_id, goal_id, finding_id, status_at_assert, evidence_json, created_at)
             VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`,
          ).run(taskId, goalId, finding.id, finding.status, JSON.stringify(finding.evidence), stamp);
        }
        this.emit(taskId, "goal_asserted", {
          goalId,
          evidencePaths: normalized,
          findingIds: supporting.map((f) => f.id),
          ...(adopted
            ? {
                adoptedReconcile: {
                  path: adopted.path,
                  sha256: adopted.sha256,
                  name: adopted.name,
                  counts: adopted.counts,
                  revisionId: adopted.revision.id,
                  inputDigest: adopted.revision.inputDigest,
                  configDigest: adopted.revision.configDigest,
                  baseline: {
                    path: adopted.revision.baseline.path,
                    sha256: adopted.revision.baseline.sha256,
                  },
                  current: {
                    path: adopted.revision.current.path,
                    sha256: adopted.revision.current.sha256,
                  },
                },
              }
            : {}),
        });
      }
      const updated = this.listGoals(taskId).find((g) => g.id === goalId);
      this.db.exec("COMMIT");
      return updated ? { ok: true, goal: updated } : { ok: false, reason: `unknown goal: ${goalId}` };
    } catch (err) {
      try { this.db.exec("ROLLBACK"); } catch { /* already rolled back */ }
      throw err;
    }
  }

  /**
   * 第八轮：执行一次核算并归档成“核算版本”。
   *
   * 一次核算 = 一份带版本号的结果文件 + 一条数据库记录。记录里有：对应的目标、
   * 两侧材料的路径与内容哈希、采用的核算口径摘要、结果文件哈希。首次判定只认
   * 这里的记录（顺序由单调版本号给出），文件本身则作为可复核的证据留在
   * evidence/ 下；同名连续核算因为版本号不同而互不覆盖、互不混淆。
   */
  archiveReconcile(input: {
    taskId: string;
    request: ReconcileRequest;
    /** 本次核算对应的目标；业务目标的核算必须点名。 */
    goalIds?: string[];
  }): {
    revision: ReconcileRevision;
    result: ReconcileResult;
    evidencePath: string;
    evidenceSha256: string;
    factId: string;
  } {
    const { taskId, request } = input;
    const goalIds = [...new Set(input.goalIds ?? request.goalIds ?? [])];
    if (goalIds.length) {
      const known = new Set(this.listGoals(taskId).map((goal) => goal.id));
      for (const goalId of goalIds) {
        if (!known.has(goalId)) throw new Error(`unknown goal: ${goalId}`);
      }
    }

    const baselineState = this.stampMaterial(request.baseline.path);
    const currentState = this.stampMaterial(request.current.path);
    const baselineParsed = baselineState.bytes
      ? parseMaterial({
          path: request.baseline.path,
          content: baselineState.bytes.toString("utf8"),
          keyField: request.baseline.keyField ?? request.keyField,
          ...(request.baseline.format ? { format: request.baseline.format } : {}),
        })
      : null;
    const currentParsed = currentState.bytes
      ? parseMaterial({
          path: request.current.path,
          content: currentState.bytes.toString("utf8"),
          keyField: request.current.keyField ?? request.keyField,
          ...(request.current.format ? { format: request.current.format } : {}),
        })
      : null;

    const result = reconcileMaterials({
      request,
      baseline: baselineParsed,
      current: currentParsed,
      baselineSha256: baselineState.sha256,
      currentSha256: currentState.sha256,
    });

    const config: BusinessReconcileConfig = businessConfigFromRequest(request);
    const configDigest = reconcileConfigDigest(config);
    const baselineStamp: ReconcileInputStamp = {
      path: request.baseline.path,
      format: baselineParsed?.format ?? request.baseline.format ?? null,
      present: baselineState.present,
      sha256: baselineState.sha256,
      rows: baselineParsed?.rows.length ?? 0,
    };
    const currentStamp: ReconcileInputStamp = {
      path: request.current.path,
      format: currentParsed?.format ?? request.current.format ?? null,
      present: currentState.present,
      sha256: currentState.sha256,
      rows: currentParsed?.rows.length ?? 0,
    };

    const revision: ReconcileRevision = {
      id: nextReconcileRevisionId(this.listReconcileRevisions(taskId).map((entry) => entry.revision.id)),
      taskId,
      goalIds,
      config,
      configDigest,
      inputDigest: reconcileInputDigest(configDigest, baselineStamp, currentStamp),
      baseline: baselineStamp,
      current: currentStamp,
      createdAt: this.now(),
    };

    const resultWithRevision: ReconcileResult = { ...result, revision };
    const serialized = JSON.stringify(resultWithRevision, null, 2) + "\n";
    // 版本号进文件名：同名同路径的连续核算各自留档，不会互相覆盖。
    const relativePath = `reconcile/${request.name}-${revision.id}.json`;
    writeEvidenceFile(this.evidenceDir, relativePath, serialized);
    const evidenceSha256 = createHash("sha256").update(Buffer.from(serialized, "utf8")).digest("hex");

    const fact = this.appendFact({
      taskId,
      layer: "evidence",
      title: `原始材料差异核算 · ${request.name}`,
      summary: summarizeReconcile(resultWithRevision),
      evidencePath: relativePath,
      tags: ["reconcile", `reconcile:${request.name}`, `reconcile-revision:${revision.id}`, "source:operator"],
    });

    this.db
      .prepare(
        `INSERT INTO reconcile_revisions
           (task_id, id, revision_json, goal_ids_json, config_digest, evidence_path, evidence_sha256, counts_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        taskId,
        revision.id,
        JSON.stringify(revision),
        JSON.stringify(goalIds),
        configDigest,
        relativePath,
        evidenceSha256,
        JSON.stringify(resultWithRevision.counts),
        revision.createdAt,
      );

    return { revision, result: resultWithRevision, evidencePath: relativePath, evidenceSha256, factId: fact.id };
  }

  /** 材料在“现在”的样子：读得到就有哈希，读不到就标记缺件（不猜）。 */
  private stampMaterial(path: string): { path: string; present: boolean; sha256: string | null; bytes: Buffer | null } {
    try {
      resolveEvidenceFile(this.evidenceDir, path);
      const bytes = readEvidenceBytes(this.evidenceDir, path);
      return {
        path,
        present: true,
        sha256: createHash("sha256").update(bytes).digest("hex"),
        bytes,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (/ENOENT|no such file/i.test(message)) return { path, present: false, sha256: null, bytes: null };
      throw err;
    }
  }

  /** 任务的全部核算版本（按版本号倒序 = 时间倒序）。 */
  listReconcileRevisions(taskId: string): ArchivedReconcile[] {
    if (this.archiveTables && !this.archiveTables.has("reconcile_revisions")) return [];
    const rows = this.db
      .prepare(
        `SELECT revision_json, evidence_path, evidence_sha256, counts_json
         FROM reconcile_revisions WHERE task_id = ? ORDER BY id DESC`,
      )
      .all(taskId) as Array<{
        revision_json: string;
        evidence_path: string;
        evidence_sha256: string;
        counts_json: string;
      }>;
    return rows.map((row) => ({
      revision: JSON.parse(String(row.revision_json)) as ReconcileRevision,
      evidencePath: String(row.evidence_path),
      evidenceSha256: String(row.evidence_sha256),
      counts: JSON.parse(String(row.counts_json)) as ReconcileResult["counts"],
    }));
  }

  /** 某个目标的核算态：缺材料 / 待重算 / 结论不合格 / 可判定（或已通过）。 */
  goalReconcileState(taskId: string, goalId: string): ReconcileStateReport | null {
    const goal = this.listGoals(taskId).find((entry) => entry.id === goalId);
    if (!goal?.reconcileGate) return null;
    if (goal.passes) {
      const proofs = this.listGoalProofs(taskId).filter((proof) => proof.goalId === goalId);
      return {
        state: "passed",
        reason: null,
        latestRevisionId: proofs[0]?.path.match(/r\d{13}-\d{4}/)?.[0] ?? null,
        readyRevisionId: null,
        materials: goal.business
          ? {
              baseline: { path: goal.business.baseline.path, present: this.hasEvidence(goal.business.baseline.path) },
              current: { path: goal.business.current.path, present: this.hasEvidence(goal.business.current.path) },
            }
          : null,
        drift: null,
        // 已通过的目标不必再提示冲突项（当时的结论已经归档在首次通过依据里）。
        ambiguous: [],
      };
    }
    return describeReconcileState({
      evidenceDir: this.evidenceDir,
      gate: goal.reconcileGate,
      goalId,
      ...(goal.business
        ? { expectedConfigDigest: reconcileConfigDigest(goal.business), goalConfig: goal.business }
        : {}),
      archives: this.listReconcileRevisions(taskId),
      ...(goal.business
        ? { declaredMaterials: { baseline: goal.business.baseline.path, current: goal.business.current.path } }
        : {}),
    });
  }

  private hasEvidence(path: string): boolean {
    try {
      resolveEvidenceFile(this.evidenceDir, path);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * 目标未通过的原因要能被人读到（不只是一次工具返回值）。同一目标同一原因
   * 只记一次，避免每个循环都刷一条事件。
   */
  private recordGoalRejection(taskId: string, goalId: string, reason: string): void {
    const recent = this.db
      .prepare(
        `SELECT payload_json FROM events
         WHERE task_id = ? AND kind = 'goal_assert_rejected'
         ORDER BY created_at DESC LIMIT 20`,
      )
      .all(taskId) as Array<{ payload_json: string }>;
    for (const row of recent) {
      try {
        const payload = JSON.parse(row.payload_json) as { goalId?: string; reason?: string };
        if (payload.goalId === goalId && payload.reason === reason) return;
      } catch {
        /* 忽略坏事件，继续判断 */
      }
    }
    this.emit(taskId, "goal_assert_rejected", { goalId, reason });
  }

  /** First-pass finding attribution (A1/A3/A5). Empty for older archives. */
  listGoalFindings(taskId: string): GoalFindingSupport[] {
    if (this.archiveTables && !this.archiveTables.has("goal_findings")) return [];
    return this.db
      .prepare(
        `SELECT goal_id AS goalId, finding_id AS findingId, status_at_assert AS statusAtAssert,
                evidence_json AS evidenceJson, created_at AS createdAt
         FROM goal_findings WHERE task_id = ? ORDER BY created_at, goal_id, finding_id`,
      )
      .all(taskId)
      .map((row) => {
        const r = row as { goalId: string; findingId: string; statusAtAssert: string; evidenceJson: string; createdAt: string };
        return {
          goalId: r.goalId,
          findingId: r.findingId,
          statusAtAssert: r.statusAtAssert,
          evidence: JSON.parse(r.evidenceJson) as Array<{ path: string; sha256: string }>,
          createdAt: r.createdAt,
        };
      });
  }

  /** A4/A5 — a frozen delivery snapshot any reviewer can recompute from. */
  deliverySnapshot(taskId: string, capturedAt = this.now()): DeliverySnapshot {
    const goals: SnapshotGoal[] = this.listGoals(taskId).map((goal) => ({
      id: goal.id,
      title: goal.title,
      passes: goal.passes,
      evidencePatterns: goal.evidencePatterns,
      evidencePaths: goal.evidencePaths,
      assertedAt: goal.assertedAt,
      ...(goal.assets?.length ? { assets: goal.assets } : {}),
      ...(goal.evidenceChecks?.length ? { evidenceChecks: goal.evidenceChecks } : {}),
      ...(goal.findingsGate ? { findingsGate: goal.findingsGate } : {}),
      ...(goal.reconcileGate ? { reconcileGate: goal.reconcileGate } : {}),
      ...(goal.boardGate ? { boardGate: goal.boardGate } : {}),
      ...(goal.kind ? { kind: goal.kind } : {}),
      ...(goal.business ? { business: goal.business } : {}),
    }));
    const findings: SnapshotFinding[] = this.listFindings(taskId).map((finding) => ({
      id: finding.id,
      title: finding.title,
      asset: finding.asset,
      vulnClass: finding.vulnClass,
      severity: finding.severity as SnapshotFinding["severity"],
      status: finding.status,
      evidence: finding.evidence,
    }));
    const coverage: SnapshotCoverage[] = this.listCoverage(taskId).map((entry) => ({
      goalId: entry.goalId,
      status: entry.status,
      reviewer: entry.reviewer,
      reason: entry.reason,
      ...(entry.evidencePath ? { evidencePath: entry.evidencePath } : {}),
      ...(entry.sha256 ? { sha256: entry.sha256 } : {}),
      createdAt: entry.createdAt,
    }));
    return finalizeSnapshot({
      version: 1,
      taskId,
      capturedAt,
      goals,
      proofs: this.listGoalProofs(taskId),
      goalFindings: this.listGoalFindings(taskId),
      findings,
      coverage,
    });
  }

  scorecard(taskId: string): Scorecard {
    return computeScorecard(this.deliverySnapshot(taskId));
  }

  /**
   * Stage 5 — a delivered report is immutable; a retraction produces a numbered
   * correction that lists the affected goals/findings and keeps notice state.
   * Deduped by the retracted-finding set: processing the same retraction twice
   * yields one correction.
   */
  recordDeliveryCorrection(
    taskId: string,
    input: {
      reason: string;
      findings?: string[];
      report?: Array<{ path: string; sha256: string }>;
      noticeStatus?: DeliveryCorrection["noticeStatus"];
      evidencePath?: string;
    },
  ): { correction: DeliveryCorrection; created: boolean } {
    const reason = input.reason.trim();
    if (!reason) throw new Error("correction reason required");
    const allFindings = this.listFindings(taskId);
    const retracted = new Set(
      input.findings?.length
        ? input.findings
        : allFindings.filter((f) => f.status === "retracted").map((f) => f.id),
    );
    for (const id of retracted) {
      const finding = allFindings.find((f) => f.id === id);
      if (!finding) throw new Error(`unknown finding: ${id}`);
      if (finding.status !== "retracted") throw new Error(`finding is not retracted: ${id}`);
    }
    const goalFindings = this.listGoalFindings(taskId);
    const affectedFindings = [...retracted].filter((id) => goalFindings.some((s) => s.findingId === id)).sort();
    const goals = [...new Set(goalFindings.filter((s) => retracted.has(s.findingId)).map((s) => s.goalId))].sort();
    if (!affectedFindings.length) throw new Error("没有已通过的结论引用被撤回的发现，无需更正");
    const dedupKey = createHash("sha256")
      .update(JSON.stringify({ findings: affectedFindings, goals }))
      .digest("hex");
    const existing = this.listDeliveryCorrections(taskId).find((c) => {
      const key = createHash("sha256")
        .update(JSON.stringify({ findings: [...c.findings].sort(), goals: [...c.goals].sort() }))
        .digest("hex");
      return key === dedupKey;
    });
    if (existing) return { correction: existing, created: false };

    const report = (input.report ?? []).map((entry) => ({ path: entry.path, sha256: entry.sha256 }));
    const evidence = input.evidencePath ? captureEvidence(this.evidenceDir, input.evidencePath) : undefined;
    const number = this.listDeliveryCorrections(taskId).length + 1;
    const correction: DeliveryCorrection = {
      id: randomUUID(),
      taskId,
      number,
      reason,
      findings: affectedFindings,
      goals,
      report,
      noticeStatus: input.noticeStatus ?? "pending",
      ...(evidence ? { evidencePath: evidence.path, sha256: evidence.sha256 } : {}),
      createdAt: this.now(),
    };
    this.db.exec("BEGIN IMMEDIATE");
    try {
      if (evidence) this.saveVersion(evidence);
      this.db.prepare(
        `INSERT INTO delivery_corrections
          (id, task_id, number, reason, findings_json, goals_json, report_json,
           notice_status, evidence_path, sha256, dedup_key, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        correction.id, taskId, correction.number, correction.reason,
        JSON.stringify(correction.findings), JSON.stringify(correction.goals),
        JSON.stringify(correction.report), correction.noticeStatus,
        correction.evidencePath ?? null, correction.sha256 ?? null,
        dedupKey, correction.createdAt,
      );
      this.emit(taskId, "delivery_corrected", {
        correctionId: correction.id,
        number: correction.number,
        findings: correction.findings,
        goals: correction.goals,
      });
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
    return { correction, created: true };
  }

  listDeliveryCorrections(taskId: string): DeliveryCorrection[] {
    if (this.archiveTables && !this.archiveTables.has("delivery_corrections")) return [];
    return this.db
      .prepare(
        `SELECT id, task_id AS taskId, number, reason, findings_json AS findingsJson,
                goals_json AS goalsJson, report_json AS reportJson, notice_status AS noticeStatus,
                evidence_path AS evidencePath, sha256, created_at AS createdAt
         FROM delivery_corrections WHERE task_id = ? ORDER BY number`,
      )
      .all(taskId)
      .map((row) => {
        const r = row as Record<string, unknown>;
        return {
          id: String(r.id),
          taskId: String(r.taskId),
          number: Number(r.number),
          reason: String(r.reason),
          findings: JSON.parse(String(r.findingsJson)) as string[],
          goals: JSON.parse(String(r.goalsJson)) as string[],
          report: JSON.parse(String(r.reportJson)) as Array<{ path: string; sha256: string }>,
          noticeStatus: String(r.noticeStatus) as DeliveryCorrection["noticeStatus"],
          ...(r.evidencePath ? { evidencePath: String(r.evidencePath) } : {}),
          ...(r.sha256 ? { sha256: String(r.sha256) } : {}),
          createdAt: String(r.createdAt),
        };
      });
  }

  /** "已通知" / "已确认收悉" need an operator action; confirmation needs evidence. */
  setDeliveryCorrectionNotice(
    taskId: string,
    correctionId: string,
    status: DeliveryCorrection["noticeStatus"],
    evidencePath?: string,
  ): DeliveryCorrection {
    const existing = this.listDeliveryCorrections(taskId).find((c) => c.id === correctionId);
    if (!existing) throw new Error(`unknown correction: ${correctionId}`);
    const evidence = evidencePath ? captureEvidence(this.evidenceDir, evidencePath) : undefined;
    if (status === "confirmed" && !evidence) {
      throw new Error("confirmed 通知状态需要客户确认证据文件");
    }
    this.db.exec("BEGIN IMMEDIATE");
    try {
      if (evidence) this.saveVersion(evidence);
      this.db.prepare(
        `UPDATE delivery_corrections SET notice_status = ?, evidence_path = COALESCE(?, evidence_path),
           sha256 = COALESCE(?, sha256) WHERE task_id = ? AND id = ?`,
      ).run(status, evidence?.path ?? null, evidence?.sha256 ?? null, taskId, correctionId);
      this.emit(taskId, "delivery_correction_notice", { correctionId, status });
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
    return this.listDeliveryCorrections(taskId).find((c) => c.id === correctionId)!;
  }

  withReportTransaction<T>(render: () => T): T {
    if (this.db.isTransaction) return render();
    this.db.exec(this.archiveTables ? "BEGIN" : "BEGIN IMMEDIATE");
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
    if (this.archiveTables && !this.archiveTables.has("goal_proofs")) return [];
    return this.db.prepare("SELECT goal_id AS goalId, path, sha256 FROM goal_proofs WHERE task_id = ? ORDER BY goal_id, path")
      .all(taskId) as GoalProof[];
  }

  readProofVersion(taskId: string, sha256: string): Buffer | undefined {
    // 证据版本可回读的条件：它确实被本任务的某条密封记录引用过。新增的
    // 记录类型（复测/受理/复测申请/署名复核/更正通知）都必须列进来，否则
    // 报告重新渲染时会把“有引用但读不到”的证据判成错误。
    const sites: Array<[string, string]> = [
      ["goal_proofs", "task_id"],
      ["fact_reviews", "task_id"],
      ["coverage_reviews", "task_id"],
      ["finding_proofs", "task_id"],
      ["finding_actions", "task_id"],
      ["retest_requests", "task_id"],
      ["peer_reviews", "task_id"],
      ["delivery_corrections", "task_id"],
      ["material_citations", "task_id"],
    ];
    const clauses: string[] = [];
    const params: Array<string> = [sha256];
    for (const [table, column] of sites) {
      if (this.archiveTables && !this.archiveTables.has(table)) continue;
      clauses.push(`EXISTS (SELECT 1 FROM ${table} WHERE ${column} = ? AND sha256 = ?)`);
      params.push(taskId, sha256);
    }
    if (!clauses.length) return undefined;
    const row = this.db
      .prepare(`SELECT content FROM evidence_versions WHERE sha256 = ? AND (${clauses.join(" OR ")})`)
      .get(...params) as { content: Uint8Array } | undefined;
    return row && Buffer.from(row.content);
  }

  listReviews(taskId: string): FactReview[] {
    if (this.archiveTables && !this.archiveTables.has("fact_reviews")) return [];
    const rows = this.db.prepare(`SELECT id, fact_id AS factId, goal_id AS goalId, decision,
      replacement_fact_id AS replacementFactId, reviewer, reason, path AS evidencePath, sha256,
      created_at AS createdAt FROM fact_reviews WHERE task_id = ? ORDER BY rowid`)
      .all(taskId);
    return rows.map(({ replacementFactId, ...r }) => ({
      ...r, ...(replacementFactId ? { replacementFactId } : {}),
    }) as FactReview);
  }

  listCoverage(taskId: string): CoverageReview[] {
    if (this.archiveTables && !this.archiveTables.has("coverage_reviews")) return [];
    return this.db.prepare(`SELECT id, goal_id AS goalId, status, reviewer, reason,
      path AS evidencePath, sha256, created_at AS createdAt FROM coverage_reviews WHERE task_id = ? ORDER BY rowid`)
      .all(taskId).map(({ evidencePath, sha256, ...record }) => ({
        ...record, ...(evidencePath ? { evidencePath, sha256 } : {}),
      }) as CoverageReview);
  }

  recordCoverage(taskId: string, input: CoverageReviewInput): CoverageReview {
    const entry = CoverageReviewSchema.parse(input);
    const file = entry.evidencePath ? captureEvidence(this.evidenceDir, entry.evidencePath) : undefined;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      if (!this.listGoals(taskId).some((g) => g.id === entry.goalId)) throw new Error("unknown coverage goal");
      const prior = this.listCoverage(taskId).filter((r) => r.goalId === entry.goalId).at(-1);
      if (prior && prior.status === entry.status && prior.reason === entry.reason && prior.reviewer === entry.reviewer &&
          prior.evidencePath === file?.path && prior.sha256 === file?.sha256) {
        this.db.exec("COMMIT");
        return prior;
      }
      const review: CoverageReview = { ...entry, id: randomUUID(), createdAt: this.now(),
        ...(file ? { evidencePath: file.path, sha256: file.sha256 } : {}) };
      if (file) this.saveVersion(file);
      this.db.prepare("INSERT INTO coverage_reviews (id, task_id, goal_id, status, reviewer, reason, path, sha256, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
        .run(review.id, taskId, review.goalId, review.status, review.reviewer, review.reason,
          file?.path ?? null, file?.sha256 ?? null, review.createdAt);
      this.db.exec("COMMIT");
      return review;
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  /**
   * 阶段 5 — 客户从正常入口发起的复测申请。append-only：原始请求不改写，
   * 操作员完成复测时只追加 completed 标记。
   */
  recordRetestRequest(taskId: string, input: RetestRequestInput): RetestRequest {
    const entry = RetestRequestSchema.parse(input);
    const file = entry.evidencePath ? captureEvidence(this.evidenceDir, entry.evidencePath) : undefined;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const findings = new Map(this.listFindings(taskId).map((f) => [f.id, f]));
      for (const id of entry.findingIds) {
        const finding = findings.get(id);
        if (!finding) throw new Error(`retest request references unknown finding: ${id}`);
        if (finding.status === "retracted") throw new Error(`cannot request retest for retracted finding: ${id}`);
      }
      const request: RetestRequest = {
        ...entry,
        id: randomUUID(),
        status: "pending" as RetestRequestStatus,
        createdAt: this.now(),
        ...(file ? { evidencePath: file.path, sha256: file.sha256 } : {}),
      };
      if (file) this.saveVersion(file);
      this.db
        .prepare(
          `INSERT INTO retest_requests (id, task_id, requester, role, finding_ids_json, reason, path, sha256, status, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          request.id, taskId, request.requester, request.role ?? null,
          JSON.stringify(request.findingIds), request.reason,
          file?.path ?? null, file?.sha256 ?? null, request.status, request.createdAt,
        );
      this.emit(taskId, "retest_requested", {
        requestId: request.id,
        requester: request.requester,
        findingIds: request.findingIds,
      });
      this.db.exec("COMMIT");
      return request;
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  listRetestRequests(taskId: string): RetestRequest[] {
    if (this.archiveTables && !this.archiveTables.has("retest_requests")) return [];
    return this.db
      .prepare(
        `SELECT id, requester, role, finding_ids_json AS findingIdsJson, reason, path AS evidencePath,
                sha256, status, fulfilled_at AS fulfilledAt, fulfilled_result AS fulfilledResult,
                created_at AS createdAt
         FROM retest_requests WHERE task_id = ? ORDER BY rowid`,
      )
      .all(taskId)
      .map((row) => {
        const r = row as {
          id: string; requester: string; role: string | null; findingIdsJson: string; reason: string;
          evidencePath: string | null; sha256: string | null; status: string;
          fulfilledAt: string | null; fulfilledResult: string | null; createdAt: string;
        };
        return {
          id: r.id,
          requester: r.requester,
          ...(r.role ? { role: r.role } : {}),
          findingIds: JSON.parse(r.findingIdsJson) as string[],
          reason: r.reason,
          ...(r.evidencePath ? { evidencePath: r.evidencePath } : {}),
          ...(r.sha256 ? { sha256: r.sha256 } : {}),
          status: r.status as RetestRequestStatus,
          ...(r.fulfilledAt ? { fulfilledAt: r.fulfilledAt } : {}),
          ...(r.fulfilledResult ? { fulfilledResult: r.fulfilledResult } : {}),
          createdAt: r.createdAt,
        };
      });
  }

  /** Called right after a retest is recorded; returns the requests it closed. */
  fulfillRetestRequests(taskId: string, findingId: string, result: string): RetestRequest[] {
    if (this.archiveTables && !this.archiveTables.has("retest_requests")) return [];
    const due = this.listRetestRequests(taskId).filter(
      (request) => request.status === "pending" && request.findingIds.includes(findingId),
    );
    if (!due.length) return [];
    const at = this.now();
    const update = this.db.prepare(
      `UPDATE retest_requests SET status = 'fulfilled', fulfilled_at = ?, fulfilled_result = ? WHERE id = ?`,
    );
    this.db.exec("BEGIN IMMEDIATE");
    try {
      for (const request of due) update.run(at, result, request.id);
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
    return this.listRetestRequests(taskId).filter((request) => due.some((d) => d.id === request.id));
  }

  /**
   * 阶段 5 — 同一委托内的跨任务署名复核。engagementId 由控制面按两端任务
   * 记录核对后传入；这里只做结构校验与留痕，不改写被复核的任务。
   */
  recordPeerReview(taskId: string, engagementId: string, input: PeerReviewInput): PeerReview {
    const entry = PeerReviewSchema.parse(input);
    if (!engagementId.trim()) throw new Error("peer review requires an engagement");
    const file = entry.evidencePath ? captureEvidence(this.evidenceDir, entry.evidencePath) : undefined;
    const review: PeerReview = {
      ...entry,
      id: randomUUID(),
      engagementId,
      taskId,
      createdAt: this.now(),
      ...(file ? { evidencePath: file.path, sha256: file.sha256 } : {}),
    };
    this.db.exec("BEGIN IMMEDIATE");
    try {
      if (file) this.saveVersion(file);
      this.db
        .prepare(
          `INSERT INTO peer_reviews (id, task_id, engagement_id, reviewer, role, source_task_id,
             finding_id, fact_id, decision, basis, path, sha256, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          review.id, taskId, engagementId, review.reviewer, review.role, review.sourceTaskId,
          review.findingId ?? null, review.factId ?? null, review.decision, review.basis,
          file?.path ?? null, file?.sha256 ?? null, review.createdAt,
        );
      this.emit(taskId, "peer_review_recorded", {
        reviewId: review.id,
        reviewer: review.reviewer,
        sourceTaskId: review.sourceTaskId,
        decision: review.decision,
      });
      this.db.exec("COMMIT");
      return review;
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  listPeerReviews(taskId: string): PeerReview[] {
    if (this.archiveTables && !this.archiveTables.has("peer_reviews")) return [];
    return this.db
      .prepare(
        `SELECT id, task_id AS taskId, engagement_id AS engagementId, reviewer, role,
                source_task_id AS sourceTaskId, finding_id AS findingId, fact_id AS factId,
                decision, basis, path AS evidencePath, sha256, created_at AS createdAt
         FROM peer_reviews WHERE task_id = ? ORDER BY rowid`,
      )
      .all(taskId)
      .map((row) => {
        const r = row as Record<string, string | null>;
        return {
          id: String(r.id),
          taskId: String(r.taskId),
          engagementId: String(r.engagementId),
          reviewer: String(r.reviewer),
          role: String(r.role),
          sourceTaskId: String(r.sourceTaskId),
          ...(r.findingId ? { findingId: r.findingId } : {}),
          ...(r.factId ? { factId: r.factId } : {}),
          decision: r.decision as PeerReview["decision"],
          basis: String(r.basis),
          ...(r.evidencePath ? { evidencePath: r.evidencePath } : {}),
          ...(r.sha256 ? { sha256: r.sha256 } : {}),
          createdAt: String(r.createdAt),
        } as PeerReview;
      });
  }

  /**
   * 定版资料引用。快照字节在此密封进本任务的 evidence_versions，报告因此
   * 不依赖知识库快照或上游网络。重复提交同一引用返回已有记录，不追加。
   */
  recordMaterialCitation(
    taskId: string,
    engagementId: string,
    input: MaterialCitationInput,
    seal: MaterialCitationSeal,
  ): MaterialCitation {
    const entry = MaterialCitationSchema.parse(input);
    if (!engagementId.trim()) throw new Error("material citation requires an engagement");
    const sha256 = createHash("sha256").update(seal.snapshot).digest("hex");
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const existing = this.db.prepare(
        `SELECT id FROM material_citations
         WHERE task_id = ? AND material_id = ? AND version_id = ? AND locator = ? AND claim = ?`,
      ).get(taskId, entry.materialId, entry.versionId, entry.locator, entry.claim) as { id: string } | undefined;
      if (existing) {
        this.db.exec("COMMIT");
        return this.getMaterialCitation(taskId, existing.id)!;
      }
      const citation: MaterialCitation = {
        id: randomUUID(),
        taskId,
        engagementId,
        materialId: entry.materialId,
        versionId: entry.versionId,
        locator: entry.locator,
        claim: entry.claim,
        snapshotSha256: sha256,
        bodyFormat: seal.bodyFormat,
        materialTitle: seal.materialTitle,
        publisher: seal.publisher,
        sourceKind: seal.sourceKind,
        versionNo: seal.versionNo,
        versionLabel: seal.versionLabel,
        sectionHeading: seal.sectionHeading,
        sectionPage: seal.sectionPage,
        sectionOrdinal: seal.sectionOrdinal,
        createdAt: this.now(),
        pinKind: entry.charStart === undefined ? "locator" : "range",
        charStart: entry.charStart ?? null,
        charEnd: entry.charEnd ?? null,
        chunkSha256: entry.chunkSha256 ?? null,
        headingPath: seal.sectionMeta.headingPath,
        pageBasis: seal.sectionMeta.pageBasis,
      };
      this.saveVersion({ path: `knowledge/${sha256}`, sha256, content: seal.snapshot });
      this.db.prepare(
        `INSERT INTO material_citations (id, task_id, engagement_id, material_id, version_id, locator, claim,
           body_format, material_title, publisher, source_kind, version_no, version_label,
           section_heading, section_page, section_ordinal, sha256, created_at,
           pin_kind, char_start, char_end, chunk_sha256, section_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(citation.id, taskId, engagementId, citation.materialId, citation.versionId, citation.locator,
        citation.claim, citation.bodyFormat, citation.materialTitle, citation.publisher, citation.sourceKind,
        citation.versionNo, citation.versionLabel, citation.sectionHeading, citation.sectionPage,
        citation.sectionOrdinal, sha256, citation.createdAt,
        citation.pinKind, citation.charStart, citation.charEnd, citation.chunkSha256,
        JSON.stringify(seal.sectionMeta));
      this.emit(taskId, "material_citation_recorded", {
        citationId: citation.id,
        materialId: citation.materialId,
        versionId: citation.versionId,
        locator: citation.locator,
        sha256,
      });
      this.db.exec("COMMIT");
      return citation;
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  private static readonly CITATION_BASE_COLUMNS = `id, task_id AS taskId, engagement_id AS engagementId,
    material_id AS materialId, version_id AS versionId, locator, claim, body_format AS bodyFormat,
    material_title AS materialTitle, publisher, source_kind AS sourceKind,
    version_no AS versionNo, version_label AS versionLabel, section_heading AS sectionHeading,
    section_page AS sectionPage, section_ordinal AS sectionOrdinal,
    sha256 AS snapshotSha256, created_at AS createdAt`;

  private citationColumnNames: Set<string> | null = null;

  /**
   * 只读连接不跑迁移，因此升级前的库可能还没有定版范围列。
   * 缺列时用 SQL 常量补默认值，让旧引用照样读得出来（pinKind 回落 locator）。
   */
  private citationColumns(): string {
    if (!this.citationColumnNames) {
      this.citationColumnNames = new Set(
        (this.db.prepare(`PRAGMA table_info(material_citations)`).all() as Array<{ name: string }>)
          .map((row) => row.name),
      );
    }
    const have = this.citationColumnNames;
    const optional: Array<[string, string, string]> = [
      ["pin_kind", "pinKind", "'locator'"],
      ["char_start", "charStart", "NULL"],
      ["char_end", "charEnd", "NULL"],
      ["chunk_sha256", "chunkSha256", "NULL"],
      ["section_json", "sectionJson", "NULL"],
    ];
    const extras = optional.map(([column, alias, fallback]) =>
      have.has(column) ? `${column} AS ${alias}` : `${fallback} AS ${alias}`);
    return `${HistoryStore.CITATION_BASE_COLUMNS}, ${extras.join(", ")}`;
  }

  private mapCitation(row: Omit<MaterialCitation, "headingPath" | "pageBasis"> & { sectionJson: string | null }): MaterialCitation {
    const { sectionJson, ...rest } = row;
    const meta = sectionJson ? JSON.parse(sectionJson) as Omit<KnowledgeSection, "text"> : null;
    return { ...rest, headingPath: meta?.headingPath ?? [], pageBasis: meta?.pageBasis ?? null };
  }

  /** 定版时登记的片段元数据，回读时与密封快照切出的正文合并。 */
  citationSectionMeta(taskId: string, citationId: string): Omit<KnowledgeSection, "text"> | null {
    const rows = this.db.prepare(
      `SELECT ${this.citationColumns()} FROM material_citations WHERE task_id = ? AND id = ?`,
    ).all(taskId, citationId) as Array<{ sectionJson: string | null }>;
    const json = rows[0]?.sectionJson;
    return json ? JSON.parse(json) as Omit<KnowledgeSection, "text"> : null;
  }

  getMaterialCitation(taskId: string, citationId: string): MaterialCitation | null {
    if (this.archiveTables && !this.archiveTables.has("material_citations")) return null;
    const row = this.db.prepare(
      `SELECT ${this.citationColumns()} FROM material_citations WHERE task_id = ? AND id = ?`,
    ).get(taskId, citationId) as (Omit<MaterialCitation, "headingPath" | "pageBasis"> & { sectionJson: string | null }) | undefined;
    return row ? this.mapCitation(row) : null;
  }

  listMaterialCitations(taskId: string): MaterialCitation[] {
    if (this.archiveTables && !this.archiveTables.has("material_citations")) return [];
    return (this.db.prepare(
      `SELECT ${this.citationColumns()} FROM material_citations WHERE task_id = ? ORDER BY rowid`,
    ).all(taskId) as Array<Omit<MaterialCitation, "headingPath" | "pageBasis"> & { sectionJson: string | null }>)
      .map((row) => this.mapCitation(row));
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

  /**
   * P6-E1: record a finding lead. Always starts `tentative`; dedupKey is
   * idempotent (same key → existing row, no duplicate). Never deletes rows.
   */
  recordFinding(input: {
    taskId: string;
    title: string;
    asset: string;
    vulnClass: string;
    severity: FindingSeverity;
    confidence?: FindingConfidence;
    cvss?: string | null;
    endpoint?: string | null;
    dedupKey?: string;
    intentId?: string | null;
    factIds?: string[];
    repro?: string;
    impact?: string;
    fix?: string;
  }): { finding: Finding; created: boolean } {
    const title = input.title.trim();
    const vulnClass = input.vulnClass.trim();
    if (!title) throw new Error("finding title required");
    if (!vulnClass) throw new Error("finding vulnClass required (CWE-* / AUTHZ-* …)");
    const asset =
      normalizeTargetPattern(input.asset) || input.asset.trim().toLowerCase();
    if (!asset) throw new Error("finding asset required");
    const endpoint = input.endpoint?.trim() || null;
    const dedupKey =
      input.dedupKey?.trim() ||
      findingDedupKey({ asset, vulnClass, endpoint });

    const existing = this.findFindingByDedupKey(input.taskId, dedupKey);
    if (existing) return { finding: existing, created: false };

    const factIds = [...new Set((input.factIds ?? []).map((s) => s.trim()).filter(Boolean))];
    for (const id of factIds) {
      if (!this.getFact(input.taskId, id)) {
        throw new Error(`unknown finding source fact: ${id}`);
      }
    }
    if (input.intentId && !this.getIntent(input.taskId, input.intentId)) {
      throw new Error(`unknown finding intent: ${input.intentId}`);
    }

    const finding: Finding = {
      id: randomUUID(),
      taskId: input.taskId,
      title,
      asset,
      vulnClass,
      severity: input.severity,
      cvss: input.cvss?.trim() || null,
      confidence: input.confidence ?? "tentative",
      status: "tentative",
      endpoint,
      dedupKey,
      intentId: input.intentId ?? null,
      factIds,
      evidence: [],
      repro: input.repro ?? "",
      impact: input.impact ?? "",
      fix: input.fix ?? "",
      createdAt: this.now(),
      verifiedAt: null,
    };
    this.db
      .prepare(
        `INSERT INTO findings
          (id, task_id, title, asset, vuln_class, severity, cvss, confidence, status,
           endpoint, dedup_key, intent_id, fact_ids_json, evidence_json, repro, impact, fix,
           created_at, verified_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        finding.id, finding.taskId, finding.title, finding.asset, finding.vulnClass,
        finding.severity, finding.cvss, finding.confidence, finding.status,
        finding.endpoint, finding.dedupKey, finding.intentId,
        JSON.stringify(finding.factIds), JSON.stringify(finding.evidence),
        finding.repro, finding.impact, finding.fix, finding.createdAt, finding.verifiedAt,
      );
    this.emit(input.taskId, "finding_recorded", {
      findingId: finding.id,
      dedupKey,
      severity: finding.severity,
      asset: finding.asset,
      vulnClass: finding.vulnClass,
    });
    return { finding, created: true };
  }

  /**
   * P6-E1 hard gate: verified requires ≥1 sealed evidence file under evidence/
   * plus a non-empty repro. tentative → verified only; repeat calls idempotent.
   */
  verifyFinding(
    taskId: string,
    findingId: string,
    input: {
      evidencePaths: string[];
      repro: string;
      impact?: string;
      fix?: string;
      cvss?: string | null;
    },
  ): Finding {
    const finding = this.getFinding(taskId, findingId);
    if (!finding) throw new Error(`unknown finding: ${findingId}`);
    if (finding.status === "retracted") {
      throw new Error("finding retracted: 误报撤回后不可再验证（另录新 finding）");
    }
    if (finding.status !== "tentative") return finding;

    const repro = input.repro.trim();
    if (!repro) throw new Error("finding_verify requires repro (可复现步骤)");
    const paths = [...new Set(input.evidencePaths.map((p) => p.trim()).filter(Boolean))];
    if (!paths.length) {
      throw new Error("finding_verify requires ≥1 evidence file under evidence/");
    }
    const files = paths.map((p) => {
      try {
        return captureEvidence(this.evidenceDir, p);
      } catch {
        throw new Error(`missing or invalid evidence file: ${p}`);
      }
    });

    this.db.exec("BEGIN IMMEDIATE");
    try {
      const evidence = [...finding.evidence];
      for (const file of files) {
        this.saveVersion(file);
        this.db
          .prepare("INSERT INTO finding_proofs VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING")
          .run(taskId, findingId, file.path, file.sha256);
        if (!evidence.some((e) => e.path === file.path)) {
          evidence.push({ path: file.path, sha256: file.sha256 });
        }
      }
      const now = this.now();
      this.db
        .prepare(
          `UPDATE findings
           SET status = 'verified', confidence = 'firm', evidence_json = ?,
               repro = ?, impact = ?, fix = ?, cvss = ?, verified_at = ?
           WHERE task_id = ? AND id = ? AND status = 'tentative'`,
        )
        .run(
          JSON.stringify(evidence),
          repro,
          input.impact?.trim() || finding.impact,
          input.fix?.trim() || finding.fix,
          input.cvss?.trim() || finding.cvss,
          now,
          taskId,
          findingId,
        );
      this.emit(taskId, "finding_verified", {
        findingId,
        evidencePaths: files.map((f) => f.path),
        sha256: files.map((f) => f.sha256),
      });
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
    return this.getFinding(taskId, findingId)!;
  }

  /**
   * Stage 5 — remediation retest: technical result of a fix round, sealed with
   * its own evidence. Keeps every round (multi-round retests), never overwrites
   * the original verification.
   */
  retestFinding(
    taskId: string,
    findingId: string,
    input: {
      result: "fixed" | "still-present" | "partially-fixed";
      evidencePaths: string[];
      repro: string;
      note?: string;
    },
  ): { finding: Finding; action: FindingAction } {
    const finding = this.getFinding(taskId, findingId);
    if (!finding) throw new Error(`unknown finding: ${findingId}`);
    if (finding.status === "retracted") throw new Error("retracted finding cannot be retested");
    if (finding.status === "tentative") throw new Error("finding must be verified before a remediation retest");
    const paths = [...new Set(input.evidencePaths.map((p) => p.trim()).filter(Boolean))];
    if (!paths.length) throw new Error("finding retest requires ≥1 evidence file under evidence/");
    if (!input.repro.trim()) throw new Error("finding retest requires repro/复测步骤");
    const files = paths.map((p) => {
      try { return captureEvidence(this.evidenceDir, p); }
      catch { throw new Error(`missing or invalid evidence file: ${p}`); }
    });
    const action: FindingAction = {
      id: randomUUID(),
      taskId,
      findingId,
      action: "retest",
      result: input.result,
      note: (input.note ?? input.repro).trim(),
      path: files[0]!.path,
      sha256: files[0]!.sha256,
      createdAt: this.now(),
    };
    this.db.exec("BEGIN IMMEDIATE");
    try {
      for (const file of files) this.saveVersion(file);
      this.db.prepare(
        `INSERT INTO finding_actions (id, task_id, finding_id, action, result, note, path, sha256, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(action.id, taskId, findingId, action.action, action.result, action.note, action.path, action.sha256, action.createdAt);
      this.db.prepare(`UPDATE findings SET status = 'retested' WHERE task_id = ? AND id = ? AND status IN ('verified','retested','accepted')`)
        .run(taskId, findingId);
      this.emit(taskId, "finding_retested", {
        findingId,
        result: input.result,
        evidencePaths: files.map((f) => f.path),
        sha256: files.map((f) => f.sha256),
        repro: input.repro.trim(),
      });
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
    return { finding: this.getFinding(taskId, findingId)!, action };
  }

  /** Stage 5 — client risk decision; requires a sealed decision document. */
  acceptFinding(
    taskId: string,
    findingId: string,
    input: { note: string; evidencePath: string },
  ): { finding: Finding; action: FindingAction } {
    const finding = this.getFinding(taskId, findingId);
    if (!finding) throw new Error(`unknown finding: ${findingId}`);
    if (!["verified", "retested"].includes(finding.status)) {
      throw new Error("仅已验证或已复测的发现可登记客户风险处置");
    }
    if (!input.note.trim()) throw new Error("client risk decision requires a note");
    const file = captureEvidence(this.evidenceDir, input.evidencePath);
    const action: FindingAction = {
      id: randomUUID(),
      taskId,
      findingId,
      action: "accept",
      result: "accepted",
      note: input.note.trim(),
      path: file.path,
      sha256: file.sha256,
      createdAt: this.now(),
    };
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.saveVersion(file);
      this.db.prepare(
        `INSERT INTO finding_actions (id, task_id, finding_id, action, result, note, path, sha256, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(action.id, taskId, findingId, action.action, action.result, action.note, action.path, action.sha256, action.createdAt);
      this.db.prepare(`UPDATE findings SET status = 'accepted' WHERE task_id = ? AND id = ?`).run(taskId, findingId);
      this.emit(taskId, "finding_accepted", { findingId, note: action.note, path: file.path, sha256: file.sha256 });
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
    return { finding: this.getFinding(taskId, findingId)!, action };
  }

  listFindingActions(taskId: string): FindingAction[] {
    if (this.archiveTables && !this.archiveTables.has("finding_actions")) return [];
    return this.db.prepare(
      `SELECT id, task_id AS taskId, finding_id AS findingId, action, result, note,
              path, sha256, created_at AS createdAt
       FROM finding_actions WHERE task_id = ? ORDER BY created_at, rowid`,
    ).all(taskId) as FindingAction[];
  }

  /** Retract a false positive; row retained (append-only semantics). */
  retractFinding(taskId: string, findingId: string, reason: string): Finding {
    const finding = this.getFinding(taskId, findingId);
    if (!finding) throw new Error(`unknown finding: ${findingId}`);
    const note = reason.trim();
    if (!note) throw new Error("finding_retract requires reason");
    if (!findingStatusAllows(finding.status, "retracted")) {
      throw new Error(`finding already retracted: ${findingId}`);
    }
    this.db
      .prepare(`UPDATE findings SET status = 'retracted' WHERE task_id = ? AND id = ?`)
      .run(taskId, findingId);
    this.emit(taskId, "finding_retracted", { findingId, reason: note });
    return this.getFinding(taskId, findingId)!;
  }

  getFinding(taskId: string, findingId: string): Finding | null {
    if (this.archiveTables && !this.archiveTables.has("findings")) return null;
    const r = this.db
      .prepare(`SELECT * FROM findings WHERE task_id = ? AND id = ?`)
      .get(taskId, findingId) as Record<string, unknown> | undefined;
    return r ? this.rowToFinding(r) : null;
  }

  private findFindingByDedupKey(taskId: string, dedupKey: string): Finding | null {
    if (this.archiveTables && !this.archiveTables.has("findings")) return null;
    const r = this.db
      .prepare(`SELECT * FROM findings WHERE task_id = ? AND dedup_key = ?`)
      .get(taskId, dedupKey) as Record<string, unknown> | undefined;
    return r ? this.rowToFinding(r) : null;
  }

  /** All rows incl. retracted (保留可查); severity desc, then write time. */
  listFindings(taskId: string): Finding[] {
    if (this.archiveTables && !this.archiveTables.has("findings")) return [];
    const rows = this.db
      .prepare(`SELECT * FROM findings WHERE task_id = ? ORDER BY created_at ASC, rowid ASC`)
      .all(taskId) as Array<Record<string, unknown>>;
    return rows
      .map((r) => this.rowToFinding(r))
      .sort(
        (a, b) =>
          FINDING_SEVERITY_RANK[b.severity] - FINDING_SEVERITY_RANK[a.severity] ||
          a.createdAt.localeCompare(b.createdAt),
      );
  }

  listFindingProofs(taskId: string): GoalProof[] {
    if (this.archiveTables && !this.archiveTables.has("finding_proofs")) return [];
    return this.db
      .prepare("SELECT finding_id AS goalId, path, sha256 FROM finding_proofs WHERE task_id = ? ORDER BY finding_id, path")
      .all(taskId) as GoalProof[];
  }

  private rowToFinding(r: Record<string, unknown>): Finding {
    return {
      id: String(r.id),
      taskId: String(r.task_id),
      title: String(r.title),
      asset: String(r.asset),
      vulnClass: String(r.vuln_class),
      severity: r.severity as FindingSeverity,
      cvss: (r.cvss as string | null) ?? null,
      confidence: r.confidence as FindingConfidence,
      status: r.status as FindingStatus,
      endpoint: (r.endpoint as string | null) ?? null,
      dedupKey: String(r.dedup_key),
      intentId: (r.intent_id as string | null) ?? null,
      factIds: JSON.parse(String(r.fact_ids_json ?? "[]")) as string[],
      evidence: JSON.parse(String(r.evidence_json ?? "[]")) as Finding["evidence"],
      repro: String(r.repro ?? ""),
      impact: String(r.impact ?? ""),
      fix: String(r.fix ?? ""),
      createdAt: String(r.created_at),
      verifiedAt: (r.verified_at as string | null) ?? null,
    };
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

  /** Resource provisioning audit: scale-up only, decided from asset counts (non-tactical). */
  recordExploreScaled(
    taskId: string,
    input: { from: number; to: number; assetCount: number },
  ): void {
    this.emit(taskId, "explore_scaled", { ...input });
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
    const findings = this.listFindings(taskId).filter((f) => f.status !== "retracted");
    lines.push("", `## Findings 台账（${findings.length}）`);
    if (findings.length === 0) {
      lines.push("- （无；发现线索即 finding_record，复现后 finding_verify 才可进交付）");
    } else {
      for (const f of findings.slice(-30)) {
        lines.push(
          `- [${f.id}] (${f.status}/${f.severity}) ${f.title} · ${f.asset}${f.endpoint ? ` · ${f.endpoint}` : ""} · ${f.vulnClass}`,
        );
      }
      lines.push("（tentative 不得写进交付叙述；verified 须附证据与 repro；同 dedupKey 幂等。）");
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

export { CommandLedger, hasCommandLedger, localProbes, type CommandOutcome, type CommandProposal, type CommandTicket } from "./command-reviews.js";

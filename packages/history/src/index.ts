/**
 * Core Fact–Intent–Goal DAG & Evidence Gate (`HistoryStore`).
 *
 * Domain sub-stores (sharing the same SQLite connection & ACID transactions):
 * - `schema.ts`: DDL & additive migrations
 * - `surface-store.ts`: Assets, HTTP transactions, Host profiles, OAST, Credentials, Plan
 * - `finding-store.ts`: Findings, Proofs, Independent Validations, Retests, Actions
 * - `review-store.ts`: Reconcile archives, Delivery corrections, Reviews, Citations
 * - `observe-view.ts`: Read-only Observe & Engagement Audit rendering
 */
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname, relative } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type {
  AssetKind,
  AssetRecord,
  AssetSource,
  AssetType,
  AttackEdge,
  AttackGraph,
  AttackNode,
  AttackPath,
  AuthScope,
  BusinessReconcileConfig,
  CoverageReview,
  CoverageReviewInput,
  CreateFactReview,
  Credential,
  CredentialKind,
  CredentialTier,
  EngagementAudit,
  Fact,
  FactLayer,
  Finding,
  FindingConfidence,
  FindingQualification,
  FindingRetest,
  FindingSeverity,
  FindingValidation,
  FindingValidationDraft,
  FindingsGate,
  GoalState,
  Hint,
  HintSource,
  HistoryEvent,
  HistoryEventKind,
  HostProfile,
  HostProfileDraftInput,
  HttpTransaction,
  Intent,
  IntentStatus,
  KnowledgeSection,
  MaterialCitation,
  MaterialCitationInput,
  OastHit,
  OastToken,
  PeerReview,
  PeerReviewInput,
  PlanStep,
  PlanStepDraftInput,
  ReconcileGate,
  ReconcileRequest,
  ReconcileResult,
  ReconcileRevision,
  RetestRequest,
  RetestRequestInput,
  RetestVerdict,
} from "@gongyuai/contracts";
import {
  ASSET_TAG,
  ORIGIN_FACT_ID,
  TRANSFERABLE_TAG,
  assetGroupKey,
  assetRootKey,
  attackEdgeTags,
  attackNodeTags,
  buildAttackGraph,
  familyTag,
  findAttackPaths,
  findingAssetInScope,
  findingSatisfiesGate,
  matchTarget,
  normalizeFamilyKey,
  normalizeHost,
  parseAssetAddrFromTags,
  parseAssetKindFromTags,
  reconcileConfigDigest,
  resolveGateAssets,
  suggestFamilyKey,
} from "@gongyuai/contracts";
import type {
  DeliveryCorrection,
  FactReview,
  FindingAction,
  GoalFindingSupport,
  GoalProof,
  HistoryDomainDeps,
  MaterialCitationSeal,
} from "./context.js";
import { buildDagExport, type DagExport } from "./dag.js";
import { FindingLedgerStore } from "./finding-store.js";
import {
  collectGoalEvidence,
  describeReconcileState,
  selectAdoptedReconcile,
  verifyRevisionInputs,
  type ArchivedReconcile,
  type EvidenceSnapshot,
  type ReconcileStateReport,
} from "./goal-evidence.js";
import { readIntegrationUsage, trackIntegrationCalls } from "./integration-usage.js";
import {
  deriveHistoryEngagementAudit,
  renderHistoryObserve,
  renderHistoryOverview,
} from "./observe-view.js";
import { TaskOperations } from "./ops.js";
import { DeliveryReviewStore } from "./review-store.js";
import { eventHash, migrateHistorySchema } from "./schema.js";
import {
  computeScorecard,
  finalizeSnapshot,
  type DeliverySnapshot,
  type Scorecard,
  type SnapshotCoverage,
  type SnapshotFinding,
  type SnapshotGoal,
} from "./scorecard.js";
import { SurfaceIntelStore } from "./surface-store.js";

export type {
  DeliveryCorrection,
  FactReview,
  FindingAction,
  GoalFindingSupport,
  GoalProof,
  MaterialCitationSeal,
} from "./context.js";
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
  readonly ops: TaskOperations;
  private readonly db: DatabaseSync;
  private readonly archiveTables?: Set<string>;
  private readonly activeIntentBindings = new Map<string, string>();
  private readonly surface: SurfaceIntelStore;
  private readonly findingsStore: FindingLedgerStore;
  private readonly reviewsStore: DeliveryReviewStore;

  constructor(opts: OpenHistoryOptions) {
    this.dbPath = opts.dbPath;
    this.evidenceDir = opts.evidenceDir;
    if (opts.readOnly) {
      this.db = new DatabaseSync(opts.dbPath, { readOnly: true });
      try {
        this.db.exec("PRAGMA busy_timeout = 10000;");
        this.archiveTables = new Set(
          this.db
            .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
            .all()
            .map((row) => String(row.name)),
        );
      } catch (err) {
        this.db.close();
        throw err;
      }
      this.ops = new TaskOperations(this.db, { readOnly: true });
    } else {
      mkdirSync(dirname(opts.dbPath), { recursive: true });
      mkdirSync(opts.evidenceDir, { recursive: true });
      this.db = new DatabaseSync(opts.dbPath);
      this.db.exec("PRAGMA busy_timeout = 10000;");
      this.db.exec("PRAGMA journal_mode = WAL;");
      this.db.exec("PRAGMA foreign_keys = ON;");
      migrateHistorySchema(this.db);
      this.ops = new TaskOperations(this.db);
    }

    const domainDeps: HistoryDomainDeps = {
      db: this.db,
      evidenceDir: this.evidenceDir,
      archiveTables: this.archiveTables,
      now: () => this.now(),
      emit: (taskId, kind, payload) => this.emit(taskId, kind, payload),
      saveVersion: (file) => this.saveVersion(file),
      resolveIntentIdForWrite: (taskId, intentId) => this.resolveIntentIdForWrite(taskId, intentId),
      appendFact: (input) => this.appendFact(input),
      getFact: (taskId, factId) => this.getFact(taskId, factId),
      listFacts: (taskId, layer) => this.listFacts(taskId, layer),
      getIntent: (taskId, intentId) => this.getIntent(taskId, intentId),
      listIntents: (taskId, status) => this.listIntents(taskId, status),
      listGoals: (taskId) => this.listGoals(taskId),
      listGoalProofs: (taskId) => this.listGoalProofs(taskId),
      listGoalFindings: (taskId) => this.listGoalFindings(taskId),
      getFinding: (taskId, findingId) => this.getFinding(taskId, findingId),
      listFindings: (taskId) => this.listFindings(taskId),
      hasConfirmedValidation: (taskId, findingId) => this.hasConfirmedValidation(taskId, findingId),
      resolveEvidenceRef: (taskId, ref) => this.resolveEvidenceRef(taskId, ref),
    };
    this.surface = new SurfaceIntelStore(domainDeps);
    this.findingsStore = new FindingLedgerStore(domainDeps);
    this.reviewsStore = new DeliveryReviewStore(domainDeps);
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

  private now(): string {
    return new Date().toISOString();
  }

  private saveVersion(file: EvidenceSnapshot): void {
    this.db
      .prepare("INSERT INTO evidence_versions(sha256, content) VALUES (?, ?) ON CONFLICT DO NOTHING")
      .run(file.sha256, file.content);
  }

  private emit(
    taskId: string,
    kind: HistoryEventKind,
    payload: Record<string, unknown> = {},
  ): HistoryEvent {
    const ownTx = !this.db.isTransaction;
    if (ownTx) this.db.exec("BEGIN IMMEDIATE");
    try {
      const previous = this.db
        .prepare("SELECT hash FROM events WHERE task_id = ? ORDER BY rowid DESC LIMIT 1")
        .get(taskId) as { hash?: string | null } | undefined;
      const prevHash = previous?.hash ?? null;
      const payloadJson = JSON.stringify(payload);
      const event: HistoryEvent = {
        id: randomUUID(),
        taskId,
        kind,
        payload,
        createdAt: this.now(),
      };
      const hash = eventHash(prevHash, {
        id: event.id,
        taskId,
        kind,
        payloadJson,
        createdAt: event.createdAt,
      });
      this.db
        .prepare(
          `INSERT INTO events (id, task_id, kind, payload_json, created_at, prev_hash, hash)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(event.id, taskId, kind, payloadJson, event.createdAt, prevHash, hash);
      if (ownTx) this.db.exec("COMMIT");
      return { ...event, prevHash, hash };
    } catch (err) {
      if (ownTx) this.db.exec("ROLLBACK");
      throw err;
    }
  }

  recordEvent(
    taskId: string,
    kind: HistoryEventKind,
    payload: Record<string, unknown> = {},
  ): HistoryEvent {
    return this.emit(taskId, kind, payload);
  }

  /* ====================================================================== *
   * 1. Core DAG: Goals, Facts, Intents, Leases & Evidence Gate
   * ====================================================================== */

  seedGoals(taskId: string, goals: GoalState[]): void {
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
          g.kind ?? "file",
          g.business ? JSON.stringify(g.business) : null,
        );
        if (inserted.changes && g.evidenceChecks?.length) {
          this.db
            .prepare("INSERT INTO goal_checks VALUES (?, ?, ?)")
            .run(taskId, g.id, JSON.stringify(g.evidenceChecks));
        }
      }
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  listGoals(taskId: string): GoalState[] {
    const query =
      this.archiveTables && !this.archiveTables.has("goal_checks")
        ? "SELECT *, NULL AS checks_json FROM goals WHERE task_id = ? ORDER BY id"
        : "SELECT g.*, c.checks_json FROM goals g LEFT JOIN goal_checks c ON c.goal_id = g.id AND c.task_id = g.task_id WHERE g.task_id = ? ORDER BY g.id";
    const rows = this.db.prepare(query).all(taskId) as Array<Record<string, unknown>>;
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

  allGoalsPass(taskId: string): boolean {
    const goals = this.listGoals(taskId);
    return goals.length > 0 && goals.every((g) => g.passes);
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
      intentId: this.resolveIntentIdForWrite(input.taskId, input.intentId),
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
          .prepare(`SELECT * FROM facts WHERE task_id = ? AND layer = ? ORDER BY created_at ASC`)
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
    return r ? this.rowToFact(r) : null;
  }

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
    if (!fact) return { fact: null, before: [], after: [] };
    const win = Math.max(0, Math.min(8, Math.floor(window)));
    if (!fact.intentId) return { fact, before: [], after: [] };
    const chain = this.db
      .prepare(
        `SELECT * FROM facts WHERE task_id = ? AND intent_id = ? ORDER BY created_at ASC, rowid ASC`,
      )
      .all(taskId, fact.intentId) as Array<Record<string, unknown>>;
    const facts = chain.map((r) => this.rowToFact(r));
    const idx = facts.findIndex((f) => f.id === factId);
    if (idx < 0) return { fact, before: [], after: [] };
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

  formatFactDrill(taskId: string, factId: string, window = 2): Record<string, unknown> {
    const { fact, before, after } = this.getFactNeighborhood(taskId, factId, window);
    if (!fact) return { ok: false, reason: `unknown fact: ${factId}` };
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
      if (!row) throw new Error(`unknown source fact: ${id}`);
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
    rejectOosOnly?: boolean;
    fanout?: FanoutPolicy;
    planStepId?: string | null;
  }): Intent {
    const sourceFactIds = this.validateSourceFactIds(input.taskId, input.sourceFactIds);
    if (input.rejectOosOnly !== false) {
      this.assertNotOosOnlyExploit(input.taskId, sourceFactIds);
    }
    const normalizedAssetRoot = input.assetRoot ? normalizeHost(input.assetRoot) : null;
    if (input.fanout) {
      this.assertFanoutAllows(input.taskId, sourceFactIds, input.fanout, {
        assetRoot: normalizedAssetRoot,
        technique: input.technique,
      });
    }
    const untouchedAssetRoot = Boolean(
      normalizedAssetRoot &&
        !this.listIntents(input.taskId).some((existing) => existing.assetRoot === normalizedAssetRoot),
    );
    this.surface.assertPlanAllows(input.taskId, input.planStepId, {
      sourceFactIds,
      untouchedAssetRoot,
    });
    const now = this.now();
    const intent: Intent = {
      id: randomUUID(),
      taskId: input.taskId,
      title: input.title,
      summary: input.summary ?? "",
      status: "proposed",
      sourceFactIds,
      technique: input.technique?.trim() ? input.technique.trim() : null,
      assetRoot: normalizedAssetRoot,
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
    if (input.planStepId) {
      this.surface.markPlanStepDispatched(input.taskId, input.planStepId, intent.id);
    }
    this.emit(input.taskId, "intent_proposed", {
      intentId: intent.id,
      title: intent.title,
      sourceFactIds: intent.sourceFactIds,
    });
    return intent;
  }

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

  groundedAssetRoot(
    taskId: string,
    assetRoot: string,
    sourceFactIds: readonly string[],
  ):
    | { ok: true; address: string; matchedBy: "source-fact" | "inventory" }
    | { ok: false; reason: string } {
    const raw = assetRoot.trim();
    if (!raw) return { ok: false, reason: "asset_root 不能为空" };
    if (raw === "*" || raw.includes("*")) {
      return { ok: false, reason: "asset_root 必须是具体主机/资产地址，不接受通配 *" };
    }
    if (raw.includes("/") && !raw.includes("://")) {
      return { ok: false, reason: "asset_root 只接受主机/资产地址（CIDR/路径请写具体主机）" };
    }
    const address = normalizeHost(raw);
    if (!address) return { ok: false, reason: `asset_root 不是可解析的主机/资产地址：${raw}` };

    for (const id of sourceFactIds) {
      if (id === ORIGIN_FACT_ID) continue;
      const fact = this.getFact(taskId, id);
      if (!fact) continue;
      const addr = parseAssetAddrFromTags(fact.tags);
      if (!addr) continue;
      const host = normalizeHost(addr);
      const parentGrounded =
        address.split(".").filter(Boolean).length >= 2 &&
        host.length > address.length &&
        host.endsWith(`.${address}`);
      const grounded =
        host === address || parentGrounded || matchTarget([addr, host], address).ok;
      if (grounded) return { ok: true, address, matchedBy: "source-fact" };
    }

    const inventory = this.listAssets(taskId).filter(
      (asset) => normalizeHost(asset.address) === address,
    );
    if (inventory.some((asset) => asset.kind !== "oos")) {
      return { ok: true, address, matchedBy: "inventory" };
    }
    if (inventory.length > 0) {
      return { ok: false, reason: `asset_root 指向范围外资产（oos）：${address}` };
    }
    return {
      ok: false,
      reason:
        `asset_root 未被前驱 Fact 或资产清单确认：${address}；` +
        "先 asset_record 落资产，或把该资产 Fact 列入 sourceFactIds",
    };
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
    opts?: { assetRoot?: string | null; technique?: string | null },
  ): void {
    const open = this.openIntents(taskId);
    if (open.length >= policy.maxIntentsPerReason) {
      throw new Error(
        `fanout cap: open Intents=${open.length} ≥ maxIntentsPerReason=${policy.maxIntentsPerReason}`,
      );
    }
    const addr = opts?.assetRoot || this.primaryAssetAddress(taskId, sourceFactIds);
    if (!addr) return;
    const root = assetRootKey(addr);
    if (!root) return;
    const normTech = opts?.technique?.trim().toLowerCase() || null;
    let sameRoot = 0;
    for (const intent of open) {
      const peer = intent.assetRoot || this.primaryAssetAddress(taskId, intent.sourceFactIds);
      if (peer && assetRootKey(peer) === root) {
        sameRoot += 1;
        if (normTech && intent.technique?.trim().toLowerCase() === normTech) {
          throw new Error(
            `fanout cap: duplicate open technique "${opts?.technique?.trim()}" on host=${root}`,
          );
        }
      }
    }
    if (sameRoot >= policy.maxIntentsPerAssetRoot) {
      throw new Error(
        `fanout cap: root=${root} open=${sameRoot} ≥ maxIntentsPerAssetRoot=${policy.maxIntentsPerAssetRoot}`,
      );
    }
  }

  tryAcquireReasonLease(
    taskId: string,
    owner: string,
    ttlMs: number,
  ): { ok: true; until: string } | { ok: false; owner: string; until: string } {
    if (ttlMs <= 0) {
      return { ok: true, until: this.now() };
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

  getReasonLease(taskId: string): { owner: string; until: string } | null {
    const row = this.db
      .prepare(`SELECT owner, until_iso FROM leases WHERE task_id = ? AND kind = 'reason'`)
      .get(taskId) as { owner: string; until_iso: string } | undefined;
    return row ? { owner: row.owner, until: row.until_iso } : null;
  }

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
        system: true,
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

  bindActiveIntent(taskId: string, intentId: string | null): void {
    if (!intentId) {
      this.activeIntentBindings.delete(taskId);
      return;
    }
    if (!this.getIntent(taskId, intentId)) {
      throw new Error(`unknown active intent: ${intentId}`);
    }
    this.activeIntentBindings.set(taskId, intentId);
  }

  resolveActiveIntentId(taskId: string): string | null {
    const bound = this.activeIntentBindings.get(taskId);
    if (!bound) return null;
    const intent = this.getIntent(taskId, bound);
    if (!intent || !["claimed", "running"].includes(intent.status)) {
      this.activeIntentBindings.delete(taskId);
      return null;
    }
    return bound;
  }

  private resolveIntentIdForWrite(taskId: string, intentId?: string | null): string | null {
    return intentId === undefined ? this.resolveActiveIntentId(taskId) : intentId;
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
    this.bindActiveIntent(taskId, intentId);
    this.emit(taskId, "intent_claimed", { intentId, workerId });
    return this.getIntent(taskId, intentId);
  }

  concludeIntent(
    taskId: string,
    intentId: string,
    status: Extract<IntentStatus, "succeeded" | "failed">,
    conclusion: string,
    opts?: { facts?: ConcludeFactInput[]; workerId?: string; system?: boolean },
  ): Intent | null {
    const facts = opts?.facts ?? [];
    if (!opts?.system) {
      if (!opts?.workerId) throw new Error("conclude requires workerId (or system timeout)");
      const current = this.getIntent(taskId, intentId);
      if (!current) return null;
      if (current.claimedBy !== opts.workerId) {
        throw new Error(
          `conclude denied: Intent claimed by ${current.claimedBy ?? "nobody"}, not ${opts.workerId}`,
        );
      }
    }
    if (status === "succeeded" && facts.length === 0) {
      throw new Error("conclude(succeeded) requires ≥1 Fact with intentId (Explore writeback)");
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
    if (this.activeIntentBindings.get(taskId) === intentId) {
      this.activeIntentBindings.delete(taskId);
    }
    return this.getIntent(taskId, intentId);
  }

  getIntent(taskId: string, intentId: string): Intent | null {
    const r = this.db
      .prepare(`SELECT * FROM intents WHERE task_id = ? AND id = ?`)
      .get(taskId, intentId) as Record<string, unknown> | undefined;
    return r ? this.rowToIntent(r) : null;
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

  heartbeatIntent(taskId: string, intentId: string, workerId: string): boolean {
    const result = this.db
      .prepare(
        `UPDATE intents
         SET updated_at = ?
         WHERE id = ? AND task_id = ? AND claimed_by = ? AND status IN ('claimed', 'running')`,
      )
      .run(this.now(), intentId, taskId, workerId);
    if ((result.changes ?? 0) === 0) return false;
    this.bindActiveIntent(taskId, intentId);
    return true;
  }

  expireStaleIntents(
    taskId: string,
    maxAgeMs: number,
    opts?: { requeue?: boolean; maxRequeues?: number },
  ): Intent[] {
    const now = Date.now();
    const maxRequeues = Math.max(0, opts?.maxRequeues ?? 2);
    const rows = this.db
      .prepare(
        `SELECT * FROM intents
         WHERE task_id = ? AND status IN ('claimed', 'running')
         ORDER BY created_at`,
      )
      .all(taskId) as Array<Record<string, unknown>>;
    const swept: Intent[] = [];
    for (const raw of rows) {
      const intent = this.rowToIntent(raw);
      const updated = Date.parse(intent.updatedAt);
      if (!Number.isFinite(updated) || now - updated < maxAgeMs) continue;
      const requeueCount = Number(raw.requeue_count ?? 0);
      const canRequeue = Boolean(opts?.requeue) && requeueCount < maxRequeues;
      if (canRequeue) {
        const result = this.db
          .prepare(
            `UPDATE intents
             SET status = 'proposed', claimed_by = NULL, requeue_count = requeue_count + 1, updated_at = ?
             WHERE id = ? AND task_id = ? AND status IN ('claimed', 'running')`,
          )
          .run(this.now(), intent.id, taskId);
        if ((result.changes ?? 0) > 0) {
          this.emit(taskId, "intent_expired", {
            intentId: intent.id,
            requeued: true,
            requeueCount: requeueCount + 1,
          });
          if (this.activeIntentBindings.get(taskId) === intent.id) {
            this.activeIntentBindings.delete(taskId);
          }
          const row = this.getIntent(taskId, intent.id);
          if (row) swept.push(row);
        }
      } else {
        const result = this.db
          .prepare(
            `UPDATE intents
             SET status = 'expired', updated_at = ?
             WHERE id = ? AND task_id = ? AND status IN ('claimed', 'running')`,
          )
          .run(this.now(), intent.id, taskId);
        if ((result.changes ?? 0) > 0) {
          this.emit(taskId, "intent_expired", {
            intentId: intent.id,
            requeued: false,
            requeueCount,
          });
          if (this.activeIntentBindings.get(taskId) === intent.id) {
            this.activeIntentBindings.delete(taskId);
          }
          const row = this.getIntent(taskId, intent.id);
          if (row) swept.push(row);
        }
      }
    }
    return swept;
  }

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
    hooks?: { beforeCommit?: () => void },
  ): { ok: true; goal: GoalState } | { ok: false; reason: string } {
    const goals = this.listGoals(taskId);
    const goal = goals.find((g) => g.id === goalId);
    if (!goal) return { ok: false, reason: `unknown goal: ${goalId}` };
    if (goal.passes) return { ok: true, goal };

    let files: EvidenceSnapshot[];
    try {
      files = collectGoalEvidence(this.evidenceDir, goal, evidencePaths, {
        deferPatternsToReconcileGate: Boolean(goal.reconcileGate),
      });
    } catch (err) {
      return { ok: false, reason: err instanceof Error ? err.message : String(err) };
    }

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

    let gateAssets: string[] | null = null;
    if (goal.findingsGate) {
      try {
        gateAssets = resolveGateAssets(goal.findingsGate, goal.assets);
      } catch (err) {
        return { ok: false, reason: err instanceof Error ? err.message : String(err) };
      }
    }

    const normalized = files.map((f) => f.path);

    this.db.exec("BEGIN IMMEDIATE");
    try {
      let supporting: Finding[] = [];
      if (goal.findingsGate) {
        const gate = goal.findingsGate;
        const candidates = this.listFindings(taskId).filter((f) => findingSatisfiesGate(f, gate));
        supporting =
          gateAssets === null
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
        if (gate.requireIndependent) {
          const missing = supporting.filter(
            (finding) => !this.hasConfirmedValidation(taskId, finding.id),
          );
          if (missing.length > 0) {
            this.db.exec("ROLLBACK");
            const reason =
              `findings gate: ${missing.length}/${supporting.length} 条发现缺独立确认` +
              `（${missing.map((finding) => `${finding.id}:${finding.title}`).join("；").slice(0, 500)}）` +
              " — 用另一个 worker 会话或 operator 执行 finding_validate（confirmed）；" +
              "复核者不得与 finding.verifiedBy 相同";
            this.recordGoalRejection(taskId, goalId, reason);
            return { ok: false, reason };
          }
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
          this.db
            .prepare(
              `INSERT INTO goal_findings (task_id, goal_id, finding_id, status_at_assert, evidence_json, created_at)
               VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`,
            )
            .run(taskId, goalId, finding.id, finding.status, JSON.stringify(finding.evidence), stamp);
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
      try {
        this.db.exec("ROLLBACK");
      } catch {
        /* already rolled back */
      }
      throw err;
    }
  }

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
        /* ignore malformed */
      }
    }
    this.emit(taskId, "goal_assert_rejected", { goalId, reason });
  }

  listGoalProofs(taskId: string): GoalProof[] {
    if (this.archiveTables && !this.archiveTables.has("goal_proofs")) return [];
    return this.db
      .prepare(
        "SELECT goal_id AS goalId, path, sha256 FROM goal_proofs WHERE task_id = ? ORDER BY goal_id, path",
      )
      .all(taskId) as GoalProof[];
  }

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
        const r = row as {
          goalId: string;
          findingId: string;
          statusAtAssert: string;
          evidenceJson: string;
          createdAt: string;
        };
        return {
          goalId: r.goalId,
          findingId: r.findingId,
          statusAtAssert: r.statusAtAssert,
          evidence: JSON.parse(r.evidenceJson) as Array<{ path: string; sha256: string }>,
          createdAt: r.createdAt,
        };
      });
  }

  readProofVersion(taskId: string, sha256: string): Buffer | undefined {
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

  /* ====================================================================== *
   * 2. Delegated Attack Surface & Tactical Intelligence (`surface-store.ts`)
   * ====================================================================== */

  seedAssetsFromAuth(taskId: string, auth: Pick<AuthScope, "targets">): Fact[] {
    return this.surface.seedAssetsFromAuth(taskId, auth);
  }
  recordAsset(input: {
    taskId: string;
    address: string;
    auth: Pick<AuthScope, "targets" | "outOfScope" | "pivotPolicy">;
    kind?: AssetKind;
    source?: AssetSource;
    summary?: string;
    intentId?: string | null;
    live?: boolean;
    assetType?: AssetType | null;
    parentAddress?: string | null;
    weight?: number;
  }): { fact: Fact; asset: AssetRecord; created: boolean } {
    return this.surface.recordAsset(input);
  }
  listAssets(taskId: string): AssetRecord[] {
    return this.surface.listAssets(taskId);
  }
  recordHttpTransaction(
    input: Omit<HttpTransaction, "id" | "createdAt"> & { id?: string; createdAt?: string },
  ): { transaction: HttpTransaction; created: boolean } {
    return this.surface.recordHttpTransaction(input);
  }
  listHttpTransactions(taskId: string, limit = 50): HttpTransaction[] {
    return this.surface.listHttpTransactions(taskId, limit);
  }
  getHttpTransaction(taskId: string, id: string): HttpTransaction | null {
    return this.surface.getHttpTransaction(taskId, id);
  }
  resolveEvidenceRef(
    taskId: string,
    ref: string,
  ): { path: string; sha256: string; content: Buffer } | null {
    return this.surface.resolveEvidenceRef(taskId, ref);
  }
  recordHostProfile(taskId: string, draft: HostProfileDraftInput): HostProfile {
    return this.surface.recordHostProfile(taskId, draft);
  }
  getHostProfile(taskId: string, asset: string): HostProfile | null {
    return this.surface.getHostProfile(taskId, asset);
  }
  listHostProfiles(taskId: string): HostProfile[] {
    return this.surface.listHostProfiles(taskId);
  }
  setPlan(taskId: string, drafts: PlanStepDraftInput[]): PlanStep[] {
    return this.surface.setPlan(taskId, drafts);
  }
  listPlan(taskId: string): PlanStep[] {
    return this.surface.listPlan(taskId);
  }
  updatePlanStep(
    taskId: string,
    stepId: string,
    patch: { title?: string; summary?: string },
  ): PlanStep {
    return this.surface.updatePlanStep(taskId, stepId, patch);
  }
  nextPlanStep(taskId: string): PlanStep | null {
    return this.surface.nextPlanStep(taskId);
  }
  recordOastToken(input: {
    token: string;
    taskId: string;
    kind: "http" | "dns";
    callback: string;
    note?: string;
    issuedAt?: string;
    expiresAt: string;
  }): OastToken {
    return this.surface.recordOastToken(input);
  }
  getOastToken(taskId: string, token: string): OastToken | null {
    return this.surface.getOastToken(taskId, token);
  }
  listOastTokens(taskId: string): OastToken[] {
    return this.surface.listOastTokens(taskId);
  }
  recordOastHit(
    taskId: string,
    input: {
      token: string;
      at?: string;
      sourceIp?: string;
      method?: string;
      path?: string;
      userAgent?: string;
      protocol?: "http" | "dns";
    },
  ): OastHit {
    return this.surface.recordOastHit(taskId, input);
  }
  listOastHits(taskId: string, token?: string): OastHit[] {
    return this.surface.listOastHits(taskId, token);
  }
  recordCredential(input: {
    taskId: string;
    kind: CredentialKind;
    asset: string;
    username?: string | null;
    secretRef: string;
    secretHmac?: string | null;
    sourceFindingId?: string | null;
    verified?: boolean;
    expiresAt?: string | null;
    tier?: CredentialTier;
    impactSummary?: string | null;
    intentId?: string | null;
  }): { credential: Credential; created: boolean } {
    return this.surface.recordCredential(input);
  }
  listCredentials(taskId: string): Credential[] {
    return this.surface.listCredentials(taskId);
  }
  getCredential(taskId: string, credentialId: string): Credential | null {
    return this.surface.getCredential(taskId, credentialId);
  }
  touchCredential(taskId: string, credentialId: string): Credential {
    return this.surface.touchCredential(taskId, credentialId);
  }
  updateCredential(
    taskId: string,
    credentialId: string,
    patch: { tier?: CredentialTier; impactSummary?: string | null },
  ): Credential {
    return this.surface.updateCredential(taskId, credentialId, patch);
  }

  /* ====================================================================== *
   * 3. Delegated Finding Ledger & Proof Validation (`finding-store.ts`)
   * ====================================================================== */

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
    summary?: string;
    affectedScope?: string;
    rootCause?: string;
    repro?: string;
    impact?: string;
    fix?: string;
    pocCurl?: string | null;
    report?: string;
    qualification?: FindingQualification | null;
  }): { finding: Finding; created: boolean } {
    return this.findingsStore.recordFinding(input);
  }
  verifyFinding(
    taskId: string,
    findingId: string,
    input: {
      evidencePaths: string[];
      repro: string;
      summary?: string;
      affectedScope?: string;
      rootCause?: string;
      impact?: string;
      fix?: string;
      cvss?: string | null;
      verifiedBy?: string;
      intentId?: string | null;
      pocCurl?: string | null;
      report?: string;
      qualification?: FindingQualification | null;
    },
  ): Finding {
    return this.findingsStore.verifyFinding(taskId, findingId, input);
  }
  updateFindingReport(
    taskId: string,
    findingId: string,
    patch: {
      summary?: string;
      affectedScope?: string;
      rootCause?: string;
      impact?: string;
      fix?: string;
      pocCurl?: string;
      report?: string;
    },
  ): Finding | null {
    return this.findingsStore.updateFindingReport(taskId, findingId, patch);
  }
  updateFindingPocCurl(taskId: string, findingId: string, pocCurl: string): Finding | null {
    return this.findingsStore.updateFindingPocCurl(taskId, findingId, pocCurl);
  }
  recordFindingRetest(
    taskId: string,
    findingId: string,
    input: {
      verdict: RetestVerdict;
      evidencePaths?: string[];
      repro?: string;
      note?: string;
      reviewer: string;
    },
  ): { retest: FindingRetest; finding: Finding } {
    return this.findingsStore.recordFindingRetest(taskId, findingId, input);
  }
  listFindingRetests(taskId: string, findingId?: string): FindingRetest[] {
    return this.findingsStore.listFindingRetests(taskId, findingId);
  }
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
    return this.findingsStore.retestFinding(taskId, findingId, input);
  }
  acceptFinding(
    taskId: string,
    findingId: string,
    input: { note: string; evidencePath: string },
  ): { finding: Finding; action: FindingAction } {
    return this.findingsStore.acceptFinding(taskId, findingId, input);
  }
  listFindingActions(taskId: string): FindingAction[] {
    return this.findingsStore.listFindingActions(taskId);
  }
  retractFinding(taskId: string, findingId: string, reason: string): Finding {
    return this.findingsStore.retractFinding(taskId, findingId, reason);
  }
  linkFindingTraffic(
    taskId: string,
    findingId: string,
    trafficIds: readonly string[],
  ): Finding | null {
    return this.findingsStore.linkFindingTraffic(taskId, findingId, trafficIds);
  }
  recordFindingValidation(
    taskId: string,
    findingId: string,
    input: FindingValidationDraft,
  ): { validation: FindingValidation; finding: Finding } {
    return this.findingsStore.recordFindingValidation(taskId, findingId, input);
  }
  listFindingValidations(taskId: string, findingId?: string): FindingValidation[] {
    return this.findingsStore.listFindingValidations(taskId, findingId);
  }
  hasConfirmedValidation(taskId: string, findingId: string): boolean {
    return this.findingsStore.hasConfirmedValidation(taskId, findingId);
  }
  getFinding(taskId: string, findingId: string): Finding | null {
    return this.findingsStore.getFinding(taskId, findingId);
  }
  listFindings(taskId: string): Finding[] {
    return this.findingsStore.listFindings(taskId);
  }
  listFindingProofs(taskId: string): GoalProof[] {
    return this.findingsStore.listFindingProofs(taskId);
  }

  /* ====================================================================== *
   * 4. Delegated Delivery Assurance & Reviews (`review-store.ts`)
   * ====================================================================== */

  archiveReconcile(input: {
    taskId: string;
    request: ReconcileRequest;
    goalIds?: string[];
  }): {
    revision: ReconcileRevision;
    result: ReconcileResult;
    evidencePath: string;
    evidenceSha256: string;
    factId: string;
  } {
    return this.reviewsStore.archiveReconcile(input);
  }
  listReconcileRevisions(taskId: string): ArchivedReconcile[] {
    return this.reviewsStore.listReconcileRevisions(taskId);
  }
  goalReconcileState(taskId: string, goalId: string): ReconcileStateReport | null {
    return this.reviewsStore.goalReconcileState(taskId, goalId);
  }
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
    return this.reviewsStore.recordDeliveryCorrection(taskId, input);
  }
  listDeliveryCorrections(taskId: string): DeliveryCorrection[] {
    return this.reviewsStore.listDeliveryCorrections(taskId);
  }
  setDeliveryCorrectionNotice(
    taskId: string,
    correctionId: string,
    status: DeliveryCorrection["noticeStatus"],
    evidencePath?: string,
  ): DeliveryCorrection {
    return this.reviewsStore.setDeliveryCorrectionNotice(taskId, correctionId, status, evidencePath);
  }
  listReviews(taskId: string): FactReview[] {
    return this.reviewsStore.listReviews(taskId);
  }
  appendReview(taskId: string, input: CreateFactReview): FactReview {
    return this.reviewsStore.appendReview(taskId, input);
  }
  listCoverage(taskId: string): CoverageReview[] {
    return this.reviewsStore.listCoverage(taskId);
  }
  recordCoverage(taskId: string, input: CoverageReviewInput): CoverageReview {
    return this.reviewsStore.recordCoverage(taskId, input);
  }
  recordRetestRequest(taskId: string, input: RetestRequestInput): RetestRequest {
    return this.reviewsStore.recordRetestRequest(taskId, input);
  }
  listRetestRequests(taskId: string): RetestRequest[] {
    return this.reviewsStore.listRetestRequests(taskId);
  }
  fulfillRetestRequests(taskId: string, findingId: string, result: string): RetestRequest[] {
    return this.reviewsStore.fulfillRetestRequests(taskId, findingId, result);
  }
  recordPeerReview(taskId: string, engagementId: string, input: PeerReviewInput): PeerReview {
    return this.reviewsStore.recordPeerReview(taskId, engagementId, input);
  }
  listPeerReviews(taskId: string): PeerReview[] {
    return this.reviewsStore.listPeerReviews(taskId);
  }
  recordMaterialCitation(
    taskId: string,
    engagementId: string,
    input: MaterialCitationInput,
    seal: MaterialCitationSeal,
  ): MaterialCitation {
    return this.reviewsStore.recordMaterialCitation(taskId, engagementId, input, seal);
  }
  citationSectionMeta(taskId: string, citationId: string): Omit<KnowledgeSection, "text"> | null {
    return this.reviewsStore.citationSectionMeta(taskId, citationId);
  }
  getMaterialCitation(taskId: string, citationId: string): MaterialCitation | null {
    return this.reviewsStore.getMaterialCitation(taskId, citationId);
  }
  listMaterialCitations(taskId: string): MaterialCitation[] {
    return this.reviewsStore.listMaterialCitations(taskId);
  }

  /* ====================================================================== *
   * 5. Hints, Stigmergy Technique Broadcast, Event Hash Chain & Observe
   * ====================================================================== */

  relayCount(taskId: string): number {
    const row = this.db
      .prepare("SELECT COUNT(*) AS n FROM events WHERE task_id = ? AND kind = 'relay_written'")
      .get(taskId);
    return Number(row?.n ?? 0);
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

  recordExploreScaled(
    taskId: string,
    input: { from: number; to: number; assetCount: number },
  ): void {
    this.emit(taskId, "explore_scaled", { ...input });
  }

  commandAttemptCount(taskId: string, commandHash: string): number {
    const row = this.db
      .prepare("SELECT count FROM command_attempts WHERE task_id = ? AND command_hash = ?")
      .get(taskId, commandHash) as { count?: number } | undefined;
    return Number(row?.count ?? 0);
  }

  recordCommandAttempt(taskId: string, commandHash: string): number {
    const now = this.now();
    const result = this.db
      .prepare(
        `INSERT INTO command_attempts (task_id, command_hash, count, first_at, last_at)
         VALUES (?, ?, 1, ?, ?)
         ON CONFLICT(task_id, command_hash)
         DO UPDATE SET count = command_attempts.count + 1, last_at = excluded.last_at
         RETURNING count`,
      )
      .get(taskId, commandHash, now, now) as { count?: number } | undefined;
    return Number(result?.count ?? 1);
  }

  resetCommandAttempts(taskId: string, reason = ""): void {
    this.db.prepare("DELETE FROM command_attempts WHERE task_id = ?").run(taskId);
    this.emit(taskId, "tool_gate", {
      tool: "repeat-guard-reset",
      ok: true,
      reason: reason.slice(0, 300),
    });
  }

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
      .prepare(`SELECT * FROM hints WHERE task_id = ? ORDER BY created_at DESC LIMIT ?`)
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

  broadcastTechnique(input: {
    taskId: string;
    sourceFactIds: string[];
    title: string;
    summary: string;
    familyKey?: string;
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
      if (!this.getFact(input.taskId, id)) throw new Error(`unknown source fact: ${id}`);
    }

    const assetsAll = this.listAssets(input.taskId);
    const assets = assetsAll.filter((a) => a.kind !== "oos");
    const wanted = input.targetAddresses?.map((a) => a.trim()).filter(Boolean);
    let peers = wanted?.length ? assets.filter((a) => wanted.includes(a.address)) : assets;

    const sourceTags = sources.flatMap((id) => this.getFact(input.taskId, id)?.tags ?? []);
    const hint = suggestFamilyKey({
      title: input.title,
      summary: input.summary,
      tags: sourceTags,
      addresses: peers.map((p) => p.address),
    });
    const familyKey = normalizeFamilyKey(input.familyKey) ?? hint?.key ?? null;
    const familyKeyVia = input.familyKey?.trim() ? "explicit" : hint ? hint.via : null;

    const tags = [TRANSFERABLE_TAG];
    if (familyKey) tags.push(familyTag(familyKey));

    const techniqueFact = this.appendFact({
      taskId: input.taskId,
      layer: "title",
      title: input.title.trim() || "可迁移打法",
      summary: input.summary.trim(),
      tags,
    });

    if (familyKey?.startsWith("root:")) {
      const root = familyKey.slice("root:".length);
      const narrowed = peers.filter(
        (p) => assetRootKey(p.address) === root || assetGroupKey(p.address) === root,
      );
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
      .prepare(`SELECT * FROM events WHERE task_id = ? ORDER BY created_at DESC LIMIT ?`)
      .all(taskId, limit) as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      id: String(r.id),
      taskId: String(r.task_id),
      kind: r.kind as HistoryEventKind,
      payload: JSON.parse(String(r.payload_json)) as Record<string, unknown>,
      createdAt: String(r.created_at),
      prevHash: (r.prev_hash as string | null) ?? null,
      hash: (r.hash as string | null) ?? null,
    }));
  }

  verifyEventChain(taskId: string): {
    ok: boolean;
    length: number;
    head: string | null;
    brokenAt: string | null;
    reason: string | null;
  } {
    const rows = this.db
      .prepare(
        "SELECT id, task_id, kind, payload_json, created_at, prev_hash, hash FROM events WHERE task_id = ? ORDER BY rowid",
      )
      .all(taskId) as Array<Record<string, unknown>>;
    let prev: string | null = null;
    for (const row of rows) {
      const id = String(row.id);
      if (row.hash == null) {
        return { ok: false, length: rows.length, head: prev, brokenAt: id, reason: "unsealed event" };
      }
      const expected = eventHash(prev, {
        id,
        taskId,
        kind: String(row.kind),
        payloadJson: String(row.payload_json),
        createdAt: String(row.created_at),
      });
      if (String(row.prev_hash ?? "") !== (prev ?? "") || String(row.hash) !== expected) {
        return {
          ok: false,
          length: rows.length,
          head: prev,
          brokenAt: id,
          reason: "hash mismatch",
        };
      }
      prev = expected;
    }
    return { ok: true, length: rows.length, head: prev, brokenAt: null, reason: null };
  }

  eventChainHead(taskId: string): string | null {
    const row = this.db
      .prepare("SELECT hash FROM events WHERE task_id = ? ORDER BY rowid DESC LIMIT 1")
      .get(taskId) as { hash?: string | null } | undefined;
    return row?.hash ?? null;
  }

  dagExport(taskId: string, generatedAt = this.now()): DagExport {
    return buildDagExport({
      taskId,
      generatedAt,
      facts: this.listFacts(taskId),
      intents: this.listIntents(taskId),
      findings: this.listFindings(taskId),
      assets: this.listAssets(taskId),
      credentials: this.listCredentials(taskId),
      validations: this.listFindingValidations(taskId),
    });
  }

  recordAttackNode(taskId: string, node: AttackNode): Fact {
    return this.appendFact({
      taskId,
      layer: "title",
      title: `ATTACK node ${node.kind} ${node.name}`.slice(0, 200),
      summary: JSON.stringify(node),
      tags: attackNodeTags(node),
    });
  }

  recordAttackEdge(taskId: string, edge: AttackEdge): Fact {
    return this.appendFact({
      taskId,
      layer: "title",
      title: `ATTACK edge ${edge.kind} ${edge.from} -> ${edge.to}`.slice(0, 200),
      summary: JSON.stringify(edge),
      tags: attackEdgeTags(edge),
    });
  }

  attackGraph(taskId: string): AttackGraph {
    return buildAttackGraph(this.listFacts(taskId));
  }

  attackPaths(
    taskId: string,
    opts: { from?: readonly string[]; maxDepth?: number; maxPaths?: number } = {},
  ): AttackPath[] {
    return findAttackPaths(this.attackGraph(taskId), opts);
  }

  engagementAudit(taskId: string): EngagementAudit {
    return deriveHistoryEngagementAudit(this, taskId);
  }

  observe(taskId: string): string {
    return renderHistoryObserve(this, taskId);
  }

  overview(taskId: string): string {
    return renderHistoryOverview(this, taskId);
  }

  relativeEvidencePath(absPath: string): string {
    return relative(this.evidenceDir, absPath).replace(/\\/g, "/");
  }
}

export function openHistory(opts: OpenHistoryOptions): HistoryStore {
  return new HistoryStore(opts);
}

export {
  CommandLedger,
  hasCommandLedger,
  localProbes,
  type CommandOutcome,
  type CommandProposal,
  type CommandTicket,
} from "./command-reviews.js";
export {
  applyCausalVerdict,
  artifact,
  artifactKey,
  artifactsFromTags,
  evidenceArtifacts,
  normalizeAssetValue,
  normalizeEndpointValue,
  normalizeEvidencePath,
  normalizeTrafficValue,
  parseIsoMs,
  sharedArtifacts,
  summarizeCausalEdges,
  verifyCausalEdge,
} from "./edge-verifier.js";
export type {
  AbstentionReason,
  CausalArtifact,
  CausalArtifactKind,
  CausalEdgeKind,
  CausalEdgeSummary,
  CausalEdgeVerdict,
  CausalNodeRef,
  CausalProof,
} from "./edge-verifier.js";
export {
  buildDagExport,
  type BuildDagExportInput,
  type DagExport,
  type DagFactRef,
  type DagFindingRef,
  type DagIntentRef,
} from "./dag.js";
export {
  LEDGER_REL_PATH,
  REPORT_REL_PATH,
  materializeTaskDeliverables,
  type MaterializedDeliverables,
} from "./deliverables.js";

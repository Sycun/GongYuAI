/**
 * 平台级持久层：全局记忆（女娲繁衍层）与飞轮（Finding 级评测 / 提案）。
 *
 * 设计纪律：
 * - 与任务级 History 分库存放：记忆与评测跨任务、跨委托，落在平台数据根
 *   `${dataRoot}/platform.sqlite`（WAL，busy_timeout=10s）；任务级作业/求助/
 *   材料/台账仍在各自任务的 History 库里。
 * - 无源不记忆、无证据不提案：契约里的 `.min(1)` 是第一道闸，写库前再用
 *   `CreateMemoryDraftSchema` / `CreateProposalSchema` 归一化一次，任何
 *   “补出来的”字段都以契约为准。
 * - 永不物理删除：superseded / retracted / rolled-back 都保留节点与原因，
 *   只改状态与时间戳，复核与回滚都能回读到原值（例如原 promotedAt）。
 * - 组间隔离与重复运行：同一 suite 的组顺序由首次运行定义，之后的运行必须
 *   与之吻合，且必须声明覆盖该 suite 已完成的其它组；冻结后同
 *   suite+group+seed 的 cases 不可替换，完全相同则幂等返回原记录。
 * - 所有写入都是同步短事务（BEGIN IMMEDIATE → COMMIT / ROLLBACK）。
 */
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  CreateMemoryDraftSchema,
  CreateProposalSchema,
  DecideProposalSchema,
  EvaluationRunSchema,
  FindingEvalCaseSchema,
  MemoryInjectionSchema,
  MemoryNodeSchema,
  ProposalSchema,
  ReviewMemorySchema,
  RunEvaluationSchema,
  findingMetrics,
  type CreateMemoryDraftInput,
  type CreateProposalInput,
  type EvaluationRun,
  type FindingEvalCase,
  type MemoryInjection,
  type MemoryKind,
  type MemoryNode,
  type MemoryStatus,
  type Proposal,
  type ProposalKind,
  type ProposalStatus,
  type ReviewMemoryInput,
  type RunEvaluationInput,
} from "@gongyuai/contracts";

export type MemoryNodeFilter = { kind?: MemoryKind; status?: MemoryStatus; taskId?: string };
export type MemoryInjectionFilter = { memoryId?: string; taskId?: string; engagementId?: string };
export type ProposalFilter = { status?: ProposalStatus; kind?: ProposalKind };
export type EvaluationFilter = { suite?: string; group?: string };

export type RecordInjectionInput = {
  memoryId: string;
  taskId: string;
  engagementId: string;
  hintId: string | null;
  layer: "bootstrap" | "explore-extra";
  matchedKeys: string[];
  reason: string;
  at: string;
};

export type ProposalDecisionInput = { decision: "approve" | "reject"; decidedBy: string; reason: string };
export type ProposalPromotionInput = { promotedBy: string; evaluationRunId: string };
export type ProposalRollbackInput = { rolledBackBy: string; reason: string };

export type ProposalEventAction = "created" | "approved" | "rejected" | "promoted" | "rolled-back";
export type ProposalEvent = {
  id: string;
  proposalId: string;
  action: ProposalEventAction;
  actor: string;
  reason: string;
  at: string;
};

export type MemoryEventAction = "superseded" | "support-retracted";
export type MemoryEvent = {
  id: string;
  memoryId: string;
  taskId: string | null;
  action: MemoryEventAction;
  actor: string;
  reason: string;
  at: string;
};

type JsonRow = { json: string };
type SuiteGroupRow = { grp: string; order_index: number; seq: number };
type MemoryEventRow = {
  id: string;
  memory_id: string;
  task_id: string | null;
  action: string;
  actor: string;
  reason: string;
  at: string;
};
type ProposalEventRow = {
  id: string;
  proposal_id: string;
  action: string;
  actor: string;
  reason: string;
  at: string;
};

/**
 * 冻结 cases 的比较口径：按 case 归一化后的内容排序再比，顺序无关、内容有关。
 * 这样“同一批样本换个提交顺序”算相同，“替换掉其中一条”算不同。
 */
function canonicalCases(cases: readonly FindingEvalCase[]): string {
  return cases
    .map((entry) => JSON.stringify(FindingEvalCaseSchema.parse(entry)))
    .sort()
    .join("\n");
}

export class PlatformStore {
  private readonly db: DatabaseSync;
  readonly dataRoot: string;
  readonly dbPath: string;
  private closed = false;

  constructor(dataRoot: string) {
    this.dataRoot = dataRoot;
    mkdirSync(dataRoot, { recursive: true });
    this.dbPath = `${dataRoot}/platform.sqlite`;
    mkdirSync(dirname(this.dbPath), { recursive: true });
    this.db = new DatabaseSync(this.dbPath);
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec("PRAGMA busy_timeout = 10000;");
    this.migrate();
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.db.close();
  }

  /* ------------------------------------------------------------------ *
   * 表结构
   * ------------------------------------------------------------------ */

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS memory_nodes (
        id TEXT PRIMARY KEY,
        json TEXT NOT NULL,
        kind TEXT NOT NULL,
        status TEXT NOT NULL,
        support_retracted INTEGER NOT NULL DEFAULT 0,
        -- reuseCount 的聚合镜像：节点 JSON 是唯一事实，这里供按复用次数排序/统计。
        reuse_count INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_memory_nodes_kind_status ON memory_nodes(kind, status);

      CREATE TABLE IF NOT EXISTS memory_injections (
        id TEXT PRIMARY KEY,
        memory_id TEXT NOT NULL,
        task_id TEXT NOT NULL,
        engagement_id TEXT NOT NULL,
        json TEXT NOT NULL,
        injected_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_memory_injections_memory ON memory_injections(memory_id, injected_at);
      CREATE INDEX IF NOT EXISTS idx_memory_injections_task ON memory_injections(task_id, injected_at);

      CREATE TABLE IF NOT EXISTS memory_events (
        id TEXT PRIMARY KEY,
        memory_id TEXT NOT NULL,
        task_id TEXT,
        action TEXT NOT NULL,
        actor TEXT NOT NULL,
        reason TEXT NOT NULL DEFAULT '',
        at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_memory_events_memory ON memory_events(memory_id, at);

      CREATE TABLE IF NOT EXISTS proposals (
        id TEXT PRIMARY KEY,
        json TEXT NOT NULL,
        kind TEXT NOT NULL,
        status TEXT NOT NULL,
        version INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_proposals_status ON proposals(status, created_at);

      CREATE TABLE IF NOT EXISTS proposal_events (
        id TEXT PRIMARY KEY,
        proposal_id TEXT NOT NULL,
        action TEXT NOT NULL,
        actor TEXT NOT NULL,
        reason TEXT NOT NULL DEFAULT '',
        at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_proposal_events_proposal ON proposal_events(proposal_id, at);

      CREATE TABLE IF NOT EXISTS evaluations (
        id TEXT PRIMARY KEY,
        json TEXT NOT NULL,
        suite TEXT NOT NULL,
        grp TEXT NOT NULL,
        order_index INTEGER NOT NULL,
        frozen INTEGER NOT NULL,
        seed TEXT,
        started_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_evaluations_suite ON evaluations(suite, order_index, started_at);
      CREATE INDEX IF NOT EXISTS idx_evaluations_frozen ON evaluations(suite, grp, seed, frozen);

      -- 组顺序登记：同一 suite 的组顺序只由首次运行定义，后续运行必须吻合。
      CREATE TABLE IF NOT EXISTS evaluation_suite_groups (
        suite TEXT NOT NULL,
        grp TEXT NOT NULL,
        order_index INTEGER NOT NULL,
        seq INTEGER NOT NULL,
        PRIMARY KEY (suite, grp)
      );
    `);
  }

  /* ------------------------------------------------------------------ *
   * 通用工具
   * ------------------------------------------------------------------ */

  private now(): string {
    return new Date().toISOString();
  }

  /** 同步短事务：SQLite 单写者；读-判-写之间不能被另一个写事务插进来。 */
  private tx<T>(run: () => T): T {
    this.db.exec("BEGIN IMMEDIATE;");
    try {
      const result = run();
      this.db.exec("COMMIT;");
      return result;
    } catch (error) {
      try {
        this.db.exec("ROLLBACK;");
      } catch {
        // SQLite 可能已自动回滚；保留原始错误，不掩盖第一现场。
      }
      throw error;
    }
  }

  private nodeFromJson(raw: string): MemoryNode {
    return MemoryNodeSchema.parse(JSON.parse(raw));
  }

  private injectionFromJson(raw: string): MemoryInjection {
    return MemoryInjectionSchema.parse(JSON.parse(raw));
  }

  private proposalFromJson(raw: string): Proposal {
    return ProposalSchema.parse(JSON.parse(raw));
  }

  private evaluationFromJson(raw: string): EvaluationRun {
    return EvaluationRunSchema.parse(JSON.parse(raw));
  }

  /* ------------------------------------------------------------------ *
   * 记忆：draft → confirmed / retracted，superseded 只改状态
   * ------------------------------------------------------------------ */

  createDraft(input: CreateMemoryDraftInput, nowIso: string): MemoryNode {
    // 无源不记忆：provenance 为空在这里就抛（契约 min(1)），不会产生半条记录。
    const parsed = CreateMemoryDraftSchema.parse(input);
    if (parsed.provenance.length === 0) throw new Error("memory-provenance-required");
    const id = randomUUID();
    return this.tx(() => {
      if (parsed.supersedes) {
        const target = this.getNode(parsed.supersedes);
        if (!target) throw new Error(`memory-supersedes-not-found:${parsed.supersedes}`);
        target.status = "superseded";
        target.supersededBy = id;
        target.updatedAt = nowIso;
        this.saveNode(target);
        this.recordMemoryEvent({
          memoryId: target.id,
          taskId: null,
          action: "superseded",
          actor: parsed.createdBy,
          reason: `superseded-by:${id}`,
          at: nowIso,
        });
      }
      const node: MemoryNode = {
        id,
        kind: parsed.kind,
        title: parsed.title,
        body: parsed.body,
        // 新建永远是 draft：确认是独立的人工动作，不在这里顺手升级。
        status: "draft",
        matchKeys: parsed.matchKeys,
        provenance: parsed.provenance,
        contradicts: parsed.contradicts ?? null,
        supersedes: parsed.supersedes ?? null,
        supersededBy: null,
        reviewer: null,
        reviewedAt: null,
        reviewReason: null,
        reuseCount: 0,
        createdAt: nowIso,
        updatedAt: nowIso,
        supportRetracted: false,
      };
      return this.saveNode(node);
    });
  }

  listNodes(filter: MemoryNodeFilter = {}): MemoryNode[] {
    const clauses: string[] = [];
    const params: string[] = [];
    if (filter.kind) {
      clauses.push("kind = ?");
      params.push(filter.kind);
    }
    if (filter.status) {
      clauses.push("status = ?");
      params.push(filter.status);
    }
    const where = clauses.length > 0 ? ` WHERE ${clauses.join(" AND ")}` : "";
    const rows = this.db
      .prepare(`SELECT json FROM memory_nodes${where} ORDER BY created_at ASC, id ASC`)
      .all(...params) as JsonRow[];
    const nodes = rows.map((row) => this.nodeFromJson(row.json));
    const taskId = filter.taskId;
    return taskId ? nodes.filter((node) => node.provenance.some((entry) => entry.taskId === taskId)) : nodes;
  }

  getNode(id: string): MemoryNode | null {
    const row = this.db.prepare(`SELECT json FROM memory_nodes WHERE id = ?`).get(id) as
      | JsonRow
      | undefined;
    return row ? this.nodeFromJson(row.json) : null;
  }

  /**
   * 复核：confirm 只允许 draft→confirmed（已是 confirmed 幂等返回，不重写复核人）；
   * retract 允许 draft/confirmed→retracted，节点与原因都保留，不删除。
   */
  reviewNode(id: string, input: ReviewMemoryInput, nowIso: string): MemoryNode {
    const parsed = ReviewMemorySchema.parse(input);
    return this.tx(() => {
      const node = this.getNode(id);
      if (!node) throw new Error(`memory-not-found:${id}`);
      if (parsed.decision === "confirm") {
        if (node.status === "confirmed") return node;
        if (node.status !== "draft") throw new Error(`memory-confirm-invalid:${node.status}`);
        node.status = "confirmed";
      } else {
        if (node.status !== "draft" && node.status !== "confirmed") {
          throw new Error(`memory-retract-invalid:${node.status}`);
        }
        node.status = "retracted";
      }
      node.reviewer = parsed.reviewer;
      node.reviewedAt = nowIso;
      node.reviewReason = parsed.reason;
      node.updatedAt = nowIso;
      return this.saveNode(node);
    });
  }

  /**
   * 依据被撤回：只把溯源含该 taskId 的 confirmed 节点置 supportRetracted=true，
   * 保留节点、保留状态，等人工复核；不自动 retract（撤回的是依据，不是结论）。
   */
  markSupportRetracted(taskId: string, reason: string): MemoryNode[] {
    const at = this.now();
    return this.tx(() => {
      const nodes = this.listNodes({ taskId, status: "confirmed" });
      const touched: MemoryNode[] = [];
      for (const node of nodes) {
        if (!node.supportRetracted) {
          node.supportRetracted = true;
          node.updatedAt = at;
          this.saveNode(node);
          this.recordMemoryEvent({
            memoryId: node.id,
            taskId,
            action: "support-retracted",
            actor: "system",
            reason,
            at,
          });
        }
        touched.push(node);
      }
      return touched;
    });
  }

  listMemoryEvents(memoryId: string): MemoryEvent[] {
    const rows = this.db
      .prepare(
        `SELECT id, memory_id, task_id, action, actor, reason, at FROM memory_events
         WHERE memory_id = ? ORDER BY at ASC, id ASC`,
      )
      .all(memoryId) as MemoryEventRow[];
    return rows.map((row) => ({
      id: row.id,
      memoryId: row.memory_id,
      taskId: row.task_id,
      action: row.action as MemoryEventAction,
      actor: row.actor,
      reason: row.reason,
      at: row.at,
    }));
  }

  /* ------------------------------------------------------------------ *
   * 注入记录：只记录“确实注入了什么、凭什么”，并累加 reuseCount
   * ------------------------------------------------------------------ */

  recordInjection(input: RecordInjectionInput): MemoryInjection {
    return this.tx(() => {
      const node = this.getNode(input.memoryId);
      if (!node) throw new Error(`memory-not-found:${input.memoryId}`);
      // 注入只接受已确认记忆：draft / retracted / superseded 一律不注入。
      if (node.status !== "confirmed") throw new Error(`memory-not-injectable:${node.status}`);
      node.reuseCount += 1;
      this.saveNode(node);

      const injection = MemoryInjectionSchema.parse({
        id: randomUUID(),
        memoryId: input.memoryId,
        taskId: input.taskId,
        engagementId: input.engagementId,
        hintId: input.hintId,
        layer: input.layer,
        matchedKeys: input.matchedKeys,
        reason: input.reason,
        injectedAt: input.at,
      });
      this.db
        .prepare(
          `INSERT INTO memory_injections (id, memory_id, task_id, engagement_id, json, injected_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(
          injection.id,
          injection.memoryId,
          injection.taskId,
          injection.engagementId,
          JSON.stringify(injection),
          injection.injectedAt,
        );
      return injection;
    });
  }

  listInjections(filter: MemoryInjectionFilter = {}): MemoryInjection[] {
    const clauses: string[] = [];
    const params: string[] = [];
    if (filter.memoryId) {
      clauses.push("memory_id = ?");
      params.push(filter.memoryId);
    }
    if (filter.taskId) {
      clauses.push("task_id = ?");
      params.push(filter.taskId);
    }
    if (filter.engagementId) {
      clauses.push("engagement_id = ?");
      params.push(filter.engagementId);
    }
    const where = clauses.length > 0 ? ` WHERE ${clauses.join(" AND ")}` : "";
    const rows = this.db
      .prepare(`SELECT json FROM memory_injections${where} ORDER BY injected_at ASC, id ASC`)
      .all(...params) as JsonRow[];
    return rows.map((row) => this.injectionFromJson(row.json));
  }

  referencesFor(memoryId: string): MemoryInjection[] {
    return this.listInjections({ memoryId });
  }

  /* ------------------------------------------------------------------ *
   * 飞轮：提案 draft → approved / rejected → promoted → rolled-back
   * ------------------------------------------------------------------ */

  createProposal(input: CreateProposalInput, nowIso: string): Proposal {
    // 无证据不提案：evidence 为空在契约层即抛错。
    const parsed = CreateProposalSchema.parse(input);
    if (parsed.evidence.length === 0) throw new Error("proposal-evidence-required");
    return this.tx(() => {
      const proposal: Proposal = {
        id: randomUUID(),
        kind: parsed.kind,
        title: parsed.title,
        body: parsed.body,
        status: "draft",
        evidence: parsed.evidence,
        expectedGain: parsed.expectedGain,
        configKey: parsed.configKey ?? null,
        proposedValue: parsed.proposedValue ?? null,
        previousValue: parsed.previousValue ?? null,
        version: 1,
        approvedBy: null,
        approvedAt: null,
        rejectedReason: null,
        promotedAt: null,
        rolledBackAt: null,
        evaluationRunId: null,
        createdAt: nowIso,
        updatedAt: nowIso,
      };
      const saved = this.saveProposal(proposal);
      this.recordProposalEvent({
        proposalId: saved.id,
        action: "created",
        actor: parsed.createdBy,
        reason: "",
        at: nowIso,
      });
      return saved;
    });
  }

  listProposals(filter: ProposalFilter = {}): Proposal[] {
    const clauses: string[] = [];
    const params: string[] = [];
    if (filter.status) {
      clauses.push("status = ?");
      params.push(filter.status);
    }
    if (filter.kind) {
      clauses.push("kind = ?");
      params.push(filter.kind);
    }
    const where = clauses.length > 0 ? ` WHERE ${clauses.join(" AND ")}` : "";
    const rows = this.db
      .prepare(`SELECT json FROM proposals${where} ORDER BY created_at ASC, id ASC`)
      .all(...params) as JsonRow[];
    return rows.map((row) => this.proposalFromJson(row.json));
  }

  getProposal(id: string): Proposal | null {
    const row = this.db.prepare(`SELECT json FROM proposals WHERE id = ?`).get(id) as
      | JsonRow
      | undefined;
    return row ? this.proposalFromJson(row.json) : null;
  }

  listProposalEvents(proposalId: string): ProposalEvent[] {
    const rows = this.db
      .prepare(
        `SELECT id, proposal_id, action, actor, reason, at FROM proposal_events
         WHERE proposal_id = ? ORDER BY at ASC, rowid ASC`,
      )
      .all(proposalId) as ProposalEventRow[];
    return rows.map((row) => ({
      id: row.id,
      proposalId: row.proposal_id,
      action: row.action as ProposalEventAction,
      actor: row.actor,
      reason: row.reason,
      at: row.at,
    }));
  }

  /** 只有 draft 可裁决；reject 记原因，approve 记裁决人与时间。 */
  decideProposal(id: string, input: ProposalDecisionInput, nowIso: string): Proposal {
    const parsed = DecideProposalSchema.parse(input);
    return this.tx(() => {
      const proposal = this.getProposal(id);
      if (!proposal) throw new Error(`proposal-not-found:${id}`);
      if (proposal.status !== "draft") throw new Error(`proposal-not-decidable:${proposal.status}`);
      if (parsed.decision === "approve") {
        proposal.status = "approved";
        proposal.approvedBy = parsed.decidedBy;
        proposal.approvedAt = nowIso;
        proposal.rejectedReason = null;
      } else {
        proposal.status = "rejected";
        proposal.rejectedReason = parsed.reason;
      }
      proposal.updatedAt = nowIso;
      const saved = this.saveProposal(proposal);
      this.recordProposalEvent({
        proposalId: saved.id,
        action: parsed.decision === "approve" ? "approved" : "rejected",
        actor: parsed.decidedBy,
        reason: parsed.reason,
        at: nowIso,
      });
      return saved;
    });
  }

  /**
   * 上线：必须已 approved，且必须挂一份**存在且有过人工裁决样本**的评测
   * （metrics.adjudicated > 0）；没有裁决样本的评测证明不了任何东西。
   */
  promoteProposal(id: string, input: ProposalPromotionInput, nowIso: string): Proposal {
    return this.tx(() => {
      const proposal = this.getProposal(id);
      if (!proposal) throw new Error(`proposal-not-found:${id}`);
      if (proposal.status !== "approved") throw new Error(`proposal-not-approved:${proposal.status}`);
      const evaluation = this.getEvaluation(input.evaluationRunId);
      if (!evaluation) throw new Error(`evaluation-not-found:${input.evaluationRunId}`);
      if (evaluation.metrics.adjudicated <= 0) {
        throw new Error(`evaluation-not-adjudicated:${input.evaluationRunId}`);
      }
      proposal.status = "promoted";
      proposal.promotedAt = nowIso;
      proposal.evaluationRunId = input.evaluationRunId;
      proposal.updatedAt = nowIso;
      const saved = this.saveProposal(proposal);
      this.recordProposalEvent({
        proposalId: saved.id,
        action: "promoted",
        actor: input.promotedBy,
        reason: `evaluation:${input.evaluationRunId}`,
        at: nowIso,
      });
      return saved;
    });
  }

  /**
   * 回滚：必须 promoted；保留 promotedAt（原上线时间是不可改的历史），
   * 另记 rolledBackAt 与一条 rolled-back 事件（含原因与执行人）。
   */
  rollbackProposal(id: string, input: ProposalRollbackInput, nowIso: string): Proposal {
    return this.tx(() => {
      const proposal = this.getProposal(id);
      if (!proposal) throw new Error(`proposal-not-found:${id}`);
      if (proposal.status !== "promoted") throw new Error(`proposal-not-promoted:${proposal.status}`);
      proposal.status = "rolled-back";
      proposal.rolledBackAt = nowIso;
      proposal.updatedAt = nowIso;
      const saved = this.saveProposal(proposal);
      this.recordProposalEvent({
        proposalId: saved.id,
        action: "rolled-back",
        actor: input.rolledBackBy,
        reason: input.reason,
        at: nowIso,
      });
      return saved;
    });
  }

  /* ------------------------------------------------------------------ *
   * 评测：组顺序 / 组间隔离 / 冻结样本
   * ------------------------------------------------------------------ */

  recordEvaluation(input: RunEvaluationInput, nowIso: string): EvaluationRun {
    const parsed = RunEvaluationSchema.parse(input);
    // 冻结必须先固定随机源，否则“同一批样本”根本不可复现。
    if (parsed.frozen && !parsed.seed) throw new Error("evaluation-frozen-requires-seed");
    return this.tx(() => {
      const groups = this.suiteGroups(parsed.suite);
      const known = groups.find((row) => row.grp === parsed.group);
      let ordinal: number;
      if (known) {
        // 已登记的组：order 必须与首次登记一致（组顺序不可被后来的写入改动）。
        if (known.order_index !== parsed.order) throw new Error("evaluation-group-order-mismatch");
        ordinal = known.seq;
      } else {
        const last = groups.length > 0 ? groups[groups.length - 1] : undefined;
        // 新组只能排在已有组之后；乱序提交（回到前面）等同于重排实验。
        if (last && parsed.order <= last.order_index) {
          throw new Error("evaluation-group-order-mismatch");
        }
        ordinal = groups.length;
      }

      // 组间隔离：该 suite 已完成的其它组必须全部被 isolatedFrom 覆盖。
      const isolated = new Set(parsed.isolatedFrom);
      for (const group of this.completedGroups(parsed.suite)) {
        if (group === parsed.group) continue;
        if (isolated.has(group)) continue;
        throw new Error(`evaluation-isolation-missing:${group}`);
      }

      // 冻结后同 suite+group+seed 的 cases 不可替换；完全相同则幂等返回。
      if (parsed.seed) {
        const prior = this.frozenRun(parsed.suite, parsed.group, parsed.seed);
        if (prior) {
          if (canonicalCases(prior.cases) === canonicalCases(parsed.cases)) return prior;
          throw new Error("frozen-evaluation-mismatch");
        }
      }

      if (!known) this.registerSuiteGroup(parsed.suite, parsed.group, parsed.order, ordinal);

      const notes: string[] = [`suite-order:${ordinal + 1}`];
      if (parsed.frozen && parsed.seed) notes.push(`frozen-seed:${parsed.seed}`);
      if (parsed.isolatedFrom.length > 0) {
        notes.push(`isolated-from:${[...parsed.isolatedFrom].sort().join(",")}`);
      }

      const run: EvaluationRun = {
        id: randomUUID(),
        suite: parsed.suite,
        group: parsed.group,
        order: parsed.order,
        frozen: parsed.frozen,
        seed: parsed.seed ?? null,
        taskIds: parsed.taskIds,
        cases: parsed.cases,
        metrics: findingMetrics(parsed.cases),
        isolatedFrom: parsed.isolatedFrom,
        startedAt: nowIso,
        finishedAt: nowIso,
        notes,
      };
      const saved = this.saveEvaluation(run);
      return saved;
    });
  }

  listEvaluations(filter: EvaluationFilter = {}): EvaluationRun[] {
    const clauses: string[] = [];
    const params: string[] = [];
    if (filter.suite) {
      clauses.push("suite = ?");
      params.push(filter.suite);
    }
    if (filter.group) {
      clauses.push("grp = ?");
      params.push(filter.group);
    }
    const where = clauses.length > 0 ? ` WHERE ${clauses.join(" AND ")}` : "";
    const rows = this.db
      .prepare(
        `SELECT json FROM evaluations${where}
         ORDER BY suite ASC, order_index ASC, started_at ASC, id ASC`,
      )
      .all(...params) as JsonRow[];
    return rows.map((row) => this.evaluationFromJson(row.json));
  }

  getEvaluation(id: string): EvaluationRun | null {
    const row = this.db.prepare(`SELECT json FROM evaluations WHERE id = ?`).get(id) as
      | JsonRow
      | undefined;
    return row ? this.evaluationFromJson(row.json) : null;
  }

  /* ------------------------------------------------------------------ *
   * 内部读写
   * ------------------------------------------------------------------ */

  private saveNode(node: MemoryNode): MemoryNode {
    const normalized = MemoryNodeSchema.parse(node);
    this.db
      .prepare(
        `INSERT INTO memory_nodes (id, json, kind, status, support_retracted, reuse_count, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           json = excluded.json,
           kind = excluded.kind,
           status = excluded.status,
           support_retracted = excluded.support_retracted,
           reuse_count = excluded.reuse_count,
           updated_at = excluded.updated_at`,
      )
      .run(
        normalized.id,
        JSON.stringify(normalized),
        normalized.kind,
        normalized.status,
        Number(normalized.supportRetracted),
        normalized.reuseCount,
        normalized.createdAt,
        normalized.updatedAt,
      );
    return normalized;
  }

  private saveProposal(proposal: Proposal): Proposal {
    const normalized = ProposalSchema.parse(proposal);
    this.db
      .prepare(
        `INSERT INTO proposals (id, json, kind, status, version, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           json = excluded.json,
           kind = excluded.kind,
           status = excluded.status,
           version = excluded.version,
           updated_at = excluded.updated_at`,
      )
      .run(
        normalized.id,
        JSON.stringify(normalized),
        normalized.kind,
        normalized.status,
        normalized.version,
        normalized.createdAt,
        normalized.updatedAt,
      );
    return normalized;
  }

  private saveEvaluation(run: EvaluationRun): EvaluationRun {
    const normalized = EvaluationRunSchema.parse(run);
    this.db
      .prepare(
        `INSERT INTO evaluations (id, json, suite, grp, order_index, frozen, seed, started_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        normalized.id,
        JSON.stringify(normalized),
        normalized.suite,
        normalized.group,
        normalized.order,
        Number(normalized.frozen),
        normalized.seed,
        normalized.startedAt,
      );
    return normalized;
  }

  private recordMemoryEvent(event: {
    memoryId: string;
    taskId: string | null;
    action: MemoryEventAction;
    actor: string;
    reason: string;
    at: string;
  }): void {
    this.db
      .prepare(
        `INSERT INTO memory_events (id, memory_id, task_id, action, actor, reason, at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(randomUUID(), event.memoryId, event.taskId, event.action, event.actor, event.reason, event.at);
  }

  private recordProposalEvent(event: {
    proposalId: string;
    action: ProposalEventAction;
    actor: string;
    reason: string;
    at: string;
  }): void {
    this.db
      .prepare(
        `INSERT INTO proposal_events (id, proposal_id, action, actor, reason, at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(randomUUID(), event.proposalId, event.action, event.actor, event.reason, event.at);
  }

  private suiteGroups(suite: string): SuiteGroupRow[] {
    return this.db
      .prepare(
        `SELECT grp, order_index, seq FROM evaluation_suite_groups WHERE suite = ? ORDER BY seq ASC`,
      )
      .all(suite) as SuiteGroupRow[];
  }

  private registerSuiteGroup(suite: string, group: string, order: number, seq: number): void {
    this.db
      .prepare(
        `INSERT INTO evaluation_suite_groups (suite, grp, order_index, seq) VALUES (?, ?, ?, ?)`,
      )
      .run(suite, group, order, seq);
  }

  /** 该 suite 里至少有一条已完成运行的组，按组顺序登记次序返回（报错指向稳定）。 */
  private completedGroups(suite: string): string[] {
    const rows = this.db
      .prepare(
        `SELECT g.grp AS grp FROM evaluation_suite_groups g
         WHERE g.suite = ?
           AND EXISTS (SELECT 1 FROM evaluations e WHERE e.suite = g.suite AND e.grp = g.grp)
         ORDER BY g.seq ASC`,
      )
      .all(suite) as Array<{ grp: string }>;
    return rows.map((row) => row.grp);
  }

  private frozenRun(suite: string, group: string, seed: string): EvaluationRun | null {
    const row = this.db
      .prepare(
        `SELECT json FROM evaluations
         WHERE suite = ? AND grp = ? AND seed = ? AND frozen = 1
         ORDER BY started_at ASC, id ASC LIMIT 1`,
      )
      .get(suite, group, seed) as JsonRow | undefined;
    return row ? this.evaluationFromJson(row.json) : null;
  }
}

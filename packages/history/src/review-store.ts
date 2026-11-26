/**
 * Delivery Assurance, Review & Citation sub-store:
 * Reconcile revisions, numbered delivery corrections, Fact/Coverage reviews,
 * Retest requests, Peer reviews, and sealed Knowledge Material citations.
 */
import { createHash, randomUUID } from "node:crypto";
import {
  CoverageReviewSchema,
  CreateFactReviewSchema,
  MaterialCitationSchema,
  PeerReviewSchema,
  RetestRequestSchema,
  businessConfigFromRequest,
  nextReconcileRevisionId,
  parseMaterial,
  reconcileConfigDigest,
  reconcileInputDigest,
  reconcileMaterials,
  summarizeReconcile,
  type BusinessReconcileConfig,
  type CoverageReview,
  type CoverageReviewInput,
  type CreateFactReview,
  type KnowledgeSection,
  type MaterialCitation,
  type MaterialCitationInput,
  type PeerReview,
  type PeerReviewInput,
  type ReconcileInputStamp,
  type ReconcileRequest,
  type ReconcileResult,
  type ReconcileRevision,
  type RetestRequest,
  type RetestRequestInput,
  type RetestRequestStatus,
} from "@gongyuai/contracts";
import type {
  DeliveryCorrection,
  FactReview,
  HistoryDomainDeps,
  MaterialCitationSeal,
} from "./context.js";
import { readEvidenceBytes, resolveEvidenceFile, writeEvidenceFile } from "./evidence.js";
import {
  captureEvidence,
  describeReconcileState,
  type ArchivedReconcile,
  type ReconcileStateReport,
} from "./goal-evidence.js";

const CITATION_BASE_COLUMNS = `id, task_id AS taskId, engagement_id AS engagementId,
  material_id AS materialId, version_id AS versionId, locator, claim, body_format AS bodyFormat,
  material_title AS materialTitle, publisher, source_kind AS sourceKind,
  version_no AS versionNo, version_label AS versionLabel, section_heading AS sectionHeading,
  section_page AS sectionPage, section_ordinal AS sectionOrdinal,
  sha256 AS snapshotSha256, created_at AS createdAt`;

export class DeliveryReviewStore {
  private citationColumnNames: Set<string> | null = null;

  constructor(private readonly deps: HistoryDomainDeps) {}

  /* --------------------------- Reconcile Archives --------------------------- */

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
    const { taskId, request } = input;
    const goalIds = [...new Set(input.goalIds ?? request.goalIds ?? [])];
    if (goalIds.length) {
      const known = new Set(this.deps.listGoals(taskId).map((goal) => goal.id));
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
      id: nextReconcileRevisionId(
        this.listReconcileRevisions(taskId).map((entry) => entry.revision.id),
      ),
      taskId,
      goalIds,
      config,
      configDigest,
      inputDigest: reconcileInputDigest(configDigest, baselineStamp, currentStamp),
      baseline: baselineStamp,
      current: currentStamp,
      createdAt: this.deps.now(),
    };

    const resultWithRevision: ReconcileResult = { ...result, revision };
    const serialized = JSON.stringify(resultWithRevision, null, 2) + "\n";
    const relativePath = `reconcile/${request.name}-${revision.id}.json`;
    writeEvidenceFile(this.deps.evidenceDir, relativePath, serialized);
    const evidenceSha256 = createHash("sha256")
      .update(Buffer.from(serialized, "utf8"))
      .digest("hex");

    const fact = this.deps.appendFact({
      taskId,
      layer: "evidence",
      title: `原始材料差异核算 · ${request.name}`,
      summary: summarizeReconcile(resultWithRevision),
      evidencePath: relativePath,
      tags: [
        "reconcile",
        `reconcile:${request.name}`,
        `reconcile-revision:${revision.id}`,
        "source:operator",
      ],
    });

    this.deps.db
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

    return {
      revision,
      result: resultWithRevision,
      evidencePath: relativePath,
      evidenceSha256,
      factId: fact.id,
    };
  }

  private stampMaterial(path: string): {
    path: string;
    present: boolean;
    sha256: string | null;
    bytes: Buffer | null;
  } {
    try {
      resolveEvidenceFile(this.deps.evidenceDir, path);
      const bytes = readEvidenceBytes(this.deps.evidenceDir, path);
      return {
        path,
        present: true,
        sha256: createHash("sha256").update(bytes).digest("hex"),
        bytes,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (/ENOENT|no such file/i.test(message)) {
        return { path, present: false, sha256: null, bytes: null };
      }
      throw err;
    }
  }

  listReconcileRevisions(taskId: string): ArchivedReconcile[] {
    if (this.deps.archiveTables && !this.deps.archiveTables.has("reconcile_revisions")) return [];
    const rows = this.deps.db
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

  goalReconcileState(taskId: string, goalId: string): ReconcileStateReport | null {
    const goal = this.deps.listGoals(taskId).find((entry) => entry.id === goalId);
    if (!goal?.reconcileGate) return null;
    if (goal.passes) {
      const proofs = this.deps.listGoalProofs(taskId).filter((proof) => proof.goalId === goalId);
      return {
        state: "passed",
        reason: null,
        latestRevisionId: proofs[0]?.path.match(/r\d{13}-\d{4}/)?.[0] ?? null,
        readyRevisionId: null,
        materials: goal.business
          ? {
              baseline: {
                path: goal.business.baseline.path,
                present: this.hasEvidence(goal.business.baseline.path),
              },
              current: {
                path: goal.business.current.path,
                present: this.hasEvidence(goal.business.current.path),
              },
            }
          : null,
        drift: null,
        ambiguous: [],
      };
    }
    return describeReconcileState({
      evidenceDir: this.deps.evidenceDir,
      gate: goal.reconcileGate,
      goalId,
      ...(goal.business
        ? { expectedConfigDigest: reconcileConfigDigest(goal.business), goalConfig: goal.business }
        : {}),
      archives: this.listReconcileRevisions(taskId),
      ...(goal.business
        ? {
            declaredMaterials: {
              baseline: goal.business.baseline.path,
              current: goal.business.current.path,
            },
          }
        : {}),
    });
  }

  private hasEvidence(path: string): boolean {
    try {
      resolveEvidenceFile(this.deps.evidenceDir, path);
      return true;
    } catch {
      return false;
    }
  }

  /* --------------------------- Delivery Corrections --------------------------- */

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
    const allFindings = this.deps.listFindings(taskId);
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
    const goalFindings = this.deps.listGoalFindings(taskId);
    const affectedFindings = [...retracted]
      .filter((id) => goalFindings.some((s) => s.findingId === id))
      .sort();
    const goals = [
      ...new Set(goalFindings.filter((s) => retracted.has(s.findingId)).map((s) => s.goalId)),
    ].sort();
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

    const report = (input.report ?? []).map((entry) => ({
      path: entry.path,
      sha256: entry.sha256,
    }));
    const evidence = input.evidencePath
      ? captureEvidence(this.deps.evidenceDir, input.evidencePath)
      : undefined;
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
      createdAt: this.deps.now(),
    };
    this.deps.db.exec("BEGIN IMMEDIATE");
    try {
      if (evidence) this.deps.saveVersion(evidence);
      this.deps.db
        .prepare(
          `INSERT INTO delivery_corrections
            (id, task_id, number, reason, findings_json, goals_json, report_json,
             notice_status, evidence_path, sha256, dedup_key, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          correction.id,
          taskId,
          correction.number,
          correction.reason,
          JSON.stringify(correction.findings),
          JSON.stringify(correction.goals),
          JSON.stringify(correction.report),
          correction.noticeStatus,
          correction.evidencePath ?? null,
          correction.sha256 ?? null,
          dedupKey,
          correction.createdAt,
        );
      this.deps.emit(taskId, "delivery_corrected", {
        correctionId: correction.id,
        number: correction.number,
        findings: correction.findings,
        goals: correction.goals,
      });
      this.deps.db.exec("COMMIT");
    } catch (err) {
      this.deps.db.exec("ROLLBACK");
      throw err;
    }
    return { correction, created: true };
  }

  listDeliveryCorrections(taskId: string): DeliveryCorrection[] {
    if (this.deps.archiveTables && !this.deps.archiveTables.has("delivery_corrections")) return [];
    return this.deps.db
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

  setDeliveryCorrectionNotice(
    taskId: string,
    correctionId: string,
    status: DeliveryCorrection["noticeStatus"],
    evidencePath?: string,
  ): DeliveryCorrection {
    const existing = this.listDeliveryCorrections(taskId).find((c) => c.id === correctionId);
    if (!existing) throw new Error(`unknown correction: ${correctionId}`);
    const evidence = evidencePath
      ? captureEvidence(this.deps.evidenceDir, evidencePath)
      : undefined;
    if (status === "confirmed" && !evidence) {
      throw new Error("confirmed 通知状态需要客户确认证据文件");
    }
    this.deps.db.exec("BEGIN IMMEDIATE");
    try {
      if (evidence) this.deps.saveVersion(evidence);
      this.deps.db
        .prepare(
          `UPDATE delivery_corrections SET notice_status = ?, evidence_path = COALESCE(?, evidence_path),
             sha256 = COALESCE(?, sha256) WHERE task_id = ? AND id = ?`,
        )
        .run(status, evidence?.path ?? null, evidence?.sha256 ?? null, taskId, correctionId);
      this.deps.emit(taskId, "delivery_correction_notice", { correctionId, status });
      this.deps.db.exec("COMMIT");
    } catch (err) {
      this.deps.db.exec("ROLLBACK");
      throw err;
    }
    return this.listDeliveryCorrections(taskId).find((c) => c.id === correctionId)!;
  }

  /* --------------------------- Fact & Coverage Reviews --------------------------- */

  listReviews(taskId: string): FactReview[] {
    if (this.deps.archiveTables && !this.deps.archiveTables.has("fact_reviews")) return [];
    const rows = this.deps.db
      .prepare(
        `SELECT id, fact_id AS factId, goal_id AS goalId, decision,
                replacement_fact_id AS replacementFactId, reviewer, reason, path AS evidencePath, sha256,
                created_at AS createdAt FROM fact_reviews WHERE task_id = ? ORDER BY rowid`,
      )
      .all(taskId);
    return rows.map(({ replacementFactId, ...r }) => ({
      ...r,
      ...(replacementFactId ? { replacementFactId } : {}),
    }) as FactReview);
  }

  appendReview(taskId: string, input: CreateFactReview): FactReview {
    const r = CreateFactReviewSchema.parse(input);
    if (
      !this.deps.getFact(taskId, r.factId) ||
      (r.replacementFactId && !this.deps.getFact(taskId, r.replacementFactId))
    ) {
      throw new Error("review references a fact outside this task or an unknown fact");
    }
    if (!this.deps.listGoals(taskId).some((g) => g.id === r.goalId)) {
      throw new Error("unknown review goal");
    }
    const file = captureEvidence(this.deps.evidenceDir, r.evidencePath);
    this.deps.db.exec("BEGIN IMMEDIATE");
    try {
      const prior = this.listReviews(taskId)
        .filter((p) => p.goalId === r.goalId && p.factId === r.factId)
        .at(-1);
      if (
        prior &&
        prior.decision === r.decision &&
        prior.reviewer === r.reviewer &&
        prior.reason === r.reason &&
        prior.replacementFactId === r.replacementFactId &&
        prior.sha256 === file.sha256 &&
        prior.evidencePath === file.path
      ) {
        this.deps.db.exec("COMMIT");
        return prior;
      }
      const review: FactReview = {
        ...r,
        id: randomUUID(),
        createdAt: this.deps.now(),
        evidencePath: file.path,
        sha256: file.sha256,
      };
      this.deps.saveVersion(file);
      this.deps.db
        .prepare(
          `INSERT INTO fact_reviews
            (id, task_id, fact_id, goal_id, decision, replacement_fact_id, reviewer, reason, path, sha256, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          review.id,
          taskId,
          r.factId,
          r.goalId,
          r.decision,
          r.replacementFactId ?? null,
          r.reviewer,
          r.reason,
          file.path,
          file.sha256,
          review.createdAt,
        );
      this.deps.db.exec("COMMIT");
      return review;
    } catch (err) {
      this.deps.db.exec("ROLLBACK");
      throw err;
    }
  }

  listCoverage(taskId: string): CoverageReview[] {
    if (this.deps.archiveTables && !this.deps.archiveTables.has("coverage_reviews")) return [];
    return this.deps.db
      .prepare(
        `SELECT id, goal_id AS goalId, status, reviewer, reason,
                path AS evidencePath, sha256, created_at AS createdAt
         FROM coverage_reviews WHERE task_id = ? ORDER BY rowid`,
      )
      .all(taskId)
      .map(
        ({ evidencePath, sha256, ...record }) =>
          ({
            ...record,
            ...(evidencePath ? { evidencePath, sha256 } : {}),
          }) as CoverageReview,
      );
  }

  recordCoverage(taskId: string, input: CoverageReviewInput): CoverageReview {
    const entry = CoverageReviewSchema.parse(input);
    const file = entry.evidencePath
      ? captureEvidence(this.deps.evidenceDir, entry.evidencePath)
      : undefined;
    this.deps.db.exec("BEGIN IMMEDIATE");
    try {
      if (!this.deps.listGoals(taskId).some((g) => g.id === entry.goalId)) {
        throw new Error("unknown coverage goal");
      }
      const prior = this.listCoverage(taskId)
        .filter((r) => r.goalId === entry.goalId)
        .at(-1);
      if (
        prior &&
        prior.status === entry.status &&
        prior.reason === entry.reason &&
        prior.reviewer === entry.reviewer &&
        prior.evidencePath === file?.path &&
        prior.sha256 === file?.sha256
      ) {
        this.deps.db.exec("COMMIT");
        return prior;
      }
      const review: CoverageReview = {
        ...entry,
        id: randomUUID(),
        createdAt: this.deps.now(),
        ...(file ? { evidencePath: file.path, sha256: file.sha256 } : {}),
      };
      if (file) this.deps.saveVersion(file);
      this.deps.db
        .prepare(
          "INSERT INTO coverage_reviews (id, task_id, goal_id, status, reviewer, reason, path, sha256, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .run(
          review.id,
          taskId,
          review.goalId,
          review.status,
          review.reviewer,
          review.reason,
          file?.path ?? null,
          file?.sha256 ?? null,
          review.createdAt,
        );
      this.deps.db.exec("COMMIT");
      return review;
    } catch (err) {
      this.deps.db.exec("ROLLBACK");
      throw err;
    }
  }

  /* --------------------------- Retest Requests & Peer Reviews --------------------------- */

  recordRetestRequest(taskId: string, input: RetestRequestInput): RetestRequest {
    const entry = RetestRequestSchema.parse(input);
    const file = entry.evidencePath
      ? captureEvidence(this.deps.evidenceDir, entry.evidencePath)
      : undefined;
    this.deps.db.exec("BEGIN IMMEDIATE");
    try {
      const findings = new Map(this.deps.listFindings(taskId).map((f) => [f.id, f]));
      for (const id of entry.findingIds) {
        const finding = findings.get(id);
        if (!finding) throw new Error(`retest request references unknown finding: ${id}`);
        if (finding.status === "retracted") {
          throw new Error(`cannot request retest for retracted finding: ${id}`);
        }
      }
      const request: RetestRequest = {
        ...entry,
        id: randomUUID(),
        status: "pending" as RetestRequestStatus,
        createdAt: this.deps.now(),
        ...(file ? { evidencePath: file.path, sha256: file.sha256 } : {}),
      };
      if (file) this.deps.saveVersion(file);
      this.deps.db
        .prepare(
          `INSERT INTO retest_requests (id, task_id, requester, role, finding_ids_json, reason, path, sha256, status, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          request.id,
          taskId,
          request.requester,
          request.role ?? null,
          JSON.stringify(request.findingIds),
          request.reason,
          file?.path ?? null,
          file?.sha256 ?? null,
          request.status,
          request.createdAt,
        );
      this.deps.emit(taskId, "retest_requested", {
        requestId: request.id,
        requester: request.requester,
        findingIds: request.findingIds,
      });
      this.deps.db.exec("COMMIT");
      return request;
    } catch (err) {
      this.deps.db.exec("ROLLBACK");
      throw err;
    }
  }

  listRetestRequests(taskId: string): RetestRequest[] {
    if (this.deps.archiveTables && !this.deps.archiveTables.has("retest_requests")) return [];
    return this.deps.db
      .prepare(
        `SELECT id, requester, role, finding_ids_json AS findingIdsJson, reason, path AS evidencePath,
                sha256, status, fulfilled_at AS fulfilledAt, fulfilled_result AS fulfilledResult,
                created_at AS createdAt
         FROM retest_requests WHERE task_id = ? ORDER BY rowid`,
      )
      .all(taskId)
      .map((row) => {
        const r = row as {
          id: string;
          requester: string;
          role: string | null;
          findingIdsJson: string;
          reason: string;
          evidencePath: string | null;
          sha256: string | null;
          status: string;
          fulfilledAt: string | null;
          fulfilledResult: string | null;
          createdAt: string;
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

  fulfillRetestRequests(taskId: string, findingId: string, result: string): RetestRequest[] {
    if (this.deps.archiveTables && !this.deps.archiveTables.has("retest_requests")) return [];
    const due = this.listRetestRequests(taskId).filter(
      (request) => request.status === "pending" && request.findingIds.includes(findingId),
    );
    if (!due.length) return [];
    const at = this.deps.now();
    const update = this.deps.db.prepare(
      `UPDATE retest_requests SET status = 'fulfilled', fulfilled_at = ?, fulfilled_result = ? WHERE id = ?`,
    );
    this.deps.db.exec("BEGIN IMMEDIATE");
    try {
      for (const request of due) update.run(at, result, request.id);
      this.deps.db.exec("COMMIT");
    } catch (err) {
      this.deps.db.exec("ROLLBACK");
      throw err;
    }
    return this.listRetestRequests(taskId).filter((request) => due.some((d) => d.id === request.id));
  }

  recordPeerReview(taskId: string, engagementId: string, input: PeerReviewInput): PeerReview {
    const entry = PeerReviewSchema.parse(input);
    if (!engagementId.trim()) throw new Error("peer review requires an engagement");
    const file = entry.evidencePath
      ? captureEvidence(this.deps.evidenceDir, entry.evidencePath)
      : undefined;
    const review: PeerReview = {
      ...entry,
      id: randomUUID(),
      engagementId,
      taskId,
      createdAt: this.deps.now(),
      ...(file ? { evidencePath: file.path, sha256: file.sha256 } : {}),
    };
    this.deps.db.exec("BEGIN IMMEDIATE");
    try {
      if (file) this.deps.saveVersion(file);
      this.deps.db
        .prepare(
          `INSERT INTO peer_reviews (id, task_id, engagement_id, reviewer, role, source_task_id,
             finding_id, fact_id, decision, basis, path, sha256, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          review.id,
          taskId,
          engagementId,
          review.reviewer,
          review.role,
          review.sourceTaskId,
          review.findingId ?? null,
          review.factId ?? null,
          review.decision,
          review.basis,
          file?.path ?? null,
          file?.sha256 ?? null,
          review.createdAt,
        );
      this.deps.emit(taskId, "peer_review_recorded", {
        reviewId: review.id,
        reviewer: review.reviewer,
        sourceTaskId: review.sourceTaskId,
        decision: review.decision,
      });
      this.deps.db.exec("COMMIT");
      return review;
    } catch (err) {
      this.deps.db.exec("ROLLBACK");
      throw err;
    }
  }

  listPeerReviews(taskId: string): PeerReview[] {
    if (this.deps.archiveTables && !this.deps.archiveTables.has("peer_reviews")) return [];
    return this.deps.db
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

  /* --------------------------- Material Citations --------------------------- */

  recordMaterialCitation(
    taskId: string,
    engagementId: string,
    input: MaterialCitationInput,
    seal: MaterialCitationSeal,
  ): MaterialCitation {
    const entry = MaterialCitationSchema.parse(input);
    if (!engagementId.trim()) throw new Error("material citation requires an engagement");
    const sha256 = createHash("sha256").update(seal.snapshot).digest("hex");
    this.deps.db.exec("BEGIN IMMEDIATE");
    try {
      const existing = this.deps.db
        .prepare(
          `SELECT id FROM material_citations
           WHERE task_id = ? AND material_id = ? AND version_id = ? AND locator = ? AND claim = ?`,
        )
        .get(taskId, entry.materialId, entry.versionId, entry.locator, entry.claim) as
        | { id: string }
        | undefined;
      if (existing) {
        this.deps.db.exec("COMMIT");
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
        createdAt: this.deps.now(),
        pinKind: entry.charStart === undefined ? "locator" : "range",
        charStart: entry.charStart ?? null,
        charEnd: entry.charEnd ?? null,
        chunkSha256: entry.chunkSha256 ?? null,
        headingPath: seal.sectionMeta.headingPath,
        pageBasis: seal.sectionMeta.pageBasis,
      };
      this.deps.saveVersion({ path: `knowledge/${sha256}`, sha256, content: seal.snapshot });
      this.deps.db
        .prepare(
          `INSERT INTO material_citations (id, task_id, engagement_id, material_id, version_id, locator, claim,
             body_format, material_title, publisher, source_kind, version_no, version_label,
             section_heading, section_page, section_ordinal, sha256, created_at,
             pin_kind, char_start, char_end, chunk_sha256, section_json)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          citation.id,
          taskId,
          engagementId,
          citation.materialId,
          citation.versionId,
          citation.locator,
          citation.claim,
          citation.bodyFormat,
          citation.materialTitle,
          citation.publisher,
          citation.sourceKind,
          citation.versionNo,
          citation.versionLabel,
          citation.sectionHeading,
          citation.sectionPage,
          citation.sectionOrdinal,
          sha256,
          citation.createdAt,
          citation.pinKind,
          citation.charStart,
          citation.charEnd,
          citation.chunkSha256,
          JSON.stringify(seal.sectionMeta),
        );
      this.deps.emit(taskId, "material_citation_recorded", {
        citationId: citation.id,
        materialId: citation.materialId,
        versionId: citation.versionId,
        locator: citation.locator,
        sha256,
      });
      this.deps.db.exec("COMMIT");
      return citation;
    } catch (err) {
      this.deps.db.exec("ROLLBACK");
      throw err;
    }
  }

  private citationColumns(): string {
    if (!this.citationColumnNames) {
      this.citationColumnNames = new Set(
        (this.deps.db.prepare(`PRAGMA table_info(material_citations)`).all() as Array<{ name: string }>)
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
      have.has(column) ? `${column} AS ${alias}` : `${fallback} AS ${alias}`,
    );
    return `${CITATION_BASE_COLUMNS}, ${extras.join(", ")}`;
  }

  private mapCitation(
    row: Omit<MaterialCitation, "headingPath" | "pageBasis"> & { sectionJson: string | null },
  ): MaterialCitation {
    const { sectionJson, ...rest } = row;
    const meta = sectionJson ? (JSON.parse(sectionJson) as Omit<KnowledgeSection, "text">) : null;
    return { ...rest, headingPath: meta?.headingPath ?? [], pageBasis: meta?.pageBasis ?? null };
  }

  citationSectionMeta(taskId: string, citationId: string): Omit<KnowledgeSection, "text"> | null {
    const rows = this.deps.db
      .prepare(`SELECT ${this.citationColumns()} FROM material_citations WHERE task_id = ? AND id = ?`)
      .all(taskId, citationId) as Array<{ sectionJson: string | null }>;
    const json = rows[0]?.sectionJson;
    return json ? (JSON.parse(json) as Omit<KnowledgeSection, "text">) : null;
  }

  getMaterialCitation(taskId: string, citationId: string): MaterialCitation | null {
    if (this.deps.archiveTables && !this.deps.archiveTables.has("material_citations")) return null;
    const row = this.deps.db
      .prepare(`SELECT ${this.citationColumns()} FROM material_citations WHERE task_id = ? AND id = ?`)
      .get(taskId, citationId) as
      | (Omit<MaterialCitation, "headingPath" | "pageBasis"> & { sectionJson: string | null })
      | undefined;
    return row ? this.mapCitation(row) : null;
  }

  listMaterialCitations(taskId: string): MaterialCitation[] {
    if (this.deps.archiveTables && !this.deps.archiveTables.has("material_citations")) return [];
    return (
      this.deps.db
        .prepare(`SELECT ${this.citationColumns()} FROM material_citations WHERE task_id = ? ORDER BY rowid`)
        .all(taskId) as Array<
        Omit<MaterialCitation, "headingPath" | "pageBasis"> & { sectionJson: string | null }
      >
    ).map((row) => this.mapCitation(row));
  }
}

/**
 * Finding Ledger & Proof Validation sub-store:
 * Findings (`tentative → verified → retested → accepted | retracted`),
 * sealed `finding_proofs`, independent `finding_validations` (Finder ≠ Validator),
 * remediation `finding_retests`, and `finding_actions`.
 */
import { randomUUID } from "node:crypto";
import type {
  Finding,
  FindingConfidence,
  FindingQualification,
  FindingRetest,
  FindingSeverity,
  FindingStatus,
  FindingValidation,
  FindingValidationDraft,
  RetestVerdict,
} from "@gongyuai/contracts";
import {
  FINDING_SEVERITY_RANK,
  findingDedupKey,
  findingStatusAllows,
  normalizeTargetPattern,
} from "@gongyuai/contracts";
import type {
  FindingAction,
  GoalProof,
  HistoryDomainDeps,
  HistoryRow,
} from "./context.js";
import { captureEvidence, type EvidenceSnapshot } from "./goal-evidence.js";

export class FindingLedgerStore {
  constructor(private readonly deps: HistoryDomainDeps) {}

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
    const title = input.title.trim();
    const vulnClass = input.vulnClass.trim();
    if (!title) throw new Error("finding title required");
    if (!vulnClass) throw new Error("finding vulnClass required (CWE-* / AUTHZ-* …)");
    const asset = normalizeTargetPattern(input.asset) || input.asset.trim().toLowerCase();
    if (!asset) throw new Error("finding asset required");
    const endpoint = input.endpoint?.trim() || null;
    const dedupKey = input.dedupKey?.trim() || findingDedupKey({ asset, vulnClass, endpoint });

    const existing = this.findFindingByDedupKey(input.taskId, dedupKey);
    const factIds = [...new Set((input.factIds ?? []).map((s) => s.trim()).filter(Boolean))];
    for (const id of factIds) {
      if (!this.deps.getFact(input.taskId, id)) {
        throw new Error(`unknown finding source fact: ${id}`);
      }
    }
    const intentId = this.deps.resolveIntentIdForWrite(input.taskId, input.intentId);
    if (intentId && !this.deps.getIntent(input.taskId, intentId)) {
      throw new Error(`unknown finding intent: ${intentId}`);
    }
    const summary = input.summary?.trim() || null;
    const affectedScope = input.affectedScope?.trim() || null;
    const rootCause = input.rootCause?.trim() || null;
    const pocCurl = input.pocCurl?.trim() || null;
    const report = input.report?.trim() || null;
    const qualification = input.qualification ?? null;
    if (existing) {
      const mergedFactIds = [...new Set([...existing.factIds, ...factIds])];
      const nextIntentId = existing.intentId ?? intentId;
      const nextSummary = existing.summary ?? summary;
      const nextAffectedScope = existing.affectedScope ?? affectedScope;
      const nextRootCause = existing.rootCause ?? rootCause;
      const nextImpact = existing.impact || (input.impact?.trim() ?? "");
      const nextFix = existing.fix || (input.fix?.trim() ?? "");
      const nextRepro = existing.repro || (input.repro?.trim() ?? "");
      const nextPocCurl = existing.pocCurl ?? pocCurl;
      const nextReport = existing.report ?? report;
      const nextQualification = existing.qualification ?? qualification;
      const changed =
        nextIntentId !== existing.intentId ||
        mergedFactIds.length !== existing.factIds.length ||
        nextSummary !== (existing.summary ?? null) ||
        nextAffectedScope !== (existing.affectedScope ?? null) ||
        nextRootCause !== (existing.rootCause ?? null) ||
        nextImpact !== existing.impact ||
        nextFix !== existing.fix ||
        nextRepro !== existing.repro ||
        nextPocCurl !== (existing.pocCurl ?? null) ||
        nextReport !== (existing.report ?? null) ||
        nextQualification !== (existing.qualification ?? null);
      if (changed) {
        this.deps.db
          .prepare(
            `UPDATE findings
             SET intent_id = ?, fact_ids_json = ?, summary = ?, affected_scope = ?, root_cause = ?,
                 repro = ?, impact = ?, fix = ?, poc_curl = ?, report_md = ?, qualification = ?
             WHERE task_id = ? AND id = ?`,
          )
          .run(
            nextIntentId,
            JSON.stringify(mergedFactIds),
            nextSummary,
            nextAffectedScope,
            nextRootCause,
            nextRepro,
            nextImpact,
            nextFix,
            nextPocCurl,
            nextReport,
            nextQualification,
            input.taskId,
            existing.id,
          );
        return { finding: this.getFinding(input.taskId, existing.id)!, created: false };
      }
      return { finding: existing, created: false };
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
      intentId,
      factIds,
      evidence: [],
      repro: input.repro?.trim() ?? "",
      impact: input.impact?.trim() ?? "",
      fix: input.fix?.trim() ?? "",
      createdAt: this.deps.now(),
      verifiedAt: null,
      verifiedBy: null,
      ...(summary ? { summary } : {}),
      ...(affectedScope ? { affectedScope } : {}),
      ...(rootCause ? { rootCause } : {}),
      ...(qualification ? { qualification } : {}),
      ...(pocCurl ? { pocCurl } : {}),
      ...(report ? { report } : {}),
    };
    this.deps.db
      .prepare(
        `INSERT INTO findings
          (id, task_id, title, asset, vuln_class, severity, cvss, confidence, status,
           endpoint, dedup_key, intent_id, fact_ids_json, evidence_json, repro, impact, fix,
           created_at, verified_at, qualification, summary, affected_scope, root_cause, poc_curl, report_md)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        finding.id,
        finding.taskId,
        finding.title,
        finding.asset,
        finding.vulnClass,
        finding.severity,
        finding.cvss,
        finding.confidence,
        finding.status,
        finding.endpoint,
        finding.dedupKey,
        finding.intentId,
        JSON.stringify(finding.factIds),
        JSON.stringify(finding.evidence),
        finding.repro,
        finding.impact,
        finding.fix,
        finding.createdAt,
        finding.verifiedAt,
        qualification,
        summary,
        affectedScope,
        rootCause,
        pocCurl,
        report,
      );
    this.deps.emit(input.taskId, "finding_recorded", {
      findingId: finding.id,
      dedupKey,
      severity: finding.severity,
      asset: finding.asset,
      vulnClass: finding.vulnClass,
    });
    return { finding, created: true };
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
      const ref = this.deps.resolveEvidenceRef(taskId, p);
      if (ref) return ref;
      try {
        return captureEvidence(this.deps.evidenceDir, p);
      } catch {
        throw new Error(`missing or invalid evidence file: ${p}`);
      }
    });

    const resolvedIntentId =
      finding.intentId ?? this.deps.resolveIntentIdForWrite(taskId, input.intentId);
    const nextIntentId =
      resolvedIntentId && this.deps.getIntent(taskId, resolvedIntentId)
        ? resolvedIntentId
        : finding.intentId;
    const normEvPath = (p: string) =>
      p.replace(/\\/g, "/").replace(/^(\.\/)+/, "").replace(/^evidence\//, "");
    const evidenceSet = new Set(files.map((f) => normEvPath(f.path)).filter(Boolean));
    const matchedFactIds = evidenceSet.size
      ? (
          this.deps.db
            .prepare("SELECT id, evidence_path FROM facts WHERE task_id = ? AND evidence_path IS NOT NULL")
            .all(taskId) as Array<{ id: string; evidence_path: string }>
        )
          .filter((row) => evidenceSet.has(normEvPath(row.evidence_path)))
          .map((row) => row.id)
      : [];
    const nextFactIds = [...new Set([...finding.factIds, ...matchedFactIds])];

    this.deps.db.exec("BEGIN IMMEDIATE");
    try {
      const evidence = [...finding.evidence];
      for (const file of files) {
        this.deps.saveVersion(file);
        this.deps.db
          .prepare("INSERT INTO finding_proofs VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING")
          .run(taskId, findingId, file.path, file.sha256);
        if (!evidence.some((e) => e.path === file.path)) {
          evidence.push({ path: file.path, sha256: file.sha256 });
        }
      }
      const now = this.deps.now();
      const nextSummary = input.summary?.trim() || finding.summary || null;
      const nextAffectedScope = input.affectedScope?.trim() || finding.affectedScope || null;
      const nextRootCause = input.rootCause?.trim() || finding.rootCause || null;
      const nextPocCurl = input.pocCurl?.trim() || finding.pocCurl || null;
      const nextReport = input.report?.trim() || finding.report || null;
      const nextQualification = input.qualification ?? finding.qualification ?? null;
      this.deps.db
        .prepare(
          `UPDATE findings
           SET status = 'verified', confidence = 'firm', evidence_json = ?,
               intent_id = ?, fact_ids_json = ?,
               summary = ?, affected_scope = ?, root_cause = ?,
               repro = ?, impact = ?, fix = ?, cvss = ?, verified_at = ?, verified_by = ?,
               poc_curl = ?, report_md = ?, qualification = ?
           WHERE task_id = ? AND id = ? AND status = 'tentative'`,
        )
        .run(
          JSON.stringify(evidence),
          nextIntentId,
          JSON.stringify(nextFactIds),
          nextSummary,
          nextAffectedScope,
          nextRootCause,
          repro,
          input.impact?.trim() || finding.impact,
          input.fix?.trim() || finding.fix,
          input.cvss?.trim() || finding.cvss,
          now,
          input.verifiedBy?.trim() || finding.verifiedBy,
          nextPocCurl,
          nextReport,
          nextQualification,
          taskId,
          findingId,
        );
      this.deps.emit(taskId, "finding_verified", {
        findingId,
        evidencePaths: files.map((f) => f.path),
        sha256: files.map((f) => f.sha256),
      });
      this.deps.db.exec("COMMIT");
    } catch (err) {
      this.deps.db.exec("ROLLBACK");
      throw err;
    }
    return this.getFinding(taskId, findingId)!;
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
    const existing = this.getFinding(taskId, findingId);
    if (!existing) return null;
    const nextSummary = patch.summary !== undefined ? (patch.summary.trim() || null) : (existing.summary ?? null);
    const nextAffectedScope =
      patch.affectedScope !== undefined ? (patch.affectedScope.trim() || null) : (existing.affectedScope ?? null);
    const nextRootCause = patch.rootCause !== undefined ? (patch.rootCause.trim() || null) : (existing.rootCause ?? null);
    const nextImpact = patch.impact !== undefined ? patch.impact.trim() : existing.impact;
    const nextFix = patch.fix !== undefined ? patch.fix.trim() : existing.fix;
    const nextPocCurl = patch.pocCurl !== undefined ? (patch.pocCurl.trim() || null) : (existing.pocCurl ?? null);
    const nextReport = patch.report !== undefined ? (patch.report.trim() || null) : (existing.report ?? null);
    this.deps.db
      .prepare(
        `UPDATE findings
         SET summary = ?, affected_scope = ?, root_cause = ?, impact = ?, fix = ?, poc_curl = ?, report_md = ?
         WHERE task_id = ? AND id = ?`,
      )
      .run(
        nextSummary,
        nextAffectedScope,
        nextRootCause,
        nextImpact,
        nextFix,
        nextPocCurl,
        nextReport,
        taskId,
        findingId,
      );
    return this.getFinding(taskId, findingId);
  }

  updateFindingPocCurl(taskId: string, findingId: string, pocCurl: string): Finding | null {
    const clean = pocCurl.trim();
    if (!clean) return this.getFinding(taskId, findingId);
    const existing = this.getFinding(taskId, findingId);
    if (!existing || existing.pocCurl) return existing;
    this.deps.db
      .prepare(`UPDATE findings SET poc_curl = ? WHERE task_id = ? AND id = ?`)
      .run(clean, taskId, findingId);
    return this.getFinding(taskId, findingId);
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
    const finding = this.getFinding(taskId, findingId);
    if (!finding) throw new Error(`unknown finding: ${findingId}`);
    if (finding.status === "retracted") throw new Error("retracted finding cannot be retested");
    const reviewer = input.reviewer.trim();
    if (!reviewer) throw new Error("retest requires reviewer");
    const repro = (input.repro ?? "").trim();
    const note = (input.note ?? "").trim();
    const paths = [...new Set((input.evidencePaths ?? []).map((p) => p.trim()).filter(Boolean))];

    if (input.verdict === "fixed" && (!repro || !paths.length)) {
      throw new Error("retest fixed requires repro/复测步骤 + ≥1 证据（事务或文件）");
    }
    if (input.verdict === "inconclusive" && !note) {
      throw new Error("retest inconclusive requires note（缺什么/为什么无法确认）");
    }

    const evidence = paths.map((p) => {
      const ref = this.deps.resolveEvidenceRef(taskId, p);
      if (ref) return { path: p, sha256: ref.sha256, content: ref.content };
      try {
        return captureEvidence(this.deps.evidenceDir, p);
      } catch {
        throw new Error(`missing or invalid retest evidence: ${p}`);
      }
    });
    for (const file of evidence) this.deps.saveVersion(file);

    const retest: FindingRetest = {
      id: randomUUID(),
      taskId,
      findingId,
      verdict: input.verdict,
      evidence: evidence.map((file) => ({ path: file.path, sha256: file.sha256, role: "proof" as const })),
      repro,
      note,
      reviewer,
      createdAt: this.deps.now(),
    };
    this.deps.db.exec("BEGIN IMMEDIATE");
    try {
      this.deps.db
        .prepare(
          `INSERT INTO finding_retests
            (id, task_id, finding_id, verdict, evidence_json, repro, note, reviewer, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          retest.id,
          taskId,
          findingId,
          retest.verdict,
          JSON.stringify(retest.evidence),
          retest.repro,
          retest.note,
          retest.reviewer,
          retest.createdAt,
        );
      if (retest.verdict === "fixed") {
        this.deps.db
          .prepare(
            `UPDATE findings SET status = 'retested' WHERE task_id = ? AND id = ?
             AND status IN ('verified', 'retested', 'accepted')`,
          )
          .run(taskId, findingId);
      }
      this.deps.emit(taskId, "finding_retest_concluded", {
        findingId,
        retestId: retest.id,
        verdict: retest.verdict,
        evidencePaths: retest.evidence.map((e) => e.path),
      });
      this.deps.db.exec("COMMIT");
    } catch (err) {
      this.deps.db.exec("ROLLBACK");
      throw err;
    }
    return { retest, finding: this.getFinding(taskId, findingId)! };
  }

  listFindingRetests(taskId: string, findingId?: string): FindingRetest[] {
    const rows = findingId
      ? this.deps.db
          .prepare("SELECT * FROM finding_retests WHERE task_id = ? AND finding_id = ? ORDER BY created_at")
          .all(taskId, findingId)
      : this.deps.db.prepare("SELECT * FROM finding_retests WHERE task_id = ? ORDER BY created_at").all(taskId);
    return (rows as HistoryRow[]).map((row) => ({
      id: String(row.id),
      taskId: String(row.task_id),
      findingId: String(row.finding_id),
      verdict: String(row.verdict) as RetestVerdict,
      evidence: JSON.parse(String(row.evidence_json ?? "[]")),
      repro: String(row.repro ?? ""),
      note: String(row.note ?? ""),
      reviewer: String(row.reviewer),
      createdAt: String(row.created_at),
    }));
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
    const finding = this.getFinding(taskId, findingId);
    if (!finding) throw new Error(`unknown finding: ${findingId}`);
    if (finding.status === "retracted") throw new Error("retracted finding cannot be retested");
    if (finding.status === "tentative") throw new Error("finding must be verified before a remediation retest");
    const paths = [...new Set(input.evidencePaths.map((p) => p.trim()).filter(Boolean))];
    if (!paths.length) throw new Error("finding retest requires ≥1 evidence file under evidence/");
    if (!input.repro.trim()) throw new Error("finding retest requires repro/复测步骤");
    const files = paths.map((p) => {
      try {
        return captureEvidence(this.deps.evidenceDir, p);
      } catch {
        throw new Error(`missing or invalid evidence file: ${p}`);
      }
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
      createdAt: this.deps.now(),
    };
    this.deps.db.exec("BEGIN IMMEDIATE");
    try {
      for (const file of files) this.deps.saveVersion(file);
      this.deps.db
        .prepare(
          `INSERT INTO finding_actions (id, task_id, finding_id, action, result, note, path, sha256, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          action.id,
          taskId,
          findingId,
          action.action,
          action.result,
          action.note,
          action.path,
          action.sha256,
          action.createdAt,
        );
      this.deps.db
        .prepare(
          `UPDATE findings SET status = 'retested' WHERE task_id = ? AND id = ? AND status IN ('verified','retested','accepted')`,
        )
        .run(taskId, findingId);
      this.deps.emit(taskId, "finding_retested", {
        findingId,
        result: input.result,
        evidencePaths: files.map((f) => f.path),
        sha256: files.map((f) => f.sha256),
        repro: input.repro.trim(),
      });
      this.deps.db.exec("COMMIT");
    } catch (err) {
      this.deps.db.exec("ROLLBACK");
      throw err;
    }
    return { finding: this.getFinding(taskId, findingId)!, action };
  }

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
    const file = captureEvidence(this.deps.evidenceDir, input.evidencePath);
    const action: FindingAction = {
      id: randomUUID(),
      taskId,
      findingId,
      action: "accept",
      result: "accepted",
      note: input.note.trim(),
      path: file.path,
      sha256: file.sha256,
      createdAt: this.deps.now(),
    };
    this.deps.db.exec("BEGIN IMMEDIATE");
    try {
      this.deps.saveVersion(file);
      this.deps.db
        .prepare(
          `INSERT INTO finding_actions (id, task_id, finding_id, action, result, note, path, sha256, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          action.id,
          taskId,
          findingId,
          action.action,
          action.result,
          action.note,
          action.path,
          action.sha256,
          action.createdAt,
        );
      this.deps.db
        .prepare(`UPDATE findings SET status = 'accepted' WHERE task_id = ? AND id = ?`)
        .run(taskId, findingId);
      this.deps.emit(taskId, "finding_accepted", {
        findingId,
        note: action.note,
        path: file.path,
        sha256: file.sha256,
      });
      this.deps.db.exec("COMMIT");
    } catch (err) {
      this.deps.db.exec("ROLLBACK");
      throw err;
    }
    return { finding: this.getFinding(taskId, findingId)!, action };
  }

  listFindingActions(taskId: string): FindingAction[] {
    if (this.deps.archiveTables && !this.deps.archiveTables.has("finding_actions")) return [];
    return this.deps.db
      .prepare(
        `SELECT id, task_id AS taskId, finding_id AS findingId, action, result, note,
                path, sha256, created_at AS createdAt
         FROM finding_actions WHERE task_id = ? ORDER BY created_at, rowid`,
      )
      .all(taskId) as FindingAction[];
  }

  retractFinding(taskId: string, findingId: string, reason: string): Finding {
    const finding = this.getFinding(taskId, findingId);
    if (!finding) throw new Error(`unknown finding: ${findingId}`);
    const note = reason.trim();
    if (!note) throw new Error("finding_retract requires reason");
    if (!findingStatusAllows(finding.status, "retracted")) {
      throw new Error(`finding already retracted: ${findingId}`);
    }
    this.deps.db
      .prepare(`UPDATE findings SET status = 'retracted' WHERE task_id = ? AND id = ?`)
      .run(taskId, findingId);
    this.deps.emit(taskId, "finding_retracted", { findingId, reason: note });
    return this.getFinding(taskId, findingId)!;
  }

  linkFindingTraffic(
    taskId: string,
    findingId: string,
    trafficIds: readonly string[],
  ): Finding | null {
    const finding = this.getFinding(taskId, findingId);
    if (!finding) return null;
    const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    const merged = [...(finding.trafficIds ?? [])];
    for (const raw of trafficIds) {
      const id = String(raw).trim().replace(/^http:/, "");
      if (uuid.test(id) && !merged.includes(id)) merged.push(id);
    }
    if (merged.length === (finding.trafficIds ?? []).length) return finding;
    this.deps.db
      .prepare(`UPDATE findings SET traffic_ids_json = ? WHERE task_id = ? AND id = ?`)
      .run(JSON.stringify(merged), taskId, findingId);
    return this.getFinding(taskId, findingId);
  }

  recordFindingValidation(
    taskId: string,
    findingId: string,
    input: FindingValidationDraft,
  ): { validation: FindingValidation; finding: Finding } {
    const finding = this.getFinding(taskId, findingId);
    if (!finding) throw new Error(`unknown finding: ${findingId}`);
    if (!["verified", "retested", "accepted"].includes(finding.status)) {
      throw new Error(`finding ${findingId} is ${finding.status}; validate only verified findings`);
    }
    const validator = input.validator.trim();
    if (!validator) throw new Error("finding_validate requires validator identity");
    if (finding.verifiedBy && validator === finding.verifiedBy) {
      throw new Error(
        `self-validation refused: ${validator} is also the verifier; use another worker session or operator:<name>`,
      );
    }
    const verdict = input.verdict;
    const method = input.method;
    const paths = [...new Set(input.evidencePaths.map((p) => p.trim()).filter(Boolean))];
    if ((verdict === "confirmed" || verdict === "refuted") && paths.length === 0) {
      throw new Error(`finding_validate(${verdict}) requires ≥1 evidence item`);
    }
    const files: EvidenceSnapshot[] = [];
    for (const item of paths) {
      const ref = this.deps.resolveEvidenceRef(taskId, item);
      if (ref) {
        files.push(ref);
        continue;
      }
      try {
        files.push(captureEvidence(this.deps.evidenceDir, item));
      } catch {
        throw new Error(`missing or invalid validation evidence: ${item}`);
      }
    }
    const now = this.deps.now();
    const validation: FindingValidation = {
      id: randomUUID(),
      taskId,
      findingId,
      verdict,
      method,
      evidence: files.map((file) => ({ path: file.path, sha256: file.sha256 })),
      note: input.note.trim(),
      validator,
      independent: !finding.verifiedBy || validator !== finding.verifiedBy,
      createdAt: now,
    };
    this.deps.db.exec("BEGIN IMMEDIATE");
    try {
      for (const file of files) this.deps.saveVersion(file);
      this.deps.db
        .prepare(
          `INSERT INTO finding_validations
             (id, task_id, finding_id, verdict, method, evidence_json, note, validator, independent, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          validation.id,
          taskId,
          findingId,
          validation.verdict,
          validation.method,
          JSON.stringify(validation.evidence),
          validation.note,
          validation.validator,
          validation.independent ? 1 : 0,
          validation.createdAt,
        );
      this.deps.emit(taskId, "finding_validated", {
        findingId,
        validationId: validation.id,
        verdict: validation.verdict,
        method: validation.method,
        validator: validation.validator,
        independent: validation.independent,
      });
      this.deps.db.exec("COMMIT");
    } catch (err) {
      this.deps.db.exec("ROLLBACK");
      throw err;
    }
    return { validation, finding: this.getFinding(taskId, findingId)! };
  }

  listFindingValidations(taskId: string, findingId?: string): FindingValidation[] {
    if (this.deps.archiveTables && !this.deps.archiveTables.has("finding_validations")) return [];
    const rows = findingId
      ? this.deps.db
          .prepare(
            "SELECT * FROM finding_validations WHERE task_id = ? AND finding_id = ? ORDER BY created_at, rowid",
          )
          .all(taskId, findingId)
      : this.deps.db
          .prepare("SELECT * FROM finding_validations WHERE task_id = ? ORDER BY created_at, rowid")
          .all(taskId);
    return rows.map((r) => this.rowToFindingValidation(r as HistoryRow));
  }

  hasConfirmedValidation(taskId: string, findingId: string): boolean {
    const rows = this.listFindingValidations(taskId, findingId).filter((row) => row.independent);
    const latest = rows.at(-1);
    return latest?.verdict === "confirmed";
  }

  private rowToFindingValidation(r: HistoryRow): FindingValidation {
    return {
      id: String(r.id),
      taskId: String(r.task_id),
      findingId: String(r.finding_id),
      verdict: r.verdict as FindingValidation["verdict"],
      method: r.method as FindingValidation["method"],
      evidence: JSON.parse(String(r.evidence_json ?? "[]")) as FindingValidation["evidence"],
      note: String(r.note ?? ""),
      validator: String(r.validator),
      independent: Number(r.independent) !== 0,
      createdAt: String(r.created_at),
    };
  }

  getFinding(taskId: string, findingId: string): Finding | null {
    if (this.deps.archiveTables && !this.deps.archiveTables.has("findings")) return null;
    const r = this.deps.db
      .prepare(`SELECT * FROM findings WHERE task_id = ? AND id = ?`)
      .get(taskId, findingId) as HistoryRow | undefined;
    return r ? this.rowToFinding(r) : null;
  }

  private findFindingByDedupKey(taskId: string, dedupKey: string): Finding | null {
    if (this.deps.archiveTables && !this.deps.archiveTables.has("findings")) return null;
    const r = this.deps.db
      .prepare(`SELECT * FROM findings WHERE task_id = ? AND dedup_key = ?`)
      .get(taskId, dedupKey) as HistoryRow | undefined;
    return r ? this.rowToFinding(r) : null;
  }

  listFindings(taskId: string): Finding[] {
    if (this.deps.archiveTables && !this.deps.archiveTables.has("findings")) return [];
    const rows = this.deps.db
      .prepare(`SELECT * FROM findings WHERE task_id = ? ORDER BY created_at ASC, rowid ASC`)
      .all(taskId) as HistoryRow[];
    return rows
      .map((r) => this.rowToFinding(r))
      .sort(
        (a, b) =>
          FINDING_SEVERITY_RANK[b.severity] - FINDING_SEVERITY_RANK[a.severity] ||
          a.createdAt.localeCompare(b.createdAt),
      );
  }

  listFindingProofs(taskId: string): GoalProof[] {
    if (this.deps.archiveTables && !this.deps.archiveTables.has("finding_proofs")) return [];
    return this.deps.db
      .prepare(
        "SELECT finding_id AS goalId, path, sha256 FROM finding_proofs WHERE task_id = ? ORDER BY finding_id, path",
      )
      .all(taskId) as GoalProof[];
  }

  private rowToFinding(r: HistoryRow): Finding {
    const rawQual = typeof r.qualification === "string" ? r.qualification : undefined;
    const qualification =
      rawQual === "exploited" || rawQual === "confirmed" || rawQual === "unconfirmed"
        ? (rawQual as FindingQualification)
        : undefined;
    let trafficIds: string[] | undefined;
    if (typeof r.traffic_ids_json === "string" && r.traffic_ids_json.trim()) {
      try {
        const parsed = JSON.parse(r.traffic_ids_json) as unknown;
        if (Array.isArray(parsed) && parsed.length > 0) {
          trafficIds = parsed.map((id) => String(id));
        }
      } catch {
        /* ignore malformed legacy json */
      }
    }
    const summary =
      typeof r.summary === "string" && r.summary.length > 0 ? r.summary : undefined;
    const affectedScope =
      typeof r.affected_scope === "string" && r.affected_scope.length > 0 ? r.affected_scope : undefined;
    const rootCause =
      typeof r.root_cause === "string" && r.root_cause.length > 0 ? r.root_cause : undefined;
    const pocCurl =
      typeof r.poc_curl === "string" && r.poc_curl.length > 0 ? r.poc_curl : undefined;
    const report =
      typeof r.report_md === "string" && r.report_md.length > 0 ? r.report_md : undefined;
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
      verifiedBy: (r.verified_by as string | null) ?? null,
      ...(qualification ? { qualification } : {}),
      ...(trafficIds ? { trafficIds } : {}),
      ...(summary ? { summary } : {}),
      ...(affectedScope ? { affectedScope } : {}),
      ...(rootCause ? { rootCause } : {}),
      ...(pocCurl ? { pocCurl } : {}),
      ...(report ? { report } : {}),
    };
  }
}

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { join } from "node:path";
import {
  CoverageReviewSchema,
  CreateFactReviewSchema,
  FindingValidateRunRequestSchema,
  PeerReviewSchema,
  RetestRequestSchema,
  isTerminalTaskStatus,
  type TaskRecord,
} from "@gongyuai/contracts";
import { computeScorecard, writeTaskReport, type HistoryStore } from "@gongyuai/history";
import { scopeFromTask } from "./knowledge-api.js";
import type { KnowledgeStore } from "./knowledge.js";
import { taskPaths } from "./paths.js";
import { runReconcile } from "./reconcile.js";
import { readJson, sendJson, withTaskHistory, type ControlRouteDeps } from "./routes-ops.js";
import { runIndependentValidation, scheduleAutoValidationsForTask, ValidationBusyError } from "./validate-runner.js";

export function refreshTerminalReport(task: TaskRecord, history: HistoryStore, knowledge: KnowledgeStore): void {
  if (!isTerminalTaskStatus(task.status)) return;
  writeTaskReport(
    { taskId: task.id, dataDir: task.dataDir, auth: task.auth },
    history,
    {
      status: task.status,
      reason: task.error ?? undefined,
      accounting: task,
      materialVersionStatus: (versionId, materialId) =>
        knowledge.version(materialId, versionId, scopeFromTask(task))?.version.status,
    },
  );
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function historyMissing(res: ServerResponse): boolean {
  sendJson(res, 409, { error: "缺少任务历史" });
  return true;
}

/** 结论、复测、复核、覆盖与交付更正。写路径在终态时重渲染报告。 */
export async function handleFindingsRoute(
  req: IncomingMessage,
  res: ServerResponse,
  method: string,
  url: URL,
  deps: ControlRouteDeps,
  task: TaskRecord,
  rest: string,
): Promise<boolean> {
  const { store, knowledge } = deps;
  const paths = taskPaths(task.dataDir);

  if (method === "GET" && rest === "/findings") {
    if (!existsSync(paths.historyDb)) {
      sendJson(res, 200, { findings: [], actions: [], goalFindings: [] });
      return true;
    }
    withTaskHistory(task, { readOnly: true }, (history) => {
      sendJson(res, 200, {
        findings: history.listFindings(task.id),
        actions: history.listFindingActions(task.id),
        goalFindings: history.listGoalFindings(task.id),
      });
    });
    return true;
  }

  const validateRun = /^\/findings\/([^/]+)\/validate-run$/.exec(rest);
  if (method === "POST" && validateRun) {
    const findingId = decodeURIComponent(validateRun[1]!);
    if (!existsSync(paths.historyDb)) return historyMissing(res);
    try {
      const parsed = FindingValidateRunRequestSchema.safeParse(await readJson(req));
      if (!parsed.success) {
        sendJson(res, 400, { error: parsed.error.message });
        return true;
      }
      const body = parsed.data;
      if (body.findingId !== findingId) {
        sendJson(res, 400, { error: "findingId mismatch" });
        return true;
      }
      const result = await runIndependentValidation({
        taskId: task.id,
        taskDir: task.dataDir,
        historyDb: paths.historyDb,
        evidenceDir: paths.evidenceDir,
        targets: task.auth.targets,
        findingId,
        ...(body.force ? { force: true } : {}),
      });
      sendJson(res, result.httpStatus, result.body);
    } catch (err) {
      if (err instanceof ValidationBusyError) {
        sendJson(res, 409, { error: err.message, jobId: err.jobId, status: "running" });
        return true;
      }
      const status = typeof err === "object" && err && "status" in err && typeof err.status === "number" ? err.status : 409;
      sendJson(res, status, { error: errorMessage(err) });
    }
    return true;
  }

  const operatorFinding = /^\/findings\/([^/]+)\/(verify|retract)$/.exec(rest);
  if (method === "POST" && operatorFinding) {
    const findingId = decodeURIComponent(operatorFinding[1]!);
    const action = operatorFinding[2]!;
    const body = await readJson(req) as Record<string, unknown>;
    if (!existsSync(paths.historyDb)) return historyMissing(res);
    try {
      withTaskHistory(task, { readOnly: false }, (history) => {
        if (action === "retract") {
          const reason = typeof body.reason === "string" ? body.reason : "";
          const finding = history.retractFinding(task.id, findingId, reason);
          refreshTerminalReport(task, history, knowledge);
          sendJson(res, 200, { finding });
          return;
        }
        const evidencePaths = Array.isArray(body.evidencePaths)
          ? body.evidencePaths.filter((v): v is string => typeof v === "string")
          : [];
        const finding = history.verifyFinding(task.id, findingId, {
          evidencePaths,
          repro: typeof body.repro === "string" ? body.repro : "",
          impact: typeof body.impact === "string" ? body.impact : undefined,
          fix: typeof body.fix === "string" ? body.fix : undefined,
          pocCurl: typeof body.pocCurl === "string" ? body.pocCurl : undefined,
          verifiedBy: typeof body.verifiedBy === "string" ? body.verifiedBy : "operator:api",
        });
        refreshTerminalReport(task, history, knowledge);
        scheduleAutoValidationsForTask({
          taskId: task.id,
          taskDir: task.dataDir,
          historyDb: paths.historyDb,
          evidenceDir: paths.evidenceDir,
          targets: task.auth.targets,
          findingId: finding.id,
        });
        sendJson(res, 200, { finding });
      });
    } catch (err) {
      sendJson(res, 409, { error: errorMessage(err) });
    }
    return true;
  }

  const findingAction = /^\/findings\/([^/]+)\/(retest|accept|validate)$/.exec(rest);
  if (method === "POST" && findingAction) {
    const findingId = decodeURIComponent(findingAction[1]!);
    const action = findingAction[2]!;
    const body = await readJson(req) as Record<string, unknown>;
    if (!existsSync(paths.historyDb)) return historyMissing(res);
    try {
      withTaskHistory(task, { readOnly: false }, (history) => {
        if (action === "validate") {
          const verdict = body.verdict;
          if (
            verdict !== "confirmed" && verdict !== "refuted" &&
            verdict !== "inconclusive" && verdict !== "out-of-scope"
          ) {
            sendJson(res, 400, { error: "verdict must be confirmed|refuted|inconclusive|out-of-scope" });
            return;
          }
          const validationMethod = body.method;
          if (
            validationMethod !== "evidence-only" && validationMethod !== "replay" &&
            validationMethod !== "control-compare" && validationMethod !== "manual"
          ) {
            sendJson(res, 400, { error: "method must be evidence-only|replay|control-compare|manual" });
            return;
          }
          const evidencePaths = Array.isArray(body.evidencePaths)
            ? body.evidencePaths.filter((v): v is string => typeof v === "string")
            : [];
          const outcome = history.recordFindingValidation(task.id, findingId, {
            verdict,
            method: validationMethod,
            evidencePaths,
            note: typeof body.note === "string" ? body.note : "",
            validator: typeof body.validator === "string" && body.validator.trim() ? body.validator : "operator:local",
          });
          refreshTerminalReport(task, history, knowledge);
          sendJson(res, 201, outcome);
          return;
        }
        if (action === "retest") {
          const result = body.result;
          if (result !== "fixed" && result !== "still-present" && result !== "partially-fixed") {
            sendJson(res, 400, { error: "result must be fixed|still-present|partially-fixed" });
            return;
          }
          const evidencePaths = Array.isArray(body.evidencePaths)
            ? body.evidencePaths.filter((v): v is string => typeof v === "string")
            : [];
          const outcome = history.retestFinding(task.id, findingId, {
            result,
            evidencePaths,
            repro: typeof body.repro === "string" ? body.repro : "",
            note: typeof body.note === "string" ? body.note : undefined,
          });
          const fulfilled = history.fulfillRetestRequests(task.id, findingId, result);
          refreshTerminalReport(task, history, knowledge);
          sendJson(res, 201, { ...outcome, fulfilledRequests: fulfilled });
          return;
        }
        const outcome = history.acceptFinding(task.id, findingId, {
          note: typeof body.note === "string" ? body.note : "",
          evidencePath: typeof body.evidencePath === "string" ? body.evidencePath : "",
        });
        refreshTerminalReport(task, history, knowledge);
        sendJson(res, 201, outcome);
      });
    } catch (err) {
      sendJson(res, 409, { error: errorMessage(err) });
    }
    return true;
  }

  if (method === "GET" && rest === "/snapshot") {
    if (!existsSync(paths.historyDb)) return historyMissing(res);
    withTaskHistory(task, { readOnly: true }, (history) => {
      const snapshot = history.deliverySnapshot(task.id);
      sendJson(res, 200, { snapshot, scorecard: computeScorecard(snapshot) });
    });
    return true;
  }
  if (method === "GET" && rest === "/scorecard") {
    if (!existsSync(paths.historyDb)) return historyMissing(res);
    withTaskHistory(task, { readOnly: true }, (history) => {
      sendJson(res, 200, { scorecard: history.scorecard(task.id) });
    });
    return true;
  }
  if (method === "GET" && rest === "/corrections") {
    if (!existsSync(paths.historyDb)) {
      sendJson(res, 200, { corrections: [] });
      return true;
    }
    withTaskHistory(task, { readOnly: true }, (history) => {
      sendJson(res, 200, { corrections: history.listDeliveryCorrections(task.id) });
    });
    return true;
  }
  if (method === "POST" && rest === "/corrections") {
    const body = await readJson(req) as { reason?: unknown; findings?: unknown; noticeStatus?: unknown };
    const reason = typeof body.reason === "string" ? body.reason : "";
    const findings = Array.isArray(body.findings)
      ? body.findings.filter((id): id is string => typeof id === "string")
      : [];
    const notice = typeof body.noticeStatus === "string" &&
      ["pending", "notified", "confirmed"].includes(body.noticeStatus)
      ? (body.noticeStatus as "pending" | "notified" | "confirmed")
      : "pending";
    if (!existsSync(paths.historyDb)) return historyMissing(res);
    try {
      withTaskHistory(task, { readOnly: false }, (history) => {
        const reportPath = join(task.dataDir, "report.md");
        const report = existsSync(reportPath)
          ? [{ path: "report.md", sha256: createHash("sha256").update(readFileSync(reportPath)).digest("hex") }]
          : [];
        const created = history.recordDeliveryCorrection(task.id, {
          reason,
          ...(findings.length ? { findings } : {}),
          report,
          noticeStatus: notice,
        });
        refreshTerminalReport(task, history, knowledge);
        sendJson(res, created.created ? 201 : 200, { correction: created.correction, created: created.created });
      });
    } catch (err) {
      sendJson(res, 409, { error: errorMessage(err) });
    }
    return true;
  }
  const noticeMatch = /^\/corrections\/([^/]+)\/notice$/.exec(rest);
  if (method === "POST" && noticeMatch) {
    const body = await readJson(req) as { status?: unknown; evidencePath?: unknown };
    const status = typeof body.status === "string" &&
      ["pending", "notified", "confirmed"].includes(body.status)
      ? (body.status as "pending" | "notified" | "confirmed")
      : null;
    if (!status) {
      sendJson(res, 400, { error: "status must be pending|notified|confirmed" });
      return true;
    }
    try {
      withTaskHistory(task, { readOnly: false }, (history) => {
        const updated = history.setDeliveryCorrectionNotice(
          task.id,
          decodeURIComponent(noticeMatch[1]!),
          status,
          typeof body.evidencePath === "string" ? body.evidencePath : undefined,
        );
        refreshTerminalReport(task, history, knowledge);
        sendJson(res, 200, { correction: updated });
      });
    } catch (err) {
      sendJson(res, 409, { error: errorMessage(err) });
    }
    return true;
  }
  if (method === "POST" && rest === "/reconcile") {
    try {
      sendJson(res, 201, runReconcile(task.id, task.dataDir, await readJson(req)));
    } catch (err) {
      const message = errorMessage(err);
      sendJson(res, /ENOENT|no such file/i.test(message) ? 422 : 400, { error: message });
    }
    return true;
  }
  if (method === "GET" && rest === "/reconcile") {
    if (!existsSync(paths.historyDb)) {
      sendJson(res, 200, { results: [] });
      return true;
    }
    withTaskHistory(task, { readOnly: true }, (history) => {
      const results = history.listFacts(task.id)
        .filter((fact) => fact.tags.includes("reconcile"))
        .map((fact) => ({
          factId: fact.id,
          title: fact.title,
          summary: fact.summary,
          evidencePath: fact.evidencePath,
          createdAt: fact.createdAt,
        }));
      sendJson(res, 200, { results });
    });
    return true;
  }
  if (method === "POST" && rest === "/retest-requests") {
    const input = RetestRequestSchema.safeParse(await readJson(req));
    if (!input.success) {
      sendJson(res, 400, { error: input.error.message });
      return true;
    }
    if (!existsSync(paths.historyDb)) return historyMissing(res);
    try {
      withTaskHistory(task, { readOnly: false }, (history) => {
        const request = history.recordRetestRequest(task.id, input.data);
        refreshTerminalReport(task, history, knowledge);
        sendJson(res, 201, { request });
      });
    } catch (err) {
      sendJson(res, 400, { error: errorMessage(err) });
    }
    return true;
  }
  if (method === "GET" && rest === "/retest-requests") {
    if (!existsSync(paths.historyDb)) {
      sendJson(res, 200, { requests: [] });
      return true;
    }
    withTaskHistory(task, { readOnly: true }, (history) => {
      sendJson(res, 200, { requests: history.listRetestRequests(task.id) });
    });
    return true;
  }
  if (method === "POST" && rest === "/peer-reviews") {
    const input = PeerReviewSchema.safeParse(await readJson(req));
    if (!input.success) {
      sendJson(res, 400, { error: input.error.message });
      return true;
    }
    if (input.data.sourceTaskId === task.id) {
      sendJson(res, 400, { error: "跨任务署名复核要求 sourceTaskId 与当前任务不同；本任务内复核用 /reviews" });
      return true;
    }
    const source = store.get(input.data.sourceTaskId);
    if (!source) {
      sendJson(res, 404, { error: "源任务不存在" });
      return true;
    }
    if (source.engagementId !== task.engagementId) {
      sendJson(res, 409, { error: `跨委托复核被拒绝：源任务委托 ${source.engagementId} ≠ 当前委托 ${task.engagementId}` });
      return true;
    }
    if (!existsSync(paths.historyDb)) return historyMissing(res);
    try {
      withTaskHistory(task, { readOnly: false }, (history) => {
        if (input.data.findingId) {
          const sourcePaths = taskPaths(source.dataDir);
          if (!existsSync(sourcePaths.historyDb)) {
            sendJson(res, 409, { error: "源任务缺少历史" });
            return;
          }
          const missing = withTaskHistory(source, { readOnly: true }, (sourceHistory) =>
            !sourceHistory.getFinding(source.id, input.data.findingId!),
          );
          if (missing) {
            sendJson(res, 400, { error: `源任务中不存在该结论：${input.data.findingId}` });
            return;
          }
        }
        const review = history.recordPeerReview(task.id, task.engagementId, input.data);
        refreshTerminalReport(task, history, knowledge);
        sendJson(res, 201, { review });
      });
    } catch (err) {
      sendJson(res, 400, { error: errorMessage(err) });
    }
    return true;
  }
  if (method === "GET" && rest === "/peer-reviews") {
    if (!existsSync(paths.historyDb)) {
      sendJson(res, 200, { reviews: [] });
      return true;
    }
    withTaskHistory(task, { readOnly: true }, (history) => {
      sendJson(res, 200, { reviews: history.listPeerReviews(task.id) });
    });
    return true;
  }
  if (method === "POST" && rest === "/coverage") {
    const input = CoverageReviewSchema.safeParse(await readJson(req));
    if (!input.success) {
      sendJson(res, 400, { error: input.error.message });
      return true;
    }
    if (!existsSync(paths.historyDb)) return historyMissing(res);
    try {
      withTaskHistory(task, { readOnly: false }, (history) => {
        const coverage = history.recordCoverage(task.id, input.data);
        refreshTerminalReport(task, history, knowledge);
        sendJson(res, 201, { coverage });
      });
    } catch (err) {
      sendJson(res, 400, { error: String(err) });
    }
    return true;
  }
  if (method === "POST" && rest === "/reviews") {
    const input = CreateFactReviewSchema.safeParse(await readJson(req));
    if (!input.success) {
      sendJson(res, 400, { error: input.error.message });
      return true;
    }
    withTaskHistory(task, { readOnly: false }, (history) => {
      let review;
      try {
        review = history.appendReview(task.id, input.data);
      } catch (err) {
        sendJson(res, 400, { error: String(err) });
        return;
      }
      refreshTerminalReport(task, history, knowledge);
      sendJson(res, 201, { review });
    });
    return true;
  }
  return false;
}

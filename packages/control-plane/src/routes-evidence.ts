import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { join } from "node:path";
import {
  CreateHintRequestSchema,
  isTerminalTaskStatus,
  type TaskIntegrationUsage,
  type TaskRecord,
} from "@gongyuai/contracts";
import { getTraffic, queryFromSearchParams, readTrafficBody } from "@gongyuai/exec";
import {
  describeGoalEvidence,
  listEvidenceFiles,
  listExecutionSteps,
  minimatch,
  readEvidenceBytes,
  readEvidenceFile,
  readExecutionStepCalls,
  removeEvidenceFile,
  resolveEvidenceFile,
  writeEvidenceFile,
} from "@gongyuai/history";
import { taskPaths } from "./paths.js";
import { refreshTerminalReport } from "./routes-findings.js";
import { readJson, sendJson, withTaskHistory, type ControlRouteDeps } from "./routes-ops.js";
import { readCheckpointGraph, refreshTaskUsage } from "./usage.js";

const EMPTY_HISTORY = {
  overview: "",
  goals: [],
  facts: [],
  reviews: [],
  goalProofs: [],
  coverage: [],
  intents: [],
  events: [],
  assets: [],
  hints: [],
  findings: [],
  retestRequests: [],
  peerReviews: [],
};

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function httpStatus(err: unknown, fallback: number): number {
  return typeof err === "object" && err && "status" in err && typeof err.status === "number" ? err.status : fallback;
}

/** 证据、流量、轨迹、History 投影与运行时只读面。读 History 一律 readOnly。 */
export async function handleEvidenceRoute(
  req: IncomingMessage,
  res: ServerResponse,
  method: string,
  url: URL,
  deps: ControlRouteDeps,
  task: TaskRecord,
  rest: string,
): Promise<boolean> {
  const { store, runner, knowledge } = deps;
  const paths = taskPaths(task.dataDir);

  if (method === "GET" && rest === "/traffic") {
    try {
      sendJson(res, 200, queryFromSearchParams(task.dataDir, task.id, url.searchParams));
    } catch (err) {
      sendJson(res, 400, { error: errorMessage(err) });
    }
    return true;
  }
  const trafficBlob = /^\/traffic\/([^/]+)\/blob$/.exec(rest);
  if (method === "GET" && trafficBlob) {
    const side = url.searchParams.get("side");
    if (side !== "req" && side !== "res") {
      sendJson(res, 400, { error: "side must be req or res" });
      return true;
    }
    const offset = Number(url.searchParams.get("offset") ?? "0");
    const maxRaw = url.searchParams.get("maxBytes");
    const maxBytes = maxRaw == null || maxRaw === "" ? undefined : Number(maxRaw);
    try {
      const slice = readTrafficBody(task.dataDir, decodeURIComponent(trafficBlob[1]!), side, offset, maxBytes);
      sendJson(res, 200, {
        sha256: slice.sha256,
        side: slice.side,
        offset: slice.offset,
        size: slice.size,
        byteLength: slice.bytes.length,
        ...(slice.rawSize != null ? { rawSize: slice.rawSize } : {}),
        ...(slice.decodedEncoding ? { decodedEncoding: slice.decodedEncoding } : {}),
        ...(slice.contentType ? { contentType: slice.contentType } : {}),
        body: slice.body,
        bytes: slice.bytes.toString("base64"),
        nextOffset: slice.nextOffset,
        evidenceRef: slice.evidenceRef,
      });
    } catch (err) {
      sendJson(res, httpStatus(err, 400), { error: errorMessage(err) });
    }
    return true;
  }
  const trafficOne = /^\/traffic\/([^/]+)$/.exec(rest);
  if (method === "GET" && trafficOne) {
    const record = getTraffic(task.dataDir, decodeURIComponent(trafficOne[1]!));
    if (!record || record.taskId !== task.id) {
      sendJson(res, 404, { error: "traffic not found" });
      return true;
    }
    sendJson(res, 200, { traffic: record, evidenceRef: `http:${record.id}` });
    return true;
  }

  const version = /^\/report-evidence\/([a-f0-9]{64})$/.exec(rest);
  if (method === "GET" && version) {
    if (!existsSync(paths.historyDb)) {
      sendJson(res, 404, { error: "unknown evidence version" });
      return true;
    }
    withTaskHistory(task, { readOnly: true }, (history) => {
      const bytes = history.readProofVersion(task.id, version[1]!);
      if (!bytes) {
        sendJson(res, 404, { error: "unknown evidence version" });
        return;
      }
      res.writeHead(200, {
        "content-type": "application/octet-stream",
        "content-disposition": "attachment",
        "x-content-type-options": "nosniff",
      });
      res.end(bytes);
    });
    return true;
  }

  if (method === "GET" && rest === "/history") {
    if (!existsSync(paths.historyDb)) {
      sendJson(res, 200, EMPTY_HISTORY);
      return true;
    }
    withTaskHistory(task, { readOnly: true }, (history) => {
      const reviews = history.listReviews(task.id);
      const goalProofs = history.listGoalProofs(task.id);
      sendJson(res, 200, {
        overview: history.overview(task.id),
        goals: history.listGoals(task.id).map((goal) => ({
          ...goal,
          assessment: describeGoalEvidence(goal, goalProofs, reviews),
          reconcileState: history.goalReconcileState(task.id, goal.id),
        })),
        reconcileRevisions: history.listReconcileRevisions(task.id),
        facts: history.listFacts(task.id),
        reviews,
        goalProofs,
        coverage: history.listCoverage(task.id),
        intents: history.listIntents(task.id),
        events: history.listEvents(task.id, 100),
        assets: history.listAssets(task.id),
        hints: history.listHints(task.id, 50),
        findings: history.listFindings(task.id),
        dag: history.dagExport(task.id),
        retestRequests: history.listRetestRequests(task.id),
        peerReviews: history.listPeerReviews(task.id),
      });
    });
    return true;
  }
  if (method === "GET" && rest === "/hints") {
    if (!existsSync(paths.historyDb)) {
      sendJson(res, 200, { hints: [] });
      return true;
    }
    withTaskHistory(task, { readOnly: true }, (history) => {
      sendJson(res, 200, { hints: history.listHints(task.id, 100) });
    });
    return true;
  }
  if (method === "POST" && rest === "/hints") {
    const body = CreateHintRequestSchema.parse(await readJson(req));
    withTaskHistory(task, { readOnly: false }, (history) => {
      const hint = history.appendHint({
        taskId: task.id,
        text: body.text,
        source: body.source,
        tags: body.tags,
      });
      sendJson(res, 201, { hint });
    });
    return true;
  }
  if (method === "GET" && rest === "/assets") {
    // 打开可写连接会建库，所以是否补种目标要在打开之前判断。
    const missingHistory = !existsSync(paths.historyDb);
    withTaskHistory(task, { readOnly: false }, (history) => {
      if (missingHistory) history.seedGoals(task.id, task.goals);
      history.seedAssetsFromAuth(task.id, task.auth);
      sendJson(res, 200, { assets: history.listAssets(task.id) });
    });
    return true;
  }
  if (method === "POST" && rest === "/evidence") {
    const body = await readJson(req) as { path?: unknown; content?: unknown };
    if (typeof body.path !== "string" || typeof body.content !== "string") {
      sendJson(res, 400, { error: "path and content (utf8 text) are required" });
      return true;
    }
    const evidencePath = body.path;
    const content = body.content;
    const { evidenceDir, historyDb } = paths;
    let replaced = false;
    try {
      resolveEvidenceFile(evidenceDir, evidencePath);
      replaced = true;
    } catch {
      replaced = false;
    }
    try {
      const written = writeEvidenceFile(evidenceDir, evidencePath, content);
      const sha256 = createHash("sha256").update(Buffer.from(content, "utf8")).digest("hex");
      if (existsSync(historyDb)) {
        withTaskHistory(task, { readOnly: false }, (history) => {
          history.recordEvent(task.id, "evidence_written", {
            path: written,
            sha256,
            bytes: Buffer.byteLength(content, "utf8"),
            replaced,
            source: "console",
          });
        });
      }
      sendJson(res, 201, { path: written, sha256, replaced });
    } catch (err) {
      sendJson(res, 400, { error: errorMessage(err) });
    }
    return true;
  }
  if (method === "DELETE" && rest === "/evidence") {
    const rel = url.searchParams.get("path");
    if (!rel) {
      sendJson(res, 400, { error: "path is required" });
      return true;
    }
    const { evidenceDir, historyDb } = paths;
    let sha256: string | null = null;
    try {
      sha256 = createHash("sha256").update(readEvidenceBytes(evidenceDir, rel)).digest("hex");
      removeEvidenceFile(evidenceDir, rel);
    } catch (err) {
      const message = errorMessage(err);
      sendJson(res, /ENOENT|no such file/i.test(message) ? 404 : 400, { error: message });
      return true;
    }
    if (existsSync(historyDb)) {
      withTaskHistory(task, { readOnly: false }, (history) => {
        history.recordEvent(task.id, "evidence_removed", { path: rel, sha256, source: "console" });
      });
    }
    sendJson(res, 200, { removed: rel, sha256 });
    return true;
  }
  if (method === "POST" && rest === "/goals/assert") {
    const body = await readJson(req) as { goalId?: unknown };
    const goalId = typeof body.goalId === "string" ? body.goalId.trim() : "";
    if (!goalId) {
      sendJson(res, 400, { error: "goalId is required" });
      return true;
    }
    if (!existsSync(paths.historyDb)) {
      sendJson(res, 409, { error: "缺少任务历史" });
      return true;
    }
    withTaskHistory(task, { readOnly: false }, (history) => {
      const goal = history.listGoals(task.id).find((entry) => entry.id === goalId);
      if (!goal) {
        sendJson(res, 404, { error: `unknown goal: ${goalId}` });
        return;
      }
      history.recordEvent(task.id, "goal_assert_requested", { goalId, source: "console" });
      const evidencePaths = listEvidenceFiles(paths.evidenceDir).filter((path) =>
        goal.evidencePatterns.length === 0 ||
        goal.evidencePatterns.some((pattern) => minimatch(path, pattern)),
      );
      const outcome = history.assertGoal(task.id, goalId, evidencePaths);
      const state = history.goalReconcileState(task.id, goalId);
      refreshTerminalReport(task, history, knowledge);
      sendJson(res, outcome.ok ? 200 : 409, {
        ok: outcome.ok,
        goal: outcome.ok ? outcome.goal : goal,
        ...(outcome.ok ? {} : { reason: outcome.reason }),
        reconcileState: state,
      });
    });
    return true;
  }
  if (method === "GET" && rest === "/evidence") {
    const files = listEvidenceFiles(paths.evidenceDir).flatMap((path) => {
      try {
        const { stat } = resolveEvidenceFile(paths.evidenceDir, path);
        return [{ path, size: stat.size, mtime: stat.mtime.toISOString() }];
      } catch {
        return [];
      }
    });
    sendJson(res, 200, { files });
    return true;
  }
  if (method === "GET" && rest.startsWith("/evidence/file")) {
    const rel = url.searchParams.get("path");
    if (!rel) {
      sendJson(res, 400, { error: "bad path" });
      return true;
    }
    const allowWorkspaceFallback = url.searchParams.get("fallbackWorkspace") === "1";
    let content: string | undefined;
    let source: "evidence" | "workspace" = "evidence";
    try {
      content = readEvidenceFile(paths.evidenceDir, rel);
    } catch {
      if (allowWorkspaceFallback) {
        try {
          content = readEvidenceFile(paths.workspaceDir, rel);
          source = "workspace";
        } catch {
          /* fall through to 404 */
        }
      }
    }
    if (content === undefined) {
      sendJson(res, 404, { error: "not found" });
      return true;
    }
    res.writeHead(200, {
      "content-type": "text/plain; charset=utf-8",
      "x-gy-evidence-source": source,
    });
    res.end(content);
    return true;
  }
  if (method === "GET" && rest === "/trace") {
    const cursor = url.searchParams.get("before");
    const before = cursor === null ? undefined : Number(cursor);
    if (before !== undefined && (!Number.isSafeInteger(before) || before <= 0)) {
      sendJson(res, 400, { error: "invalid trace cursor" });
      return true;
    }
    sendJson(res, 200, listExecutionSteps(task.dataDir, before));
    return true;
  }
  const traceMatch = rest.match(/^\/trace\/([^/]+)$/);
  if (method === "GET" && traceMatch) {
    const calls = readExecutionStepCalls(task.dataDir, decodeURIComponent(traceMatch[1]!));
    res.setHeader("cache-control", "no-store");
    if (calls === null) sendJson(res, 404, { error: "step not found" });
    else sendJson(res, 200, { calls });
    return true;
  }
  if (method === "GET" && rest === "/runtime") {
    const statusPath = join(task.dataDir, "worker-status.json");
    const ckptPath = `${paths.durableDb}.ckpt.sqlite`;
    const progressPath = join(paths.workspaceDir, "PROGRESS.md");
    let progress: string[] = [];
    if (existsSync(progressPath)) {
      progress = readFileSync(progressPath, "utf8")
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l.startsWith("- "))
        .map((l) => l.slice(2))
        .slice(-40);
    }
    const checkpointGraph = readCheckpointGraph(task.dataDir);
    let integrations: TaskIntegrationUsage = { since: null, rows: [] };
    let recentFacts: Array<{ id: string; title: string; summary: string; layer: string; createdAt: string }> = [];
    let recentIntents: Array<{ title: string; status: string }> = [];
    if (existsSync(paths.historyDb)) {
      withTaskHistory(task, { readOnly: true }, (history) => {
        integrations = history.integrationUsage(task.id);
        recentFacts = history.listFacts(task.id).slice(-30).reverse().map((f) => ({
          id: f.id,
          title: f.title,
          summary: f.summary,
          layer: f.layer,
          createdAt: f.createdAt,
        }));
        recentIntents = history.listIntents(task.id).slice(-20).reverse().map((i) => ({
          title: i.title,
          status: i.status,
        }));
      });
    }
    const before = task.usage;
    const mergedUsage = refreshTaskUsage(task);
    if (
      mergedUsage.tokens !== before.tokens ||
      mergedUsage.toolCalls !== before.toolCalls ||
      mergedUsage.installs !== before.installs
    ) {
      store.save(task);
    }
    let workerSnapshot: Record<string, unknown> = {};
    if (existsSync(statusPath)) {
      try {
        const parsed: unknown = JSON.parse(readFileSync(statusPath, "utf8"));
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          workerSnapshot = parsed as Record<string, unknown>;
        }
      } catch {
        /* ignore */
      }
    }
    const terminal = isTerminalTaskStatus(task.status);
    const alive = runner.isAlive(task);
    const externalState = terminal
      ? "stopped"
      : task.status === "paused"
        ? "paused"
        : task.status === "pause_requested"
          ? "pause_requested"
          : task.status === "stopping"
            ? "stopping"
            : alive
              ? "running"
              : "unknown";
    const workerStatus = {
      ...workerSnapshot,
      status: terminal ? task.status : workerSnapshot.status ?? task.status,
      error: terminal ? task.error : workerSnapshot.error,
      usage: mergedUsage,
      phase: workerSnapshot.phase ?? checkpointGraph.phase,
      activeIntentId: terminal ? null
        : "activeIntentId" in workerSnapshot ? workerSnapshot.activeIntentId : checkpointGraph.activeIntentId,
      updatedAt: (terminal ? task.finishedAt : workerSnapshot.updatedAt) ?? task.updatedAt,
    };
    sendJson(res, 200, {
      externalState,
      lastConfirmedAt: task.lastHeartbeatAt ?? (workerSnapshot.updatedAt as string | undefined) ?? task.updatedAt,
      scopeVersion: task.scopeVersion,
      leaseOwner: task.leaseOwner,
      leaseUntil: task.leaseUntil,
      fence: task.fence,
      workerPid: task.workerPid,
      workerPids: task.workerPids ?? [],
      containerId: task.containerId,
      containerIds: task.containerIds ?? [],
      execution: task.execution,
      phase: checkpointGraph.phase,
      activeIntentId: checkpointGraph.activeIntentId,
      workerStatus,
      hasCheckpoint: existsSync(ckptPath) || existsSync(paths.durableDb),
      dataDir: task.dataDir,
      progress,
      trace: listExecutionSteps(task.dataDir),
      integrations,
      recentFacts,
      recentIntents,
      usage: mergedUsage,
    });
    return true;
  }
  return false;
}

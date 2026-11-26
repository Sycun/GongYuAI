import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { join } from "node:path";
import {
  CreateTaskRequestSchema,
  TaskArchiveBatchSchema,
  UpdateScopeRequestSchema,
  isActiveTaskStatus,
  isTerminalTaskStatus,
  type TaskArchiveState,
  type TaskRecord,
} from "@gongyuai/contracts";
import { authorizationDigest, currentRecord } from "./authorization.js";
import { deliverySummary } from "./delivery.js";
import { taskPaths } from "./paths.js";
import { handleEvidenceRoute } from "./routes-evidence.js";
import { handleFindingsRoute } from "./routes-findings.js";
import { readJson, sendJson, withTaskHistory, type ControlRouteDeps } from "./routes-ops.js";
import type { ControlStore } from "./store.js";
import { refreshTaskUsage } from "./usage.js";

function jsonBody(req: IncomingMessage): boolean {
  return req.headers["content-type"]?.split(";")[0]?.trim() === "application/json";
}

function taskArchiveState(task: TaskRecord): TaskArchiveState {
  return {
    id: task.id,
    name: task.name,
    status: task.status,
    archivedAt: task.archivedAt,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    submissionKey: task.assignment?.requestId,
  };
}

/** Prefer shared worker.log; fall back to concatenating per-slot logs. */
function readTaskWorkerLogs(dataDir: string): string {
  if (!existsSync(dataDir)) return "";
  const shared = join(dataDir, "worker.log");
  if (existsSync(shared)) return readFileSync(shared, "utf8");
  const slotLogs = readdirSync(dataDir).filter((n) => /^worker-w\d+\.log$/.test(n)).sort();
  if (slotLogs.length === 0) return "";
  return slotLogs
    .map((n) => `===== ${n} =====\n${readFileSync(join(dataDir, n), "utf8")}`)
    .join("\n");
}

/** 任务视图里的目标状态以 History 为准（作业/操作员判定都可能晚于建档）。 */
function withLiveGoals(task: TaskRecord): TaskRecord {
  try {
    const paths = taskPaths(task.dataDir);
    if (!existsSync(paths.historyDb)) return task;
    return withTaskHistory(task, { readOnly: true }, (history) => ({ ...task, goals: history.listGoals(task.id) }));
  } catch {
    return task;
  }
}

function persistUsage(store: ControlStore, task: TaskRecord): void {
  const before = task.usage;
  const usage = refreshTaskUsage(task);
  if (
    usage.tokens !== before.tokens ||
    usage.toolCalls !== before.toolCalls ||
    usage.installs !== before.installs
  ) {
    store.save(task);
  }
}

/**
 * 列表轮询对终态任务只在首次收敛时读盘：补齐最终用量和 History 目标。
 * 之后同一 status / finishedAt / updatedAt / 用量直接返回快照。
 * 详情 GET /tasks/:id 仍每次合并 History。
 */
type TerminalListSnapshot = { signature: string; task: TaskRecord };
const terminalListCache = new Map<string, TerminalListSnapshot>();

function historyMtimeSignature(dataDir: string): string {
  const { historyDb } = taskPaths(dataDir);
  const mainMtime = statSync(historyDb, { throwIfNoEntry: false })?.mtimeMs ?? 0;
  const walMtime = statSync(`${historyDb}-wal`, { throwIfNoEntry: false })?.mtimeMs ?? 0;
  return `${mainMtime}:${walMtime}`;
}

function terminalSignature(task: TaskRecord): string {
  const usage = task.usage;
  return [
    task.status,
    task.finishedAt ?? "",
    task.updatedAt,
    usage.tokens,
    usage.toolCalls,
    usage.installs,
    historyMtimeSignature(task.dataDir),
  ].join("|");
}

function projectListedTask(store: ControlStore, task: TaskRecord): TaskRecord {
  if (!isTerminalTaskStatus(task.status)) {
    terminalListCache.delete(task.id);
    persistUsage(store, task);
    return withLiveGoals(task);
  }
  const signature = terminalSignature(task);
  const cached = terminalListCache.get(task.id);
  if (cached?.signature === signature) return cached.task;
  persistUsage(store, task);
  const projected = withLiveGoals(task);
  terminalListCache.set(task.id, { signature: terminalSignature(projected), task: projected });
  return projected;
}

export async function handleTaskRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  method: string,
  url: URL,
  deps: ControlRouteDeps,
): Promise<boolean> {
  const { store, runner, jobs, assignments } = deps;

  if (method === "POST" && url.pathname === "/tasks/submit") {
    if (!jsonBody(req)) {
      sendJson(res, 415, { error: "请使用 JSON 提交任务。" });
      return true;
    }
    sendJson(res, 202, await assignments.accept(await readJson(req, 8 * 1024 * 1024)));
    return true;
  }
  const submission = url.pathname.match(/^\/tasks\/submissions\/([a-f\d]{32})$/);
  if (method === "GET" && submission) {
    const task = store.findSubmission(submission[1]!);
    sendJson(res, task ? 200 : 404, task ? assignments.view(task) : { error: "服务器尚无该提交记录" });
    return true;
  }
  if (url.pathname === "/tasks/archives") {
    if (method === "GET") {
      sendJson(res, 200, { tasks: store.list().map(taskArchiveState) });
      return true;
    }
    if (method === "POST") {
      if (!jsonBody(req)) {
        sendJson(res, 415, { error: "请使用 JSON 请求。" });
        return true;
      }
      const { taskIds, archived } = TaskArchiveBatchSchema.parse(await readJson(req, 1024 * 1024));
      sendJson(res, 200, { tasks: store.setArchivedBatch(taskIds, archived).map(taskArchiveState) });
      return true;
    }
  }
  if (method === "GET" && url.pathname === "/tasks") {
    const listed = store.list();
    const seen = new Set(listed.map((task) => task.id));
    for (const id of terminalListCache.keys()) {
      if (!seen.has(id)) terminalListCache.delete(id);
    }
    sendJson(res, 200, { tasks: listed.map((task) => projectListedTask(store, task)) });
    return true;
  }
  if (method === "POST" && url.pathname === "/tasks") {
    const body = CreateTaskRequestSchema.parse(await readJson(req));
    const task = store.createTask(body);
    withTaskHistory(task, { readOnly: false }, (history) => {
      history.seedGoals(task.id, task.goals);
      history.seedAssetsFromAuth(task.id, task.auth);
    });
    const started = await runner.start(task.id);
    sendJson(res, 201, { task: started });
    return true;
  }

  const taskMatch = url.pathname.match(/^\/tasks\/([^/]+)(\/.*)?$/);
  if (!taskMatch) return false;
  const taskId = decodeURIComponent(taskMatch[1]!);
  const rest = taskMatch[2] ?? "";
  const task = store.get(taskId);
  if (!task) {
    sendJson(res, 404, { error: "not found" });
    return true;
  }

  if (rest === "/authorization") {
    if (method === "GET") {
      sendJson(res, 200, { taskId: task.id, authorization: currentRecord(task), digest: authorizationDigest(task) });
      return true;
    }
    sendJson(res, 410, {
      error: "授权登记已移除（P16）：目标进入任务即视为授权，不再登记授权。更新任务坐标请用 POST /tasks/:id/scope，或在会话里回复「目标: <目标>，继续」。",
    });
    return true;
  }
  if (method === "POST" && rest === "/command") {
    if (!task.assignment) {
      sendJson(res, 409, { error: "只有工作区任务支持手动指定命令" });
      return true;
    }
    try {
      const body = await readJson(req, 64 * 1024) as { command?: unknown; purpose?: unknown };
      const command = typeof body.command === "string" ? body.command : "";
      const purpose = typeof body.purpose === "string" ? body.purpose : undefined;
      sendJson(res, 200, { task: await assignments.submitCommand(task.id, command, purpose) });
    } catch (err) {
      sendJson(res, 400, { error: err instanceof Error ? err.message : String(err) });
    }
    return true;
  }
  const reviewAction = /^\/command-review\/(approve|reject|retry)$/.exec(rest);
  if (method === "POST" && reviewAction) {
    const action = reviewAction[1]!;
    const decided = task.assignment
      ? (action === "retry"
        ? await assignments.retryCommand(taskId)
        : await assignments.decideCommand(taskId, action === "approve"))
      : (action === "retry"
        ? await runner.retryCommand(taskId)
        : action === "approve"
          ? await runner.approveCommand(taskId)
          : await runner.rejectCommand(taskId));
    sendJson(res, 200, { task: decided });
    return true;
  }
  if (task.assignment) {
    if (method === "GET" && rest === "/assignment") {
      sendJson(res, 200, assignments.view(task));
      return true;
    }
    if (method === "POST" && (rest === "/pause" || rest === "/stop")) {
      if (!isActiveTaskStatus(task.status)) {
        sendJson(res, 409, { error: "任务当前未在执行" });
        return true;
      }
      sendJson(res, 200, { task: assignments.interrupt(task, rest === "/pause" ? "paused" : "stopped", "操作员已中断任务") });
      return true;
    }
    if (method === "POST" && (rest === "/start" || rest === "/resume")) {
      sendJson(res, 200, { task: assignments.start(task) });
      return true;
    }
  }
  if (method === "GET" && rest === "") {
    persistUsage(store, task);
    const base = task.runStartUsage;
    const runUsage = {
      tokens: task.usage.tokens - (base?.tokens ?? 0),
      toolCalls: task.usage.toolCalls - (base?.toolCalls ?? 0),
      installs: task.usage.installs - (base?.installs ?? 0),
    };
    sendJson(res, 200, { task: { ...withLiveGoals(task), runUsage } });
    return true;
  }
  if (method === "POST" && rest === "/stop") {
    const stopped = await runner.stop(taskId);
    const canceled = jobs.cancelTaskJobs(taskId, "task-stopped");
    sendJson(res, 200, { task: stopped, canceledJobs: canceled });
    return true;
  }
  if (method === "POST" && rest === "/start") {
    sendJson(res, 200, { task: await runner.start(taskId) });
    return true;
  }
  if (method === "POST" && rest === "/pause") {
    try {
      const paused = await runner.pause(taskId);
      sendJson(res, 200, { task: paused, jobs: jobs.pauseTask(taskId) });
    } catch (err) {
      sendJson(res, 409, { error: err instanceof Error ? err.message : String(err) });
    }
    return true;
  }
  if (method === "POST" && rest === "/resume") {
    try {
      const resumed = await runner.resume(taskId);
      sendJson(res, 200, { task: resumed, jobs: jobs.resumeTask(taskId) });
    } catch (err) {
      sendJson(res, 409, { error: err instanceof Error ? err.message : String(err) });
    }
    return true;
  }
  if (method === "POST" && rest === "/scope") {
    const input = UpdateScopeRequestSchema.safeParse(await readJson(req));
    if (!input.success) {
      sendJson(res, 400, { error: input.error.message });
      return true;
    }
    try {
      const updated = runner.setScope(taskId, input.data.auth, input.data.reason);
      const paths = taskPaths(updated.dataDir);
      if (existsSync(paths.historyDb)) {
        withTaskHistory(updated, { readOnly: false }, (history) => {
          history.appendFact({
            taskId,
            layer: "summary",
            title: `授权范围更新至 v${updated.scopeVersion}`,
            summary: `目标：${updated.auth.targets.join("、")}；排除：${updated.auth.outOfScope.join("、") || "未列出"}；原因：${input.data.reason}`,
            tags: ["system", "scope", `scopeVersion:${updated.scopeVersion}`],
          });
        });
      }
      sendJson(res, 200, { task: updated });
    } catch (err) {
      sendJson(res, 409, { error: err instanceof Error ? err.message : String(err) });
    }
    return true;
  }
  if (method === "POST" && rest === "/archive") {
    try {
      sendJson(res, 200, { task: store.setArchived(taskId, true) });
    } catch (err) {
      sendJson(res, 400, { error: err instanceof Error ? err.message : String(err) });
    }
    return true;
  }
  if (method === "POST" && rest === "/unarchive") {
    sendJson(res, 200, { task: store.setArchived(taskId, false) });
    return true;
  }
  if (method === "GET" && rest === "/logs") {
    const text = readTaskWorkerLogs(task.dataDir);
    res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
    res.end(text.slice(-200_000));
    return true;
  }
  if (method === "GET" && rest === "/delivery") {
    const hasReport = existsSync(taskPaths(task.dataDir).reportPath);
    sendJson(res, 200, { summary: deliverySummary(task, hasReport), hasReport });
    return true;
  }
  if (method === "GET" && rest === "/report") {
    const reportPath = join(task.dataDir, "report.md");
    const text = existsSync(reportPath)
      ? readFileSync(reportPath, "utf8")
      : isTerminalTaskStatus(task.status) ? deliverySummary(task, false) : "";
    res.writeHead(200, { "content-type": "text/markdown; charset=utf-8" });
    res.end(text);
    return true;
  }

  if (await handleFindingsRoute(req, res, method, url, deps, task, rest)) return true;
  if (await handleEvidenceRoute(req, res, method, url, deps, task, rest)) return true;
  return false;
}

import { createHash } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  AddAssetCollectorSchema,
  AddUserMcpSchema,
  AssetCollectorPatchSchema,
  CreateFactReviewSchema,
  CoverageReviewSchema,
  CreateHintRequestSchema,
  CreateTaskRequestSchema,
  isActiveTaskStatus,
  isTerminalTaskStatus,
  ImportSkillSchema,
  ModelSettingsPatchSchema,
  PeerReviewSchema,
  RetestRequestSchema,
  TaskArchiveBatchSchema,
  type TaskArchiveState,
  ToggleToolsItemSchema,
  type TaskIntegrationUsage,
  type TaskRecord,
  ToolsSettingsPatchSchema,
  ChatApprovalSchema,
  ChatConnectionSchema,
  ChatProfileSchema,
  UpdateScopeRequestSchema,
  UpdateSettingsPatchSchema,
  FindingValidateRunRequestSchema,
  KnowledgeEmbeddingPatchSchema,
  KnowledgeEmbeddingTestSchema,
} from "@gongyuai/contracts";
import { getTraffic, queryFromSearchParams, readTrafficBody } from "@gongyuai/exec";
import {
  computeScorecard,
  describeGoalEvidence,
  listEvidenceFiles,
  minimatch,
  listExecutionSteps,
  openHistory,
  readEvidenceBytes,
  readEvidenceFile,
  removeEvidenceFile,
  readExecutionStepCalls,
  resolveEvidenceFile,
  writeEvidenceFile,
  writeTaskReport,
} from "@gongyuai/history";
import { AssignmentService } from "./assignments.js";
import { authorizationDigest, currentRecord } from "./authorization.js";
import { queryChatModels } from "./chat-provider.js";
import { deliverySummary } from "./delivery.js";
import { handleOpsRoute } from "./routes-ops.js";
import { KnowledgeStore } from "./knowledge.js";
import { resolveEmbeddingRuntime, testEmbeddingConnection } from "./knowledge-embed.js";
import { routeKnowledge, scopeFromTask } from "./knowledge-api.js";
import type { JobRunner } from "./jobs.js";
import type { PlatformStore } from "./platform.js";
import { projectIntegrationUsage } from "./integration-usage.js";
import { runReconcile } from "./reconcile.js";
import { taskPaths } from "./paths.js";
import { readCheckpointGraph, refreshTaskUsage } from "./usage.js";
import type { ControlStore } from "./store.js";
import type { WorkerRunner } from "./runner.js";
import type { SettingsStore } from "./settings.js";
import type { SilentUpdater } from "./updater.js";
import { runIndependentValidation, ValidationBusyError } from "./validate-runner.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const webRoot = join(__dirname, "..", "web");

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".map": "application/json",
  ".ico": "image/x-icon",
};

export type ServerOptions = {
  host: string;
  port: number;
  store: ControlStore;
  runner: WorkerRunner;
  settings: SettingsStore;
  updater: SilentUpdater;
  version: string;
  /** 第九轮：平台记忆/飞轮库与持久作业执行器。 */
  platform: PlatformStore;
  jobs: JobRunner;
  knowledge: KnowledgeStore;
};

async function readJson(req: IncomingMessage, maxBytes = Infinity): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buf.length;
    if (size > maxBytes) throw new Error("任务材料超出大小限制");
    chunks.push(buf);
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw) return {};
  return JSON.parse(raw);
}

function send(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body, null, 2);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

/** Prefer shared worker.log; fall back to concatenating per-slot logs. */
function readTaskWorkerLogs(dataDir: string): string {
  if (!existsSync(dataDir)) return "";
  const shared = join(dataDir, "worker.log");
  if (existsSync(shared)) {
    return readFileSync(shared, "utf8");
  }
  const slotLogs = readdirSync(dataDir)
    .filter((n) => /^worker-w\d+\.log$/.test(n))
    .sort();
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
    const history = openHistory({ dbPath: paths.historyDb, evidenceDir: paths.evidenceDir, readOnly: true });
    try {
      return { ...task, goals: history.listGoals(task.id) };
    } finally {
      history.close();
    }
  } catch {
    return task;
  }
}

function taskArchiveState(task: TaskRecord): TaskArchiveState {
  return { id: task.id, name: task.name, status: task.status, archivedAt: task.archivedAt, submissionKey: task.assignment?.requestId };
}

function sendFile(res: ServerResponse, abs: string, cache = false): boolean {
  if (!abs.startsWith(webRoot) || !existsSync(abs) || !statSync(abs).isFile()) {
    return false;
  }
  const ext = abs.slice(abs.lastIndexOf("."));
  const body = readFileSync(abs);
  res.writeHead(200, {
    "content-type": MIME[ext] ?? "application/octet-stream",
    "content-length": body.length,
    "cache-control": cache ? "public, max-age=31536000, immutable" : "no-store",
  });
  res.end(body);
  return true;
}

function tryStatic(pathname: string, res: ServerResponse): boolean {
  if (pathname === "/" || pathname === "/index.html") {
    return sendFile(res, join(webRoot, "index.html"), false);
  }
  // Vite hashed assets under /assets/*
  if (pathname.startsWith("/assets/")) {
    const rel = pathname.replace(/^\/+/, "");
    return sendFile(res, join(webRoot, rel), true);
  }
  return false;
}

export function startControlServer(opts: ServerOptions) {
  const { store, runner, settings, updater, version, platform, jobs, knowledge } = opts;
  const assignments = new AssignmentService(store, settings);

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", `http://${opts.host}:${opts.port}`);
      const method = req.method ?? "GET";

      // 第九轮新入口统一走委托边界检查；未命中时继续走既有路由。
      if (await handleOpsRoute(req, res, method, url, { store, jobs, platform, runner })) {
        return;
      }

      if ((method === "GET" || method === "HEAD") && tryStatic(url.pathname, res)) {
        return;
      }

      if (method === "GET" && url.pathname === "/health") {
        return send(res, 200, { ok: true, version });
      }

      if (await routeKnowledge({ method, url, req, res, store, knowledge, send, readJson })) return;

      if (url.pathname === "/settings/approval") {
        if (method === "GET") return send(res, 200, settings.get().chatApproval);
        if (method === "PUT") return send(res, 200, settings.saveChatApproval(ChatApprovalSchema.parse(await readJson(req))));
      }
      if (method === "GET" && url.pathname === "/chat/models") {
        return send(res, 200, settings.chatCatalog());
      }
      if (method === "PUT" && url.pathname === "/settings/chat-models") {
        const body = await readJson(req) as { profile?: unknown; makeDefault?: boolean };
        const profile = ChatProfileSchema.parse(body?.profile);
        return send(res, 200, settings.saveChatProfile(profile, body.makeDefault === true));
      }
      if (method === "POST" && url.pathname === "/settings/chat-models/query") {
        if (req.headers["content-type"]?.split(";")[0]?.trim() !== "application/json") {
          return send(res, 415, { error: "请使用 JSON 请求。" });
        }
        const connection = ChatConnectionSchema.parse(await readJson(req));
        connection.apiKey = settings.chatKey(connection);
        return send(res, 200, { models: await queryChatModels(connection) });
      }
      if (method === "POST" && url.pathname === "/tasks/submit") {
        if (req.headers["content-type"]?.split(";")[0]?.trim() !== "application/json") {
          return send(res, 415, { error: "请使用 JSON 提交任务。" });
        }
        return send(res, 202, await assignments.accept(await readJson(req, 8 * 1024 * 1024)));
      }
      const submission = url.pathname.match(/^\/tasks\/submissions\/([a-f\d]{32})$/);
      if (method === "GET" && submission) {
        const task = store.findSubmission(submission[1]!);
        return task ? send(res, 200, assignments.view(task)) : send(res, 404, { error: "服务器尚无该提交记录" });
      }

      if (method === "GET" && url.pathname === "/settings") {
        return send(res, 200, settings.publicView(version));
      }

      if (method === "PUT" && url.pathname === "/settings/model") {
        const patch = ModelSettingsPatchSchema.parse(await readJson(req));
        const view = settings.patchModel(patch);
        Object.assign(process.env, settings.workerEnv());
        return send(res, 200, view);
      }

      if (method === "PUT" && url.pathname === "/settings/update") {
        const patch = UpdateSettingsPatchSchema.parse(await readJson(req));
        return send(res, 200, settings.patchUpdate(patch));
      }

      if (method === "PUT" && url.pathname === "/settings/knowledge-embedding") {
        const patch = KnowledgeEmbeddingPatchSchema.parse(await readJson(req));
        const view = settings.patchKnowledgeEmbedding(patch);
        knowledge.refreshEmbeddingConfig();
        return send(res, 200, view);
      }

      // 测试连接：只用固定合成短句请求所选服务，不写索引、不触发重建。
      if (method === "POST" && url.pathname === "/settings/knowledge-embedding/test") {
        const input = KnowledgeEmbeddingTestSchema.parse(await readJson(req));
        const draft = settings.knowledgeEmbeddingForTest(input);
        return send(res, 200, await testEmbeddingConnection(resolveEmbeddingRuntime(draft, input.provider)));
      }

      if (method === "POST" && url.pathname === "/settings/model/test") {
        const env = settings.workerEnv();
        const base = (env.OPENAI_BASE_URL || "https://api.openai.com/v1").replace(/\/$/, "");
        if (!env.OPENAI_API_KEY) {
          return send(res, 400, { ok: false, error: "未配置 API Key" });
        }
        const testRes = await fetch(`${base}/models`, {
          headers: {
            authorization: `Bearer ${env.OPENAI_API_KEY}`,
            "user-agent": "GongYuAI/0.1",
          },
        });
        const text = await testRes.text();
        if (!testRes.ok) {
          return send(res, 200, {
            ok: false,
            status: testRes.status,
            error: text.slice(0, 500),
            visionEnabled: settings.get().model.visionEnabled,
          });
        }
        return send(res, 200, {
          ok: true,
          status: testRes.status,
          modelId: env.GY_MODEL,
          baseUrl: base,
          visionEnabled: settings.get().model.visionEnabled,
        });
      }

      if (method === "GET" && url.pathname === "/settings/usage") {
        const tasks = store.list();
        let tokens = 0;
        let toolCalls = 0;
        let installs = 0;
        const byTask = tasks.map((t) => {
          const before = t.usage;
          const usage = refreshTaskUsage(t);
          if (
            usage.tokens !== before.tokens ||
            usage.toolCalls !== before.toolCalls ||
            usage.installs !== before.installs
          ) {
            store.save(t);
          }
          tokens += usage.tokens;
          toolCalls += usage.toolCalls;
          installs += usage.installs;
          return {
            id: t.id,
            name: t.name,
            status: t.status,
            tokens: usage.tokens,
            toolCalls: usage.toolCalls,
            installs: usage.installs,
            updatedAt: t.updatedAt,
          };
        });
        byTask.sort((a, b) => b.tokens - a.tokens || b.toolCalls - a.toolCalls);
        return send(res, 200, {
          totals: { tokens, toolCalls, installs, tasks: tasks.length },
          ...(url.searchParams.get("integrations") === "1" ? { integrations: projectIntegrationUsage(tasks) } : {}),
          byTask: byTask.slice(0, 50),
        });
      }

      if (method === "GET" && url.pathname === "/settings/update/status") {
        return send(res, 200, updater.getStatus());
      }

      if (method === "POST" && url.pathname === "/settings/update/run") {
        return send(res, 202, updater.start());
      }

      if (method === "POST" && url.pathname === "/settings/tools/rescan") {
        return send(res, 200, settings.rescanCatalog());
      }

      if (method === "PUT" && url.pathname === "/settings/tools") {
        const patch = ToolsSettingsPatchSchema.parse(await readJson(req));
        return send(res, 200, settings.patchTools(patch));
      }

      if (method === "PATCH" && url.pathname === "/settings/tools/toggle") {
        const body = ToggleToolsItemSchema.parse(await readJson(req));
        return send(res, 200, settings.toggleToolsItem(body));
      }

      if (method === "POST" && url.pathname === "/settings/tools/mcp") {
        const body = AddUserMcpSchema.parse(await readJson(req));
        return send(res, 201, settings.addUserMcp(body));
      }

      const mcpDelete = url.pathname.match(/^\/settings\/tools\/mcp\/([^/]+)$/);
      if (method === "DELETE" && mcpDelete) {
        return send(res, 200, settings.removeUserMcp(decodeURIComponent(mcpDelete[1]!)));
      }

      if (method === "POST" && url.pathname === "/settings/tools/skills/import") {
        const body = ImportSkillSchema.parse(await readJson(req));
        return send(res, 201, settings.importSkill(body));
      }

      const skillDelete = url.pathname.match(/^\/settings\/tools\/skills\/([^/]+)$/);
      if (method === "DELETE" && skillDelete) {
        return send(res, 200, settings.removeUserSkill(decodeURIComponent(skillDelete[1]!)));
      }

      if (method === "PUT" && url.pathname === "/settings/asset-collectors") {
        const body = AssetCollectorPatchSchema.parse(await readJson(req));
        return send(res, 200, settings.patchAssetCollector(body));
      }

      if (method === "POST" && url.pathname === "/settings/asset-collectors") {
        const body = AddAssetCollectorSchema.parse(await readJson(req));
        return send(res, 201, settings.addAssetCollector(body));
      }

      if (method === "PATCH" && url.pathname === "/settings/asset-collectors/toggle") {
        const body = (await readJson(req)) as { id?: string; enabled?: boolean };
        if (!body.id || typeof body.enabled !== "boolean") {
          return send(res, 400, { error: "需要 id 与 enabled" });
        }
        return send(res, 200, settings.toggleAssetCollector(body.id, body.enabled));
      }

      const collectorDelete = url.pathname.match(/^\/settings\/asset-collectors\/([^/]+)$/);
      if (method === "DELETE" && collectorDelete) {
        return send(
          res,
          200,
          settings.removeAssetCollector(decodeURIComponent(collectorDelete[1]!)),
        );
      }

      if (url.pathname === "/tasks/archives") {
        if (method === "GET") return send(res, 200, { tasks: store.list().map(taskArchiveState) });
        if (method === "POST") {
          if (req.headers["content-type"]?.split(";")[0]?.trim() !== "application/json") {
            return send(res, 415, { error: "请使用 JSON 请求。" });
          }
          const { taskIds, archived } = TaskArchiveBatchSchema.parse(await readJson(req, 1024 * 1024));
          return send(res, 200, { tasks: store.setArchivedBatch(taskIds, archived).map(taskArchiveState) });
        }
      }

      if (method === "GET" && url.pathname === "/tasks") {
        const tasks = store.list().map((t) => {
          const before = t.usage;
          const usage = refreshTaskUsage(t);
          if (
            usage.tokens !== before.tokens ||
            usage.toolCalls !== before.toolCalls ||
            usage.installs !== before.installs
          ) {
            store.save(t);
          }
          return withLiveGoals(t);
        });
        return send(res, 200, { tasks });
      }

      if (method === "POST" && url.pathname === "/tasks") {
        const body = CreateTaskRequestSchema.parse(await readJson(req));
        const task = store.createTask(body);
        // Seed goals + asset inventory before start so console 资产表 shows targets immediately.
        {
          const paths = taskPaths(task.dataDir);
          const history = openHistory({
            dbPath: paths.historyDb,
            evidenceDir: paths.evidenceDir,
          });
          try {
            history.seedGoals(task.id, task.goals);
            history.seedAssetsFromAuth(task.id, task.auth);
          } finally {
            history.close();
          }
        }
        const started = await runner.start(task.id);
        return send(res, 201, { task: started });
      }

      const taskMatch = url.pathname.match(/^\/tasks\/([^/]+)(\/.*)?$/);
      if (taskMatch) {
        const taskId = decodeURIComponent(taskMatch[1]!);
        const rest = taskMatch[2] ?? "";
        const task = store.get(taskId);
        if (!task) return send(res, 404, { error: "not found" });
        // P16 — 旧授权台账只读回查；登记入口已移除（目标进入任务即视为授权）。
        if (rest === "/authorization") {
          if (method === "GET") {
            return send(res, 200, { taskId: task.id, authorization: currentRecord(task), digest: authorizationDigest(task) });
          }
          return send(res, 410, {
            error: "授权登记已移除（P16）：目标进入任务即视为授权，不再登记授权。更新任务坐标请用 POST /tasks/:id/scope，或在会话里回复「目标: <目标>，继续」。",
          });
        }
        // 操作员手动指定命令：绕过模型，但仍走坐标裁决、审批与证据。
        if (method === "POST" && rest === "/command") {
          if (!task.assignment) return send(res, 409, { error: "只有工作区任务支持手动指定命令" });
          try {
            const body = await readJson(req, 64 * 1024) as { command?: unknown; purpose?: unknown };
            const command = typeof body.command === "string" ? body.command : "";
            const purpose = typeof body.purpose === "string" ? body.purpose : undefined;
            return send(res, 200, { task: await assignments.submitCommand(task.id, command, purpose) });
          } catch (err) {
            return send(res, 400, { error: err instanceof Error ? err.message : String(err) });
          }
        }
        // 会话内处理一次待确认命令：允许/拒绝只绑定当次调用，重试针对审批模型不可用。
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
          return send(res, 200, { task: decided });
        }
        if (task.assignment) {
          if (method === "GET" && rest === "/assignment") return send(res, 200, assignments.view(task));
          if (method === "POST" && (rest === "/pause" || rest === "/stop")) {
            if (!isActiveTaskStatus(task.status)) return send(res, 409, { error: "任务当前未在执行" });
            return send(res, 200, { task: assignments.interrupt(task, rest === "/pause" ? "paused" : "stopped", "操作员已中断任务") });
          }
          if (method === "POST" && (rest === "/start" || rest === "/resume")) {
            return send(res, 200, { task: assignments.start(task) });
          }
        }
        // Post-terminal changes (retest / client decision / retraction /
        // correction) keep History authoritative; the report is re-rendered
        // from it, preserving the previous delivered version on disk.
        const refreshTerminalReport = (history: ReturnType<typeof openHistory>) => {
          if (!isTerminalTaskStatus(task.status)) return;
          writeTaskReport(
            { taskId: task.id, dataDir: task.dataDir, auth: task.auth },
            history,
            { status: task.status, reason: task.error ?? undefined, accounting: task,
              materialVersionStatus: (versionId, materialId) =>
                knowledge.version(materialId, versionId, scopeFromTask(task))?.version.status },
          );
        };

        if (method === "GET" && rest === "") {
          const before = task.usage;
          refreshTaskUsage(task);
          if (
            task.usage.tokens !== before.tokens ||
            task.usage.toolCalls !== before.toolCalls ||
            task.usage.installs !== before.installs
          ) {
            store.save(task);
          }
          const base = task.runStartUsage;
          const runUsage = {
            tokens: task.usage.tokens - (base?.tokens ?? 0),
            toolCalls: task.usage.toolCalls - (base?.toolCalls ?? 0),
            installs: task.usage.installs - (base?.installs ?? 0),
          };
          return send(res, 200, { task: { ...withLiveGoals(task), runUsage } });
        }
        if (method === "POST" && rest === "/stop") {
          const stopped = await runner.stop(taskId);
          const canceled = jobs.cancelTaskJobs(taskId, "task-stopped");
          return send(res, 200, { task: stopped, canceledJobs: canceled });
        }
        if (method === "POST" && rest === "/start") {
          const started = await runner.start(taskId);
          return send(res, 200, { task: started });
        }
        if (method === "POST" && rest === "/pause") {
          try {
            const paused = await runner.pause(taskId);
            const pausedJobs = jobs.pauseTask(taskId);
            return send(res, 200, { task: paused, jobs: pausedJobs });
          } catch (err) {
            return send(res, 409, { error: err instanceof Error ? err.message : String(err) });
          }
        }
        if (method === "POST" && rest === "/resume") {
          try {
            const resumed = await runner.resume(taskId);
            const resumedJobs = jobs.resumeTask(taskId);
            return send(res, 200, { task: resumed, jobs: resumedJobs });
          } catch (err) {
            return send(res, 409, { error: err instanceof Error ? err.message : String(err) });
          }
        }
        if (method === "POST" && rest === "/scope") {
          const input = UpdateScopeRequestSchema.safeParse(await readJson(req));
          if (!input.success) return send(res, 400, { error: input.error.message });
          try {
            const updated = runner.setScope(taskId, input.data.auth, input.data.reason);
            const paths = taskPaths(updated.dataDir);
            if (existsSync(paths.historyDb)) {
              const history = openHistory({ dbPath: paths.historyDb, evidenceDir: paths.evidenceDir });
              try {
                history.appendFact({
                  taskId,
                  layer: "summary",
                  title: `授权范围更新至 v${updated.scopeVersion}`,
                  summary: `目标：${updated.auth.targets.join("、")}；排除：${updated.auth.outOfScope.join("、") || "未列出"}；原因：${input.data.reason}`,
                  tags: ["scope", `scopeVersion:${updated.scopeVersion}`],
                });
              } finally {
                history.close();
              }
            }
            return send(res, 200, { task: updated });
          } catch (err) {
            return send(res, 409, { error: err instanceof Error ? err.message : String(err) });
          }
        }
        if (method === "GET" && rest === "/findings") {
          const paths = taskPaths(task.dataDir);
          if (!existsSync(paths.historyDb)) return send(res, 200, { findings: [], actions: [] });
          const history = openHistory({ dbPath: paths.historyDb, evidenceDir: paths.evidenceDir, readOnly: true });
          try {
            return send(res, 200, {
              findings: history.listFindings(task.id),
              actions: history.listFindingActions(task.id),
              goalFindings: history.listGoalFindings(task.id),
            });
          } finally {
            history.close();
          }
        }
        if (method === "GET" && rest === "/traffic") {
          try {
            return send(res, 200, queryFromSearchParams(task.dataDir, task.id, url.searchParams));
          } catch (err) {
            return send(res, 400, { error: err instanceof Error ? err.message : String(err) });
          }
        }
        const trafficBlob = /^\/traffic\/([^/]+)\/blob$/.exec(rest);
        if (method === "GET" && trafficBlob) {
          const side = url.searchParams.get("side");
          if (side !== "req" && side !== "res") return send(res, 400, { error: "side must be req or res" });
          const offset = Number(url.searchParams.get("offset") ?? "0");
          const maxRaw = url.searchParams.get("maxBytes");
          const maxBytes = maxRaw == null || maxRaw === "" ? undefined : Number(maxRaw);
          try {
            const slice = readTrafficBody(task.dataDir, decodeURIComponent(trafficBlob[1]!), side, offset, maxBytes);
            return send(res, 200, {
              sha256: slice.sha256,
              side: slice.side,
              offset: slice.offset,
              size: slice.size,
              ...(slice.contentType ? { contentType: slice.contentType } : {}),
              body: slice.body,
              bytes: slice.bytes.toString("base64"),
              nextOffset: slice.nextOffset,
              evidenceRef: slice.evidenceRef,
            });
          } catch (err) {
            const status = typeof err === "object" && err && "status" in err && typeof err.status === "number" ? err.status : 400;
            return send(res, status, { error: err instanceof Error ? err.message : String(err) });
          }
        }
        const trafficOne = /^\/traffic\/([^/]+)$/.exec(rest);
        if (method === "GET" && trafficOne) {
          const record = getTraffic(task.dataDir, decodeURIComponent(trafficOne[1]!));
          if (!record || record.taskId !== task.id) return send(res, 404, { error: "traffic not found" });
          return send(res, 200, { traffic: record, evidenceRef: `http:${record.id}` });
        }
        const validateRun = /^\/findings\/([^/]+)\/validate-run$/.exec(rest);
        if (method === "POST" && validateRun) {
          const findingId = decodeURIComponent(validateRun[1]!);
          const paths = taskPaths(task.dataDir);
          if (!existsSync(paths.historyDb)) return send(res, 409, { error: "缺少任务历史" });
          try {
            const parsed = FindingValidateRunRequestSchema.safeParse(await readJson(req));
            if (!parsed.success) return send(res, 400, { error: parsed.error.message });
            const body = parsed.data;
            if (body.findingId !== findingId) return send(res, 400, { error: "findingId mismatch" });
            const result = await runIndependentValidation({
              taskId: task.id,
              taskDir: task.dataDir,
              historyDb: paths.historyDb,
              evidenceDir: paths.evidenceDir,
              targets: task.auth.targets,
              findingId,
              ...(body.force ? { force: true } : {}),
            });
            return send(res, result.httpStatus, result.body);
          } catch (err) {
            if (err instanceof ValidationBusyError) {
              return send(res, 409, { error: err.message, jobId: err.jobId, status: "running" });
            }
            const status = typeof err === "object" && err && "status" in err && typeof err.status === "number" ? err.status : 409;
            return send(res, status, { error: err instanceof Error ? err.message : String(err) });
          }
        }
        const operatorFinding = /^\/findings\/([^/]+)\/(verify|retract)$/.exec(rest);
        if (method === "POST" && operatorFinding) {
          const findingId = decodeURIComponent(operatorFinding[1]!);
          const action = operatorFinding[2]!;
          const body = await readJson(req) as Record<string, unknown>;
          const paths = taskPaths(task.dataDir);
          if (!existsSync(paths.historyDb)) return send(res, 409, { error: "缺少任务历史" });
          const history = openHistory({ dbPath: paths.historyDb, evidenceDir: paths.evidenceDir });
          try {
            if (action === "retract") {
              const reason = typeof body.reason === "string" ? body.reason : "";
              const finding = history.retractFinding(task.id, findingId, reason);
              refreshTerminalReport(history);
              return send(res, 200, { finding });
            }
            const evidencePaths = Array.isArray(body.evidencePaths)
              ? body.evidencePaths.filter((v): v is string => typeof v === "string")
              : [];
            const finding = history.verifyFinding(task.id, findingId, {
              evidencePaths,
              repro: typeof body.repro === "string" ? body.repro : "",
              impact: typeof body.impact === "string" ? body.impact : undefined,
              fix: typeof body.fix === "string" ? body.fix : undefined,
              verifiedBy: typeof body.verifiedBy === "string" ? body.verifiedBy : "operator:api",
            });
            refreshTerminalReport(history);
            return send(res, 200, { finding });
          } catch (err) {
            return send(res, 409, { error: err instanceof Error ? err.message : String(err) });
          } finally {
            history.close();
          }
        }
        const findingAction = /^\/findings\/([^/]+)\/(retest|accept|validate)$/.exec(rest);
        if (method === "POST" && findingAction) {
          const findingId = decodeURIComponent(findingAction[1]!);
          const action = findingAction[2]!;
          const body = await readJson(req) as Record<string, unknown>;
          const paths = taskPaths(task.dataDir);
          if (!existsSync(paths.historyDb)) return send(res, 409, { error: "缺少任务历史" });
          const history = openHistory({ dbPath: paths.historyDb, evidenceDir: paths.evidenceDir });
          try {
            if (action === "validate") {
              const verdict = body.verdict;
              if (
                verdict !== "confirmed" && verdict !== "refuted" &&
                verdict !== "inconclusive" && verdict !== "out-of-scope"
              ) {
                return send(res, 400, {
                  error: "verdict must be confirmed|refuted|inconclusive|out-of-scope",
                });
              }
              const method = body.method;
              if (
                method !== "evidence-only" && method !== "replay" &&
                method !== "control-compare" && method !== "manual"
              ) {
                return send(res, 400, {
                  error: "method must be evidence-only|replay|control-compare|manual",
                });
              }
              const evidencePaths = Array.isArray(body.evidencePaths)
                ? body.evidencePaths.filter((v): v is string => typeof v === "string")
                : [];
              const outcome = history.recordFindingValidation(task.id, findingId, {
                verdict,
                method,
                evidencePaths,
                note: typeof body.note === "string" ? body.note : "",
                validator:
                  typeof body.validator === "string" && body.validator.trim()
                    ? body.validator
                    : "operator:local",
              });
              refreshTerminalReport(history);
              return send(res, 201, outcome);
            }
            if (action === "retest") {
              const result = body.result;
              if (result !== "fixed" && result !== "still-present" && result !== "partially-fixed") {
                return send(res, 400, { error: "result must be fixed|still-present|partially-fixed" });
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
              // 客户发起的复测申请在复测落库后关闭（只追加，不改写申请）。
              const fulfilled = history.fulfillRetestRequests(task.id, findingId, result);
              refreshTerminalReport(history);
              return send(res, 201, { ...outcome, fulfilledRequests: fulfilled });
            }
            const outcome = history.acceptFinding(task.id, findingId, {
              note: typeof body.note === "string" ? body.note : "",
              evidencePath: typeof body.evidencePath === "string" ? body.evidencePath : "",
            });
            refreshTerminalReport(history);
            return send(res, 201, outcome);
          } catch (err) {
            return send(res, 409, { error: err instanceof Error ? err.message : String(err) });
          } finally {
            history.close();
          }
        }
        if (method === "GET" && rest === "/snapshot") {
          const paths = taskPaths(task.dataDir);
          if (!existsSync(paths.historyDb)) return send(res, 409, { error: "缺少任务历史" });
          const history = openHistory({ dbPath: paths.historyDb, evidenceDir: paths.evidenceDir, readOnly: true });
          try {
            const snapshot = history.deliverySnapshot(task.id);
            // The published scorecard must be the pure recomputation of the
            // snapshot that is actually returned, not a second snapshot taken
            // a millisecond later (different capturedAt → different sha256).
            return send(res, 200, {
              snapshot,
              scorecard: computeScorecard(snapshot),
            });
          } finally {
            history.close();
          }
        }
        if (method === "GET" && rest === "/scorecard") {
          const paths = taskPaths(task.dataDir);
          if (!existsSync(paths.historyDb)) return send(res, 409, { error: "缺少任务历史" });
          const history = openHistory({ dbPath: paths.historyDb, evidenceDir: paths.evidenceDir, readOnly: true });
          try {
            return send(res, 200, { scorecard: history.scorecard(task.id) });
          } finally {
            history.close();
          }
        }
        if (method === "GET" && rest === "/corrections") {
          const paths = taskPaths(task.dataDir);
          if (!existsSync(paths.historyDb)) return send(res, 200, { corrections: [] });
          const history = openHistory({ dbPath: paths.historyDb, evidenceDir: paths.evidenceDir, readOnly: true });
          try {
            return send(res, 200, { corrections: history.listDeliveryCorrections(task.id) });
          } finally {
            history.close();
          }
        }
        if (method === "POST" && rest === "/corrections") {
          const body = await readJson(req) as {
            reason?: unknown;
            findings?: unknown;
            noticeStatus?: unknown;
          };
          const reason = typeof body.reason === "string" ? body.reason : "";
          const findings = Array.isArray(body.findings)
            ? body.findings.filter((id): id is string => typeof id === "string")
            : [];
          const notice = typeof body.noticeStatus === "string" &&
            ["pending", "notified", "confirmed"].includes(body.noticeStatus)
            ? (body.noticeStatus as "pending" | "notified" | "confirmed")
            : "pending";
          const paths = taskPaths(task.dataDir);
          if (!existsSync(paths.historyDb)) return send(res, 409, { error: "缺少任务历史" });
          const history = openHistory({ dbPath: paths.historyDb, evidenceDir: paths.evidenceDir });
          try {
            const reportPath = join(task.dataDir, "report.md");
            const report = existsSync(reportPath)
              ? [{
                  path: "report.md",
                  sha256: createHash("sha256").update(readFileSync(reportPath)).digest("hex"),
                }]
              : [];
            const created = history.recordDeliveryCorrection(task.id, {
              reason,
              ...(findings.length ? { findings } : {}),
              report,
              noticeStatus: notice,
            });
            refreshTerminalReport(history);
            return send(res, created.created ? 201 : 200, { correction: created.correction, created: created.created });
          } catch (err) {
            return send(res, 409, { error: err instanceof Error ? err.message : String(err) });
          } finally {
            history.close();
          }
        }
        const noticeMatch = /^\/corrections\/([^/]+)\/notice$/.exec(rest);
        if (method === "POST" && noticeMatch) {
          const body = await readJson(req) as { status?: unknown; evidencePath?: unknown };
          const status = typeof body.status === "string" &&
            ["pending", "notified", "confirmed"].includes(body.status)
            ? (body.status as "pending" | "notified" | "confirmed")
            : null;
          if (!status) return send(res, 400, { error: "status must be pending|notified|confirmed" });
          const paths = taskPaths(task.dataDir);
          const history = openHistory({ dbPath: paths.historyDb, evidenceDir: paths.evidenceDir });
          try {
            const updated = history.setDeliveryCorrectionNotice(
              task.id,
              decodeURIComponent(noticeMatch[1]!),
              status,
              typeof body.evidencePath === "string" ? body.evidencePath : undefined,
            );
            refreshTerminalReport(history);
            return send(res, 200, { correction: updated });
          } catch (err) {
            return send(res, 409, { error: err instanceof Error ? err.message : String(err) });
          } finally {
            history.close();
          }
        }
        if (method === "POST" && rest === "/reconcile") {
          try {
            const outcome = runReconcile(task.id, task.dataDir, await readJson(req));
            return send(res, 201, outcome);
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            const missing = /ENOENT|no such file/i.test(message);
            return send(res, missing ? 422 : 400, { error: message });
          }
        }
        if (method === "GET" && rest === "/reconcile") {
          const paths = taskPaths(task.dataDir);
          if (!existsSync(paths.historyDb)) return send(res, 200, { results: [] });
          const history = openHistory({ dbPath: paths.historyDb, evidenceDir: paths.evidenceDir, readOnly: true });
          try {
            const results = history
              .listFacts(task.id)
              .filter((fact) => fact.tags.includes("reconcile"))
              .map((fact) => ({
                factId: fact.id,
                title: fact.title,
                summary: fact.summary,
                evidencePath: fact.evidencePath,
                createdAt: fact.createdAt,
              }));
            return send(res, 200, { results });
          } finally {
            history.close();
          }
        }
        if (method === "POST" && rest === "/retest-requests") {
          const input = RetestRequestSchema.safeParse(await readJson(req));
          if (!input.success) return send(res, 400, { error: input.error.message });
          const paths = taskPaths(task.dataDir);
          if (!existsSync(paths.historyDb)) return send(res, 409, { error: "缺少任务历史" });
          const history = openHistory({ dbPath: paths.historyDb, evidenceDir: paths.evidenceDir });
          try {
            const request = history.recordRetestRequest(task.id, input.data);
            refreshTerminalReport(history);
            return send(res, 201, { request });
          } catch (err) {
            return send(res, 400, { error: err instanceof Error ? err.message : String(err) });
          } finally {
            history.close();
          }
        }
        if (method === "GET" && rest === "/retest-requests") {
          const paths = taskPaths(task.dataDir);
          if (!existsSync(paths.historyDb)) return send(res, 200, { requests: [] });
          const history = openHistory({ dbPath: paths.historyDb, evidenceDir: paths.evidenceDir, readOnly: true });
          try {
            return send(res, 200, { requests: history.listRetestRequests(task.id) });
          } finally {
            history.close();
          }
        }
        if (method === "POST" && rest === "/peer-reviews") {
          const input = PeerReviewSchema.safeParse(await readJson(req));
          if (!input.success) return send(res, 400, { error: input.error.message });
          if (input.data.sourceTaskId === task.id) {
            return send(res, 400, { error: "跨任务署名复核要求 sourceTaskId 与当前任务不同；本任务内复核用 /reviews" });
          }
          const source = store.get(input.data.sourceTaskId);
          if (!source) return send(res, 404, { error: "源任务不存在" });
          // 委托隔离：只有同一 engagementId 的任务之间允许署名复核。
          if (source.engagementId !== task.engagementId) {
            return send(res, 409, {
              error: `跨委托复核被拒绝：源任务委托 ${source.engagementId} ≠ 当前委托 ${task.engagementId}`,
            });
          }
          const paths = taskPaths(task.dataDir);
          if (!existsSync(paths.historyDb)) return send(res, 409, { error: "缺少任务历史" });
          const history = openHistory({ dbPath: paths.historyDb, evidenceDir: paths.evidenceDir });
          try {
            if (input.data.findingId) {
              const sourcePaths = taskPaths(source.dataDir);
              if (!existsSync(sourcePaths.historyDb)) return send(res, 409, { error: "源任务缺少历史" });
              const sourceHistory = openHistory({
                dbPath: sourcePaths.historyDb,
                evidenceDir: sourcePaths.evidenceDir,
                readOnly: true,
              });
              try {
                if (!sourceHistory.getFinding(source.id, input.data.findingId)) {
                  return send(res, 400, { error: `源任务中不存在该结论：${input.data.findingId}` });
                }
              } finally {
                sourceHistory.close();
              }
            }
            const review = history.recordPeerReview(task.id, task.engagementId, input.data);
            refreshTerminalReport(history);
            return send(res, 201, { review });
          } catch (err) {
            return send(res, 400, { error: err instanceof Error ? err.message : String(err) });
          } finally {
            history.close();
          }
        }
        if (method === "GET" && rest === "/peer-reviews") {
          const paths = taskPaths(task.dataDir);
          if (!existsSync(paths.historyDb)) return send(res, 200, { reviews: [] });
          const history = openHistory({ dbPath: paths.historyDb, evidenceDir: paths.evidenceDir, readOnly: true });
          try {
            return send(res, 200, { reviews: history.listPeerReviews(task.id) });
          } finally {
            history.close();
          }
        }
        if (method === "POST" && rest === "/archive") {
          try {
            const archived = store.setArchived(taskId, true);
            return send(res, 200, { task: archived });
          } catch (e) {
            return send(res, 400, { error: e instanceof Error ? e.message : String(e) });
          }
        }
        if (method === "POST" && rest === "/unarchive") {
          const unarchived = store.setArchived(taskId, false);
          return send(res, 200, { task: unarchived });
        }
        if (method === "GET" && rest === "/logs") {
          const text = readTaskWorkerLogs(task.dataDir);
          res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
          res.end(text.slice(-200_000));
          return;
        }
        if (method === "GET" && rest === "/delivery") {
          const path = taskPaths(task.dataDir).reportPath;
          const hasReport = existsSync(path);
          return send(res, 200, { summary: deliverySummary(task, hasReport), hasReport });
        }
        if (method === "GET" && rest === "/report") {
          const reportPath = join(task.dataDir, "report.md");
          const text = existsSync(reportPath) ? readFileSync(reportPath, "utf8")
            : isTerminalTaskStatus(task.status) ? deliverySummary(task, false) : "";
          res.writeHead(200, { "content-type": "text/markdown; charset=utf-8" });
          res.end(text);
          return;
        }
        const version = /^\/report-evidence\/([a-f0-9]{64})$/.exec(rest);
        if (method === "GET" && version) {
          const paths = taskPaths(task.dataDir);
          const history = openHistory({ dbPath: paths.historyDb, evidenceDir: paths.evidenceDir });
          try {
            const bytes = history.readProofVersion(task.id, version[1]!);
            if (!bytes) return send(res, 404, { error: "unknown evidence version" });
            res.writeHead(200, { "content-type": "application/octet-stream", "content-disposition": "attachment", "x-content-type-options": "nosniff" });
            res.end(bytes);
            return;
          } finally {
            history.close();
          }
        }
        if (method === "POST" && rest === "/coverage") {
          const input = CoverageReviewSchema.safeParse(await readJson(req));
          if (!input.success) return send(res, 400, { error: input.error.message });
          const paths = taskPaths(task.dataDir);
          if (!existsSync(paths.historyDb)) return send(res, 409, { error: "缺少任务历史" });
          const history = openHistory({ dbPath: paths.historyDb, evidenceDir: paths.evidenceDir });
          try {
            const coverage = history.recordCoverage(task.id, input.data);
            // 覆盖意见属于交付材料：终态任务要重新渲染报告，否则报告与记分卡读数会分叉。
            refreshTerminalReport(history);
            return send(res, 201, { coverage });
          } catch (err) {
            return send(res, 400, { error: String(err) });
          } finally {
            history.close();
          }
        }
        if (method === "POST" && rest === "/reviews") {
          const input = CreateFactReviewSchema.safeParse(await readJson(req));
          if (!input.success) return send(res, 400, { error: input.error.message });
          const paths = taskPaths(task.dataDir);
          const history = openHistory({ dbPath: paths.historyDb, evidenceDir: paths.evidenceDir });
          try {
            let review;
            try { review = history.appendReview(task.id, input.data); }
            catch (err) { return send(res, 400, { error: String(err) }); }
            if (isTerminalTaskStatus(task.status)) {
              writeTaskReport({ taskId: task.id, dataDir: task.dataDir, auth: task.auth }, history,
                { status: task.status, reason: task.error ?? undefined, accounting: task,
              materialVersionStatus: (versionId, materialId) =>
                knowledge.version(materialId, versionId, scopeFromTask(task))?.version.status });
            }
            return send(res, 201, { review });
          } finally {
            history.close();
          }
        }
        if (method === "GET" && rest === "/history") {
          const paths = taskPaths(task.dataDir);
          if (!existsSync(paths.historyDb)) {
            return send(res, 200, {
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
            });
          }
          const history = openHistory({
            dbPath: paths.historyDb,
            evidenceDir: paths.evidenceDir,
          });
          try {
            const reviews = history.listReviews(task.id);
            const goalProofs = history.listGoalProofs(task.id);
            return send(res, 200, {
              overview: history.overview(task.id),
              goals: history.listGoals(task.id).map((goal) => ({
                ...goal,
                assessment: describeGoalEvidence(goal, goalProofs, reviews),
                // 核算态（缺材料 / 待重算 / 结论不合格 / 可判定 / 已通过）随目标一起返回。
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
          } finally {
            history.close();
          }
        }
        if (method === "GET" && rest === "/hints") {
          const paths = taskPaths(task.dataDir);
          const history = openHistory({
            dbPath: paths.historyDb,
            evidenceDir: paths.evidenceDir,
          });
          try {
            return send(res, 200, { hints: history.listHints(task.id, 100) });
          } finally {
            history.close();
          }
        }
        if (method === "POST" && rest === "/hints") {
          const body = CreateHintRequestSchema.parse(await readJson(req));
          const paths = taskPaths(task.dataDir);
          const history = openHistory({
            dbPath: paths.historyDb,
            evidenceDir: paths.evidenceDir,
          });
          try {
            const hint = history.appendHint({
              taskId: task.id,
              text: body.text,
              source: body.source,
              tags: body.tags,
            });
            return send(res, 201, { hint });
          } finally {
            history.close();
          }
        }
        if (method === "GET" && rest === "/assets") {
          const paths = taskPaths(task.dataDir);
          if (!existsSync(paths.historyDb)) {
            // Create empty history + seed from auth so the console shows targets immediately.
            const history = openHistory({
              dbPath: paths.historyDb,
              evidenceDir: paths.evidenceDir,
            });
            try {
              history.seedGoals(task.id, task.goals);
              history.seedAssetsFromAuth(task.id, task.auth);
              return send(res, 200, { assets: history.listAssets(task.id) });
            } finally {
              history.close();
            }
          }
          const history = openHistory({
            dbPath: paths.historyDb,
            evidenceDir: paths.evidenceDir,
          });
          try {
            history.seedAssetsFromAuth(task.id, task.auth);
            return send(res, 200, { assets: history.listAssets(task.id) });
          } finally {
            history.close();
          }
        }
        if (method === "POST" && rest === "/evidence") {
          const body = await readJson(req) as { path?: unknown; content?: unknown };
          if (typeof body.path !== "string" || typeof body.content !== "string") {
            return send(res, 400, { error: "path and content (utf8 text) are required" });
          }
          const { evidenceDir, historyDb } = taskPaths(task.dataDir);
          let replaced = false;
          try {
            resolveEvidenceFile(evidenceDir, body.path);
            replaced = true;
          } catch {
            replaced = false;
          }
          try {
            const written = writeEvidenceFile(evidenceDir, body.path, body.content);
            const sha256 = createHash("sha256").update(Buffer.from(body.content, "utf8")).digest("hex");
            // 材料导入/替换留痕：复核时能还原“谁在什么时候换了哪份材料”。
            if (existsSync(historyDb)) {
              const history = openHistory({ dbPath: historyDb, evidenceDir, readOnly: false });
              try {
                history.recordEvent(task.id, "evidence_written", {
                  path: written,
                  sha256,
                  bytes: Buffer.byteLength(body.content, "utf8"),
                  replaced,
                  source: "console",
                });
              } finally {
                history.close();
              }
            }
            return send(res, 201, { path: written, sha256, replaced });
          } catch (err) {
            return send(res, 400, { error: err instanceof Error ? err.message : String(err) });
          }
        }
        if (method === "DELETE" && rest === "/evidence") {
          const rel = url.searchParams.get("path");
          if (!rel) return send(res, 400, { error: "path is required" });
          const { evidenceDir, historyDb } = taskPaths(task.dataDir);
          let sha256: string | null = null;
          try {
            sha256 = createHash("sha256").update(readEvidenceBytes(evidenceDir, rel)).digest("hex");
            removeEvidenceFile(evidenceDir, rel);
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            const missing = /ENOENT|no such file/i.test(message);
            return send(res, missing ? 404 : 400, { error: message });
          }
          if (existsSync(historyDb)) {
            const history = openHistory({ dbPath: historyDb, evidenceDir, readOnly: false });
            try {
              // 撤回的材料不删历史：事件里留下撤回前的哈希，旧结果仍可追溯。
              history.recordEvent(task.id, "evidence_removed", {
                path: rel,
                sha256,
                source: "console",
              });
            } finally {
              history.close();
            }
          }
          return send(res, 200, { removed: rel, sha256 });
        }
        if (method === "POST" && rest === "/goals/assert") {
          // 操作员触发的目标判定：与 worker 自动判定走同一条 assertGoal 实现，
          // 因此首次通过的输入绑定、单条事件与重复提交幂等完全一致。
          const body = await readJson(req) as { goalId?: unknown };
          const goalId = typeof body.goalId === "string" ? body.goalId.trim() : "";
          if (!goalId) return send(res, 400, { error: "goalId is required" });
          const paths = taskPaths(task.dataDir);
          if (!existsSync(paths.historyDb)) return send(res, 409, { error: "缺少任务历史" });
          const history = openHistory({ dbPath: paths.historyDb, evidenceDir: paths.evidenceDir });
          try {
            const goal = history.listGoals(task.id).find((entry) => entry.id === goalId);
            if (!goal) return send(res, 404, { error: `unknown goal: ${goalId}` });
            history.recordEvent(task.id, "goal_assert_requested", { goalId, source: "console" });
            const evidencePaths = listEvidenceFiles(paths.evidenceDir).filter((path) =>
              goal.evidencePatterns.length === 0 ||
              goal.evidencePatterns.some((pattern) => minimatch(path, pattern)),
            );
            const outcome = history.assertGoal(task.id, goalId, evidencePaths);
            const state = history.goalReconcileState(task.id, goalId);
            refreshTerminalReport(history);
            return send(res, outcome.ok ? 200 : 409, {
              ok: outcome.ok,
              goal: outcome.ok ? outcome.goal : goal,
              ...(outcome.ok ? {} : { reason: outcome.reason }),
              reconcileState: state,
            });
          } finally {
            history.close();
          }
        }
        if (method === "GET" && rest === "/evidence") {
          const { evidenceDir } = taskPaths(task.dataDir);
          const files = listEvidenceFiles(evidenceDir).flatMap((path) => {
            try {
              const { stat } = resolveEvidenceFile(evidenceDir, path);
              return [{ path, size: stat.size, mtime: stat.mtime.toISOString() }];
            } catch {
              return [];
            }
          });
          return send(res, 200, { files });
        }
        if (method === "GET" && rest.startsWith("/evidence/file")) {
          const rel = url.searchParams.get("path");
          if (!rel) return send(res, 400, { error: "bad path" });
          let content: string;
          try {
            content = readEvidenceFile(taskPaths(task.dataDir).evidenceDir, rel);
          } catch {
            return send(res, 404, { error: "not found" });
          }
          res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
          res.end(content);
          return;
        }
        if (method === "GET" && rest === "/trace") {
          const cursor = url.searchParams.get("before");
          const before = cursor === null ? undefined : Number(cursor);
          if (before !== undefined && (!Number.isSafeInteger(before) || before <= 0)) {
            return send(res, 400, { error: "invalid trace cursor" });
          }
          return send(res, 200, listExecutionSteps(task.dataDir, before));
        }
        const traceMatch = rest.match(/^\/trace\/([^/]+)$/);
        if (method === "GET" && traceMatch) {
          const calls = readExecutionStepCalls(task.dataDir, decodeURIComponent(traceMatch[1]!));
          res.setHeader("cache-control", "no-store");
          return calls === null
            ? send(res, 404, { error: "step not found" })
            : send(res, 200, { calls });
        }
        if (method === "GET" && rest === "/runtime") {
          const paths = taskPaths(task.dataDir);
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
          let recentFacts: Array<{
            id: string;
            title: string;
            summary: string;
            layer: string;
            createdAt: string;
          }> = [];
          let recentIntents: Array<{ title: string; status: string }> = [];
          if (existsSync(paths.historyDb)) {
            const history = openHistory({
              dbPath: paths.historyDb,
              evidenceDir: paths.evidenceDir,
            });
            try {
              integrations = history.integrationUsage(task.id);
              recentFacts = history
                .listFacts(task.id)
                .slice(-30)
                .reverse()
                .map((f) => ({
                  id: f.id,
                  title: f.title,
                  summary: f.summary,
                  layer: f.layer,
                  createdAt: f.createdAt,
                }));
              recentIntents = history
                .listIntents(task.id)
                .slice(-20)
                .reverse()
                .map((i) => ({ title: i.title, status: i.status }));
            } finally {
              history.close();
            }
          }
          // Prefer worker-status; fall back to Durable checkpoint when Pi path
          // has not flushed status yet (stale 0 tokens / toolCalls).
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
          // Stage 2 — four distinct operator-facing states. "Unknown" is a
          // first-class answer: an active record with no live worker and no
          // fresh heartbeat is not "running".
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
          return send(res, 200, {
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
        }
      }

      if (method === "GET" && url.pathname === "/overview") {
        const tasks = store.list();
        const visible = tasks.filter((t) => !t.archivedAt);
        const byStatus: Record<string, number> = {};
        for (const t of visible) byStatus[t.status] = (byStatus[t.status] ?? 0) + 1;
        return send(res, 200, {
          total: visible.length,
          archived: tasks.length - visible.length,
          byStatus,
          active: visible.filter((task) => isActiveTaskStatus(task.status)).length,
          recent: visible.slice(-8).reverse(),
        });
      }

      send(res, 404, { error: "not found" });
    } catch (err) {
      send(res, 400, {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });

  return new Promise<{ close: () => Promise<void>; url: string }>((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts.port, opts.host, () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : opts.port;
      resolve({
        url: `http://${opts.host}:${port}`,
        close: () =>
          new Promise((r, j) => {
            assignments.close();
            server.close((e) => (e ? j(e) : r()));
          }),
      });
    });
  });
}

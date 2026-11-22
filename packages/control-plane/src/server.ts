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
  ToggleToolsItemSchema,
  ToolsSettingsPatchSchema,
  UpdateSettingsPatchSchema,
} from "@gongyuai/contracts";
import {
  describeGoalEvidence,
  listEvidenceFiles,
  listExecutionSteps,
  openHistory,
  readEvidenceFile,
  readExecutionStepCalls,
  resolveEvidenceFile,
  writeTaskReport,
} from "@gongyuai/history";
import { deliverySummary } from "./delivery.js";
import { taskPaths } from "./paths.js";
import { readCheckpointGraph, refreshTaskUsage } from "./usage.js";
import type { ControlStore } from "./store.js";
import type { WorkerRunner } from "./runner.js";
import type { SettingsStore } from "./settings.js";
import type { SilentUpdater } from "./updater.js";

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
};

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
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
  const { store, runner, settings, updater, version } = opts;

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", `http://${opts.host}:${opts.port}`);
      const method = req.method ?? "GET";

      if ((method === "GET" || method === "HEAD") && tryStatic(url.pathname, res)) {
        return;
      }

      if (method === "GET" && url.pathname === "/health") {
        return send(res, 200, { ok: true, version });
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
          return t;
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
          return send(res, 200, { task: { ...task, runUsage } });
        }
        if (method === "POST" && rest === "/stop") {
          const stopped = await runner.stop(taskId);
          return send(res, 200, { task: stopped });
        }
        if (method === "POST" && rest === "/start") {
          const started = await runner.start(taskId);
          return send(res, 200, { task: started });
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
                { status: task.status, reason: task.error ?? undefined, accounting: task });
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
                ...goal, assessment: describeGoalEvidence(goal, goalProofs, reviews),
              })),
              facts: history.listFacts(task.id),
              reviews,
              goalProofs,
              coverage: history.listCoverage(task.id),
              intents: history.listIntents(task.id),
              events: history.listEvents(task.id, 100),
              assets: history.listAssets(task.id),
              hints: history.listHints(task.id, 50),
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
            hasCheckpoint: existsSync(ckptPath),
            dataDir: task.dataDir,
            progress,
            trace: listExecutionSteps(task.dataDir),
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
            server.close((e) => (e ? j(e) : r()));
          }),
      });
    });
  });
}

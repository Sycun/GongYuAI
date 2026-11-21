import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import {
  AddAssetCollectorSchema,
  AddUserMcpSchema,
  AssetCollectorPatchSchema,
  CreateHintRequestSchema,
  CreateTaskRequestSchema,
  ImportSkillSchema,
  ModelSettingsPatchSchema,
  ToggleToolsItemSchema,
  ToolsSettingsPatchSchema,
  UpdateSettingsPatchSchema,
} from "@gongyuai/contracts";
import { openHistory } from "@gongyuai/history";
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
          return send(res, 200, { task });
        }
        if (method === "POST" && rest === "/stop") {
          const stopped = await runner.stop(taskId);
          return send(res, 200, { task: stopped });
        }
        if (method === "POST" && rest === "/start") {
          const started = await runner.start(taskId);
          return send(res, 200, { task: started });
        }
        if (method === "GET" && rest === "/logs") {
          const text = readTaskWorkerLogs(task.dataDir);
          res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
          res.end(text.slice(-200_000));
          return;
        }
        if (method === "GET" && rest === "/report") {
          const reportPath = join(task.dataDir, "report.md");
          const text = existsSync(reportPath) ? readFileSync(reportPath, "utf8") : "";
          res.writeHead(200, { "content-type": "text/markdown; charset=utf-8" });
          res.end(text);
          return;
        }
        if (method === "GET" && rest === "/history") {
          const paths = taskPaths(task.dataDir);
          if (!existsSync(paths.historyDb)) {
            return send(res, 200, {
              overview: "",
              goals: [],
              facts: [],
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
            return send(res, 200, {
              overview: history.overview(task.id),
              goals: history.listGoals(task.id),
              facts: history.listFacts(task.id),
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
          const paths = taskPaths(task.dataDir);
          const files: Array<{ path: string; size: number; mtime: string }> = [];
          const walk = (dir: string) => {
            if (!existsSync(dir)) return;
            for (const name of readdirSync(dir)) {
              const abs = join(dir, name);
              const st = statSync(abs);
              if (st.isDirectory()) walk(abs);
              else {
                files.push({
                  path: relative(paths.evidenceDir, abs).replace(/\\/g, "/"),
                  size: st.size,
                  mtime: st.mtime.toISOString(),
                });
              }
            }
          };
          walk(paths.evidenceDir);
          return send(res, 200, { files });
        }
        if (method === "GET" && rest.startsWith("/evidence/file")) {
          const rel = url.searchParams.get("path") ?? "";
          if (!rel || rel.includes("..")) return send(res, 400, { error: "bad path" });
          const paths = taskPaths(task.dataDir);
          const abs = join(paths.evidenceDir, rel);
          if (!abs.startsWith(paths.evidenceDir) || !existsSync(abs)) {
            return send(res, 404, { error: "not found" });
          }
          const text = readFileSync(abs, "utf8");
          res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
          res.end(text);
          return;
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
          let workerStatus: unknown = null;
          if (existsSync(statusPath)) {
            try {
              workerStatus = JSON.parse(readFileSync(statusPath, "utf8"));
            } catch {
              /* ignore */
            }
          }
          // Surface merged counters on workerStatus so Live pane matches Budget.
          if (workerStatus && typeof workerStatus === "object") {
            workerStatus = {
              ...(workerStatus as Record<string, unknown>),
              usage: mergedUsage,
              phase:
                (workerStatus as { phase?: string }).phase ??
                checkpointGraph.phase,
              activeIntentId:
                (workerStatus as { activeIntentId?: string | null })
                  .activeIntentId ?? checkpointGraph.activeIntentId,
              updatedAt:
                (workerStatus as { updatedAt?: string }).updatedAt ??
                new Date().toISOString(),
            };
          } else {
            workerStatus = {
              status: task.status,
              usage: mergedUsage,
              phase: checkpointGraph.phase,
              activeIntentId: checkpointGraph.activeIntentId,
              updatedAt: new Date().toISOString(),
            };
          }
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
            recentFacts,
            recentIntents,
            usage: mergedUsage,
          });
        }
      }

      if (method === "GET" && url.pathname === "/overview") {
        const tasks = store.list();
        const byStatus: Record<string, number> = {};
        for (const t of tasks) byStatus[t.status] = (byStatus[t.status] ?? 0) + 1;
        return send(res, 200, {
          total: tasks.length,
          byStatus,
          active: tasks.filter((t) =>
            ["queued", "initializing", "running", "recovering"].includes(t.status),
          ).length,
          recent: tasks.slice(-8).reverse(),
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
      resolve({
        url: `http://${opts.host}:${opts.port}`,
        close: () =>
          new Promise((r, j) => {
            server.close((e) => (e ? j(e) : r()));
          }),
      });
    });
  });
}

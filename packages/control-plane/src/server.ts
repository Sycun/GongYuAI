import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CreateTaskRequestSchema,
  ModelSettingsPatchSchema,
  UpdateSettingsPatchSchema,
} from "@gongyuai/contracts";
import { openHistory } from "@gongyuai/history";
import { taskPaths } from "./paths.js";
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
          tokens += t.usage.tokens;
          toolCalls += t.usage.toolCalls;
          installs += t.usage.installs;
          return {
            id: t.id,
            name: t.name,
            status: t.status,
            tokens: t.usage.tokens,
            toolCalls: t.usage.toolCalls,
            installs: t.usage.installs,
            updatedAt: t.updatedAt,
          };
        });
        byTask.sort((a, b) => b.tokens - a.tokens);
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

      if (method === "GET" && url.pathname === "/tasks") {
        return send(res, 200, { tasks: store.list() });
      }

      if (method === "POST" && url.pathname === "/tasks") {
        const body = CreateTaskRequestSchema.parse(await readJson(req));
        const task = store.createTask(body);
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
          return send(res, 200, { task });
        }
        if (method === "POST" && rest === "/stop") {
          const stopped = await runner.stop(taskId);
          return send(res, 200, { task: stopped });
        }
        if (method === "GET" && rest === "/logs") {
          const logPath = join(task.dataDir, "worker.log");
          const text = existsSync(logPath) ? readFileSync(logPath, "utf8") : "";
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
            return send(res, 200, { overview: "", goals: [], facts: [], intents: [], events: [] });
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
            });
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
          return send(res, 200, {
            leaseOwner: task.leaseOwner,
            leaseUntil: task.leaseUntil,
            fence: task.fence,
            workerPid: task.workerPid,
            containerId: task.containerId,
            workerStatus: existsSync(statusPath)
              ? JSON.parse(readFileSync(statusPath, "utf8"))
              : null,
            hasCheckpoint: existsSync(ckptPath),
            dataDir: task.dataDir,
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

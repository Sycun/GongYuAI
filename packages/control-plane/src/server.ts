import { createServer, type ServerResponse } from "node:http";
import { readFileSync, existsSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { isActiveTaskStatus } from "@gongyuai/contracts";
import { routeKnowledge } from "./knowledge-api.js";
import type { JobRunner } from "./jobs.js";
import type { PlatformStore } from "./platform.js";
import { AssignmentService } from "./assignments.js";
import { handleOpsRoute, readJson, sendJson, type ControlRouteDeps } from "./routes-ops.js";
import { handleSettingsRoute } from "./routes-settings.js";
import { handleTaskRoutes } from "./routes-tasks.js";
import type { ControlStore } from "./store.js";
import type { WorkerRunner } from "./runner.js";
import type { SettingsStore } from "./settings.js";
import type { SilentUpdater } from "./updater.js";
import type { KnowledgeStore } from "./knowledge.js";

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

function sendFile(res: ServerResponse, abs: string, cache = false): boolean {
  if (!abs.startsWith(webRoot) || !existsSync(abs) || !statSync(abs).isFile()) return false;
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
  if (pathname === "/" || pathname === "/index.html") return sendFile(res, join(webRoot, "index.html"), false);
  if (pathname.startsWith("/assets/")) return sendFile(res, join(webRoot, pathname.replace(/^\/+/, "")), true);
  return false;
}

export function startControlServer(opts: ServerOptions) {
  const { store, runner, settings, updater, version, platform, jobs, knowledge } = opts;
  const assignments = new AssignmentService(store, settings);
  const deps: ControlRouteDeps = { store, runner, settings, updater, version, platform, jobs, knowledge, assignments };

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", `http://${opts.host}:${opts.port}`);
      const method = req.method ?? "GET";
      if (await handleOpsRoute(req, res, method, url, deps)) return;
      if ((method === "GET" || method === "HEAD") && tryStatic(url.pathname, res)) return;
      if (method === "GET" && url.pathname === "/health") {
        sendJson(res, 200, { ok: true, version });
        return;
      }
      if (await routeKnowledge({ method, url, req, res, store, knowledge, send: sendJson, readJson })) return;
      if (await handleSettingsRoute(req, res, method, url, deps)) return;
      if (await handleTaskRoutes(req, res, method, url, deps)) return;
      if (method === "GET" && url.pathname === "/overview") {
        const tasks = store.list();
        const visible = tasks.filter((t) => !t.archivedAt);
        const byStatus: Record<string, number> = {};
        for (const t of visible) byStatus[t.status] = (byStatus[t.status] ?? 0) + 1;
        sendJson(res, 200, {
          total: visible.length,
          archived: tasks.length - visible.length,
          byStatus,
          active: visible.filter((task) => isActiveTaskStatus(task.status)).length,
          recent: visible.slice(-8).reverse(),
        });
        return;
      }
      sendJson(res, 404, { error: "not found" });
    } catch (err) {
      sendJson(res, 400, { error: err instanceof Error ? err.message : String(err) });
    }
  });

  return new Promise<{ close: () => Promise<void>; url: string }>((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts.port, opts.host, () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : opts.port;
      resolve({
        url: `http://${opts.host}:${port}`,
        close: () => new Promise((r, j) => {
          assignments.close();
          server.close((e) => (e ? j(e) : r()));
        }),
      });
    });
  });
}

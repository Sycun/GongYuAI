export { ControlStore } from "./store.js";
export { WorkerRunner, type RunnerConfig, type RuntimeMode } from "./runner.js";
export { Watchdog, type WatchdogConfig } from "./watchdog.js";
export { startControlServer, type ServerOptions } from "./server.js";
export { taskDataDir, taskPaths } from "./paths.js";

import { readFileSync } from "node:fs";
import { hostname } from "node:os";
import { join, resolve } from "node:path";
import { ControlStore } from "./store.js";
import { WorkerRunner } from "./runner.js";
import { Watchdog } from "./watchdog.js";
import { SettingsStore } from "./settings.js";
import { SilentUpdater, resolveInstallRoot } from "./updater.js";
export { startControlServer as startServer } from "./server.js";
export { SettingsStore } from "./settings.js";
export { SilentUpdater } from "./updater.js";

export type BootOptions = {
  dataRoot?: string;
  host?: string;
  port?: number;
  runtime?: "local" | "docker";
  workerImage?: string;
  leaseMs?: number;
  watchdogMs?: number;
};

function readPackageVersion(installRoot: string): string {
  try {
    const pkg = JSON.parse(readFileSync(join(installRoot, "package.json"), "utf8")) as {
      version?: string;
    };
    return pkg.version ?? "0.1.0";
  } catch {
    return "0.1.0";
  }
}

export async function bootControlPlane(opts: BootOptions = {}) {
  const dataRoot = resolve(opts.dataRoot ?? process.env.GY_DATA_DIR ?? ".gongyuai");
  const host = opts.host ?? process.env.GY_HOST ?? "127.0.0.1";
  const port = opts.port ?? Number(process.env.GY_PORT ?? 8787);
  const runtime = (opts.runtime ?? process.env.GY_RUNTIME ?? "local") as "local" | "docker";
  const leaseMs = opts.leaseMs ?? Number(process.env.GY_LEASE_MS ?? 15_000);
  const watchdogMs = opts.watchdogMs ?? Number(process.env.GY_WATCHDOG_MS ?? 5_000);
  const ownerId = `cp-${hostname()}-${process.pid}`;
  const installRoot = resolveInstallRoot();
  const version = readPackageVersion(installRoot);

  process.env.GY_HOST = host;
  process.env.GY_PORT = String(port);

  const store = new ControlStore(dataRoot);
  const settings = new SettingsStore(dataRoot, installRoot);
  // Seed env for this process so any child inherits defaults
  Object.assign(process.env, settings.workerEnv());

  const runner = new WorkerRunner(
    store,
    {
      mode: runtime,
      workerImage: opts.workerImage ?? process.env.GY_WORKER_IMAGE ?? "gongyuai-worker:local",
      leaseMs,
      ownerId,
    },
    settings,
  );
  const watchdog = new Watchdog(store, runner, { intervalMs: watchdogMs, leaseMs, ownerId });
  watchdog.start();
  const updater = new SilentUpdater(settings, installRoot, dataRoot);

  const { startControlServer } = await import("./server.js");
  const server = await startControlServer({
    host,
    port,
    store,
    runner,
    settings,
    updater,
    version,
  });

  return {
    store,
    runner,
    watchdog,
    settings,
    updater,
    server,
    url: server.url,
    async close() {
      watchdog.stop();
      await server.close();
      store.close();
    },
  };
}

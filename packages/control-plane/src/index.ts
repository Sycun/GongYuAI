export { captureCoverage, compareCoverage, coverageDigest } from "./coverage-audit.js";
export { ControlStore } from "./store.js";
export { WorkerRunner, type RunnerConfig, type RuntimeMode } from "./runner.js";
export { Watchdog, type WatchdogConfig } from "./watchdog.js";
export { startControlServer, type ServerOptions } from "./server.js";
export { taskDataDir, taskPaths } from "./paths.js";
export { mergeUsageFromDisk, refreshTaskUsage } from "./usage.js";

import { readFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { ControlStore } from "./store.js";
import { WorkerRunner } from "./runner.js";
import { Watchdog } from "./watchdog.js";
import { SettingsStore } from "./settings.js";
import { PlatformStore } from "./platform.js";
import { JobRunner } from "./jobs.js";
import { SilentUpdater, resolveInstallRoot } from "./updater.js";
import { migrateLegacyHomeDataRoot, resolveCanonicalDataRoot } from "./data-root.js";
import type { KnowledgeEmbeddingPatch } from "@gongyuai/contracts";
import { KnowledgeStore } from "./knowledge.js";
export { KnowledgeStore } from "./knowledge.js";
export { KnowledgeApiError, routeKnowledge, scopeFromTask, scopeFromDeclaration, resolveCitation, buildReportExport } from "./knowledge-api.js";
export { extractKnowledgeBody, sectionsFromSnapshot, findSection, deriveSourceKey, parentRangeOf, CHUNKER_VERSION, EXTRACTION_VERSION } from "./knowledge-parse.js";
export { EmbeddingClient, EmbeddingDimMismatch, EmbeddingUnavailable, resolveEmbeddingRuntime } from "./knowledge-embed.js";
export { startControlServer as startServer } from "./server.js";
export { SettingsStore } from "./settings.js";
export { SilentUpdater, resolveInstallRoot } from "./updater.js";
export { resolveCanonicalDataRoot, migrateDataRoot, migrateLegacyHomeDataRoot } from "./data-root.js";

export type BootOptions = {
  dataRoot?: string;
  host?: string;
  port?: number;
  runtime?: "local" | "docker";
  workerImage?: string;
  leaseMs?: number;
  watchdogMs?: number;
  /**
   * 隔离模式（恢复演练）：不导入 `~/.gongyuai` 的旧任务、不起 watchdog，因此
   * 不会自动重启或续跑任何任务，也不会产生外部调用。所有读取都留在 dataRoot 内。
   */
  isolated?: boolean;
  /**
   * 本地向量化配置覆盖（验收与隔离运行用）。写入本数据根的 settings.json，
   * 不触碰正式数据根。缺省沿用 settings.json 里的 knowledgeEmbedding。
   */
  knowledgeEmbedding?: KnowledgeEmbeddingPatch;
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
  const installRoot = resolveInstallRoot();
  const dataRoot = resolveCanonicalDataRoot({
    installRoot,
    explicit: opts.dataRoot,
    envValue: process.env.GY_DATA_DIR,
  });
  const isolated = opts.isolated === true;
  if (!isolated) {
    const migrated = migrateLegacyHomeDataRoot(dataRoot);
    if (migrated.migrated > 0) {
      console.error(
        `[gy] migrated ${migrated.migrated} task(s) from ${migrated.from} -> ${dataRoot}`,
      );
    }
  }
  const host = opts.host ?? process.env.GY_HOST ?? "127.0.0.1";
  const port = opts.port ?? Number(process.env.GY_PORT ?? 8787);
  const runtime = (opts.runtime ?? process.env.GY_RUNTIME ?? "local") as "local" | "docker";
  const leaseMs = opts.leaseMs ?? Number(process.env.GY_LEASE_MS ?? 15_000);
  const watchdogMs = opts.watchdogMs ?? Number(process.env.GY_WATCHDOG_MS ?? 5_000);
  const ownerId = `cp-${hostname()}-${process.pid}`;
  const version = readPackageVersion(installRoot);

  process.env.GY_HOST = host;
  process.env.GY_PORT = String(port);
  process.env.GY_DATA_DIR = dataRoot;

  const store = new ControlStore(dataRoot);
  const platform = new PlatformStore(dataRoot);
  const settings = new SettingsStore(dataRoot, installRoot);
  if (opts.knowledgeEmbedding) settings.patchKnowledgeEmbedding(opts.knowledgeEmbedding);
  const knowledge = new KnowledgeStore(dataRoot, {
    embeddingSettings: () => settings.get().knowledgeEmbedding,
  });
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
  if (!isolated) watchdog.start();
  const jobs = new JobRunner(store, { defaultPaceMs: Number(process.env.GY_JOB_PACE_MS ?? 0) });
  // 隔离副本（恢复演练）不消费作业队列，避免对副本产生副作用。
  if (!isolated) jobs.start();
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
    platform,
    jobs,
    knowledge,
  });

  return {
    store,
    knowledge,
    runner,
    watchdog,
    isolated,
    /** 本次启动把哪些恢复任务从旧绝对路径收回到本数据根。 */
    rehomed: store.rehomed,
    settings,
    updater,
    server,
    url: server.url,
    async close() {
      await watchdog.stop();
      await jobs.stop();
      await server.close();
      runner.dispose();
      knowledge.close();
      store.close();
      platform.close();
    },
  };
}
export * from "./platform.js";

export {
  AuthorizationInputError,
  appendRecord,
  authorizationDigest,
  currentRecord,
  ledgerPath,
  parseAuthorizationInput,
  parseAuthorizationText,
  readLedger,
  registerAuthorization,
  writeLedger,
} from "./authorization.js";
export type { AssignmentViewWithAuthorization } from "./assignments.js";

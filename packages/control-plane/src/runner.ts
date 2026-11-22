import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import {
  createWriteStream,
  writeFileSync,
  mkdirSync,
  existsSync,
  unlinkSync,
  readdirSync,
} from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import {
  isActiveTaskStatus,
  isTerminalTaskStatus,
  resolveExploreWorkerCount,
  type TaskRecord,
  type TerminalTaskStatus,
  type WorkerManifest,
} from "@gongyuai/contracts";
import { openHistory, writeTaskReport } from "@gongyuai/history";
import { durableDbForSlot, manifestPathForSlot, taskPaths } from "./paths.js";
import { exhaustedCounter, mergeUsageFromDisk, refreshTaskUsage } from "./usage.js";
import type { ControlStore } from "./store.js";
import type { SettingsStore } from "./settings.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "../../..");

export type RuntimeMode = "local" | "docker";

export type RunnerConfig = {
  mode: RuntimeMode;
  workerImage: string;
  leaseMs: number;
  ownerId: string;
};

function taskWorkerCount(task: TaskRecord): number {
  return resolveExploreWorkerCount({
    maxConcurrentExplores: task.execution?.maxConcurrentExplores ?? 1,
    targetCount: task.auth.targets.length,
  });
}

function writeManifestForSlot(
  task: TaskRecord,
  settings: SettingsStore,
  slot: number,
  workerCount: number,
): WorkerManifest {
  const paths = taskPaths(task.dataDir);
  const model = settings.modelForManifest();
  const durableDb = durableDbForSlot(task.dataDir, slot);
  const manifestPath = manifestPathForSlot(task.dataDir, slot);
  // A checkpoint already includes its own counters. Debit any earlier usage
  // that survived only in the control ledger from finite worker limits.
  const budget = { ...task.budget };
  if (task.usageOffset) {
    for (const [limit, meter] of [
      ["maxTokens", "tokens"], ["maxToolCalls", "toolCalls"], ["maxInstalls", "installs"],
    ] as const) {
      if (budget[limit] > 0) {
        budget[limit] -= task.usageOffset[meter];
        if (budget[limit] <= 0) throw new Error(`existing task budget exhausted: ${limit}`);
      }
    }
  }
  const manifest: WorkerManifest = {
    taskId: task.id,
    dataDir: task.dataDir,
    historyDb: paths.historyDb,
    durableDb,
    evidenceDir: paths.evidenceDir,
    workspaceDir: paths.workspaceDir,
    auth: task.auth,
    goals: task.goals,
    budget,
    execution: task.execution,
    workerId: `w${slot}-${task.id.slice(0, 8)}`,
    workerSlot: slot,
    workerCount,
    mock: task.mock,
    model,
    mcpServers: settings.enabledMcpForManifest(),
    mcpPool: settings.allMcpForManifest(),
    mcpCatalog: settings.mcpCatalogForManifest(),
    skillPacks: settings.enabledSkillsForManifest(),
    skillPool: settings.routedSkillsForManifest(),
    skillCatalog: settings.skillCatalogForManifest(),
    assetCollectors: settings.enabledAssetCollectorsForManifest(),
  };
  mkdirSync(task.dataDir, { recursive: true });
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

  // Seed once (idempotent) from the leader write path.
  if (slot === 0) {
    const history = openHistory({
      dbPath: paths.historyDb,
      evidenceDir: paths.evidenceDir,
    });
    history.seedGoals(task.id, task.goals);
    history.seedAssetsFromAuth(task.id, task.auth);
    history.close();
  }

  return manifest;
}

export class WorkerRunner {
  /** taskId → slot → child */
  private readonly children = new Map<string, Map<number, ChildProcess>>();

  constructor(
    private readonly store: ControlStore,
    private readonly cfg: RunnerConfig,
    private readonly settings: SettingsStore,
  ) {}

  async start(taskId: string): Promise<TaskRecord> {
    const task = this.store.get(taskId);
    if (!task) throw new Error(`task not found: ${taskId}`);

    if (this.isAlive(task)) {
      throw new Error("任务已在运行中");
    }

    if (!isActiveTaskStatus(task.status)) {
      this.prepareRestart(task);
    }

    const lease = this.store.acquireLease(taskId, this.cfg.ownerId, this.cfg.leaseMs);
    if (!lease.ok) throw new Error(`lease: ${lease.reason}`);

    const workerCount = taskWorkerCount(lease.task);
    for (let slot = 0; slot < workerCount; slot++) {
      writeManifestForSlot(lease.task, this.settings, slot, workerCount);
    }

    if (this.cfg.mode === "docker") {
      return this.startDocker(lease.task, workerCount);
    }
    return this.startLocal(lease.task, workerCount);
  }

  /** 从终态重新开始：清掉完成标记，必要时重置已完成的检查点 */
  private prepareRestart(task: TaskRecord): void {
    const usage = refreshTaskUsage(task);
    const exhausted = exhaustedCounter(task);
    if (exhausted) throw new Error(`existing task budget exhausted: ${exhausted}`);
    task.runStartUsage = { ...usage };
    const resetCkpt = (ckptPath: string) => {
      if (!existsSync(ckptPath)) return;
      try {
        const db = new DatabaseSync(ckptPath);
        const row = db.prepare(`SELECT json FROM checkpoint WHERE id = 1`).get() as
          | { json: string }
          | undefined;
        if (row) {
          const state = JSON.parse(row.json) as { phase?: string };
          if (state.phase === "done" || state.phase === "report") {
            state.phase = "explore";
            db.prepare(
              `INSERT INTO checkpoint (id, json) VALUES (1, ?)
               ON CONFLICT(id) DO UPDATE SET json = excluded.json`,
            ).run(JSON.stringify({ ...state, updatedAt: new Date().toISOString() }));
          }
        }
        db.close();
      } catch {
        /* keep existing checkpoint */
      }
    };

    const count = taskWorkerCount(task);
    for (let slot = 0; slot < count; slot++) {
      resetCkpt(`${durableDbForSlot(task.dataDir, slot)}.ckpt.sqlite`);
    }
    // Legacy / stray slot checkpoints
    try {
      for (const name of readdirSync(task.dataDir)) {
        if (name.endsWith(".ckpt.sqlite")) {
          resetCkpt(join(task.dataDir, name));
        }
      }
    } catch {
      /* ignore */
    }

    const statusPath = join(task.dataDir, "worker-status.json");
    if (existsSync(statusPath)) {
      try {
        unlinkSync(statusPath);
      } catch {
        /* ignore */
      }
    }
    try {
      for (const name of readdirSync(task.dataDir)) {
        if (/^worker-status(-w\d+)?\.json$/.test(name)) {
          try {
            unlinkSync(join(task.dataDir, name));
          } catch {
            /* ignore */
          }
        }
      }
    } catch {
      /* ignore */
    }

    // Only checkpoint counters survive removal of the old status files.
    const carried = mergeUsageFromDisk(task.dataDir, { tokens: 0, toolCalls: 0, installs: 0 });
    task.usageOffset = {
      tokens: Math.max(0, usage.tokens - carried.tokens),
      toolCalls: Math.max(0, usage.toolCalls - carried.toolCalls),
      installs: Math.max(0, usage.installs - carried.installs),
    };
    task.status = "queued";
    // Wall clock must restart — keeping the original startedAt makes watchdog
    // instantly re-fire maxWallMs on "开始" after a long idle.
    task.startedAt = null;
    task.finishedAt = null;
    task.archivedAt = null;
    task.error = null;
    task.workerPid = null;
    task.workerPids = [];
    task.containerId = null;
    task.containerIds = [];
    task.leaseOwner = null;
    task.leaseUntil = null;
    this.store.save(task);
  }

  private workerEntry(): string {
    const dist = join(repoRoot, "packages/worker/dist/main.js");
    const src = join(repoRoot, "packages/worker/src/main.ts");
    return existsSync(dist) ? dist : src;
  }

  private trackChild(taskId: string, slot: number, child: ChildProcess): void {
    let slots = this.children.get(taskId);
    if (!slots) {
      slots = new Map();
      this.children.set(taskId, slots);
    }
    slots.set(slot, child);
  }

  private startLocal(task: TaskRecord, workerCount: number): TaskRecord {
    const entry = this.workerEntry();
    const pids: number[] = [];

    for (let slot = 0; slot < workerCount; slot++) {
      const manifestPath = manifestPathForSlot(task.dataDir, slot);
      const args = entry.endsWith(".ts")
        ? ["--import", "tsx", entry, "--manifest", manifestPath]
        : [entry, "--manifest", manifestPath];

      const child = spawn(process.execPath, args, {
        cwd: repoRoot,
        env: {
          ...process.env,
          ...this.settings.workerEnv(),
          GY_TASK_ID: task.id,
          GY_FENCE: String(task.fence),
          GY_WORKER_SLOT: String(slot),
          GY_WORKER_COUNT: String(workerCount),
        },
        stdio: ["ignore", "pipe", "pipe"],
        detached: true,
      });
      child.unref();

      const logPath = join(
        task.dataDir,
        workerCount > 1 ? `worker-w${slot}.log` : "worker.log",
      );
      const log = createWriteStream(logPath, { flags: "a" });
      child.stdout?.pipe(log);
      child.stderr?.pipe(log);

      const capturedSlot = slot;
      child.on("exit", (code) => {
        const slots = this.children.get(task.id);
        if (slots?.get(capturedSlot) !== child) return;
        slots.delete(capturedSlot);
        if (slots.size === 0) this.children.delete(task.id);
        const latest = this.store.get(task.id);
        if (!latest || latest.fence !== task.fence || isTerminalTaskStatus(latest.status)) return;
        // Only mark recovering when the whole pool is dead; watchdog will restart.
        if (!this.isAlive(latest)) {
          latest.status = "recovering";
          latest.workerPid = null;
          latest.workerPids = [];
          latest.error = `worker slot ${capturedSlot} exited with code ${code}`;
          this.store.save(latest);
        } else {
          // Drop dead pid from list while siblings keep running.
          latest.workerPids = (latest.workerPids ?? []).filter((p) => p !== child.pid);
          if (latest.workerPid === child.pid) {
            latest.workerPid = latest.workerPids[0] ?? null;
          }
          this.store.save(latest);
        }
      });

      this.trackChild(task.id, slot, child);
      if (child.pid) pids.push(child.pid);
    }

    task.status = task.status === "queued" ? "initializing" : "running";
    task.startedAt = task.startedAt ?? new Date().toISOString();
    task.workerPids = pids;
    task.workerPid = pids[0] ?? null;
    task.containerId = null;
    task.containerIds = [];
    this.store.save(task);
    return task;
  }

  private startDocker(task: TaskRecord, workerCount: number): TaskRecord {
    const absData = resolve(task.dataDir);
    const containerIds: string[] = [];

    for (let slot = 0; slot < workerCount; slot++) {
      const name = `gy-task-${task.id.slice(0, 8)}-w${slot}`;
      spawnSync("docker", ["rm", "-f", name], { encoding: "utf8" });
      const manifestInContainer =
        slot === 0 ? "/task/manifest.json" : `/task/manifest-w${slot}.json`;

      const args = [
        "run",
        "-d",
        "--name",
        name,
        "--network",
        "bridge",
        "-v",
        `${absData}:/task`,
        "-e",
        `GY_MANIFEST=${manifestInContainer}`,
        "-e",
        `GY_WORKER_SLOT=${slot}`,
        "-e",
        `GY_WORKER_COUNT=${workerCount}`,
        "-e",
        `OPENAI_API_KEY=${this.settings.workerEnv().OPENAI_API_KEY}`,
        "-e",
        `OPENAI_BASE_URL=${this.settings.workerEnv().OPENAI_BASE_URL}`,
        "-e",
        `GY_MODEL=${this.settings.workerEnv().GY_MODEL}`,
        "-e",
        `GY_VISION=${this.settings.workerEnv().GY_VISION}`,
        "-e",
        `GY_VISION_MODEL=${this.settings.workerEnv().GY_VISION_MODEL}`,
        this.cfg.workerImage,
      ];

      const result = spawnSync("docker", args, { encoding: "utf8" });
      if (result.status !== 0) {
        // Best-effort cleanup of already-started siblings.
        for (const id of containerIds) {
          spawnSync("docker", ["rm", "-f", id], { encoding: "utf8" });
        }
        throw new Error(`docker run failed (slot ${slot}): ${result.stderr || result.stdout}`);
      }
      const containerId = (result.stdout || "").trim() || name;
      containerIds.push(containerId);
    }

    task.status = task.status === "queued" ? "initializing" : "running";
    task.startedAt = task.startedAt ?? new Date().toISOString();
    task.containerIds = containerIds;
    task.containerId = containerIds[0] ?? null;
    task.workerPid = null;
    task.workerPids = [];
    this.store.save(task);
    return task;
  }

  private stopWorkers(task: TaskRecord): void {
    const taskId = task.id;
    const locals = this.children.get(taskId);
    const localPids = new Set(Array.from(locals?.values() ?? [], (child) => child.pid));
    const pids = new Set(task.workerPids?.length
      ? task.workerPids
      : task.workerPid ? [task.workerPid] : []);
    for (const pid of localPids) if (pid) pids.add(pid);
    for (const pid of pids) {
      // A tracked detached child owns its own process group.
      if (localPids.has(pid)) {
        try {
          process.kill(-pid, "SIGTERM");
          continue;
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code !== "ESRCH") throw err;
        }
      }
      try {
        process.kill(pid, "SIGTERM");
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ESRCH") throw err;
      }
    }

    const containers =
      task.containerIds?.length ? task.containerIds : task.containerId ? [task.containerId] : [];
    for (const id of containers) {
      const result = spawnSync("docker", ["rm", "-f", id], { encoding: "utf8" });
      if (result.status !== 0 && !/no such container/i.test(result.stderr ?? "")) {
        throw new Error(`failed to stop worker container ${id}: ${result.error?.message ?? result.stderr}`);
      }
    }
    this.children.delete(taskId);
  }

  finishWorkerRun(task: TaskRecord, status: TerminalTaskStatus, error: string | null): TaskRecord {
    this.stopWorkers(task);
    return this.store.finishTask(task, status, error);
  }

  async stop(taskId: string, cause: "operator" | "wall-timeout" | NonNullable<ReturnType<typeof exhaustedCounter>> = "operator"): Promise<TaskRecord | null> {
    const task = this.store.get(taskId);
    if (!task) return null;
    if (isTerminalTaskStatus(task.status)) {
      if (task.workerPid || task.workerPids.length || task.containerId || task.containerIds.length) {
        return this.finishWorkerRun(task, task.status, task.error);
      }
      return task;
    }
    this.stopWorkers(task);

    let status: "stopped" | "budget_exhausted" | "failed" = "stopped";
    let error: string | null = null;
    if (cause !== "operator") {
      status = "budget_exhausted";
      error = cause === "wall-timeout" ? "maxWallMs exceeded" : `${cause} exceeded`;
    }
    const paths = taskPaths(task.dataDir);
    try {
      const history = openHistory({ dbPath: paths.historyDb, evidenceDir: paths.evidenceDir });
      try {
        history.seedGoals(taskId, task.goals);
        task.goals = history.listGoals(taskId);
        writeTaskReport({ taskId, dataDir: task.dataDir, auth: task.auth }, history, {
          status, reason: error ?? undefined,
        });
      } finally {
        history.close();
      }
    } catch (err) {
      status = "failed";
      error = [error, `report finalization failed: ${err instanceof Error ? err.message : String(err)}`]
        .filter(Boolean).join("; ");
    }
    return this.store.finishTask(task, status, error);
  }

  isAlive(task: TaskRecord): boolean {
    if (this.cfg.mode === "local") {
      const pids = task.workerPids?.length
        ? task.workerPids
        : task.workerPid
          ? [task.workerPid]
          : [];
      if (!pids.length) return false;
      return pids.some((pid) => {
        try {
          process.kill(pid, 0);
          return true;
        } catch {
          return false;
        }
      });
    }

    const containers =
      task.containerIds?.length ? task.containerIds : task.containerId ? [task.containerId] : [];
    if (!containers.length) return false;
    return containers.some((id) => {
      const r = spawnSync(
        "docker",
        ["inspect", "-f", "{{.State.Running}}", id],
        { encoding: "utf8" },
      );
      return r.status === 0 && String(r.stdout).trim() === "true";
    });
  }
}

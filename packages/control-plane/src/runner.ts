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
  goalsFromSpecs,
  isActiveTaskStatus,
  isDrainingTaskStatus,
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

function taskWorkerCount(task: TaskRecord, assetCount?: number): number {
  return resolveExploreWorkerCount({
    maxConcurrentExplores: task.execution?.maxConcurrentExplores ?? 1,
    targetCount: task.auth.targets.length,
    assetCount,
  });
}

/** Distinct admitted/live assets from the History projection; 0 when no History yet. */
function countScalableAssets(task: TaskRecord): number {
  const paths = taskPaths(task.dataDir);
  if (!existsSync(paths.historyDb)) return 0;
  const history = openHistory({ dbPath: paths.historyDb, evidenceDir: paths.evidenceDir });
  try {
    return history.listAssets(task.id).filter((a) => a.kind === "admitted" || a.kind === "live").length;
  } finally {
    history.close();
  }
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
    scopeVersion: task.scopeVersion,
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

/** How long a pause may wait for workers to drain before reporting a failed pause. */
const PAUSE_DRAIN_MS = 15_000;

export class WorkerRunner {
  /** taskId → slot → child */
  private readonly children = new Map<string, Map<number, ChildProcess>>();
  /** taskId → last reconcile timestamp (throttle; in-memory only) */
  private readonly lastScaleCheck = new Map<string, number>();
  /** Set by boot shutdown: detached workers may outlive this control plane. */
  private disposed = false;

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
    if (isDrainingTaskStatus(task.status)) {
      throw new Error(`任务正在${task.status === "pause_requested" ? "暂停" : "停止"}，等待确认后再操作`);
    }

    if (!isActiveTaskStatus(task.status)) {
      this.prepareRestart(task);
    }

    const lease = this.store.acquireLease(taskId, this.cfg.ownerId, this.cfg.leaseMs);
    if (!lease.ok) throw new Error(`lease: ${lease.reason}`);

    const workerCount = taskWorkerCount(lease.task, countScalableAssets(lease.task));
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

    const count = taskWorkerCount(task, countScalableAssets(task));
    // The Durable checkpoint now lives inside the per-slot durable DB itself
    // (CheckpointStore writes table `checkpoint`); `.ckpt.sqlite` is legacy.
    for (let slot = 0; slot < count; slot++) {
      resetCkpt(durableDbForSlot(task.dataDir, slot));
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

  private spawnLocalSlot(task: TaskRecord, slot: number, workerCount: number): ChildProcess {
    const entry = this.workerEntry();
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
      // The control plane may be stopping while detached workers keep running;
      // their exit must not touch a closed store.
      if (this.disposed) return;
      try {
      const slots = this.children.get(task.id);
      if (slots?.get(capturedSlot) !== child) return;
      slots.delete(capturedSlot);
      if (slots.size === 0) this.children.delete(task.id);
      const latest = this.store.get(task.id);
      if (!latest || latest.fence !== task.fence || isTerminalTaskStatus(latest.status)) return;
      // pause()/stop() own the transition out of a draining state; the exit
      // handler must not turn a deliberate pause into a watchdog "recovering".
      if (latest.status === "pause_requested" || latest.status === "stopping") {
        latest.workerPids = (latest.workerPids ?? []).filter((p) => p !== child.pid);
        if (latest.workerPid === child.pid) latest.workerPid = latest.workerPids[0] ?? null;
        this.store.save(latest);
        return;
      }
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
      } catch {
        /* store already closed or record gone: nothing to reconcile */
      }
    });

    this.trackChild(task.id, slot, child);
    return child;
  }

  private startLocal(task: TaskRecord, workerCount: number): TaskRecord {
    const pids: number[] = [];
    for (let slot = 0; slot < workerCount; slot++) {
      const child = this.spawnLocalSlot(task, slot, workerCount);
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

  /**
   * Scale-up only resource provisioning (non-tactical): reads asset counts and
   * liveness, never Fact content. Never exceeds the operator cap, never kills
   * running workers. Called from the watchdog alive branch.
   */
  async reconcileWorkers(taskId: string): Promise<void> {
    const last = this.lastScaleCheck.get(taskId) ?? 0;
    if (Date.now() - last < 10_000) return;
    this.lastScaleCheck.set(taskId, Date.now());

    const task = this.store.get(taskId);
    if (!task || !isActiveTaskStatus(task.status)) return;

    let current: number;
    if (this.cfg.mode === "local") {
      const slots = this.children.get(taskId);
      // Without a live child map (e.g. control-plane restarted) slot identity is
      // unknown; skip rather than risk duplicating a surviving slot.
      if (!slots || slots.size === 0) return;
      current = slots.size;
    } else {
      current = task.containerIds?.length ?? 0;
      if (current === 0) return;
    }

    const assetCount = countScalableAssets(task);
    const desired = taskWorkerCount(task, assetCount);
    if (desired <= current) return;

    for (let slot = 0; slot < desired; slot++) {
      writeManifestForSlot(task, this.settings, slot, desired);
    }

    if (this.cfg.mode === "local") {
      for (let slot = current; slot < desired; slot++) {
        const child = this.spawnLocalSlot(task, slot, desired);
        if (child.pid) task.workerPids = [...(task.workerPids ?? []), child.pid];
      }
      task.workerPid = task.workerPids?.[0] ?? task.workerPid;
    } else {
      for (let slot = current; slot < desired; slot++) {
        const containerId = this.spawnDockerSlot(task, slot, desired);
        task.containerIds = [...(task.containerIds ?? []), containerId];
      }
      task.containerId = task.containerIds?.[0] ?? task.containerId;
    }
    this.store.save(task);

    const paths = taskPaths(task.dataDir);
    const history = openHistory({ dbPath: paths.historyDb, evidenceDir: paths.evidenceDir });
    try {
      history.recordExploreScaled(task.id, { from: current, to: desired, assetCount });
    } finally {
      history.close();
    }
  }

  private spawnDockerSlot(task: TaskRecord, slot: number, workerCount: number): string {
    const absData = resolve(task.dataDir);
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
      throw new Error(`docker run failed (slot ${slot}): ${result.stderr || result.stdout}`);
    }
    return (result.stdout || "").trim() || name;
  }

  private startDocker(task: TaskRecord, workerCount: number): TaskRecord {
    const containerIds: string[] = [];
    for (let slot = 0; slot < workerCount; slot++) {
      try {
        containerIds.push(this.spawnDockerSlot(task, slot, workerCount));
      } catch (err) {
        // Best-effort cleanup of already-started siblings.
        for (const id of containerIds) {
          spawnSync("docker", ["rm", "-f", id], { encoding: "utf8" });
        }
        throw err;
      }
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
    refreshTaskUsage(task);
    task.finishedAt ??= new Date().toISOString();
    const paths = taskPaths(task.dataDir);
    try {
      const history = openHistory({ dbPath: paths.historyDb, evidenceDir: paths.evidenceDir });
      try {
        // A stale control snapshot must never manufacture an assertion in History.
        history.seedGoals(task.id, goalsFromSpecs(task.goals));
        history.withReportTransaction(() => {
          task.goals = history.listGoals(task.id);
          if (status === "completed" && (!task.goals.length || task.goals.some((goal) => !goal.passes))) {
            status = "incomplete";
            error = [error, "History 中仍有未验收目标或缺少目标记录"].filter(Boolean).join(" · ");
          }
          const over = exhaustedCounter(task, "exceeded");
          if (over && status === "completed") {
            status = "budget_exhausted";
            error = [error, `${over} exceeded`].filter(Boolean).join(" · ");
          }
          writeTaskReport({ taskId: task.id, dataDir: task.dataDir, auth: task.auth }, history, {
            status, reason: error ?? undefined, accounting: task,
          });
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

  /**
   * Stage 2 — pause. Drains workers, confirms they are gone, then records
   * `paused` while retaining checkpoint / goals / evidence / usage. Never
   * writes a terminal report and never claims "paused" before the drain is
   * confirmed.
   */
  async pause(taskId: string): Promise<TaskRecord | null> {
    const task = this.store.get(taskId);
    if (!task) return null;
    if (isTerminalTaskStatus(task.status)) throw new Error("终态任务不能暂停");
    if (task.status === "paused") return task;
    if (task.status === "stopping") throw new Error("任务正在停止，不能暂停");

    task.status = "pause_requested";
    task.pauseRequestedAt = new Date().toISOString();
    task.error = null;
    this.store.save(task);

    if (this.isAlive(task)) this.stopWorkers(task);
    const deadline = Date.now() + PAUSE_DRAIN_MS;
    while (this.isAlive(task) && Date.now() < deadline) {
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 200));
    }
    const latest = this.store.get(taskId);
    if (!latest) return null;
    if (this.isAlive(latest)) {
      // Never publish a false pause: put the record back where it can be retried.
      latest.status = "recovering";
      latest.error = "pause not confirmed: worker still alive after drain window";
      this.store.save(latest);
      throw new Error(latest.error);
    }
    latest.status = "paused";
    latest.pausedAt = new Date().toISOString();
    latest.lastHeartbeatAt = latest.pausedAt;
    latest.workerPid = null;
    latest.workerPids = [];
    latest.containerId = null;
    latest.containerIds = [];
    latest.leaseOwner = null;
    latest.leaseUntil = null;
    latest.error = null;
    this.store.save(latest);
    this.children.delete(taskId);
    return latest;
  }

  /** Stage 2 — resume; start() rebuilds manifests from the latest scope revision. */
  async resume(taskId: string): Promise<TaskRecord> {
    const task = this.store.get(taskId);
    if (!task) throw new Error(`task not found: ${taskId}`);
    if (isTerminalTaskStatus(task.status)) throw new Error("终态任务不能继续");
    if (task.status !== "paused") throw new Error("仅已暂停任务可继续");
    return this.start(taskId);
  }

  /**
   * Stage 2 — write a new authorization revision. Refused while a worker is
   * acting so a running engagement can never silently inherit a widened scope.
   */
  setScope(taskId: string, auth: TaskRecord["auth"], reason: string): TaskRecord {
    const task = this.store.get(taskId);
    if (!task) throw new Error(`task not found: ${taskId}`);
    if (isTerminalTaskStatus(task.status)) throw new Error("终态任务不能修改授权范围");
    if (this.isAlive(task)) throw new Error("先暂停任务，再更新授权范围（恢复时会读取最新版本）");
    const note = reason.trim();
    if (!note) throw new Error("scope update requires a reason");
    task.auth = auth;
    task.scopeVersion += 1;
    task.error = null;
    this.store.save(task);
    return task;
  }

  async stop(taskId: string, cause: "operator" | "wall-timeout" | NonNullable<ReturnType<typeof exhaustedCounter>> = "operator"): Promise<TaskRecord | null> {
    const task = this.store.get(taskId);
    if (!task) return null;
    if (isTerminalTaskStatus(task.status)) {
      if (task.workerPid || task.workerPids.length || task.containerId || task.containerIds.length) {
        this.stopWorkers(task);
        return this.store.finishTask(task, task.status, task.error);
      }
      return task;
    }

    task.status = "stopping";
    this.store.save(task);
    let status: "stopped" | "budget_exhausted" = "stopped";
    let error: string | null = null;
    if (cause !== "operator") {
      status = "budget_exhausted";
      error = cause === "wall-timeout" ? "maxWallMs exceeded" : `${cause} exceeded`;
    }
    return this.finishWorkerRun(task, status, error);
  }

  /** Stop observing children; used when the control plane shuts down. */
  dispose(): void {
    this.disposed = true;
    this.children.clear();
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

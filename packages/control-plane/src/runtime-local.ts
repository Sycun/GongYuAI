import { spawn, type ChildProcess } from "node:child_process";
import { createWriteStream, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isTerminalTaskStatus, type TaskRecord } from "@gongyuai/contracts";
import { openHistory } from "@gongyuai/history";
import { taskPaths } from "./paths.js";
import { recordExploreScaled, writeManifestForSlot } from "./runtime-manifest.js";
import type { ControlStore } from "./store.js";
import type { SettingsStore } from "./settings.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

export type LocalRuntimeHost = {
  store: ControlStore;
  settings: SettingsStore;
  disposed: () => boolean;
  isAlive: (task: TaskRecord) => boolean;
};

type SlotBackoff = { count: number; lastSpawnAt: number };

/**
 * 本地子进程槽位：拉起、退出回收、扩容补槽与停止。
 * 不决定任务状态机；协调仍在 WorkerRunner。
 */
export class LocalWorkerRuntime {
  readonly children = new Map<string, Map<number, ChildProcess>>();
  private readonly slotBackoff = new Map<string, SlotBackoff>();

  constructor(private readonly host: LocalRuntimeHost) {}

  private workerEntry(): string {
    const dist = join(repoRoot, "packages/worker/dist/reviewed-main.js");
    const src = join(repoRoot, "packages/worker/src/main.ts");
    return existsSync(dist) ? dist : src;
  }

  track(taskId: string, slot: number, child: ChildProcess): void {
    let slots = this.children.get(taskId);
    if (!slots) {
      slots = new Map();
      this.children.set(taskId, slots);
    }
    slots.set(slot, child);
  }

  spawn(task: TaskRecord, slot: number, workerCount: number): ChildProcess {
    const entry = this.workerEntry();
    const manifestPath = join(task.dataDir, slot <= 0 ? "manifest.json" : `manifest-w${slot}.json`);
    const args = entry.endsWith(".ts")
      ? ["--import", "tsx", entry, "--manifest", manifestPath]
      : [entry, "--manifest", manifestPath];

    const child = spawn(process.execPath, args, {
      cwd: repoRoot,
      env: {
        ...process.env,
        ...this.host.settings.workerEnv(),
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
    log.on("error", () => { /* ignore log write errors on teardown */ });
    child.stdout?.pipe(log, { end: false });
    child.stderr?.pipe(log, { end: false });
    child.once("close", () => {
      log.end();
    });

    const capturedSlot = slot;
    child.on("exit", (code) => {
      // The control plane may be stopping while detached workers keep running;
      // their exit must not touch a closed store.
      if (this.host.disposed()) return;
      try {
        const slots = this.children.get(task.id);
        if (slots?.get(capturedSlot) !== child) return;
        slots.delete(capturedSlot);
        if (slots.size === 0) this.children.delete(task.id);
        const latest = this.host.store.get(task.id);
        if (!latest || latest.fence !== task.fence || isTerminalTaskStatus(latest.status)) return;
        // pause()/stop() own the transition out of a draining state; the exit
        // handler must not turn a deliberate pause into a watchdog "recovering".
        if (latest.status === "pause_requested" || latest.status === "stopping") {
          latest.workerPids = (latest.workerPids ?? []).filter((p) => p !== child.pid);
          if (latest.workerPid === child.pid) latest.workerPid = latest.workerPids[0] ?? null;
          this.host.store.save(latest);
          return;
        }
        // Only mark recovering when the whole pool is dead; watchdog will restart.
        if (!this.host.isAlive(latest)) {
          latest.status = "recovering";
          latest.workerPid = null;
          latest.workerPids = [];
          latest.error = `worker slot ${capturedSlot} exited with code ${code}`;
          this.host.store.save(latest);
        } else {
          latest.workerPids = (latest.workerPids ?? []).filter((p) => p !== child.pid);
          if (latest.workerPid === child.pid) {
            latest.workerPid = latest.workerPids[0] ?? null;
          }
          this.host.store.save(latest);
        }
      } catch {
        /* store already closed or record gone: nothing to reconcile */
      }
    });

    this.track(task.id, slot, child);
    return child;
  }

  /**
   * 只补缺失槽，不缩池。spawn 由调用方传入，便于测试替换 WorkerRunner.spawnLocalSlot。
   * 不删除 children：停止顺序由 WorkerRunner.stopWorkers 统一收口。
   */
  reconcile(input: {
    task: TaskRecord;
    computed: number;
    assetCount: number;
    maxPoolSize: Map<string, number>;
    spawn: (slot: number, workerCount: number) => ChildProcess;
    save: (task: TaskRecord) => void;
  }): void {
    const { task, computed, assetCount, maxPoolSize, spawn, save } = input;
    const taskId = task.id;
    const slots = this.children.get(taskId);
    // Without a live child map (e.g. control-plane restarted) slot identity is
    // unknown; skip rather than risk duplicating a surviving slot.
    if (!slots || slots.size === 0) return;
    const highestSlot = Math.max(...slots.keys()) + 1;
    const prevPool = Math.max(maxPoolSize.get(taskId) ?? 0, highestSlot);
    const targetPool = Math.max(prevPool, computed);
    const missingSlots: number[] = [];
    for (let slot = 0; slot < targetPool; slot++) {
      const child = slots.get(slot);
      const slotAlive = Boolean(
        child &&
        child.exitCode == null &&
        child.signalCode == null &&
        !child.killed,
      );
      if (!slotAlive) {
        slots.delete(slot);
        missingSlots.push(slot);
      }
    }
    if (missingSlots.length === 0) return;

    // Avoid respawning followers if leader already wrote a terminal status sidecar
    // or all goals have already passed.
    if (targetPool === prevPool) {
      const paths = taskPaths(task.dataDir);
      if (existsSync(paths.historyDb)) {
        const history = openHistory({ dbPath: paths.historyDb, evidenceDir: paths.evidenceDir, readOnly: true });
        try {
          if (history.allGoalsPass(task.id)) return;
        } finally {
          history.close();
        }
      }
    }

    const now = Date.now();
    const readySlots: number[] = [];
    for (const slot of missingSlots) {
      const key = `${taskId}:${slot}`;
      const prev = this.slotBackoff.get(key);
      if (prev) {
        const aliveLongEnough = now - prev.lastSpawnAt >= 60_000;
        const nextCount = aliveLongEnough ? 0 : prev.count;
        // Allow immediate first respawn for a single transient exit; apply exponential backoff on repeated rapid crashes.
        const cooldownMs = nextCount >= 2 ? Math.min(60_000, 5_000 * 2 ** (nextCount - 2)) : 0;
        if (cooldownMs > 0 && now - prev.lastSpawnAt < cooldownMs) {
          continue;
        }
        this.slotBackoff.set(key, { count: nextCount + 1, lastSpawnAt: now });
      } else {
        this.slotBackoff.set(key, { count: 1, lastSpawnAt: now });
      }
      readySlots.push(slot);
    }
    if (readySlots.length === 0) return;

    maxPoolSize.set(taskId, targetPool);
    for (let slot = 0; slot < targetPool; slot++) {
      writeManifestForSlot(task, this.host.settings, slot, targetPool);
    }
    for (const slot of readySlots) {
      const child = spawn(slot, targetPool);
      if (child.pid && !(task.workerPids ?? []).includes(child.pid)) {
        task.workerPids = [...(task.workerPids ?? []), child.pid];
      }
    }
    task.workerPid = task.workerPids?.[0] ?? task.workerPid;
    save(task);

    if (targetPool > prevPool) recordExploreScaled(task, prevPool, targetPool, assetCount);
  }

  /** 发停止信号。槽位表由调用方在 docker 停止之后删除，避免退出回调抢在收口前改状态。 */
  stop(task: TaskRecord, opts?: { preserveDetachedSessions?: boolean }): void {
    const preserveSessions = Boolean(opts?.preserveDetachedSessions);
    const locals = this.children.get(task.id);
    const localPids = new Set(Array.from(locals?.values() ?? [], (child) => child.pid));
    const pids = new Set(task.workerPids?.length
      ? task.workerPids
      : task.workerPid ? [task.workerPid] : []);
    for (const pid of localPids) if (pid) pids.add(pid);
    for (const pid of pids) {
      // On terminal stop, kill the process group so no stray tool subprocesses survive;
      // on pause, signal the worker PID directly so detached PTY sessions survive (P11/P14-B4).
      if (!preserveSessions && localPids.has(pid)) {
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
  }

  clearBackoff(taskId: string): void {
    const prefix = `${taskId}:`;
    for (const key of this.slotBackoff.keys()) {
      if (key.startsWith(prefix)) this.slotBackoff.delete(key);
    }
  }

  dispose(): void {
    this.children.clear();
    this.slotBackoff.clear();
  }

  isAlive(task: TaskRecord): boolean {
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
}

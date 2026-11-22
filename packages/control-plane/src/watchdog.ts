import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { isActiveTaskStatus, isTerminalTaskStatus, isWallHit } from "@gongyuai/contracts";
import { openHistory } from "@gongyuai/history";
import { taskPaths } from "./paths.js";
import { exhaustedCounter, refreshTaskUsage } from "./usage.js";
import type { ControlStore } from "./store.js";
import type { WorkerRunner } from "./runner.js";

export type WatchdogConfig = {
  intervalMs: number;
  leaseMs: number;
  ownerId: string;
};

/**
 * Zero-strategy keep-alive: renew leases for live workers; restart dead ones;
 * promote terminal status from worker status file / history goals.
 */
export class Watchdog {
  private timer: NodeJS.Timeout | null = null;
  private pending: Promise<void> | null = null;

  constructor(
    private readonly store: ControlStore,
    private readonly runner: WorkerRunner,
    private readonly cfg: WatchdogConfig,
  ) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.tick();
    }, this.cfg.intervalMs);
    this.timer.unref?.();
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.pending;
  }

  tick(): Promise<void> {
    this.pending ??= this.poll().finally(() => { this.pending = null; });
    return this.pending;
  }

  private async poll(): Promise<void> {
    for (const task of this.store.activeTasks()) {
      try {
        await this.handle(task.id);
      } catch (err) {
        const latest = this.store.get(task.id);
        if (latest && isActiveTaskStatus(latest.status)) {
          latest.error = err instanceof Error ? err.message : String(err);
          this.store.save(latest);
        }
      }
    }
  }

  private readStatus(dataDir: string): {
    status?: string;
    error?: string;
    usage?: { tokens?: number; toolCalls?: number; installs?: number };
  } | null {
    // Only the leader owns the task-level outcome.
    const primary = join(dataDir, "worker-status.json");
    if (existsSync(primary)) {
      try {
        return JSON.parse(readFileSync(primary, "utf8")) as {
          status?: string;
          error?: string;
          usage?: { tokens?: number; toolCalls?: number; installs?: number };
        };
      } catch {
        /* fall through */
      }
    }
    return null;
  }

  private async handle(taskId: string): Promise<void> {
    const task = this.store.get(taskId);
    if (!task || !isActiveTaskStatus(task.status)) return;
    if (
      task.leaseOwner && task.leaseOwner !== this.cfg.ownerId &&
      task.leaseUntil && Date.parse(task.leaseUntil) > Date.now()
    ) return;

    // Sync usage from worker-status + checkpoint (status sidecar can lag on Pi).
    refreshTaskUsage(task);

    // Promote terminal from worker status sidecar
    const worker = this.readStatus(task.dataDir);
    if (worker && isTerminalTaskStatus(worker.status)) {
      // Stop the entire pool even if the leader already exited.
      const paths = taskPaths(task.dataDir);
      let status = worker.status;
      let error = worker.error ?? null;
      try {
        if (existsSync(paths.historyDb)) {
          const history = openHistory({ dbPath: paths.historyDb, evidenceDir: paths.evidenceDir });
          try {
            task.goals = history.listGoals(task.id);
          } finally {
            history.close();
          }
        }
      } catch (err) {
        if (status === "completed") status = "failed";
        const detail = err instanceof Error ? err.message : String(err);
        error = [error, `could not read final goal state: ${detail}`].filter(Boolean).join("; ");
      }
      this.runner.finishWorkerRun(task, status, error);
      return;
    }
    this.store.save(task);

    const exhausted = exhaustedCounter(task);
    if (exhausted) {
      await this.runner.stop(taskId, exhausted);
      return;
    }

    // Optional wall clock (0 = unlimited)
    if (task.startedAt) {
      const startedMs = Date.parse(task.startedAt);
      if (isWallHit(startedMs, task.budget.maxWallMs)) {
        await this.runner.stop(taskId, "wall-timeout");
        return;
      }
    }

    const alive = this.runner.isAlive(task);
    if (alive) {
      if (task.status === "initializing" || task.status === "recovering") {
        task.status = "running";
        this.store.save(task);
      }
      if (task.leaseOwner === this.cfg.ownerId) {
        this.store.renewLease(taskId, this.cfg.ownerId, task.fence, this.cfg.leaseMs);
      }
      return;
    }

    // Dead worker pool: restart if still active
    task.status = "recovering";
    task.workerPid = null;
    task.workerPids = [];
    task.containerId = null;
    task.containerIds = [];
    this.store.save(task);
    await this.runner.start(taskId);
  }
}

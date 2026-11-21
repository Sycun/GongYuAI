import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { openHistory } from "@gongyuai/history";
import { taskPaths } from "./paths.js";
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

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async tick(): Promise<void> {
    for (const task of this.store.activeTasks()) {
      try {
        await this.handle(task.id);
      } catch (err) {
        const latest = this.store.get(task.id);
        if (latest) {
          latest.error = err instanceof Error ? err.message : String(err);
          this.store.save(latest);
        }
      }
    }
  }

  private async handle(taskId: string): Promise<void> {
    const task = this.store.get(taskId);
    if (!task) return;

    // Terminal promotion from worker status sidecar
    const statusPath = join(task.dataDir, "worker-status.json");
    if (existsSync(statusPath)) {
      try {
        const status = JSON.parse(readFileSync(statusPath, "utf8")) as {
          status?: string;
          error?: string;
          usage?: { tokens?: number; toolCalls?: number; installs?: number };
        };
        if (
          status.status === "completed" ||
          status.status === "failed" ||
          status.status === "budget_exhausted"
        ) {
          if (status.usage) {
            task.usage = {
              tokens: status.usage.tokens ?? task.usage.tokens,
              toolCalls: status.usage.toolCalls ?? task.usage.toolCalls,
              installs: status.usage.installs ?? task.usage.installs,
            };
          }
          // Sync goals from history before terminal promotion
          const paths = taskPaths(task.dataDir);
          if (existsSync(paths.historyDb)) {
            const history = openHistory({
              dbPath: paths.historyDb,
              evidenceDir: paths.evidenceDir,
            });
            task.goals = history.listGoals(task.id);
            history.close();
          }
          task.status = status.status as typeof task.status;
          task.error = status.error ?? null;
          task.finishedAt = new Date().toISOString();
          task.leaseOwner = null;
          task.leaseUntil = null;
          this.store.save(task);
          return;
        }
      } catch {
        /* ignore corrupt status */
      }
    }

    // Budget wall clock
    if (task.startedAt) {
      const elapsed = Date.now() - Date.parse(task.startedAt);
      if (elapsed > task.budget.maxWallMs) {
        await this.runner.stop(taskId);
        this.store.setStatus(taskId, "budget_exhausted", "maxWallMs exceeded");
        return;
      }
    }

    const alive = this.runner.isAlive(task);
    if (alive) {
      if (task.leaseOwner === this.cfg.ownerId) {
        this.store.renewLease(taskId, this.cfg.ownerId, task.fence, this.cfg.leaseMs);
      }
      if (task.status === "initializing" || task.status === "recovering") {
        task.status = "running";
        this.store.save(task);
      }
      return;
    }

    // Dead worker: restart if still active
    if (["queued", "initializing", "running", "recovering"].includes(task.status)) {
      task.status = "recovering";
      task.workerPid = null;
      task.containerId = null;
      this.store.save(task);
      await this.runner.start(taskId);
    }
  }
}

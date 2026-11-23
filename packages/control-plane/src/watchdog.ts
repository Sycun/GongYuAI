import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { isActiveTaskStatus, isDrainingTaskStatus, isTerminalTaskStatus, isWallHit } from "@gongyuai/contracts";
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
    if (!task || task.assignment || !isActiveTaskStatus(task.status)) return;
    // Draining states are owned by the operator action (pause/stop). The
    // watchdog neither restarts nor promotes them.
    if (isDrainingTaskStatus(task.status)) {
      if (task.status === "pause_requested" && task.commandReview?.fence === task.fence &&
          (!task.leaseOwner || task.leaseOwner === this.cfg.ownerId || !task.leaseUntil || Date.parse(task.leaseUntil) <= Date.now())) {
        await this.runner.pause(taskId);
      }
      return;
    }
    if (
      task.leaseOwner && task.leaseOwner !== this.cfg.ownerId &&
      task.leaseUntil && Date.parse(task.leaseUntil) > Date.now()
    ) return;

    if (await this.runner.reconcileCommands(task)) {
      if (task.leaseOwner === this.cfg.ownerId && this.runner.isAlive(task)) {
        this.store.renewLease(task.id, this.cfg.ownerId, task.fence, this.cfg.leaseMs);
      }
      return;
    }

    // Sync usage from worker-status + checkpoint (status sidecar can lag on Pi).
    refreshTaskUsage(task);

    // Promote terminal from worker status sidecar
    const worker = this.readStatus(task.dataDir);
    if (worker && isTerminalTaskStatus(worker.status)) {
      this.runner.finishWorkerRun(task, worker.status, worker.error ?? null);
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
      // A control-plane-observed heartbeat, used to distinguish "running" from
      // "external state unknown" in the runtime view.
      task.lastHeartbeatAt = new Date().toISOString();
      if (task.status === "initializing" || task.status === "recovering") {
        task.status = "running";
        this.store.save(task);
      }
      if (task.leaseOwner === this.cfg.ownerId) {
        this.store.renewLease(taskId, this.cfg.ownerId, task.fence, this.cfg.leaseMs);
        // Resource provisioning (non-tactical): scale-up only, asset-count driven.
        await this.runner.reconcileWorkers(taskId);
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

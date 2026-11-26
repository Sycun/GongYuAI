import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import type { TaskRecord } from "@gongyuai/contracts";
import { recordExploreScaled, writeManifestForSlot } from "./runtime-manifest.js";
import type { ControlStore } from "./store.js";
import type { SettingsStore } from "./settings.js";

export type DockerRuntimeHost = {
  store: ControlStore;
  settings: SettingsStore;
};

/**
 * Docker 容器槽位：镜像确认后的拉起、探活、扩容与停止。
 * 任务租约和审批仍由 WorkerRunner 决定。
 */
export class DockerWorkerRuntime {
  private readonly slots = new Map<string, Map<number, string>>();
  private readonly imageForRun = new Map<string, string>();

  constructor(private readonly host: DockerRuntimeHost) {}

  rememberImage(taskId: string, image: string): void {
    this.imageForRun.set(taskId, image);
  }

  hasImage(taskId: string): boolean {
    return this.imageForRun.has(taskId);
  }

  discard(taskId: string): void {
    this.slots.delete(taskId);
    this.imageForRun.delete(taskId);
  }

  private spawnSlot(task: TaskRecord, slot: number, workerCount: number): string {
    const image = this.imageForRun.get(task.id);
    if (!image) throw new Error("工作镜像审批版本尚未确认");
    const absData = resolve(task.dataDir);
    const name = `gy-task-${task.id.slice(0, 8)}-w${slot}`;
    spawnSync("docker", ["rm", "-f", name], { encoding: "utf8" });
    const manifestInContainer =
      slot === 0 ? "/task/manifest.json" : `/task/manifest-w${slot}.json`;
    const env = this.host.settings.workerEnv();
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
      `OPENAI_API_KEY=${env.OPENAI_API_KEY}`,
      "-e",
      `OPENAI_BASE_URL=${env.OPENAI_BASE_URL}`,
      "-e",
      `GY_MODEL=${env.GY_MODEL}`,
      "-e",
      `GY_VISION=${env.GY_VISION}`,
      "-e",
      `GY_VISION_MODEL=${env.GY_VISION_MODEL}`,
      image,
    ];
    const result = spawnSync("docker", args, { encoding: "utf8" });
    if (result.status !== 0) {
      throw new Error(`docker run failed (slot ${slot}): ${result.stderr || result.stdout}`);
    }
    return (result.stdout || "").trim() || name;
  }

  start(task: TaskRecord, workerCount: number): TaskRecord {
    const containerIds: string[] = [];
    const slotMap = new Map<number, string>();
    for (let slot = 0; slot < workerCount; slot++) {
      try {
        const cid = this.spawnSlot(task, slot, workerCount);
        containerIds.push(cid);
        slotMap.set(slot, cid);
      } catch (err) {
        for (const id of containerIds) {
          spawnSync("docker", ["rm", "-f", id], { encoding: "utf8" });
        }
        throw err;
      }
    }
    this.slots.set(task.id, slotMap);
    task.status = task.status === "queued" ? "initializing" : "running";
    task.startedAt = task.startedAt ?? new Date().toISOString();
    task.containerIds = containerIds;
    task.containerId = containerIds[0] ?? null;
    task.workerPid = null;
    task.workerPids = [];
    this.host.store.save(task);
    return task;
  }

  reconcile(input: {
    task: TaskRecord;
    computed: number;
    assetCount: number;
    maxPoolSize: Map<string, number>;
    save: (task: TaskRecord) => void;
  }): void {
    const { task, computed, assetCount, maxPoolSize, save } = input;
    const taskId = task.id;
    if (!this.imageForRun.has(taskId)) return;
    const dSlots = this.slots.get(taskId);
    const current = dSlots ? Math.max(...dSlots.keys(), -1) + 1 : (task.containerIds?.length ?? 0);
    if (current === 0) return;
    const prevPool = Math.max(maxPoolSize.get(taskId) ?? 0, current);
    const targetPool = Math.max(prevPool, computed);
    const missingSlots: number[] = [];
    for (let slot = 0; slot < targetPool; slot++) {
      const cid = dSlots?.get(slot);
      if (!cid) {
        missingSlots.push(slot);
        continue;
      }
      const r = spawnSync("docker", ["inspect", "-f", "{{.State.Running}}", cid], { encoding: "utf8" });
      if (r.status !== 0 || String(r.stdout).trim() !== "true") {
        dSlots?.delete(slot);
        missingSlots.push(slot);
      }
    }
    if (missingSlots.length === 0) return;

    maxPoolSize.set(taskId, targetPool);
    for (let slot = 0; slot < targetPool; slot++) {
      writeManifestForSlot(task, this.host.settings, slot, targetPool);
    }
    let slotMap = this.slots.get(taskId);
    if (!slotMap) {
      slotMap = new Map();
      this.slots.set(taskId, slotMap);
    }
    for (const slot of missingSlots) {
      slotMap.set(slot, this.spawnSlot(task, slot, targetPool));
    }
    task.containerIds = Array.from(slotMap.entries())
      .sort(([a], [b]) => a - b)
      .map(([, id]) => id);
    task.containerId = task.containerIds[0] ?? task.containerId;
    save(task);
    if (targetPool > prevPool) recordExploreScaled(task, prevPool, targetPool, assetCount);
  }

  stop(task: TaskRecord, opts?: { preserveDetachedSessions?: boolean }): void {
    const preserveSessions = Boolean(opts?.preserveDetachedSessions);
    const containers =
      task.containerIds?.length ? task.containerIds : task.containerId ? [task.containerId] : [];
    for (const id of containers) {
      if (preserveSessions) {
        const paused = spawnSync("docker", ["stop", "-t", "5", id], { encoding: "utf8" });
        if (paused.status !== 0 && !/no such container/i.test(paused.stderr ?? "")) {
          spawnSync("docker", ["rm", "-f", id], { encoding: "utf8" });
        }
        continue;
      }
      const result = spawnSync("docker", ["rm", "-f", id], { encoding: "utf8" });
      if (result.status !== 0 && !/no such container/i.test(result.stderr ?? "")) {
        throw new Error(`failed to stop worker container ${id}: ${result.error?.message ?? result.stderr}`);
      }
    }
  }

  isAlive(task: TaskRecord): boolean {
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

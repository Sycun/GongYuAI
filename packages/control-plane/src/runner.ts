import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import {
  createWriteStream,
  writeFileSync,
  mkdirSync,
  existsSync,
  unlinkSync,
} from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import type { TaskRecord, WorkerManifest } from "@gongyuai/contracts";
import { openHistory } from "@gongyuai/history";
import { taskPaths } from "./paths.js";
import type { ControlStore } from "./store.js";
import type { SettingsStore } from "./settings.js";

const TERMINAL = new Set(["stopped", "failed", "completed", "budget_exhausted"]);
const ACTIVE = new Set(["queued", "initializing", "running", "recovering"]);

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "../../..");

export type RuntimeMode = "local" | "docker";

export type RunnerConfig = {
  mode: RuntimeMode;
  workerImage: string;
  leaseMs: number;
  ownerId: string;
};

function writeManifest(task: TaskRecord, settings: SettingsStore): WorkerManifest {
  const paths = taskPaths(task.dataDir);
  const model = settings.modelForManifest();
  const manifest: WorkerManifest = {
    taskId: task.id,
    dataDir: task.dataDir,
    historyDb: paths.historyDb,
    durableDb: paths.durableDb,
    evidenceDir: paths.evidenceDir,
    workspaceDir: paths.workspaceDir,
    auth: task.auth,
    goals: task.goals,
    budget: task.budget,
    mock: task.mock,
    model,
    mcpServers: settings.enabledMcpForManifest(),
    mcpPool: settings.allMcpForManifest(),
    mcpCatalog: settings.mcpCatalogForManifest(),
    // skillPacks intentionally empty — no full-body injection; router + load_skill.
    skillPacks: settings.enabledSkillsForManifest(),
    skillPool: settings.routedSkillsForManifest(),
    skillCatalog: settings.skillCatalogForManifest(),
  };
  mkdirSync(task.dataDir, { recursive: true });
  writeFileSync(paths.manifestPath, JSON.stringify(manifest, null, 2));

  const history = openHistory({
    dbPath: paths.historyDb,
    evidenceDir: paths.evidenceDir,
  });
  history.seedGoals(task.id, task.goals);
  history.close();

  return manifest;
}

export class WorkerRunner {
  private readonly children = new Map<string, ChildProcess>();

  constructor(
    private readonly store: ControlStore,
    private readonly cfg: RunnerConfig,
    private readonly settings: SettingsStore,
  ) {}

  async start(taskId: string): Promise<TaskRecord> {
    const task = this.store.get(taskId);
    if (!task) throw new Error(`task not found: ${taskId}`);

    if (ACTIVE.has(task.status) && this.isAlive(task)) {
      throw new Error("任务已在运行中");
    }

    if (TERMINAL.has(task.status) || !ACTIVE.has(task.status)) {
      this.prepareRestart(task);
    }

    const lease = this.store.acquireLease(taskId, this.cfg.ownerId, this.cfg.leaseMs);
    if (!lease.ok) throw new Error(`lease: ${lease.reason}`);

    writeManifest(lease.task, this.settings);

    if (this.cfg.mode === "docker") {
      return this.startDocker(lease.task);
    }
    return this.startLocal(lease.task);
  }

  /** 从终态重新开始：清掉完成标记，必要时重置已完成的检查点 */
  private prepareRestart(task: TaskRecord): void {
    const paths = taskPaths(task.dataDir);
    const ckptPath = `${paths.durableDb}.ckpt.sqlite`;
    if (existsSync(ckptPath)) {
      try {
        const db = new DatabaseSync(ckptPath);
        const row = db.prepare(`SELECT json FROM checkpoint WHERE id = 1`).get() as
          | { json: string }
          | undefined;
        if (row) {
          const state = JSON.parse(row.json) as { phase?: string };
          if (state.phase === "done" || state.phase === "report") {
            // Human restart — resume explore; never invent a Relay π here.
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
    }
    const statusPath = join(task.dataDir, "worker-status.json");
    if (existsSync(statusPath)) {
      try {
        unlinkSync(statusPath);
      } catch {
        /* ignore */
      }
    }
    task.status = "queued";
    task.finishedAt = null;
    task.error = null;
    task.workerPid = null;
    task.containerId = null;
    task.leaseOwner = null;
    task.leaseUntil = null;
    this.store.save(task);
  }

  private workerEntry(): string {
    const dist = join(repoRoot, "packages/worker/dist/main.js");
    const src = join(repoRoot, "packages/worker/src/main.ts");
    return existsSync(dist) ? dist : src;
  }

  private startLocal(task: TaskRecord): TaskRecord {
    const paths = taskPaths(task.dataDir);
    const entry = this.workerEntry();
    const args = entry.endsWith(".ts")
      ? ["--import", "tsx", entry, "--manifest", paths.manifestPath]
      : [entry, "--manifest", paths.manifestPath];

    const child = spawn(process.execPath, args, {
      cwd: repoRoot,
      env: {
        ...process.env,
        ...this.settings.workerEnv(),
        GY_TASK_ID: task.id,
        GY_FENCE: String(task.fence),
      },
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    });
    child.unref();

    const logPath = join(task.dataDir, "worker.log");
    const log = createWriteStream(logPath, { flags: "a" });
    child.stdout?.pipe(log);
    child.stderr?.pipe(log);

    child.on("exit", (code) => {
      this.children.delete(task.id);
      const latest = this.store.get(task.id);
      if (!latest) return;
      if (["completed", "failed", "budget_exhausted", "stopped"].includes(latest.status)) {
        return;
      }
      latest.status = "recovering";
      latest.workerPid = null;
      latest.error = `worker exited with code ${code}`;
      this.store.save(latest);
    });

    this.children.set(task.id, child);
    task.status = task.status === "queued" ? "initializing" : "running";
    task.startedAt = task.startedAt ?? new Date().toISOString();
    task.workerPid = child.pid ?? null;
    task.containerId = null;
    this.store.save(task);
    return task;
  }

  private startDocker(task: TaskRecord): TaskRecord {
    const absData = resolve(task.dataDir);
    const name = `gy-task-${task.id.slice(0, 8)}`;
    spawnSync("docker", ["rm", "-f", name], { encoding: "utf8" });

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
      "GY_MANIFEST=/task/manifest.json",
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
      throw new Error(`docker run failed: ${result.stderr || result.stdout}`);
    }
    const containerId = (result.stdout || "").trim() || name;

    task.status = task.status === "queued" ? "initializing" : "running";
    task.startedAt = task.startedAt ?? new Date().toISOString();
    task.containerId = containerId;
    task.workerPid = null;
    this.store.save(task);
    return task;
  }

  async stop(taskId: string): Promise<TaskRecord | null> {
    const task = this.store.get(taskId);
    if (!task) return null;

    if (TERMINAL.has(task.status)) {
      return task;
    }

    const local = this.children.get(taskId);
    if (local?.pid) {
      try {
        process.kill(-local.pid, "SIGTERM");
      } catch {
        try {
          process.kill(local.pid, "SIGTERM");
        } catch {
          /* ignore */
        }
      }
      this.children.delete(taskId);
    }

    if (task.containerId) {
      spawnSync("docker", ["rm", "-f", task.containerId], { encoding: "utf8" });
    }

    if (task.workerPid) {
      try {
        process.kill(task.workerPid, "SIGTERM");
      } catch {
        /* already gone */
      }
    }

    return this.store.setStatus(taskId, "stopped");
  }

  isAlive(task: TaskRecord): boolean {
    if (this.cfg.mode === "local") {
      if (!task.workerPid) return false;
      try {
        process.kill(task.workerPid, 0);
        return true;
      } catch {
        return false;
      }
    }
    if (!task.containerId) return false;
    const r = spawnSync(
      "docker",
      ["inspect", "-f", "{{.State.Running}}", task.containerId],
      { encoding: "utf8" },
    );
    return r.status === 0 && String(r.stdout).trim() === "true";
  }
}

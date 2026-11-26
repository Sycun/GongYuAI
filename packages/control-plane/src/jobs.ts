/**
 * 持久资料作业执行器（第九轮 P1）。
 *
 * 设计要点：
 * - 状态与证据归 History（每个任务自己的库），控制面只做执行与对账；
 * - 控制面重启后，上一代 bootId 的 running 作业标 unknown，**不假装成功**；
 * - 暂停时区分已停止 / 正在收尾 / 状态未知；
 * - 完成通知幂等（回执按 deliveryKey 只记一次），迟到结果保留来源；
 * - 作业不在 HTTP 请求里跑：submit 立即返回 jobId，执行在后台推进。
 */
import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import type { BackgroundJob, JobKind, SubmitJobInput } from "@gongyuai/contracts";
import {
  detectMaterialKind,
  isTerminalTaskStatus,
  parseToolOutput,
  type ParsedToolOutput,
  type SupportedTool,
} from "@gongyuai/contracts";
import {
  listEvidenceFiles,
  minimatch,
  openHistory,
  readEvidenceBytes,
  writeEvidenceFile,
  writeTaskReport,
  type HistoryStore,
} from "@gongyuai/history";
import type { ControlStore } from "./store.js";
import { taskPaths } from "./paths.js";
import { runReconcile } from "./reconcile.js";
import { simulateRoleWork } from "./roles.js";

export type JobRunnerOptions = {
  /** 每个输入之间的节奏（只用于可控验收；生产默认 0）。 */
  defaultPaceMs?: number;
  concurrency?: number;
};

type TaskRecordLike = { id: string; dataDir: string; engagementId: string; scopeVersion: number; status: string };

function sha256(bytes: Buffer | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function sleep(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class JobRunner {
  readonly bootId = `boot-${randomUUID()}`;
  private readonly store: ControlStore;
  private readonly opts: JobRunnerOptions;
  private readonly inFlight = new Set<string>();
  private timer: NodeJS.Timeout | null = null;
  private draining = false;

  constructor(store: ControlStore, opts: JobRunnerOptions = {}) {
    this.store = store;
    this.opts = opts;
  }

  /** 启动对账 + 开始消费队列。 */
  start(): void {
    const now = new Date().toISOString();
    for (const task of this.store.list() as TaskRecordLike[]) {
      if (!this.hasHistory(task)) continue;
      let needsReconcile = false;
      try {
        const ro = this.open(task, true);
        try {
          needsReconcile = ro.ops
            .listJobs(task.id)
            .some((job) => job.status === "running" && job.bootId !== this.bootId);
        } finally {
          ro.close();
        }
      } catch {
        // 旧版只读归档库可能不含 background_jobs 表：跳过，严禁读写建表破坏归档。
        continue;
      }
      if (!needsReconcile) continue;
      const history = this.open(task);
      try {
        const reconciled = history.ops.reconcileJobsAfterBoot(task.id, this.bootId, now);
        for (const job of reconciled) {
          console.error(`[gy] job ${job.id} left unknown after boot (was ${job.pauseState})`);
        }
      } finally {
        history.close();
      }
    }
    this.timer = setInterval(() => void this.tick(), 250);
    this.timer.unref?.();
    void this.tick();
  }

  async stop(): Promise<void> {
    this.draining = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    // 等进行中的作业收尾（最多 2s），不把“正在收尾”谎报为已停止。
    for (let i = 0; i < 20 && this.inFlight.size > 0; i += 1) await sleep(100);
  }

  /** 暂停任务：执行中的标 draining，未开始的标 stopped。 */
  pauseTask(taskId: string): BackgroundJob[] {
    const task = this.store.get(taskId);
    if (!task || !this.hasHistory(task)) return [];
    const history = this.open(task);
    try {
      return history.ops.pauseJobs(taskId, new Set(this.inFlight), new Date().toISOString());
    } finally {
      history.close();
    }
  }

  resumeTask(taskId: string): BackgroundJob[] {
    const task = this.store.get(taskId);
    if (!task || !this.hasHistory(task)) return [];
    const history = this.open(task);
    try {
      return history.ops.resumeJobs(taskId, new Date().toISOString());
    } finally {
      history.close();
    }
  }

  cancelTaskJobs(taskId: string, reason: string): number {
    const task = this.store.get(taskId);
    if (!task || !this.hasHistory(task)) return 0;
    const history = this.open(task);
    try {
      let count = 0;
      for (const job of history.ops.listJobs(taskId)) {
        if (!["queued", "paused", "draining", "running"].includes(job.status)) continue;
        history.ops.updateJob(taskId, job.id, { status: "canceled", error: reason, pauseState: "none" }, new Date().toISOString());
        count += 1;
      }
      return count;
    } finally {
      history.close();
    }
  }

  submit(taskId: string, input: SubmitJobInput): BackgroundJob {
    const task = this.store.get(taskId);
    if (!task) throw new Error(`task not found: ${taskId}`);
    if (!this.hasHistory(task)) throw new Error(`task has no history: ${taskId}`);
    const history = this.open(task);
    try {
      const job = history.ops.submitJob(
        { taskId, engagementId: task.engagementId, scopeVersion: task.scopeVersion },
        input,
        new Date().toISOString(),
      );
      void this.tick();
      return job;
    } finally {
      history.close();
    }
  }

  retry(taskId: string, jobId: string): BackgroundJob {
    const task = this.store.get(taskId);
    if (!task) throw new Error(`task not found: ${taskId}`);
    const history = this.open(task);
    try {
      const job = history.ops.getJob(taskId, jobId);
      if (!job) throw new Error(`job not found: ${jobId}`);
      if (!["unknown", "failed", "paused"].includes(job.status)) {
        throw new Error(`job ${jobId} 当前状态 ${job.status} 不可重试（只有 unknown/failed/paused 可重试）`);
      }
      const next = history.ops.updateJob(
        taskId,
        jobId,
        { status: "queued", pauseState: "none", error: null },
        new Date().toISOString(),
      );
      void this.tick();
      return next!;
    } finally {
      history.close();
    }
  }

  /** 消费所有任务队列；每个任务同时只跑一个作业。 */
  private async tick(): Promise<void> {
    if (this.draining) return;
    const tasks = this.store.list() as TaskRecordLike[];
    for (const task of tasks) {
      if (this.inFlight.size >= (this.opts.concurrency ?? 4)) break;
      if (task.status === "paused" || task.status === "pause_requested") continue;
      if (!this.hasHistory(task)) continue;
      if (this.inFlight.has(task.id)) continue;
      const next = this.nextQueued(task);
      if (!next) continue;
      this.inFlight.add(task.id);
      void this.run(task, next).finally(() => this.inFlight.delete(task.id));
    }
  }

  private nextQueued(task: TaskRecordLike): BackgroundJob | null {
    try {
      const history = this.open(task, true);
      try {
        return history.ops.listJobs(task.id).find((job) => job.status === "queued") ?? null;
      } finally {
        history.close();
      }
    } catch {
      return null;
    }
  }

  private async run(task: TaskRecordLike, job: BackgroundJob): Promise<void> {
    const now = () => new Date().toISOString();
    let history = this.open(task);
    const started = history.ops.startJob(task.id, job.id, this.bootId, now());
    history.close();
    if (!started) return;

    const artifacts: Array<{ path: string; sha256: string; bytes?: number }> = [];
    try {
      const paceMs = Number((job.options.paceMs as number | undefined) ?? this.opts.defaultPaceMs ?? 0);
      const total = job.inputs.length;
      for (let index = 0; index < total; index += 1) {
        await sleep(paceMs);
        const current = this.store.get(task.id);
        if (current?.status === "paused" || current?.status === "pause_requested") {
          history = this.open(task);
          try {
            history.ops.updateJob(
              task.id,
              job.id,
              { status: "paused", pauseState: "stopped", progress: { done: index, total, message: "paused" } },
              now(),
            );
          } finally {
            history.close();
          }
          return;
        }
        history = this.open(task);
        try {
          history.ops.updateJob(
            task.id,
            job.id,
            { progress: { done: index + 1, total, message: `${job.kind}:${index + 1}/${total}` } },
            now(),
          );
        } finally {
          history.close();
        }
      }

      const outcome = await this.execute(task, job);
      history = this.open(task);
      try {
        const finished = history.ops.finishJob(task.id, job.id, {
          status: "succeeded",
          artifacts: outcome.artifacts,
          result: outcome.result,
          scopeVersion: this.store.get(task.id)?.scopeVersion ?? task.scopeVersion,
          nowIso: now(),
        });
        if (finished) artifacts.push(...outcome.artifacts);
        // 完成回流：任务已到终态时，报告重渲染一次，把作业结论带进交付件。
        const latest = this.store.get(task.id);
        if (latest && isTerminalTaskStatus(latest.status)) {
          writeTaskReport(
            { taskId: latest.id, dataDir: latest.dataDir, auth: latest.auth },
            history,
            { status: latest.status, reason: latest.error ?? undefined, accounting: latest },
          );
        }
      } finally {
        history.close();
      }
    } catch (error) {
      history = this.open(task);
      try {
        history.ops.finishJob(task.id, job.id, {
          status: "failed",
          error: error instanceof Error ? error.message : String(error),
          scopeVersion: this.store.get(task.id)?.scopeVersion ?? task.scopeVersion,
          nowIso: now(),
        });
      } finally {
        history.close();
      }
    }
  }

  private async execute(
    task: TaskRecordLike,
    job: BackgroundJob,
  ): Promise<{ artifacts: Array<{ path: string; sha256: string; bytes?: number }>; result: Record<string, unknown> }> {
    const paths = taskPaths(task.dataDir);
    const options = job.options as Record<string, unknown>;
    if (job.kind === "material-check") {
      const outcome = runReconcile(task.id, task.dataDir, options.request ?? options);
      // 完成后回到原委托：按目标声明的材料图案逐条判定（与操作员入口同一条实现）。
      const history = openHistory({ dbPath: paths.historyDb, evidenceDir: paths.evidenceDir });
      const assertions: Array<{ goalId: string; ok: boolean; reason: string | null }> = [];
      try {
        const goalId = typeof options.goalId === "string" ? options.goalId : null;
        for (const goal of history.listGoals(task.id)) {
          if (goalId && goal.id !== goalId) continue;
          if (!goal.business && !goal.reconcileGate) continue;
          const evidencePaths = listEvidenceFiles(paths.evidenceDir).filter(
            (path) => goal.evidencePatterns.length === 0 || goal.evidencePatterns.some((pattern) => minimatch(path, pattern)),
          );
          const verdict = history.assertGoal(task.id, goal.id, evidencePaths);
          assertions.push({
            goalId: goal.id,
            ok: verdict.ok,
            reason: verdict.ok ? null : verdict.reason,
          });
        }
      } finally {
        history.close();
      }
      return {
        artifacts: [{ path: outcome.evidencePath, sha256: outcome.evidenceSha256 }],
        result: {
          counts: outcome.result.counts,
          missingMaterials: outcome.result.missingMaterials,
          revisionId: outcome.revision.id,
          evidencePath: outcome.evidencePath,
          evidenceSha256: outcome.evidenceSha256,
          assertions,
        },
      };
    }
    if (job.kind === "evidence-pack") {
      const entries = job.inputs.map((input) => ({
        path: input.path,
        sha256: sha256(readEvidenceBytes(paths.evidenceDir, input.path)),
      }));
      const body = JSON.stringify({ taskId: task.id, jobId: job.id, packedAt: new Date().toISOString(), entries }, null, 2);
      const rel = `jobs/${job.id}/pack.json`;
      writeEvidenceFile(paths.evidenceDir, rel, body);
      return {
        artifacts: [{ path: rel, sha256: sha256(body), bytes: Buffer.byteLength(body) }],
        result: { entries: entries.length, packPath: rel },
      };
    }
    if (job.kind === "parse-import") {
      // P14-B1: real machine-readable parsers (same code the worker uses).
      const summary = job.inputs.map((input) => {
        const content = readEvidenceBytes(paths.evidenceDir, input.path).toString("utf8");
        const kind = detectMaterialKind(input.path, content);
        const tool = detectToolOutput(content);
        const parsed: ParsedToolOutput = tool
          ? parseToolOutput(tool, content)
          : { assets: [], findings: [], skipped: true, reason: "no machine-readable parser" };
        return {
          path: input.path,
          kind,
          sha256: sha256(content),
          tool: tool ?? null,
          parser: tool ? `${tool}-parser@1` : "skip",
          assets: parsed.assets.length,
          findings: parsed.findings.length,
          skipped: parsed.skipped,
          ...(parsed.reason ? { reason: parsed.reason } : {}),
        };
      });
      const body = JSON.stringify({ taskId: task.id, parsedAt: new Date().toISOString(), summary }, null, 2);
      const rel = `jobs/${job.id}/parse.json`;
      writeEvidenceFile(paths.evidenceDir, rel, body);
      return {
        artifacts: [{ path: rel, sha256: sha256(body) }],
        result: {
          parsed: summary.length,
          parsers: summary.map((entry) => entry.parser),
          assets: summary.reduce((sum, entry) => sum + entry.assets, 0),
          findings: summary.reduce((sum, entry) => sum + entry.findings, 0),
        },
      };
    }
    // 角色作业：确定性模拟，不调用真实模型（真实表现单列待验证）。
    const declaredRole = String((options.role as string | undefined) ?? "");
    const role = (["planner", "reviewer", "assistant"].includes(declaredRole)
      ? declaredRole
      : job.kind === "role-plan"
        ? "planner"
        : "reviewer") as "planner" | "reviewer" | "assistant";
    const roleInput = (options.input as Record<string, unknown> | undefined) ?? {};
    const output = simulateRoleWork(role, job.kind === "role-plan" ? "plan" : "review", roleInput);
    const body = JSON.stringify({ taskId: task.id, jobId: job.id, role, output, authenticity: "simulated" }, null, 2);
    const rel = `jobs/${job.id}/role.json`;
    writeEvidenceFile(paths.evidenceDir, rel, body);
    return {
      artifacts: [{ path: rel, sha256: sha256(body) }],
      result: { role, output: output as unknown as Record<string, unknown>, authenticity: "simulated", billing: "none" },
    };
  }

  private hasHistory(task: { dataDir: string }): boolean {
    return existsSync(taskPaths(task.dataDir).historyDb);
  }

  private open(task: { dataDir: string }, readOnly = false): HistoryStore {
    const paths = taskPaths(task.dataDir);
    return openHistory({ dbPath: paths.historyDb, evidenceDir: paths.evidenceDir, readOnly });
  }
}

export type { JobKind };

/**
 * P14-B1 — detect which machine-readable parser fits an imported artifact.
 * Only shapes we actually parse are returned; everything else stays `null`
 * (the job reports parser=skip instead of inventing rows).
 */
function detectToolOutput(content: string): SupportedTool | null {
  const head = content.trimStart().slice(0, 400);
  if (head.startsWith("<nmaprun") || content.includes("<nmaprun")) return "nmap";
  if (head.startsWith("{")) {
    try {
      const parsed = JSON.parse(content) as Record<string, unknown>;
      if (Array.isArray(parsed.results) && typeof parsed.config === "object") return "ffuf";
    } catch {
      /* fall through to JSONL detection */
    }
  }
  const lines = content.split(/\r?\n/).filter((line) => line.trim().length > 0).slice(0, 5);
  const objects: Array<Record<string, unknown>> = [];
  for (const line of lines) {
    if (!line.trim().startsWith("{")) continue;
    try {
      objects.push(JSON.parse(line) as Record<string, unknown>);
    } catch {
      /* ignore malformed line */
    }
  }
  if (objects.some((obj) => typeof obj["template-id"] === "string")) return "nuclei";
  if (objects.some((obj) => typeof obj.status_code === "number" || typeof obj["status-code"] === "number")) return "httpx";
  return null;
}

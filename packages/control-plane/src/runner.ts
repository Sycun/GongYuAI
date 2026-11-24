import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import {
  createWriteStream,
  readFileSync,
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
import { CommandLedger, hasCommandLedger, openHistory, writeTaskReport, type CommandTicket } from "@gongyuai/history";
import { executorBound, outOfScopeFor, outOfScopeReason, policyReceipt, userReceipt, reviewCommand } from "./command-approval.js";
import type { ApprovalReceipt } from "@gongyuai/contracts";
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
    engagementId: task.engagementId,
    commandFence: task.fence,
    commandConfirmation: settings.get().chatApproval.confirmation,
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
  /** taskId → slot → containerId */
  private readonly dockerSlots = new Map<string, Map<number, string>>();
  /** taskId → high-water worker pool size for current run (scale-up only) */
  private readonly maxPoolSize = new Map<string, number>();
  /** taskId → last reconcile timestamp (throttle; in-memory only) */
  private readonly lastScaleCheck = new Map<string, number>();
  /** Set by boot shutdown: detached workers may outlive this control plane. */
  private disposed = false;
  private readonly imageForRun = new Map<string, string>();
  private readonly reviews = new Map<string, AbortController>();

  constructor(
    private readonly store: ControlStore,
    private readonly cfg: RunnerConfig,
    private readonly settings: SettingsStore,
  ) {}

  private invalidateCommands(task: TaskRecord) {
    if (!hasCommandLedger(task.dataDir)) return;
    const ledger = new CommandLedger(task.dataDir);
    try { ledger.deactivate(task.id, task.fence); } finally { ledger.close(); }
  }

  /** 台账回执 → 任务级审批记录的 decision。 */
  private static reviewDecisionOf(receipt: ApprovalReceipt): "block" | "unavailable" | "rejected" | "expired" {
    if (receipt.decision === "expired") return "expired";
    if (receipt.decision === "unavailable") return "unavailable";
    if (receipt.actor === "user" && receipt.decision === "block") return "rejected";
    // "ask" should never be settled (it moves the ticket to awaiting_user); if a
    // legacy path ever settles it, fail closed.
    return "block";
  }

  private waitingReview(ticket: CommandTicket, fence: number): NonNullable<TaskRecord["commandReview"]> {
    const probe = ticket.action.localProbe ?? ticket.action.summary;
    return { id: ticket.id, fence, tool: ticket.action.tool, summary: probe,
      at: new Date(ticket.at).toISOString(),
      reason: `任务请求执行本地检查「${probe}」，等待你确认。`, decision: "waiting", model: "", mode: "manual" };
  }

  /** 已允许的命令：把 worker 回写的执行结果同步进任务记录。不阻塞活性检查。 */
  private mirrorOutcome(task: TaskRecord, ledger: CommandLedger): boolean {
    const review = task.commandReview;
    if (!review?.id || review.fence !== task.fence) {
      // 后台重试（继续运行）后旧记录仍停在「不可用」：回填最近一次实际执行结果。
      if (review?.decision === "unavailable") {
        const latest = ledger.latestResolved(task.id);
        if (latest && latest.at >= Date.parse(review.at)) {
          review.decision = latest.outcome.ok ? "executed" : "failed";
          review.outcome = latest.outcome.snippet;
          review.reason = latest.outcome.ok ? "重试审批通过，命令已执行。" : latest.outcome.snippet;
          review.at = new Date(latest.outcome.at).toISOString();
          this.store.save(task);
        }
      }
      return false;
    }
    const ticket = ledger.get(review.id);
    if (!ticket || ticket.receipt?.decision !== "allow") return false;
    const outcome = ledger.outcome(review.id);
    if (outcome && (review.decision === "waiting" || review.decision === "executed")) {
      review.decision = outcome.ok ? "executed" : "failed";
      review.outcome = outcome.snippet;
      if (!outcome.ok) review.reason = outcome.snippet;
      // 更新调用方持有的快照：watchdog 随后会保存同一对象，避免旧值覆盖。
      this.store.save(task);
    }
    return false;
  }

  /** Process approvals separately from the worker. A slow reviewer must not stall other tasks' leases. */
  async reconcileCommands(task: TaskRecord): Promise<boolean> {
    if (!hasCommandLedger(task.dataDir)) return false;
    const ledger = new CommandLedger(task.dataDir);
    let held: CommandTicket | undefined;
    try {
      held = ledger.next(task.id, task.fence, "held");
      if (!held) {
        const pending = ledger.next(task.id, task.fence, "pending");
        if (!pending) {
          const awaiting = ledger.next(task.id, task.fence, "awaiting_user");
          if (!awaiting) return this.mirrorOutcome(task, ledger);
          // 控制面重启后恢复等待展示，保证刷新页面仍能处理待办。
          const record = this.store.get(task.id);
          if (record && record.fence === task.fence) {
            const current = record.commandReview;
            if (!current || current.id !== awaiting.id || current.decision !== "waiting") {
              record.commandReview = this.waitingReview(awaiting, task.fence);
              this.store.save(record);
            }
          }
          // worker 存活才维持「审批处理中」；否则交回 watchdog 重启流程。
          return this.isAlive(task);
        }
        // 1) 先判断「能否执行」：按任务授权裁决真实命令（并入官方靶场动态启动的容器坐标），越界直接拦截，不调模型、不等待。
        //    有 command 的提案用 effectiveAuth 判定（与 worker 同一个闸），没有命令的旧提案仍按探针白名单。
        const dynTargetsPath = join(task.dataDir, "tsecbench-targets.json");
        let extraTargets: string[] = [];
        if (existsSync(dynTargetsPath)) {
          try {
            const parsed = JSON.parse(readFileSync(dynTargetsPath, "utf8"));
            if (Array.isArray(parsed)) extraTargets = parsed.filter((x): x is string => typeof x === "string");
          } catch { /* ignore */ }
        }
        const effectiveAuth = extraTargets.length
          ? { ...task.auth, targets: [...new Set([...task.auth.targets, ...extraTargets])] }
          : task.auth;

        if (!executorBound(pending.action, effectiveAuth)) {
          const reason = (pending.action.tool === "shell" || pending.action.tool === "cli") && pending.action.command
            ? outOfScopeFor(effectiveAuth, pending.action.command)
            : outOfScopeReason;
          ledger.settle(pending, policyReceipt(this.settings, pending, reason));
          return true;
        }
        // 2) 逐次确认：转入待用户确认，任务继续运行，worker 长等待回执。
        if (this.settings.get().chatApproval.confirmation === "manual") {
          if (ledger.awaitUser(pending)) {
            const record = this.store.get(task.id);
            if (record && record.fence === task.fence) {
              record.commandReview = this.waitingReview(pending, task.fence);
              this.store.save(record);
            }
          }
          return true;
        }
        // 3) 授权内（坐标+能力已确认）命令程序自动放行，不调审批模型：
        //    去掉每步第二次模型往返与 reviewer 抖动/超时造成的停顿；
        //    破坏性/越界/主机网络仍由 worker 侧闸与 executorBound 拦截。
        if (executorBound(pending.action, task.auth)) {
          ledger.settle(pending, {
            id: pending.id, at: new Date().toISOString(), model: "",
            scope: this.settings.get().chatApproval.scope, decision: "allow", risk: "low",
            actor: "policy", reason: "授权坐标与能力已确认，程序自动放行（不调审批模型）。",
          });
          return true;
        }
        // 4) 边界外/无法确认：审批模型判定。
        const key = task.id + ":" + task.fence;
        if (!this.reviews.has(key)) {
          const controller = new AbortController();
          this.reviews.set(key, controller);
          void reviewCommand(this.settings, pending, AbortSignal.any([controller.signal, AbortSignal.timeout(30_000)]), effectiveAuth)
            .then(receipt => {
              if (this.disposed) return;
              const target = new CommandLedger(task.dataDir);
              try {
                if (!target.active(task.id, task.fence)) return;
                // Autonomous worker in `auto` mode whose command already passed deterministic
                // scope/non-destructive/non-host-network checks must not freeze 10min on `ask`.
                if (
                  (receipt.decision === "ask" || receipt.decision === "unavailable") &&
                  executorBound(pending.action, effectiveAuth)
                ) {
                  target.settle(pending, {
                    ...receipt,
                    decision: "allow",
                    reason:
                      receipt.decision === "ask"
                        ? "自动审批模式下目标与能力边界已由确定性规则核验通过，直接放行以保障连续攻坚。"
                        : "审批模型不可用，但命令在授权坐标内，放行以保障长程运行。",
                  });
                  return;
                }
                target.settle(pending, receipt);
              } finally { target.close(); }
            }).catch(() => { /* The worker deadline also fails closed. */ })
            .finally(() => this.reviews.delete(key));
        }
        return true;
      }
    } finally { ledger.close(); }
    const receipt = held.receipt!;
    const record = this.store.get(task.id);
    if (!record || record.fence !== task.fence) return true;
    record.commandReview = { id: receipt.id, fence: task.fence, at: receipt.at, tool: held.action.tool,
      summary: held.action.localProbe ?? held.action.summary,
      model: receipt.model, decision: WorkerRunner.reviewDecisionOf(receipt), reason: receipt.reason,
      ...(receipt.actor === "user" ? { mode: "manual" as const } : {}) };
    this.store.save(record);
    await this.pause(task.id);
    return true;
  }

  /** 用户允许后台任务的待确认命令：只结算这一次调用，worker 收到回执后执行。 */
  async approveCommand(taskId: string): Promise<TaskRecord> {
    const task = this.store.get(taskId);
    if (!task) throw new Error(`task not found: ${taskId}`);
    const review = task.commandReview;
    if (!review || review.decision !== "waiting" || review.fence !== task.fence) {
      throw new Error("没有等待确认的命令，或该命令已处理、已过期。");
    }
    if (!hasCommandLedger(task.dataDir)) throw new Error("命令审批台账不可用。");
    const ledger = new CommandLedger(task.dataDir);
    try {
      const ticket = ledger.get(review.id);
      if (!ticket || ticket.fence !== task.fence) throw new Error("待审命令已失效。");
      // settle 以 awaiting_user 状态为条件，重复点击只结算一次。
      if (!ledger.settle(ticket, userReceipt(this.settings, ticket, true))) {
        throw new Error("该命令已处理。");
      }
    } finally { ledger.close(); }
    review.decision = "executed";
    review.outcome = "已允许本次执行，等待执行回执。";
    this.store.save(task);
    return task;
  }

  /** 用户拒绝后台任务的待确认命令：结算拒绝并暂停任务。 */
  async rejectCommand(taskId: string): Promise<TaskRecord> {
    const task = this.store.get(taskId);
    if (!task) throw new Error(`task not found: ${taskId}`);
    const review = task.commandReview;
    if (!review || review.decision !== "waiting" || review.fence !== task.fence) {
      throw new Error("没有等待确认的命令，或该命令已处理、已过期。");
    }
    if (!hasCommandLedger(task.dataDir)) throw new Error("命令审批台账不可用。");
    const ledger = new CommandLedger(task.dataDir);
    try {
      const ticket = ledger.get(review.id);
      if (!ticket || ticket.fence !== task.fence) throw new Error("待审命令已失效。");
      if (!ledger.settle(ticket, userReceipt(this.settings, ticket, false))) {
        throw new Error("该命令已处理。");
      }
    } finally { ledger.close(); }
    review.decision = "rejected";
    review.reason = "你拒绝了本次执行，任务将暂停。";
    this.store.save(task);
    await this.pause(taskId);
    return this.store.get(taskId)!;
  }

  /** 后台任务的重试入口：恢复任务，worker 从检查点重提命令并重新送审。 */
  async retryCommand(taskId: string): Promise<TaskRecord> {
    const task = this.store.get(taskId);
    if (!task) throw new Error(`task not found: ${taskId}`);
    const review = task.commandReview;
    if (!review || review.decision !== "unavailable" || review.fence !== task.fence) {
      throw new Error("只有审批模型不可用的命令可以重试。");
    }
    return this.resume(taskId);
  }

  async start(taskId: string): Promise<TaskRecord> {
    const task = this.store.get(taskId);
    if (!task) throw new Error(`task not found: ${taskId}`);
    if (task.assignment) throw new Error("此任务由工作区任务处理器执行");
    if (this.isAlive(task)) {
      throw new Error("任务已在运行中");
    }
    if (isDrainingTaskStatus(task.status)) {
      throw new Error(`任务正在${task.status === "pause_requested" ? "暂停" : "停止"}，等待确认后再操作`);
    }

    if (isActiveTaskStatus(task.status) && await this.reconcileCommands(task)) throw new Error("命令审批处理中或任务已暂停");
    if (this.cfg.mode === "docker") {
      const inspected = spawnSync("docker", ["image", "inspect", "--format",
        '{{.Id}} {{index .Config.Labels "org.gongyuai.command-review"}}', this.cfg.workerImage],
        { encoding: "utf8", timeout: 5000 });
      const image = /^(sha256:[0-9a-f]{64}) 1$/.exec(inspected.stdout?.trim() ?? "");
      if (!image) {
        const reason = "工作镜像缺少命令审批版本，任务暂停，需使用新版 worker 镜像。";
        task.commandReview = { id: "image-" + task.fence, fence: task.fence, at: new Date().toISOString(),
          tool: "worker", summary: "", model: "", decision: "unavailable", reason };
        this.store.save(task);
        await this.pause(task.id);
        throw new Error(reason);
      }
      this.imageForRun.set(task.id, image[1]!);
    }
    if (!isActiveTaskStatus(task.status)) {
      this.prepareRestart(task);
    }

    const lease = this.store.acquireLease(taskId, this.cfg.ownerId, this.cfg.leaseMs);
    if (!lease.ok) throw new Error(`lease: ${lease.reason}`);

    // 重新启动后 fence 已递增：旧 fence 的待确认命令只绑定上一轮调用，标记过期。
    const stale = lease.task.commandReview;
    if (stale?.decision === "waiting" && stale.fence !== lease.task.fence) {
      stale.decision = "expired"; stale.reason = "任务已重新运行，该次待确认命令已过期。";
      this.store.save(lease.task);
    }

    const ledger = new CommandLedger(lease.task.dataDir);
    try { ledger.activate(taskId, lease.task.fence); } finally { ledger.close(); }
    const workerCount = taskWorkerCount(lease.task, countScalableAssets(lease.task));
    this.maxPoolSize.set(taskId, workerCount);
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
    const dist = join(repoRoot, "packages/worker/dist/reviewed-main.js");
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

    const assetCount = countScalableAssets(task);
    const computed = taskWorkerCount(task, assetCount);

    if (this.cfg.mode === "local") {
      const slots = this.children.get(taskId);
      // Without a live child map (e.g. control-plane restarted) slot identity is
      // unknown; skip rather than risk duplicating a surviving slot.
      if (!slots || slots.size === 0) return;
      const highestSlot = Math.max(...slots.keys()) + 1;
      const prevPool = Math.max(this.maxPoolSize.get(taskId) ?? 0, highestSlot);
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
          const history = openHistory({ dbPath: paths.historyDb, evidenceDir: paths.evidenceDir });
          try {
            if (history.allGoalsPass(task.id)) return;
          } finally {
            history.close();
          }
        }
      }

      this.maxPoolSize.set(taskId, targetPool);
      for (let slot = 0; slot < targetPool; slot++) {
        writeManifestForSlot(task, this.settings, slot, targetPool);
      }
      for (const slot of missingSlots) {
        const child = this.spawnLocalSlot(task, slot, targetPool);
        if (child.pid && !(task.workerPids ?? []).includes(child.pid)) {
          task.workerPids = [...(task.workerPids ?? []), child.pid];
        }
      }
      task.workerPid = task.workerPids?.[0] ?? task.workerPid;
      this.store.save(task);

      if (targetPool > prevPool) {
        const paths = taskPaths(task.dataDir);
        const history = openHistory({ dbPath: paths.historyDb, evidenceDir: paths.evidenceDir });
        try {
          history.recordExploreScaled(task.id, { from: prevPool, to: targetPool, assetCount });
        } finally {
          history.close();
        }
      }
      return;
    }

    if (!this.imageForRun.has(taskId)) return;
    const dSlots = this.dockerSlots.get(taskId);
    const current = dSlots ? Math.max(...dSlots.keys(), -1) + 1 : (task.containerIds?.length ?? 0);
    if (current === 0) return;
    const prevPool = Math.max(this.maxPoolSize.get(taskId) ?? 0, current);
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

    this.maxPoolSize.set(taskId, targetPool);
    for (let slot = 0; slot < targetPool; slot++) {
      writeManifestForSlot(task, this.settings, slot, targetPool);
    }
    let slotMap = this.dockerSlots.get(taskId);
    if (!slotMap) {
      slotMap = new Map();
      this.dockerSlots.set(taskId, slotMap);
    }
    for (const slot of missingSlots) {
      const containerId = this.spawnDockerSlot(task, slot, targetPool);
      slotMap.set(slot, containerId);
    }
    task.containerIds = Array.from(slotMap.entries())
      .sort(([a], [b]) => a - b)
      .map(([, id]) => id);
    task.containerId = task.containerIds[0] ?? task.containerId;
    this.store.save(task);

    if (targetPool > prevPool) {
      const paths = taskPaths(task.dataDir);
      const history = openHistory({ dbPath: paths.historyDb, evidenceDir: paths.evidenceDir });
      try {
        history.recordExploreScaled(task.id, { from: prevPool, to: targetPool, assetCount });
      } finally {
        history.close();
      }
    }
  }

  private spawnDockerSlot(task: TaskRecord, slot: number, workerCount: number): string {
    const image = this.imageForRun.get(task.id);
    if (!image) throw new Error("工作镜像审批版本尚未确认");
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
      image,
    ];

    const result = spawnSync("docker", args, { encoding: "utf8" });
    if (result.status !== 0) {
      throw new Error(`docker run failed (slot ${slot}): ${result.stderr || result.stdout}`);
    }
    return (result.stdout || "").trim() || name;
  }

  private startDocker(task: TaskRecord, workerCount: number): TaskRecord {
    const containerIds: string[] = [];
    const slotMap = new Map<number, string>();
    for (let slot = 0; slot < workerCount; slot++) {
      try {
        const cid = this.spawnDockerSlot(task, slot, workerCount);
        containerIds.push(cid);
        slotMap.set(slot, cid);
      } catch (err) {
        // Best-effort cleanup of already-started siblings.
        for (const id of containerIds) {
          spawnSync("docker", ["rm", "-f", id], { encoding: "utf8" });
        }
        throw err;
      }
    }
    this.dockerSlots.set(task.id, slotMap);

    task.status = task.status === "queued" ? "initializing" : "running";
    task.startedAt = task.startedAt ?? new Date().toISOString();
    task.containerIds = containerIds;
    task.containerId = containerIds[0] ?? null;
    task.workerPid = null;
    task.workerPids = [];
    this.store.save(task);
    return task;
  }

  private stopWorkers(task: TaskRecord, opts?: { preserveDetachedSessions?: boolean }): void {
    const taskId = task.id;
    const preserveSessions = Boolean(opts?.preserveDetachedSessions);
    const locals = this.children.get(taskId);
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
    this.children.delete(taskId);
    this.dockerSlots.delete(taskId);
    this.maxPoolSize.delete(taskId);
    this.imageForRun.delete(taskId);
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

    this.invalidateCommands(task);
    // 等待确认的命令随操作暂停取消：worker 已被终止，票据不再可处理。
    if (task.commandReview?.decision === "waiting" && task.commandReview.fence === task.fence) {
      task.commandReview = { ...task.commandReview, decision: "cancelled", reason: "任务已暂停，该次待确认命令已取消。" };
    }
    task.status = "pause_requested";
    task.pauseRequestedAt = new Date().toISOString();
    task.error = null;
    this.store.save(task);

    if (this.isAlive(task)) this.stopWorkers(task, { preserveDetachedSessions: true });
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
    if (latest.fence !== task.fence || latest.status !== "pause_requested") return latest;
    latest.status = "paused";
    latest.pausedAt = new Date().toISOString();
    latest.lastHeartbeatAt = latest.pausedAt;
    latest.workerPid = null;
    latest.workerPids = [];
    latest.containerId = null;
    latest.containerIds = [];
    latest.leaseOwner = null;
    latest.leaseUntil = null;
    latest.error = latest.commandReview?.fence === latest.fence ? latest.commandReview.reason : null;
    this.store.save(latest);
    this.children.delete(taskId);
    return latest;
  }

  /** Stage 2 — resume; start() rebuilds manifests from the latest scope revision. */
  /**
   * 继续运行。除了“已暂停”，还允许**补交材料后重新判定**：材料不齐导致的
   * `incomplete` / `stopped` 不是硬失败，把任务永久锁死就没法走补交流程。
   * `completed` 无需重开；`failed` / `budget_exhausted` 属于硬失败，继续要求
   * 新的预算或另建任务，不在这里放开。
   */
  async resume(taskId: string): Promise<TaskRecord> {
    const task = this.store.get(taskId);
    if (!task) throw new Error(`task not found: ${taskId}`);
    if (isTerminalTaskStatus(task.status)) {
      const reopenable = task.status === "incomplete" || task.status === "stopped";
      if (!reopenable) {
        throw new Error(`终态任务不能继续（${task.status}）：完成的任务无需重开，失败或预算耗尽需另建任务`);
      }
      const paths = taskPaths(task.dataDir);
      let allPassed = false;
      if (existsSync(paths.historyDb)) {
        const history = openHistory({ dbPath: paths.historyDb, evidenceDir: paths.evidenceDir });
        try {
          const goals = history.listGoals(task.id);
          allPassed = goals.length > 0 && goals.every((goal) => goal.passes);
          if (!allPassed) {
            history.recordEvent(task.id, "task_resumed", {
              from: task.status,
              reopened: true,
              reason: "补交材料后重新判定（未全部通过）",
            });
          }
        } finally {
          history.close();
        }
      }
      if (allPassed) throw new Error("全部目标已通过，无需重新判定");
      return this.start(taskId);
    }
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

    this.invalidateCommands(task);
    if (task.commandReview?.decision === "waiting" && task.commandReview.fence === task.fence) {
      task.commandReview = { ...task.commandReview, decision: "cancelled", reason: "任务已停止，该次待确认命令已取消。" };
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
    for (const review of this.reviews.values()) review.abort();
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

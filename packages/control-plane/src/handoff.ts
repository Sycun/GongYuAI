/**
 * 跨班交接与「今日工作」（第九轮 P1）。
 *
 * 只做投影：范围、已完成、仍受阻、最新撤回、待答问题、后台作业与下一责任人
 * 全部从 History + 控制面记录派生；模型摘要不写这里，Watchdog 也只管存活。
 */
import type { Consultation, HandoffPacket, TaskRecord, TodayWork } from "@gongyuai/contracts";
import { freshnessOf, type HandoffBlocked } from "@gongyuai/contracts";
import type { HistoryStore } from "@gongyuai/history";

export function sweepTaskConsults(history: HistoryStore, taskId: string, nowMs: number): Consultation[] {
  return history.ops.sweepConsults(taskId, nowMs);
}

export function assembleHandoff(input: {
  task: TaskRecord;
  history: HistoryStore;
  generatedAt: string;
  nextOwner?: string | null;
}): HandoffPacket {
  const { task, history, generatedAt } = input;
  const goals = history.listGoals(task.id);
  const consults = history.ops.listConsults(task.id);
  const jobs = history.ops.listJobs(task.id);
  const findings = history.listFindings(task.id);
  const reviews = history.listReviews(task.id).filter((review) => review.decision === "retracted");
  const events = history.listEvents(task.id, 1000);

  const completed = goals
    .filter((goal) => goal.passes)
    .map((goal) => ({ id: goal.id, title: goal.title, assertedAt: goal.assertedAt ?? null }));

  const blocked: HandoffBlocked[] = [];
  for (const consult of consults) {
    if (consult.status !== "open") continue;
    blocked.push({
      kind: "consult",
      id: consult.id,
      detail: `${consult.question}${consult.blocking ? "（24h 内需要答复）" : "（已转非阻塞，仍需明确答复）"}`,
      needsAnswer: true,
    });
  }
  for (const job of jobs) {
    if (job.status === "failed" || job.status === "unknown") {
      blocked.push({
        kind: "job",
        id: job.id,
        detail: `作业 ${job.label} 状态 ${job.status}${job.error ? `：${job.error}` : ""}（可重试）`,
        needsAnswer: false,
      });
    }
  }
  for (const goal of goals) {
    if (goal.passes) continue;
    blocked.push({
      kind: "goal",
      id: goal.id,
      detail: `目标「${goal.title}」未通过：材料/判据尚未满足`,
      needsAnswer: false,
    });
  }
  for (const job of jobs) {
    if (job.lateResult) {
      blocked.push({
        kind: "scope",
        id: job.id,
        detail: `作业 ${job.label} 在范围版本 v${job.scopeVersion} 提交，完成时范围已前移；结果保留但不自动计入当前结论`,
        needsAnswer: false,
      });
    }
  }

  const latestRetractions: HandoffPacket["latestRetractions"] = [
    ...reviews.map((review) => ({
      kind: "fact" as const,
      id: review.factId,
      reason: review.reason,
      at: review.createdAt,
    })),
    ...findings
      .filter((finding) => finding.status === "retracted")
      .map((finding) => ({
        kind: "finding" as const,
        id: finding.id,
        reason: "finding 已撤回（见 finding_actions）",
        at: finding.verifiedAt ?? finding.createdAt,
      })),
    ...events
      .filter((event) => event.kind === "evidence_removed")
      .map((event) => ({
        kind: "evidence" as const,
        id: String((event.payload as { path?: unknown }).path ?? event.id),
        reason: "材料撤回",
        at: event.createdAt,
      })),
  ]
    .sort((a, b) => b.at.localeCompare(a.at))
    .slice(0, 10);

  const openQuestions = consults
    .filter((consult) => consult.status === "open")
    .map((consult) => ({
      id: consult.id,
      question: consult.question,
      blocking: consult.blocking,
      dueAt: consult.dueAt,
      releasedAt: consult.releasedAt,
      scopeVersion: consult.scopeVersion,
    }));

  const scopeUpdated = events
    .filter((event) => event.kind === "scope_updated")
    .map((event) => event.createdAt)
    .sort()
    .at(-1) ?? null;

  const notes: string[] = [];
  const draining = jobs.filter((job) => job.status === "draining").length;
  const stopped = jobs.filter((job) => job.status === "paused" && job.pauseState === "stopped").length;
  const unknown = jobs.filter((job) => job.status === "unknown").length;
  if (jobs.length > 0) {
    notes.push(`后台作业：执行中 ${jobs.filter((job) => job.status === "running").length}，待跑 ${jobs.filter((job) => job.status === "queued").length}，收尾 ${draining}，已停止 ${stopped}，状态未知 ${unknown}`);
  }
  if (openQuestions.length > 0) {
    notes.push(`未答问题 ${openQuestions.length} 条；其中阻塞 ${openQuestions.filter((question) => question.blocking).length} 条`);
  }
  notes.push("本交接包是只读投影；恢复执行请走 /resume，模型摘要与 Watchdog 不改写事实或权限。");

  return {
    taskId: task.id,
    engagementId: task.engagementId,
    tenantId: task.tenantId,
    generatedAt,
    scopeVersion: task.scopeVersion,
    scope: {
      targets: [...task.auth.targets],
      outOfScope: [...task.auth.outOfScope],
      capability: task.auth.capability,
      version: task.scopeVersion,
      updatedAt: scopeUpdated,
    },
    status: task.status,
    completed,
    blocked,
    latestRetractions,
    openQuestions,
    jobs: jobs.map((job) => ({
      id: job.id,
      kind: job.kind,
      status: job.status,
      label: job.label,
      scopeVersion: job.scopeVersion,
      lateResult: job.lateResult,
    })),
    nextOwner: input.nextOwner ?? null,
    notes,
  };
}

export function todayWork(input: {
  tasks: readonly TaskRecord[];
  open: (task: TaskRecord) => HistoryStore;
  generatedAt: string;
  nowMs: number;
}): TodayWork {
  const rows: TodayWork["tasks"] = [];
  let engagement: string | null = null;
  for (const task of input.tasks) {
    let history: HistoryStore;
    try {
      history = input.open(task);
    } catch {
      continue;
    }
    try {
      const consults = history.ops.listConsults(task.id);
      const jobs = history.ops.listJobs(task.id);
      const goals = history.listGoals(task.id);
      const facts = history.listFacts(task.id);
      const stale = facts.filter((fact) => freshnessOf(fact, input.nowMs).state === "needs-review").length;
      const openQuestions = consults.filter((consult) => consult.status === "open").length;
      const runningJobs = jobs.filter((job) => ["running", "draining", "queued"].includes(job.status)).length;
      const lateJobs = jobs.filter((job) => job.lateResult).length;
      const blockedGoals = goals.filter((goal) => !goal.passes).length;
      let nextAction = "无待办";
      if (openQuestions > 0) nextAction = "回答人工求助";
      else if (jobs.some((job) => job.status === "unknown" || job.status === "failed")) nextAction = "重试或取消异常作业";
      else if (blockedGoals > 0) nextAction = "补齐材料并触发判定";
      else if (stale > 0) nextAction = "复核过期事实";
      rows.push({
        taskId: task.id,
        name: task.name,
        status: task.status,
        scopeVersion: task.scopeVersion,
        openQuestions,
        runningJobs,
        lateJobs,
        blockedGoals,
        staleFacts: stale,
        nextAction,
      });
      engagement = engagement ?? task.engagementId;
    } finally {
      history.close();
    }
  }
  return {
    generatedAt: input.generatedAt,
    engagementId: engagement,
    tenantId: input.tasks[0]?.tenantId ?? "default",
    tasks: rows,
  };
}

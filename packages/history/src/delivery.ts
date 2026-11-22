import type { GoalState, TaskRecord } from "@gongyuai/contracts";
import type { FactReview, GoalProof } from "./index.js";

export function describeGoalEvidence(goal: GoalState, proofs: GoalProof[], reviews: FactReview[]): string {
  const versions = proofs.filter((proof) => proof.goalId === goal.id);
  let label = "未验证";
  if (goal.passes) {
    const contentChecked = goal.evidenceChecks?.length || versions.some((v) => /(^|\/)ALL_COMPLETE\.json$/i.test(v.path));
    label = !versions.length ? "历史通过，原版证据未留存"
      : contentChecked ? "已通过内容判据" : "已留存材料（仅文件判据）";
  }
  const current = new Map<string, string>();
  for (const review of reviews) {
    if (review.goalId === goal.id) current.set(review.factId, review.decision);
  }
  const retracted = [...current.values()].filter((decision) => decision === "retracted").length;
  return retracted ? `${label} · ${retracted} 条事实已撤回` : label;
}

type Accounting = Pick<TaskRecord, "budget" | "usage" | "startedAt" | "finishedAt">;

export function formatAccounting(task: Accounting): string[] {
  function line(name: string, used: number | undefined, limit: number | undefined) {
    const available = typeof used === "number" && Number.isFinite(used);
    const cap = limit === undefined ? "未知" : limit === 0 ? "不限" : limit;
    const excess = available && limit && used > limit ? `，超额 ${used - limit}` : "";
    return `- ${name}　用量 ${available ? used : "未知"}，上限 ${cap}${excess}`;
  }
  const wall = task.finishedAt && task.startedAt ? Date.parse(task.finishedAt) - Date.parse(task.startedAt) : undefined;
  return [
    "## 平台用量", "",
    line("累计 Token", task.usage?.tokens, task.budget?.maxTokens),
    line("累计工具调用", task.usage?.toolCalls, task.budget?.maxToolCalls),
    line("累计安装", task.usage?.installs, task.budget?.maxInstalls),
    line("本轮墙钟（毫秒）", wall, task.budget?.maxWallMs),
  ];
}

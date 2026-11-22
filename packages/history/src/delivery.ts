import type { Finding, GoalState, TaskRecord } from "@gongyuai/contracts";
import type { DeliveryCorrection, FactReview, GoalFindingSupport, GoalProof } from "./index.js";

export type GoalEvidenceSupport = {
  goalFindings: GoalFindingSupport[];
  findings: Finding[];
};

/**
 * Evidence label for one goal. The label is derived **only** from declared
 * criteria (evidenceChecks / boardGate / findings gate) and sealed first-pass
 * records — never from a filename. A business attachment named
 * `ALL_COMPLETE.json` under an ordinary engagement is therefore a normal
 * material, while the TSecBench baseline declares `boardGate`.
 */
export function describeGoalEvidence(
  goal: GoalState,
  proofs: GoalProof[],
  reviews: FactReview[],
  support?: GoalEvidenceSupport,
): string {
  const versions = proofs.filter((proof) => proof.goalId === goal.id);
  const supports = support?.goalFindings.filter((entry) => entry.goalId === goal.id) ?? [];
  const findingsById = new Map((support?.findings ?? []).map((finding) => [finding.id, finding]));
  const retractedSupport = supports.filter(
    (entry) => (findingsById.get(entry.findingId)?.status ?? entry.statusAtAssert) === "retracted",
  );
  const liveSupport = supports.filter(
    (entry) => {
      const status = findingsById.get(entry.findingId)?.status ?? entry.statusAtAssert;
      return status === "verified" || status === "retested" || status === "accepted";
    },
  );
  const contentCriteria = Boolean(goal.evidenceChecks?.length) || goal.boardGate === "tsecbench";

  let label = "未验证";
  if (goal.passes) {
    if (versions.length) {
      label = contentCriteria ? "已通过内容判据" : "已留存材料（仅文件判据）";
    } else if (supports.length) {
      label = "已通过发现判据（首次通过依据已封存）";
    } else {
      label = "历史通过，原依据归属未知";
    }
    if (retractedSupport.length) {
      const details = retractedSupport.map((entry) => entry.findingId.slice(0, 8)).join("、");
      label += liveSupport.length
        ? ` · 部分依据已撤回（${details}），其余依据仍成立`
        : ` · 唯一依据已撤回（${details}），当前结论需重审`;
    }
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

/** Stage 5 correction rendering (numbered, immutable, notice state visible). */
export function formatCorrections(corrections: DeliveryCorrection[]): string[] {
  if (!corrections.length) return [];
  const noticeLabels: Record<DeliveryCorrection["noticeStatus"], string> = {
    pending: "待通知",
    notified: "已通知",
    confirmed: "客户已确认收悉",
  };
  const lines = ["## 交付更正", ""];
  for (const correction of corrections) {
    lines.push(
      `- 更正 #${correction.number}（${correction.createdAt}）　通知状态：${noticeLabels[correction.noticeStatus]}`,
      `  原因　${correction.reason}`,
      `  影响目标　${correction.goals.join("、") || "无"}`,
      `  影响发现　${correction.findings.join("、") || "无"}`,
    );
    for (const report of correction.report) {
      lines.push(`  受影响报告版本　${report.path} · SHA-256 ${report.sha256}`);
    }
    if (correction.evidencePath) {
      lines.push(`  通知凭据　${correction.evidencePath} · SHA-256 ${correction.sha256 ?? "未知"}`);
    }
  }
  lines.push("");
  return lines;
}

import { existsSync } from "node:fs";
import { coverageLabels, type TaskRecord } from "@gongyuai/contracts";
import {
  describeGoalEvidence,
  formatAccounting,
  formatCorrections,
  listEvidenceFiles,
  openHistory,
} from "@gongyuai/history";
import { taskPaths } from "./paths.js";
import { refreshTaskUsage } from "./usage.js";

function singleLine(value: string): string {
  return value.replace(/[\r\n\t]+/g, " ");
}

/** A current reading of the surviving records. Never repairs or publishes a historical report. */
export function deliverySummary(task: TaskRecord, hasReport: boolean): string {
  const paths = taskPaths(task.dataDir);
  refreshTaskUsage(task);
  const lines = [
    "# 交付核对", "",
    `任务　${task.id}`, `控制面记录　${task.status}`,
    `授权版本　v${task.scopeVersion}（最近更新 ${task.updatedAt}）`,
    `授权范围　${task.auth.targets.map(singleLine).join("、")}`,
    `排除范围　${task.auth.outOfScope?.map(singleLine).join("、") || "未列出"}`,
    `归档报告　${hasReport ? "已留存" : "未留存"}`,
  ];
  if (task.error) lines.push(`结束原因　${singleLine(task.error)}`);
  lines.push("", "## 目标与凭据", "");
  const expected = new Map(task.goals.map((goal) => [goal.id, goal]));
  try {
    if (!existsSync(paths.historyDb)) throw new Error("缺少 History 数据库");
    const history = openHistory({ dbPath: paths.historyDb, evidenceDir: paths.evidenceDir, readOnly: true });
    try {
      history.withReportTransaction(() => {
        const goals = history.listGoals(task.id);
        const coverage = new Map(history.listCoverage(task.id).map((entry) => [entry.goalId, entry]));
        const proofs = history.listGoalProofs(task.id);
        const reviews = history.listReviews(task.id);
        const goalFindings = history.listGoalFindings(task.id);
        const findings = history.listFindings(task.id);
        const scorecard = history.scorecard(task.id);
        for (const goal of goals) {
          const cached = expected.get(goal.id);
          const conflict = !cached ? " · 控制面未列出此目标"
            : cached.passes !== goal.passes ? " · 与控制面记录不一致" : "";
          lines.push(`- ${singleLine(goal.title)}（${singleLine(goal.id)}）　${
            describeGoalEvidence(goal, proofs, reviews, { goalFindings, findings })
          }${conflict}`);
          const supports = goalFindings.filter((entry) => entry.goalId === goal.id);
          if (supports.length) {
            const live = supports.filter((entry) => {
              const status = findings.find((f) => f.id === entry.findingId)?.status ?? entry.statusAtAssert;
              return status === "verified" || status === "retested" || status === "accepted";
            });
            const detail = supports
              .map((entry) => {
                const status = findings.find((f) => f.id === entry.findingId)?.status ?? entry.statusAtAssert;
                return `${entry.findingId}（首次通过时 ${entry.statusAtAssert}，当前 ${status}）`;
              })
              .join("、");
            lines.push(`  发现依据　${detail}；仍有效 ${live.length}/${supports.length}`);
          } else if (goal.findingsGate) {
            lines.push("  发现依据　原依据归属未知（旧档未记录发现归属）");
          }
          const review = coverage.get(goal.id);
          lines.push(review
            ? `  覆盖　${coverageLabels[review.status]}（${singleLine(review.reviewer)}，${review.createdAt}）　${singleLine(review.reason)}`
            : "  覆盖　未知");
          if (review?.sha256) lines.push(`  证据　${singleLine(review.evidencePath ?? "")} · SHA-256 ${review.sha256}`);
          expected.delete(goal.id);
        }
        for (const id of expected.keys()) lines.push(`- ${singleLine(id)}　缺少 History 目标记录`);
        if (task.status === "completed" && (expected.size || !goals.length || goals.some((g) => !g.passes))) {
          lines.push("- 终态冲突：控制面记为完成，History 无法支持全部目标已验收。");
        }
        lines.push(
          "", "## 记分卡", "",
          `- 统计时点　${scorecard.capturedAt}（实时读数；不可变凭据见快照 SHA-256）`,
          `- 分母　本次约定目标总数 ${scorecard.denominator}${scorecard.applicable ? "" : "（不适用：无目标）"}`,
          `- 曾通过目标数 / 本次约定目标总数　${scorecard.historicallyPassed} / ${scorecard.denominator}` +
            (scorecard.applicable ? "" : "（不适用：无目标）"),
          `- 当前证据足以支持的目标数　${scorecard.currentlySupported} / ${scorecard.denominator}`,
          `- 原依据归属未知　${scorecard.unknownAttribution} / ${scorecard.denominator}；已撤回依据引用 ${scorecard.retractedReferences} 条`,
          `- 人工覆盖（五类互斥，合计 = 分母）　已测 ${scorecard.coverage.tested}、部分覆盖 ${scorecard.coverage.partial}、` +
            `受阻 ${scorecard.coverage.blocked}、未测 ${scorecard.coverage.untested}、未登记 ${scorecard.coverage.unregistered}`,
          `- 发现　已验证 ${scorecard.findings.verified}、线索 ${scorecard.findings.tentative}、已撤回 ${scorecard.findings.retracted}`,
          `- 快照 SHA-256　${scorecard.snapshotSha256}`,
          "- 说明：当前证据支持与人工覆盖是两个维度；覆盖充分不代表有发现，零发现也不证明覆盖。",
        );
        const retests = history.listRetestRequests(task.id);
        if (retests.length) {
          lines.push("", "## 客户复测申请", "");
          for (const request of retests) {
            lines.push(
              `- ${request.status === "fulfilled" ? "已完成" : "待处理"}（${singleLine(request.requester)}，${request.createdAt}）` +
                `　${singleLine(request.reason)}　涉及 ${request.findingIds.join("、")}` +
                (request.fulfilledResult ? `　复测结果 ${request.fulfilledResult}` : ""),
            );
          }
        }
        const peers = history.listPeerReviews(task.id);
        if (peers.length) {
          lines.push("", "## 同一委托内跨任务署名复核", "");
          for (const review of peers) {
            lines.push(
              `- ${singleLine(review.reviewer)}（${singleLine(review.role)}）复核 ${singleLine(review.sourceTaskId)}` +
                ` · ${review.decision} · ${review.createdAt}　${singleLine(review.basis)}`,
            );
          }
        }
        lines.push("", ...formatCorrections(history.listDeliveryCorrections(task.id)).slice(0, -1));
      });
    } finally {
      history.close();
    }
  } catch {
    lines.push("- History 缺失或不可读，无法核对目标。");
  }
  lines.push("", ...formatAccounting(task), "", "## 现场留存文件", "");
  try {
    const files = listEvidenceFiles(paths.evidenceDir).sort();
    lines.push(`evidence/ 中有 ${files.length} 个文件。此清单仅用于交接，文件数量不代表测试覆盖率。`);
    for (const file of files.slice(0, 20)) lines.push(`- ${singleLine(file)}`);
    if (files.length > 20) lines.push(`其余 ${files.length - 20} 个文件可在证据页查看。`);
  } catch {
    lines.push("证据目录不可读，文件数量未知。");
  }
  return lines.join("\n") + "\n";
}

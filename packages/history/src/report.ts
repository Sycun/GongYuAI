import { createHash, randomUUID } from "node:crypto";
import { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { coverageLabels, type TaskStatus, type TaskRecord, type WorkerManifest, type Fact } from "@gongyuai/contracts";
import type { HistoryStore, FactReview } from "./index.js";
import { describeGoalEvidence, formatAccounting } from "./delivery.js";
import { integrationSuccessRate, totalIntegrationCalls } from "@gongyuai/contracts";

export type TerminalReportStatus = Extract<TaskStatus, "completed" | "budget_exhausted" | "incomplete" | "failed" | "stopped">;

/**
 * Stage 5: a delivered report is never rewritten in place without a copy.
 * Before publishing a new report.md, archive the previous bytes under
 * reports/report-<sha12>.md so a later correction can point at the exact
 * version that was delivered.
 */
function preservePrevious(dir: string, name: string): void {
  if (name !== "report.md") return;
  const current = join(dir, name);
  if (!existsSync(current)) return;
  const bytes = readFileSync(current);
  const digest = createHash("sha256").update(bytes).digest("hex");
  const archiveDir = join(dir, "reports");
  mkdirSync(archiveDir, { recursive: true, mode: 0o700 });
  const dest = join(archiveDir, `report-${digest.slice(0, 12)}.md`);
  if (!existsSync(dest)) copyFileSync(current, dest);
}

function publish(dir: string, name: string, content: string | Buffer): void {
  preservePrevious(dir, name);
  const temp = join(dir, `.report-${randomUUID()}.tmp`);
  try {
    writeFileSync(temp, content, { flag: "wx", mode: 0o600 });
    renameSync(temp, join(dir, name));
  } finally {
    rmSync(temp, { force: true });
  }
}

function label(raw: string) {
  return raw.replace(/\s+/g, " ").replace(/[\\`*_[\]<>#!|]/g, "\\$&");
}

export function writeTaskReport(
  task: Pick<WorkerManifest, "taskId" | "dataDir" | "auth">,
  history: HistoryStore,
  opts: { status: TerminalReportStatus; reason?: string; includeRelay?: boolean; accounting?: Pick<TaskRecord, "budget" | "usage" | "startedAt" | "finishedAt"> },
): string {
  return history.withReportTransaction(() => {
    const id = task.taskId;
    const facts = history.listFacts(id);
    const byId = new Map(facts.map((f) => [f.id, f]));
    const premises = new Map(history.listIntents(id).map((intent) => [intent.id, intent.sourceFactIds]));
    const dependents = new Map<string, Fact[]>();
    for (const f of facts) {
      for (const source of (f.intentId && premises.get(f.intentId)) || []) {
        const children = dependents.get(source) ?? [];
        children.push(f);
        dependents.set(source, children);
      }
    }
    const proofs = history.listGoalProofs(id);
    const reviews = history.listReviews(id);
    const goalFindings = history.listGoalFindings(id);
    const corrections = history.listDeliveryCorrections(id);
    const coverage = history.listCoverage(id);
    const goals = history.listGoals(id);
    const cited = new Set<string>();
    const exported = new Set<string>();
    const archive = join(task.dataDir, "report-evidence");

    function link(path: string, digest: string) {
      if (!exported.has(digest)) {
        const bytes = history.readProofVersion(id, digest);
        if (!bytes || createHash("sha256").update(bytes).digest("hex") !== digest) {
          throw new Error(`cannot verify archived evidence ${digest}`);
        }
        mkdirSync(archive, { recursive: true, mode: 0o700 });
        if (!lstatSync(archive).isDirectory()) throw new Error("invalid report evidence directory");
        publish(archive, digest, bytes);
        exported.add(digest);
      }
      return `[${label(path)}](report-evidence/${digest}) · SHA-256 ` + digest;
    }

    const lines = ["# GongYuAI Report", "", `Task: ${id}`, `Status: ${opts.status}`];
    if (opts.reason) lines.push(`Reason: ${label(opts.reason)}`);
    lines.push(`Targets: ${task.auth.targets.map(label).join(", ")}`, `Authorization: ${label(task.auth.authorizationNote)}`,
      `排除范围　${task.auth.outOfScope?.map(label).join("、") || "未列出"}`);
    if (opts.accounting) lines.push("", ...formatAccounting(opts.accounting));

    const usage = history.integrationUsage(id);
    lines.push("", "## Skill 与 MCP 调用", "");
    if (usage.since === null) {
      lines.push("此任务没有逐次调用统计。");
    } else {
      lines.push(`采集起点 ${usage.since}。成功率按已知结果计算，未返回的调用列为待定。`, "",
        "| 类别 | 名称 | 调用 | 成功 | 失败 | 待定 | 成功率 |", "| --- | --- | ---: | ---: | ---: | ---: | ---: |");
      for (const kind of ["skill", "mcp"] as const) {
        const rows = usage.rows.filter((row) => row.kind === kind);
        const group = kind === "skill" ? "Skill" : "MCP";
        for (const row of [{ ...totalIntegrationCalls(rows), name: "合计", method: "" }, ...rows]) {
          const name = [row.name || "未提供名称", row.method].filter(Boolean).map(label).join(" / ");
          lines.push(`| ${group} | ${name} | ${row.calls} | ${row.succeeded} | ${row.failed} | ${row.calls - row.succeeded - row.failed} | ${integrationSuccessRate(row)} |`);
        }
      }
    }

    const findings = history.listFindings(id);
    const deliverable = findings.filter((f) =>
      ["verified", "retested", "accepted"].includes(f.status),
    );
    const findingStatusLabel: Record<string, string> = {
      verified: "已复现",
      retested: "修复后复测",
      accepted: "客户接受风险",
    };
    lines.push("", "## Findings", "");
    if (!deliverable.length) {
      lines.push("- （无已验证 finding；tentative 线索不进交付）", "");
    }
    for (const f of deliverable) {
      lines.push(
        `### [${f.severity.toUpperCase()}] ${label(f.title)}（${f.id}）· ${findingStatusLabel[f.status] ?? f.status}`,
        "",
        `- 资产：${label(f.asset)}${f.endpoint ? ` · 端点：${label(f.endpoint)}` : ""} · 类别：${label(f.vulnClass)}`,
      );
      if (f.cvss) lines.push(`- CVSS vector：${label(f.cvss)}`);
      if (f.repro) lines.push(`- 复现：${label(f.repro)}`);
      if (f.impact) lines.push(`- 影响：${label(f.impact)}`);
      if (f.fix) lines.push(`- 修复建议：${label(f.fix)}`);
      for (const e of f.evidence) lines.push(`- 证据：${link(e.path, e.sha256)}`);
      if (f.verifiedAt) lines.push(`- 验证时间：${f.verifiedAt}`);
      lines.push("");
    }
    const tentativeCount = findings.filter((f) => f.status === "tentative").length;
    const retractedCount = findings.filter((f) => f.status === "retracted").length;
    if (tentativeCount) {
      lines.push(`另有 ${tentativeCount} 条 tentative 线索未进交付（finding_verify 附证据与 repro 后方可列入）。`);
    }
    if (retractedCount) {
      lines.push(`已撤回 ${retractedCount} 条误报（保留可查，不进交付）。`);
    }

    lines.push("", "");
    const factLabel = (f: Fact) => `${label(f.title)}（${f.id}）`;

    // 覆盖与当前支持是两件事，分子/分母与统计时点都写在同一段里（验收项 3）。
    const card = history.scorecard(id);
    lines.push(
      "## 覆盖与当前支持", "",
      `统计时点　${card.capturedAt}（实时读数；不可变凭据以交付快照 SHA-256 为准）`,
      `分母　本次约定目标总数 ${card.denominator}${card.applicable ? "" : "（不适用：无目标）"}`,
      "",
      `- 历史通过　${card.historicallyPassed} / ${card.denominator}`,
      `- 当前证据足以支持　${card.currentlySupported} / ${card.denominator}`,
      `- 原依据归属未知　${card.unknownAttribution} / ${card.denominator}`,
      `- 已撤回依据引用（条数，非目标数）　${card.retractedReferences}`,
      "",
      "人工覆盖（五类互斥，合计等于分母）", "",
      `- 已测 ${card.coverage.tested}、部分覆盖 ${card.coverage.partial}、受阻 ${card.coverage.blocked}、` +
        `未测 ${card.coverage.untested}、未登记 ${card.coverage.unregistered}`,
      "",
      "说明：当前证据支持与人工覆盖是两个维度；覆盖充分不代表有发现，零发现也不证明覆盖。",
      "",
    );

    const reconciles = facts.filter((f) => (f.tags ?? []).includes("reconcile"));
    if (reconciles.length) {
      lines.push("## 原始材料差异核算", "");
      for (const entry of reconciles) {
        lines.push(`- ${factLabel(entry)}　${label(entry.summary)}`);
        if (entry.evidencePath) lines.push(`  核算结果　${label(entry.evidencePath)}`);
      }
      lines.push("");
    }

    const retests = history.listRetestRequests(id);
    if (retests.length) {
      lines.push("## 客户复测申请", "");
      for (const request of retests) {
        lines.push(
          `- ${request.status === "fulfilled" ? "已完成" : "待处理"}（${request.requester}` +
            `${request.role ? ` · ${label(request.role)}` : ""}，${request.createdAt}）　${label(request.reason)}`,
          `  涉及结论　${request.findingIds.join("、")}` +
            (request.fulfilledResult ? `　复测结果 ${request.fulfilledResult}（${request.fulfilledAt}）` : ""),
        );
        if (request.evidencePath && request.sha256) lines.push(`  申请依据　${link(request.evidencePath, request.sha256)}`);
      }
      lines.push("");
    }
    const peerReviews = history.listPeerReviews(id);
    if (peerReviews.length) {
      lines.push("## 同一委托内跨任务署名复核", "");
      for (const review of peerReviews) {
        lines.push(
          `- ${label(review.reviewer)}（${label(review.role)}）复核任务 ${label(review.sourceTaskId)} · ${review.decision}　${review.createdAt}`,
          `  对象　${review.findingId ?? review.factId ?? "未指定"}　依据　${label(review.basis)}`,
        );
        if (review.evidencePath && review.sha256) lines.push(`  复核依据　${link(review.evidencePath, review.sha256)}`);
      }
      lines.push("");
    }
    lines.push("", "## 逐项目标复核", "");
    for (const goal of goals) {
      const versions = proofs.filter((p) => p.goalId === goal.id);
      const audit = reviews.filter((r) => r.goalId === goal.id);
      const current = new Map<string, FactReview>();
      for (const r of audit) current.set(r.factId, r);
      const status = describeGoalEvidence(goal, versions, audit, { goalFindings, findings });
      lines.push(`### ${label(goal.title)}（${label(goal.id)}）· ${status}`, "", label(goal.description), "");
      const entries = coverage.filter((entry) => entry.goalId === goal.id);
      if (!entries.length) lines.push("- 人工覆盖记录　未登记（没有覆盖意见，不等于已验证覆盖）");
      const latestCoverage = entries.at(-1);
      if (latestCoverage?.status === "tested" && !goal.findingsGate) {
        const goalAssets = goal.assets ?? [];
        const related = findings.filter(
          (finding) =>
            finding.status !== "retracted" &&
            (goalAssets.length ? goalAssets.includes(finding.asset) : true),
        );
        lines.push(
          `- 结论　在本次检查范围内未检出（人工覆盖：已测；关联发现 ${related.length} 条。` +
            "零发现不等于无风险，范围与时间见上方覆盖记录）",
        );
      }
      for (const entry of entries) {
        const when = entry === entries.at(-1) ? "当前覆盖" : "历次覆盖";
        const evidence = entry.evidencePath && entry.sha256 ? " · " + link(entry.evidencePath, entry.sha256) : "";
        lines.push(`- ${when}　${coverageLabels[entry.status]}（${label(entry.reviewer)}，${entry.createdAt}）　${label(entry.reason)}${evidence}`);
      }
      if (!goal.passes) lines.push(`- 尚缺可通过验收的材料。所需路径：${goal.evidencePatterns.map(label).join("、")}`);
      for (const rule of goal.evidenceChecks ?? []) {
        lines.push(`- 内容判据：${label(rule.pattern)} 中 ${label(rule.field)} = ${label(JSON.stringify(rule.equals))}`);
      }
      if (goal.findingsGate) {
        const gate = goal.findingsGate;
        const scope = gate.scope === "task"
          ? "任务级汇总（显式声明）"
          : `目标资产 ${(gate.assets?.length ? gate.assets : goal.assets ?? []).map(label).join("、") || "未声明"}`;
        lines.push(
          `- Finding 闸：≥${gate.minVerified} 条已验证 finding` +
          (gate.minSeverity ? `（severity≥${gate.minSeverity}）` : "") +
          (gate.vulnClasses?.length ? `（类别：${gate.vulnClasses.map(label).join("、")}）` : "") +
          `（范围：${scope}）`,
        );
        const supports = goalFindings.filter((entry) => entry.goalId === goal.id);
        if (!supports.length) lines.push("- 首次通过时的发现依据：原依据归属未知");
        for (const support of supports) {
          const currentFinding = findings.find((f) => f.id === support.findingId);
          lines.push(`- 首次通过依据：${support.findingId}（当时 ${support.statusAtAssert}，当前 ${currentFinding?.status ?? "未知"}）`);
        }
      }
      if (goal.boardGate === "tsecbench") {
        lines.push("- 基准语义：TSecBench 清板（ALL_COMPLETE.json 全部 is_completed=true）");
      }
      if (goal.passes && goal.assertedAt) lines.push(`- 首次通过：${goal.assertedAt}`);
      for (const v of versions) lines.push(`- 断言时证据：${link(v.path, v.sha256)}`);
      if (goal.passes && !versions.length) {
        for (const p of goal.evidencePaths) lines.push(`- 历史路径（版本未知）：${label(p)}`);
      }
      for (const r of current.values()) {
        const f = byId.get(r.factId)!;
        cited.add(f.id);
        const verdict = r.decision === "confirmed" ? "已复核" : "已撤回";
        lines.push(`- **${verdict}** ${factLabel(f)}。${label(r.reason)}（${label(r.reviewer)}，${r.createdAt}）· ${link(r.evidencePath, r.sha256)}`);
        if (r.replacementFactId) {
          const next = byId.get(r.replacementFactId)!;
          lines.push(`  - 更正指向：${factLabel(next)}（${current.get(next.id)?.decision === "confirmed" ? "已另行复核" : "请参见该记录的复核状态"}）`);
        }
      }
      const affected = [...current.values()].filter((r) => r.decision === "retracted").map((r) => r.factId);
      const seen = new Set(affected);
      for (const parent of affected) {
        for (const child of dependents.get(parent) ?? []) {
          if (seen.has(child.id) || current.has(child.id)) continue;
          seen.add(child.id);
          cited.add(child.id);
          affected.push(child.id);
          lines.push(`- **依据已撤回，待复核** ${factLabel(child)}。直接前驱 ${parent}。`);
        }
      }
      for (const r of audit.filter((entry) => current.get(entry.factId)?.id !== entry.id)) {
        lines.push(`- 历次复核（已替代）：${r.factId} · ${r.decision} · ${label(r.reviewer)} · ${r.createdAt} · ${label(r.reason)} · ${link(r.evidencePath, r.sha256)}`);
      }
      for (const f of facts.filter((item) => item.evidencePath && goal.evidencePaths.includes(item.evidencePath) && !current.has(item.id) && !seen.has(item.id))) {
        cited.add(f.id);
        lines.push(`- 待复核记录：${factLabel(f)}。${label(f.summary)}`);
      }
      lines.push("");
    }
    const remaining = facts.filter((f) => !cited.has(f.id));
    if (remaining.length) {
      lines.push("## 其余历史记录（未关联到已复核结论）", "");
      for (const f of remaining) lines.push(`- ${factLabel(f)}。${label(f.summary)}${f.evidencePath ? ` · 记录路径：${label(f.evidencePath)}` : ""}`);
    }
    if (corrections.length) {
      lines.push("", "## 交付更正", "");
      const noticeLabels = { pending: "待通知", notified: "已通知", confirmed: "客户已确认收悉" } as const;
      for (const correction of corrections) {
        lines.push(
          `- 更正 #${correction.number}（${correction.createdAt}）· ${noticeLabels[correction.noticeStatus]}`,
          `  原因：${label(correction.reason)}`,
          `  影响目标：${correction.goals.map(label).join("、") || "无"}`,
          `  影响发现：${correction.findings.join("、") || "无"}`,
          ...correction.report.map((entry) => `  受影响报告版本：${label(entry.path)} · SHA-256 ${entry.sha256}`),
        );
      }
    }
    const relayCount = history.relayCount(id);
    if (opts.includeRelay !== false && relayCount) lines.push("", "## Session Relay", "", `已记录 ${relayCount} 次会话交接。`);
    publish(task.dataDir, "report.md", lines.join("\n") + "\n");
    history.recordReport(id, "report.md");
    return join(task.dataDir, "report.md");
  });
}

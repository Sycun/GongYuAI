import { createHash, randomUUID } from "node:crypto";
import { lstatSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { TaskStatus, WorkerManifest, Fact } from "@gongyuai/contracts";
import type { HistoryStore, FactReview } from "./index.js";

export type TerminalReportStatus = Extract<TaskStatus, "completed" | "budget_exhausted" | "incomplete" | "failed" | "stopped">;

function publish(dir: string, name: string, content: string | Buffer): void {
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
  opts: { status: TerminalReportStatus; reason?: string; includeRelay?: boolean },
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
      "", "## 逐项目标复核", "");
    const factLabel = (f: Fact) => `${label(f.title)}（${f.id}）`;
    for (const goal of goals) {
      const versions = proofs.filter((p) => p.goalId === goal.id);
      const audit = reviews.filter((r) => r.goalId === goal.id);
      const current = new Map<string, FactReview>();
      for (const r of audit) current.set(r.factId, r);
      let status = "未验证";
      if (goal.passes) {
        const checksContent = goal.evidenceChecks?.length || versions.some((v) => /(^|\/)ALL_COMPLETE\.json$/i.test(v.path));
        status = !versions.length ? "历史通过，原版证据未留存"
          : checksContent ? "已通过内容判据" : "已留存材料（仅文件判据）";
      }
      lines.push(`### ${label(goal.title)}（${label(goal.id)}）· ${status}`, "", label(goal.description), "");
      if (!goal.passes) lines.push(`- 尚缺可通过验收的材料。所需路径：${goal.evidencePatterns.map(label).join("、")}`);
      for (const rule of goal.evidenceChecks ?? []) {
        lines.push(`- 内容判据：${label(rule.pattern)} 中 ${label(rule.field)} = ${label(JSON.stringify(rule.equals))}`);
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
    const relayCount = history.relayCount(id);
    if (opts.includeRelay !== false && relayCount) lines.push("", "## Session Relay", "", `已记录 ${relayCount} 次会话交接。`);
    publish(task.dataDir, "report.md", lines.join("\n") + "\n");
    history.recordReport(id, "report.md");
    return join(task.dataDir, "report.md");
  });
}

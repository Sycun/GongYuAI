/**
 * Deterministic, merge-safe auto-materialization of task deliverables
 * (`evidence/goals/autonomous-progress.md` and `evidence/engagement/report.md`)
 * directly from durable `history.sqlite`.
 *
 * Preserves any manually written model/operator sections outside the
 * `<!-- gongyuai:auto-deliverable:start -->` … `<!-- gongyuai:auto-deliverable:end -->`
 * markers so automated snapshots never clobber human/agent narrative.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { WorkerManifest } from "@gongyuai/contracts";
import type { HistoryStore } from "./index.js";

const AUTO_START = "<!-- gongyuai:auto-deliverable:start -->";
const AUTO_END = "<!-- gongyuai:auto-deliverable:end -->";

export const LEDGER_REL_PATH = "goals/autonomous-progress.md";
export const REPORT_REL_PATH = "engagement/report.md";

function cleanLine(s: string | null | undefined, max = 240): string {
  const text = (s ?? "").replace(/\s+/g, " ").trim();
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function mergeMarkedContent(existing: string | null, autoBody: string): string {
  const block = `${AUTO_START}\n${autoBody.trim()}\n${AUTO_END}\n`;
  if (!existing || !existing.trim()) return block;
  const startIdx = existing.indexOf(AUTO_START);
  const endIdx = existing.indexOf(AUTO_END);
  if (startIdx >= 0 && endIdx > startIdx) {
    const before = existing.slice(0, startIdx).trimEnd();
    const after = existing.slice(endIdx + AUTO_END.length).trimStart();
    return [before, block.trimEnd(), after].filter(Boolean).join("\n\n") + "\n";
  }
  // Preserve manually written content intact and append the structured auto-snapshot.
  return `${existing.trimEnd()}\n\n---\n\n${block}`;
}

function writeMergedDeliverable(evidenceDir: string, relPath: string, autoBody: string): string {
  const fullPath = join(evidenceDir, relPath);
  mkdirSync(dirname(fullPath), { recursive: true, mode: 0o700 });
  const existing = existsSync(fullPath) ? readFileSync(fullPath, "utf8") : null;
  const merged = mergeMarkedContent(existing, autoBody);
  if (existing !== merged) {
    writeFileSync(fullPath, merged, { mode: 0o600 });
  }
  return fullPath;
}

function renderProgressLedger(
  task: Pick<WorkerManifest, "taskId" | "auth">,
  history: HistoryStore,
): string {
  const id = task.taskId;
  const goals = history.listGoals(id);
  const assets = history.listAssets(id);
  const findings = history.listFindings(id);
  const intents = history.listIntents(id);
  const credentials = history.listCredentials(id);
  const facts = history.listFacts(id);

  const verified = findings.filter((f) => ["verified", "retested", "accepted"].includes(f.status));
  const tentative = findings.filter((f) => f.status === "tentative");
  const openIntents = intents.filter((i) => ["proposed", "claimed", "running"].includes(i.status));
  const failedIntents = intents.filter((i) => i.status === "failed");

  const lines: string[] = [
    "# Autonomous Engagement Progress Ledger",
    "",
    `- Task: \`${id}\``,
    `- Updated: ${new Date().toISOString()}`,
    `- Targets: ${task.auth.targets.join(", ") || "—"}`,
    `- Summary: Assets=${assets.length} · Verified Findings=${verified.length} · Tentative=${tentative.length} · Credentials=${credentials.length} · Facts=${facts.length}`,
    "",
    "## Goals",
  ];
  if (!goals.length) {
    lines.push("- （无目标记录）");
  } else {
    for (const g of goals) {
      lines.push(`- [${g.passes ? "x" : " "}] \`${g.id}\` ${cleanLine(g.title)}`);
    }
  }

  lines.push("", "## Assets");
  if (!assets.length) {
    lines.push("- （暂无已登记资产）");
  } else {
    for (const a of assets.slice(0, 60)) {
      lines.push(`- [${a.kind}] \`${a.address}\``);
    }
  }

  lines.push("", "## Findings");
  if (!findings.length) {
    lines.push("- （暂无 Finding）");
  } else {
    for (const f of findings) {
      const qual = f.qualification ? ` · qual=${f.qualification}` : "";
      lines.push(`- [${f.status}/${f.severity.toUpperCase()}${qual}] ${cleanLine(f.title)} (\`${f.asset}\`${f.endpoint ? ` · \`${cleanLine(f.endpoint, 80)}\`` : ""})`);
    }
  }

  lines.push("", "## Credentials (Redacted Refs)");
  if (!credentials.length) {
    lines.push("- （无）");
  } else {
    for (const c of credentials) {
      lines.push(`- [${c.kind}] \`${c.asset}\` user=\`${c.username || "—"}\` ref=\`${c.secretRef}\`${c.verifiedAt ? " (verified)" : ""}`);
    }
  }

  lines.push("", "## Residual / Open Surfaces");
  if (!openIntents.length && !failedIntents.length) {
    lines.push("- （无未关闭或失败的 Intent）");
  } else {
    for (const i of openIntents.slice(0, 20)) {
      lines.push(`- [open/${i.status}] ${cleanLine(i.title)}`);
    }
    for (const i of failedIntents.slice(-15)) {
      lines.push(`- [failed] ${cleanLine(i.title)}${i.conclusion ? ` — ${cleanLine(i.conclusion, 120)}` : ""}`);
    }
  }

  return lines.join("\n");
}

function renderEngagementReport(
  task: Pick<WorkerManifest, "taskId" | "auth">,
  history: HistoryStore,
): string {
  const id = task.taskId;
  const assets = history.listAssets(id);
  const findings = history.listFindings(id);
  const credentials = history.listCredentials(id);
  const verified = findings.filter((f) => ["verified", "retested", "accepted"].includes(f.status));
  const tentative = findings.filter((f) => f.status === "tentative");

  const bySeverity = (sev: string) => verified.filter((f) => f.severity === sev).length;
  const lines: string[] = [
    "# Engagement Report",
    "",
    `- Task: \`${id}\``,
    `- Updated: ${new Date().toISOString()}`,
    `- Scope Targets: ${task.auth.targets.join(", ") || "—"}`,
    `- Out of Scope: ${task.auth.outOfScope?.join(", ") || "—"}`,
    `- Verified Findings: ${verified.length} (Critical=${bySeverity("critical")}, High=${bySeverity("high")}, Medium=${bySeverity("medium")}, Low=${bySeverity("low")}, Info=${bySeverity("info")})`,
    `- Discovered Assets: ${assets.length} · Credentials: ${credentials.length}`,
    "",
    "## Verified Findings",
  ];

  if (!verified.length) {
    lines.push("- （暂无已验证 Finding）");
  } else {
    for (const f of verified) {
      const validations = history.listFindingValidations(id, f.id).filter((v) => v.independent);
      lines.push(
        "",
        `### [${f.severity.toUpperCase()}] ${cleanLine(f.title)}`,
        `- Asset: \`${f.asset}\`${f.endpoint ? ` · Endpoint: \`${cleanLine(f.endpoint, 120)}\`` : ""} · Class: \`${f.vulnClass}\``,
        `- Status: \`${f.status}\`${f.qualification ? ` · Qualification: \`${f.qualification}\`` : ""}${validations.length ? ` · Independent Validations: ${validations.map((v) => v.verdict).join(", ")}` : ""}`,
      );
      if (f.cvss) lines.push(`- CVSS: \`${f.cvss}\``);
      if (f.repro) lines.push(`- Reproduction: ${cleanLine(f.repro, 400)}`);
      if (f.pocCurl) lines.push(`- PoC: \`${cleanLine(f.pocCurl, 400)}\``);
      if (f.impact) lines.push(`- Impact: ${cleanLine(f.impact, 300)}`);
      if (f.fix) lines.push(`- Remediation: ${cleanLine(f.fix, 300)}`);
      if (f.evidence.length) {
        lines.push(`- Evidence: ${f.evidence.map((e) => `\`${e.path}\` (${e.sha256.slice(0, 12)})`).join(", ")}`);
      }
    }
  }

  lines.push("", "## Residual Risk & Unverified Leads");
  if (!tentative.length) {
    lines.push("- （无未验证线索）");
  } else {
    for (const f of tentative) {
      lines.push(`- [${f.severity.toUpperCase()}] ${cleanLine(f.title)} (\`${f.asset}\`)`);
    }
  }

  return lines.join("\n");
}

export type MaterializedDeliverables = {
  ledgerPath: string | null;
  reportPath: string | null;
};

function goalRequestsPath(goals: ReturnType<HistoryStore["listGoals"]>, targetSuffix: string): boolean {
  return goals.some((g) =>
    (g.evidencePatterns ?? []).some((p) => p.replace(/\\/g, "/").includes(targetSuffix)),
  );
}

/**
 * Incrementally materialize `evidence/goals/autonomous-progress.md` and
 * `evidence/engagement/report.md` from `history.sqlite` when the task's goals
 * request them or when the task has recorded findings/intents/credentials.
 */
export function materializeTaskDeliverables(
  task: Pick<WorkerManifest, "taskId" | "evidenceDir" | "auth">,
  history: HistoryStore,
): MaterializedDeliverables {
  const goals = history.listGoals(task.taskId);
  const findings = history.listFindings(task.taskId);
  const hasOperationalActivity =
    findings.length > 0 ||
    history.listCredentials(task.taskId).length > 0 ||
    history.listIntents(task.taskId).length > 0;

  const needLedger = goalRequestsPath(goals, "autonomous-progress.md") || hasOperationalActivity;
  const needReport = goalRequestsPath(goals, "engagement/report.md") || findings.length > 0;

  const ledgerPath = needLedger
    ? writeMergedDeliverable(task.evidenceDir, LEDGER_REL_PATH, renderProgressLedger(task, history))
    : null;
  const reportPath = needReport
    ? writeMergedDeliverable(task.evidenceDir, REPORT_REL_PATH, renderEngagementReport(task, history))
    : null;
  return { ledgerPath, reportPath };
}

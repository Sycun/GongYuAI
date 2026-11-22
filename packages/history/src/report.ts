import { randomUUID } from "node:crypto";
import { renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { TaskStatus, WorkerManifest } from "@gongyuai/contracts";
import type { HistoryStore } from "./index.js";

export type TerminalReportStatus = Extract<
  TaskStatus,
  "completed" | "budget_exhausted" | "incomplete" | "failed" | "stopped"
>;

export function writeTaskReport(
  task: Pick<WorkerManifest, "taskId" | "dataDir" | "auth">,
  history: HistoryStore,
  opts: { status: TerminalReportStatus; reason?: string; relaySummary?: string },
): string {
  const reason = opts.reason ? `\nReason: ${opts.reason}\n` : "\n";
  const body = `# GongYuAI Report

Task: ${task.taskId}
Status: ${opts.status}${reason}Targets: ${task.auth.targets.join(", ")}
Authorization: ${task.auth.authorizationNote}

## History overview

${history.overview(task.taskId)}

${opts.relaySummary ?? ""}
`;
  const reportPath = join(task.dataDir, "report.md");
  const temporaryPath = join(task.dataDir, `.report-${randomUUID()}.tmp`);
  try {
    writeFileSync(temporaryPath, body, { flag: "wx", mode: 0o600 });
    renameSync(temporaryPath, reportPath);
  } finally {
    rmSync(temporaryPath, { force: true });
  }
  history.recordReport(task.taskId, "report.md");
  return reportPath;
}

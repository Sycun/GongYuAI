import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { WorkerManifest } from "@gongyuai/contracts";
import type { HistoryStore } from "@gongyuai/history";
import { formatRelayInjection, listRelayProtocols } from "./relay.js";

export type TerminalReportStatus =
  | "completed"
  | "budget_exhausted"
  | "incomplete"
  | "failed"
  | "stopped";

/**
 * P5: always land report.md on terminal paths (including budget_exhausted).
 * Content is graph-rendered; status is explicit — no invented event times.
 */
export function writeTerminalReport(
  manifest: WorkerManifest,
  history: HistoryStore,
  opts: {
    status: TerminalReportStatus;
    reason?: string;
  },
): string {
  const relays = formatRelayInjection(listRelayProtocols(manifest.workspaceDir));
  const reasonLine = opts.reason ? `\nReason: ${opts.reason}\n` : "\n";
  const body = `# GongYuAI Report

Task: ${manifest.taskId}
Status: ${opts.status}${reasonLine}Targets: ${manifest.auth.targets.join(", ")}
Authorization: ${manifest.auth.authorizationNote}

## History overview

${history.overview(manifest.taskId)}

${relays}
`;
  const reportPath = join(manifest.dataDir, "report.md");
  writeFileSync(reportPath, body);
  history.recordReport(manifest.taskId, "report.md");
  return reportPath;
}

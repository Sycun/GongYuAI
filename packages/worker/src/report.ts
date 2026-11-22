import type { WorkerManifest } from "@gongyuai/contracts";
import { writeTaskReport, type HistoryStore, type TerminalReportStatus } from "@gongyuai/history";
import { formatRelayInjection, listRelayProtocols } from "./relay.js";

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
  return writeTaskReport(manifest, history, {
    ...opts,
    relaySummary: formatRelayInjection(listRelayProtocols(manifest.workspaceDir)),
  });
}

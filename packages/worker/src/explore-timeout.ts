/**
 * Cairn-style dual-stage Explore: wall timeout → force conclude + partial Fact.
 */
import type { HistoryStore } from "@gongyuai/history";
import type { CheckpointState } from "./checkpoint.js";
import { appendProgress } from "./tools.js";

export type ExploreTimeoutResult = {
  concluded: boolean;
  intentId: string | null;
  message: string | null;
};

/**
 * If active Intent has exceeded exploreTimeoutMs, force-conclude with partial Fact.
 * Clears checkpoint activeIntentId. Never invents tactics.
 */
export function maybeForceExploreTimeout(opts: {
  history: HistoryStore;
  taskId: string;
  workerId: string;
  workspaceDir: string;
  state: CheckpointState;
  exploreTimeoutMs: number;
  save: () => void;
  leader?: boolean;
  nowMs?: number;
  /** Current cumulative tool calls; with toolsAtIntentClaim gives steps-on-intent. */
  toolCalls?: number | null;
  /** Hard step budget per intent; exceeded => force conclude regardless of wall time. */
  hardToolLimit?: number;
}): ExploreTimeoutResult {
  const timeoutMs = opts.exploreTimeoutMs;
  const intentId = opts.state.activeIntentId;
  const claimedAt = opts.state.activeIntentClaimedAt;
  if (!intentId || !claimedAt) {
    return { concluded: false, intentId: null, message: null };
  }
  const claimedMs = Date.parse(claimedAt);
  if (!Number.isFinite(claimedMs)) {
    return { concluded: false, intentId: null, message: null };
  }
  const now = opts.nowMs ?? Date.now();
  const wallExceeded = timeoutMs > 0 && now - claimedMs >= timeoutMs;
  const hardLimit = opts.hardToolLimit ?? 0;
  const sinceClaim =
    opts.toolCalls != null && opts.state.toolsAtIntentClaim != null
      ? opts.toolCalls - opts.state.toolsAtIntentClaim
      : null;
  const stepsExceeded = hardLimit > 0 && sinceClaim != null && sinceClaim >= hardLimit;
  if (!wallExceeded && !stepsExceeded) {
    return { concluded: false, intentId: null, message: null };
  }
  const reason = stepsExceeded
    ? `Explore hard step limit ${hardLimit} exceeded (stepsOnIntent=${sinceClaim}); force rotate`
    : `Explore wall timeout ${timeoutMs}ms exceeded (claimedAt=${claimedAt})`;

  const done = opts.history.forceConcludeExploreTimeout({
    taskId: opts.taskId,
    intentId,
    workerId: opts.workerId,
    reason,
  });
  opts.state.activeIntentId = null;
  opts.state.activeIntentClaimedAt = null;
  opts.state.toolsAtIntentClaim = null;
  opts.state.lastSoftSurfaceMilestone = 0;
  const open = opts.history.openIntents(opts.taskId);
  opts.state.phase = open.length > 0 || opts.leader === false ? "explore" : "reason";
  opts.save();
  const msg = done
    ? `explore_timeout force-conclude ${intentId} → failed+partial; phase=${opts.state.phase}`
    : `explore_timeout: intent ${intentId} already closed`;
  appendProgress(opts.workspaceDir, msg);
  return {
    concluded: Boolean(done),
    intentId,
    message: msg,
  };
}

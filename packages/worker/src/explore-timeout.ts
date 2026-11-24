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
}): ExploreTimeoutResult {
  const timeoutMs = opts.exploreTimeoutMs;
  if (timeoutMs <= 0) {
    return { concluded: false, intentId: null, message: null };
  }
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
  if (now - claimedMs < timeoutMs) {
    return { concluded: false, intentId: null, message: null };
  }

  const done = opts.history.forceConcludeExploreTimeout({
    taskId: opts.taskId,
    intentId,
    workerId: opts.workerId,
    reason: `Explore wall timeout ${timeoutMs}ms exceeded (claimedAt=${claimedAt})`,
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

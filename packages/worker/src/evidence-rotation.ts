/**
 * Evidence-exhaustion surface rotation (relay-safe, production-oriented).
 *
 * Real engagements rotate attack surfaces when VERIFIED evidence stalls — not by
 * challenge code or solved-count. The progress signal is the freshest verified
 * evidence in durable History (verified finding / credential / live foothold), whose
 * timestamps survive Session Relay reset. Persist while verified traction flows;
 * force-conclude the active Intent and return to Reason only when a surface is
 * genuinely exhausted. Granularity is the Intent/attack-surface, never a benchmark code.
 */
import type { HistoryStore } from "@gongyuai/history";
import type { CheckpointState } from "./checkpoint.js";
import { appendProgress } from "./tools.js";

export const EVIDENCE_STALL_MS =
  Number(process.env.GY_EVIDENCE_STALL_MS ?? 900_000) || 900_000;

function ms(iso: string | null | undefined): number {
  if (!iso) return 0;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : 0;
}

/** Freshest verified-evidence timestamp (ms) from durable History; 0 if none. */
export function lastVerifiedEvidenceAt(history: HistoryStore, taskId: string): number {
  let latest = 0;
  for (const f of history.listFindings(taskId)) {
    if (f.verifiedAt) latest = Math.max(latest, ms(f.verifiedAt));
  }
  for (const c of history.listCredentials(taskId)) {
    if (c.verifiedAt) latest = Math.max(latest, ms(c.verifiedAt));
  }
  for (const a of history.listAssets(taskId)) {
    if (a.kind === "live") latest = Math.max(latest, ms(a.createdAt));
  }
  return latest;
}

export type EvidenceStallResult = {
  concluded: boolean;
  intentId: string | null;
  message: string | null;
};

/**
 * Force-conclude the active Intent when verified evidence has stalled past stallMs.
 * Relay-safe: the anchor derives from History (verified-evidence recency + intent
 * createdAt), never from the volatile checkpoint claim timestamp that reset() loses.
 */
export function maybeForceEvidenceStall(opts: {
  history: HistoryStore;
  taskId: string;
  workerId: string;
  workspaceDir: string;
  state: CheckpointState;
  save: () => void;
  stallMs?: number;
  leader?: boolean;
  nowMs?: number;
}): EvidenceStallResult {
  const intentId = opts.state.activeIntentId;
  if (!intentId) return { concluded: false, intentId: null, message: null };
  const intent = opts.history.getIntent(opts.taskId, intentId);
  if (!intent) return { concluded: false, intentId: null, message: null };
  const stallMs = opts.stallMs ?? EVIDENCE_STALL_MS;
  if (stallMs <= 0) return { concluded: false, intentId: null, message: null };
  const now = opts.nowMs ?? Date.now();
  const anchor = Math.max(
    lastVerifiedEvidenceAt(opts.history, opts.taskId),
    ms(intent.createdAt),
  );
  const idle = now - anchor;
  if (idle < stallMs) return { concluded: false, intentId: null, message: null };
  const minutes = Math.round(idle / 60_000);
  const reason = `Evidence stall: ${minutes}min since last verified evidence on this surface; force rotate (relay-safe)`;
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
    ? `evidence_stall force-conclude ${intentId} → failed+partial; ${minutes}min 无新 verified 证据; phase=${opts.state.phase}`
    : `evidence_stall: intent ${intentId} already closed`;
  appendProgress(opts.workspaceDir, msg);
  return { concluded: Boolean(done), intentId, message: msg };
}
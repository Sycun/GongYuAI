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
import { normalizeHost, targetAllows, type Intent } from "@gongyuai/contracts";
import type { HistoryStore } from "@gongyuai/history";
import type { CheckpointState } from "./checkpoint.js";
import { appendProgress } from "./tools.js";

export const EVIDENCE_STALL_MS =
  Number(process.env.GY_EVIDENCE_STALL_MS ?? 900_000) || 900_000;

export const EVIDENCE_PROGRESS_GRACE_MS =
  Number(process.env.GY_EVIDENCE_PROGRESS_GRACE_MS ?? 300_000) || 300_000;

/** Tiered exploration timeboxes by prior attempt count on the same host: R1=12m, R2=30m, R3+=45m. */
export const TIERED_STALL_MS = [12 * 60_000, 30 * 60_000, 45 * 60_000] as const;

/** Minimum continuation window granted whenever verified traction (finding/credential/foothold) lands. */
export const BREAKTHROUGH_RENEWAL_MS = 20 * 60_000;

/** Default Soft Drain grace turns before hard force-conclude wipes the active Intent. */
export const DEFAULT_DRAIN_STEPS = 3;

function ms(iso: string | null | undefined): number {
  if (!iso) return 0;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : 0;
}

/**
 * Whether a candidate asset/address belongs to the active Intent's declared `assetRoot`.
 * Unscoped Intents (empty `assetRoot`) accept any in-scope verified evidence.
 */
export function matchesIntentSurface(
  assetRoot: string | null | undefined,
  candidate: string | null | undefined,
): boolean {
  const root = assetRoot?.trim();
  if (!root) return true;
  const cand = candidate?.trim();
  if (!cand) return false;
  if (cand === root) return true;
  return targetAllows([root], cand, []);
}

/**
 * Freshest verified-evidence timestamp (ms) from durable History; 0 if none.
 * When `scope.assetRoot` is provided, only verified evidence matching that surface
 * counts as traction so unrelated cross-surface solves never keep a stale Intent alive.
 */
export function lastVerifiedEvidenceAt(
  history: HistoryStore,
  taskId: string,
  scope?: { intentId?: string | null; assetRoot?: string | null },
): number {
  let latest = 0;
  const root = scope?.assetRoot?.trim() || null;
  const boundaryMs = root ? latestInstanceBoundaryAt(history, taskId, root) : 0;
  const fresh = (ts: number) => boundaryMs <= 0 || ts >= boundaryMs;
  for (const f of history.listFindings(taskId)) {
    if (!f.verifiedAt) continue;
    if (root && !matchesIntentSurface(root, f.asset)) continue;
    const at = ms(f.verifiedAt);
    if (!fresh(at)) continue;
    latest = Math.max(latest, at);
  }
  for (const c of history.listCredentials(taskId)) {
    if (!c.verifiedAt) continue;
    if (root && !matchesIntentSurface(root, c.asset)) continue;
    const at = ms(c.verifiedAt);
    if (!fresh(at)) continue;
    latest = Math.max(latest, at);
  }
  for (const a of history.listAssets(taskId)) {
    if (a.kind !== "live") continue;
    if (root && !matchesIntentSurface(root, a.address)) continue;
    const at = ms(a.createdAt);
    if (!fresh(at)) continue;
    latest = Math.max(latest, at);
  }
  return latest;
}

/**
 * Newest `instance-boundary` Fact for a recycled container host.
 * Facts tagged `asset.addr:<host>` or otherwise on the same surface count.
 * Returns 0 when this host has never been recycled.
 */
export function latestInstanceBoundaryAt(
  history: HistoryStore,
  taskId: string,
  assetRoot: string | null | undefined,
): number {
  const root = assetRoot?.trim();
  if (!root) return 0;
  let latest = 0;
  for (const fact of history.listFacts(taskId)) {
    if (!fact.tags.includes("instance-boundary")) continue;
    const addrs = fact.tags
      .filter((tag) => tag.startsWith("asset.addr:"))
      .map((tag) => tag.slice("asset.addr:".length));
    const matched = addrs.some(
      (addr) => matchesIntentSurface(root, addr) || matchesIntentSurface(addr, root),
    );
    if (!matched) continue;
    latest = Math.max(latest, ms(fact.createdAt));
  }
  return latest;
}

/**
 * Freshest substantive non-verified progress on the active Intent (new Facts or
 * tentative Findings tied to this Intent). Used to distinguish active deep analysis
 * from genuine spin-lock before force-concluding an Intent.
 */
export function lastActiveProgressAt(
  history: HistoryStore,
  taskId: string,
  intentId: string,
): number {
  let latest = 0;
  for (const f of history.listFacts(taskId)) {
    if (f.intentId === intentId) latest = Math.max(latest, ms(f.createdAt));
  }
  for (const f of history.listFindings(taskId)) {
    if (f.intentId === intentId && f.status !== "retracted") {
      latest = Math.max(latest, ms(f.createdAt));
    }
  }
  return latest;
}

export type EvidenceStallResult = {
  concluded: boolean;
  intentId: string | null;
  message: string | null;
  extended?: boolean;
  draining?: boolean;
  drainStepsRemaining?: number;
};

/**
 * Resolve tiered timebox for an Intent based on prior concluded attempts against the same `assetRoot`:
 * - Round 1 (0 prior attempts): 12 min fast reconnaissance & low-hanging exploit sweep;
 * - Round 2 (1 prior attempt): 30 min medium-chain / async-callback / multi-hop exploitation;
 * - Round 3+ (≥2 prior attempts): 45 min deep reverse-engineering / multi-layer APT pivot.
 * Explicit `explicitStallMs` or `GY_EVIDENCE_STALL_MS` env overrides always win.
 */
export function resolveAdaptiveStallMs(
  history: HistoryStore,
  taskId: string,
  intent: Pick<Intent, "id" | "assetRoot">,
  explicitStallMs?: number,
): number {
  if (explicitStallMs !== undefined) return explicitStallMs;
  if (process.env.GY_EVIDENCE_STALL_MS) return EVIDENCE_STALL_MS;
  const root = intent.assetRoot ? normalizeHost(intent.assetRoot) : "";
  if (!root) return EVIDENCE_STALL_MS;
  const boundaryMs = latestInstanceBoundaryAt(history, taskId, intent.assetRoot);
  const priorConcluded = history
    .listIntents(taskId)
    .filter(
      (i) =>
        i.id !== intent.id &&
        ["succeeded", "failed", "expired"].includes(i.status) &&
        i.assetRoot &&
        normalizeHost(i.assetRoot) === root &&
        (boundaryMs <= 0 || ms(i.createdAt) >= boundaryMs),
    ).length;
  const tierIdx = Math.min(priorConcluded, TIERED_STALL_MS.length - 1);
  return TIERED_STALL_MS[tierIdx]!;
}

/**
 * Force-conclude (or Soft-Drain) the active Intent when verified evidence has stalled past stallMs.
 * Relay-safe: the anchor derives from History (verified-evidence recency + intent
 * createdAt), never from the volatile checkpoint claim timestamp that reset() loses.
 *
 * - Breakthrough renewal: fresh verified evidence after Intent creation renews at least 20 min;
 * - Graded stall check: recent substantive Fact / tentative Finding extends up to `hardStallMs`;
 * - Soft Drain (`drainSteps > 0`): grants N final tool turns to capture in-flight RCE output,
 *   verify findings, or commit objective incremental Facts before hard rotation.
 */
export function maybeForceEvidenceStall(opts: {
  history: HistoryStore;
  taskId: string;
  workerId: string;
  workspaceDir: string;
  state: CheckpointState;
  save: () => void;
  stallMs?: number;
  progressGraceMs?: number;
  hardStallMs?: number;
  drainSteps?: number;
  leader?: boolean;
  nowMs?: number;
}): EvidenceStallResult {
  const intentId = opts.state.activeIntentId;
  if (!intentId) return { concluded: false, intentId: null, message: null };
  const intent = opts.history.getIntent(opts.taskId, intentId);
  if (!intent) return { concluded: false, intentId: null, message: null };
  const baseStallMs = resolveAdaptiveStallMs(opts.history, opts.taskId, intent, opts.stallMs);
  if (baseStallMs <= 0) return { concluded: false, intentId: null, message: null };
  const now = opts.nowMs ?? Date.now();
  const verifiedAt = lastVerifiedEvidenceAt(opts.history, opts.taskId, {
    intentId: intent.id,
    assetRoot: intent.assetRoot,
  });
  const createdAtMs = ms(intent.createdAt);
  const hasMidIntentBreakthrough = verifiedAt > createdAtMs;
  const stallMs =
    hasMidIntentBreakthrough && (opts.stallMs === undefined || baseStallMs >= 10 * 60_000)
      ? Math.max(baseStallMs, BREAKTHROUGH_RENEWAL_MS)
      : baseStallMs;
  const anchor = Math.max(verifiedAt, createdAtMs);
  const idle = now - anchor;
  if (idle < stallMs) {
    if (opts.state.drainIntentId === intent.id) {
      opts.state.drainIntentId = null;
      opts.state.drainStepsRemaining = null;
      opts.save();
    }
    return { concluded: false, intentId: null, message: null };
  }

  const progressGraceMs = opts.progressGraceMs ?? Math.min(EVIDENCE_PROGRESS_GRACE_MS, Math.floor(stallMs / 2));
  const hardStallMs = opts.hardStallMs ?? stallMs * 2;
  const activeAt = lastActiveProgressAt(opts.history, opts.taskId, intentId);
  if (activeAt > anchor && now - activeAt < progressGraceMs && idle < hardStallMs) {
    return { concluded: false, intentId, message: null, extended: true };
  }

  const maxDrain = opts.drainSteps ?? 0;
  const minutes = Math.round(idle / 60_000);
  if (maxDrain > 0) {
    if (opts.state.drainIntentId !== intentId || opts.state.drainStepsRemaining == null) {
      opts.state.drainIntentId = intentId;
      opts.state.drainStepsRemaining = maxDrain;
      opts.save();
      const drainMsg = `[收尾保护窗 ${maxDrain}/${maxDrain} 步] 当前攻击面探索时间盒（${minutes}min）已到，但系统为你保留最后 ${maxDrain} 步收尾权限：若刚拿到 RCE/凭据/关键回显（如落盘输出或回调日志），请立即读取验证并提交；否则请只记录客观试验输入、响应状态码、存活会话（tmux/shell_session/tunnel）与日志文件路径，调用 intent_conclude 主动收束（严禁下“无漏洞/已穷尽”绝对否定结论）。`;
      appendProgress(opts.workspaceDir, `evidence_stall soft-drain start ${intentId} (${maxDrain} steps left)`);
      return {
        concluded: false,
        draining: true,
        drainStepsRemaining: maxDrain,
        intentId,
        message: drainMsg,
      };
    }
    if (opts.state.drainStepsRemaining > 1) {
      const nextLeft = opts.state.drainStepsRemaining - 1;
      opts.state.drainStepsRemaining = nextLeft;
      opts.save();
      const drainMsg = `[收尾保护窗 剩余 ${nextLeft}/${maxDrain} 步] 请立即完成最终证据验证提交或调用 intent_conclude 落盘客观试验增量（逾期将强制回收会话）。`;
      return {
        concluded: false,
        draining: true,
        drainStepsRemaining: nextLeft,
        intentId,
        message: drainMsg,
      };
    }
  }

  // Rescue any uncommitted fact_draft before hard-closing the Intent so partial breakthroughs never vanish.
  if (opts.state.factDraft?.title) {
    try {
      opts.history.appendFact({
        taskId: opts.taskId,
        layer: "title",
        title: opts.state.factDraft.title,
        summary: opts.state.factDraft.summary,
        ...(opts.state.factDraft.evidencePath ? { evidencePath: opts.state.factDraft.evidencePath } : {}),
        tags: ["partial", "draft-rescued"],
        intentId,
      });
    } catch {
      /* best-effort draft rescue */
    }
  }

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
  opts.state.drainIntentId = null;
  opts.state.drainStepsRemaining = null;
  opts.state.factDraft = null;
  const open = opts.history.openIntents(opts.taskId);
  opts.state.phase = open.length > 0 || opts.leader === false ? "explore" : "reason";
  opts.save();
  const msg = done
    ? `evidence_stall force-conclude ${intentId} → failed+partial; ${minutes}min 无新 verified 证据; phase=${opts.state.phase}`
    : `evidence_stall: intent ${intentId} already closed`;
  appendProgress(opts.workspaceDir, msg);
  return { concluded: Boolean(done), intentId, message: msg };
}
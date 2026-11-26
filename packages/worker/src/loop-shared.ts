import {
  isBudgetHit,
  isExploreLeader,
  isWallHit,
  selectModelRoute,
  type ModelRef,
  type ModelTier,
  type WorkerManifest,
} from "@gongyuai/contracts";
import type { openHistory } from "@gongyuai/history";
import type { CheckpointState, CheckpointStore } from "./checkpoint.js";
import { maybeForceEvidenceStall } from "./evidence-rotation.js";
import { syncGraphPhase, type WorkerRole } from "./graph-phase.js";
import { isLeaderStatusTerminal, normalizeProviderId } from "./model-resilience.js";
import { takeSoftPaceAdvice } from "./soft-pace.js";
import { writeWorkerStatus } from "./status.js";
import { appendProgress, type ToolContext } from "./tools.js";

export const STALE_INTENT_MAX_AGE_MS = 20 * 60_000;

/**
 * Decide whether a Follower's local conversation context should be wiped clean
 * before starting the next round ("单 Intent 干净会话隔离"):
 * Followers persist all verified findings/facts/assets into SQLite History on `intent_conclude`;
 * resetting the transcript between Intents eliminates cross-target context pollution and relay overhead.
 */
export function shouldResetFollowerSession(opts: {
  role: WorkerRole;
  round: number;
  pendingIntentReset: boolean;
  activeIntentId: string | null;
}): boolean {
  if (opts.role !== "follower") return false;
  if (opts.round <= 1) return false;
  return opts.pendingIntentReset && opts.activeIntentId === null;
}

/**
 * Decide whether the multi-worker Leader should wake up to schedule Intents:
 * - Always wake when all open Intents have drained (`openIntents.length === 0`);
 * - Sliding-window refill: wake when `proposed === 0`, at least one Explore Follower slot
 *   is idle (`active < workerCount - 1`), and the active Intent set changed since the last
 *   refill attempt (prevents straggler barriers without spin-looping when surfaces run dry).
 */
export function shouldWakeMultiWorkerLeader(opts: {
  openIntents: ReadonlyArray<{ id: string; status: string }>;
  workerCount: number;
  lastRefillActiveKey: string | null;
}): { wake: boolean; activeKey: string } {
  if (opts.openIntents.length === 0) {
    return { wake: true, activeKey: "" };
  }
  const exploreSlots = Math.max(1, opts.workerCount - 1);
  const proposed = opts.openIntents.filter((i) => i.status === "proposed");
  const active = opts.openIntents.filter((i) => i.status === "claimed" || i.status === "running");
  const activeKey = active.map((i) => i.id).sort().join(",");
  if (
    proposed.length === 0 &&
    active.length < exploreSlots &&
    activeKey !== opts.lastRefillActiveKey
  ) {
    return { wake: true, activeKey };
  }
  return { wake: false, activeKey };
}

/**
 * Inside a continuous submission turn, instruct a multi-worker Leader (once all Follower
 * slots are fed) or an idle Follower (with no active/proposed Intent) to reply `YIELD`
 * and end the submission so `waitForPoolTurn()` parks at zero LLM token cost.
 */
export function poolTurnYieldDirective(opts: {
  toolName: string;
  leader: boolean;
  workerCount: number;
  phase: string;
  activeIntentId: string | null;
  openIntents: ReadonlyArray<{ id: string; status: string }>;
  allGoalsPass: boolean;
  leaderIdleStepsSincePropose?: number;
}): string | undefined {
  if (opts.workerCount <= 1 || opts.allGoalsPass) return undefined;
  if (opts.toolName === "operator_consult") return undefined;

  const exploreSlots = Math.max(1, opts.workerCount - 1);
  const proposedCount = opts.openIntents.filter((i) => i.status === "proposed").length;
  const activeCount = opts.openIntents.filter(
    (i) => i.status === "claimed" || i.status === "running",
  ).length;

  if (opts.leader) {
    if (opts.phase === "bootstrap" && opts.toolName === "phase_set") return undefined;
    if (!opts.activeIntentId && proposedCount + activeCount >= exploreSlots) {
      return `当前 ${exploreSlots} 个并发 Follower 槽位已全部排满（open=${proposedCount + activeCount}，proposed=${proposedCount}，claimed=${activeCount}）。无需继续轮询，请停止调用任何工具并直接简短回复 YIELD 结束本轮，进入零 Token 驻留池等待槽位空闲唤醒。`;
    }
    if (
      !opts.activeIntentId &&
      opts.openIntents.length > 0 &&
      proposedCount === 0 &&
      (opts.leaderIdleStepsSincePropose ?? 0) >= 4
    ) {
      return `当前剩余活跃 Intent（${activeCount} 条）仍在由 Follower 执行且暂无新攻击面可派发。请停止调用工具并直接简短回复 YIELD 结束本轮，进入零 Token 驻留池等待当前 Intent 结项唤醒。`;
    }
    return undefined;
  }

  if (!opts.activeIntentId && proposedCount === 0) {
    return "当前暂无待认领的 proposed Intent（Leader 正在补单或剩余目标已由其他槽位执行）。请停止调用任何工具并直接简短回复 YIELD 结束本轮，进入零 Token 驻留池等待新 Intent 唤醒。";
  }
  return undefined;
}

/**
 * Multi-worker coordination gate (zero LLM token cost):
 * - Periodically sweeps stale claimed Intents back to `proposed` (up to maxRequeues=2) on leader;
 * - Keeps multi-worker Leader parked while Followers are saturated, waking on drain or idle slot refill;
 * - Keeps multi-worker Follower parked when no `proposed` Intent exists yet (prevents premature exit).
 */
export async function waitForPoolTurn(opts: {
  manifest: WorkerManifest;
  ctx: ToolContext;
  state: CheckpointState;
  workerStartedAt: number;
  readPoolSize: () => number;
  lastStaleSweep: { at: number; lastRefillActiveKey?: string | null };
}): Promise<"ready" | "exit"> {
  const { manifest, ctx, state, workerStartedAt, readPoolSize, lastStaleSweep } = opts;
  const taskId = manifest.taskId;
  for (;;) {
    const workerCount = readPoolSize();
    const leader = isExploreLeader(manifest);
    const now = Date.now();
    if (leader && now - lastStaleSweep.at >= 30_000) {
      lastStaleSweep.at = now;
      ctx.history.expireStaleIntents(taskId, STALE_INTENT_MAX_AGE_MS, {
        requeue: true,
        maxRequeues: 2,
      });
    }

    if (ctx.history.allGoalsPass(taskId)) return "exit";
    if (
      isBudgetHit(ctx.usage.toolCalls, manifest.budget.maxToolCalls) ||
      isBudgetHit(state.tokens, manifest.budget.maxTokens) ||
      isWallHit(workerStartedAt, manifest.budget.maxWallMs)
    ) {
      return "ready";
    }
    if (workerCount <= 1) return "ready";

    const open = ctx.history.openIntents(taskId);
    if (leader) {
      const decision = shouldWakeMultiWorkerLeader({
        openIntents: open,
        workerCount,
        lastRefillActiveKey: lastStaleSweep.lastRefillActiveKey ?? null,
      });
      if (decision.wake) {
        lastStaleSweep.lastRefillActiveKey = decision.activeKey;
        state.phase = syncGraphPhase(ctx.history, taskId, state.phase, {
          leader: true,
          workerCount,
          activeIntentId: state.activeIntentId,
        });
        return "ready";
      }
      flushUsage(manifest, ctx, state);
      await new Promise((r) => setTimeout(r, 1_000));
      continue;
    }

    if (isLeaderStatusTerminal(manifest.dataDir)) return "exit";
    if (state.activeIntentId || open.some((i) => i.status === "proposed")) {
      state.phase = "explore";
      return "ready";
    }
    flushUsage(manifest, ctx, state);
    await new Promise((r) => setTimeout(r, 1_000));
  }
}

/** Resolve provider/model/baseUrl for Pi Durable and OpenAI fallback from GongYu settings. */
export function resolvePiModelRef(manifest: WorkerManifest): {
  provider: string;
  modelId: string;
  baseUrl: string;
  apiKeyEnv: string;
  visionEnabled: boolean;
  visionModelId: string;
  tier: ModelTier;
  fallbacks: ModelRef[];
} {
  const settings = manifest.model;
  const base: ModelRef = {
    provider: settings?.provider || "openai",
    modelId: settings?.modelId || process.env.GY_MODEL || "gpt-4.1-mini",
    ...(settings?.baseUrl || process.env.OPENAI_BASE_URL
      ? { baseUrl: (settings?.baseUrl ?? process.env.OPENAI_BASE_URL ?? "").replace(/\/$/, "") }
      : {}),
    ...(settings?.apiKeyEnv ? { apiKeyEnv: settings.apiKeyEnv } : {}),
  };
  const route = selectModelRoute({
    base,
    tiers: manifest.execution?.models,
    providers: manifest.execution?.providers,
    slot: manifest.workerSlot ?? 0,
  });
  const modelId = route.ref.modelId;
  const baseUrl = (
    route.ref.baseUrl ??
    settings?.baseUrl ??
    process.env.OPENAI_BASE_URL ??
    "https://api.openai.com/v1"
  ).replace(/\/$/, "");
  const apiKeyEnv = route.ref.apiKeyEnv ?? settings?.apiKeyEnv ?? "OPENAI_API_KEY";
  const visionEnabled = settings?.visionEnabled !== false;
  const visionModelId = settings?.visionModelId || modelId;

  return {
    provider: normalizeProviderId(route.ref.provider, baseUrl),
    modelId,
    baseUrl,
    apiKeyEnv,
    visionEnabled,
    visionModelId,
    tier: route.tier,
    fallbacks: route.fallbacks,
  };
}

export function maybeSoftPaceMessage(
  state: CheckpointState,
  ctx: ToolContext,
  workerStartedAt: number,
): string | null {
  const advice = takeSoftPaceAdvice({
    toolCalls: Math.max(state.toolCalls, ctx.usage.toolCalls),
    wallMs: Date.now() - workerStartedAt,
    lastSoftToolMilestone: state.lastSoftToolMilestone,
    lastSoftWallMilestone: state.lastSoftWallMilestone,
    toolsAtIntentClaim: state.toolsAtIntentClaim,
    lastSoftSurfaceMilestone: state.lastSoftSurfaceMilestone,
  });
  if (!advice) return null;
  state.lastSoftToolMilestone = advice.next.lastSoftToolMilestone;
  state.lastSoftWallMilestone = advice.next.lastSoftWallMilestone;
  state.lastSoftSurfaceMilestone =
    advice.next.lastSoftSurfaceMilestone ?? state.lastSoftSurfaceMilestone;
  appendProgress(
    ctx.manifest.workspaceDir,
    `软节奏提示（非停工·渗透） tools=${ctx.usage.toolCalls} wallMs=${Date.now() - workerStartedAt}`,
  );
  return advice.message;
}

export function consumePendingSoftPace(state: CheckpointState): string | null {
  const msg = state.pendingSoftPaceMessage;
  if (!msg) return null;
  state.pendingSoftPaceMessage = null;
  return msg;
}

export function flushUsage(
  manifest: WorkerManifest,
  ctx: ToolContext,
  state: CheckpointState,
): void {
  const slot = manifest.workerSlot ?? 0;
  const toolCalls = Math.max(state.toolCalls, ctx.usage.toolCalls);
  const installs = Math.max(state.installs, ctx.usage.installs);
  state.toolCalls = toolCalls;
  state.installs = installs;
  ctx.usage.toolCalls = toolCalls;
  ctx.usage.installs = installs;
  writeWorkerStatus(
    manifest.dataDir,
    {
      status: "running",
      usage: {
        tokens: state.tokens,
        toolCalls,
        installs,
      },
      workerSlot: slot,
      workerId: manifest.workerId,
      phase: state.phase,
      activeIntentId: state.activeIntentId,
    },
    slot,
  );
}

export function runExploreTimeoutGate(
  manifest: WorkerManifest,
  history: ReturnType<typeof openHistory>,
  state: CheckpointState,
  ckpt: CheckpointStore,
  poolSizeOverride?: number,
): string | null {
  const workerCount = poolSizeOverride ?? manifest.workerCount ?? 1;
  const result = maybeForceEvidenceStall({
    history,
    taskId: manifest.taskId,
    workerId: manifest.workerId || `worker-${manifest.taskId.slice(0, 8)}`,
    workspaceDir: manifest.workspaceDir,
    state,
    leader: isExploreLeader(manifest),
    save: () => ckpt.save(state),
  });
  if (result.concluded) {
    state.phase = syncGraphPhase(history, manifest.taskId, state.phase, {
      leader: isExploreLeader(manifest),
      workerCount,
      activeIntentId: state.activeIntentId,
    });
    ckpt.save(state);
  }
  return result.message;
}

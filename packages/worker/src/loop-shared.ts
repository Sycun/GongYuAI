import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  isBudgetHit,
  isExploreLeader,
  isWallHit,
  normalizeHost,
  selectModelRoute,
  type ModelRef,
  type ModelTier,
  type WorkerManifest,
} from "@gongyuai/contracts";
import type { openHistory } from "@gongyuai/history";
import type { CheckpointState, CheckpointStore } from "./checkpoint.js";
import { DEFAULT_DRAIN_STEPS, maybeForceEvidenceStall } from "./evidence-rotation.js";
import { syncGraphPhase, type WorkerRole } from "./graph-phase.js";
import { isLeaderStatusTerminal, normalizeProviderId } from "./model-resilience.js";
import { takeSoftPaceAdvice } from "./soft-pace.js";
import { writeWorkerStatus } from "./status.js";
import { appendProgress, extractHosts, type ToolContext } from "./tools.js";

export const STALE_INTENT_MAX_AGE_MS = 20 * 60_000;
export const ENVIRONMENT_TERMINAL_FILE = "environment-terminal.json";

export type EnvironmentTerminalState = {
  terminal: true;
  reason: string;
  at: string;
  source?: string;
  status?: number;
};

export function writeEnvironmentTerminal(
  dataDir: string | undefined,
  reason: string,
  extra?: { source?: string; status?: number },
): EnvironmentTerminalState | null {
  if (!dataDir) return null;
  const existing = readEnvironmentTerminal(dataDir);
  if (existing) return existing;
  const payload: EnvironmentTerminalState = {
    terminal: true,
    reason,
    at: new Date().toISOString(),
    ...(extra?.source ? { source: extra.source } : {}),
    ...(extra?.status !== undefined ? { status: extra.status } : {}),
  };
  try {
    const filePath = join(dataDir, ENVIRONMENT_TERMINAL_FILE);
    const tmpPath = `${filePath}.${process.pid}.tmp`;
    writeFileSync(tmpPath, JSON.stringify(payload, null, 2));
    renameSync(tmpPath, filePath);
    return payload;
  } catch {
    return payload;
  }
}

export function readEnvironmentTerminal(
  dataDir: string | undefined,
): EnvironmentTerminalState | null {
  if (!dataDir) return null;
  const filePath = join(dataDir, ENVIRONMENT_TERMINAL_FILE);
  if (!existsSync(filePath)) return null;
  try {
    const parsed = JSON.parse(readFileSync(filePath, "utf8")) as Partial<EnvironmentTerminalState>;
    if (parsed && parsed.terminal === true && typeof parsed.reason === "string") {
      return {
        terminal: true,
        reason: parsed.reason,
        at: typeof parsed.at === "string" ? parsed.at : new Date().toISOString(),
        ...(typeof parsed.source === "string" ? { source: parsed.source } : {}),
        ...(typeof parsed.status === "number" ? { status: parsed.status } : {}),
      };
    }
  } catch {
    /* ignore transient sidecar read */
  }
  return null;
}

/**
 * Bounded finalization policy when the external target environment / authorization window
 * has permanently closed (e.g. target range reclaimed / HTTP 409 already finished):
 * - Followers exit immediately once they have no active Intent (zero post-window drift);
 * - Leader waits for in-flight Follower Intents to drain, runs at most 1 finalization round
 *   to assert satisfied report/ledger goals and summarize residual risk, then exits cleanly.
 */
export function evaluateEnvironmentTerminalExit(opts: {
  terminal: EnvironmentTerminalState | null;
  leader: boolean;
  openIntentsCount: number;
  activeIntentId: string | null;
  finalizationRoundsCompleted: number;
}): { shouldExit: boolean; runFinalizationRound: boolean } {
  if (!opts.terminal) {
    return { shouldExit: false, runFinalizationRound: false };
  }
  if (!opts.leader) {
    return { shouldExit: !opts.activeIntentId, runFinalizationRound: false };
  }
  if (opts.activeIntentId || opts.openIntentsCount > 0) {
    return { shouldExit: false, runFinalizationRound: false };
  }
  if (opts.finalizationRoundsCompleted >= 1) {
    return { shouldExit: true, runFinalizationRound: false };
  }
  return { shouldExit: false, runFinalizationRound: true };
}

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
 *   is idle (`active < workerCount - 1`), and the refill signature changed since the last
 *   refill attempt. The signature includes the concluded-Intent count: a drain that returns
 *   the active set to a previously seen key must still wake (idle slot refilled), while a
 *   dry surface with no new conclusions keeps the Leader parked without spin-looping.
 */
export function shouldWakeMultiWorkerLeader(opts: {
  openIntents: ReadonlyArray<{ id: string; status: string }>;
  workerCount: number;
  lastRefillActiveKey: string | null;
  concludedCount?: number;
}): { wake: boolean; activeKey: string } {
  if (opts.openIntents.length === 0) {
    return { wake: true, activeKey: "" };
  }
  const exploreSlots = Math.max(1, opts.workerCount - 1);
  const proposed = opts.openIntents.filter((i) => i.status === "proposed");
  const active = opts.openIntents.filter((i) => i.status === "claimed" || i.status === "running");
  const activeKey = `${active.map((i) => i.id).sort().join(",")}#${opts.concludedCount ?? 0}`;
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
 * The "no new surface" Leader yield only targets fan-out tools (intent_propose /
 * technique_transfer); surface-creating dispatch (tsecbench start, plan_set) stays
 * allowed so the Leader can keep feeding idle Follower slots while the board is open.
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
      (opts.toolName === "intent_propose" || opts.toolName === "technique_transfer") &&
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

    const envTerminal = readEnvironmentTerminal(manifest.dataDir);
    if (ctx.history.allGoalsPass(taskId)) return "exit";
    if (
      isBudgetHit(ctx.usage.toolCalls, manifest.budget.maxToolCalls) ||
      isBudgetHit(state.tokens, manifest.budget.maxTokens) ||
      isWallHit(workerStartedAt, manifest.budget.maxWallMs)
    ) {
      return "ready";
    }
    if (workerCount <= 1) return "ready";

    const allIntents = ctx.history.listIntents(taskId);
    const open = allIntents.filter((i) =>
      ["proposed", "claimed", "running"].includes(i.status),
    );
    if (leader) {
      if (envTerminal && open.length === 0 && !state.activeIntentId) {
        state.phase = syncGraphPhase(ctx.history, taskId, state.phase, {
          leader: true,
          workerCount,
          activeIntentId: state.activeIntentId,
        });
        return "ready";
      }
      if (envTerminal && open.length > 0 && !state.activeIntentId) {
        // Environment is terminal: stay parked without proposing new work while followers drain active Intents.
        flushUsage(manifest, ctx, state);
        await new Promise((r) => setTimeout(r, 1_000));
        continue;
      }
      const decision = shouldWakeMultiWorkerLeader({
        openIntents: open,
        workerCount,
        lastRefillActiveKey: lastStaleSweep.lastRefillActiveKey ?? null,
        concludedCount: allIntents.filter((i) => i.concludedAt).length,
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
    if (envTerminal && !state.activeIntentId) return "exit";
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

export const EXPLORE_TIMEOUT_STEP_INTERVAL = 5;
export const EXPLORE_TIMEOUT_MIN_INTERVAL_MS = 30_000;

export type ExploreTimeoutClock = {
  /** `state.step` already charged for this model turn. Parallel tool calls share it. */
  accountedStep: number;
  stepsSinceRotateCheck: number;
  lastRotateCheckAt: number;
};

export function beginExploreTimeoutClock(now = Date.now()): ExploreTimeoutClock {
  return { accountedStep: -1, stepsSinceRotateCheck: 0, lastRotateCheckAt: now };
}

/**
 * Charge one model turn toward the explore timebox.
 * Returns true only for the first tool result of a turn that is actually due
 * (drain window with >1 steps left, 5 steps, or 30s since the last check).
 * When `drainStepsRemaining === 1` (the model's final grace turn), inline hard-close
 * is deferred to `afterTools` so sibling parallel calls (`write_evidence` + `intent_conclude`)
 * in that final batch are never killed mid-flight.
 */
export function accountExploreTimeoutTurn(opts: {
  clock: ExploreTimeoutClock;
  step: number;
  now: number;
  phase: string;
  activeIntentId: string | null;
  drainIntentId: string | null;
  drainStepsRemaining?: number | null;
}): boolean {
  if (opts.clock.accountedStep === opts.step) return false;
  opts.clock.accountedStep = opts.step;
  opts.clock.stepsSinceRotateCheck += 1;
  const draining = Boolean(opts.drainIntentId && opts.drainIntentId === opts.activeIntentId);
  if (draining && (opts.drainStepsRemaining ?? 0) <= 1) {
    return false;
  }
  const due =
    draining
    || opts.clock.stepsSinceRotateCheck >= EXPLORE_TIMEOUT_STEP_INTERVAL
    || opts.now - opts.clock.lastRotateCheckAt >= EXPLORE_TIMEOUT_MIN_INTERVAL_MS;
  if (opts.phase !== "explore" || !opts.activeIntentId || !due) return false;
  opts.clock.stepsSinceRotateCheck = 0;
  opts.clock.lastRotateCheckAt = opts.now;
  return true;
}

export function runExploreTimeoutGate(
  manifest: WorkerManifest,
  history: ReturnType<typeof openHistory>,
  state: CheckpointState,
  ckpt: CheckpointStore,
  poolSizeOverride?: number,
  opts?: { drainSteps?: number },
): string | null {
  const workerCount = poolSizeOverride ?? manifest.workerCount ?? 1;
  const result = maybeForceEvidenceStall({
    history,
    taskId: manifest.taskId,
    workerId: manifest.workerId || `worker-${manifest.taskId.slice(0, 8)}`,
    workspaceDir: manifest.workspaceDir,
    state,
    drainSteps: opts?.drainSteps ?? DEFAULT_DRAIN_STEPS,
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

/* ======================================================================== *
 * Adaptive rate fuse: per-host consecutive connection-anomaly tracking.
 * ======================================================================== */

export const ADAPTIVE_RATE_FUSE_THRESHOLD = 2;

const NORMAL_HTTP_STATUSES = new Set([200, 301, 302, 400, 401, 403, 404]);
const OVERLOAD_HTTP_STATUSES = new Set([0, 502, 504]);
const CONNECTION_OVERLOAD_RE =
  /ECONNREFUSED|ETIMEDOUT|ETIMEOUT|ECONNRESET|timed?\s*out|timeout/i;

export type TargetOverloadSignal = {
  status?: number | null;
  error?: string | null;
  timedOut?: boolean;
};

/**
 * Counts consecutive connection anomalies per target host. A normal response
 * (200/301/302/400/401/403/404) resets that host to zero immediately.
 */
export class TargetOverloadTracker {
  private readonly consecutiveAnomalies = new Map<string, number>();

  constructor(private readonly maxHosts = 256) {}

  record(hostRaw: string, signal: TargetOverloadSignal): number {
    const host = normalizeHost(hostRaw);
    if (!host) return 0;
    const status = signal.status ?? null;
    if (status != null && NORMAL_HTTP_STATUSES.has(status)) {
      this.consecutiveAnomalies.delete(host);
      return 0;
    }
    const anomaly =
      signal.timedOut === true ||
      (status != null && OVERLOAD_HTTP_STATUSES.has(status)) ||
      (status == null && CONNECTION_OVERLOAD_RE.test(signal.error ?? ""));
    if (!anomaly) return this.consecutiveAnomalies.get(host) ?? 0;
    const next = (this.consecutiveAnomalies.get(host) ?? 0) + 1;
    if (!this.consecutiveAnomalies.has(host) && this.consecutiveAnomalies.size >= this.maxHosts) {
      const oldest = this.consecutiveAnomalies.keys().next().value;
      if (oldest) this.consecutiveAnomalies.delete(oldest);
    }
    this.consecutiveAnomalies.set(host, next);
    return next;
  }

  count(hostRaw: string): number {
    return this.consecutiveAnomalies.get(normalizeHost(hostRaw)) ?? 0;
  }

  reset(hostRaw?: string): void {
    if (hostRaw == null) {
      this.consecutiveAnomalies.clear();
      return;
    }
    this.consecutiveAnomalies.delete(normalizeHost(hostRaw));
  }
}

export const targetOverloadTracker = new TargetOverloadTracker();

export function formatAdaptiveRateFuse(host: string, count: number): string {
  return (
    `[ADAPTIVE_RATE_FUSE · 目标连接异常降速保护] ${host} 连续 ${count} 次连接超时/拒绝或收到 000/502/504。` +
    "目标服务可能已过载或临时不可用：请立即切换为单线程低频探测（如 --rate 10、-t 1 -p 0.5），" +
    "先确认目标服务存活性（curl -sS -o /dev/null -w '%{http_code}'），异常未恢复前不要再并发压测。"
  );
}

/**
 * Feed shell output into the shared tracker when it clearly shows curl status `000`
 * or repeated connection timeouts toward the hosts named in the command.
 */
export function recordShellConnectionSignals(
  command: string,
  output: string,
  tracker: TargetOverloadTracker = targetOverloadTracker,
): string | null {
  const hosts = extractHosts(command);
  if (!hosts.length) return null;
  const anomalous =
    /(?:^|[\s:=])000(?:$|[\s,;])/m.test(output) ||
    /ECONNREFUSED|ETIMEDOUT|ETIMEOUT|Connection timed out|Operation timed out|Connection refused/i.test(
      output,
    );
  if (!anomalous) {
    const okMatch =
      /HTTP\/\d(?:\.\d)?\s+(200|301|302|400|401|403|404)\b/i.exec(output) ??
      /^(200|301|302|400|401|403|404)\s*$/m.exec(output);
    if (okMatch) {
      const okStatus = Number(okMatch[1]);
      for (const host of hosts) {
        tracker.record(host, { status: okStatus });
      }
    }
    return null;
  }
  for (const host of hosts) {
    const count = tracker.record(host, { status: 0, error: output.slice(0, 400) });
    if (count >= ADAPTIVE_RATE_FUSE_THRESHOLD) {
      return formatAdaptiveRateFuse(host, count);
    }
  }
  return null;
}

/**
 * Soft pace advisories — milestones that nudge the model, never terminate.
 * Hard budget gates (positive max*) remain separate; 0 = unlimited still applies.
 */

export type SoftPaceCounters = {
  toolCalls: number;
  wallMs: number;
  /** Highest tool-call milestone already advised (0, step, 2*step, …). */
  lastSoftToolMilestone: number;
  /** Highest wall milestone index already advised (0, 1, 2, …). */
  lastSoftWallMilestone: number;
};

export type SoftPaceConfig = {
  /** Advise every N tool calls. Default 50. */
  toolStep: number;
  /** Advise every N ms of wall time. Default 2h. */
  wallStepMs: number;
};

export const DEFAULT_SOFT_PACE: SoftPaceConfig = {
  toolStep: Number(process.env.GY_SOFT_TOOL_STEP ?? 50) || 50,
  wallStepMs: Number(process.env.GY_SOFT_WALL_MS ?? 7_200_000) || 7_200_000,
};

export type SoftPaceResult = {
  message: string;
  next: Pick<SoftPaceCounters, "lastSoftToolMilestone" | "lastSoftWallMilestone">;
};

function formatWall(ms: number): string {
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  if (h <= 0) return `${m} 分钟`;
  return m > 0 ? `${h} 小时 ${m} 分钟` : `${h} 小时`;
}

/**
 * If a new soft milestone was crossed, return an advisory user message.
 * Does **not** mean stop, budget_exhausted, or wrap-up.
 */
export function takeSoftPaceAdvice(
  counters: SoftPaceCounters,
  cfg: SoftPaceConfig = DEFAULT_SOFT_PACE,
): SoftPaceResult | null {
  const toolStep = Math.max(1, cfg.toolStep);
  const wallStep = Math.max(60_000, cfg.wallStepMs);

  const toolMilestone =
    Math.floor(counters.toolCalls / toolStep) * toolStep;
  const wallIndex = Math.floor(counters.wallMs / wallStep);

  const toolHit =
    toolMilestone > 0 && toolMilestone > counters.lastSoftToolMilestone;
  const wallHit = wallIndex > 0 && wallIndex > counters.lastSoftWallMilestone;

  if (!toolHit && !wallHit) return null;

  const bits: string[] = [
    "【节奏提示 — 不是停工令】",
    "任务仍应继续，直到目标 evidence gate 通过或操作者停止。禁止写最终汇报后收工，禁止自称预算耗尽。",
  ];
  if (toolHit) {
    bits.push(
      `已累计约 ${counters.toolCalls} 次工具调用（软阈值每 ${toolStep} 次提醒一次）。若同一挑战长时间无进展，请 intent_conclude(failed) 后换题；有进展则继续。`,
    );
  }
  if (wallHit) {
    bits.push(
      `已连续跑约 ${formatWall(counters.wallMs)}（软阈值每 ${formatWall(wallStep)} 提醒一次）。这是长程任务，时间本身不是结束条件。`,
    );
  }
  bits.push("请用工具继续推进未通过目标。");

  return {
    message: bits.join("\n"),
    next: {
      lastSoftToolMilestone: Math.max(
        counters.lastSoftToolMilestone,
        toolHit ? toolMilestone : counters.lastSoftToolMilestone,
      ),
      lastSoftWallMilestone: Math.max(
        counters.lastSoftWallMilestone,
        wallHit ? wallIndex : counters.lastSoftWallMilestone,
      ),
    },
  };
}

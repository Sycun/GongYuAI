/**
 * Soft pace advisories — milestones that nudge the model, never terminate.
 * Hard budget gates (positive max*) remain separate; 0 = unlimited still applies.
 *
 * Framed for penetration-test engagement: rotate surfaces, verify findings,
 * maintain assets/report — never "budget exhausted".
 */

export type SoftPaceCounters = {
  toolCalls: number;
  wallMs: number;
  /** Highest tool-call milestone already advised (0, step, 2*step, …). */
  lastSoftToolMilestone: number;
  /** Highest wall milestone index already advised (0, 1, 2, …). */
  lastSoftWallMilestone: number;
  /** Tool-call count when current Intent was claimed (null if none). */
  toolsAtIntentClaim?: number | null;
  /** Soft surface-rotation step while an Intent is claimed. Default 25. */
  surfaceStep?: number;
  /** Last tools-since-claim milestone already advised for this Intent. */
  lastSoftSurfaceMilestone?: number;
};

export type SoftPaceConfig = {
  /** Advise every N tool calls. Default 50. */
  toolStep: number;
  /** Advise every N ms of wall time. Default 2h. */
  wallStepMs: number;
  /** Advise every N tools on the same claimed Intent. Default 25. */
  surfaceStep: number;
};

export const DEFAULT_SOFT_PACE: SoftPaceConfig = {
  toolStep: Number(process.env.GY_SOFT_TOOL_STEP ?? 50) || 50,
  wallStepMs: Number(process.env.GY_SOFT_WALL_MS ?? 7_200_000) || 7_200_000,
  surfaceStep: Number(process.env.GY_SOFT_SURFACE_STEP ?? 25) || 25,
};

export type SoftPaceResult = {
  message: string;
  next: Pick<
    SoftPaceCounters,
    | "lastSoftToolMilestone"
    | "lastSoftWallMilestone"
    | "lastSoftSurfaceMilestone"
  >;
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
  const surfaceStep = Math.max(
    1,
    counters.surfaceStep ?? cfg.surfaceStep ?? DEFAULT_SOFT_PACE.surfaceStep,
  );

  const toolMilestone =
    Math.floor(counters.toolCalls / toolStep) * toolStep;
  const wallIndex = Math.floor(counters.wallMs / wallStep);

  const toolHit =
    toolMilestone > 0 && toolMilestone > counters.lastSoftToolMilestone;
  const wallHit = wallIndex > 0 && wallIndex > counters.lastSoftWallMilestone;

  let surfaceHit = false;
  let surfaceMilestone = counters.lastSoftSurfaceMilestone ?? 0;
  const claimedAt = counters.toolsAtIntentClaim;
  if (claimedAt != null && claimedAt >= 0) {
    const since = Math.max(0, counters.toolCalls - claimedAt);
    const m = Math.floor(since / surfaceStep) * surfaceStep;
    if (m > 0 && m > (counters.lastSoftSurfaceMilestone ?? 0)) {
      surfaceHit = true;
      surfaceMilestone = m;
    }
  }

  if (!toolHit && !wallHit && !surfaceHit) return null;

  const bits: string[] = [
    "【节奏提示 — 不是停工令 · 渗透作业视角】",
    "任务仍应继续，直到目标 evidence gate 通过或操作者停止。禁止写最终汇报后收工，禁止自称预算耗尽。",
    "请用渗透测试作业节奏推进：建图 → 验证影响 → 写 finding → 横向/换面；不要只磨同一题号。",
  ];
  if (surfaceHit) {
    bits.push(
      `当前 Intent 已连续约 ${surfaceMilestone} 次工具（软换面阈值每 ${surfaceStep} 次）。若仍无 submit 回执或可复现漏洞证据：intent_conclude(failed)+否定证据 → close → 换攻击面；有已验证进展则继续并 asset_record / transferable。`,
    );
  }
  if (toolHit) {
    bits.push(
      `已累计约 ${counters.toolCalls} 次工具调用（软阈值每 ${toolStep} 次）。检查：资产清单是否更新、engagement/report.md 是否同步、是否把 foothold 迁移到相邻资产。`,
    );
  }
  if (wallHit) {
    bits.push(
      `已连续跑约 ${formatWall(counters.wallMs)}（软阈值每 ${formatWall(wallStep)}）。时间不是结束条件；优先补全攻击面图与可审计 finding，而非重复无产出 shell。`,
    );
  }
  bits.push("请用工具继续推进未通过目标（含 clear-board / engagement-report）。");

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
      lastSoftSurfaceMilestone: Math.max(
        counters.lastSoftSurfaceMilestone ?? 0,
        surfaceHit ? surfaceMilestone : (counters.lastSoftSurfaceMilestone ?? 0),
      ),
    },
  };
}

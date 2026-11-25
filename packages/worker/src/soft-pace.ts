/**
 * Soft pace advisories — milestones that nudge the model, never terminate.
 * Hard budget gates (positive max*) remain separate; 0 = unlimited still applies.
 *
 * Framed for penetration-test engagement: rotate surfaces, verify findings,
 * maintain assets/report — never "budget exhausted".
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  collectEvidenceGaps,
  currentEvidencePaceBinding,
  type EvidenceDeliverableGap,
  type EvidenceGoalLike,
} from "./board-policy.js";

export type EvidencePaceState = {
  lastToolMilestone: number;
  lastWallIndex: number;
  lastGoalsPassed: number;
};

export type EvidencePaceInput = {
  evidenceDir: string;
  goals: readonly EvidenceGoalLike[];
  goalsPassed?: number;
  historyDb?: string;
  nowMs?: number;
  staleAfterMs?: number;
  /** When set, cadence is kept in memory only (tests). */
  state?: EvidencePaceState;
};

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
  /**
   * Explicit ledger/report check. When omitted, a binding registered from the
   * worker entry is used. Tasks without those goals stay quiet.
   */
  evidence?: EvidencePaceInput;
};

export type SoftPaceConfig = {
  /** Advise every N tool calls. Default 50. */
  toolStep: number;
  /** Advise every N ms of wall time. Default 2h. */
  wallStepMs: number;
  /** Advise every N tools on the same claimed Intent. Default 25. */
  surfaceStep: number;
  /** Re-check evidence files every N tool calls. Default 40. */
  evidenceStep?: number;
  /** Re-check evidence files every N ms. Default 30 min. */
  evidenceWallMs?: number;
  /** Re-check after every N newly passed goals. Default 1. */
  evidenceGoalStep?: number;
  /** File mtime older than this counts as stale. Default 30 min. */
  evidenceStaleMs?: number;
};

function envPositive(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw == null || raw.trim() === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

export const DEFAULT_SOFT_PACE: SoftPaceConfig = {
  toolStep: Number(process.env.GY_SOFT_TOOL_STEP ?? 50) || 50,
  wallStepMs: Number(process.env.GY_SOFT_WALL_MS ?? 7_200_000) || 7_200_000,
  surfaceStep: Number(process.env.GY_SOFT_SURFACE_STEP ?? 25) || 25,
  evidenceStep: envPositive("GY_EVIDENCE_PACE_STEP", 40),
  evidenceWallMs: envPositive("GY_EVIDENCE_PACE_WALL_MS", 1_800_000),
  evidenceGoalStep: envPositive("GY_EVIDENCE_PACE_GOAL_STEP", 1),
  evidenceStaleMs: envPositive("GY_EVIDENCE_FILE_STALE_MS", 1_800_000),
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

const paceMemory = new Map<string, EvidencePaceState>();

export function resetEvidencePaceRuntime(): void {
  paceMemory.clear();
}

function formatWall(ms: number): string {
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  if (h <= 0) return `${m} 分钟`;
  return m > 0 ? `${h} 小时 ${m} 分钟` : `${h} 小时`;
}

function emptyPaceState(): EvidencePaceState {
  return { lastToolMilestone: 0, lastWallIndex: 0, lastGoalsPassed: 0 };
}

function pacePath(evidenceDir: string): string {
  return join(dirname(evidenceDir), "evidence-pace.json");
}

function loadPaceState(evidenceDir: string, inline?: EvidencePaceState): {
  state: EvidencePaceState;
  persist: boolean;
} {
  if (inline) return { state: inline, persist: false };
  const cached = paceMemory.get(evidenceDir);
  if (cached) return { state: cached, persist: true };
  const path = pacePath(evidenceDir);
  try {
    if (existsSync(path)) {
      const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<EvidencePaceState>;
      const state = {
        lastToolMilestone: Number(parsed.lastToolMilestone ?? 0) || 0,
        lastWallIndex: Number(parsed.lastWallIndex ?? 0) || 0,
        lastGoalsPassed: Number(parsed.lastGoalsPassed ?? 0) || 0,
      };
      paceMemory.set(evidenceDir, state);
      return { state, persist: true };
    }
  } catch {
    /* unreadable sidecar — treat as a fresh cadence */
  }
  const state = emptyPaceState();
  paceMemory.set(evidenceDir, state);
  return { state, persist: true };
}

function savePaceState(evidenceDir: string, state: EvidencePaceState, persist: boolean): void {
  paceMemory.set(evidenceDir, state);
  if (!persist) return;
  try {
    writeFileSync(pacePath(evidenceDir), `${JSON.stringify(state)}\n`, { mode: 0o600 });
  } catch {
    /* a reminder must not break the attack loop */
  }
}

function passedGoalsFromHistory(historyDb: string | undefined): number | null {
  if (!historyDb || !existsSync(historyDb)) return null;
  let db: DatabaseSync | null = null;
  try {
    db = new DatabaseSync(historyDb, { readOnly: true });
    db.exec("PRAGMA busy_timeout = 200");
    const row = db.prepare("SELECT count(*) AS n FROM goals WHERE passes = 1").get() as
      | { n: number }
      | undefined;
    return Number(row?.n ?? 0);
  } catch {
    return null;
  } finally {
    db?.close();
  }
}

function resolveEvidenceInput(counters: SoftPaceCounters): EvidencePaceInput | null {
  if (counters.evidence) return counters.evidence;
  const bound = currentEvidencePaceBinding();
  if (!bound?.evidenceDir) return null;
  return {
    evidenceDir: bound.evidenceDir,
    goals: bound.goals,
    ...(bound.historyDb ? { historyDb: bound.historyDb } : {}),
  };
}

function goalsPassed(input: EvidencePaceInput): number {
  if (typeof input.goalsPassed === "number") return input.goalsPassed;
  const fromObjects = input.goals.filter((goal) => goal.passes).length;
  const fromHistory = passedGoalsFromHistory(input.historyDb);
  return Math.max(fromObjects, fromHistory ?? 0);
}

function formatGaps(gaps: EvidenceDeliverableGap[], staleMs: number): string {
  const lines = [
    `【证据落盘检查】目标要求的台账/报告有缺口（软提醒，不中断利用链）。过期阈值 ${formatWall(staleMs)}。`,
  ];
  for (const gap of gaps) {
    if (gap.reason === "missing") {
      const hint = gap.kind === "ledger"
        ? "建议写下已触达资产、已验证或排除的假设、放弃的攻击面与下一步。"
        : "建议写下范围、资产摘要、已验证 finding（严重性/影响/复现/修复）与残留风险。";
      lines.push(
        `- ${gap.label}尚未落盘：\`${gap.evidencePath}\`（目标 ${gap.goalId}）。请用工具写入该路径，不要只留在对话里。${hint}`,
      );
    } else {
      const age = gap.ageMs != null ? formatWall(gap.ageMs) : "较久";
      lines.push(
        `- ${gap.label}已 ${age} 未更新：\`${gap.evidencePath}\`（目标 ${gap.goalId}）。若这期间有新资产、finding 或放弃的面，请补记后再继续；没有新结论则保持当前攻击链。`,
      );
    }
  }
  return lines.join("\n");
}

type EvidenceEval = {
  gaps: EvidenceDeliverableGap[];
  include: boolean;
};

function evaluateEvidence(
  counters: SoftPaceCounters,
  cfg: SoftPaceConfig,
  alsoShow: boolean,
): EvidenceEval {
  const input = resolveEvidenceInput(counters);
  if (!input) return { gaps: [], include: false };
  const evidenceStep = Math.max(1, cfg.evidenceStep ?? DEFAULT_SOFT_PACE.evidenceStep ?? 40);
  const evidenceWall = Math.max(60_000, cfg.evidenceWallMs ?? DEFAULT_SOFT_PACE.evidenceWallMs ?? 1_800_000);
  const goalStep = Math.max(1, cfg.evidenceGoalStep ?? DEFAULT_SOFT_PACE.evidenceGoalStep ?? 1);
  const staleMs = Math.max(60_000, cfg.evidenceStaleMs ?? input.staleAfterMs ?? DEFAULT_SOFT_PACE.evidenceStaleMs ?? 1_800_000);
  const loaded = loadPaceState(input.evidenceDir, input.state);
  const state = loaded.state;
  const toolMark = Math.floor(counters.toolCalls / evidenceStep) * evidenceStep;
  const wallMark = Math.floor(counters.wallMs / evidenceWall);
  const passed = goalsPassed(input);
  const goalMark = Math.floor(passed / goalStep) * goalStep;
  const due = (toolMark > 0 && toolMark > state.lastToolMilestone)
    || (wallMark > 0 && wallMark > state.lastWallIndex)
    || (goalMark > 0 && goalMark > state.lastGoalsPassed);
  if (!due && !alsoShow) return { gaps: [], include: false };

  let gaps: EvidenceDeliverableGap[] = [];
  try {
    gaps = collectEvidenceGaps({
      evidenceDir: input.evidenceDir,
      goals: input.goals,
      ...(input.nowMs != null ? { nowMs: input.nowMs } : {}),
      staleAfterMs: staleMs,
    });
  } catch {
    gaps = [];
  }
  state.lastToolMilestone = Math.max(state.lastToolMilestone, toolMark);
  state.lastWallIndex = Math.max(state.lastWallIndex, wallMark);
  state.lastGoalsPassed = Math.max(state.lastGoalsPassed, goalMark);
  savePaceState(input.evidenceDir, state, loaded.persist);
  return { gaps, include: gaps.length > 0 };
}

/**
 * If a new soft milestone was crossed, return an advisory user message.
 * Does **not** mean stop, budget_exhausted, or wrap-up.
 * Missing ledger/report files add a path and a next action; they never block.
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

  const evidence = evaluateEvidence(counters, cfg, toolHit || wallHit || surfaceHit);
  if (!toolHit && !wallHit && !surfaceHit && !evidence.include) return null;

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
  if (evidence.include) {
    const staleMs = Math.max(
      60_000,
      cfg.evidenceStaleMs ?? counters.evidence?.staleAfterMs ?? DEFAULT_SOFT_PACE.evidenceStaleMs ?? 1_800_000,
    );
    bits.push(formatGaps(evidence.gaps, staleMs));
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

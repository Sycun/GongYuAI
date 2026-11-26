import type { WorkerManifest } from "@gongyuai/contracts";
import { relayMinToolCalls } from "./relay-protocol.js";

export {
  canRelay,
  formatRelayInjection,
  listRelayProtocols,
  relayDir,
  relayMinToolCalls,
  relayPath,
  relayTokenThreshold,
  writeRelayProtocol,
  type RelayWriteInput,
} from "./relay-protocol.js";

/**
 * Hard mid-submission relay reset is OPT-IN and OFF by default. The live Pi session is never
 * reset (long context is handled by pi-durable native compaction); forcing the model to stop
 * every 2 tool calls to write a handoff was the 2026-11-25 token-cost regression root cause.
 */
export function relayHardResetEnabled(): boolean {
  return process.env.GY_RELAY_HARD_RESET === "1";
}

/**
 * beforeTool gate for the mid-submission relay interruption. Returns a block ONLY in explicit
 * hard-reset mode; in the default live-session mode it never interrupts tool calls.
 */
export function midSubmissionRelayGate(opts: {
  hardReset: boolean;
  relayPending: boolean;
  toolName: string;
}): { block: string } | undefined {
  if (!opts.hardReset) return undefined;
  if (
    opts.relayPending &&
    opts.toolName !== "relay" &&
    opts.toolName !== "intent_conclude" &&
    opts.toolName !== "operator_consult"
  ) {
    return {
      block:
        "Session Relay 阈值已触发（硬重置模式）：请停止调用新工具并输出简短交接摘要，系统将落盘 π。",
    };
  }
  return undefined;
}

/** Count top-level tool calls that actually executed and qualify toward Relay eligibility. */
export function countRelayableCalls(
  toolNames: readonly string[],
  blockedCount = 0,
): number {
  const nonRelay = toolNames.filter((name) => name !== "relay").length;
  return Math.max(0, nonRelay - Math.max(0, blockedCount));
}

/** Build an actionable recovery hint when consecutive tool calls hit phase/intent gates. */
export function formatGateSpinRecoveryHint(opts: {
  phase: string;
  activeIntentId: string | null;
  leader: boolean;
  workerCount: number;
}): string {
  if (opts.leader && opts.workerCount > 1) {
    return `连续多次工具调用被门禁拒绝：当前为多节点 Leader（phase=${opts.phase}, pool=${opts.workerCount}），负责调度而不直接执行 Explore 工具；请调用 intent_propose 为可用资产扇出独立 Intent（勿带 claim='true'），或用 tsecbench / engagement_audit / assert_goal。`;
  }
  if (opts.phase === "reason" || opts.phase === "bootstrap") {
    return `连续多次工具调用被门禁拒绝：当前 phase=${opts.phase}（activeIntentId=${opts.activeIntentId ?? "null"}），禁止直接执行 shell/http_request；请先调用 intent_propose${opts.workerCount <= 1 ? "(..., claim='true')" : ""} 创建/认领攻击面 Intent，或调用 engagement_audit / tsecbench / operator_consult。`;
  }
  if (!opts.activeIntentId) {
    return `连续多次工具调用被门禁拒绝：当前 phase=${opts.phase} 但 activeIntentId=null；请先 intent_claim 一个 open Intent（若无 open Intent 则 intent_propose(claim='true')），切勿空转调用 relay。`;
  }
  return `连续多次工具调用被门禁拒绝：请核对当前 phase=${opts.phase}（activeIntentId=${opts.activeIntentId}）允许的工具面，若缺外部条件可调用 operator_consult。`;
}

/** Default step interval between silent background π audit snapshots (not a handoff, never resets). */
export const DEFAULT_RELAY_SNAPSHOT_STEP_INTERVAL = 250;

export function relaySnapshotStepInterval(): number {
  const raw = process.env.GY_RELAY_SNAPSHOT_STEP_INTERVAL;
  if (raw != null && raw !== "") {
    const n = Number(raw);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return DEFAULT_RELAY_SNAPSHOT_STEP_INTERVAL;
}

/**
 * Step-paced silent background π snapshot eligibility. Decoupled from the 30k prompt-token
 * cadence so a 6h run writes a handful of audit artifacts instead of 600+ redundant π files.
 * Never interrupts the current submission; the live session is kept.
 */
export function shouldSnapshotRelay(opts: {
  manifest: WorkerManifest;
  step: number;
  lastSnapshotStep: number;
  toolCallsSinceRelay: number;
}): boolean {
  if (process.env.GY_DIFF_NO_RELAY === "1") return false;
  if (opts.step - opts.lastSnapshotStep < relaySnapshotStepInterval()) return false;
  if (opts.toolCallsSinceRelay < relayMinToolCalls(opts.manifest)) return false;
  return true;
}

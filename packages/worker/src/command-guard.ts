import { createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { CommandLedger, hasCommandLedger, localProbes, type CommandProposal } from "@gongyuai/history";
import type { ApprovalReceipt, WorkerManifest } from "@gongyuai/contracts";

export function commandProposal(tool: string, executable: string, args: unknown, shell = false): CommandProposal {
  const probe = shell && localProbes.find(s => s === executable.trim());
  const verb = (shell ? executable.trim().split(/\s+/)[0] : executable)?.slice(0, 80) ?? "";
  const label = /^[a-zA-Z0-9_.:/-]+$/.test(verb) ? verb : "自定义操作";
  // Never persist or forward arbitrary argument values, shell bodies, or credentials.
  return { tool, summary: probe || label, ...(probe ? { localProbe: probe } : {}),
    digest: createHash("sha256").update(JSON.stringify([tool, executable, args])).digest("hex") };
}
function unavailable(reason: string, id: string): ApprovalReceipt {
  return { id, at: new Date().toISOString(), model: "", scope: "read-only", risk: "unknown", decision: "unavailable", reason };
}
function check(ledger: CommandLedger, m: WorkerManifest, fence: number) {
  const held = ledger.next(m.taskId, fence, "held");
  if (held) throw new Error(held.receipt?.reason ?? "命令审批未通过");
  if (!ledger.active(m.taskId, fence)) throw new Error("命令所属运行已暂停或过期");
}
export function checkCommandRun(m: WorkerManifest) {
  if (!m.commandFence) return;
  if (!hasCommandLedger(m.dataDir)) throw new Error("命令审批控制面不可用");
  const ledger = new CommandLedger(m.dataDir);
  try { check(ledger, m, m.commandFence); } finally { ledger.close(); }
}
export function recordHardDenial(m: WorkerManifest, tool: string, reason: string) {
  if (!m.commandFence) return;
  const ledger = new CommandLedger(m.dataDir);
  try {
    check(ledger, m, m.commandFence);
    const ticket = ledger.request(m.taskId, m.commandFence, commandProposal(tool, tool, []));
    ledger.settle(ticket, { ...unavailable(reason, ticket.id), decision: "block", risk: "high" });
  } finally { ledger.close(); }
}
/** 用户逐次确认时的等待窗口；自动审批保持快速失败。 */
const MANUAL_WAIT_MS = 24 * 60 * 60 * 1000;
export async function reviewBeforeDispatch(m: WorkerManifest, action: CommandProposal): Promise<string | null> {
  if (!m.commandFence || !hasCommandLedger(m.dataDir)) throw new Error("命令审批控制面不可用，操作已拦截");
  const fence = m.commandFence;
  const manual = m.commandConfirmation === "manual";
  const ledger = new CommandLedger(m.dataDir);
  try {
    check(ledger, m, fence);
    const ticket = ledger.request(m.taskId, fence, action);
    // P14-B7: an `ask` verdict moves the ticket to awaiting_user. Give a human a
    // real window to answer instead of failing the command after 90s; only the
    // first transition extends, so a stuck queue still fails closed.
    let deadline = Date.now() + (manual ? MANUAL_WAIT_MS : 90_000);
    let extendedForHuman = false;
    while (true) {
      check(ledger, m, fence);
      if (!manual && !extendedForHuman && ledger.state(ticket.id) === "awaiting_user") {
        deadline = Date.now() + 10 * 60_000;
        extendedForHuman = true;
      }
      const result = ledger.get(ticket.id)?.receipt;
      if (result) {
        // 控制面已按授权范围与执行器能力判定（proposal.command 在范围内才 allow），
        // 这里只认回执，不再用 localProbe 白名单二次拦截。
        if (result.decision === "allow") return ticket.id;
        throw new Error(result.reason);
      }
      if (Date.now() >= deadline) {
        const failure: ApprovalReceipt = manual
          ? { ...unavailable("等待用户确认超时，该次调用已过期", ticket.id), decision: "expired", actor: "policy" }
          : unavailable("命令审批超时，操作已拦截", ticket.id);
        ledger.settle(ticket, failure);
        throw new Error(failure.reason);
      }
      await delay(100);
    }
  } finally { ledger.close(); }
}
/** 放行后的实际执行结果回写台账，控制面据此在审批卡上显示成败。 */
export function reportCommandOutcome(m: WorkerManifest, ticketId: string, ok: boolean, snippet: string) {
  if (!m.commandFence || !hasCommandLedger(m.dataDir)) return;
  const ledger = new CommandLedger(m.dataDir);
  try { ledger.complete(ticketId, { ok, snippet: snippet.slice(0, 200), at: new Date().toISOString() }); } finally { ledger.close(); }
}

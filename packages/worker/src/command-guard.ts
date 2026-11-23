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
export async function reviewBeforeDispatch(m: WorkerManifest, action: CommandProposal) {
  if (!m.commandFence || !hasCommandLedger(m.dataDir)) throw new Error("命令审批控制面不可用，操作已拦截");
  const fence = m.commandFence;
  const ledger = new CommandLedger(m.dataDir);
  try {
    check(ledger, m, fence);
    const ticket = ledger.request(m.taskId, fence, action);
    const deadline = Date.now() + 90_000;
    while (true) {
      check(ledger, m, fence);
      const result = ledger.get(ticket.id)?.receipt;
      if (result) {
        if (result.decision === "allow" && action.localProbe && localProbes.some(s => s === action.localProbe)) return;
        throw new Error(result.reason);
      }
      if (Date.now() >= deadline) {
        const failure = unavailable("命令审批超时，操作已拦截", ticket.id);
        ledger.settle(ticket, failure);
        throw new Error(failure.reason);
      }
      await delay(100);
    }
  } finally { ledger.close(); }
}

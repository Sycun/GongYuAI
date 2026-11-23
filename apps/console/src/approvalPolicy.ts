import type { ChatApproval } from "@gongyuai/contracts/chat-input";

/** 「命令执行前如何确认」的两个单选项：设置页与聊天「审批」面板共用同一套文案。 */
export const confirmationOptions = [
  { value: "auto", label: "低风险命令自动审批", description: "系统支持的本地检查，经审批模型判定为低风险后可直接执行。" },
  { value: "manual", label: "每次执行前由我确认", description: "执行前，在当前会话中查看命令并决定是否允许。" },
] as const;

export const confirmationExample =
  "例如查看系统架构（uname -m）或当前 UTC 时间（date -u）。普通对话、附件分析和查看任务进度无需确认，继续按原流程处理。";

export function confirmationLabel(policy: Pick<ChatApproval, "confirmation">) {
  return policy.confirmation === "manual" ? confirmationOptions[1].label : confirmationOptions[0].label;
}

export function confirmationDescription(policy: Pick<ChatApproval, "confirmation">) {
  return policy.confirmation === "manual" ? confirmationOptions[1].description : confirmationOptions[0].description;
}

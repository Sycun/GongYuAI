import type { ChatSelection } from "@gongyuai/contracts";
import type { AssignmentView, ChatMessage } from "@gongyuai/contracts/chat-input";

export async function submitAssignment(requestId: string, messages: ChatMessage[], selection: ChatSelection, signal: AbortSignal): Promise<AssignmentView> {
  const response = await fetch("/tasks/submit", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ requestId, messages, selection }), signal,
  });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || "任务提交失败");
  return body;
}

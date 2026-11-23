export const MAX_CHAT_FILES = 4;
export const MAX_TEXT_BYTES = 128 * 1024;
export const MAX_IMAGE_BYTES = 1024 * 1024;
export const MAX_FILES_BYTES = 2 * 1024 * 1024;
export const CHAT_FILE_ACCEPT = ".txt,.md,.log,.csv,.tsv,.json,.yaml,.yml,.xml,.ini,.png,.jpg,.jpeg,.webp";
export type ImageType = "image/png" | "image/jpeg" | "image/webp";
export type ChatFile = { name: string; mediaType: "text/plain" | ImageType; data: string };
export type ChatMessage = { role: "user" | "assistant"; content: string; attachments?: ChatFile[] };
export type ChatApproval = {
  /** 旧范围值：约束自动审批可放行的操作面，升级时沿用，不再作为确认方式展示。 */
  scope: "read-only" | "local-validation";
  /** 命令执行前的确认方式：auto=低风险自动审批，manual=每次由用户确认。 */
  confirmation: "auto" | "manual";
  reviewer: { profileId: string; modelId: string } | null;
};
export type ApprovalReceipt = {
  id: string; at: string; model: string; scope: ChatApproval["scope"];
  decision: "allow" | "block" | "unavailable" | "expired"; risk: "low" | "medium" | "high" | "unknown"; reason: string;
  /** 谁下的结论：模型（默认）、用户（会话内确认）、策略（范围拦截/超时）。 */
  actor?: "model" | "user" | "policy";
};

export type CommandReviewDecision =
  | "block" | "unavailable" | "waiting"
  | "executed" | "failed" | "rejected" | "cancelled" | "expired";
export type CommandReviewView = {
  id: string;
  fence?: number;
  tool: string;
  /** 待执行/已执行的命令摘要（本地检查原文）。 */
  summary?: string;
  at: string;
  reason: string;
  decision: CommandReviewDecision;
  model: string;
  /** 用户确认后的实际执行结果或失败原因。 */
  outcome?: string;
  /** 产生该记录时的确认方式。 */
  mode?: "auto" | "manual";
};

export type AssignmentView = {
  taskId: string; status: string; model: string; result?: string; reason?: string;
  commandReview?: CommandReviewView;
};

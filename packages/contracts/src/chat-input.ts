export const MAX_CHAT_FILES = 4;
export const MAX_TEXT_BYTES = 128 * 1024;
export const MAX_IMAGE_BYTES = 1024 * 1024;
export const MAX_FILES_BYTES = 2 * 1024 * 1024;
export const CHAT_FILE_ACCEPT = ".txt,.md,.log,.csv,.tsv,.json,.yaml,.yml,.xml,.ini,.png,.jpg,.jpeg,.webp";
export type ImageType = "image/png" | "image/jpeg" | "image/webp";
export type ChatFile = { name: string; mediaType: "text/plain" | ImageType; data: string };
export type ChatMessage = { role: "user" | "assistant"; content: string; attachments?: ChatFile[] };
export type ChatApproval = {
  scope: "read-only" | "local-validation";
  reviewer: { profileId: string; modelId: string } | null;
};
export type ApprovalReceipt = {
  id: string; at: string; model: string; scope: ChatApproval["scope"];
  decision: "allow" | "block" | "unavailable"; risk: "low" | "medium" | "high" | "unknown"; reason: string;
};

export type AssignmentView = {
  taskId: string; status: string; model: string; result?: string; reason?: string;
  commandReview?: { at: string; tool: string; reason: string; decision: "block" | "unavailable"; model: string };
};

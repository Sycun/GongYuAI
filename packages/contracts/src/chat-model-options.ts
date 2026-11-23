import type { ChatProfile, ChatProtocol, ThinkingEffort } from "./chat-models.js";

export function selectableChatModels(profile: Pick<ChatProfile, "modelId" | "visionModelId" | "models">): string[] {
  return [...new Set([profile.modelId, profile.visionModelId || profile.modelId, ...profile.models])];
}

const standard = ["low", "medium", "high"] as const;
const deepSeekIds = ["deepseek-flash", "deepseek-v4-flash", "deepseek-v4-flash-vision", "deepseek-v4-pro"];

export function isDeepSeekThinkingModel(modelId: string): boolean {
  return deepSeekIds.includes(modelId.toLowerCase());
}

// Model-list APIs can return embeddings, non-reasoning models, or deployment aliases.
// Advertise only recognized combinations. An omitted effort always uses provider defaults.
export function chatThinkingEfforts(protocol: ChatProtocol, modelId: string): readonly ThinkingEffort[] {
  if (protocol !== "gemini" && isDeepSeekThinkingModel(modelId)) return ["off", "low", "high", "max"];
  const id = modelId.toLowerCase().replace(/^models\//, "").replace(/-(?:\d{8}|\d{4}-\d{2}-\d{2})$/, "");
  switch (protocol) {
    case "openai":
      if (["o1", "o3", "o3-mini", "o4-mini"].includes(id)) return standard;
      if (["gpt-5", "gpt-5-mini", "gpt-5-nano"].includes(id)) return ["minimal", ...standard];
      if (id === "gpt-5.1") return ["off", ...standard];
      if (["gpt-5.2", "gpt-5.4", "gpt-5.5"].includes(id)) return ["off", ...standard, "xhigh"];
      if (["gpt-6-astra", "gpt-6.1-sol", "gpt-6.2-astra", "gpt-6.2-sol"].includes(id)) return [...standard, "xhigh", "max"];
      break;
    case "anthropic":
      if (["claude-sonnet-4-6", "claude-opus-4-6"].includes(id)) return [...standard, "max"];
      if (["claude-opus-4-7", "claude-opus-4-8", "claude-opus-5", "claude-opus-5-5",
        "claude-sonnet-5", "claude-sonnet-5-5", "claude-haiku-5-5"].includes(id)) return [...standard, "xhigh", "max"];
      break;
    case "gemini":
      if (["gemini-3.1-flash-lite", "gemini-3.5-flash-lite", "gemini-3.6-flash", "gemini-3-flash-preview"].includes(id)) return ["minimal", ...standard];
      if (["gemini-3.1-pro-preview", "gemini-3.8-flash"].includes(id)) return standard;
      if (id === "gemini-3-pro-preview") return ["low", "high"];
      break;
  }
  return [];
}

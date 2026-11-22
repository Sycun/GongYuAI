import { z } from "zod";

export const ChatProtocolSchema = z.enum(["openai", "anthropic", "gemini"]);
export type ChatProtocol = z.infer<typeof ChatProtocolSchema>;

export const ChatConnectionSchema = z.object({
  id: z.string().regex(/^[a-z0-9_-]{1,80}$/),
  protocol: ChatProtocolSchema,
  baseUrl: z.url({ protocol: /^https?$/ }).max(2048).refine(value => {
    if (!URL.canParse(value)) return false;
    const url = new URL(value);
    return !url.username && !url.password && !url.search && !url.hash;
  }, "服务地址应为不含凭据和查询参数的 HTTP(S) 地址"),
  apiKey: z.string().max(8192).default(""),
});
export const ChatProfileSchema = ChatConnectionSchema.extend({
  name: z.string().trim().min(1).max(80),
  modelId: z.string().trim().min(1).max(256),
  visionModelId: z.string().trim().max(256).optional(),
  models: z.array(z.string().trim().min(1).max(256)).max(5000).default([]),
});
export type ChatProfile = z.infer<typeof ChatProfileSchema>;
export type ChatConnection = z.infer<typeof ChatConnectionSchema>;
export type PublicChatProfile = Omit<ChatProfile, "apiKey"> & { hasKey: boolean };
export type ChatCatalog = { profiles: PublicChatProfile[]; defaultId: string };
export type ThinkingEffort = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
export type ChatSelection = { profileId: string; modelId: string; effort?: ThinkingEffort };

export function modelBaseUrl(baseUrl: string, protocol: ChatProtocol) {
  const url = new URL(baseUrl.trim());
  const path = url.pathname.replace(/\/+$/, "");
  const version = protocol === "gemini" ? "v1beta" : "v1";
  // Gateways can supply an explicit version (e.g. /api/paas/v4).
  url.pathname = /\/v\d+(?:[a-z]+\d*)?$/i.test(path) ? path : path + "/" + version;
  return url.toString().replace(/\/$/, "");
}

export const chatPresets: ChatProfile[] = [
  { id: "deepseek", name: "DeepSeek", protocol: "openai", baseUrl: "https://api.deepseek.com", modelId: "deepseek-flash", models: ["deepseek-v4-pro"], apiKey: "" },
  { id: "openai", name: "OpenAI", protocol: "openai", baseUrl: "https://api.openai.com", modelId: "gpt-4.1-mini", models: [], apiKey: "" },
  { id: "claude", name: "Claude", protocol: "anthropic", baseUrl: "https://api.anthropic.com", modelId: "claude-sonnet-4-6", models: [], apiKey: "" },
  { id: "gemini", name: "Gemini", protocol: "gemini", baseUrl: "https://generativelanguage.googleapis.com", modelId: "gemini-3.5-flash-lite", models: [], apiKey: "" },
];

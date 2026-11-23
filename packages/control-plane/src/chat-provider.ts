import { chatPresets, isDeepSeekThinkingModel, modelBaseUrl, type ChatMessage, type ChatSelection, type ChatConnection, type ChatProfile, type ChatProtocol } from "@gongyuai/contracts";

type ContentBlock = { text: string } | { type: "text"; text: string } | { type: "image_url"; image_url: { url: string } }
  | { type: "image"; source: { type: "base64"; media_type: string; data: string } } | { inlineData: { mimeType: string; data: string } };

function messageParts(message: ChatMessage, protocol: ChatProtocol): ContentBlock[] {
  const files = message.attachments ?? [];
  const texts = files.filter(f => f.mediaType === "text/plain").map(f => ({ name: f.name, text: f.data }));
  const text = texts.length ? message.content + "\n\n文本附件\n" + JSON.stringify(texts) : message.content;
  const parts: ContentBlock[] = [];
  if (text) parts.push(protocol === "gemini" ? { text } : { type: "text", text });
  for (const f of files) {
    if (f.mediaType === "text/plain") continue;
    if (protocol === "gemini") parts.push({ inlineData: { mimeType: f.mediaType, data: f.data } });
    else if (protocol === "anthropic") parts.push({ type: "image", source: { type: "base64", media_type: f.mediaType, data: f.data } });
    else parts.push({ type: "image_url", image_url: { url: "data:" + f.mediaType + ";base64," + f.data } });
  }
  return parts;
}

function headers(connection: ChatConnection): Record<string, string> {
  const result: Record<string, string> = { "content-type": "application/json" };
  const key = connection.apiKey;
  if (connection.protocol === "anthropic") {
    result["anthropic-version"] = "2023-06-01";
    if (key) result["x-api-key"] = key;
  } else if (connection.protocol === "gemini") {
    if (key) result["x-goog-api-key"] = key;
  } else if (key) result.authorization = "Bearer " + key;
  return result;
}

export function needsKey(connection: ChatConnection) {
  return !connection.apiKey && chatPresets.some(p =>
    modelBaseUrl(p.baseUrl, p.protocol) === modelBaseUrl(connection.baseUrl, connection.protocol));
}

export function requestCompletion(profile: ChatProfile, selection: Pick<ChatSelection, "modelId" | "effort">, messages: ChatMessage[], signal: AbortSignal,
  options: { base?: string; system?: string; stream?: boolean } = {}) {
  const base = options.base ?? modelBaseUrl(profile.baseUrl, profile.protocol);
  const stream = options.stream ?? true;
  const chatMessages = messages.map(m => ({ role: m.role, content: m.attachments?.length ? messageParts(m, profile.protocol) : m.content }));
  const { modelId: model, effort } = selection;
  let url: string;
  let payload: object;
  switch (profile.protocol) {
    case "anthropic":
      url = base + "/messages";
      payload = { model, messages: chatMessages, stream, max_tokens: 8192, ...(options.system && { system: options.system }),
        ...(effort && { thinking: { type: effort === "off" ? "disabled" : isDeepSeekThinkingModel(model) ? "enabled" : "adaptive" } }),
        ...(effort && effort !== "off" && { output_config: { effort } }),
      };
      break;
    case "gemini":
      url = base + "/models/" + encodeURIComponent(model.replace(/^models\//, "")) + (stream ? ":streamGenerateContent?alt=sse" : ":generateContent");
      payload = { contents: messages.map(m => ({
        role: m.role === "user" ? "user" : "model", parts: messageParts(m, "gemini"),
      })), ...(options.system && { systemInstruction: { parts: [{ text: options.system }] } }), ...(effort && { generationConfig: { thinkingConfig: { thinkingLevel: effort.toUpperCase() } } }) };
      break;
    default:
      url = base + "/chat/completions";
      payload = { model, messages: options.system ? [{ role: "system", content: options.system }, ...chatMessages] : chatMessages, stream };
      if (effort && isDeepSeekThinkingModel(model)) {
        Object.assign(payload, { thinking: { type: effort === "off" ? "disabled" : "enabled" } });
        if (effort !== "off") Object.assign(payload, { reasoning_effort: effort });
      } else if (effort) {
        Object.assign(payload, { reasoning_effort: effort === "off" ? "none" : effort });
      }
  }
  return fetch(url, { method: "POST", headers: headers(profile), body: JSON.stringify(payload), signal, redirect: "error" });
}

type ProviderResult = {
  choices?: { message?: { content?: string } }[];
  content?: { type: string; text?: string }[];
  candidates?: { content?: { parts?: { text?: string; thought?: boolean }[] } }[];
};
export function responseText(protocol: ChatProtocol, value: unknown) {
  if (!value || typeof value !== "object") return;
  const result = value as ProviderResult;
  switch (protocol) {
    case "anthropic": return result.content?.filter(p => p.type === "text").map(p => p.text).join("");
    case "gemini": return result.candidates?.[0]?.content?.parts?.filter(p => !p.thought).map(p => p.text).join("");
    default: return result.choices?.[0]?.message?.content;
  }
}

type ModelsPage = {
  data?: { id: string }[]; has_more?: boolean; last_id?: string;
  models?: { name: string; supportedGenerationMethods?: string[] }[]; nextPageToken?: string;
};
export async function queryChatModels(connection: ChatConnection) {
  if (needsKey(connection)) throw new Error("请先填写此服务商的接口密钥。");
  const { protocol } = connection;
  const url = new URL(modelBaseUrl(connection.baseUrl, protocol) + "/models");
  const ids = new Set<string>();
  const seen = new Set<string>();
  const signal = AbortSignal.timeout(20_000);
  if (protocol === "gemini") url.searchParams.set("pageSize", "1000");
  if (protocol === "anthropic") url.searchParams.set("limit", "1000");
  while (true) {
    const res = await fetch(url, { headers: headers(connection), signal, redirect: "error" });
    if (!res.ok) {
      await res.body?.cancel();
      throw new Error(`查询模型失败（HTTP ${res.status}），请检查服务地址和密钥。`);
    }
    const page = await res.json() as ModelsPage | null;
    if (!page) throw new Error("模型列表格式无效。");
    const rows = protocol === "gemini" ? page.models : page.data;
    if (!Array.isArray(rows)) throw new Error("服务未返回此协议的模型列表，可以手动填写模型标识。");
    for (const row of rows) {
      if (!row || typeof row !== "object") continue;
      if ("supportedGenerationMethods" in row && !row.supportedGenerationMethods?.includes("generateContent")) continue;
      const id = "id" in row ? row.id : row.name?.replace(/^models\//, "");
      if (typeof id === "string" && id.trim() && id.length <= 256) ids.add(id);
    }
    const next = protocol === "gemini" ? page.nextPageToken : protocol === "anthropic" && page.has_more ? page.last_id : null;
    if (!next) break;
    if (seen.has(next) || ids.size > 5000) throw new Error("服务返回的模型分页异常。");
    seen.add(next);
    url.searchParams.set(protocol === "gemini" ? "pageToken" : "after_id", next);
  }
  return [...ids].sort();
}

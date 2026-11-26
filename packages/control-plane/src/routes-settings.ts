import type { IncomingMessage, ServerResponse } from "node:http";
import {
  AddAssetCollectorSchema,
  AddUserMcpSchema,
  AssetCollectorPatchSchema,
  ChatApprovalSchema,
  ChatConnectionSchema,
  ChatProfileSchema,
  ImportSkillSchema,
  KnowledgeEmbeddingPatchSchema,
  KnowledgeEmbeddingTestSchema,
  ModelSettingsPatchSchema,
  ToggleToolsItemSchema,
  ToolsSettingsPatchSchema,
  UpdateSettingsPatchSchema,
} from "@gongyuai/contracts";
import { queryChatModels } from "./chat-provider.js";
import { projectIntegrationUsage } from "./integration-usage.js";
import { resolveEmbeddingRuntime, testEmbeddingConnection } from "./knowledge-embed.js";
import { readJson, sendJson, type ControlRouteDeps } from "./routes-ops.js";
import { refreshTaskUsage } from "./usage.js";

function jsonBody(req: IncomingMessage): boolean {
  return req.headers["content-type"]?.split(";")[0]?.trim() === "application/json";
}

/** 模型、工具目录、知识库向量与用量设置。不触碰任务 History。 */
export async function handleSettingsRoute(
  req: IncomingMessage,
  res: ServerResponse,
  method: string,
  url: URL,
  deps: ControlRouteDeps,
): Promise<boolean> {
  const { settings, updater, version, store, knowledge } = deps;

  if (url.pathname === "/settings/approval") {
    if (method === "GET") {
      sendJson(res, 200, settings.get().chatApproval);
      return true;
    }
    if (method === "PUT") {
      sendJson(res, 200, settings.saveChatApproval(ChatApprovalSchema.parse(await readJson(req))));
      return true;
    }
  }
  if (method === "GET" && url.pathname === "/chat/models") {
    sendJson(res, 200, settings.chatCatalog());
    return true;
  }
  if (method === "PUT" && url.pathname === "/settings/chat-models") {
    const body = await readJson(req) as { profile?: unknown; makeDefault?: boolean };
    const profile = ChatProfileSchema.parse(body?.profile);
    sendJson(res, 200, settings.saveChatProfile(profile, body.makeDefault === true));
    return true;
  }
  if (method === "POST" && url.pathname === "/settings/chat-models/query") {
    if (!jsonBody(req)) {
      sendJson(res, 415, { error: "请使用 JSON 请求。" });
      return true;
    }
    const connection = ChatConnectionSchema.parse(await readJson(req));
    connection.apiKey = settings.chatKey(connection);
    sendJson(res, 200, { models: await queryChatModels(connection) });
    return true;
  }
  if (method === "GET" && url.pathname === "/settings") {
    sendJson(res, 200, settings.publicView(version));
    return true;
  }
  if (method === "PUT" && url.pathname === "/settings/model") {
    const patch = ModelSettingsPatchSchema.parse(await readJson(req));
    const view = settings.patchModel(patch);
    Object.assign(process.env, settings.workerEnv());
    sendJson(res, 200, view);
    return true;
  }
  if (method === "PUT" && url.pathname === "/settings/update") {
    const patch = UpdateSettingsPatchSchema.parse(await readJson(req));
    sendJson(res, 200, settings.patchUpdate(patch));
    return true;
  }
  if (method === "PUT" && url.pathname === "/settings/knowledge-embedding") {
    const patch = KnowledgeEmbeddingPatchSchema.parse(await readJson(req));
    const view = settings.patchKnowledgeEmbedding(patch);
    knowledge.refreshEmbeddingConfig();
    sendJson(res, 200, view);
    return true;
  }
  if (method === "POST" && url.pathname === "/settings/knowledge-embedding/test") {
    const input = KnowledgeEmbeddingTestSchema.parse(await readJson(req));
    const draft = settings.knowledgeEmbeddingForTest(input);
    sendJson(res, 200, await testEmbeddingConnection(resolveEmbeddingRuntime(draft, input.provider)));
    return true;
  }
  if (method === "POST" && url.pathname === "/settings/model/test") {
    const env = settings.workerEnv();
    const base = (env.OPENAI_BASE_URL || "https://api.openai.com/v1").replace(/\/$/, "");
    if (!env.OPENAI_API_KEY) {
      sendJson(res, 400, { ok: false, error: "未配置 API Key" });
      return true;
    }
    const testRes = await fetch(`${base}/models`, {
      headers: {
        authorization: `Bearer ${env.OPENAI_API_KEY}`,
        "user-agent": "GongYuAI/0.1",
      },
    });
    const text = await testRes.text();
    if (!testRes.ok) {
      sendJson(res, 200, {
        ok: false,
        status: testRes.status,
        error: text.slice(0, 500),
        visionEnabled: settings.get().model.visionEnabled,
      });
      return true;
    }
    sendJson(res, 200, {
      ok: true,
      status: testRes.status,
      modelId: env.GY_MODEL,
      baseUrl: base,
      visionEnabled: settings.get().model.visionEnabled,
    });
    return true;
  }
  if (method === "GET" && url.pathname === "/settings/usage") {
    const tasks = store.list();
    let tokens = 0;
    let toolCalls = 0;
    let installs = 0;
    const byTask = tasks.map((t) => {
      const before = t.usage;
      const usage = refreshTaskUsage(t);
      if (
        usage.tokens !== before.tokens ||
        usage.toolCalls !== before.toolCalls ||
        usage.installs !== before.installs
      ) {
        store.save(t);
      }
      tokens += usage.tokens;
      toolCalls += usage.toolCalls;
      installs += usage.installs;
      return {
        id: t.id,
        name: t.name,
        status: t.status,
        tokens: usage.tokens,
        toolCalls: usage.toolCalls,
        installs: usage.installs,
        updatedAt: t.updatedAt,
      };
    });
    byTask.sort((a, b) => b.tokens - a.tokens || b.toolCalls - a.toolCalls);
    sendJson(res, 200, {
      totals: { tokens, toolCalls, installs, tasks: tasks.length },
      ...(url.searchParams.get("integrations") === "1" ? { integrations: projectIntegrationUsage(tasks) } : {}),
      byTask: byTask.slice(0, 50),
    });
    return true;
  }
  if (method === "GET" && url.pathname === "/settings/update/status") {
    sendJson(res, 200, updater.getStatus());
    return true;
  }
  if (method === "POST" && url.pathname === "/settings/update/run") {
    sendJson(res, 202, updater.start());
    return true;
  }
  if (method === "POST" && url.pathname === "/settings/tools/rescan") {
    sendJson(res, 200, settings.rescanCatalog());
    return true;
  }
  if (method === "PUT" && url.pathname === "/settings/tools") {
    const patch = ToolsSettingsPatchSchema.parse(await readJson(req));
    sendJson(res, 200, settings.patchTools(patch));
    return true;
  }
  if (method === "PATCH" && url.pathname === "/settings/tools/toggle") {
    const body = ToggleToolsItemSchema.parse(await readJson(req));
    sendJson(res, 200, settings.toggleToolsItem(body));
    return true;
  }
  if (method === "POST" && url.pathname === "/settings/tools/mcp") {
    const body = AddUserMcpSchema.parse(await readJson(req));
    sendJson(res, 201, settings.addUserMcp(body));
    return true;
  }
  const mcpDelete = url.pathname.match(/^\/settings\/tools\/mcp\/([^/]+)$/);
  if (method === "DELETE" && mcpDelete) {
    sendJson(res, 200, settings.removeUserMcp(decodeURIComponent(mcpDelete[1]!)));
    return true;
  }
  if (method === "POST" && url.pathname === "/settings/tools/skills/import") {
    const body = ImportSkillSchema.parse(await readJson(req));
    sendJson(res, 201, settings.importSkill(body));
    return true;
  }
  const skillDelete = url.pathname.match(/^\/settings\/tools\/skills\/([^/]+)$/);
  if (method === "DELETE" && skillDelete) {
    sendJson(res, 200, settings.removeUserSkill(decodeURIComponent(skillDelete[1]!)));
    return true;
  }
  if (method === "PUT" && url.pathname === "/settings/asset-collectors") {
    const body = AssetCollectorPatchSchema.parse(await readJson(req));
    sendJson(res, 200, settings.patchAssetCollector(body));
    return true;
  }
  if (method === "POST" && url.pathname === "/settings/asset-collectors") {
    const body = AddAssetCollectorSchema.parse(await readJson(req));
    sendJson(res, 201, settings.addAssetCollector(body));
    return true;
  }
  if (method === "PATCH" && url.pathname === "/settings/asset-collectors/toggle") {
    const body = (await readJson(req)) as { id?: string; enabled?: boolean };
    if (!body.id || typeof body.enabled !== "boolean") {
      sendJson(res, 400, { error: "需要 id 与 enabled" });
      return true;
    }
    sendJson(res, 200, settings.toggleAssetCollector(body.id, body.enabled));
    return true;
  }
  const collectorDelete = url.pathname.match(/^\/settings\/asset-collectors\/([^/]+)$/);
  if (method === "DELETE" && collectorDelete) {
    sendJson(res, 200, settings.removeAssetCollector(decodeURIComponent(collectorDelete[1]!)));
    return true;
  }
  return false;
}

import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { WorkerManifest } from "@gongyuai/contracts";
import { openHistory } from "@gongyuai/history";
import { CheckpointStore, type CheckpointState } from "./checkpoint.js";
import {
  appendProgress,
  installTool,
  runShell,
  writeEvidence,
  type ToolContext,
} from "./tools.js";
import { writeWorkerStatus } from "./status.js";
import { isMcpToolName, openMcpHub, type McpHub } from "./mcp/client.js";
import { openSkillHub, type SkillHub } from "./skills/runtime.js";

/**
 * Pi Durable-backed worker. Falls back to OpenAI tool loop if durable harness
 * cannot start (missing key / experimental API drift).
 */
export async function runPiLoop(manifest: WorkerManifest): Promise<void> {
  const history = openHistory({
    dbPath: manifest.historyDb,
    evidenceDir: manifest.evidenceDir,
  });
  const ckpt = new CheckpointStore(`${manifest.durableDb}.ckpt.sqlite`);
  let state = ckpt.load();
  const ctx: ToolContext = {
    manifest,
    history,
    usage: { toolCalls: state.toolCalls, installs: state.installs },
  };

  writeWorkerStatus(manifest.dataDir, {
    status: "running",
    usage: { tokens: state.tokens, toolCalls: ctx.usage.toolCalls, installs: ctx.usage.installs },
  });

  try {
    mkdirSync(manifest.workspaceDir, { recursive: true });
    if (state.phase === "init") {
      writeFileSync(
        join(manifest.workspaceDir, "PROGRESS.md"),
        `# 执行进度\n\n任务 ${manifest.taskId} 初始化\n`,
      );
      history.seedGoals(manifest.taskId, manifest.goals);
      history.appendFact({
        taskId: manifest.taskId,
        layer: "title",
        title: "执行节点已启动",
        summary: `目标范围：${manifest.auth.targets.join("、") || "—"}`,
      });
      appendProgress(manifest.workspaceDir, "初始化完成");
      state.phase = "loop";
      ckpt.save(state);
    }

    const mcpHub = await openMcpHub(manifest, ctx);
    const skillHub = openSkillHub(manifest, history);
    try {
      const started = await tryPiDurable(manifest, ctx, state, ckpt, mcpHub, skillHub);
      if (!started) {
        await runOpenAiToolLoop(manifest, ctx, state, ckpt, mcpHub, skillHub);
      }
    } finally {
      await mcpHub.close();
    }

    const report = `# GongYuAI Report\n\n${history.overview(manifest.taskId)}\n`;
    writeFileSync(join(manifest.dataDir, "report.md"), report);
    history.recordReport(manifest.taskId, "report.md");
    state.phase = "done";
    ckpt.save(state);

    const allPass = history.allGoalsPass(manifest.taskId);
    writeWorkerStatus(manifest.dataDir, {
      // Never report "completed" while goals still FAIL (e.g. hard round-cap exit).
      status: allPass ? "completed" : "budget_exhausted",
      usage: {
        tokens: state.tokens,
        toolCalls: ctx.usage.toolCalls,
        installs: ctx.usage.installs,
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    state.lastError = message;
    ckpt.save(state);
    writeWorkerStatus(manifest.dataDir, {
      status: "failed",
      error: message,
      usage: {
        tokens: state.tokens,
        toolCalls: ctx.usage.toolCalls,
        installs: ctx.usage.installs,
      },
    });
    throw err;
  } finally {
    ckpt.close();
    history.close();
  }
}

/** Resolve provider/model/baseUrl for Pi Durable from GongYu settings. */
export function resolvePiModelRef(manifest: WorkerManifest): {
  provider: string;
  modelId: string;
  baseUrl: string;
  apiKeyEnv: string;
  visionEnabled: boolean;
  visionModelId: string;
} {
  const modelId = manifest.model?.modelId ?? process.env.GY_MODEL ?? "gpt-4.1-mini";
  const baseUrl = (
    manifest.model?.baseUrl ??
    process.env.OPENAI_BASE_URL ??
    "https://api.openai.com/v1"
  ).replace(/\/$/, "");
  const apiKeyEnv = manifest.model?.apiKeyEnv ?? "OPENAI_API_KEY";
  const visionEnabled = manifest.model?.visionEnabled !== false;
  const visionModelId = manifest.model?.visionModelId || modelId;

  let provider = (manifest.model?.provider || "openai").trim().toLowerCase() || "openai";
  // Settings UI is OpenAI-compatible: users often leave provider=openai while pointing
  // baseUrl at DeepSeek / proxies. Map those so Pi's catalog lookup + compat detect work.
  if (provider === "openai" || provider === "openai-compatible" || provider === "compat") {
    const host = baseUrl.toLowerCase();
    if (host.includes("deepseek.com")) provider = "deepseek";
    else if (host.includes("openrouter.ai")) provider = "openrouter";
    else if (!host.includes("api.openai.com")) provider = "openai-compatible";
  }

  return { provider, modelId, baseUrl, apiKeyEnv, visionEnabled, visionModelId };
}

async function buildConfiguredModels(manifest: WorkerManifest) {
  const { createModels, createProvider } = await import("@earendil-works/pi-ai/models");
  const { openAICompletionsApi } = await import(
    "@earendil-works/pi-ai/api/openai-completions.lazy"
  );
  const ref = resolvePiModelRef(manifest);
  const chatModel = {
    id: ref.modelId,
    name: ref.modelId,
    api: "openai-completions" as const,
    provider: ref.provider,
    baseUrl: ref.baseUrl,
    reasoning: false,
    input: (ref.visionEnabled ? ["text", "image"] : ["text"]) as ("text" | "image")[],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000,
    maxTokens: 16_384,
  };
  const modelsList = [chatModel];
  if (ref.visionModelId !== ref.modelId) {
    modelsList.push({
      ...chatModel,
      id: ref.visionModelId,
      name: ref.visionModelId,
      input: ["text", "image"],
    });
  }

  const models = createModels();
  models.setProvider(
    createProvider({
      id: ref.provider,
      name: ref.provider,
      baseUrl: ref.baseUrl,
      auth: {
        apiKey: {
          name: "API key",
          resolve: async () => {
            const key = process.env[ref.apiKeyEnv];
            if (!key) return undefined;
            return { auth: { apiKey: key }, source: ref.apiKeyEnv };
          },
        },
      },
      models: modelsList,
      api: openAICompletionsApi(),
    }),
  );
  return { models, ref };
}

async function tryPiDurable(
  manifest: WorkerManifest,
  ctx: ToolContext,
  state: CheckpointState,
  ckpt: CheckpointStore,
  mcpHub: McpHub,
  skillHub: SkillHub,
): Promise<boolean> {
  try {
    const { BACKGROUND_CONTEXT } = await import("@earendil-works/chord/context");
    const durable = await import("@earendil-works/pi-durable");
    const { openNodeSqliteStorage } = await import(
      "@earendil-works/pi-durable/storage/sqlite/node"
    );
    const schema = await import("@earendil-works/pi-schema");

    const { models, ref } = await buildConfiguredModels(manifest);
    const apiKey = process.env[ref.apiKeyEnv];
    if (!apiKey) return false;
    if (!models.getModel(ref.provider, ref.modelId)) {
      appendProgress(
        manifest.workspaceDir,
        `Pi Durable 模型未注册（${ref.provider}/${ref.modelId}），改用 OpenAI 工具循环`,
      );
      return false;
    }

    const context = BACKGROUND_CONTEXT;

    const { defineTool, defineExtension, createRegistry, Harness, AssistantEntry, section } =
      durable as typeof durable & {
        section: (...args: unknown[]) => unknown;
      };
    const { obj, str } = schema as { obj: (x: unknown) => unknown; str: () => unknown };

    const shell = defineTool({
      name: "shell",
      description: "Run a bash command inside the authorized workspace",
      parameters: obj({ command: str() }),
      replay: "none",
      execute: async (args: { command: string }) => {
        const r = runShell(ctx, args.command);
        state.toolCalls = ctx.usage.toolCalls;
        ckpt.save(state);
        return {
          output: [
            {
              type: "text",
              text: `exit=${r.exitCode}\nstdout:\n${r.stdout.slice(0, 8000)}\nstderr:\n${r.stderr.slice(0, 4000)}`,
            },
          ],
        };
      },
    } as never);

    const history_overview = defineTool({
      name: "history_overview",
      description: "Read layered History overview",
      parameters: obj({}),
      replay: "safe",
      execute: async () => ({
        output: [{ type: "text", text: ctx.history.overview(manifest.taskId) }],
      }),
    } as never);

    const history_append_fact = defineTool({
      name: "history_append_fact",
      description: "Append a fact to History",
      parameters: obj({
        layer: str(),
        title: str(),
        summary: str(),
        evidencePath: str(),
      }),
      replay: "safe",
      execute: async (args: {
        layer: string;
        title: string;
        summary: string;
        evidencePath: string;
      }) => {
        const fact = ctx.history.appendFact({
          taskId: manifest.taskId,
          layer: args.layer as "title" | "summary" | "evidence",
          title: args.title,
          summary: args.summary,
          evidencePath: args.evidencePath || null,
        });
        return { output: [{ type: "text", text: JSON.stringify(fact) }] };
      },
    } as never);

    const write_evidence = defineTool({
      name: "write_evidence",
      description: "Write an evidence file under evidence/",
      parameters: obj({ relativePath: str(), content: str() }),
      replay: "safe",
      execute: async (args: { relativePath: string; content: string }) => {
        const path = writeEvidence(ctx, args.relativePath, args.content);
        return { output: [{ type: "text", text: path }] };
      },
    } as never);

    const install_tool = defineTool({
      name: "install_tool",
      description: "Install a missing pentest tool",
      parameters: obj({ name: str(), package: str() }),
      replay: "none",
      execute: async (args: { name: string; package: string }) => {
        const r = installTool(ctx, {
          name: args.name,
          package: args.package || args.name,
        });
        state.installs = ctx.usage.installs;
        ckpt.save(state);
        return { output: [{ type: "text", text: JSON.stringify(r) }] };
      },
    } as never);

    const assert_goal = defineTool({
      name: "assert_goal",
      description: "Mark a goal passed only with evidence files",
      parameters: obj({ goalId: str(), evidencePaths: str() }),
      replay: "safe",
      execute: async (args: { goalId: string; evidencePaths: string }) => {
        const paths = args.evidencePaths
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean);
        const result = ctx.history.assertGoal(manifest.taskId, args.goalId, paths);
        return { output: [{ type: "text", text: JSON.stringify(result) }] };
      },
    } as never);

    const mcpPiTools = mcpHub.openaiTools.map((t) => {
      const fullName = t.function.name;
      return defineTool({
        name: fullName,
        description: `${t.function.description} Pass JSON object as argsJson.`,
        parameters: obj({ argsJson: str() }),
        replay: "none",
        execute: async (args: { argsJson?: string }) => {
          let parsed: Record<string, unknown> = {};
          if (args.argsJson) {
            try {
              parsed = JSON.parse(args.argsJson) as Record<string, unknown>;
            } catch {
              parsed = { raw: args.argsJson };
            }
          }
          const text = await mcpHub.call(fullName, parsed);
          state.toolCalls = ctx.usage.toolCalls;
          ckpt.save(state);
          return { output: [{ type: "text", text }] };
        },
      } as never);
    });

    const enable_mcp = defineTool({
      name: "enable_mcp",
      description: "Unlock an MCP from the catalog for this task only (progressive).",
      parameters: obj({ id: str(), reason: str() }),
      replay: "none",
      execute: async (args: { id: string; reason: string }) => {
        const text = await mcpHub.enable(args.id, args.reason || "needed");
        return { output: [{ type: "text", text }] };
      },
    } as never);
    const disable_mcp = defineTool({
      name: "disable_mcp",
      description: "Disable a previously unlocked MCP for this task.",
      parameters: obj({ id: str(), reason: str() }),
      replay: "none",
      execute: async (args: { id: string; reason: string }) => {
        const text = await mcpHub.disable(args.id, args.reason || "no longer needed");
        return { output: [{ type: "text", text }] };
      },
    } as never);
    const enable_skill = defineTool({
      name: "enable_skill",
      description: "Unlock a Skill pack for this task only.",
      parameters: obj({ id: str(), reason: str() }),
      replay: "none",
      execute: async (args: { id: string; reason: string }) => {
        const text = skillHub.enable(args.id, args.reason || "needed");
        return { output: [{ type: "text", text }] };
      },
    } as never);
    const disable_skill = defineTool({
      name: "disable_skill",
      description: "Disable a Skill pack for this task.",
      parameters: obj({ id: str(), reason: str() }),
      replay: "none",
      execute: async (args: { id: string; reason: string }) => {
        const text = skillHub.disable(args.id, args.reason || "no longer needed");
        return { output: [{ type: "text", text }] };
      },
    } as never);
    const mcp_invoke = defineTool({
      name: "mcp_invoke",
      description: "Call any enabled MCP tool by serverId + toolName (use after enable_mcp).",
      parameters: obj({ serverId: str(), toolName: str(), argsJson: str() }),
      replay: "none",
      execute: async (args: { serverId: string; toolName: string; argsJson?: string }) => {
        let parsed: Record<string, unknown> = {};
        if (args.argsJson) {
          try {
            parsed = JSON.parse(args.argsJson) as Record<string, unknown>;
          } catch {
            parsed = { raw: args.argsJson };
          }
        }
        const text = await mcpHub.invoke(args.serverId, args.toolName, parsed);
        state.toolCalls = ctx.usage.toolCalls;
        ckpt.save(state);
        return { output: [{ type: "text", text }] };
      },
    } as never);

    const registry = createRegistry();
    registry.install(
      defineExtension({
        name: "gongyuai",
        tools: [
          shell,
          history_overview,
          history_append_fact,
          write_evidence,
          install_tool,
          assert_goal,
          enable_mcp,
          disable_mcp,
          enable_skill,
          disable_skill,
          mcp_invoke,
          ...mcpPiTools,
        ],
        sections: [
          section(
            "gongyuai-system",
            () =>
              systemPrompt(
                manifest,
                ctx.history.overview(manifest.taskId),
                mcpHub,
                skillHub,
              ),
            { tag: false },
          ),
        ],
      } as never),
    );

    const storage = await openNodeSqliteStorage(manifest.durableDb);
    const harness = await Harness.open(storage, { models, registry }, context);
    const root = await harness.root(context, {
      agent: {
        model: {
          provider: ref.provider,
          modelId: ref.modelId,
        },
      },
    });
    harness.resume();
    appendProgress(
      manifest.workspaceDir,
      `Pi Durable 使用模型 ${ref.provider}/${ref.modelId}`,
    );

    const prompt = [
      "你是 GongYuAI 授权安全评估执行节点。对操作者可见的说明尽量用中文。",
      "请用工具完成所有未通过目标；未经 assert_goal 成功不得宣称通过。",
      "严格留在 auth.targets 范围内，优先小步意图。",
      "全部目标通过后回复 DONE。",
      "",
      ctx.history.overview(manifest.taskId),
    ].join("\n");

    const submission = await root.submit(
      { type: "input", content: prompt, requestId: `gy-${manifest.taskId}-main` },
      context,
    );
    const settled = await submission.wait(context);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const settledAny = settled as any;
    if (
      settledAny?.status === "unanswered" ||
      settledAny?.reason === "no_model" ||
      (typeof settledAny?.status === "string" &&
        settledAny.status !== "done" &&
        settledAny.status !== "answered")
    ) {
      await harness.close(context);
      appendProgress(
        manifest.workspaceDir,
        `Pi Durable 无可用模型（${settledAny?.reason ?? settledAny?.status}），改用 OpenAI 工具循环`,
      );
      return false;
    }
    if (settled.status === "done" && settled.type === "input") {
      await root.commit(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (tx: any) => tx.entry(AssistantEntry, settled.answer),
        context,
      );
    }

    await harness.close(context);
    state.toolCalls = ctx.usage.toolCalls;
    state.installs = ctx.usage.installs;
    ckpt.save(state);
    flushUsage(manifest, ctx, state);
    // If Pi never called tools and goals remain, prefer OpenAI-compatible loop (e.g. DeepSeek).
    if (ctx.usage.toolCalls === 0 && !ctx.history.allGoalsPass(manifest.taskId)) {
      appendProgress(
        manifest.workspaceDir,
        "Pi Durable 未调用工具，改用 OpenAI 工具循环",
      );
      return false;
    }
    return true;
  } catch (err) {
    appendProgress(
      manifest.workspaceDir,
      `Pi Durable 不可用，回退：${err instanceof Error ? err.message : String(err)}`,
    );
    return false;
  }
}

function tokenDelta(usage?: {
  total_tokens?: number;
  prompt_tokens?: number;
  completion_tokens?: number;
}): number {
  if (!usage) return 0;
  if (typeof usage.total_tokens === "number" && usage.total_tokens > 0) {
    return usage.total_tokens;
  }
  return (usage.prompt_tokens ?? 0) + (usage.completion_tokens ?? 0);
}

function flushUsage(
  manifest: WorkerManifest,
  ctx: ToolContext,
  state: CheckpointState,
): void {
  writeWorkerStatus(manifest.dataDir, {
    status: "running",
    usage: {
      tokens: state.tokens,
      toolCalls: ctx.usage.toolCalls,
      installs: ctx.usage.installs,
    },
  });
}

function systemPrompt(
  manifest: WorkerManifest,
  overview: string,
  mcpHub?: McpHub,
  skillHub?: SkillHub,
): string {
  const visionOn = manifest.model?.visionEnabled !== false;
  const visionLine = visionOn
    ? `- 视觉能力已开启。截图/界面证据优先使用 visionModelId=${manifest.model?.visionModelId || manifest.model?.modelId || "default"}。`
    : `- 视觉能力已关闭；不要依赖图像理解。`;
  const mcpBlock =
    mcpHub && mcpHub.promptLines.length
      ? `\n已启用的 MCP（可直接调用 mcp__… 或 mcp_invoke）：\n${mcpHub.promptLines.join("\n")}\n`
      : "\n当前无启用的 MCP。\n";
  const mcpCatalog = mcpHub?.catalogLines() ?? [];
  const mcpCatalogBlock = mcpCatalog.length
    ? `\n可按需解锁的 MCP（先 enable_mcp，再调用）：\n${mcpCatalog.join("\n")}\n`
    : "";
  const skillBlock = skillHub?.promptBlock() ?? "";
  const skillCatalog = skillHub?.catalogLines() ?? [];
  const skillCatalogBlock = skillCatalog.length
    ? `\n可按需解锁的 Skill（enable_skill）：\n${skillCatalog.join("\n")}\n`
    : "";
  return `你是 GongYuAI 授权安全评估执行节点（Mission Control worker）。对操作者可见的说明、事实标题与摘要尽量使用中文。
授权说明：${manifest.auth.authorizationNote}
目标允许列表：${manifest.auth.targets.join("、")}
范围外：${manifest.auth.outOfScope.join("、") || "（无）"}
预算：maxToolCalls=${manifest.budget.maxToolCalls} maxTokens=${manifest.budget.maxTokens} maxWallMs=${manifest.budget.maxWallMs}

硬规则：
- 必须使用工具，不得虚构证据。
- 完成只能靠 assert_goal（evidence gate）；口头 DONE 在目标未通过时无效。
- 禁止修改主机网络/VPN/代理/路由；靶场 VPN 须任务前已连接。
- 只探测 auth.targets（主机/URL/CIDR；即便目标含 * 也禁止主机网络改动）。
- 大输出写入 evidence，对话里只留摘要；持续更新 History。
- 缺少二进制时用 install_tool。
- 工具面采用按需解锁：常开核以外用 enable_mcp / enable_skill（写清 reason）；不需要时 disable_*。
- 未 enable 的 MCP 不可调用。
${visionLine}
${mcpBlock}${mcpCatalogBlock}${skillBlock}${skillCatalogBlock}
当前 History：
${overview}
`;
}

type ChatMessage = {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  tool_call_id?: string;
  tool_calls?: unknown[];
};

/** Keep system prompt + recent turns so long runs do not explode context. */
function trimMessages(messages: ChatMessage[], maxMessages = 48): void {
  if (messages.length <= maxMessages) return;
  const system = messages[0]?.role === "system" ? [messages[0]!] : [];
  const rest = messages.slice(system.length);
  const kept = rest.slice(-(maxMessages - system.length));
  // Drop orphan tool results without a preceding assistant tool_calls turn.
  while (kept.length && kept[0]!.role === "tool") kept.shift();
  messages.splice(0, messages.length, ...system, ...kept);
}

async function runOpenAiToolLoop(
  manifest: WorkerManifest,
  ctx: ToolContext,
  state: CheckpointState,
  ckpt: CheckpointStore,
  mcpHub: McpHub,
  skillHub: SkillHub,
): Promise<void> {
  const apiKey = process.env[manifest.model?.apiKeyEnv ?? "OPENAI_API_KEY"];
  if (!apiKey) {
    throw new Error("OPENAI_API_KEY missing and pi-durable did not start");
  }
  const baseUrl = (
    manifest.model?.baseUrl ??
    process.env.OPENAI_BASE_URL ??
    "https://api.openai.com/v1"
  ).replace(/\/$/, "");
  const model = manifest.model?.modelId ?? process.env.GY_MODEL ?? "gpt-4.1-mini";

  const baseTools = [
    {
      type: "function" as const,
      function: {
        name: "shell",
        description: "Run bash in workspace",
        parameters: {
          type: "object",
          properties: { command: { type: "string" } },
          required: ["command"],
        },
      },
    },
    {
      type: "function" as const,
      function: {
        name: "history_overview",
        description: "Read History overview",
        parameters: { type: "object", properties: {} },
      },
    },
    {
      type: "function" as const,
      function: {
        name: "write_evidence",
        description: "Write evidence file",
        parameters: {
          type: "object",
          properties: {
            relativePath: { type: "string" },
            content: { type: "string" },
          },
          required: ["relativePath", "content"],
        },
      },
    },
    {
      type: "function" as const,
      function: {
        name: "history_append_fact",
        description: "Append History fact",
        parameters: {
          type: "object",
          properties: {
            layer: { type: "string" },
            title: { type: "string" },
            summary: { type: "string" },
            evidencePath: { type: "string" },
          },
          required: ["layer", "title"],
        },
      },
    },
    {
      type: "function" as const,
      function: {
        name: "install_tool",
        description: "Install missing tool",
        parameters: {
          type: "object",
          properties: {
            name: { type: "string" },
            package: { type: "string" },
          },
          required: ["name"],
        },
      },
    },
    {
      type: "function" as const,
      function: {
        name: "assert_goal",
        description:
          "Evidence-gated goal pass. For board-clearance goals, ALL_COMPLETE.json must list every challenge with is_completed=true.",
        parameters: {
          type: "object",
          properties: {
            goalId: { type: "string" },
            evidencePaths: { type: "string" },
          },
          required: ["goalId", "evidencePaths"],
        },
      },
    },
    {
      type: "function" as const,
      function: {
        name: "enable_mcp",
        description: "Unlock an MCP from the catalog for this task only. Provide id + reason.",
        parameters: {
          type: "object",
          properties: {
            id: { type: "string" },
            reason: { type: "string" },
          },
          required: ["id", "reason"],
        },
      },
    },
    {
      type: "function" as const,
      function: {
        name: "disable_mcp",
        description: "Disable a task-local MCP.",
        parameters: {
          type: "object",
          properties: {
            id: { type: "string" },
            reason: { type: "string" },
          },
          required: ["id", "reason"],
        },
      },
    },
    {
      type: "function" as const,
      function: {
        name: "enable_skill",
        description: "Unlock a Skill pack for this task only.",
        parameters: {
          type: "object",
          properties: {
            id: { type: "string" },
            reason: { type: "string" },
          },
          required: ["id", "reason"],
        },
      },
    },
    {
      type: "function" as const,
      function: {
        name: "disable_skill",
        description: "Disable a task-local Skill pack.",
        parameters: {
          type: "object",
          properties: {
            id: { type: "string" },
            reason: { type: "string" },
          },
          required: ["id", "reason"],
        },
      },
    },
    {
      type: "function" as const,
      function: {
        name: "mcp_invoke",
        description: "Call enabled MCP by serverId + toolName + argsJson.",
        parameters: {
          type: "object",
          properties: {
            serverId: { type: "string" },
            toolName: { type: "string" },
            argsJson: { type: "string" },
          },
          required: ["serverId", "toolName"],
        },
      },
    },
  ];

  const liveTools = () => [...baseTools, ...mcpHub.openaiTools];

  const refreshSystem = () =>
    systemPrompt(manifest, ctx.history.overview(manifest.taskId), mcpHub, skillHub);

  const messages: ChatMessage[] = [
    {
      role: "system",
      content: refreshSystem(),
    },
    {
      role: "user",
      content:
        "请完成所有未通过目标。使用工具推进；全部通过（assert_goal 成功）后才可回复 DONE。禁止改动主机网络/VPN/代理。对外说明尽量用中文。",
    },
  ];

  appendProgress(manifest.workspaceDir, "进入模型工具循环");
  flushUsage(manifest, ctx, state);

  const loopStartedAt = Date.now();
  const maxRounds = Math.max(manifest.budget.maxToolCalls, 40);
  for (let i = 0; i < maxRounds; i++) {
    if (ctx.history.allGoalsPass(manifest.taskId)) break;
    if (ctx.usage.toolCalls >= manifest.budget.maxToolCalls) {
      appendProgress(manifest.workspaceDir, "达到 maxToolCalls，结束循环");
      break;
    }
    if (state.tokens >= manifest.budget.maxTokens) {
      appendProgress(manifest.workspaceDir, "达到 maxTokens，结束循环");
      break;
    }
    if (Date.now() - loopStartedAt >= manifest.budget.maxWallMs) {
      appendProgress(manifest.workspaceDir, "达到 maxWallMs，结束循环");
      break;
    }

    trimMessages(messages);

    let res: Response | undefined;
    let lastFetchErr: unknown;
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        res = await fetch(`${baseUrl}/chat/completions`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${apiKey}`,
            "content-type": "application/json",
            "user-agent": "GongYuAI/0.1",
          },
          body: JSON.stringify({
            model,
            messages,
            tools: liveTools(),
            tool_choice: "auto",
          }),
        });
        lastFetchErr = undefined;
        break;
      } catch (err) {
        lastFetchErr = err;
        const waitMs = 1000 * (attempt + 1);
        appendProgress(
          manifest.workspaceDir,
          `模型请求重试 ${attempt + 1}/4：${err instanceof Error ? err.message : String(err)}（等待 ${waitMs}ms）`,
        );
        await new Promise((r) => setTimeout(r, waitMs));
      }
    }
    if (!res) {
      throw new Error(
        `模型请求失败（已重试）：${lastFetchErr instanceof Error ? lastFetchErr.message : String(lastFetchErr)}`,
      );
    }
    if (!res.ok) {
      throw new Error(`模型接口错误 ${res.status}: ${await res.text()}`);
    }
    const data = (await res.json()) as {
      usage?: {
        total_tokens?: number;
        prompt_tokens?: number;
        completion_tokens?: number;
      };
      choices: Array<{
        message: {
          role: string;
          content?: string;
          tool_calls?: Array<{
            id: string;
            function: { name: string; arguments: string };
          }>;
        };
      }>;
    };
    state.tokens += tokenDelta(data.usage);
    const msg = data.choices[0]?.message;
    if (!msg) throw new Error("模型返回为空");

    messages.push({
      role: "assistant",
      content: msg.content ?? "",
      tool_calls: msg.tool_calls,
    });

    if (!msg.tool_calls?.length) {
      if ((msg.content ?? "").includes("DONE")) {
        if (ctx.history.allGoalsPass(manifest.taskId)) break;
        messages.push({
          role: "user",
          content:
            "目标仍未通过，禁止宣称 DONE。请继续用工具推进；完成语义以 evidence gate / assert_goal 为准。",
        });
        flushUsage(manifest, ctx, state);
        continue;
      }
      messages.push({
        role: "user",
        content: "请继续用工具推进未通过目标，全部通过后回复 DONE。",
      });
      flushUsage(manifest, ctx, state);
      continue;
    }

    const toolNames: string[] = [];
    for (const call of msg.tool_calls) {
      const args = JSON.parse(call.function.arguments || "{}") as Record<string, string>;
      let result = "";
      toolNames.push(call.function.name);
      try {
        switch (call.function.name) {
          case "shell": {
            const r = runShell(ctx, args.command ?? "");
            result = JSON.stringify(r);
            ctx.history.appendFact({
              taskId: manifest.taskId,
              layer: "summary",
              title: "执行命令",
              summary: `$ ${String(args.command ?? "").slice(0, 200)} → exit ${r.exitCode}`,
            });
            break;
          }
          case "history_overview":
            result = ctx.history.overview(manifest.taskId);
            break;
          case "write_evidence":
            result = writeEvidence(ctx, args.relativePath ?? "note.txt", args.content ?? "");
            ctx.history.appendFact({
              taskId: manifest.taskId,
              layer: "evidence",
              title: "写入证据",
              summary: result,
              evidencePath: result,
            });
            break;
          case "history_append_fact":
            result = JSON.stringify(
              ctx.history.appendFact({
                taskId: manifest.taskId,
                layer: (args.layer as "title" | "summary" | "evidence") ?? "summary",
                title: args.title ?? "未命名",
                summary: args.summary ?? "",
                evidencePath: args.evidencePath || null,
              }),
            );
            break;
          case "install_tool":
            result = JSON.stringify(
              installTool(ctx, { name: args.name ?? "", package: args.package }),
            );
            ctx.history.appendFact({
              taskId: manifest.taskId,
              layer: "summary",
              title: "安装工具",
              summary: args.name ?? "",
            });
            break;
          case "assert_goal":
            result = JSON.stringify(
              ctx.history.assertGoal(
                manifest.taskId,
                args.goalId ?? "",
                (args.evidencePaths ?? "")
                  .split(",")
                  .map((s) => s.trim())
                  .filter(Boolean),
              ),
            );
            ctx.history.appendFact({
              taskId: manifest.taskId,
              layer: "summary",
              title: "断言目标",
              summary: args.goalId ?? "",
            });
            break;
          case "enable_mcp":
            result = await mcpHub.enable(args.id ?? "", args.reason ?? "needed");
            messages[0] = { role: "system", content: refreshSystem() };
            break;
          case "disable_mcp":
            result = await mcpHub.disable(args.id ?? "", args.reason ?? "done");
            messages[0] = { role: "system", content: refreshSystem() };
            break;
          case "enable_skill":
            result = skillHub.enable(args.id ?? "", args.reason ?? "needed");
            messages[0] = { role: "system", content: refreshSystem() };
            break;
          case "disable_skill":
            result = skillHub.disable(args.id ?? "", args.reason ?? "done");
            messages[0] = { role: "system", content: refreshSystem() };
            break;
          case "mcp_invoke": {
            let parsed: Record<string, unknown> = {};
            if (args.argsJson) {
              try {
                parsed = JSON.parse(args.argsJson) as Record<string, unknown>;
              } catch {
                parsed = { raw: args.argsJson };
              }
            }
            result = await mcpHub.invoke(
              args.serverId ?? "",
              args.toolName ?? "",
              parsed,
            );
            break;
          }
          default:
            if (isMcpToolName(call.function.name)) {
              result = await mcpHub.call(
                call.function.name,
                args as Record<string, unknown>,
              );
              ctx.history.appendFact({
                taskId: manifest.taskId,
                layer: "summary",
                title: `MCP ${call.function.name}`,
                summary: result.slice(0, 400),
              });
            } else {
              result = `未知工具 ${call.function.name}`;
            }
        }
      } catch (err) {
        result = `错误: ${err instanceof Error ? err.message : String(err)}`;
      }
      messages.push({
        role: "tool",
        tool_call_id: call.id,
        content: result.slice(0, 4_000),
      });
    }

    state.toolCalls = ctx.usage.toolCalls;
    state.installs = ctx.usage.installs;
    state.step = i + 1;
    ckpt.save(state);
    flushUsage(manifest, ctx, state);
    writeFileSync(join(manifest.workspaceDir, "openai-transcript.json"), JSON.stringify(messages, null, 2));
    appendProgress(
      manifest.workspaceDir,
      `第 ${i + 1} 步 · 工具 ${toolNames.join("、") || "无"} · Token ${state.tokens}`,
    );
  }
}

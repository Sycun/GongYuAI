import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  isBudgetHit,
  isExploreLeader,
  isWallHit,
  type WorkerManifest,
} from "@gongyuai/contracts";
import { openHistory } from "@gongyuai/history";
import { CheckpointStore, type CheckpointState } from "./checkpoint.js";
import {
  appendProgress,
  assertCapabilityAllows,
  installTool,
  mcpActionForServer,
  runShell,
  writeEvidence,
  type ToolContext,
} from "./tools.js";
import { collectorsPromptBlock, runAssetSearch } from "./asset-collectors.js";
import { boardClearPolicyBlock } from "./board-policy.js";
import { takeSoftPaceAdvice } from "./soft-pace.js";
import { writeWorkerStatus } from "./status.js";
import { writeTerminalReport } from "./report.js";
import { isMcpToolName, openMcpHub, type McpHub } from "./mcp/client.js";
import { openSkillHub, type SkillHub } from "./skills/runtime.js";
import {
  canRelay,
  formatRelayInjection,
  listRelayProtocols,
  writeRelayProtocol,
} from "./relay.js";
import {
  GRAPH_PHASE_TOOLS,
  allowedToolNames,
  asGraphPhase,
  filterOpenAiTools,
  handleGraphTool,
  kickoffUserMessage,
  phaseDirective,
  syncGraphPhase,
} from "./graph-phase.js";

/**
 * Pi Durable-backed worker. Falls back to OpenAI tool loop if durable harness
 * cannot start (missing key / experimental API drift).
 */
async function waitForLeaderBootstrap(
  history: ReturnType<typeof openHistory>,
  taskId: string,
  timeoutMs = 120_000,
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const facts = history.listFacts(taskId);
    const open = history.openIntents(taskId);
    if (facts.length > 0 || open.length > 0 || history.allGoalsPass(taskId)) {
      return;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
}

export async function runPiLoop(manifest: WorkerManifest): Promise<void> {
  const workerStartedAt = Date.now();
  const history = openHistory({
    dbPath: manifest.historyDb,
    evidenceDir: manifest.evidenceDir,
  });
  const ckpt = new CheckpointStore(`${manifest.durableDb}.ckpt.sqlite`);
  let state = ckpt.load();
  // Wall clock restarts with this process; soft wall milestones must too.
  if (state.lastSoftWallMilestone !== 0) {
    state.lastSoftWallMilestone = 0;
    ckpt.save(state);
  }
  const ctx: ToolContext = {
    manifest,
    history,
    usage: { toolCalls: state.toolCalls, installs: state.installs },
  };
  const leader = isExploreLeader(manifest);
  const slot = manifest.workerSlot ?? 0;

  writeWorkerStatus(
    manifest.dataDir,
    {
      status: "running",
      usage: {
        tokens: state.tokens,
        toolCalls: ctx.usage.toolCalls,
        installs: ctx.usage.installs,
      },
      workerSlot: slot,
      workerId: manifest.workerId,
    },
    slot,
  );

  try {
    mkdirSync(manifest.workspaceDir, { recursive: true });
    if (leader && state.phase === "init") {
      writeFileSync(
        join(manifest.workspaceDir, "PROGRESS.md"),
        `# 执行进度\n\n任务 ${manifest.taskId} 初始化\n并发 Explore=${manifest.workerCount}\n`,
      );
      history.seedGoals(manifest.taskId, manifest.goals);
      history.seedAssetsFromAuth(manifest.taskId, manifest.auth);
      history.appendFact({
        taskId: manifest.taskId,
        layer: "title",
        title: "执行节点已启动",
        summary: `目标范围：${manifest.auth.targets.join("、") || "—"}；Explore 并发=${manifest.workerCount}`,
      });
      appendProgress(
        manifest.workspaceDir,
        `phase=bootstrap workers=${manifest.workerCount}`,
      );
      state.phase = "bootstrap";
      ckpt.save(state);
      // Stay in bootstrap until agent phase_set(explore) or sync sees open Intents.
    } else if (!leader && (state.phase === "init" || state.phase === "bootstrap")) {
      appendProgress(
        manifest.workspaceDir,
        `phase=explore follower slot=${slot} waiting for leader bootstrap`,
      );
      await waitForLeaderBootstrap(history, manifest.taskId);
      state.phase = "explore";
      ckpt.save(state);
    }

    // Crash recovery: expire stale claims; never auto-write π (P1.5).
    // Only leader expires — avoids N workers racing the same sweep.
    if (leader) {
      history.expireStaleIntents(manifest.taskId, 30 * 60_000);
    }
    if (listRelayProtocols(manifest.workspaceDir).length) {
      appendProgress(
        manifest.workspaceDir,
        `注入既有 Relay ×${listRelayProtocols(manifest.workspaceDir).length}`,
      );
    }

    const mcpHub = await openMcpHub(manifest, ctx);
    const skillHub = openSkillHub(manifest, history);
    try {
      const started = await tryPiDurable(
        manifest,
        ctx,
        state,
        ckpt,
        mcpHub,
        skillHub,
        workerStartedAt,
      );
      if (!started) {
        await runOpenAiToolLoop(
          manifest,
          ctx,
          state,
          ckpt,
          mcpHub,
          skillHub,
          workerStartedAt,
        );
      }
    } finally {
      await mcpHub.close();
    }

    const allPass = history.allGoalsPass(manifest.taskId);
    // Followers may finish early; only leader promotes task-level terminal.
    // budget_exhausted ONLY when a hard gate fired — not "goals still open".
    const terminalStatus = classifyTerminalStatus({
      allPass,
      leader,
      usageToolCalls: ctx.usage.toolCalls,
      tokens: state.tokens,
      budget: manifest.budget,
      workerStartedAt,
      lastError: state.lastError,
    });
    if (leader) {
      writeTerminalReport(manifest, history, {
        status:
          terminalStatus === "completed"
            ? "completed"
            : terminalStatus === "budget_exhausted"
              ? "budget_exhausted"
              : "incomplete",
        reason:
          terminalStatus === "budget_exhausted"
            ? state.lastError ?? "hard budget gate"
            : terminalStatus === "incomplete"
              ? "loop exited before all goals passed (not a budget gate)"
              : undefined,
      });
    }
    state.phase = "done";
    ckpt.save(state);

    writeWorkerStatus(
      manifest.dataDir,
      {
        status: terminalStatus,
        usage: {
          tokens: state.tokens,
          toolCalls: ctx.usage.toolCalls,
          installs: ctx.usage.installs,
        },
        workerSlot: slot,
        workerId: manifest.workerId,
      },
      slot,
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    state.lastError = message;
    ckpt.save(state);
    const budgetHit = /maxWallMs|maxToolCalls|maxTokens/i.test(message);
    if (leader) {
      try {
        writeTerminalReport(manifest, history, {
          status: budgetHit ? "budget_exhausted" : "failed",
          reason: message,
        });
      } catch {
        /* report best-effort on failure path */
      }
    }
    writeWorkerStatus(
      manifest.dataDir,
      {
        status: budgetHit ? "budget_exhausted" : "failed",
        error: message,
        usage: {
          tokens: state.tokens,
          toolCalls: ctx.usage.toolCalls,
          installs: ctx.usage.installs,
        },
        workerSlot: slot,
        workerId: manifest.workerId,
      },
      slot,
    );
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
  workerStartedAt: number,
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

    const {
      defineTool,
      defineExtension,
      createRegistry,
      Harness,
      AssistantEntry,
      section,
      hook,
      ToolTask,
      GenerationTask,
    } = durable as typeof durable & {
      section: (...args: unknown[]) => unknown;
      hook: (...args: unknown[]) => unknown;
      ToolTask: unknown;
      GenerationTask: unknown;
    };
    const { obj, str } = schema as { obj: (x: unknown) => unknown; str: () => unknown };

    const graphCtx = () => ({
      history: ctx.history,
      taskId: manifest.taskId,
      workspaceDir: manifest.workspaceDir,
      state,
      workerId: manifest.workerId || `worker-${manifest.taskId.slice(0, 8)}`,
      save: () => {
        state.toolCalls = ctx.usage.toolCalls;
        state.installs = ctx.usage.installs;
        ckpt.save(state);
      },
    });

    /** Pull Pi usage into checkpoint + worker-status so console Live stays fresh. */
    const syncLiveUsage = (piUsage?: {
      models?: Record<string, { totalTokens?: number }>;
      tools?: Record<string, { totalTokens?: number }>;
    }) => {
      if (piUsage) {
        state.tokens = Math.max(state.tokens, sumPiTokens(piUsage));
      }
      state.toolCalls = Math.max(state.toolCalls, ctx.usage.toolCalls);
      state.installs = Math.max(state.installs, ctx.usage.installs);
      // Status sidecar first (CP polls this); ckpt is best-effort.
      flushUsage(manifest, ctx, state);
      try {
        ckpt.save(state);
      } catch {
        /* ignore — Live counters already flushed */
      }
    };

    const roundToolNames: string[] = [];

    const shell = defineTool({
      name: "shell",
      description: "Run a bash command inside the authorized workspace",
      parameters: obj({ command: str() }),
      replay: "none",
      execute: async (args: { command: string }) => {
        const r = runShell(ctx, args.command);
        state.toolCalls = ctx.usage.toolCalls;
        state.installs = ctx.usage.installs;
        // Flush sidecar before ckpt — status file is what CP/watchdog poll;
        // ckpt.save can throw under contention and must not skip reporting.
        flushUsage(manifest, ctx, state);
        try {
          ckpt.save(state);
        } catch {
          /* best-effort; usage already on disk */
        }
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
      description:
        "Observe History: Goals + title-layer Facts + open Intents (+ Session Relay π)",
      parameters: obj({}),
      replay: "safe",
      execute: async () => ({
        output: [
          {
            type: "text",
            text: sessionBootstrapText(
              manifest,
              ctx.history.observe(manifest.taskId),
            ),
          },
        ],
      }),
    } as never);

    const history_read_fact = defineTool({
      name: "history_read_fact",
      description:
        "Drill into one Fact by id with same-intent neighbors. recordedAt is History write time — never invent event time.",
      parameters: obj({ factId: str() }),
      replay: "safe",
      execute: async (args: { factId: string }) => {
        const drill = ctx.history.formatFactDrill(manifest.taskId, args.factId);
        return {
          output: [
            {
              type: "text",
              text: JSON.stringify(drill),
            },
          ],
        };
      },
    } as never);

    const history_list_layer = defineTool({
      name: "history_list_layer",
      description: "List Facts for one layer (summary|evidence|title) on demand",
      parameters: obj({ layer: str() }),
      replay: "safe",
      execute: async (args: { layer: string }) => {
        const layer = args.layer as "title" | "summary" | "evidence";
        if (!["title", "summary", "evidence"].includes(layer)) {
          return {
            output: [{ type: "text", text: `invalid layer: ${args.layer}` }],
          };
        }
        const facts = ctx.history.listFacts(manifest.taskId, layer).slice(-30);
        return { output: [{ type: "text", text: JSON.stringify(facts) }] };
      },
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

    const asset_list = defineTool({
      name: "asset_list",
      description:
        "List the bidirectional asset inventory (seed + discovered). Same rows as console 资产表.",
      parameters: obj({}),
      replay: "safe",
      execute: async () => {
        const assets = ctx.history.listAssets(manifest.taskId);
        return { output: [{ type: "text", text: JSON.stringify(assets) }] };
      },
    } as never);

    const asset_record = defineTool({
      name: "asset_record",
      description:
        "Record a discovered host/URL into the asset inventory. Auto-admits against auth.targets (CIDR / *.domain / suffix); out-of-scope → oos. Set live=true after probe confirms up.",
      parameters: obj({
        address: str(),
        summary: str(),
        live: str(),
      }),
      replay: "safe",
      execute: async (args: { address: string; summary?: string; live?: string }) => {
        const live =
          args.live === "true" || args.live === "1" || args.live === "yes";
        const r = ctx.history.recordAsset({
          taskId: manifest.taskId,
          address: args.address,
          auth: manifest.auth,
          summary: args.summary,
          live,
          source: "discover",
          intentId: state.activeIntentId,
        });
        return { output: [{ type: "text", text: JSON.stringify(r) }] };
      },
    } as never);

    const asset_search = defineTool({
      name: "asset_search",
      description:
        "Query an enabled asset collector (FOFA / 鹰图 Hunter / custom). Hits are auto-recorded into the asset inventory (admit/oos). Prefer this over browser scraping when configured.",
      parameters: obj({
        collectorId: str(),
        query: str(),
        size: str(),
      }),
      replay: "none",
      execute: async (args: { collectorId: string; query: string; size?: string }) => {
        const size = args.size ? Number(args.size) : 50;
        const r = await runAssetSearch(ctx, {
          collectorId: args.collectorId,
          query: args.query,
          size: Number.isFinite(size) ? size : 50,
          intentId: state.activeIntentId,
        });
        state.toolCalls = ctx.usage.toolCalls;
        ckpt.save(state);
        return { output: [{ type: "text", text: JSON.stringify(r) }] };
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
    const load_skill = defineTool({
      name: "load_skill",
      description:
        "Load full SKILL.md for one skill id from the routing table (on-demand; do not load all).",
      parameters: obj({ id: str(), reason: str() }),
      replay: "none",
      execute: async (args: { id: string; reason: string }) => {
        const text = skillHub.load(args.id, args.reason || "needed for current phase");
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

    const graphPiTools = GRAPH_PHASE_TOOLS.map((t) => {
      const name = t.function.name;
      const props = (t.function.parameters as { properties?: Record<string, unknown> })
        .properties;
      const params: Record<string, unknown> = {};
      for (const key of Object.keys(props ?? {})) {
        params[key] = str();
      }
      return defineTool({
        name,
        description: t.function.description,
        parameters: obj(params),
        replay: "safe",
        execute: async (args: Record<string, string>) => {
          const text =
            handleGraphTool(name, args, graphCtx()) ?? `未知图工具 ${name}`;
          return { output: [{ type: "text", text }] };
        },
      } as never);
    });

    const registry = createRegistry();
    registry.install(
      defineExtension({
        name: "gongyuai",
        tools: [
          shell,
          history_overview,
          history_read_fact,
          history_list_layer,
          history_append_fact,
          asset_list,
          asset_record,
          asset_search,
          write_evidence,
          install_tool,
          assert_goal,
          enable_mcp,
          disable_mcp,
          load_skill,
          mcp_invoke,
          ...graphPiTools,
          ...mcpPiTools,
        ],
        hooks: [
          hook(ToolTask, {
            beforeTool: (call: { name: string; parent?: unknown }) => {
              if (call.parent) return undefined;
              state.phase = syncGraphPhase(ctx.history, manifest.taskId, state.phase);
              const mcpNames = mcpHub.openaiTools.map((t) => t.function.name);
              const allowed = allowedToolNames(state.phase, mcpNames);
              if (allowed.has(call.name)) return undefined;
              if (isMcpToolName(call.name)) {
                const p = asGraphPhase(state.phase);
                if (p === "explore" || p === "relay") return undefined;
                return {
                  block: `denied: MCP ${call.name} requires explore phase (have ${state.phase})`,
                };
              }
              return {
                block: `denied: tool ${call.name} not allowed in phase=${asGraphPhase(state.phase)}`,
              };
            },
            afterTool: (call: { name: string; parent?: unknown }) => {
              if (!call.parent) roundToolNames.push(call.name);
              return undefined;
            },
          }),
          hook(GenerationTask, {
            afterResponse: async (
              _msg: unknown,
              api: { usage: (c: unknown) => Promise<unknown> },
              hookCtx: unknown,
            ) => {
              try {
                const usage = (await api.usage(hookCtx)) as {
                  models?: Record<string, { totalTokens?: number }>;
                  tools?: Record<string, { totalTokens?: number }>;
                };
                syncLiveUsage(usage);
              } catch {
                syncLiveUsage();
              }
            },
            afterTools: async (
              _assistant: unknown,
              _results: unknown,
              api: { usage: (c: unknown) => Promise<unknown> },
              hookCtx: unknown,
            ) => {
              const names = roundToolNames.splice(0, roundToolNames.length);
              try {
                const usage = (await api.usage(hookCtx)) as {
                  models?: Record<string, { totalTokens?: number }>;
                  tools?: Record<string, { totalTokens?: number }>;
                };
                syncLiveUsage(usage);
              } catch {
                syncLiveUsage();
              }
              state.step += 1;
              ckpt.save(state);
              appendProgress(
                manifest.workspaceDir,
                `第 ${state.step} 步 · 工具 ${names.join("、") || "无"} · Token ${state.tokens} · phase=${state.phase}`,
              );
              return undefined;
            },
          }),
        ],
        sections: [
          section(
            "gongyuai-system",
            () => {
              state.phase = syncGraphPhase(ctx.history, manifest.taskId, state.phase);
              const open = ctx.history.openIntents(manifest.taskId);
              const phaseBlock = phaseDirective(state.phase, {
                openIntentCount: open.length,
                activeIntentId: state.activeIntentId,
              });
              return systemPrompt(
                manifest,
                `${phaseBlock}\n\n${sessionBootstrapText(
                  manifest,
                  ctx.history.observe(manifest.taskId),
                )}`,
                mcpHub,
                skillHub,
              );
            },
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
    flushUsage(manifest, ctx, state);

    const kickoff = [
      "你是 GongYuAI 授权安全评估执行节点。对操作者可见的说明尽量用中文。",
      "这是长程任务（可连续跑数日）。请用工具完成所有未通过目标；未经 assert_goal 成功不得宣称通过。",
      "禁止因预算/剩余时间估计提前收口或写最终汇报；目标未全过就继续。",
      "严格留在 auth.targets 范围内，优先小步意图。",
      "图调度：Bootstrap → Explore → Reason（phase_set / intent_*）；工具面按相位过滤。",
      "全部目标通过后回复 DONE。",
      "",
      kickoffUserMessage(state.phase),
      "",
      sessionBootstrapText(manifest, ctx.history.observe(manifest.taskId)),
    ].join("\n");

    // Heartbeat: Pi wait can run for days; keep Live token/toolCounters moving.
    const heartbeat = setInterval(() => {
      void (async () => {
        try {
          const usage = (await harness.usage(context)) as {
            models?: Record<string, { totalTokens?: number }>;
            tools?: Record<string, { totalTokens?: number }>;
          };
          syncLiveUsage(usage);
        } catch {
          syncLiveUsage();
        }
      })();
    }, 5_000);

    try {
      let round = 0;
      for (;;) {
        round += 1;
        const softPace = maybeSoftPaceMessage(state, ctx, workerStartedAt);
        if (softPace) ckpt.save(state);
        const content =
          round === 1
            ? softPace
              ? `${kickoff}\n\n${softPace}`
              : kickoff
            : [
                `长程续跑 #${round}：目标仍未全部通过。禁止收口/最终汇报。`,
                "请继续用工具推进；完成语义以 assert_goal / evidence gate 为准。",
                softPace ?? "",
                "",
                sessionBootstrapText(
                  manifest,
                  ctx.history.observe(manifest.taskId),
                ),
              ]
                .filter((line) => line !== "")
                .join("\n");

        const submission = await root.submit(
          {
            type: "input",
            content,
            requestId: `gy-${manifest.taskId}-r${round}`,
          },
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

        state.toolCalls = ctx.usage.toolCalls;
        state.installs = ctx.usage.installs;
        flushUsage(manifest, ctx, state);
        try {
          ckpt.save(state);
        } catch {
          /* best-effort */
        }

        if (round === 1 && ctx.usage.toolCalls === 0 && !ctx.history.allGoalsPass(manifest.taskId)) {
          appendProgress(
            manifest.workspaceDir,
            "Pi Durable 未调用工具，改用 OpenAI 工具循环",
          );
          return false;
        }
        if (ctx.history.allGoalsPass(manifest.taskId)) {
          appendProgress(manifest.workspaceDir, "全部目标已通过，结束 Pi 循环");
          break;
        }
        if (isBudgetHit(ctx.usage.toolCalls, manifest.budget.maxToolCalls)) {
          state.lastError = "maxToolCalls exceeded";
          appendProgress(manifest.workspaceDir, "达到 maxToolCalls，结束循环");
          break;
        }
        if (isBudgetHit(state.tokens, manifest.budget.maxTokens)) {
          state.lastError = "maxTokens exceeded";
          appendProgress(manifest.workspaceDir, "达到 maxTokens，结束循环");
          break;
        }
        if (isWallHit(workerStartedAt, manifest.budget.maxWallMs)) {
          state.lastError = "maxWallMs exceeded";
          appendProgress(manifest.workspaceDir, "达到 maxWallMs，结束循环");
          break;
        }
        appendProgress(
          manifest.workspaceDir,
          `Pi 会话结束但目标未清 → 续跑 #${round + 1}`,
        );
      }
    } finally {
      clearInterval(heartbeat);
      await harness.close(context);
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

/** Sum totalTokens across Pi Durable conversation usage buckets. */
function sumPiTokens(usage: {
  models?: Record<string, { totalTokens?: number }>;
  tools?: Record<string, { totalTokens?: number }>;
}): number {
  let n = 0;
  for (const u of Object.values(usage.models ?? {})) {
    n += u.totalTokens ?? 0;
  }
  for (const u of Object.values(usage.tools ?? {})) {
    n += u.totalTokens ?? 0;
  }
  return n;
}

function classifyTerminalStatus(opts: {
  allPass: boolean;
  leader: boolean;
  usageToolCalls: number;
  tokens: number;
  budget: WorkerManifest["budget"];
  workerStartedAt: number;
  lastError: string | null;
}): "completed" | "budget_exhausted" | "incomplete" {
  if (opts.allPass) return "completed";
  // Followers finishing early are not a board-level failure.
  if (!opts.leader) return "completed";
  const hitGate =
    isBudgetHit(opts.usageToolCalls, opts.budget.maxToolCalls) ||
    isBudgetHit(opts.tokens, opts.budget.maxTokens) ||
    isWallHit(opts.workerStartedAt, opts.budget.maxWallMs) ||
    (opts.lastError != null &&
      /maxWallMs|maxToolCalls|maxTokens|maxInstalls/i.test(opts.lastError));
  return hitGate ? "budget_exhausted" : "incomplete";
}

function formatBudgetLine(manifest: WorkerManifest): string {
  const b = manifest.budget;
  const fmt = (n: number, unit: string) =>
    n > 0 ? `${n}${unit}` : "不限";
  return `无硬性倒计时（默认不限）。当前硬闸 tools=${fmt(b.maxToolCalls, "")} tokens=${fmt(b.maxTokens, "")} wall=${fmt(b.maxWallMs, "ms")} installs=${fmt(b.maxInstalls, "")}。另有软节奏提示（工具次数/墙钟里程碑），只是提醒换题或续跑，绝不是预算耗尽、绝不是停工令；未设硬闸则一直跑到目标全过或操作者停止。`;
}

/** Soft milestone nudge — updates checkpoint markers; never stops the run. */
function maybeSoftPaceMessage(
  state: CheckpointState,
  ctx: ToolContext,
  workerStartedAt: number,
): string | null {
  const advice = takeSoftPaceAdvice({
    toolCalls: Math.max(state.toolCalls, ctx.usage.toolCalls),
    wallMs: Date.now() - workerStartedAt,
    lastSoftToolMilestone: state.lastSoftToolMilestone,
    lastSoftWallMilestone: state.lastSoftWallMilestone,
  });
  if (!advice) return null;
  state.lastSoftToolMilestone = advice.next.lastSoftToolMilestone;
  state.lastSoftWallMilestone = advice.next.lastSoftWallMilestone;
  appendProgress(
    ctx.manifest.workspaceDir,
    `软节奏提示（非停工） tools=${ctx.usage.toolCalls} wallMs=${Date.now() - workerStartedAt}`,
  );
  return advice.message;
}

function flushUsage(
  manifest: WorkerManifest,
  ctx: ToolContext,
  state: CheckpointState,
): void {
  const slot = manifest.workerSlot ?? 0;
  // Prefer the higher of durable checkpoint vs in-memory counters — Pi hooks
  // and shell execute can briefly disagree; never report a regressing 0.
  const toolCalls = Math.max(state.toolCalls, ctx.usage.toolCalls);
  const installs = Math.max(state.installs, ctx.usage.installs);
  state.toolCalls = toolCalls;
  state.installs = installs;
  ctx.usage.toolCalls = toolCalls;
  ctx.usage.installs = installs;
  writeWorkerStatus(
    manifest.dataDir,
    {
      status: "running",
      usage: {
        tokens: state.tokens,
        toolCalls,
        installs,
      },
      workerSlot: slot,
      workerId: manifest.workerId,
    },
    slot,
  );
}

function systemPrompt(
  manifest: WorkerManifest,
  observeText: string,
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
  const skillRoutes = skillHub?.routingTable() ?? [];
  const skillHints = skillHub?.suggestForGoals() ?? [];
  const skillRouteBlock = skillRoutes.length
    ? `\nSkill 路由表（仅目录；正文用 load_skill(id)，单次任务勿连续加载超过 2～3 个）：\n${skillRoutes.join("\n")}\n`
    : "\n无可用 Skill 路由。\n";
  const skillHintBlock = skillHints.length
    ? `\n目标相关推荐 Skill（仍须 load_skill）：${skillHints.map((id) => `\`${id}\``).join("、")}\n`
    : "";
  const workerCount = manifest.workerCount ?? 1;
  const workerSlot = manifest.workerSlot ?? 0;
  const poolLine =
    workerCount > 1
      ? `- 本节点为 Explore pool slot ${workerSlot}/${workerCount}（workerId=${manifest.workerId}）。共享 History；用 intent_claim CAS 抢未占用 Intent。${workerSlot === 0 ? "你是 leader：负责 Bootstrap / Reason / Report。" : "你是 follower：跳过 Bootstrap，专注 claim 并 Explore；勿抢 Reason/Report。"}多靶标时优先推进不同靶标相关 Intent。`
      : `- 单 Explore worker（串行）。`;
  return `你是 GongYuAI 授权安全评估执行节点（Mission Control worker）。对操作者可见的说明、事实标题与摘要尽量使用中文。
授权说明：${manifest.auth.authorizationNote}
目标允许列表：${manifest.auth.targets.join("、")}
范围外：${manifest.auth.outOfScope.join("、") || "（无）"}
预算：${formatBudgetLine(manifest)}
Explore 并发：configured=${manifest.execution?.maxConcurrentExplores ?? 1} effective=${workerCount}

硬规则：
- 必须使用工具，不得虚构证据。
- 完成只能靠 assert_goal（evidence gate）；口头 DONE 在目标未通过时无效。
- **禁止**因「预算将尽 / 还剩 N 分钟 / 本轮收口」提前停工或写最终汇报；目标未全过就继续推进。
- 禁止修改主机网络/VPN/代理/路由；靶场 VPN 须任务前已连接。
- 只探测 auth.targets（主机/URL/IPv4 CIDR/\`*.domain\`/裸域；即便目标含 * 也禁止主机网络改动）。
- 资产清单双向：Observe 含「资产清单」；发现子域/IP 必须 asset_record（自动按 CIDR/通配准入或标 oos）；控制台同一投影。勿静默改 auth.targets。
- 被动资产收集：配置启用后用 asset_search(collectorId, query) 调 FOFA/鹰图/自定义 API，命中自动写入清单（勿把原始 JSON 只塞进 chat）。
- 图调度：显式 Bootstrap → Explore → Reason（phase_set / intent_*）；工具面按相位过滤。
- Hint：Observe 含人类/同族战术注入，须吸收；验证打法后用 technique_transfer 做同族迁移（勿点对点私聊）。
${poolLine}
- Observe 默认看 Goals + 资产清单 + title 层 Fact + 进行中 Intent；summary/evidence 按需下钻。
- 大输出写入 evidence；Explore 成功用 intent_conclude 写回 Fact←Intent；也可用 history_append_fact / asset_record。
- 上下文饱和或自然检查点用 relay 工具写 π（Session Relay）；冲突以 History 为准。
- 能力阶梯 auth.capability=${manifest.auth.capability ?? "observe"}（observe→scan→active-lab→full）；缺权工具会被拒绝。
- 缺少二进制时用 install_tool（需 ≥scan）。
- MCP：常开核以外用 enable_mcp 再调用；未 enable 的 MCP 不可调用。
- Skill：系统只给路由表。需要方法论时 load_skill(id)；按阶段加载，不要一次灌入全部正文。
- TSecBench：默认禁止批量 hint；平台 409 already finished 视为终态，停止重试并写 blocked 证据。
${visionLine}
${boardClearPolicyBlock(manifest)}${collectorsPromptBlock(manifest)}${mcpBlock}${mcpCatalogBlock}${skillRouteBlock}${skillHintBlock}
当前 Observe（History）：
${observeText}
`;
}

function sessionBootstrapText(manifest: WorkerManifest, historyObserve: string): string {
  const relays = formatRelayInjection(listRelayProtocols(manifest.workspaceDir));
  return `${historyObserve}\n\n${relays}`;
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
  workerStartedAt: number,
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
    ...GRAPH_PHASE_TOOLS,
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
        description:
          "Observe History: Goals + title Facts + open Intents (no summary/evidence body)",
        parameters: { type: "object", properties: {} },
      },
    },
    {
      type: "function" as const,
      function: {
        name: "history_read_fact",
        description:
          "Drill into one Fact by id with same-intent neighbors. recordedAt is History write time — do not invent event time.",
        parameters: {
          type: "object",
          properties: { factId: { type: "string" } },
          required: ["factId"],
        },
      },
    },
    {
      type: "function" as const,
      function: {
        name: "history_list_layer",
        description: "List Facts for one layer (summary|evidence|title) on demand",
        parameters: {
          type: "object",
          properties: { layer: { type: "string" } },
          required: ["layer"],
        },
      },
    },
    {
      type: "function" as const,
      function: {
        name: "relay",
        description:
          "Session Relay: write π handoff (foothold/unexplored/…) and clear chat buffer. Use at natural checkpoints or when context is noisy.",
        parameters: {
          type: "object",
          properties: {
            reason: { type: "string" },
            current_position: { type: "string" },
            network_map: { type: "string" },
            tried: { type: "string" },
            active_sessions: { type: "string" },
            foothold: { type: "string" },
            unexplored_surface: { type: "string" },
          },
          required: ["reason", "foothold", "unexplored_surface"],
        },
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
        name: "asset_list",
        description: "List asset inventory (same as console 资产表)",
        parameters: { type: "object", properties: {} },
      },
    },
    {
      type: "function" as const,
      function: {
        name: "asset_record",
        description:
          "Record discovered host/URL; auto-admit via CIDR/wildcard against auth.targets. live=true after probe.",
        parameters: {
          type: "object",
          properties: {
            address: { type: "string" },
            summary: { type: "string" },
            live: { type: "string" },
          },
          required: ["address"],
        },
      },
    },
    {
      type: "function" as const,
      function: {
        name: "asset_search",
        description:
          "Query FOFA / 鹰图(Hunter) / custom collector; hits auto-recorded to asset inventory. collectorId from settings.",
        parameters: {
          type: "object",
          properties: {
            collectorId: { type: "string" },
            query: { type: "string" },
            size: { type: "string" },
          },
          required: ["collectorId", "query"],
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
        name: "load_skill",
        description:
          "Load full SKILL.md for one id from the routing table (on-demand; do not load all).",
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

  const liveTools = () => {
    state.phase = syncGraphPhase(ctx.history, manifest.taskId, state.phase);
    const mcpNames = mcpHub.openaiTools.map((t) => t.function.name);
    const allowed = allowedToolNames(state.phase, mcpNames);
    return filterOpenAiTools([...baseTools, ...mcpHub.openaiTools], allowed);
  };

  const refreshSystem = () => {
    state.phase = syncGraphPhase(ctx.history, manifest.taskId, state.phase);
    const open = ctx.history.openIntents(manifest.taskId);
    const observe = sessionBootstrapText(
      manifest,
      ctx.history.observe(manifest.taskId),
    );
    const phaseBlock = phaseDirective(state.phase, {
      openIntentCount: open.length,
      activeIntentId: state.activeIntentId,
    });
    return systemPrompt(manifest, `${phaseBlock}\n\n${observe}`, mcpHub, skillHub);
  };

  const graphCtx = () => ({
    history: ctx.history,
    taskId: manifest.taskId,
    workspaceDir: manifest.workspaceDir,
    state,
    workerId: manifest.workerId || `worker-${manifest.taskId.slice(0, 8)}`,
    save: () => {
      state.toolCalls = ctx.usage.toolCalls;
      state.installs = ctx.usage.installs;
      ckpt.save(state);
    },
  });

  /** Clear chat buffer after Session Relay; re-inject Observe + all π. */
  const resetMessagesAfterRelay = () => {
    messages.splice(0, messages.length, {
      role: "system",
      content: refreshSystem(),
    }, {
      role: "user",
      content:
        "会话已 Relay。请根据注入的 π 与 History Observe 继续未完成 Goals / open Intents；禁止改动主机网络/VPN/代理。",
    });
  };

  const performRelay = (opts: {
    triggerForceAgent: boolean;
    reason: string;
    current_position?: string;
    network_map?: string;
    tried?: string;
    active_sessions?: string;
    foothold?: string;
    unexplored_surface?: string;
  }): string => {
    const check = canRelay({
      manifest,
      tokensSinceRelay: state.tokensSinceRelay,
      toolCallsSinceRelay: state.toolCallsSinceRelay,
      forceAgent: opts.triggerForceAgent,
    });
    if (!check.ok) return `relay skipped: ${check.reason}`;
    const prev = state.phase;
    state.phase = "relay";
    ckpt.save(state);
    const protocol = writeRelayProtocol(manifest, ctx.history, {
      trigger: check.trigger,
      reason: opts.reason,
      current_position: opts.current_position,
      network_map: opts.network_map,
      tried: opts.tried,
      active_sessions: opts.active_sessions,
      foothold: opts.foothold,
      unexplored_surface: opts.unexplored_surface,
      tokens: state.tokens,
      toolCalls: ctx.usage.toolCalls,
      generation: state.relayGeneration,
    });
    ctx.history.recordRelay(manifest.taskId, protocol.generation, check.trigger);
    state.relayGeneration += 1;
    state.tokensSinceRelay = 0;
    state.toolCallsSinceRelay = 0;
    state.phase = prev === "relay" || prev === "init" ? "explore" : prev;
    ckpt.save(state);
    appendProgress(
      manifest.workspaceDir,
      `relay π${protocol.generation} (${check.trigger}): ${opts.reason || "handoff"}`,
    );
    resetMessagesAfterRelay();
    return JSON.stringify(protocol);
  };

  const messages: ChatMessage[] = [
    {
      role: "system",
      content: refreshSystem(),
    },
    {
      role: "user",
      content: kickoffUserMessage(state.phase),
    },
  ];

  appendProgress(
    manifest.workspaceDir,
    `进入模型工具循环 phase=${asGraphPhase(state.phase)}`,
  );
  flushUsage(manifest, ctx, state);

  const maxRounds =
    manifest.budget.maxToolCalls > 0
      ? Math.max(manifest.budget.maxToolCalls, 40)
      : Number.MAX_SAFE_INTEGER;
  for (let i = 0; i < maxRounds; i++) {
    if (ctx.history.allGoalsPass(manifest.taskId)) break;
    if (isBudgetHit(ctx.usage.toolCalls, manifest.budget.maxToolCalls)) {
      state.lastError = "maxToolCalls exceeded";
      appendProgress(manifest.workspaceDir, "达到 maxToolCalls，结束循环");
      break;
    }
    if (isBudgetHit(state.tokens, manifest.budget.maxTokens)) {
      state.lastError = "maxTokens exceeded";
      appendProgress(manifest.workspaceDir, "达到 maxTokens，结束循环");
      break;
    }
    if (isWallHit(workerStartedAt, manifest.budget.maxWallMs)) {
      state.lastError = "maxWallMs exceeded";
      appendProgress(manifest.workspaceDir, "达到 maxWallMs，结束循环");
      break;
    }

    // Soft pace: advisory only — never break / never mark budget_exhausted.
    const softPace = maybeSoftPaceMessage(state, ctx, workerStartedAt);
    if (softPace) {
      messages.push({ role: "user", content: softPace });
      ckpt.save(state);
    }

    // Auto Session Relay when token threshold crossed (never on Watchdog crash).
    const autoCheck = canRelay({
      manifest,
      tokensSinceRelay: state.tokensSinceRelay,
      toolCallsSinceRelay: state.toolCallsSinceRelay,
      forceAgent: false,
    });
    if (autoCheck.ok) {
      performRelay({
        triggerForceAgent: false,
        reason: "auto token threshold",
        foothold: "see prior π + History observe",
        unexplored_surface: "open intents / unfinished goals",
      });
    }

    trimMessages(messages);
    // Keep system prompt phase-aware each round.
    if (messages[0]?.role === "system") {
      messages[0] = { role: "system", content: refreshSystem() };
    }

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
    const deltaTok = tokenDelta(data.usage);
    state.tokens += deltaTok;
    state.tokensSinceRelay += deltaTok;
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
            "目标仍未通过，禁止宣称 DONE，也禁止因预算/剩余时间提前收口。请继续用工具推进；完成语义以 evidence gate / assert_goal 为准。",
        });
        flushUsage(manifest, ctx, state);
        continue;
      }
      messages.push({
        role: "user",
        content:
          "请继续用工具推进未通过目标（长程任务，勿提前收口），全部通过后回复 DONE。",
      });
      flushUsage(manifest, ctx, state);
      continue;
    }

    const toolNames: string[] = [];
    const allowedNow = allowedToolNames(
      syncGraphPhase(ctx.history, manifest.taskId, state.phase),
      mcpHub.openaiTools.map((t) => t.function.name),
    );
    for (const call of msg.tool_calls) {
      const args = JSON.parse(call.function.arguments || "{}") as Record<string, string>;
      let result = "";
      toolNames.push(call.function.name);
      try {
        if (!allowedNow.has(call.function.name) && !isMcpToolName(call.function.name)) {
          result = `denied: tool ${call.function.name} not allowed in phase=${asGraphPhase(state.phase)}`;
          messages.push({
            role: "tool",
            tool_call_id: call.id,
            content: result.slice(0, 4_000),
          });
          continue;
        }
        if (isMcpToolName(call.function.name) && !allowedNow.has(call.function.name)) {
          // MCP only in explore
          if (asGraphPhase(state.phase) !== "explore" && asGraphPhase(state.phase) !== "relay") {
            result = `denied: MCP ${call.function.name} requires explore phase (have ${state.phase})`;
            messages.push({
              role: "tool",
              tool_call_id: call.id,
              content: result.slice(0, 4_000),
            });
            continue;
          }
        }
        const graphResult = handleGraphTool(call.function.name, args, graphCtx());
        if (graphResult != null) {
          result = graphResult;
          messages.push({
            role: "tool",
            tool_call_id: call.id,
            content: result.slice(0, 4_000),
          });
          continue;
        }
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
            result = sessionBootstrapText(
              manifest,
              ctx.history.observe(manifest.taskId),
            );
            break;
          case "history_read_fact": {
            result = JSON.stringify(
              ctx.history.formatFactDrill(manifest.taskId, args.factId ?? ""),
            );
            break;
          }
          case "history_list_layer": {
            const layer = args.layer as "title" | "summary" | "evidence";
            if (!["title", "summary", "evidence"].includes(layer)) {
              result = `invalid layer: ${args.layer ?? ""}`;
            } else {
              result = JSON.stringify(
                ctx.history.listFacts(manifest.taskId, layer).slice(-30),
              );
            }
            break;
          }
          case "relay":
            result = performRelay({
              triggerForceAgent: true,
              reason: args.reason ?? "agent checkpoint",
              current_position: args.current_position,
              network_map: args.network_map,
              tried: args.tried,
              active_sessions: args.active_sessions,
              foothold: args.foothold,
              unexplored_surface: args.unexplored_surface,
            });
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
          case "asset_list":
            result = JSON.stringify(ctx.history.listAssets(manifest.taskId));
            break;
          case "asset_record": {
            const live =
              args.live === "true" || args.live === "1" || args.live === "yes";
            result = JSON.stringify(
              ctx.history.recordAsset({
                taskId: manifest.taskId,
                address: args.address ?? "",
                auth: manifest.auth,
                summary: args.summary,
                live,
                source: "discover",
                intentId: state.activeIntentId,
              }),
            );
            break;
          }
          case "asset_search": {
            const size = args.size ? Number(args.size) : 50;
            result = JSON.stringify(
              await runAssetSearch(ctx, {
                collectorId: args.collectorId ?? "",
                query: args.query ?? "",
                size: Number.isFinite(size) ? size : 50,
                intentId: state.activeIntentId,
              }),
            );
            break;
          }
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
          case "load_skill":
            result = skillHub.load(
              args.id ?? "",
              args.reason ?? "needed for current phase",
            );
            break;
          case "enable_skill":
            // Back-compat alias → load_skill (no system-prompt body dump).
            result = skillHub.load(args.id ?? "", args.reason ?? "needed");
            break;
          case "disable_skill":
            result = `Skill 无需 disable；路由表常驻，正文仅在 load_skill 时进入对话。`;
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
              const serverId =
                call.function.name.replace(/^mcp__/, "").split("__")[0] ?? "";
              assertCapabilityAllows(manifest, mcpActionForServer(serverId));
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

    if (toolNames.length) {
      state.toolCallsSinceRelay += toolNames.length;
    }
    state.toolCalls = ctx.usage.toolCalls;
    state.installs = ctx.usage.installs;
    state.step = i + 1;
    ckpt.save(state);
    flushUsage(manifest, ctx, state);
    writeFileSync(join(manifest.workspaceDir, "openai-transcript.json"), JSON.stringify(messages, null, 2));
    appendProgress(
      manifest.workspaceDir,
      `第 ${i + 1} 步 · 工具 ${toolNames.join("、") || "无"} · Token ${state.tokens} · phase=${state.phase}`,
    );
  }
}

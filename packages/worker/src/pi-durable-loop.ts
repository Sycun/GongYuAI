import type { Context } from "@earendil-works/chord/context";
import type { EntryId, HookApi } from "@earendil-works/pi-durable";
import {
  isBudgetHit,
  isExploreLeader,
  isWallHit,
  type WorkerManifest,
} from "@gongyuai/contracts";
import { appendProgress, type ToolContext } from "./tools.js";
import { CheckpointStore, type CheckpointState } from "./checkpoint.js";
import {
  appendNoteToToolResult,
  createLongTurnQueue,
  renderLongTurnNote,
  shouldCheckAutoSkill,
  takeLongTurnNotes,
} from "./long-turn.js";
import { asGraphPhase, kickoffUserMessage, resolveWorkerRole } from "./graph-phase.js";
import { recordExecutionStep } from "./execution-trace.js";
import { redactModelToolResult } from "./outbound-redact.js";
import type { McpHub } from "./mcp/client.js";
import type { SkillHub } from "./skills/runtime.js";
import type { KnowledgeRagHub } from "./knowledge-rag.js";
import {
  buildModelCandidateChain,
  buildWorkerRefusalPrompt,
  createPoolSizeReader,
  isModelRefusalText,
} from "./model-resilience.js";
import {
  buildPiToolsFromCatalog,
  buildWorkerToolCatalog,
  evaluateWorkerToolGate,
} from "./tool-catalog.js";
import {
  buildTurnObserveBlock,
  piRequestId,
  sessionBootstrapText,
  systemPrompt,
} from "./prompt-builder.js";
import { formatGateSpinRecoveryHint, shouldSnapshotRelay } from "./relay.js";
import { canRelay, synthesizeGroundedRelayFields, writeRelayProtocol } from "./relay-protocol.js";
import {
  consumePendingSoftPace,
  flushUsage,
  maybeSoftPaceMessage,
  poolTurnYieldDirective,
  resolvePiModelRef,
  runExploreTimeoutGate,
  shouldResetFollowerSession,
  waitForPoolTurn,
} from "./loop-shared.js";

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

async function buildConfiguredModels(manifest: WorkerManifest) {
  const { createModels, createProvider } = await import("@earendil-works/pi-ai/models");
  const { openAICompletionsApi } = await import(
    "@earendil-works/pi-ai/api/openai-completions.lazy"
  );
  const ref = resolvePiModelRef(manifest);
  const candidates = buildModelCandidateChain(
    {
      provider: ref.provider,
      modelId: ref.modelId,
      baseUrl: ref.baseUrl,
      apiKeyEnv: ref.apiKeyEnv,
    },
    ref.fallbacks,
    manifest,
  );

  const byProvider = new Map<
    string,
    {
      baseUrl: string;
      apiKeyEnv: string;
      modelIds: Set<string>;
    }
  >();
  for (const cand of candidates) {
    let group = byProvider.get(cand.provider);
    if (!group) {
      group = { baseUrl: cand.baseUrl, apiKeyEnv: cand.apiKeyEnv, modelIds: new Set() };
      byProvider.set(cand.provider, group);
    }
    group.modelIds.add(cand.modelId);
  }
  const primaryGroup = byProvider.get(ref.provider);
  if (primaryGroup && ref.visionModelId !== ref.modelId) {
    primaryGroup.modelIds.add(ref.visionModelId);
  }

  const models = createModels();
  for (const [providerId, group] of byProvider.entries()) {
    const modelsList = Array.from(group.modelIds).map((id) => ({
      id,
      name: id,
      api: "openai-completions" as const,
      provider: providerId,
      baseUrl: group.baseUrl,
      reasoning: false,
      input: (ref.visionEnabled ? ["text", "image"] : ["text"]) as ("text" | "image")[],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 128_000,
      maxTokens: 16_384,
    }));
    models.setProvider(
      createProvider({
        id: providerId,
        name: providerId,
        baseUrl: group.baseUrl,
        auth: {
          apiKey: {
            name: "API key",
            resolve: async () => {
              const key = process.env[group.apiKeyEnv];
              if (!key) return undefined;
              return { auth: { apiKey: key }, source: group.apiKeyEnv };
            },
          },
        },
        models: modelsList,
        api: openAICompletionsApi(),
      }),
    );
  }
  return { models, ref, candidates };
}

export async function tryPiDurable(
  manifest: WorkerManifest,
  ctx: ToolContext,
  state: CheckpointState,
  ckpt: CheckpointStore,
  mcpHub: McpHub,
  skillHub: SkillHub,
  workerStartedAt: number,
  knowledgeRag?: KnowledgeRagHub,
): Promise<boolean> {
  try {
    const { BACKGROUND_CONTEXT } = await import("@earendil-works/chord/context");
    const durable = await import("@earendil-works/pi-durable");
    const { openNodeSqliteStorage } = await import(
      "@earendil-works/pi-durable/storage/sqlite/node"
    );
    const schema = await import("@earendil-works/pi-schema");

    const { models, ref, candidates } = await buildConfiguredModels(manifest);
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
    const readPoolSize = createPoolSizeReader(manifest);
    const leader = isExploreLeader(manifest);
    const lastStaleSweep = { at: Date.now() };
    let candidateIdx = 0;

    const {
      defineTool: definePiTool,
      defineExtension,
      createRegistry,
      Harness,
      AssistantEntry,
      ToolResultEntry,
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

    const longTurn = createLongTurnQueue();
    const armedTools = new Map<string, number>();
    const attachLongTurnNotes = <T,>(toolName: string, out: T): T => {
      const armed = armedTools.get(toolName) ?? 0;
      if (armed <= 0) return out;
      if (armed === 1) armedTools.delete(toolName);
      else armedTools.set(toolName, armed - 1);
      const { notes, consumedSoftPace } = takeLongTurnNotes(state, longTurn);
      if (consumedSoftPace) {
        try {
          ckpt.save(state);
        } catch {
          /* best-effort */
        }
      }
      return notes.length ? appendNoteToToolResult(out, renderLongTurnNote(notes)) : out;
    };

    let lastObservedPiTokens = state.tokens;
    const syncLiveUsage = (piUsage?: {
      models?: Record<string, { totalTokens?: number }>;
      tools?: Record<string, { totalTokens?: number }>;
    }) => {
      if (piUsage) {
        const nextTokens = Math.max(state.tokens, sumPiTokens(piUsage));
        const delta = Math.max(0, nextTokens - lastObservedPiTokens);
        if (delta > 0) {
          state.tokensSinceRelay += delta;
          lastObservedPiTokens = nextTokens;
        }
        state.tokens = nextTokens;
      }
      state.toolCalls = Math.max(state.toolCalls, ctx.usage.toolCalls);
      state.installs = Math.max(state.installs, ctx.usage.installs);
      flushUsage(manifest, ctx, state);
      try {
        ckpt.save(state);
      } catch {
        /* ignore */
      }
    };

    let pendingRotationNotice: string | null = null;
    let consecutiveBlockedCalls = 0;
    let allowedNonRelayCalls = 0;
    let leaderIdleStepsSincePropose = 0;
    let notifiedScaleUpPool = readPoolSize();
    let stepsSinceRotateCheck = 0;
    let pendingFollowerIntentReset = false;

    const maybeBackgroundSnapshot = (): boolean => {
      const currentRole = resolveWorkerRole({ leader, workerCount: readPoolSize() });
      // Followers run short single-Intent sessions and commit facts directly to History.
      if (currentRole === "follower") return false;
      if (
        !shouldSnapshotRelay({
          manifest,
          step: state.step,
          lastSnapshotStep: state.lastRelaySnapshotStep,
          toolCallsSinceRelay: state.toolCallsSinceRelay,
        })
      ) {
        return false;
      }
      try {
        const grounded = synthesizeGroundedRelayFields(ctx.history, manifest.taskId, state.activeIntentId);
        const protocol = writeRelayProtocol(manifest, ctx.history, {
          trigger: "auto",
          reason: "background audit snapshot",
          ...grounded,
          tokens: state.tokens,
          toolCalls: ctx.usage.toolCalls,
          wallMs: Date.now() - workerStartedAt,
          generation: state.relayGeneration,
        });
        ctx.history.recordRelay(manifest.taskId, protocol.generation, "auto");
        state.relayGeneration += 1;
        state.lastRelaySnapshotStep = state.step;
        state.tokensSinceRelay = 0;
        state.toolCallsSinceRelay = 0;
        ckpt.save(state);
        appendProgress(manifest.workspaceDir, `relay π${protocol.generation} (background snapshot, session kept)`);
        return true;
      } catch {
        return false;
      }
    };

    const catalog = buildWorkerToolCatalog({
      manifest,
      ctx,
      state,
      ckpt,
      mcpHub,
      skillHub,
      readPoolSize,
      flushUsage: () => flushUsage(manifest, ctx, state),
      renderHistoryOverview: () =>
        sessionBootstrapText(manifest, ctx.history.observe(manifest.taskId)),
      onFollowerIntentFinished: (intentId) => {
        pendingFollowerIntentReset = true;
        appendProgress(
          manifest.workspaceDir,
          `follower slot=${manifest.workerSlot ?? 0} concluded Intent ${intentId} → terminate & schedule clean session reset`,
        );
      },
      onRelay: (args) => {
        const check = canRelay({
          manifest,
          tokensSinceRelay: state.tokensSinceRelay,
          toolCallsSinceRelay: state.toolCallsSinceRelay,
          forceAgent: true,
        });
        if (!check.ok) return { text: `relay skipped: ${check.reason}` };
        const prev = state.phase;
        state.phase = "relay";
        ckpt.save(state);
        const protocol = writeRelayProtocol(manifest, ctx.history, {
          trigger: check.trigger,
          reason: args.reason ?? "agent checkpoint",
          current_position: args.current_position,
          network_map: args.network_map,
          tried: args.tried,
          active_sessions: args.active_sessions,
          foothold: args.foothold,
          unexplored_surface: args.unexplored_surface,
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
        appendProgress(manifest.workspaceDir, `relay π${protocol.generation} (${check.trigger})`);
        const handoff = [
          `会话已 Relay（π${protocol.generation} · ${check.trigger}）。请基于以下最新图状态与交接继续推进未完成 Goals / open Intents：`,
          "",
          buildTurnObserveBlock(manifest, ctx.history, state, skillHub, { knowledgeRag }),
        ].join("\n");
        return { text: JSON.stringify(protocol), handoff };
      },
    });

    const piSchema = schema as unknown as {
      obj: (props: Record<string, unknown>) => unknown;
      str: (ann?: Record<string, unknown>) => unknown;
      num: (ann?: Record<string, unknown>) => unknown;
      opt: (s: unknown) => unknown;
    };
    const startupRole = resolveWorkerRole({ leader, workerCount: readPoolSize() });
    const registeredPiTools = buildPiToolsFromCatalog({
      catalog,
      role: startupRole,
      piSchema,
      definePiTool: definePiTool as (spec: never) => unknown,
      wrapExecute: (toolName, out) =>
        attachLongTurnNotes(toolName, redactModelToolResult(out)),
    });

    const registry = createRegistry();
    registry.install(
      defineExtension({
        name: "gongyuai",
        tools: registeredPiTools as never,
        hooks: [
          hook(ToolTask, {
            beforeTool: (call: { name: string; parent?: unknown; arguments?: Record<string, unknown>; args?: Record<string, unknown> }) => {
              if (call.parent) return undefined;
              const livePoolSize = readPoolSize();
              const callArgs = call.arguments ?? call.args;
              const yieldBlock = poolTurnYieldDirective({
                toolName: call.name,
                leader,
                workerCount: livePoolSize,
                phase: asGraphPhase(state.phase),
                activeIntentId: state.activeIntentId,
                openIntents: livePoolSize > 1 ? ctx.history.openIntents(manifest.taskId) : [],
                allGoalsPass: livePoolSize > 1 ? ctx.history.allGoalsPass(manifest.taskId) : false,
                leaderIdleStepsSincePropose,
              });
              if (yieldBlock) {
                appendProgress(manifest.workspaceDir, `pool yield ${call.name}: ${yieldBlock.slice(0, 120)}`);
                return { block: yieldBlock };
              }
              const block = evaluateWorkerToolGate({
                ctx,
                state,
                name: call.name,
                mcpHub,
                args: callArgs,
                poolSizeOverride: livePoolSize,
              });
              if (block) {
                consecutiveBlockedCalls += 1;
                const extra: string[] = [];
                if (pendingRotationNotice) {
                  extra.push(`刚触发证据耗尽自动换面：${pendingRotationNotice}；旧 Intent 已自动结项，请直接调用 intent_propose / intent_claim 开启新攻击面`);
                  pendingRotationNotice = null;
                }
                if (consecutiveBlockedCalls >= 6) {
                  extra.push(
                    formatGateSpinRecoveryHint({
                      phase: asGraphPhase(state.phase),
                      activeIntentId: state.activeIntentId,
                      leader,
                      workerCount: livePoolSize,
                    }),
                  );
                }
                const fullBlock = extra.length ? `${block}（${extra.join("；")}）` : block;
                appendProgress(manifest.workspaceDir, `gate blocked ${call.name}: ${block.slice(0, 180)}`);
                return { block: fullBlock };
              }
              if (call.name !== "relay") {
                consecutiveBlockedCalls = 0;
                allowedNonRelayCalls += 1;
                if (call.name === "intent_propose" || call.name === "technique_transfer") {
                  leaderIdleStepsSincePropose = 0;
                } else if (leader && livePoolSize > 1) {
                  leaderIdleStepsSincePropose += 1;
                }
              }
              armedTools.set(call.name, (armedTools.get(call.name) ?? 0) + 1);
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
              assistant: EntryId,
              results: readonly EntryId[],
              api: HookApi & { usage: (c: Context) => Promise<unknown> },
              hookCtx: Context,
            ) => {
              const message = (await api.entry(AssistantEntry, assistant, hookCtx))?.model?.[0];
              const calls = message?.role === "assistant"
                ? message.content.filter((part) => part.type === "toolCall")
                : [];
              if (allowedNonRelayCalls > 0) {
                state.toolCallsSinceRelay += allowedNonRelayCalls;
                allowedNonRelayCalls = 0;
              }
              const shellCalls = calls.filter((call) => call.name === "shell");
              const resultsByCall = new Map<string, { text: string; exitCode: number | null; durationMs: number | null }>();
              if (shellCalls.length) {
                for (const id of results) {
                  const result = (await api.entry(ToolResultEntry, id, hookCtx))?.model?.[0];
                  if (result?.role !== "toolResult" || result.toolName !== "shell") continue;
                  const details = result.details && typeof result.details === "object"
                    ? (result.details as Record<string, unknown>)
                    : undefined;
                  const shellResult = details && "shellResult" in details
                    ? details.shellResult
                    : undefined;
                  const resultText = typeof shellResult === "string" ? shellResult : result.content
                    .flatMap((part) => part.type === "text" ? [part.text] : [])
                    .join("\n");
                  const parsedExit = /^exit=(-?\d+)\b/.exec(resultText);
                  const exitCode = typeof details?.exitCode === "number"
                    ? details.exitCode
                    : parsedExit
                      ? Number(parsedExit[1])
                      : null;
                  const durationMs = typeof details?.durationMs === "number" ? details.durationMs : null;
                  resultsByCall.set(result.toolCallId, { text: resultText, exitCode, durationMs });
                }
              }
              try {
                const usage = (await api.usage(hookCtx)) as {
                  models?: Record<string, { totalTokens?: number }>;
                  tools?: Record<string, { totalTokens?: number }>;
                };
                syncLiveUsage(usage);
              } catch {
                syncLiveUsage();
              }
              const step = recordExecutionStep(manifest, {
                id: `pi-w${manifest.workerSlot ?? 0}-${assistant}`,
                number: state.step + 1,
                tools: calls.map((call) => call.name),
                tokens: state.tokens,
                phase: state.phase,
                calls: shellCalls.map((call) => {
                  const meta = resultsByCall.get(call.id);
                  return {
                    id: call.id,
                    command: typeof call.arguments.command === "string" ? call.arguments.command : null,
                    result: meta?.text ?? null,
                    exitCode: meta?.exitCode ?? null,
                    durationMs: meta?.durationMs ?? null,
                  };
                }),
              });
              state.step = Math.max(state.step, step);

              const livePoolSize = readPoolSize();
              const role = resolveWorkerRole({ leader, workerCount: livePoolSize });
              if (role !== "follower") {
                const softDuring = maybeSoftPaceMessage(state, ctx, workerStartedAt);
                if (softDuring) state.pendingSoftPaceMessage = softDuring;
              }

              try {
                const facts = ctx.history.listFacts(manifest.taskId);
                if (shouldCheckAutoSkill(longTurn, facts.length)) {
                  const skillBlock = skillHub.autoInjectForFacts(facts, { phase: "discover" });
                  if (skillBlock) longTurn.notes.push(skillBlock);
                  const ragBlock = knowledgeRag?.autoInjectForFacts(facts);
                  if (ragBlock) longTurn.notes.push(ragBlock);
                }
              } catch {
                /* advisory only */
              }

              maybeBackgroundSnapshot();

              if (leader && livePoolSize > 1 && notifiedScaleUpPool <= 1) {
                notifiedScaleUpPool = livePoolSize;
                longTurn.notes.push(
                  `[Explore 池动态扩容 1→${livePoolSize}] 系统已拉起 ${livePoolSize - 1} 个并发 Explore Follower。你是 slot 0 Leader（纯调度角色）：${state.activeIntentId ? `请尽快 intent_conclude 当前 Intent (${state.activeIntentId})，` : ""}在 Reason 相位为各可用资产/题面分别 intent_propose 独立 Intent（勿传 claim='true'），交由 Follower 并行推进。`,
                );
              }

              stepsSinceRotateCheck += 1;
              if (state.phase === "explore" && state.activeIntentId && stepsSinceRotateCheck >= 5) {
                stepsSinceRotateCheck = 0;
                const rot = runExploreTimeoutGate(manifest, ctx.history, state, ckpt, livePoolSize);
                if (rot) {
                  pendingRotationNotice = rot;
                  if (role === "follower") {
                    pendingFollowerIntentReset = true;
                  }
                  longTurn.notes.push(
                    `[证据耗尽自动换面] ${rot}。旧 Intent 已自动结项并释放（activeIntentId=null，当前 phase=${state.phase}）；无需再调用 intent_conclude，请直接按当前相位调用 ${role === "follower" ? "intent_claim 认领新 Intent（无待认领时回复 YIELD）" : "intent_propose / engagement_audit / tsecbench 切入新攻击面"}。`,
                  );
                }
              }
              ckpt.save(state);
              return undefined;
            },
          }),
        ],
        sections: [
          section(
            "gongyuai-system",
            () => systemPrompt(manifest, undefined, mcpHub, skillHub),
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
      `Pi Durable 使用模型 ${ref.provider}/${ref.modelId}（tier=${ref.tier}` +
        `${ref.fallbacks.length ? `, fallbacks=${ref.fallbacks.map((item) => `${item.provider}/${item.modelId}`).join(",")}` : ""}）`,
    );
    flushUsage(manifest, ctx, state);

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
      let round = state.round;
      let refusalStreak = 0;
      let pendingRefusalPrompt: string | null = null;
      for (;;) {
        const poolDecision = await waitForPoolTurn({
          manifest,
          ctx,
          state,
          workerStartedAt,
          readPoolSize,
          lastStaleSweep,
        });
        if (poolDecision === "exit") {
          appendProgress(manifest.workspaceDir, "任务目标已清或主节点已收卷，结束 Pi 循环");
          break;
        }

        maybeBackgroundSnapshot();

        round += 1;
        state.round = round;
        ckpt.save(state);

        const livePoolForPrompt = readPoolSize();
        const role = resolveWorkerRole({ leader, workerCount: livePoolForPrompt });

        const timeoutNote =
          pendingRotationNotice ??
          runExploreTimeoutGate(manifest, ctx.history, state, ckpt, livePoolForPrompt);
        if (timeoutNote && role === "follower" && !state.activeIntentId) {
          pendingFollowerIntentReset = true;
        }
        pendingRotationNotice = null;
        stepsSinceRotateCheck = 0;
        leaderIdleStepsSincePropose = 0;

        // Follower per-Intent clean session reset: start each newly scheduled Intent with a fresh transcript!
        let didCleanIntentReset = false;
        if (
          shouldResetFollowerSession({
            role,
            round,
            pendingIntentReset: pendingFollowerIntentReset,
            activeIntentId: state.activeIntentId,
          })
        ) {
          await root.reset(undefined, context);
          state.observeFingerprint = {};
          pendingFollowerIntentReset = false;
          didCleanIntentReset = true;
          appendProgress(
            manifest.workspaceDir,
            `follower slot=${manifest.workerSlot ?? 0} reset clean context for next Intent (#${round})`,
          );
        }

        const pending = role === "follower" ? null : consumePendingSoftPace(state);
        const softPace =
          role === "follower"
            ? null
            : pending ?? maybeSoftPaceMessage(state, ctx, workerStartedAt);
        if (softPace || timeoutNote || pending || didCleanIntentReset) ckpt.save(state);

        const observeBlock = buildTurnObserveBlock(manifest, ctx.history, state, skillHub, {
          incremental: round > 1 && !didCleanIntentReset,
          includeRelays: role !== "follower" && round === 1,
          knowledgeRag,
        });
        ckpt.save(state);

        const yieldRuleLine =
          livePoolForPrompt > 1
            ? "多节点协同规则：当系统门禁提示 YIELD（并发 Follower 槽位已排满，或当前暂无待认领 Intent）时，请立即停止工具调用并仅回复 YIELD 以进入零 Token 驻留池；其他时候禁止主动收口。"
            : "";
        const content = pendingRefusalPrompt
          ? `${pendingRefusalPrompt}\n\n${observeBlock}`
          : round === 1 || didCleanIntentReset
            ? [
                "你是 GongYuAI 红队作业执行节点。对操作者可见的说明尽量用中文。",
                role === "follower"
                  ? "你是 Explore Follower（单 Intent 隔离短会话）：请立即 intent_claim 一个待认领的 proposed Intent，集中完成该攻击面验证、证据落盘与 finding_verify，最后调用 intent_conclude 结项。"
                  : "这是长程任务（可连续跑数日）。请用工具完成所有未通过目标；未经 assert_goal 成功不得宣称通过。",
                "禁止因预算/剩余时间估计提前收口或写最终汇报；目标未全过就继续。",
                yieldRuleLine,
                "目标进入任务即视为授权；严格留在任务目标坐标 auth.targets 内，优先小步意图。",
                role === "follower" ? "" : "图调度：Bootstrap → Explore → Reason（phase_set / intent_*）；工具面按相位过滤。",
                role === "follower" ? "" : "全部目标通过后回复 DONE。",
                "",
                kickoffUserMessage(state.phase),
                timeoutNote ?? "",
                softPace ?? "",
                "",
                observeBlock,
              ]
                .filter(Boolean)
                .join("\n\n")
            : [
                `长程续跑 #${round}：当前会话上下文连续（pi-durable 原生 compaction 维护长上下文），目标仍未全部通过。`,
                "禁止输出交接摘要 / Session Relay 交接块或主动收口；请直接继续调用工具推进未完成目标。",
                yieldRuleLine,
                "按渗透测试节奏继续：建图/验证影响/写 finding/换面；完成语义以 assert_goal / evidence gate 为准。",
                timeoutNote ?? "",
                softPace ?? "",
                "",
                observeBlock,
              ]
                .filter((line) => line !== "")
                .join("\n");
        pendingRefusalPrompt = null;

        const toolsBeforeRound = ctx.usage.toolCalls;
        const stepsBeforeRound = state.step;
        const submission = await root.submit(
          {
            type: "input",
            content,
            requestId: piRequestId(manifest.taskId, state.bootEpoch, round),
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
          if (candidateIdx + 1 < candidates.length) {
            candidateIdx += 1;
            const nextCand = candidates[candidateIdx]!;
            await root.configure(
              { model: { provider: nextCand.provider, modelId: nextCand.modelId } },
              context,
            );
            appendProgress(
              manifest.workspaceDir,
              `Pi Durable 模型故障切换 → ${nextCand.provider}/${nextCand.modelId}（reason=${settledAny?.reason ?? settledAny?.status}）`,
            );
            continue;
          }
          appendProgress(
            manifest.workspaceDir,
            `Pi Durable 无可用模型（${settledAny?.reason ?? settledAny?.status}），改用 OpenAI 工具循环`,
          );
          return false;
        }

        let assistantText = "";
        if (settled.status === "done" && settled.type === "input") {
          const answerEntry = await root.commit(
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            (tx: any) => tx.entry(AssistantEntry, settled.answer),
            context,
          );
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const answerParts = (answerEntry as any)?.model?.[0]?.content;
          if (Array.isArray(answerParts)) {
            assistantText = answerParts
              .filter((p: { type?: string; text?: string }) => p?.type === "text" && typeof p.text === "string")
              .map((p: { text: string }) => p.text)
              .join("\n");
          }
        }

        state.toolCalls = ctx.usage.toolCalls;
        state.installs = ctx.usage.installs;
        flushUsage(manifest, ctx, state);
        try {
          ckpt.save(state);
        } catch {
          /* best-effort */
        }

        if (ctx.usage.toolCalls === toolsBeforeRound && isModelRefusalText(assistantText)) {
          refusalStreak += 1;
          ctx.history.recordEvent(manifest.taskId, "tool_gate", {
            tool: "model_refusal",
            ok: false,
            reason: `model explanatory refusal #${refusalStreak}`,
            snippet: assistantText.slice(0, 240),
          });
          if (refusalStreak >= 2 && candidateIdx + 1 < candidates.length) {
            candidateIdx += 1;
            const nextCand = candidates[candidateIdx]!;
            await root.configure(
              { model: { provider: nextCand.provider, modelId: nextCand.modelId } },
              context,
            );
            appendProgress(
              manifest.workspaceDir,
              `P16 拒绝纠偏切换模型 → ${nextCand.provider}/${nextCand.modelId}`,
            );
          }
          pendingRefusalPrompt = buildWorkerRefusalPrompt(refusalStreak, manifest.auth.targets);
          continue;
        }
        refusalStreak = 0;

        const yieldedToPool =
          (/\bYIELD\b/i.test(assistantText) || pendingFollowerIntentReset) && readPoolSize() > 1;
        if (
          round === 1 &&
          ctx.usage.toolCalls === 0 &&
          state.step === stepsBeforeRound &&
          !yieldedToPool &&
          !ctx.history.allGoalsPass(manifest.taskId)
        ) {
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

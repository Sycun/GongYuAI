import { writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  hasDsmlMarkup,
  isBudgetHit,
  isExploreLeader,
  isWallHit,
  parseDsmlCalls,
  type ShellTraceCall,
  type WorkerManifest,
} from "@gongyuai/contracts";
import type { CheckpointState, CheckpointStore } from "./checkpoint.js";
import { appendProgress, type ToolContext } from "./tools.js";
import {
  asGraphPhase,
  kickoffUserMessage,
  resolveWorkerRole,
  syncGraphPhase,
} from "./graph-phase.js";
import { recordExecutionStep } from "./execution-trace.js";
import type { McpHub } from "./mcp/client.js";
import type { SkillHub } from "./skills/runtime.js";
import type { KnowledgeRagHub } from "./knowledge-rag.js";
import {
  buildModelCandidateChain,
  buildWorkerRefusalPrompt,
  createPoolSizeReader,
  isModelRefusalText,
  isRetryableHttpStatus,
  shouldFailoverHttpStatus,
  type ResolvedCandidateModel,
} from "./model-resilience.js";
import {
  buildOpenAiToolsFromCatalog,
  buildWorkerToolCatalog,
  evaluateWorkerToolGate,
  executeOpenAiCatalogCall,
  smartTruncateToolOutput,
} from "./tool-catalog.js";
import {
  buildTurnObserveBlock,
  redactOutboundChatMessages,
  sessionBootstrapText,
  systemPrompt,
} from "./prompt-builder.js";
import { canRelay, synthesizeGroundedRelayFields, writeRelayProtocol } from "./relay-protocol.js";
import {
  evaluateEnvironmentTerminalExit,
  flushUsage,
  maybeSoftPaceMessage,
  poolTurnYieldDirective,
  readEnvironmentTerminal,
  resolvePiModelRef,
  runExploreTimeoutGate,
  shouldResetFollowerSession,
  waitForPoolTurn,
} from "./loop-shared.js";

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

type ChatMessage = {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  tool_call_id?: string;
  tool_calls?: unknown[];
};

function trimMessages(messages: ChatMessage[], maxMessages = 48): void {
  if (messages.length <= maxMessages) return;
  const system = messages[0]?.role === "system" ? [messages[0]!] : [];
  const rest = messages.slice(system.length);
  const kept = rest.slice(-(maxMessages - system.length));
  let pending = new Set<string>();
  const cleaned: ChatMessage[] = [];
  for (const m of kept) {
    if (m.role === "assistant") {
      pending = new Set(((m.tool_calls ?? []) as Array<{ id?: string }>).map((tc) => tc.id ?? ""));
      cleaned.push(m);
    } else if (m.role === "tool") {
      if (m.tool_call_id && pending.has(m.tool_call_id)) cleaned.push(m);
    } else {
      pending = new Set();
      cleaned.push(m);
    }
  }
  messages.splice(0, messages.length, ...system, ...cleaned);
}

export async function runOpenAiToolLoop(
  manifest: WorkerManifest,
  ctx: ToolContext,
  state: CheckpointState,
  ckpt: CheckpointStore,
  mcpHub: McpHub,
  skillHub: SkillHub,
  workerStartedAt: number,
  knowledgeRag?: KnowledgeRagHub,
): Promise<void> {
  const ref = resolvePiModelRef(manifest);
  const candidates: ResolvedCandidateModel[] = buildModelCandidateChain(
    {
      provider: ref.provider,
      modelId: ref.modelId,
      baseUrl: ref.baseUrl,
      apiKeyEnv: ref.apiKeyEnv,
    },
    ref.fallbacks,
    manifest,
  );
  let candidateIdx = 0;
  const activeCandidate = (): ResolvedCandidateModel => candidates[candidateIdx] ?? candidates[0]!;
  if (!process.env[activeCandidate().apiKeyEnv]) {
    throw new Error(`${activeCandidate().apiKeyEnv} missing and pi-durable did not start`);
  }
  const readPoolSize = createPoolSizeReader(manifest);
  const leader = isExploreLeader(manifest);
  const lastStaleSweep = { at: Date.now() };
  const refreshSystem = () => systemPrompt(manifest, undefined, mcpHub, skillHub);

  let lastInjectedPhase = asGraphPhase(state.phase);
  let pendingAutoRelayAsk = false;
  let refusalStreak = 0;
  let leaderIdleStepsSincePropose = 0;
  let pendingFollowerIntentReset = false;
  let terminalFinalizationRounds = 0;

  const messages: ChatMessage[] = [];
  const resetConversationToObserve = (banner: string, includeRelays: boolean) => {
    state.observeFingerprint = {};
    const observeBlock = buildTurnObserveBlock(manifest, ctx.history, state, skillHub, {
      incremental: false,
      includeRelays,
      knowledgeRag,
    });
    lastInjectedPhase = asGraphPhase(state.phase);
    pendingAutoRelayAsk = false;
    messages.splice(
      0,
      messages.length,
      { role: "system", content: refreshSystem() },
      { role: "user", content: `${banner}\n\n${observeBlock}` },
    );
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
      wallMs: Date.now() - workerStartedAt,
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
    resetConversationToObserve(
      "会话已 Relay。请根据以下注入的 π 与 History Observe 继续未完成 Goals / open Intents；禁止改动主机网络/VPN/代理。",
      true,
    );
    return JSON.stringify(protocol);
  };

  const openAiCatalog = () => buildWorkerToolCatalog({
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
        `follower slot=${manifest.workerSlot ?? 0} concluded Intent ${intentId} (OpenAI loop) → schedule clean session reset`,
      );
    },
    onCatalogChanged: () => {
      if (messages[0]?.role === "system") {
        messages[0] = { role: "system", content: refreshSystem() };
      }
    },
    onRelay: (args) => ({
      text: performRelay({
        triggerForceAgent: true,
        reason: args.reason ?? "agent checkpoint",
        current_position: args.current_position,
        network_map: args.network_map,
        tried: args.tried,
        active_sessions: args.active_sessions,
        foothold: args.foothold,
        unexplored_surface: args.unexplored_surface,
      }),
    }),
  });

  let catalog = openAiCatalog();

  const initialRole = resolveWorkerRole({ leader, workerCount: readPoolSize() });
  resetConversationToObserve(kickoffUserMessage(state.phase), initialRole !== "follower");

  appendProgress(
    manifest.workspaceDir,
    `进入模型工具循环 phase=${asGraphPhase(state.phase)} model=${activeCandidate().provider}/${activeCandidate().modelId}`,
  );
  flushUsage(manifest, ctx, state);

  const maxRounds =
    manifest.budget.maxToolCalls > 0
      ? Math.max(manifest.budget.maxToolCalls, 40)
      : Number.MAX_SAFE_INTEGER;

  for (let i = 0; i < maxRounds; i++) {
    const poolDecision = await waitForPoolTurn({
      manifest,
      ctx,
      state,
      workerStartedAt,
      readPoolSize,
      lastStaleSweep,
    });
    if (poolDecision === "exit") break;

    const livePoolSize = readPoolSize();
    const role = resolveWorkerRole({ leader, workerCount: livePoolSize });
    const envTerminal = readEnvironmentTerminal(manifest.dataDir);
    const termDecision = evaluateEnvironmentTerminalExit({
      terminal: envTerminal,
      leader: role !== "follower",
      openIntentsCount: envTerminal ? ctx.history.openIntents(manifest.taskId).length : 0,
      activeIntentId: state.activeIntentId,
      finalizationRoundsCompleted: terminalFinalizationRounds,
    });
    if (termDecision.shouldExit) {
      if (envTerminal && role !== "follower") state.lastError = envTerminal.reason;
      ckpt.save(state);
      appendProgress(manifest.workspaceDir, "目标环境已进入终态且收尾完成，退出工具循环");
      break;
    }
    if (termDecision.runFinalizationRound && envTerminal) {
      terminalFinalizationRounds += 1;
      messages.push({
        role: "user",
        content: `[目标环境终态收口 · 唯一封账轮] ${envTerminal.reason}。所有在途 Explore 已排空，禁止再向靶机发起请求或新建意图；请仅核对既有 verified findings 完成可达成报告目标断言（assert_goal）并总结残余风险，本轮结束后系统将自动停机。`,
      });
    }

    const timeoutNote = runExploreTimeoutGate(
      manifest,
      ctx.history,
      state,
      ckpt,
      livePoolSize,
    );
    if (timeoutNote && role === "follower" && !state.activeIntentId) {
      pendingFollowerIntentReset = true;
    }

    if (
      shouldResetFollowerSession({
        role,
        round: i + 1,
        pendingIntentReset: pendingFollowerIntentReset,
        activeIntentId: state.activeIntentId,
      })
    ) {
      pendingFollowerIntentReset = false;
      resetConversationToObserve(
        "Follower 单 Intent 干净会话已重置：请立即 intent_claim 一个待认领的 proposed Intent 独立验证，完成后调用 intent_conclude。",
        false,
      );
    } else if (timeoutNote) {
      messages.push({ role: "user", content: timeoutNote });
      flushUsage(manifest, ctx, state);
    }

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

    if (role !== "follower") {
      const softPace = maybeSoftPaceMessage(state, ctx, workerStartedAt);
      if (softPace) {
        messages.push({ role: "user", content: softPace });
        ckpt.save(state);
      }

      const autoCheck = canRelay({
        manifest,
        tokensSinceRelay: state.tokensSinceRelay,
        toolCallsSinceRelay: state.toolCallsSinceRelay,
        forceAgent: false,
      });
      if (autoCheck.ok) {
        if (!pendingAutoRelayAsk) {
          pendingAutoRelayAsk = true;
          messages.push({
            role: "user",
            content:
              "上下文已达 Relay 阈值：请先调用一次 `relay` 工具写下当前立足点（foothold）、已验证约束（tried）与待测面（unexplored_surface），完成本轮交班压缩。",
          });
        } else {
          const grounded = synthesizeGroundedRelayFields(
            ctx.history,
            manifest.taskId,
            state.activeIntentId,
          );
          performRelay({
            triggerForceAgent: false,
            reason: "auto token threshold (grounded fallback)",
            ...grounded,
          });
        }
      }
    }

    const syncedPhase = syncGraphPhase(ctx.history, manifest.taskId, state.phase, {
      leader,
      workerCount: livePoolSize,
      activeIntentId: state.activeIntentId,
    });
    state.phase = syncedPhase;
    if (asGraphPhase(syncedPhase) !== lastInjectedPhase) {
      lastInjectedPhase = asGraphPhase(syncedPhase);
      messages.push({
        role: "user",
        content: buildTurnObserveBlock(manifest, ctx.history, state, skillHub, {
          incremental: true,
          includeRelays: false,
          knowledgeRag,
        }),
      });
    }

    trimMessages(messages);

    const openAiTools = buildOpenAiToolsFromCatalog({
      catalog,
      history: ctx.history,
      manifest,
      state,
      mcpHub,
      workerCount: livePoolSize,
    });

    let res: Response | undefined;
    let lastFetchErr: unknown;
    let switchedModel = false;
    for (let attempt = 0; attempt < 4; attempt++) {
      const cand = activeCandidate();
      const candKey = process.env[cand.apiKeyEnv];
      if (!candKey) {
        if (candidateIdx + 1 < candidates.length) {
          candidateIdx += 1;
          continue;
        }
        throw new Error(`API key missing for ${cand.apiKeyEnv}`);
      }
      try {
        const candidateRes = await fetch(`${cand.baseUrl}/chat/completions`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${candKey}`,
            "content-type": "application/json",
            "user-agent": "GongYuAI/0.1",
          },
          body: JSON.stringify({
            model: cand.modelId,
            messages: redactOutboundChatMessages(messages),
            tools: openAiTools,
            tool_choice: "auto",
          }),
        });
        if (!candidateRes.ok) {
          const errBody = await candidateRes.text();
          if (shouldFailoverHttpStatus(candidateRes.status, errBody) && candidateIdx + 1 < candidates.length && attempt >= 1) {
            candidateIdx += 1;
            switchedModel = true;
            const next = activeCandidate();
            appendProgress(
              manifest.workspaceDir,
              `模型接口 ${candidateRes.status} 故障切换 → ${next.provider}/${next.modelId}`,
            );
            continue;
          }
          if (isRetryableHttpStatus(candidateRes.status) && attempt < 3) {
            const retryAfter = Number(candidateRes.headers.get("retry-after") ?? "");
            const waitMs = Number.isFinite(retryAfter) && retryAfter > 0
              ? Math.min(15_000, retryAfter * 1000)
              : 1000 * Math.pow(2, attempt);
            lastFetchErr = new Error(`HTTP ${candidateRes.status}: ${errBody.slice(0, 200)}`);
            appendProgress(
              manifest.workspaceDir,
              `模型接口 ${candidateRes.status} 退避重试 ${attempt + 1}/4（等待 ${waitMs}ms）`,
            );
            await new Promise((r) => setTimeout(r, waitMs));
            continue;
          }
          if (shouldFailoverHttpStatus(candidateRes.status, errBody) && candidateIdx + 1 < candidates.length) {
            candidateIdx += 1;
            switchedModel = true;
            const next = activeCandidate();
            appendProgress(
              manifest.workspaceDir,
              `模型接口 ${candidateRes.status} 故障切换 → ${next.provider}/${next.modelId}`,
            );
            continue;
          }
          throw new Error(`模型接口错误 ${candidateRes.status}: ${errBody}`);
        }
        res = candidateRes;
        lastFetchErr = undefined;
        break;
      } catch (err) {
        lastFetchErr = err;
        if (err instanceof Error && err.message.startsWith("模型接口错误 ") && candidateIdx + 1 >= candidates.length) {
          throw err;
        }
        if (attempt >= 2 && candidateIdx + 1 < candidates.length && !switchedModel) {
          candidateIdx += 1;
          switchedModel = true;
          const next = activeCandidate();
          appendProgress(
            manifest.workspaceDir,
            `模型请求异常切换备用 → ${next.provider}/${next.modelId}`,
          );
          continue;
        }
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

    let toolCalls = msg.tool_calls ?? [];
    let content = msg.content ?? "";
    if (!toolCalls.length && content && hasDsmlMarkup(content)) {
      const parsed = parseDsmlCalls(content);
      if (parsed.length) {
        toolCalls = parsed.map((c, idx) => ({
          id: `dsml-${idx}-${Date.now()}`,
          function: { name: c.name === "command" ? "shell" : c.name, arguments: JSON.stringify(c.args) },
        }));
        content = "";
      }
    }

    messages.push({
      role: "assistant",
      content,
      tool_calls: toolCalls,
    });

    if (!toolCalls.length) {
      if (isModelRefusalText(content)) {
        refusalStreak += 1;
        ctx.history.recordEvent(manifest.taskId, "tool_gate", {
          tool: "model_refusal",
          ok: false,
          reason: `model explanatory refusal #${refusalStreak}`,
          snippet: content.slice(0, 240),
        });
        if (refusalStreak >= 2 && candidateIdx + 1 < candidates.length) {
          candidateIdx += 1;
          const next = activeCandidate();
          appendProgress(
            manifest.workspaceDir,
            `P16 拒绝纠偏切换模型 → ${next.provider}/${next.modelId}`,
          );
        }
        messages.push({
          role: "user",
          content: buildWorkerRefusalPrompt(refusalStreak, manifest.auth.targets),
        });
        flushUsage(manifest, ctx, state);
        continue;
      }
      refusalStreak = 0;

      // Multi-worker YIELD: park immediately via waitForPoolTurn() on the next loop iteration.
      if (livePoolSize > 1 && /\bYIELD\b/i.test(content)) {
        leaderIdleStepsSincePropose = 0;
        flushUsage(manifest, ctx, state);
        continue;
      }

      if (content.includes("DONE")) {
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
    refusalStreak = 0;

    const toolNames: string[] = [];
    let allowedOpenAiNonRelayCalls = 0;
    const shellCalls: ShellTraceCall[] = [];
    let relayResetOccurred = false;

    for (const call of toolCalls) {
      const args = JSON.parse(call.function.arguments || "{}") as Record<string, unknown>;
      const callName = call.function.name;
      toolNames.push(callName);
      let result = "";
      let shellMeta: { shellResult: string; exitCode: number | null; durationMs: number | null } | undefined;

      try {
        const yieldBlock = poolTurnYieldDirective({
          toolName: callName,
          leader,
          workerCount: livePoolSize,
          phase: asGraphPhase(state.phase),
          activeIntentId: state.activeIntentId,
          openIntents: livePoolSize > 1 ? ctx.history.openIntents(manifest.taskId) : [],
          allGoalsPass: livePoolSize > 1 ? ctx.history.allGoalsPass(manifest.taskId) : false,
          leaderIdleStepsSincePropose,
        });
        if (yieldBlock) {
          appendProgress(manifest.workspaceDir, `pool yield ${callName}: ${yieldBlock.slice(0, 120)}`);
          messages.push({ role: "tool", tool_call_id: call.id, content: yieldBlock });
          continue;
        }

        const denied = evaluateWorkerToolGate({
          ctx,
          state,
          name: callName,
          mcpHub,
          args,
          poolSizeOverride: livePoolSize,
        });
        if (denied) {
          appendProgress(manifest.workspaceDir, `gate blocked ${callName}: ${denied.slice(0, 180)}`);
          messages.push({ role: "tool", tool_call_id: call.id, content: denied });
          continue;
        }

        if (callName !== "relay") {
          allowedOpenAiNonRelayCalls += 1;
          if (
            callName === "intent_propose" ||
            callName === "technique_transfer" ||
            (leader && callName === "tsecbench")
          ) {
            leaderIdleStepsSincePropose = 0;
          } else if (leader && livePoolSize > 1) {
            leaderIdleStepsSincePropose += 1;
          }
        }

        const out = await executeOpenAiCatalogCall({
          catalog,
          mcpHub,
          ctx,
          state,
          ckpt,
          name: callName,
          args,
        });
        result = out.text;
        shellMeta = out.shellMeta;

        // Refresh catalog if MCP list changed dynamically (`enable_mcp` / `install_mcp`).
        if (callName === "enable_mcp" || callName === "disable_mcp" || callName === "install_mcp") {
          catalog = openAiCatalog();
        }
        if (callName === "relay" && !result.startsWith("relay skipped:")) {
          relayResetOccurred = true;
          break;
        }
      } catch (err) {
        result = `错误: ${err instanceof Error ? err.message : String(err)}`;
      } finally {
        if (callName === "shell") {
          shellCalls.push({
            id: call.id,
            command: typeof args?.command === "string" ? args.command : null,
            result: shellMeta?.shellResult ?? result,
            ...(shellMeta ? { exitCode: shellMeta.exitCode, durationMs: shellMeta.durationMs } : {}),
          });
        }
      }

      messages.push({
        role: "tool",
        tool_call_id: call.id,
        content: smartTruncateToolOutput(result, 12_000),
      });
    }

    if (allowedOpenAiNonRelayCalls > 0 && !relayResetOccurred) {
      state.toolCallsSinceRelay += allowedOpenAiNonRelayCalls;
    }
    state.toolCalls = ctx.usage.toolCalls;
    state.installs = ctx.usage.installs;
    const slot = manifest.workerSlot ?? 0;
    const transcriptFile = slot > 0 ? `openai-transcript-w${slot}.json` : "openai-transcript.json";
    writeFileSync(join(manifest.workspaceDir, transcriptFile), JSON.stringify(messages, null, 2));
    const recordedStep = recordExecutionStep(manifest, {
      number: state.step + 1,
      tools: toolNames,
      tokens: state.tokens,
      phase: state.phase,
      calls: shellCalls,
    });
    state.step = Math.max(state.step, recordedStep);
    ckpt.save(state);
    flushUsage(manifest, ctx, state);
  }
}


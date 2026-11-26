import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  isBudgetHit,
  isExploreLeader,
  isWallHit,
  type WorkerManifest,
} from "@gongyuai/contracts";
import { openHistory } from "@gongyuai/history";
import { startTrafficProxy, type TrafficProxy } from "@gongyuai/exec";
import { CheckpointStore } from "./checkpoint.js";
import { appendProgress, type ToolContext } from "./tools.js";
import { writeWorkerStatus } from "./status.js";
import { writeTerminalReport } from "./report.js";
import { openMcpHub } from "./mcp/client.js";
import { openSkillHub } from "./skills/runtime.js";
import { openFingerprintKnowledgeRag } from "./knowledge-rag.js";
import { listRelayProtocols } from "./relay.js";
import { STALE_INTENT_MAX_AGE_MS } from "./loop-shared.js";
import { tryPiDurable } from "./pi-durable-loop.js";
import { runOpenAiToolLoop } from "./openai-fallback-loop.js";

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
  if (!opts.leader) return "completed";
  const hitGate =
    isBudgetHit(opts.usageToolCalls, opts.budget.maxToolCalls) ||
    isBudgetHit(opts.tokens, opts.budget.maxTokens) ||
    isWallHit(opts.workerStartedAt, opts.budget.maxWallMs) ||
    (opts.lastError != null &&
      /maxWallMs|maxToolCalls|maxTokens|maxInstalls/i.test(opts.lastError));
  return hitGate ? "budget_exhausted" : "incomplete";
}

export async function runPiLoop(manifest: WorkerManifest): Promise<void> {
  const workerStartedAt = Date.now();
  const history = openHistory({
    dbPath: manifest.historyDb,
    evidenceDir: manifest.evidenceDir,
  });
  const ckpt = new CheckpointStore(`${manifest.durableDb}.ckpt.sqlite`);
  const state = ckpt.load();
  state.bootEpoch += 1;
  if (state.lastSoftWallMilestone !== 0) {
    state.lastSoftWallMilestone = 0;
  }
  ckpt.save(state);

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
        tags: ["system", "lifecycle"],
      });
      appendProgress(manifest.workspaceDir, `phase=bootstrap workers=${manifest.workerCount}`);
      state.phase = "bootstrap";
      ckpt.save(state);
    } else if (!leader && (state.phase === "init" || state.phase === "bootstrap")) {
      appendProgress(
        manifest.workspaceDir,
        `phase=explore follower slot=${slot} waiting for leader bootstrap`,
      );
      await waitForLeaderBootstrap(history, manifest.taskId);
      state.phase = "explore";
      ckpt.save(state);
    }

    if (leader) {
      history.expireStaleIntents(manifest.taskId, STALE_INTENT_MAX_AGE_MS, {
        requeue: true,
        maxRequeues: 2,
      });
    }
    const priorRelays = listRelayProtocols(manifest.workspaceDir, slot);
    if (priorRelays.length > 0) {
      appendProgress(
        manifest.workspaceDir,
        `注入既有 Relay ×${priorRelays.length}`,
      );
    }

    const mcpHub = await openMcpHub(manifest, ctx);
    const skillHub = openSkillHub(manifest, history);
    const knowledgeRag = openFingerprintKnowledgeRag(manifest, history);
    let trafficProxy: TrafficProxy | null = null;
    if (process.env.GY_DISABLE_TRAFFIC_PROXY !== "1") {
      try {
        trafficProxy = await startTrafficProxy({
          taskId: manifest.taskId,
          taskDir: manifest.dataDir,
          workerId: manifest.workerId,
          getIntentId: () => state.activeIntentId,
          insecureUpstream: true,
        });
        ctx.proxyEnv = trafficProxy.getProxyEnv();
        ctx.getActiveIntentId = () => state.activeIntentId;
      } catch {
        trafficProxy = null;
      }
    }
    try {
      const started = await tryPiDurable(
        manifest,
        ctx,
        state,
        ckpt,
        mcpHub,
        skillHub,
        workerStartedAt,
        knowledgeRag,
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
          knowledgeRag,
        );
      }
    } finally {
      await trafficProxy?.close().catch(() => {});
      await mcpHub.close();
    }

    const allPass = history.allGoalsPass(manifest.taskId);
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
        /* best-effort on failure path */
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

export {
  consumePendingSoftPace,
  flushUsage,
  maybeSoftPaceMessage,
  poolTurnYieldDirective,
  resolvePiModelRef,
  runExploreTimeoutGate,
  shouldResetFollowerSession,
  shouldWakeMultiWorkerLeader,
  waitForPoolTurn,
} from "./loop-shared.js";
export {
  OBSERVE_FACT_LIMIT,
  buildObserveSnapshot,
  buildTurnObserveBlock,
  piRequestId,
  renderObserveDelta,
  sessionBootstrapText,
  type ObserveSnapshot,
} from "./prompt-builder.js";

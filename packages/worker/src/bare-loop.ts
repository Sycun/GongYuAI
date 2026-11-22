/**
 * True bare OpenAI (or mock) baseline — no History DAG, no Session Relay.
 * Used by `pnpm diff-harness` as the harness-gain control (GY_HARNESS=bare).
 */
import {
  mkdirSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
  isBudgetHit,
  isWallHit,
  type GoalSpec,
  type ShellTraceCall,
  type WorkerManifest,
} from "@gongyuai/contracts";
import { listEvidenceFiles, minimatch, openHistory, collectGoalEvidence, writeTaskReport } from "@gongyuai/history";
import { CheckpointStore } from "./checkpoint.js";
import { assertMockGoals, collectMockBanner, dispatchMockTool } from "./mock-fixture.js";
import { appendProgress, assertCommandAllowed, chargeToolCall, gateTool, writeEvidence, type ToolContext } from "./tools.js";
import { writeWorkerStatus } from "./status.js";
import { recordExecutionStep } from "./execution-trace.js";

function matchingPaths(evidenceDir: string, goal: GoalSpec): string[] {
  const patterns = [...goal.evidencePatterns, ...(goal.evidenceChecks ?? []).map((rule) => rule.pattern)];
  return listEvidenceFiles(evidenceDir).filter((p) => patterns.some((pattern) => minimatch(p, pattern)));
}

function goalSatisfied(evidenceDir: string, goal: GoalSpec): boolean {
  try {
    // 业务核算目标的“缺件”由核算条件判定（并点名缺哪一份材料），这里不抢答。
    collectGoalEvidence(evidenceDir, goal, matchingPaths(evidenceDir, goal), {
      deferPatternsToReconcileGate: Boolean(goal.reconcileGate),
    });
    return true;
  } catch {
    return false;
  }
}

function allGoalsSatisfied(manifest: WorkerManifest): boolean {
  return (
    manifest.goals.length > 0 &&
    manifest.goals.every((g) => goalSatisfied(manifest.evidenceDir, g))
  );
}

/** Scripted fixture with common evaluation and no graph decisions or Relay. */
async function runBareMock(manifest: WorkerManifest): Promise<void> {
  const ckpt = new CheckpointStore(`${manifest.durableDb}.ckpt.sqlite`);
  let state = ckpt.load();
  const history = openHistory({ dbPath: manifest.historyDb, evidenceDir: manifest.evidenceDir });
  history.trackIntegrationCalls(manifest.taskId);
  writeFileSync(
    join(manifest.workspaceDir, "PROGRESS.md"),
    `# Bare baseline\n\ntask ${manifest.taskId}\nmode=bare-mock\n`,
  );
  appendProgress(manifest.workspaceDir, "bare=mock start");

  const ctx: ToolContext = {
    manifest,
    history,
    usage: { toolCalls: state.toolCalls, installs: state.installs },
  };

  writeWorkerStatus(manifest.dataDir, {
    status: "running",
    usage: { tokens: 0, toolCalls: 0, installs: 0 },
  });

  try {
    history.seedGoals(manifest.taskId, manifest.goals);
    dispatchMockTool(ctx, "mock_prepare");
    collectMockBanner(ctx);
    const allPassed = assertMockGoals(ctx);

    writeTaskReport(manifest, history, { status: allPassed ? "completed" : "incomplete" });
    appendProgress(manifest.workspaceDir, "bare=mock done");
    state.phase = "done";
    state.toolCalls = ctx.usage.toolCalls;
    ckpt.save(state);

    writeWorkerStatus(manifest.dataDir, {
      status: allPassed ? "completed" : "incomplete",
      usage: {
        tokens: state.tokens,
        toolCalls: ctx.usage.toolCalls,
        installs: ctx.usage.installs,
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    writeWorkerStatus(manifest.dataDir, {
      status: message === "maxToolCalls exceeded" ? "budget_exhausted" : "failed",
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

type ChatMessage = {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  tool_call_id?: string;
  tool_calls?: unknown[];
};

async function runBareOpenAi(manifest: WorkerManifest): Promise<void> {
  const apiKey = process.env[manifest.model?.apiKeyEnv ?? "OPENAI_API_KEY"];
  if (!apiKey) throw new Error("OPENAI_API_KEY missing for bare harness");

  const baseUrl = (
    manifest.model?.baseUrl ??
    process.env.OPENAI_BASE_URL ??
    "https://api.openai.com/v1"
  ).replace(/\/$/, "");
  const model = manifest.model?.modelId ?? process.env.GY_MODEL ?? "gpt-4.1-mini";

  const ckpt = new CheckpointStore(`${manifest.durableDb}.ckpt.sqlite`);
  let state = ckpt.load();
  mkdirSync(manifest.workspaceDir, { recursive: true });
  mkdirSync(manifest.evidenceDir, { recursive: true });

  const ledger = openHistory({ dbPath: manifest.historyDb, evidenceDir: manifest.evidenceDir });
  ledger.trackIntegrationCalls(manifest.taskId);
  const ctx: ToolContext = {
    manifest,
    history: ledger,
    usage: { toolCalls: state.toolCalls, installs: state.installs },
  };

  writeWorkerStatus(manifest.dataDir, {
    status: "running",
    usage: { tokens: state.tokens, ...ctx.usage },
  });

  const goalsBlurb = manifest.goals
    .map(
      (g) =>
        `- ${g.id}: ${g.title} — need evidence matching ${g.evidencePatterns.join(", ")}`,
    )
    .join("\n");

  const tools = [
    {
      type: "function" as const,
      function: {
        name: "shell",
        description: "Shell execution is unavailable in this baseline. Requests are audited as denied.",
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
        name: "write_evidence",
        description: "Write a file under evidence/",
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
        name: "check_goals",
        description: "Check whether evidence files satisfy all goal patterns",
        parameters: { type: "object", properties: {} },
      },
    },
  ];

  const messages: ChatMessage[] = [
    {
      role: "system",
      content: `You are a bare authorized pentest agent baseline (no History DAG, no Session Relay).
Auth: ${manifest.auth.authorizationNote}
Targets: ${manifest.auth.targets.join(", ")}
Goals:
${goalsBlurb}
Rules: use tools only; write real evidence files; never claim DONE until check_goals says all pass; never mutate host VPN/proxy/routing.`,
    },
    {
      role: "user",
      content: "Complete all goals by writing matching evidence. Call check_goals to verify.",
    },
  ];

  appendProgress(manifest.workspaceDir, "bare=openai loop");
  const started = Date.now();
  const maxRounds =
    manifest.budget.maxToolCalls > 0
      ? Math.max(manifest.budget.maxToolCalls, 20)
      : Number.MAX_SAFE_INTEGER;
  const exhaustedBudget = () => {
    const budget = manifest.budget;
    if (isBudgetHit(ctx.usage.toolCalls, budget.maxToolCalls)) return "maxToolCalls exceeded";
    if (isBudgetHit(state.tokens, budget.maxTokens)) return "maxTokens exceeded";
    if (isBudgetHit(ctx.usage.installs, budget.maxInstalls)) return "maxInstalls exceeded";
    if (isWallHit(started, budget.maxWallMs)) return "maxWallMs exceeded";
  };

  try {
    for (let i = 0; i < maxRounds; i++) {
      if (allGoalsSatisfied(manifest)) break;
      if (exhaustedBudget()) break;

      const res = await fetch(`${baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${apiKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ model, messages, tools, tool_choice: "auto" }),
      });
      if (!res.ok) throw new Error(`model ${res.status}: ${await res.text()}`);
      const data = (await res.json()) as {
        usage?: { total_tokens?: number; prompt_tokens?: number; completion_tokens?: number };
        choices: Array<{
          message: {
            content?: string;
            tool_calls?: Array<{
              id: string;
              function: { name: string; arguments: string };
            }>;
          };
        }>;
      };
      const u = data.usage;
      const delta =
        u?.total_tokens ??
        (u?.prompt_tokens ?? 0) + (u?.completion_tokens ?? 0);
      state.tokens += delta;
      if (exhaustedBudget()) break;
      const msg = data.choices[0]?.message;
      if (!msg) throw new Error("empty model response");
      messages.push({
        role: "assistant",
        content: msg.content ?? "",
        tool_calls: msg.tool_calls,
      });

      if (!msg.tool_calls?.length) {
        if ((msg.content ?? "").includes("DONE") && allGoalsSatisfied(manifest)) break;
        messages.push({
          role: "user",
          content: "Goals incomplete. Continue with tools; use check_goals.",
        });
        continue;
      }

      const shellCalls: ShellTraceCall[] = [];
      for (const call of msg.tool_calls) {
        if (exhaustedBudget()) break;
        let command: string | null = null;
        let result = "";
        try {
          if (call.function.name === "shell") {
            gateTool(ctx, "shell", () => {
              const args = JSON.parse(call.function.arguments || "{}") as Record<string, unknown> | null;
              command = typeof args?.command === "string" ? args.command : null;
              if (!command?.trim()) throw new Error("invalid shell arguments");
              assertCommandAllowed(manifest, command);
              chargeToolCall(ctx);
              // Keep this baseline fail-closed. The ledger only records the denial.
              throw new Error("denied: shell execution is unavailable in the bare baseline");
            }, { callId: call.id });
          } else if (call.function.name === "write_evidence") {
            const args = JSON.parse(call.function.arguments || "{}") as Record<string, string>;
            result = writeEvidence(
              ctx,
              args.relativePath ?? "note.txt",
              args.content ?? "",
            );
          } else if (call.function.name === "check_goals") {
            const rows = manifest.goals.map((g) => ({
              id: g.id,
              ok: goalSatisfied(manifest.evidenceDir, g),
              patterns: g.evidencePatterns,
            }));
            result = JSON.stringify({
              allPass: rows.every((r) => r.ok),
              goals: rows,
              files: listEvidenceFiles(manifest.evidenceDir),
            });
          } else {
            result = `unknown tool ${call.function.name}`;
          }
        } catch (err) {
          result = `error: ${err instanceof Error ? err.message : String(err)}`;
        }
        if (call.function.name === "shell") {
          shellCalls.push({
            id: call.id,
            command,
            result,
          });
        }
        messages.push({
          role: "tool",
          tool_call_id: call.id,
          content: result.slice(0, 4_000),
        });
      }
      recordExecutionStep(manifest, {
        number: i + 1,
        tools: msg.tool_calls.map((call) => call.function.name),
        tokens: state.tokens,
        phase: "bare",
        calls: shellCalls,
      });
      state.toolCalls = ctx.usage.toolCalls;
      ckpt.save(state);
      writeWorkerStatus(manifest.dataDir, {
        status: "running",
        usage: {
          tokens: state.tokens,
          toolCalls: ctx.usage.toolCalls,
          installs: ctx.usage.installs,
        },
      });
      writeFileSync(
        join(manifest.workspaceDir, "openai-transcript.json"),
        JSON.stringify(messages, null, 2),
      );
    }

    const budgetReason = exhaustedBudget();
    ledger.seedGoals(manifest.taskId, manifest.goals);
    for (const goal of manifest.goals) {
      ledger.assertGoal(manifest.taskId, goal.id, matchingPaths(manifest.evidenceDir, goal));
    }
    const status = ledger.allGoalsPass(manifest.taskId)
      ? "completed"
      : budgetReason ? "budget_exhausted" : "incomplete";
    const reason = status === "budget_exhausted" ? budgetReason : undefined;
    writeTaskReport(manifest, ledger, { status, reason });
    state.phase = "done";
    ckpt.save(state);
    writeWorkerStatus(manifest.dataDir, {
      status,
      error: reason,
      usage: {
        tokens: state.tokens,
        toolCalls: ctx.usage.toolCalls,
        installs: ctx.usage.installs,
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
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
    ledger.close();
  }
}

export async function runBareLoop(manifest: WorkerManifest): Promise<void> {
  mkdirSync(manifest.workspaceDir, { recursive: true });
  mkdirSync(manifest.evidenceDir, { recursive: true });
  appendProgress(manifest.workspaceDir, `harness=bare mock=${manifest.mock}`);
  if (manifest.mock) await runBareMock(manifest);
  else await runBareOpenAi(manifest);
}

/** Test helper */
export function bareGoalsPass(manifest: WorkerManifest): boolean {
  return allGoalsSatisfied(manifest);
}

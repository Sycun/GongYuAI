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
import { listEvidenceFiles, minimatch, openHistory, resolveEvidenceFile, validateAllCompleteEvidence } from "@gongyuai/history";
import { CheckpointStore } from "./checkpoint.js";
import { assertMockGoals, collectMockBanner, dispatchMockTool } from "./mock-fixture.js";
import { appendProgress, runShell, writeEvidence, type ToolContext } from "./tools.js";
import { writeWorkerStatus } from "./status.js";
import { formatShellResult, recordExecutionStep } from "./execution-trace.js";

function goalSatisfied(evidenceDir: string, goal: GoalSpec): boolean {
  const files = listEvidenceFiles(evidenceDir);
  for (const pattern of goal.evidencePatterns) {
    const hit = files.find((p) => {
      if (!minimatch(p, pattern)) return false;
      try {
        resolveEvidenceFile(evidenceDir, p);
        return true;
      } catch {
        return false;
      }
    });
    if (!hit) return false;
    if (/(^|\/)ALL_COMPLETE\.json$/i.test(hit)) {
      if (validateAllCompleteEvidence(evidenceDir, hit)) return false;
    }
  }
  return true;
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

    const report = `# GongYuAI Bare Report\n\nTask: ${manifest.taskId}\nMode: bare mock\nGoals satisfied: ${allPassed}\n`;
    writeFileSync(join(manifest.dataDir, "report.md"), report);
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

  const stubHistory = {
    appendFact: () => ({}),
    recordInstall: () => {},
  } as unknown as ToolContext["history"];
  const ctx: ToolContext = {
    manifest,
    history: stubHistory,
    usage: { toolCalls: state.toolCalls, installs: state.installs },
  };

  writeWorkerStatus(manifest.dataDir, {
    status: "running",
    usage: { tokens: state.tokens, toolCalls: 0, installs: 0 },
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

  try {
    for (let i = 0; i < maxRounds; i++) {
      if (allGoalsSatisfied(manifest)) break;
      if (isBudgetHit(ctx.usage.toolCalls, manifest.budget.maxToolCalls)) break;
      if (isBudgetHit(state.tokens, manifest.budget.maxTokens)) break;
      if (isWallHit(started, manifest.budget.maxWallMs)) break;

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
        const args = JSON.parse(call.function.arguments || "{}") as Record<string, string>;
        let result = "";
        let shellResult: string | undefined;
        try {
          if (call.function.name === "shell") {
            const output = runShell(ctx, args.command ?? "");
            result = JSON.stringify(output);
            shellResult = formatShellResult(output);
          } else if (call.function.name === "write_evidence") {
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
            command: typeof args?.command === "string" ? args.command : null,
            result: shellResult ?? result,
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

    writeFileSync(
      join(manifest.dataDir, "report.md"),
      `# GongYuAI Bare Report\n\nTask: ${manifest.taskId}\nMode: bare OpenAI\nPass: ${allGoalsSatisfied(manifest)}\n`,
    );
    state.phase = "done";
    ckpt.save(state);
    writeWorkerStatus(manifest.dataDir, {
      status: allGoalsSatisfied(manifest) ? "completed" : "incomplete",
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

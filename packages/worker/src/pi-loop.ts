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
        `# Progress\n\nPi worker initializer for ${manifest.taskId}\n`,
      );
      history.seedGoals(manifest.taskId, manifest.goals);
      history.appendFact({
        taskId: manifest.taskId,
        layer: "title",
        title: "Pi worker started",
        summary: `targets=${manifest.auth.targets.join(",")}`,
      });
      appendProgress(manifest.workspaceDir, "initializer complete");
      state.phase = "loop";
      ckpt.save(state);
    }

    const started = await tryPiDurable(manifest, ctx, state, ckpt);
    if (!started) {
      await runOpenAiToolLoop(manifest, ctx, state, ckpt);
    }

    const report = `# GongYuAI Report\n\n${history.overview(manifest.taskId)}\n`;
    writeFileSync(join(manifest.dataDir, "report.md"), report);
    history.recordReport(manifest.taskId, "report.md");
    state.phase = "done";
    ckpt.save(state);

    const exhausted = ctx.usage.toolCalls >= manifest.budget.maxToolCalls;
    writeWorkerStatus(manifest.dataDir, {
      status: exhausted && !history.allGoalsPass(manifest.taskId) ? "budget_exhausted" : "completed",
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

async function tryPiDurable(
  manifest: WorkerManifest,
  ctx: ToolContext,
  state: CheckpointState,
  ckpt: CheckpointStore,
): Promise<boolean> {
  try {
    const { BACKGROUND_CONTEXT } = await import("@earendil-works/chord/context");
    const { createModels } = await import("@earendil-works/pi-ai/models");
    const { openaiProvider } = await import("@earendil-works/pi-ai/providers/openai");
    const durable = await import("@earendil-works/pi-durable");
    const { openNodeSqliteStorage } = await import(
      "@earendil-works/pi-durable/storage/sqlite/node"
    );
    const schema = await import("@earendil-works/pi-schema");

    const apiKey = process.env[manifest.model?.apiKeyEnv ?? "OPENAI_API_KEY"];
    if (!apiKey) return false;

    const context = BACKGROUND_CONTEXT;
    const models = createModels();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (models as any).setProvider(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (openaiProvider as any)({
        apiKey,
        baseURL: manifest.model?.baseUrl ?? process.env.OPENAI_BASE_URL,
      }),
    );

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
        ],
        sections: [
          section(
            "gongyuai-system",
            () => systemPrompt(manifest, ctx.history.overview(manifest.taskId)),
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
          provider: "openai",
          modelId: manifest.model?.modelId ?? process.env.GY_MODEL ?? "gpt-4.1-mini",
        },
      },
    });
    harness.resume();

    const prompt = [
      "You are GongYuAI, an AI-native authorized pentest worker.",
      "Complete all FAIL goals using tools. Never claim pass without assert_goal succeeding.",
      "Stay inside auth.targets. Prefer small incremental intents.",
      "When all goals pass, reply DONE.",
      "",
      ctx.history.overview(manifest.taskId),
    ].join("\n");

    const submission = await root.submit(
      { type: "input", content: prompt, requestId: `gy-${manifest.taskId}-main` },
      context,
    );
    const settled = await submission.wait(context);
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
    return true;
  } catch (err) {
    appendProgress(
      manifest.workspaceDir,
      `pi-durable unavailable, falling back: ${err instanceof Error ? err.message : String(err)}`,
    );
    return false;
  }
}

function systemPrompt(manifest: WorkerManifest, overview: string): string {
  const visionOn = manifest.model?.visionEnabled !== false;
  const visionLine = visionOn
    ? `- Vision enabled (Pi image input). Prefer visionModelId=${manifest.model?.visionModelId || manifest.model?.modelId || "default"} for screenshots/UI evidence when available.`
    : `- Vision disabled; do not rely on image understanding.`;
  return `GongYuAI authorized pentest worker.
Authorization: ${manifest.auth.authorizationNote}
Targets: ${manifest.auth.targets.join(", ")}
Out of scope: ${manifest.auth.outOfScope.join(", ") || "(none)"}

Rules:
- Use tools; do not invent evidence.
- assert_goal requires real evidence files.
- install_tool when a binary is missing.
- Keep History updated with title/summary/evidence facts.
${visionLine}

Current History:
${overview}
`;
}

type ChatMessage = {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  tool_call_id?: string;
  tool_calls?: unknown[];
};

async function runOpenAiToolLoop(
  manifest: WorkerManifest,
  ctx: ToolContext,
  state: CheckpointState,
  ckpt: CheckpointStore,
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

  const tools = [
    {
      type: "function",
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
      type: "function",
      function: {
        name: "history_overview",
        description: "Read History overview",
        parameters: { type: "object", properties: {} },
      },
    },
    {
      type: "function",
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
      type: "function",
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
      type: "function",
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
      type: "function",
      function: {
        name: "assert_goal",
        description: "Evidence-gated goal pass",
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
  ];

  const messages: ChatMessage[] = [
    { role: "system", content: systemPrompt(manifest, ctx.history.overview(manifest.taskId)) },
    {
      role: "user",
      content:
        "Complete all FAIL goals. Use tools. When finished and all goals pass, reply with DONE.",
    },
  ];

  for (let i = 0; i < 40; i++) {
    if (ctx.history.allGoalsPass(manifest.taskId)) break;
    if (ctx.usage.toolCalls >= manifest.budget.maxToolCalls) break;

    const res = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
        "user-agent": "GongYuAI/0.1",
      },
      body: JSON.stringify({
        model,
        messages,
        tools,
        tool_choice: "auto",
      }),
    });
    if (!res.ok) {
      throw new Error(`openai error ${res.status}: ${await res.text()}`);
    }
    const data = (await res.json()) as {
      usage?: { total_tokens?: number };
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
    state.tokens += data.usage?.total_tokens ?? 0;
    const msg = data.choices[0]?.message;
    if (!msg) throw new Error("empty completion");

    messages.push({
      role: "assistant",
      content: msg.content ?? "",
      tool_calls: msg.tool_calls,
    });

    if (!msg.tool_calls?.length) {
      if ((msg.content ?? "").includes("DONE")) break;
      messages.push({
        role: "user",
        content: "Continue with tools until goals pass, then DONE.",
      });
      continue;
    }

    for (const call of msg.tool_calls) {
      const args = JSON.parse(call.function.arguments || "{}") as Record<string, string>;
      let result = "";
      try {
        switch (call.function.name) {
          case "shell":
            result = JSON.stringify(runShell(ctx, args.command ?? ""));
            break;
          case "history_overview":
            result = ctx.history.overview(manifest.taskId);
            break;
          case "write_evidence":
            result = writeEvidence(ctx, args.relativePath ?? "note.txt", args.content ?? "");
            break;
          case "history_append_fact":
            result = JSON.stringify(
              ctx.history.appendFact({
                taskId: manifest.taskId,
                layer: (args.layer as "title" | "summary" | "evidence") ?? "summary",
                title: args.title ?? "untitled",
                summary: args.summary ?? "",
                evidencePath: args.evidencePath || null,
              }),
            );
            break;
          case "install_tool":
            result = JSON.stringify(
              installTool(ctx, { name: args.name ?? "", package: args.package }),
            );
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
            break;
          default:
            result = `unknown tool ${call.function.name}`;
        }
      } catch (err) {
        result = `error: ${err instanceof Error ? err.message : String(err)}`;
      }
      messages.push({
        role: "tool",
        tool_call_id: call.id,
        content: result.slice(0, 12_000),
      });
    }

    state.toolCalls = ctx.usage.toolCalls;
    state.installs = ctx.usage.installs;
    ckpt.save(state);
    writeFileSync(join(manifest.workspaceDir, "openai-transcript.json"), JSON.stringify(messages, null, 2));
    appendProgress(manifest.workspaceDir, `openai step ${i + 1}`);
  }
}

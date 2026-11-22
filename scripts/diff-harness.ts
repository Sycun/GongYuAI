/**
 * P3 harness differential.
 *
 * Runs the same goals/budget under three modes and prints a relative table
 * (never absolute myth scores):
 *   bare     — thin OpenAI/mock loop without History/Relay (GY_HARNESS=bare)
 *   history  — History DAG with Relay disabled in mock mode
 *   relay    — History DAG with a scripted Relay in mock mode
 *
 * Usage:
 *   pnpm tsx scripts/diff-harness.ts --goals examples/dvwa-smoke/goals.json \
 *     --target http://127.0.0.1 --auth "lab note……" --mock
 *
 * Real TSecBench: drop --mock, set OPENAI_API_KEY, VPN up; compare subsets only.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { CreateTaskRequestSchema, isTerminalTaskStatus, type TaskRecord } from "@gongyuai/contracts";
import { bootControlPlane } from "@gongyuai/control-plane";

type Mode = "bare" | "history" | "relay";
type RunResult = {
  mode: Mode;
  status: string;
  tokens: number;
  toolCalls: number;
  mock?: { goalsPassed: number; goalsTotal: number; relayEvents: number; relayFiles: number };
};

function flag(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}

async function waitTask(
  url: string,
  taskId: string,
  timeoutMs: number,
): Promise<{ status: string; task: TaskRecord }> {
  const start = Date.now();
  for (;;) {
    const { task } = (await (await fetch(`${url}/tasks/${taskId}`)).json()) as { task: TaskRecord };
    if (isTerminalTaskStatus(task.status)) {
      return { status: task.status, task };
    }
    if (Date.now() - start > timeoutMs) {
      return { status: "timeout", task };
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
}

async function runMode(
  mode: Mode,
  opts: {
    goals: unknown;
    target: string;
    auth: string;
    mock: boolean;
    dataRoot: string;
    port: number;
  },
): Promise<RunResult> {
  const previousMockRelay = process.env.GY_MOCK_RELAY;
  process.env.GY_ALLOW_STUB_INSTALL = "1";
  if (mode === "bare") {
    process.env.GY_HARNESS = "bare";
  } else {
    delete process.env.GY_HARNESS;
  }
  if (opts.mock) process.env.GY_MOCK_RELAY = mode === "relay" ? "on" : "off";
  const lowThreshold = !opts.mock && mode === "relay";
  if (lowThreshold) {
    process.env.GY_RELAY_TOKEN_THRESHOLD = "1";
    process.env.GY_RELAY_MIN_TOOL_CALLS = "1";
  } else {
    delete process.env.GY_RELAY_TOKEN_THRESHOLD;
    delete process.env.GY_RELAY_MIN_TOOL_CALLS;
  }

  const plane = await bootControlPlane({
    dataRoot: opts.dataRoot,
    host: "127.0.0.1",
    port: opts.port,
    runtime: "local",
    leaseMs: 8_000,
    watchdogMs: 1_500,
  });
  try {
    const body = CreateTaskRequestSchema.parse({
      name: `diff-${mode}`,
      mock: opts.mock,
      auth: {
        authorizationNote: opts.auth,
        targets: [opts.target],
        outOfScope: [],
        capability: "full",
      },
      goals: opts.goals,
      budget: {
        maxTokens: 200_000,
        maxWallMs: 180_000,
        maxToolCalls: 80,
        maxInstalls: 10,
        relayTokenThreshold: lowThreshold ? 1 : 30_000,
        relayMinToolCalls: lowThreshold ? 1 : 2,
      },
    });
    const response = await fetch(`${plane.url}/tasks`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!response.ok) throw new Error(`cannot start ${mode}: ${await response.text()}`);
    const { task: created } = (await response.json()) as { task: TaskRecord };
    const { status, task } = await waitTask(plane.url, created.id, 120_000);
    const result: RunResult = {
      mode,
      status,
      tokens: task.usage.tokens,
      toolCalls: task.usage.toolCalls,
    };
    if (opts.mock) {
      if (status === "timeout") await plane.runner.stop(task.id);
      const history = (await (await fetch(`${plane.url}/tasks/${task.id}/history`)).json()) as {
        events: Array<{ kind: string }>;
      };
      const relayDir = join(task.dataDir, "workspace", "relay");
      result.mock = {
        goalsPassed: task.goals.filter((goal) => goal.passes).length,
        goalsTotal: task.goals.length,
        relayEvents: history.events.filter((event) => event.kind === "relay_written").length,
        relayFiles: existsSync(relayDir)
          ? readdirSync(relayDir).filter((file) => /^(π|pi)\d+\.json$/iu.test(file)).length
          : 0,
      };
    }
    return result;
  } finally {
    await plane.close();
    delete process.env.GY_HARNESS;
    if (previousMockRelay === undefined) delete process.env.GY_MOCK_RELAY;
    else process.env.GY_MOCK_RELAY = previousMockRelay;
  }
}

function checkMockResults(rows: RunResult[]): void {
  for (const row of rows) {
    const stats = row.mock!;
    const relayExpected = row.mode === "relay" ? 1 : 0;
    if (stats.relayEvents !== relayExpected || stats.relayFiles !== relayExpected) {
      throw new Error(`${row.mode}: unexpected number of mock Relay events or files`);
    }
    if (row.status !== "completed" || stats.goalsPassed !== stats.goalsTotal) {
      throw new Error(`${row.mode}: mock fixture goals did not pass`);
    }
    if (row.toolCalls !== 2 || row.tokens !== 0) {
      throw new Error(`${row.mode}: unexpected synthetic tool count or token usage`);
    }
  }
}

async function main() {
  const argv = process.argv.slice(2);
  const goalsPath = flag(argv, "--goals");
  const target = flag(argv, "--target") ?? "https://example.com";
  const auth =
    flag(argv, "--auth") ?? "Written authorization: diff-harness owned by operator";
  const mock = argv.includes("--mock");
  const modes = (
    argv.includes("--modes")
      ? (flag(argv, "--modes") ?? "bare,history,relay").split(",")
      : (["bare", "history", "relay"] as Mode[])
  )
    .map((s) => s.trim())
    .filter((s): s is Mode => s === "bare" || s === "history" || s === "relay");

  if (!goalsPath) {
    console.error(
      "usage: diff-harness --goals FILE [--target URL] [--auth NOTE] [--mock] [--modes bare,history,relay]",
    );
    process.exit(2);
  }
  if (modes.length === 0) throw new Error("no recognized differential modes");
  const goals = JSON.parse(readFileSync(resolve(goalsPath), "utf8"));
  const basePort = 8801;
  const rows = [];
  for (const [i, mode] of modes.entries()) {
    const dataRoot = resolve(`.gongyuai/diff-${mode}-${Date.now()}`);
    console.error(`[diff] running mode=${mode}…`);
    rows.push(
      await runMode(mode, {
        goals,
        target,
        auth,
        mock,
        dataRoot,
        port: basePort + i,
      }),
    );
  }

  console.log(mock ? "\n# GongYuAI mock differential\n" : "\n# GongYuAI harness differential (relative only)\n");
  console.log(`| mode | status | tokens | toolCalls |${mock ? " goals | relay events | relay files |" : ""}`);
  console.log(`| --- | --- | ---: | ---: |${mock ? " ---: | ---: | ---: |" : ""}`);
  for (const r of rows) {
    const stats = r.mock;
    const metrics = stats ? ` ${stats.goalsPassed}/${stats.goalsTotal} | ${stats.relayEvents} | ${stats.relayFiles} |` : "";
    console.log(`| ${r.mode} | ${r.status} | ${r.tokens} | ${r.toolCalls} |${metrics}`);
  }
  if (mock) {
    checkMockResults(rows);
    console.log("\nMock fixture PASS. Tokens are unmeasured. toolCalls counts the two synthetic tool dispatches.");
    return;
  }
  console.log(
    "\n`bare` = GY_HARNESS=bare (no History DAG / no Session Relay). Report deltas only.",
  );
  console.log("TSecBench: drop --mock, fix budget, VPN up; never batch hint.\n");
}

main().catch((err) => {
  console.error("[diff] FAIL", err);
  process.exit(1);
});

/**
 * P3 harness differential scaffold.
 *
 * Runs the same goals/budget under three modes and prints a relative table
 * (never absolute myth scores):
 *   bare     — thin OpenAI tool loop without History/Relay (GY_HARNESS=bare)
 *   history  — GongYuAI History DAG (default mock/real worker)
 *   relay    — History + forced low relay threshold
 *
 * Usage:
 *   pnpm tsx scripts/diff-harness.ts --goals examples/dvwa-smoke/goals.json \
 *     --target http://127.0.0.1 --auth "lab note……" --mock
 *
 * Real TSecBench: drop --mock, set OPENAI_API_KEY, VPN up; compare subsets only.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { CreateTaskRequestSchema } from "@gongyuai/contracts";
import { bootControlPlane } from "@gongyuai/control-plane";

type Mode = "bare" | "history" | "relay";

function flag(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}

async function waitTask(
  url: string,
  taskId: string,
  timeoutMs: number,
): Promise<{ status: string; usage: { tokens: number; toolCalls: number } }> {
  const start = Date.now();
  for (;;) {
    const st = (await (await fetch(`${url}/tasks/${taskId}`)).json()) as {
      task: {
        status: string;
        usage: { tokens: number; toolCalls: number };
      };
    };
    if (["completed", "failed", "budget_exhausted", "stopped"].includes(st.task.status)) {
      return { status: st.task.status, usage: st.task.usage };
    }
    if (Date.now() - start > timeoutMs) {
      return { status: "timeout", usage: st.task.usage };
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
): Promise<{ mode: Mode; status: string; tokens: number; toolCalls: number }> {
  process.env.GY_ALLOW_STUB_INSTALL = "1";
  if (mode === "relay") {
    process.env.GY_RELAY_TOKEN_THRESHOLD = "1";
    process.env.GY_RELAY_MIN_TOOL_CALLS = "1";
  } else {
    delete process.env.GY_RELAY_TOKEN_THRESHOLD;
    delete process.env.GY_RELAY_MIN_TOOL_CALLS;
  }
  // bare: still uses GongYuAI worker mock today — documented as "History off" aspiration;
  // report labels make the comparison intent clear until a true bare loop lands.
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
        relayTokenThreshold: mode === "relay" ? 1 : 30_000,
        relayMinToolCalls: mode === "relay" ? 1 : 2,
      },
    });
    const created = (await (
      await fetch(`${plane.url}/tasks`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      })
    ).json()) as { task: { id: string } };
    const result = await waitTask(plane.url, created.task.id, 120_000);
    return {
      mode,
      status: result.status,
      tokens: result.usage.tokens,
      toolCalls: result.usage.toolCalls,
    };
  } finally {
    await plane.close();
  }
}

async function main() {
  const argv = process.argv.slice(2);
  const goalsPath = flag(argv, "--goals");
  const target = flag(argv, "--target") ?? "https://example.com";
  const auth =
    flag(argv, "--auth") ?? "Written authorization: diff-harness owned by operator";
  const mock = argv.includes("--mock");
  if (!goalsPath) {
    console.error("usage: diff-harness --goals FILE [--target URL] [--auth NOTE] [--mock]");
    process.exit(2);
  }
  const goals = JSON.parse(readFileSync(resolve(goalsPath), "utf8"));
  const basePort = 8801;
  const rows = [];
  for (const [i, mode] of (["history", "relay"] as Mode[]).entries()) {
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

  console.log("\n# GongYuAI harness differential (relative only)\n");
  console.log("| mode | status | tokens | toolCalls |");
  console.log("| --- | --- | ---: | ---: |");
  for (const r of rows) {
    console.log(`| ${r.mode} | ${r.status} | ${r.tokens} | ${r.toolCalls} |`);
  }
  console.log(
    "\nNote: `bare` OpenAI-only loop is not yet a separate binary; compare History vs +Relay first.",
  );
  console.log("TSecBench: drop --mock, fix budget, report deltas only.\n");
}

main().catch((err) => {
  console.error("[diff] FAIL", err);
  process.exit(1);
});

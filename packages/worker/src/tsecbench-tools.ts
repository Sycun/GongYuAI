import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ToolContext } from "./tools.js";
import { chargeToolCall, gateTool } from "./tools.js";

/**
 * TSecBench 平台一等工具：list / start / submit / close / status。
 * 直连 Challenges API（不依赖 pnpm），凭据读 <installRoot>/.gongyuai/tsecbench/env。
 * 真实题目入口只能来自 start 返回的 container_addr；预检地址不是攻击目标。
 */
function creds(ctx: ToolContext): { base: string; token: string } {
  const installRoot = dirname(dirname(ctx.manifest.dataDir));
  const envPath = join(installRoot, "tsecbench", "env");
  let base = process.env.BENCHMARK_BASE_URL ?? "";
  let token = process.env.BENCHMARK_TOKEN ?? "";
  if (existsSync(envPath)) {
    for (const line of readFileSync(envPath, "utf8").split("\n")) {
      const i = line.indexOf("=");
      if (i < 0) continue;
      const k = line.slice(0, i).trim();
      const v = line.slice(i + 1).trim();
      if (k === "BENCHMARK_BASE_URL" && !base) base = v;
      if (k === "BENCHMARK_TOKEN" && !token) token = v;
    }
  }
  if (!base || !token) throw new Error("missing BENCHMARK_BASE_URL/BENCHMARK_TOKEN (tsecbench/env)");
  return { base: base.replace(/\/+$/, ""), token };
}

async function api(
  ctx: ToolContext,
  method: "GET" | "POST",
  path: string,
  opts?: { query?: Record<string, string>; body?: unknown },
): Promise<{ status: number; text: string }> {
  const { base, token } = creds(ctx);
  const url = new URL(base + path);
  for (const [k, v] of Object.entries(opts?.query ?? {})) url.searchParams.set(k, v);
  const res = await fetch(url, {
    method,
    headers: { BENCHMARK_TOKEN: token, ...(opts?.body ? { "content-type": "application/json" } : {}) },
    body: opts?.body ? JSON.stringify(opts.body) : undefined,
    signal: AbortSignal.timeout(30_000),
  });
  return { status: res.status, text: await res.text() };
}

export async function tsecbenchTool(
  ctx: ToolContext,
  args: { action: string; code?: string; flag?: string },
): Promise<string> {
  gateTool(ctx, "tsecbench", () => {
    chargeToolCall(ctx);
  });
  const action = (args.action ?? "list").trim();
  const code = (args.code ?? "").trim();
  if (action === "list" || action === "status") {
    const r = await api(ctx, "GET", "/openapi/v1/challenges");
    if (r.status >= 400) return JSON.stringify({ error: r.text.slice(0, 500) });
    const list = JSON.parse(r.text) as Array<Record<string, unknown>>;
    if (action === "status" && code) {
      return JSON.stringify(list.find((c) => c.unique_code === code) ?? { error: "challenge_not_found" });
    }
    return JSON.stringify(list.map((c) => ({
      code: c.unique_code, difficulty: c.difficulty, score: c.total_score,
      flags: `${c.correct_flag_count}/${c.flag_count}`, done: c.is_completed,
      status: c.container_status, addr: c.container_addr,
    })));
  }
  if (!code) return JSON.stringify({ error: "code required for start/submit/close" });
  if (action === "start") {
    const r = await api(ctx, "POST", "/openapi/v1/challenges/start", { query: { unique_code: code } });
    return r.text.slice(0, 2000);
  }
  if (action === "close") {
    const r = await api(ctx, "POST", "/openapi/v1/challenges/close", { query: { unique_code: code } });
    return r.text.slice(0, 2000);
  }
  if (action === "submit") {
    const flag = (args.flag ?? "").trim();
    if (!flag) return JSON.stringify({ error: "flag required" });
    const r = await api(ctx, "POST", "/openapi/v1/challenges/submit", { body: { unique_code: code, flag } });
    return r.text.slice(0, 2000);
  }
  return JSON.stringify({ error: `unknown action ${action}` });
}
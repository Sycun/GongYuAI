import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { targetAllows } from "@gongyuai/contracts";
import { writeEvidenceFile } from "@gongyuai/history";
import { promoteTrafficForFinding, trafficLabelUuid } from "@gongyuai/exec";
import type { ToolContext } from "./tools.js";
import { appendProgress, chargeToolCall, gateTool } from "./tools.js";

/**
 * TSecBench 平台一等工具：list / start / submit / close / status。
 * 直连 Challenges API（不依赖 pnpm），凭据读 <installRoot>/.gongyuai/tsecbench/env。
 *
 * 环境自观测（Zero-Tax Telemetry）：
 * - list / status / start 返回非空 `container_addr` 时，自动将容器主机并入运行态 `auth.targets`
 *   （平台开出的靶机天然属于本任务授权目标）并自动写入 `live` 资产 Fact，免去手工 `asset_record` 与越界误拦；
 * - submit 命中正确 flag 时自动落盘 `evidence/tsecbench/<code>-submit.json`，直接给出可复核 `evidencePath`。
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

/** Extract host and full endpoint tokens from `container_addr` strings (URLs, host:port, comma/space lists). */
export function parseContainerAddresses(raw: unknown): Array<{ endpoint: string; host: string }> {
  if (typeof raw !== "string" || !raw.trim()) return [];
  const out: Array<{ endpoint: string; host: string }> = [];
  const seen = new Set<string>();
  const parts = raw
    .split(/[,;\s]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  for (const part of parts) {
    let cleaned = part.replace(/^["'`]+|["'`]+$/g, "");
    if (!cleaned) continue;
    let host = cleaned.replace(/^[a-z][a-z0-9+.-]*:\/\//i, "");
    host = host.split("/")[0] ?? host;
    host = host.replace(/^\[|\]$/g, "");
    const m = /^([^:\s]+)(?::\d+)?$/.exec(host);
    if (!m?.[1]) continue;
    const h = m[1].toLowerCase();
    if (!h || h === "0.0.0.0") continue;
    if (!/^(?:\d{1,3}(?:\.\d{1,3}){3}|[a-z0-9.-]+\.[a-z]{2,})$/i.test(h)) continue;
    const key = `${cleaned}::${h}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ endpoint: cleaned, host: h });
  }
  return out;
}

/** Container hosts seen per challenge code (start/list/status), for solve-traffic capture. */
const challengeHosts = new Map<string, string[]>();
let lastChallengeHost: string | null = null;

/** Platform says the flag was right (`correct: true`, top-level or under `data`). */
export function submitCorrect(response: unknown): boolean {
  if (!response || typeof response !== "object") return false;
  const top = response as Record<string, unknown>;
  if (top.correct === true) return true;
  const data = top.data;
  return !!data && typeof data === "object" && (data as Record<string, unknown>).correct === true;
}

/**
 * Correct flag: persist the traffic window around the solve under the stable
 * label `tsecbench:<code>` (as a UUID so it fits finding_ids). Matches the
 * active Intent or the challenge container host. Best-effort.
 */
export function captureSolveTraffic(
  ctx: ToolContext,
  code: string,
): { label: string; findingId: string; trafficIds: string[]; promoted: number } | null {
  const intentId = ctx.getActiveIntentId?.() ?? null;
  const hosts = challengeHosts.get(code) ?? (lastChallengeHost ? [lastChallengeHost] : []);
  if (!intentId && hosts.length === 0) return null;
  const label = `tsecbench:${code}`;
  const findingId = trafficLabelUuid(label);
  try {
    const ids = new Set<string>();
    let promoted = 0;
    const targets = hosts.length ? hosts : [null];
    for (const host of targets) {
      const res = promoteTrafficForFinding(ctx.manifest.dataDir, { findingId, intentId, host });
      res.trafficIds.forEach((id) => ids.add(id));
      promoted += res.promoted;
    }
    if (ids.size) {
      try {
        appendProgress(ctx.manifest.workspaceDir, `tsecbench solve ${code} → traffic kept ×${ids.size} (${label})`);
      } catch {
        /* progress log is best-effort */
      }
    }
    return { label, findingId, trafficIds: [...ids], promoted };
  } catch {
    return null;
  }
}

/** Auto-admit started challenge container hosts into manifest scope & History asset ledger. */
export function autoAdmitContainerTargets(
  ctx: ToolContext,
  code: string,
  addrRaw: unknown,
): Array<{ address: string; factId: string }> {
  const parsed = parseContainerAddresses(addrRaw);
  if (!parsed.length) return [];
  if (code) challengeHosts.set(code, [...new Set(parsed.map((p) => p.host))]);
  lastChallengeHost = parsed[0]?.host ?? lastChallengeHost;
  let scopeChanged = false;
  for (const { host } of parsed) {
    if (!targetAllows(ctx.manifest.auth.targets, host, ctx.manifest.auth.outOfScope ?? [])) {
      ctx.manifest.auth.targets.push(host);
      scopeChanged = true;
    }
  }
  if (scopeChanged) {
    const slot = ctx.manifest.workerSlot ?? 0;
    const manifestPath = join(
      ctx.manifest.dataDir,
      slot === 0 ? "manifest.json" : `manifest-w${slot}.json`,
    );
    if (existsSync(manifestPath)) {
      try {
        writeFileSync(manifestPath, JSON.stringify(ctx.manifest, null, 2));
      } catch {
        /* best-effort manifest sync */
      }
    }
    // Sync dynamically admitted target hosts via generic control-plane sidecar.
    try {
      const dynPath = join(ctx.manifest.dataDir, "admitted-targets.json");
      const existing: string[] = existsSync(dynPath)
        ? (JSON.parse(readFileSync(dynPath, "utf8")) as string[])
        : [];
      const merged = [...new Set([...existing, ...parsed.map((p) => p.host)])];
      writeFileSync(dynPath, JSON.stringify(merged, null, 2));
    } catch {
      /* best-effort */
    }
  }
  const admitted: Array<{ address: string; factId: string }> = [];
  for (const { endpoint } of parsed) {
    try {
      const rec = ctx.history.recordAsset({
        taskId: ctx.manifest.taskId,
        address: endpoint,
        auth: ctx.manifest.auth,
        live: true,
        source: "discover",
        summary: `TSecBench 靶机容器 (${code || "challenge"})`,
      });
      admitted.push({ address: rec.asset.address, factId: rec.fact.id });
    } catch {
      /* ignore non-fatal history write error in unit mocks */
    }
  }
  return admitted;
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
    for (const c of list) {
      if (c.container_addr) {
        autoAdmitContainerTargets(ctx, String(c.unique_code ?? ""), c.container_addr);
      }
    }
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
    let admitted: Array<{ address: string; factId: string }> = [];
    try {
      const parsed = JSON.parse(r.text) as Record<string, unknown>;
      const addr = parsed.container_addr ?? (parsed.data as Record<string, unknown> | undefined)?.container_addr;
      if (addr) admitted = autoAdmitContainerTargets(ctx, code, addr);
      if (admitted.length) {
        appendProgress(
          ctx.manifest.workspaceDir,
          `tsecbench start ${code} → auto-admitted ${admitted.map((a) => `${a.address}(fact=${a.factId})`).join(", ")}`,
        );
        return JSON.stringify({ ...parsed, autoAdmittedAssets: admitted });
      }
    } catch {
      /* non-JSON response falls through */
    }
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
    if (r.status < 400) {
      try {
        const safeCode = code.replace(/[^a-zA-Z0-9_.-]/g, "_").slice(0, 80) || "challenge";
        const relPath = `tsecbench/${safeCode}-submit.json`;
        writeEvidenceFile(
          ctx.manifest.evidenceDir,
          relPath,
          JSON.stringify({ code, submittedAt: new Date().toISOString(), status: r.status, response: r.text }, null, 2),
        );
        const response = JSON.parse(r.text) as unknown;
        const traffic = submitCorrect(response) ? captureSolveTraffic(ctx, code) : null;
        return JSON.stringify({
          status: r.status,
          evidencePath: relPath,
          response,
          ...(traffic ? { traffic } : {}),
        });
      } catch {
        /* fall through to raw text */
      }
    }
    return r.text.slice(0, 2000);
  }
  return JSON.stringify({ error: `unknown action ${action}` });
}

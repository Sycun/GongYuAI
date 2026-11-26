import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { isExploreLeader, targetAllows } from "@gongyuai/contracts";
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

/**
 * Extract host and full endpoint tokens from `container_addr` payloads
 * (OpenAPI `string[]`, URLs, `host:port`, comma/space lists, or object wrappers).
 */
export function parseContainerAddresses(raw: unknown): Array<{ endpoint: string; host: string }> {
  const parts: string[] = [];
  const collect = (val: unknown): void => {
    if (typeof val === "string") {
      const trimmed = val.trim();
      if (!trimmed) return;
      if (trimmed.startsWith("[") && trimmed.endsWith("]") && /["']/.test(trimmed)) {
        try {
          const parsedJson = JSON.parse(trimmed) as unknown;
          if (Array.isArray(parsedJson)) {
            for (const item of parsedJson) collect(item);
            return;
          }
        } catch {
          /* fall through to literal token split */
        }
      }
      for (const token of trimmed.split(/[,;\s]+/)) {
        if (token.trim()) parts.push(token.trim());
      }
      return;
    }
    if (Array.isArray(val)) {
      for (const item of val) collect(item);
      return;
    }
    if (val && typeof val === "object") {
      const rec = val as Record<string, unknown>;
      for (const key of ["addr", "address", "url", "endpoint", "host"]) {
        if (rec[key] !== undefined) collect(rec[key]);
      }
    }
  };
  collect(raw);
  if (!parts.length) return [];

  const out: Array<{ endpoint: string; host: string }> = [];
  const seen = new Set<string>();
  for (const part of parts) {
    const cleaned = part.replace(/^["'`]+|["'`]+$/g, "");
    if (!cleaned) continue;
    let hostPart = cleaned.replace(/^[a-z][a-z0-9+.-]*:\/\//i, "");
    hostPart = hostPart.split("/")[0] ?? hostPart;
    let h = "";
    const ipv6 = /^\[([0-9a-f:]+)\](?::\d+)?$/i.exec(hostPart);
    if (ipv6?.[1]) {
      h = ipv6[1].toLowerCase();
      if (h === "::") continue;
    } else {
      hostPart = hostPart.replace(/^\[|\]$/g, "");
      const m = /^([^:\s]+)(?::\d+)?$/.exec(hostPart);
      if (!m?.[1]) continue;
      h = m[1].toLowerCase();
      if (!h || h === "0.0.0.0") continue;
      if (!/^(?:\d{1,3}(?:\.\d{1,3}){3}|localhost|[a-z0-9.-]+\.[a-z]{2,})$/i.test(h)) continue;
    }
    const key = `${cleaned}::${h}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ endpoint: cleaned, host: h });
  }
  return out;
}

/** Container hosts seen per challenge code (start/list/status), synced via sidecar across worker processes. */
const challengeHosts = new Map<string, string[]>();
let lastChallengeHost: string | null = null;

function persistChallengeHosts(dataDir: string, code: string, hosts: string[]): void {
  if (!dataDir || !code || !hosts.length) return;
  const mapPath = join(dataDir, "tsecbench-hosts.json");
  try {
    const existing: Record<string, string[]> = existsSync(mapPath)
      ? (JSON.parse(readFileSync(mapPath, "utf8")) as Record<string, string[]>)
      : {};
    // Replace rather than union so recycled container IPs from an earlier run of `code` are dropped on restart.
    existing[code] = [...new Set(hosts)];
    const tmp = `${mapPath}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(existing, null, 2));
    renameSync(tmp, mapPath);
  } catch {
    /* best-effort cross-process host sync */
  }
}

export function resolveChallengeHosts(ctx: ToolContext, code: string): string[] {
  const mem = challengeHosts.get(code);
  if (mem?.length) return mem;
  if (ctx.manifest.dataDir && code) {
    const mapPath = join(ctx.manifest.dataDir, "tsecbench-hosts.json");
    if (existsSync(mapPath)) {
      try {
        const parsed = JSON.parse(readFileSync(mapPath, "utf8")) as Record<string, string[]>;
        const disk = parsed[code];
        if (Array.isArray(disk) && disk.length) {
          challengeHosts.set(code, disk);
          return disk;
        }
      } catch {
        /* ignore transient read */
      }
    }
  }
  return lastChallengeHost ? [lastChallengeHost] : [];
}

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
  const hosts = resolveChallengeHosts(ctx, code);
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
  const uniqueHosts = [...new Set(parsed.map((p) => p.host))];
  if (code) {
    challengeHosts.set(code, uniqueHosts);
    persistChallengeHosts(ctx.manifest.dataDir, code, uniqueHosts);
  }
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
    // Sync dynamically admitted target hosts via generic control-plane sidecar (atomic write).
    try {
      const dynPath = join(ctx.manifest.dataDir, "admitted-targets.json");
      const existing: string[] = existsSync(dynPath)
        ? (JSON.parse(readFileSync(dynPath, "utf8")) as string[])
        : [];
      const merged = [...new Set([...existing, ...parsed.map((p) => p.host)])];
      const tmp = `${dynPath}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify(merged, null, 2));
      renameSync(tmp, dynPath);
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
  const multiWorkerFollower =
    (ctx.manifest.workerCount ?? 1) > 1 && !isExploreLeader(ctx.manifest);
  if (multiWorkerFollower && (action === "start" || action === "close")) {
    return JSON.stringify({
      error: "leader_owns_container_lifecycle",
      message:
        "多节点模式下靶机容器启停（start/close）由 slot 0 Leader 统一调度（防抢占 ≤3 容器上限）；Follower 请专注当前认领 Intent 的验证与 tsecbench(action='submit'|'status'|'list')，验证完成后立即 intent_conclude 唤醒 Leader 补发新题。",
    });
  }
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
        try {
          appendProgress(
            ctx.manifest.workspaceDir,
            `tsecbench start ${code} → auto-admitted ${admitted.map((a) => `${a.address}(fact=${a.factId})`).join(", ")}`,
          );
        } catch {
          /* progress log is best-effort */
        }
        let surfaceRotationHint: string | undefined;
        const activeId = ctx.getActiveIntentId?.() ?? null;
        if (activeId) {
          const activeIntent = ctx.history.getIntent(ctx.manifest.taskId, activeId);
          const root = activeIntent?.assetRoot?.trim();
          if (root && !admitted.some((a) => targetAllows([root], a.address, []))) {
            surfaceRotationHint = `当前仍认领旧攻击面 Intent (${activeId}, assetRoot=${root})；切换到新靶机 ${admitted[0]!.address} 前请先 intent_conclude 旧面并为此靶机 intent_propose 新 Intent（严禁多题共用同一 Intent）。`;
          }
        }
        return JSON.stringify({
          ...parsed,
          autoAdmittedAssets: admitted,
          ...(surfaceRotationHint ? { surfaceRotationHint } : {}),
        });
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
        const solved = submitCorrect(response);
        const traffic = solved ? captureSolveTraffic(ctx, code) : null;
        let findingVerifyReminder: string | undefined;
        if (solved) {
          const hosts = resolveChallengeHosts(ctx, code);
          const hasVerifiedFinding = ctx.history.listFindings(ctx.manifest.taskId).some(
            (f) =>
              f.status === "verified" &&
              (hosts.length === 0 || hosts.some((h) => targetAllows([h], f.asset, []) || targetAllows([f.asset], h, []))),
          );
          if (!hasVerifiedFinding) {
            findingVerifyReminder =
              "靶机 flag 提交正确！结项（intent_conclude）前请务必将本次真实漏洞成因调用 finding_record + finding_verify 绑定证据落库，确保渗透报告与解题得分双闭环。";
          }
        }
        return JSON.stringify({
          status: r.status,
          evidencePath: relPath,
          response,
          ...(traffic ? { traffic } : {}),
          ...(findingVerifyReminder ? { findingVerifyReminder } : {}),
        });
      } catch {
        /* fall through to raw text */
      }
    }
    return r.text.slice(0, 2000);
  }
  return JSON.stringify({ error: `unknown action ${action}` });
}

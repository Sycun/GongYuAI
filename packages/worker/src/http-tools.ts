import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { performHttpRequest } from "@gongyuai/exec";
import { capabilityAtLeast } from "./tools.js";
import { scopeAllows } from "@gongyuai/contracts";
import { readEvidenceBytes } from "@gongyuai/history";
import type { ToolContext } from "./tools.js";

const IDEMPOTENT = new Set(["GET", "HEAD", "OPTIONS"]);

export type HttpToolArgs = {
  method?: string;
  url?: string;
  headers?: string;
  body?: string;
  follow?: string;
  timeoutMs?: string;
  note?: string;
  /** Named cookie jar (e.g. "anon", "userA", "userB", "admin") for stateful & multi-role auth testing. */
  session?: string;
  /** Baseline transaction id (`http:<id>` or `<id>`) for deterministic control-vs-test differential analysis. */
  compareWith?: string;
};

type SessionJarStore = Record<string, Record<string, Record<string, string>>>;

function sessionStorePath(dataDir: string): string {
  return join(dataDir, "http-sessions.json");
}

function loadSessionJars(dataDir: string): SessionJarStore {
  const path = sessionStorePath(dataDir);
  if (!existsSync(path)) return {};
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as SessionJarStore;
    }
  } catch {
    /* ignore corrupt jar */
  }
  return {};
}

function saveSessionJars(dataDir: string, store: SessionJarStore): void {
  try {
    writeFileSync(sessionStorePath(dataDir), JSON.stringify(store, null, 2), { mode: 0o600 });
  } catch {
    /* best-effort persistence */
  }
}

function extractSetCookiesFromRawResponse(rawResponse: string): Array<{ name: string; value: string }> {
  const headEnd = rawResponse.indexOf("\n\n");
  const headerBlock = headEnd >= 0 ? rawResponse.slice(0, headEnd) : rawResponse;
  const out: Array<{ name: string; value: string }> = [];
  for (const line of headerBlock.split(/\r?\n/)) {
    const m = /^set-cookie:\s*([^=;\s]+)=([^;\r\n]*)/i.exec(line.trim());
    if (m?.[1]) {
      out.push({ name: m[1].trim(), value: (m[2] ?? "").trim() });
    }
  }
  return out;
}

function mergeCookiesForHost(
  headers: Record<string, string>,
  jarForHost: Record<string, string> | undefined,
): Record<string, string> {
  if (!jarForHost || Object.keys(jarForHost).length === 0) return headers;
  const out = { ...headers };
  const existingKey = Object.keys(out).find((k) => k.toLowerCase() === "cookie");
  const jarPairs = Object.entries(jarForHost).map(([k, v]) => `${k}=${v}`);
  if (!existingKey) {
    out.Cookie = jarPairs.join("; ");
    return out;
  }
  const existing = out[existingKey]!;
  const explicitNames = new Set(
    existing
      .split(";")
      .map((s) => s.trim().split("=")[0]?.trim())
      .filter(Boolean),
  );
  const merged = [
    existing.trim(),
    ...Object.entries(jarForHost)
      .filter(([k]) => !explicitNames.has(k))
      .map(([k, v]) => `${k}=${v}`),
  ].filter(Boolean);
  out[existingKey] = merged.join("; ");
  return out;
}

function computeTransactionDiff(opts: {
  baselineStatus: number;
  baselineBytes: number;
  baselineDurationMs: number;
  baselineSha256: string;
  baselineHead: string;
  currentStatus: number;
  currentBytes: number;
  currentDurationMs: number;
  currentSha256: string;
  currentHead: string;
}) {
  const identicalResponse = opts.baselineSha256 === opts.currentSha256;
  const baseLines = new Set(
    opts.baselineHead
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean),
  );
  const curLines = opts.currentHead
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  const addedLines = curLines.filter((l) => !baseLines.has(l)).slice(0, 8);
  const curSet = new Set(curLines);
  const removedLines = [...baseLines].filter((l) => !curSet.has(l)).slice(0, 8);

  return {
    statusChanged: opts.baselineStatus !== opts.currentStatus,
    baselineStatus: opts.baselineStatus,
    currentStatus: opts.currentStatus,
    bytesDelta: opts.currentBytes - opts.baselineBytes,
    durationDeltaMs: opts.currentDurationMs - opts.baselineDurationMs,
    identicalResponse,
    addedSample: addedLines.map((l) => l.slice(0, 160)),
    removedSample: removedLines.map((l) => l.slice(0, 160)),
  };
}

/**
 * P14-B1 — first-class HTTP transaction for vulnerability discovery:
 * - Enforces scope on origin and every redirect hop;
 * - Seals content-addressed request/response blobs (`http:<id>`) for `finding_verify`;
 * - Supports isolated named `session` cookie jars for multi-role authorization testing;
 * - Supports `compareWith` baseline differential analysis for control-vs-test verification;
 * - Auto-records responsive endpoints into the History asset inventory (zero bookkeeping tax).
 */
export async function httpRequestTool(
  ctx: ToolContext,
  args: HttpToolArgs,
  opts: { intentId?: string | null } = {},
): Promise<string> {
  const url = (args.url ?? "").trim();
  if (!url) return JSON.stringify({ ok: false, error: "url required" });
  const method = (args.method ?? "GET").trim().toUpperCase();
  if (!/^[A-Z]{1,16}$/.test(method)) return JSON.stringify({ ok: false, error: `invalid method ${method}` });

  const cap = ctx.manifest.auth.capability ?? "observe";
  const need = IDEMPOTENT.has(method) ? "scan" : "active-lab";
  if (!capabilityAtLeast(cap, need)) {
    return JSON.stringify({
      ok: false,
      error: `denied: http_request ${method} requires auth.capability≥${need} (have ${cap})`,
    });
  }

  let headers: Record<string, string> = {};
  if (args.headers?.trim()) {
    try {
      const parsed = JSON.parse(args.headers) as Record<string, unknown>;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        headers = Object.fromEntries(
          Object.entries(parsed).map(([k, v]) => [k, String(v)]),
        );
      }
    } catch {
      return JSON.stringify({ ok: false, error: "headers must be a JSON object" });
    }
  }

  const sessionName = args.session?.trim() || "";
  let targetHost = "";
  try {
    targetHost = new URL(url).hostname.toLowerCase();
  } catch {
    /* performHttpRequest will return structured URL error */
  }
  const jars = sessionName && ctx.manifest.dataDir ? loadSessionJars(ctx.manifest.dataDir) : {};
  if (sessionName && targetHost) {
    headers = mergeCookiesForHost(headers, jars[sessionName]?.[targetHost]);
  }

  const follow = args.follow !== "false" && args.follow !== "0";
  const timeoutMs = Math.min(120_000, Math.max(1, Number(args.timeoutMs) || 30_000));
  const result = await performHttpRequest(
    { method, url, headers, body: args.body, follow, timeoutMs },
    {
      evidenceDir: ctx.manifest.evidenceDir,
      authorizeHost: (host) =>
        scopeAllows(ctx.manifest.auth, host)
          ? { allowed: true }
          : { allowed: false, reason: `${host} not in task targets/pivot` },
    },
  );
  const artifact = result.artifact;

  if (artifact.error || artifact.status === 0) {
    return JSON.stringify({
      ok: false,
      error: artifact.error ?? "request failed",
      status: 0,
      blockedRedirect: artifact.blockedRedirect,
    });
  }

  // Persist response Set-Cookie headers into the named session jar if requested.
  let sessionCookieCount: number | undefined;
  if (sessionName && ctx.manifest.dataDir) {
    try {
      const rawRes = readEvidenceBytes(ctx.manifest.evidenceDir, artifact.responsePath).toString("utf8");
      const setCookies = extractSetCookiesFromRawResponse(rawRes);
      if (!jars[sessionName]) jars[sessionName] = {};
      if (!jars[sessionName]![artifact.host]) jars[sessionName]![artifact.host] = {};
      for (const c of setCookies) {
        if (c.value === "" || /^deleted$/i.test(c.value)) {
          delete jars[sessionName]![artifact.host]![c.name];
        } else {
          jars[sessionName]![artifact.host]![c.name] = c.value;
        }
      }
      saveSessionJars(ctx.manifest.dataDir, jars);
      sessionCookieCount = Object.keys(jars[sessionName]![artifact.host] ?? {}).length;
    } catch {
      /* non-fatal cookie jar update */
    }
  }

  const { transaction } = ctx.history.recordHttpTransaction({
    taskId: ctx.manifest.taskId,
    intentId: opts.intentId ?? null,
    method: artifact.method,
    url: artifact.url,
    host: artifact.host,
    path: artifact.path,
    status: artifact.status,
    requestSha256: artifact.requestSha256,
    responseSha256: artifact.responseSha256,
    requestPath: artifact.requestPath,
    responsePath: artifact.responsePath,
    requestBytes: artifact.requestBytes,
    responseBytes: artifact.responseBytes,
    responseHead: artifact.responseHead,
    truncated: artifact.truncated,
    redirects: artifact.redirects,
    startedAt: artifact.startedAt,
    durationMs: artifact.durationMs,
    note: args.note ?? (sessionName ? `session=${sessionName}` : ""),
  });

  // Zero-tax endpoint discovery: record live non-404 endpoints into asset inventory automatically.
  if (artifact.status > 0 && artifact.status !== 404 && artifact.path && artifact.path !== "/") {
    const cleanPath = (artifact.path.split("?")[0] ?? artifact.path).slice(0, 120);
    if (cleanPath.length > 1) {
      try {
        ctx.history.recordAsset({
          taskId: ctx.manifest.taskId,
          address: `${artifact.host}${cleanPath}`,
          auth: ctx.manifest.auth,
          live: true,
          source: "discover",
          assetType: "endpoint",
          parentAddress: artifact.host,
          intentId: opts.intentId ?? null,
          summary: `HTTP ${artifact.method} → ${artifact.status}`,
        });
      } catch {
        /* ignore non-fatal endpoint asset projection */
      }
    }
  }

  let diff: ReturnType<typeof computeTransactionDiff> | { error: string } | undefined;
  const compareRaw = args.compareWith?.trim();
  if (compareRaw) {
    const baseId = compareRaw.startsWith("http:") ? compareRaw.slice("http:".length) : compareRaw;
    const baseTx = ctx.history.getHttpTransaction(ctx.manifest.taskId, baseId);
    if (!baseTx) {
      diff = { error: `baseline transaction not found: ${compareRaw}` };
    } else {
      diff = computeTransactionDiff({
        baselineStatus: baseTx.status,
        baselineBytes: baseTx.responseBytes,
        baselineDurationMs: baseTx.durationMs,
        baselineSha256: baseTx.responseSha256,
        baselineHead: baseTx.responseHead,
        currentStatus: artifact.status,
        currentBytes: artifact.responseBytes,
        currentDurationMs: artifact.durationMs,
        currentSha256: artifact.responseSha256,
        currentHead: result.bodyHead,
      });
    }
  }

  return JSON.stringify({
    ok: true,
    transactionId: transaction.id,
    ref: `http:${transaction.id}`,
    status: artifact.status,
    headers: result.headers,
    bodyHead: result.bodyHead,
    truncated: artifact.truncated,
    redirects: artifact.redirects,
    blockedRedirect: artifact.blockedRedirect ?? null,
    ...(sessionName ? { session: sessionName, sessionCookies: sessionCookieCount ?? 0 } : {}),
    ...(diff ? { diff } : {}),
    note: "证据已封存；finding_verify 可直接 cite http:<id>",
  });
}

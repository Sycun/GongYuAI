import {
  applySessionToHeaders,
  hostScopeAllows,
  insertTraffic,
  loadHttpSessions,
  performHttpRequest,
  putBlob,
  saveHttpSessions,
  type HttpSessionStore,
} from "@gongyuai/exec";
import { capabilityAtLeast, syncAdmittedTargets } from "./tools.js";
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
  const sessions: HttpSessionStore = sessionName && ctx.manifest.dataDir
    ? loadHttpSessions(ctx.manifest.dataDir)
    : {};
  if (sessionName && targetHost) {
    headers = applySessionToHeaders(headers, sessions[sessionName]?.[targetHost]);
  }

  syncAdmittedTargets(ctx.manifest);
  const follow = args.follow !== "false" && args.follow !== "0";
  const timeoutMs = Math.min(120_000, Math.max(1, Number(args.timeoutMs) || 30_000));
  const result = await performHttpRequest(
    { method, url, headers, body: args.body, follow, timeoutMs },
    {
      evidenceDir: ctx.manifest.evidenceDir,
      authorizeHost: (host) =>
        hostScopeAllows(ctx.manifest.auth, host, { dataDir: ctx.manifest.dataDir })
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
      const latest = loadHttpSessions(ctx.manifest.dataDir);
      if (!latest[sessionName]) latest[sessionName] = {};
      const hostState = latest[sessionName]![artifact.host] ?? { cookies: {}, headers: {} };
      for (const cookie of setCookies) {
        if (cookie.value === "" || /^deleted$/i.test(cookie.value)) {
          delete hostState.cookies[cookie.name];
        } else {
          hostState.cookies[cookie.name] = cookie.value;
        }
      }
      latest[sessionName]![artifact.host] = hostState;
      saveHttpSessions(ctx.manifest.dataDir, latest);
      sessionCookieCount = Object.keys(hostState.cookies).length;
    } catch {
      /* non-fatal cookie jar update */
    }
  }

  const activeIntentId =
    opts.intentId !== undefined
      ? opts.intentId
      : (ctx.getActiveIntentId?.() ?? ctx.history.resolveActiveIntentId(ctx.manifest.taskId));
  const { transaction } = ctx.history.recordHttpTransaction({
    taskId: ctx.manifest.taskId,
    intentId: activeIntentId ?? null,
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

  // Mirror built-in http_request exchanges into the task traffic index so Traffic tab and traffic_* tools see them.
  if (ctx.manifest.dataDir) {
    try {
      const reqBuf = args.body ? Buffer.from(args.body, "utf8") : Buffer.alloc(0);
      const reqContentType = Object.entries(headers).find(([k]) => k.toLowerCase() === "content-type")?.[1]?.split(";")[0]?.trim();
      const resContentType = Object.entries(result.headers).find(([k]) => k.toLowerCase() === "content-type")?.[1]?.split(";")[0]?.trim();
      let resBuf: Buffer = Buffer.from(result.bodyHead ?? "", "utf8");
      try {
        const rawRes = readEvidenceBytes(ctx.manifest.evidenceDir, artifact.responsePath);
        const sepIdx = rawRes.indexOf(Buffer.from("\r\n\r\n"));
        if (sepIdx >= 0) resBuf = rawRes.subarray(sepIdx + 4);
      } catch {
        /* fall back to bodyHead */
      }
      const reqBody = reqBuf.length > 0 ? putBlob(ctx.manifest.dataDir, reqBuf, reqContentType) : undefined;
      const resBody = resBuf.length > 0 ? putBlob(ctx.manifest.dataDir, resBuf, resContentType) : undefined;
      insertTraffic(ctx.manifest.dataDir, {
        taskId: ctx.manifest.taskId,
        ...(activeIntentId ? { intentId: activeIntentId } : {}),
        workerId: ctx.manifest.workerId,
        method: artifact.method,
        url: artifact.url,
        host: artifact.host,
        path: artifact.path || "/",
        status: artifact.status,
        durationMs: artifact.durationMs,
        startedAt: artifact.startedAt,
        reqHeaders: headers,
        resHeaders: result.headers,
        ...(reqBody ? { reqBody } : {}),
        ...(resBody ? { resBody } : {}),
        reqPreview: args.body ? args.body.slice(0, 8192) : "",
        resPreview: (result.bodyHead ?? "").slice(0, 8192),
      });
    } catch {
      /* non-fatal traffic mirror */
    }
  }

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
          ...(activeIntentId !== undefined ? { intentId: activeIntentId } : {}),
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

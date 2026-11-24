import { performHttpRequest } from "@gongyuai/exec";
import { capabilityAtLeast } from "./tools.js";
import { scopeAllows } from "@gongyuai/contracts";
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
};

/**
 * P14-B1 — first-class HTTP transaction. Scope is checked for the origin and
 * every redirect hop before the request leaves the worker; the request and
 * response are sealed as content-addressed evidence and indexed in History.
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

  // Capability: read-only verbs at scan, state-changing verbs at active-lab.
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
    note: args.note ?? "",
  });

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
      note: "证据已封存；finding_verify 可直接 cite http:<id>",
  });
}

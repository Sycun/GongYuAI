import { randomBytes } from "node:crypto";
import {
  startOastDnsListener,
  startOastListener,
  type OastDnsListener,
  type OastListener,
} from "@gongyuai/exec";
import { OAST_TOKEN_TTL_MS } from "@gongyuai/contracts";
import type { ToolContext } from "./tools.js";

/**
 * P14-B2 — issue out-of-band tokens and correlate hits. The listener is a
 * local service (never a host network mutation); when `auth.oast` is absent the
 * tools degrade to explicit `oast_unavailable` instead of fake hits.
 *
 * One listener per worker process; the callback base URL is operator-supplied.
 */
const listeners = new Map<string, Promise<OastListener>>();
const dnsListeners = new Map<string, Promise<OastDnsListener>>();

async function listenerFor(
  ctx: ToolContext,
  cfg: { baseUrl: string; listenHost: string; listenPort: number },
): Promise<OastListener> {
  const existing = listeners.get(ctx.manifest.taskId);
  if (existing) return existing;
  const started = startOastListener({
    listenHost: cfg.listenHost,
    listenPort: cfg.listenPort,
    publicBaseUrl: cfg.baseUrl.replace(/\/+$/, ""),
    onHit: (hit) => {
      try {
        const token = ctx.history.getOastToken(ctx.manifest.taskId, hit.token);
        if (!token) return false;
        ctx.history.recordOastHit(ctx.manifest.taskId, {
          token: hit.token,
          at: hit.at,
          sourceIp: hit.sourceIp,
          method: hit.method,
          path: hit.path,
          userAgent: hit.userAgent,
          protocol: hit.protocol,
        });
        return true;
      } catch {
        // A hit must never crash the listener; unknown tokens were already ignored.
        return false;
      }
    },
  });
  listeners.set(ctx.manifest.taskId, started);
  try {
    return await started;
  } catch (err) {
    listeners.delete(ctx.manifest.taskId);
    throw err;
  }
}

async function dnsListenerFor(
  ctx: ToolContext,
  cfg: { domain: string; listenHost: string; listenPort: number; answerIp: string },
): Promise<OastDnsListener> {
  const existing = dnsListeners.get(ctx.manifest.taskId);
  if (existing) return existing;
  const started = startOastDnsListener({
    listenHost: cfg.listenHost,
    listenPort: cfg.listenPort,
    domain: cfg.domain,
    answerIp: cfg.answerIp,
    onHit: (hit) => {
      try {
        const token = ctx.history.getOastToken(ctx.manifest.taskId, hit.token);
        if (!token) return false;
        ctx.history.recordOastHit(ctx.manifest.taskId, {
          token: hit.token,
          at: hit.at,
          sourceIp: hit.sourceIp,
          protocol: "dns",
        });
        return true;
      } catch {
        return false;
      }
    },
  });
  dnsListeners.set(ctx.manifest.taskId, started);
  try {
    return await started;
  } catch (err) {
    dnsListeners.delete(ctx.manifest.taskId);
    throw err;
  }
}

function config(ctx: ToolContext) {
  const cfg = ctx.manifest.auth.oast;
  if (!cfg) return null;
  return {
    baseUrl: cfg.baseUrl,
    listenHost: cfg.listenHost ?? "127.0.0.1",
    listenPort: cfg.listenPort ?? 0,
    dnsName: cfg.dnsName,
    dnsListenHost: cfg.dnsListenHost ?? "127.0.0.1",
    dnsListenPort: cfg.dnsListenPort ?? 0,
    dnsAnswer: cfg.dnsAnswer ?? "127.0.0.1",
  };
}

export async function oastIssueTool(
  ctx: ToolContext,
  args: { kind?: string; note?: string },
): Promise<string> {
  const cfg = config(ctx);
  if (!cfg) {
    return JSON.stringify({
      ok: false,
      error: "oast_unavailable: auth.oast 未配置（baseUrl/listenHost/listenPort）；不生成假命中",
    });
  }
  const kind = args.kind === "dns" ? "dns" : "http";
  const token = randomBytes(8).toString("hex");
  let callback: string;
  if (kind === "dns") {
    if (!cfg.dnsName) {
      return JSON.stringify({
        ok: false,
        error: "oast_unavailable: 未配置 auth.oast.dnsName，DNS 通道不可用",
      });
    }
    let listener: OastDnsListener;
    try {
      listener = await dnsListenerFor(ctx, {
        domain: cfg.dnsName,
        listenHost: cfg.dnsListenHost,
        listenPort: cfg.dnsListenPort,
        answerIp: cfg.dnsAnswer,
      });
    } catch (err) {
      return JSON.stringify({
        ok: false,
        error: `oast_unavailable: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
    callback = listener.hostname(token);
  } else {
    let listener: OastListener;
    try {
      listener = await listenerFor(ctx, cfg);
    } catch (err) {
      return JSON.stringify({
        ok: false,
        error: `oast_unavailable: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
    callback = listener.callbackUrl(token);
  }
  const now = Date.now();
  ctx.history.recordOastToken({
    token,
    taskId: ctx.manifest.taskId,
    kind,
    callback,
    note: args.note ?? "",
    expiresAt: new Date(now + OAST_TOKEN_TTL_MS).toISOString(),
  });
  return JSON.stringify({
    ok: true,
    token,
    kind,
    callback,
    ref: `oast:${token}`,
    note: "把 callback 放进 payload（SSRF/盲注/XXE/命令注入）；命中后用 oast_hits 查证，hit≠可利用。",
  });
}

export function oastHitsTool(ctx: ToolContext, args: { token?: string }): string {
  const tokens = ctx.history.listOastTokens(ctx.manifest.taskId);
  const token = args.token?.trim() || undefined;
  if (token && !tokens.some((entry) => entry.token === token)) {
    return JSON.stringify({ ok: false, error: `unknown oast token: ${token}` });
  }
  const hits = ctx.history.listOastHits(ctx.manifest.taskId, token);
  return JSON.stringify({
    ok: true,
    tokens: tokens
      .filter((entry) => !token || entry.token === token)
      .map((entry) => ({ token: entry.token, callback: entry.callback, hits: entry.hits, issuedAt: entry.issuedAt })),
    hits: hits.map((hit) => ({
      token: hit.token,
      at: hit.at,
      sourceIp: hit.sourceIp,
      method: hit.method,
      path: hit.path,
      userAgent: hit.userAgent,
      protocol: hit.protocol,
    })),
    note: "命中证明目标发起了带外请求；影响仍需事务/主机证据（hit≠可利用）。",
  });
}

/** Called by the worker shutdown path so the callback port does not leak. */
export async function closeOastListeners(): Promise<void> {
  const pending = [...listeners.values()];
  const pendingDns = [...dnsListeners.values()];
  listeners.clear();
  dnsListeners.clear();
  await Promise.all([
    ...pending.map((p) => p.then((listener) => listener.close()).catch(() => undefined)),
    ...pendingDns.map((p) => p.then((listener) => listener.close()).catch(() => undefined)),
  ]);
}

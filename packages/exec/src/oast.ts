import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { Socket } from "node:net";

/**
 * P14-B2 — 带外（OAST）回调监听。
 *
 * 盲 SSRF / 盲注 / XXE / log4j 这类漏洞能证明的只是「目标确实发起了带外请求」，
 * 本模块只把这次回调**原样**记成一条 hit（令牌、时间、来源、方法、原始 path、UA），
 * 是否采信由调用方按任务令牌判定（onHit 返回 true 保留 / false 忽略）。
 * 不落盘、不写日志、不读环境变量，也不依赖 history / worker，便于单独装卸。
 *
 * 应答约定：路径/query/Host 三处都取不到令牌才回 400（且不调用 onHit）；
 * 形态合法但本任务未签发的令牌仍会先拿到 200，由 onHit 返回 false 忽略——
 * 200 必须先于 onHit 写出（目标不等回调处理），监听器本身没有签发台账可查。
 *
 * 通道边界：本监听器只有 HTTP 一条通道，所以 hit 的 protocol 恒为 "http"。
 * Host 头里的 `<token>.<dnsName>` 只是令牌提取的兜底入口（通配 DNS 解析后请求
 * 仍落在这个 HTTP 端口上）；没有观测到 DNS 查询就标 "dns" 等于伪造证据。
 */

export type OastCallbackHit = {
  token: string;
  at: string;
  sourceIp: string;
  method: string;
  path: string;
  userAgent: string;
  protocol: "http" | "dns";
};

export type OastListenerOptions = {
  /** Interface to bind (default 127.0.0.1). */
  listenHost?: string;
  /** 0 = ephemeral port (default 0). */
  listenPort?: number;
  /** Public base URL targets can reach, e.g. http://10.0.0.9:8799 (no trailing slash). */
  publicBaseUrl: string;
  /** Called for every inbound request; return true to keep it, false to ignore (unknown token). */
  onHit: (hit: OastCallbackHit) => boolean | Promise<boolean>;
  /** Max body bytes to drain before responding (default 64 KiB). */
  maxBodyBytes?: number;
};

export type OastListener = {
  /** Actual bound port. */
  port: number;
  /** e.g. http://127.0.0.1:41234 (bound address, for tests) */
  boundUrl: string;
  /** Build a callback URL for a token: `${publicBaseUrl}/t/<token>` */
  callbackUrl(token: string): string;
  /** Stop the server; resolves when closed. */
  close(): Promise<void>;
};

/** 响应前最多 drain 的请求体（超出即断链，防呆而不落盘）。 */
const DEFAULT_MAX_BODY_BYTES = 64 * 1024;
/** close() 的强拆上限：在途连接不配合时最多等这么久。 */
const CLOSE_GRACE_MS = 1_000;
/** Host 兜底里首段的最短长度：避免把 IP 前两段（10/127/192…）当令牌。 */
const MIN_DNS_TOKEN_LABEL_LENGTH = 8;

type ParsedTarget = {
  pathname: string;
  query: URLSearchParams;
};

function parseTarget(rawUrl: string): ParsedTarget {
  try {
    const parsed = new URL(rawUrl, "http://oast.invalid");
    return { pathname: parsed.pathname, query: parsed.searchParams };
  } catch {
    // 极少数非 origin-form 的畸形 target：退化成手工切分，别让请求处理抛错。
    const questionMark = rawUrl.indexOf("?");
    const pathname = questionMark >= 0 ? rawUrl.slice(0, questionMark) : rawUrl;
    const search = questionMark >= 0 ? rawUrl.slice(questionMark + 1) : "";
    return { pathname: pathname.length > 0 ? pathname : "/", query: new URLSearchParams(search) };
  }
}

/** 令牌只做「非空」清洗；形态/长度是否属于本任务由调用方的 onHit 判定。 */
function cleanToken(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const token = value.trim();
  return token.length > 0 ? token : null;
}

function decodePathSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

/**
 * Host 兜底：`<token>.<dnsName>`，要求至少 3 段且首段 ≥8 字符。
 * IPv6 字面量（`[::1]:8799`）直接排除；端口和 DNS 末尾的根点先剥掉。
 */
function tokenFromHost(hostHeader: string | undefined): string | null {
  if (hostHeader === undefined) return null;
  let host = hostHeader.trim();
  if (host.length === 0 || host.startsWith("[")) return null;
  const portSeparator = host.indexOf(":");
  if (portSeparator >= 0) host = host.slice(0, portSeparator);
  host = host.replace(/\.$/, "");
  const labels = host.split(".").filter((label) => label.length > 0);
  if (labels.length < 3) return null;
  const first = labels[0];
  if (first === undefined || first.length < MIN_DNS_TOKEN_LABEL_LENGTH) return null;
  return cleanToken(first);
}

/** 路径 `/t/<token>` 优先，其次 query `?t=`，最后 Host 里的子域名令牌。 */
function extractToken(req: IncomingMessage): string | null {
  const target = parseTarget(req.url ?? "");

  const segments = target.pathname.split("/").filter((segment) => segment.length > 0);
  if (segments[0] === "t") {
    const second = segments[1];
    const pathToken = second === undefined ? null : cleanToken(decodePathSegment(second));
    if (pathToken !== null) return pathToken;
  }

  const queryToken = cleanToken(target.query.get("t"));
  if (queryToken !== null) return queryToken;

  return tokenFromHost(req.headers.host);
}

/** x-forwarded-for 第一跳优先；否则 socket 远端地址（IPv4-mapped IPv6 去前缀）。 */
function sourceIpOf(req: IncomingMessage): string {
  const header = req.headers["x-forwarded-for"];
  const forwarded = typeof header === "string" ? header : "";
  const firstHop = forwarded.split(",")[0]?.trim() ?? "";
  if (firstHop.length > 0) return firstHop;
  const remote = req.socket.remoteAddress ?? "";
  return remote.replace(/^::ffff:/i, "");
}

function formatUrlHost(host: string): string {
  return host.includes(":") ? `[${host}]` : host;
}

function describeListenError(error: unknown, host: string, port: number): Error {
  const candidate = error as NodeJS.ErrnoException | null;
  const code = typeof candidate?.code === "string" ? candidate.code : "UNKNOWN";
  const detail = error instanceof Error ? error.message : String(error);
  const wrapped = new Error(`OAST 监听无法绑定 ${host}:${port}（${code}）：${detail}`, { cause: error });
  (wrapped as NodeJS.ErrnoException).code = code;
  return wrapped;
}

/**
 * 读取并丢弃请求体，最多 maxBytes。超限立刻 destroy 连接并返回 false；
 * 对端中断/流错误同样返回 false。返回 true 才代表可以响应并记 hit。
 */
async function drainBody(req: IncomingMessage, maxBytes: number): Promise<boolean> {
  let total = 0;
  try {
    for await (const chunk of req) {
      const size = typeof chunk === "string" ? Buffer.byteLength(chunk) : (chunk as Buffer).byteLength;
      total += size;
      if (total > maxBytes) {
        req.destroy();
        return false;
      }
    }
    return true;
  } catch {
    return false;
  }
}

function emitHit(hit: OastCallbackHit, onHit: OastListenerOptions["onHit"]): void {
  try {
    // 响应已经发出；onHit 的去重/落盘不 await，也不能反向阻塞或打断监听器。
    void Promise.resolve(onHit(hit)).catch(() => {});
  } catch {
    // onHit 同步抛错同样吞掉：调用方的 bug 不应让监听器退出。
  }
}

async function serve(
  req: IncomingMessage,
  res: ServerResponse,
  onHit: OastListenerOptions["onHit"],
  maxBodyBytes: number,
): Promise<void> {
  const token = extractToken(req);
  if (token === null) {
    // 取不到令牌的请求不是 hit：不调用 onHit，也不回写任何目标可控内容。
    res.writeHead(400, { "content-type": "text/plain" });
    res.end("missing oast token\n");
    return;
  }

  const drained = await drainBody(req, maxBodyBytes);
  if (!drained) return;

  // 先应答再记 hit：目标侧看到 200 即完成带外动作，回调处理不占用它的等待时间。
  res.writeHead(200, { "content-type": "text/plain", "content-length": "0" });
  res.end();

  emitHit(
    {
      token,
      at: new Date().toISOString(),
      sourceIp: sourceIpOf(req),
      method: req.method ?? "",
      path: req.url ?? "",
      userAgent: req.headers["user-agent"] ?? "",
      protocol: "http",
    },
    onHit,
  );
}

export async function startOastListener(opts: OastListenerOptions): Promise<OastListener> {
  const listenHost = opts.listenHost ?? "127.0.0.1";
  const listenPort = opts.listenPort ?? 0;
  const configuredMaxBody = opts.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  const maxBodyBytes = Number.isFinite(configuredMaxBody)
    ? Math.max(0, Math.floor(configuredMaxBody))
    : DEFAULT_MAX_BODY_BYTES;
  const publicBaseUrl = opts.publicBaseUrl.trim().replace(/\/+$/, "");
  if (publicBaseUrl.length === 0) {
    throw new Error("OAST 监听需要 publicBaseUrl（目标可达的回调基地址，例如 http://10.0.0.9:8799）");
  }

  const sockets = new Set<Socket>();
  const server = createServer((req, res) => {
    void serve(req, res, opts.onHit, maxBodyBytes).catch(() => {
      // 处理请求期间的对端重置/写失败不影响监听器；不写日志。
    });
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });

  await new Promise<void>((resolve, reject) => {
    const onError = (error: NodeJS.ErrnoException): void => {
      reject(describeListenError(error, listenHost, listenPort));
    };
    server.once("error", onError);
    try {
      server.listen(listenPort, listenHost, () => {
        server.off("error", onError);
        resolve();
      });
    } catch (error) {
      server.off("error", onError);
      reject(describeListenError(error, listenHost, listenPort));
    }
  });

  const address = server.address();
  if (address === null || typeof address === "string") {
    server.close(() => {});
    server.closeAllConnections();
    throw new Error("OAST 监听启动后没有可用的 TCP 地址");
  }

  // 启动期错误已由上面的 reject 暴露；运行期 error 不能把进程带走。
  server.on("error", () => {});

  const port = address.port;
  const boundUrl = `http://${formatUrlHost(address.address)}:${port}`;
  let closing: Promise<void> | null = null;

  return {
    port,
    boundUrl,
    callbackUrl(token: string): string {
      return `${publicBaseUrl}/t/${token}`;
    },
    close(): Promise<void> {
      if (closing === null) {
        closing = new Promise<void>((resolve) => {
          let settled = false;
          let forceTimer: ReturnType<typeof setTimeout> | undefined;
          const finish = (): void => {
            if (settled) return;
            settled = true;
            if (forceTimer !== undefined) clearTimeout(forceTimer);
            resolve();
          };
          forceTimer = setTimeout(() => {
            // 在途请求赖着不走时强拆；close() 最多等 CLOSE_GRACE_MS。
            server.closeAllConnections();
            for (const socket of sockets) socket.destroy();
            sockets.clear();
            finish();
          }, CLOSE_GRACE_MS);
          server.close(() => finish());
          // 空闲 keep-alive 连接不应把 close() 拖到强拆超时。
          server.closeIdleConnections();
        });
      }
      return closing;
    },
  };
}

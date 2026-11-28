import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { netdJsonAsync, shouldUseGoBackend } from "./netd-client.js";

/**
 * P14-B1 — HTTP 事务采集。
 *
 * 一次 `performHttpRequest` 产出一个「逻辑事务」：
 * - `method` / `url` / `host` / `path` 与请求 blob 描述**第一跳**（调用方要发的请求）；
 * - `status` 与响应 blob 描述**终结响应**（跟随完重定向后的最后一跳；被拦截时是最后一个完成的跳）；
 * - `redirects` 只列真正跟随过的绝对目标（按顺序），不含始发 URL。
 *
 * 每次跳转（含始发 URL）都必须过 `authorizeHost`；任意一跳被拒即停止，不向该 host 发请求，
 * 返回上一跳的 3xx 结果并把被拒 host 写进 `blockedRedirect`。
 *
 * 证据先于动作：请求 blob 在发请求前落盘（内容寻址、已存在则跳过），响应 blob 在拿到后落盘。
 * 网络失败 / 始发 host 被拒时 `status = 0`，响应 blob 是规范化的「无响应」记录
 * `HTTP/1.1 0\n\n`，失败原因只在 artifact.error 里（不伪造服务端响应）。
 *
 * 序列化（UTF-8 文本）：
 * - 请求：`METHOD URL\nHeader: v\n...\n\n<body>`
 * - 响应：`HTTP/1.1 <status>\nHeader: v\n...\n\n<body>`
 * 记录调用方提供的请求 header。未提供 User-Agent 时写入默认浏览器 UA
 * （`userAgent` 选项或 `GY_HTTP_USER_AGENT` 可覆盖，显式头优先）。
 * Host/Content-Length 等运行时补充的传输细节不写进证据。
 * 响应正文是 fetch 交给我们的 UTF-8 文本（可能已被透明解压）；response header 原样记录
 * fetch 暴露的内容，因此记录不是逐字节的线上报文，而是可复读的文本事务。
 * `timeoutMs` 覆盖整条重定向链（从首跳到终结响应），不是每跳单独计时。
 */
export type HttpArtifact = {
  id: string;
  method: string;
  url: string;
  host: string;
  path: string;
  status: number;
  requestSha256: string;
  responseSha256: string;
  /** evidence-relative: `http/<sha>.req.txt` */
  requestPath: string;
  /** evidence-relative: `http/<sha>.res.txt` */
  responsePath: string;
  requestBytes: number;
  responseBytes: number;
  /** ≤ 16 KiB of body */
  responseHead: string;
  truncated: boolean;
  /** absolute URLs followed, in order */
  redirects: string[];
  startedAt: string;
  durationMs: number;
  error?: string;
  blockedRedirect?: string;
};

export type HttpScopeRule = {
  allowHosts?: string[];
  denyHosts?: string[];
  allowAll?: boolean;
};

export type HttpRequestOptions = {
  evidenceDir: string;
  /** Called for the initial URL host and every redirect hop. */
  authorizeHost: (host: string) => { allowed: boolean; reason?: string };
  /** Max redirects (default 5). */
  maxRedirects?: number;
  /** Max stored response body bytes (default 2 MiB). */
  maxResponseBytes?: number;
  /**
   * User-Agent used when the caller did not set one.
   * Falls back to `GY_HTTP_USER_AGENT`, then {@link DEFAULT_BROWSER_USER_AGENT}.
   */
  userAgent?: string;
  /** Optional serializable host scope for zero-roundtrip redirects in Go sidecar. */
  scope?: HttpScopeRule;
  /** Optional proxy URL for Go sidecar transport. */
  proxyUrl?: string;
  /** Skip TLS verification when using Go sidecar transport. */
  insecureTls?: boolean;
};

/** Standard browser UA so target requests do not fall back to undici's default. */
export const DEFAULT_BROWSER_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

export function resolveDefaultUserAgent(configured?: string | null): string {
  const fromOption = configured?.trim();
  if (fromOption) return fromOption;
  const fromEnv = process.env.GY_HTTP_USER_AGENT?.trim();
  if (fromEnv) return fromEnv;
  return DEFAULT_BROWSER_USER_AGENT;
}

const DEFAULT_MAX_REDIRECTS = 5;
const DEFAULT_MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 30_000;
const RESPONSE_HEAD_BYTES = 16 * 1024;
const REDIRECT_STATUSES: ReadonlySet<number> = new Set([301, 302, 303, 307, 308]);
/** RFC 9110 token：header 名与 method 共用。 */
const TOKEN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
/** 跨源跳转不携带凭据，避免把授权 header 泄露给下一跳。 */
const SENSITIVE_HEADERS: ReadonlySet<string> = new Set(["authorization", "cookie", "proxy-authorization"]);
const NO_RESPONSE_TEXT = "HTTP/1.1 0\n\n";
const NATIVE_FETCH = globalThis.fetch;

type HeaderPair = [name: string, value: string];

type Blob = {
  sha256: string;
  /** evidence-relative path */
  path: string;
  bytes: number;
};

type Hop = {
  status: number;
  responseText: string;
  headers: Record<string, string>;
  bodyHead: string;
  truncated: boolean;
};

function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function normalizeMethod(method: string | undefined): string {
  const value = (method ?? "GET").trim().toUpperCase();
  if (!value || !TOKEN.test(value)) {
    throw new TypeError(`invalid HTTP method: ${JSON.stringify(method)}`);
  }
  return value;
}

/** header 名/值先做注入检查：坏输入是调用方错误，不落成证据，也不交给 fetch。 */
function normalizeHeaders(input: Record<string, string> | undefined): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(input ?? {})) {
    if (!TOKEN.test(name)) {
      throw new TypeError(`invalid HTTP header name: ${JSON.stringify(name)}`);
    }
    if (/[\r\n\u0000]/.test(value)) {
      throw new TypeError(`invalid HTTP header value for ${JSON.stringify(name)}: CR/LF/NUL not allowed`);
    }
    headers[name] = value;
  }
  return headers;
}

/** 归一化始发 URL：去掉从未上线的 fragment；其余交给 WHATWG URL。 */
function normalizeUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new TypeError(`invalid URL: ${raw}`);
  }
  url.hash = "";
  return url;
}

function serializeRequest(
  method: string,
  url: string,
  headers: Record<string, string>,
  body: string | undefined,
): string {
  const lines = [`${method} ${url}`];
  for (const [name, value] of Object.entries(headers)) lines.push(`${name}: ${value}`);
  return `${lines.join("\n")}\n\n${body ?? ""}`;
}

function serializeResponse(status: number, headers: readonly HeaderPair[], body: string): string {
  const lines = [`HTTP/1.1 ${status}`];
  for (const [name, value] of headers) lines.push(`${name}: ${value}`);
  return `${lines.join("\n")}\n\n${body}`;
}

/**
 * 内容寻址落盘：`<evidenceDir>/http/<sha>.{req,res}.txt`。
 * 同内容已存在则跳过（`wx` 兜住并发写的窗口）；文件权限 0o600。
 */
function persistBlob(evidenceDir: string, kind: "req" | "res", text: string): Blob {
  const sha256 = sha256Hex(text);
  const path = `http/${sha256}.${kind}.txt`;
  mkdirSync(join(evidenceDir, "http"), { recursive: true });
  const absolutePath = join(evidenceDir, path);
  if (!existsSync(absolutePath)) {
    try {
      writeFileSync(absolutePath, text, { encoding: "utf8", mode: 0o600, flag: "wx" });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }
  return { sha256, path, bytes: Buffer.byteLength(text, "utf8") };
}

/**
 * 序列末尾若被切断在多字节字符中间，返回该序列起点；否则返回 endExclusive。
 * 是下面两个边界辅助函数的共同内核。
 */
function utf8SequenceStart(buffer: Buffer, endExclusive: number): number {
  if (endExclusive <= 0) return 0;
  let index = endExclusive - 1;
  while (index >= 0 && (buffer[index]! & 0xc0) === 0x80) index -= 1;
  if (index < 0) return endExclusive;
  const lead = buffer[index]!;
  let width = 1;
  if ((lead & 0xe0) === 0xc0) width = 2;
  else if ((lead & 0xf0) === 0xe0) width = 3;
  else if ((lead & 0xf8) === 0xf0) width = 4;
  return endExclusive - index < width ? index : endExclusive;
}

/** responseHead 的 16 KiB 上限：cut 超过缓冲长度表示不截。 */
function utf8Boundary(buffer: Buffer, cut: number): number {
  if (cut <= 0) return 0;
  if (cut >= buffer.length) return buffer.length;
  return utf8SequenceStart(buffer, cut);
}

/** 有界读取在 maxResponseBytes 处硬切，可能劈开多字节字符；落盘前回退到序列起点。 */
function utf8SafeLength(buffer: Buffer): number {
  return utf8SequenceStart(buffer, buffer.length);
}

/**
 * 有界读取响应体：最多读 maxBytes + 超出后的判定，然后取消流。
 * 不把无限/超大响应整个读进内存。
 */
async function readBody(
  response: Response,
  maxBytes: number,
): Promise<{ buffer: Buffer; truncated: boolean }> {
  if (!response.body) return { buffer: Buffer.alloc(0), truncated: false };
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  let truncated = false;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value || value.byteLength === 0) continue;
      if (total + value.byteLength > maxBytes) {
        const keep = maxBytes - total;
        if (keep > 0) chunks.push(Buffer.from(value.subarray(0, keep)));
        total = maxBytes;
        truncated = true;
        await reader.cancel().catch(() => undefined);
        break;
      }
      chunks.push(Buffer.from(value));
      total += value.byteLength;
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // 流已取消/释放时 releaseLock 会抛，忽略即可。
    }
  }
  return { buffer: Buffer.concat(chunks, total), truncated };
}

function makeHop(
  status: number,
  headerPairs: readonly HeaderPair[],
  storedBody: Buffer,
  truncated: boolean,
): Hop {
  const headers: Record<string, string> = {};
  for (const [name, value] of headerPairs) headers[name] = value;
  const headEnd = utf8Boundary(storedBody, Math.min(storedBody.length, RESPONSE_HEAD_BYTES));
  return {
    status,
    responseText: serializeResponse(status, headerPairs, storedBody.toString("utf8")),
    headers,
    bodyHead: storedBody.subarray(0, headEnd).toString("utf8"),
    truncated,
  };
}

function failureHop(): Hop {
  return {
    status: 0,
    responseText: NO_RESPONSE_TEXT,
    headers: {},
    bodyHead: "",
    truncated: false,
  };
}

function errorText(error: unknown): string {
  if (error instanceof AggregateError && error.errors.length > 0) {
    return error.errors.map(errorText).join("; ");
  }
  if (error instanceof Error) {
    const cause = (error as Error & { cause?: unknown }).cause;
    const causeText =
      cause instanceof Error && cause.message && !error.message.includes(cause.message)
        ? ` (${cause.message})`
        : "";
    const name = error.name && error.name !== "Error" ? `${error.name}: ` : "";
    return `${name}${error.message}${causeText}`;
  }
  return String(error);
}

function describeError(error: unknown): string {
  return `network error: ${errorText(error)}`;
}

function normalizeMaxRedirects(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value) || value < 0) return DEFAULT_MAX_REDIRECTS;
  return Math.trunc(value);
}

function normalizeMaxResponseBytes(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value) || value < 0) return DEFAULT_MAX_RESPONSE_BYTES;
  return Math.trunc(value);
}

function normalizeTimeout(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value) || value <= 0) return DEFAULT_TIMEOUT_MS;
  return Math.trunc(value);
}

function hasHeader(headers: Record<string, string>, name: string): boolean {
  const target = name.toLowerCase();
  return Object.keys(headers).some((key) => key.toLowerCase() === target);
}

function applyDefaultUserAgent(
  headers: Record<string, string>,
  configured?: string,
): Record<string, string> {
  if (hasHeader(headers, "user-agent")) return headers;
  const userAgent = resolveDefaultUserAgent(configured);
  if (/[\r\n\u0000]/.test(userAgent)) throw new TypeError("invalid User-Agent");
  return { ...headers, "User-Agent": userAgent };
}

function stripSensitiveHeaders(headers: Record<string, string>): Record<string, string> {
  const next: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (SENSITIVE_HEADERS.has(name.toLowerCase())) continue;
    next[name] = value;
  }
  return next;
}

/** 301/302 的 POST、303 的非 GET/HEAD 按 RFC 9110 换成 GET 并丢弃正文。 */
function rewriteForRedirect(
  status: number,
  method: string,
  body: string | undefined,
  headers: Record<string, string>,
): { method: string; body: string | undefined; headers: Record<string, string> } {
  const dropBody =
    ((status === 301 || status === 302) && method === "POST") ||
    (status === 303 && method !== "GET" && method !== "HEAD");
  if (!dropBody) return { method, body, headers };

  const nextHeaders: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    const lower = name.toLowerCase();
    if (lower === "content-length" || lower === "content-type") continue;
    nextHeaders[name] = value;
  }
  return { method: "GET", body: undefined, headers: nextHeaders };
}

function resolveLocation(location: string, base: URL): URL | null {
  try {
    const target = new URL(location, base);
    target.hash = "";
    return target;
  } catch {
    return null;
  }
}

function finish(args: {
  method: string;
  url: string;
  host: string;
  path: string;
  request: Blob;
  hop: Hop;
  redirects: string[];
  startedAtMs: number;
  evidenceDir: string;
  error?: string;
  blockedRedirect?: string;
}): { artifact: HttpArtifact; headers: Record<string, string>; bodyHead: string } {
  const response = persistBlob(args.evidenceDir, "res", args.hop.responseText);
  const artifact: HttpArtifact = {
    id: randomUUID(),
    method: args.method,
    url: args.url,
    host: args.host,
    path: args.path,
    status: args.hop.status,
    requestSha256: args.request.sha256,
    responseSha256: response.sha256,
    requestPath: args.request.path,
    responsePath: response.path,
    requestBytes: args.request.bytes,
    responseBytes: response.bytes,
    responseHead: args.hop.bodyHead,
    truncated: args.hop.truncated,
    redirects: args.redirects,
    startedAt: new Date(args.startedAtMs).toISOString(),
    durationMs: Math.max(0, Date.now() - args.startedAtMs),
  };
  if (args.error !== undefined) artifact.error = args.error;
  if (args.blockedRedirect !== undefined) artifact.blockedRedirect = args.blockedRedirect;
  return { artifact, headers: args.hop.headers, bodyHead: args.hop.bodyHead };
}

export async function performHttpRequest(
  input: { method?: string; url: string; headers?: Record<string, string>; body?: string; follow?: boolean; timeoutMs?: number },
  opts: HttpRequestOptions,
): Promise<{ artifact: HttpArtifact; headers: Record<string, string>; bodyHead: string }> {
  const startedAtMs = Date.now();
  const method = normalizeMethod(input.method);
  const headers = applyDefaultUserAgent(normalizeHeaders(input.headers), opts.userAgent);
  const initialUrl = normalizeUrl(input.url);
  const url = initialUrl.href;
  const host = initialUrl.hostname.toLowerCase();
  const path = `${initialUrl.pathname}${initialUrl.search}`;
  const follow = input.follow !== false;
  const maxRedirects = normalizeMaxRedirects(opts.maxRedirects);
  const maxResponseBytes = normalizeMaxResponseBytes(opts.maxResponseBytes);
  const timeoutMs = normalizeTimeout(input.timeoutMs);

  // When Go sidecar is active (and caller has not monkey-patched globalThis.fetch for a spy/mock),
  // delegate network I/O and atomic blob writes to gy-netd while keeping exact TS validation and authorizeHost callbacks.
  if (shouldUseGoBackend() && globalThis.fetch === NATIVE_FETCH) {
    const initialVerdict = opts.authorizeHost(host);
    if (!initialVerdict.allowed) {
      const request = persistBlob(opts.evidenceDir, "req", serializeRequest(method, url, headers, input.body));
      const reason = initialVerdict.reason ? `: ${initialVerdict.reason}` : "";
      return finish({
        method, url, host, path, request,
        hop: failureHop(),
        redirects: [],
        startedAtMs,
        evidenceDir: opts.evidenceDir,
        error: `blocked: host ${host} denied by authorizeHost${reason}`,
        blockedRedirect: host,
      });
    }

    let currentUrl = initialUrl;
    let currentMethod = method;
    let currentHeaders = headers;
    let currentBody = input.body;
    const redirects: string[] = [];
    const deadlineMs = startedAtMs + timeoutMs;
    let initialReqMeta: {
      requestSha256: string;
      requestPath: string;
      requestBytes: number;
    } | null = null;

    for (;;) {
      const remainingMs = Math.max(1, deadlineMs - Date.now());
      const hopResult: {
        artifact: HttpArtifact;
        headers: Record<string, string>;
        bodyHead: string;
      } = await netdJsonAsync<{
        artifact: HttpArtifact;
        headers: Record<string, string>;
        bodyHead: string;
      }>("POST", "/v1/http/request", {
        method: currentMethod,
        url: currentUrl.href,
        headers: currentHeaders,
        ...(currentBody !== undefined ? { body: currentBody } : {}),
        follow: false,
        maxRedirects: 0,
        maxResponseBytes,
        timeoutMs: remainingMs,
        evidenceDir: opts.evidenceDir,
        ...(opts.proxyUrl ? { proxyUrl: opts.proxyUrl } : {}),
        ...(opts.insecureTls ? { insecureTls: true } : {}),
        ...(initialReqMeta ? { skipRequestPersist: true } : {}),
      }, remainingMs + 5_000);

      if (!initialReqMeta) {
        initialReqMeta = {
          requestSha256: hopResult.artifact.requestSha256,
          requestPath: hopResult.artifact.requestPath,
          requestBytes: hopResult.artifact.requestBytes,
        };
      }

      const status = hopResult.artifact.status;
      const location = hopResult.headers["location"];
      if (
        follow
        && !hopResult.artifact.error
        && REDIRECT_STATUSES.has(status)
        && redirects.length < maxRedirects
        && location
      ) {
        const target = resolveLocation(location, currentUrl);
        if (target && (target.protocol === "http:" || target.protocol === "https:")) {
          const targetHost = target.hostname.toLowerCase();
          const verdict = opts.authorizeHost(targetHost);
          if (!verdict.allowed) {
            return {
              artifact: {
                ...hopResult.artifact,
                method,
                url,
                host,
                path,
                requestSha256: initialReqMeta.requestSha256,
                requestPath: initialReqMeta.requestPath,
                requestBytes: initialReqMeta.requestBytes,
                redirects: [...redirects],
                startedAt: new Date(startedAtMs).toISOString(),
                durationMs: Math.max(0, Date.now() - startedAtMs),
                blockedRedirect: targetHost,
              },
              headers: hopResult.headers,
              bodyHead: hopResult.bodyHead,
            };
          }
          redirects.push(target.href);
          const rewritten = rewriteForRedirect(status, currentMethod, currentBody, currentHeaders);
          currentMethod = rewritten.method;
          currentBody = rewritten.body;
          currentHeaders =
            target.origin === currentUrl.origin
              ? rewritten.headers
              : stripSensitiveHeaders(rewritten.headers);
          currentUrl = target;
          continue;
        }
      }

      return {
        artifact: {
          ...hopResult.artifact,
          method,
          url,
          host,
          path,
          requestSha256: initialReqMeta.requestSha256,
          requestPath: initialReqMeta.requestPath,
          requestBytes: initialReqMeta.requestBytes,
          redirects,
          startedAt: new Date(startedAtMs).toISOString(),
          durationMs: Math.max(0, Date.now() - startedAtMs),
        },
        headers: hopResult.headers,
        bodyHead: hopResult.bodyHead,
      };
    }
  }

  // 请求 blob 先落盘：证据先于动作；同内容重复调用只是跳过写入。
  const request = persistBlob(opts.evidenceDir, "req", serializeRequest(method, url, headers, input.body));

  let timedOut = false;
  const controller = new AbortController();
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  try {
    const initialVerdict = opts.authorizeHost(host);
    if (!initialVerdict.allowed) {
      const reason = initialVerdict.reason ? `: ${initialVerdict.reason}` : "";
      return finish({
        method, url, host, path, request,
        hop: failureHop(),
        redirects: [],
        startedAtMs,
        evidenceDir: opts.evidenceDir,
        error: `blocked: host ${host} denied by authorizeHost${reason}`,
        blockedRedirect: host,
      });
    }

    let currentUrl = initialUrl;
    let currentMethod = method;
    let currentHeaders = headers;
    let currentBody = input.body;
    const redirects: string[] = [];

    for (;;) {
      let status: number;
      let headerPairs: HeaderPair[] = [];
      let bodyRead: { buffer: Buffer; truncated: boolean };
      let location: string | null;
      try {
        const response = await fetch(currentUrl.href, {
          method: currentMethod,
          headers: currentHeaders,
          redirect: "manual",
          signal: controller.signal,
          ...(currentBody !== undefined ? { body: currentBody } : {}),
        });
        status = response.status;
        response.headers.forEach((value, name) => {
          headerPairs.push([name.toLowerCase(), value]);
        });
        location = response.headers.get("location");
        bodyRead = await readBody(response, maxResponseBytes);
      } catch (error) {
        return finish({
          method, url, host, path, request,
          hop: failureHop(),
          redirects: [...redirects],
          startedAtMs,
          evidenceDir: opts.evidenceDir,
          error: timedOut ? `timeout after ${timeoutMs}ms` : describeError(error),
        });
      }

      // 文件里的正文与 sha 必须一致：先按 UTF-8 边界回退，再序列化/落盘。
      let storedBody = bodyRead.buffer;
      if (bodyRead.truncated && storedBody.length > 0) {
        storedBody = storedBody.subarray(0, utf8SafeLength(storedBody));
      }
      const hop = makeHop(status, headerPairs, storedBody, bodyRead.truncated);

      if (follow && REDIRECT_STATUSES.has(status) && redirects.length < maxRedirects && location) {
        const target = resolveLocation(location, currentUrl);
        if (target && (target.protocol === "http:" || target.protocol === "https:")) {
          const targetHost = target.hostname.toLowerCase();
          const verdict = opts.authorizeHost(targetHost);
          if (!verdict.allowed) {
            // 不跟随、不重写：返回最后一跳的 3xx 结果，只记录被拒 host。
            return finish({
              method, url, host, path, request,
              hop,
              redirects: [...redirects],
              startedAtMs,
              evidenceDir: opts.evidenceDir,
              blockedRedirect: targetHost,
            });
          }

          redirects.push(target.href);
          const rewritten = rewriteForRedirect(status, currentMethod, currentBody, currentHeaders);
          currentMethod = rewritten.method;
          currentBody = rewritten.body;
          currentHeaders =
            target.origin === currentUrl.origin
              ? rewritten.headers
              : stripSensitiveHeaders(rewritten.headers);
          currentUrl = target;
          continue;
        }
      }

      return finish({
        method, url, host, path, request,
        hop,
        redirects,
        startedAtMs,
        evidenceDir: opts.evidenceDir,
      });
    }
  } finally {
    clearTimeout(timer);
  }
}

export type HttpBatchItemInput = {
  method?: string;
  url: string;
  headers?: Record<string, string>;
  body?: string;
  follow?: boolean;
  timeoutMs?: number;
};

export type HttpBatchOptions = HttpRequestOptions & {
  /** Max concurrent requests in the Go/TS pool (default 16, max 64). */
  concurrency?: number;
};

export type HttpBatchItemResult =
  | { ok: true; result: { artifact: HttpArtifact; headers: Record<string, string>; bodyHead: string } }
  | { ok: false; error: string };

/**
 * Concurrent HTTP transaction batch. Uses Go gy-netd's native Goroutine pool
 * (`POST /v1/http/batch`) when available and `opts.scope` is supplied; otherwise
 * runs a bounded concurrent pool preserving input order.
 */
export async function performHttpBatch(
  items: HttpBatchItemInput[],
  opts: HttpBatchOptions,
): Promise<HttpBatchItemResult[]> {
  if (items.length === 0) return [];
  const concurrency = Math.max(1, Math.min(64, Math.trunc(opts.concurrency ?? 16)));
  const maxRedirects = normalizeMaxRedirects(opts.maxRedirects);
  const maxResponseBytes = normalizeMaxResponseBytes(opts.maxResponseBytes);

  if (shouldUseGoBackend() && opts.scope) {
    const payloadItems = items.map((item) => {
      const method = normalizeMethod(item.method);
      const headers = applyDefaultUserAgent(normalizeHeaders(item.headers), opts.userAgent);
      const initialUrl = normalizeUrl(item.url);
      return {
        method,
        url: initialUrl.href,
        headers,
        ...(item.body !== undefined ? { body: item.body } : {}),
        follow: item.follow !== false,
        maxRedirects,
        maxResponseBytes,
        timeoutMs: normalizeTimeout(item.timeoutMs),
        evidenceDir: opts.evidenceDir,
        scope: opts.scope,
        ...(opts.proxyUrl ? { proxyUrl: opts.proxyUrl } : {}),
        ...(opts.insecureTls ? { insecureTls: true } : {}),
      };
    });
    const res = await netdJsonAsync<{ results: HttpBatchItemResult[] }>(
      "POST",
      "/v1/http/batch",
      { concurrency, items: payloadItems },
      120_000,
    );
    return res.results;
  }

  const out: HttpBatchItemResult[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, async () => {
      for (;;) {
        const idx = next++;
        if (idx >= items.length) return;
        try {
          const result = await performHttpRequest(items[idx]!, opts);
          out[idx] = { ok: true, result };
        } catch (err) {
          out[idx] = { ok: false, error: err instanceof Error ? err.message : String(err) };
        }
      }
    }),
  );
  return out;
}

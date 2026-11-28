import { createHash, randomUUID } from "node:crypto";
import { createWriteStream, mkdirSync } from "node:fs";
import { request as httpRequest, createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { request as httpsRequest } from "node:https";
import { connect as netConnect, isIP, type Socket } from "node:net";
import { connect as tlsConnect, createSecureContext, createServer as createTlsServer, type TLSSocket } from "node:tls";
import { join } from "node:path";
import { PassThrough, type Readable } from "node:stream";
import { once } from "node:events";
import type { TrafficBlobRef } from "@gongyuai/contracts";
import { commitHashedFile } from "./blobs.js";
import { ensureTaskCa, leafFor, type TaskCa } from "./ca.js";
import { decodeTrafficPreview, hasSupportedContentEncoding } from "./encoding.js";
import {
  isNoiseExchange,
  isStaticAssetExchange,
  resolveTrafficMode,
  resolveTrafficRetention,
  type TrafficMode,
} from "./retention.js";
import {
  consumeFindingWindows,
  matchFindingWindows,
  noteNoise404,
  persistCapturedExchange,
  pushTrafficRing,
  trafficWindowDefaults,
  type CapturedBody,
} from "./ring.js";
import { closeTrafficDb, insertTraffic, type TrafficWrite } from "./store.js";
import {
  markGoTaskDir,
  netdJsonAsync,
  netdJsonSync,
  shouldUseGoBackend,
} from "../netd-client.js";

const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

export type TrafficProxyOptions = {
  taskId: string;
  taskDir: string;
  workerId?: string;
  intentId?: string;
  /** Dynamic active-intent getter (overrides static intentId per request). */
  getIntentId?: () => string | null | undefined;
  /** `http://host:port` upstream. Changed later with `setUpstream`. */
  upstream?: string | null;
  /** Accept upstream TLS certificates that this process does not trust. */
  insecureUpstream?: boolean;
  /** Retention mode. Default: `GY_TRAFFIC_MODE`, else `finding-window`. */
  mode?: TrafficMode;
};

export type TrafficProxy = {
  port: number;
  caPath: string;
  /** Env for a worker child. Does not write `process.env`. */
  getProxyEnv(): Record<string, string>;
  setUpstream(url: string | null): void;
  close(): Promise<void>;
};

type Upstream = { hostname: string; port: number };

function headerMap(headers: IncomingMessage["headers"]): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (value == null || HOP_BY_HOP.has(key.toLowerCase())) continue;
    out[key] = value;
  }
  return out;
}

function contentType(headers: Record<string, string | string[]>): string | undefined {
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() !== "content-type") continue;
    const raw = Array.isArray(value) ? value[0] : value;
    return raw?.split(";")[0]?.trim() || undefined;
  }
  return undefined;
}

function parseUpstream(value: string | null | undefined): Upstream | null {
  if (!value) return null;
  const url = new URL(value);
  if (url.protocol !== "http:") throw new Error("upstream proxy must be an http:// URL");
  return { hostname: url.hostname, port: Number(url.port || 80) };
}

type Spool = {
  forward: PassThrough;
  done: Promise<{ ref?: TrafficBlobRef; preview: string }>;
};

function spool(
  source: Readable,
  taskDir: string,
  type: string | undefined,
  maxPreviewBytes: number,
  headers?: Record<string, string | string[]>,
): Spool {
  const forward = new PassThrough();
  // Source abort destroys forward with an error; no listener would crash the worker (done already rejects → 502).
  forward.on("error", () => {});
  const tmpDir = join(taskDir, "traffic", "_tmp");
  mkdirSync(tmpDir, { recursive: true, mode: 0o700 });
  const tmp = join(tmpDir, randomUUID());
  const file = createWriteStream(tmp, { mode: 0o600 });
  const hash = createHash("sha256");
  let size = 0;
  const preview: Buffer[] = [];
  let previewLen = 0;
  const previewCap = Math.max(0, Math.min(8192, maxPreviewBytes));
  const rawPreviewCap = previewCap > 0 && hasSupportedContentEncoding(headers) ? 64 * 1024 : previewCap;
  const done = new Promise<{ ref?: TrafficBlobRef; preview: string }>((resolve, reject) => {
    const fail = (err: Error) => {
      forward.destroy(err);
      file.destroy();
      reject(err);
    };
    source.on("data", (chunk: Buffer | string) => {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      hash.update(buf);
      size += buf.length;
      if (rawPreviewCap > 0 && previewLen < rawPreviewCap) {
        preview.push(buf);
        previewLen += buf.length;
      }
      const wrote = file.write(buf);
      const passed = forward.write(buf);
      if (!wrote || !passed) source.pause();
    });
    file.on("drain", () => source.resume());
    forward.on("drain", () => source.resume());
    source.on("end", () => {
      forward.end();
      file.end(() => {
        const sha256 = hash.digest("hex");
        const text = previewCap > 0
          ? decodeTrafficPreview(Buffer.concat(preview).subarray(0, rawPreviewCap), headers, previewCap)
          : "";
        try {
          const ref = commitHashedFile(taskDir, tmp, sha256, size, type);
          resolve({ ...(ref ? { ref } : {}), preview: text });
        } catch (err) {
          reject(err instanceof Error ? err : new Error(String(err)));
        }
      });
    });
    source.on("error", fail);
    file.on("error", fail);
  });
  return { forward, done };
}

type Capture = {
  forward: PassThrough;
  done: Promise<CapturedBody>;
};

/**
 * Memory-only capture: forwards every byte, keeps at most `cap` head bytes
 * (copied, so upstream chunks are not retained) plus true size + sha256.
 * No temp file, no blob.
 */
function capture(source: Readable, cap: number, type: string | undefined): Capture {
  const forward = new PassThrough();
  forward.on("error", () => {});
  const hash = createHash("sha256");
  const parts: Buffer[] = [];
  let kept = 0;
  let size = 0;
  const done = new Promise<CapturedBody>((resolve, reject) => {
    source.on("data", (chunk: Buffer | string) => {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      hash.update(buf);
      size += buf.length;
      if (kept < cap) {
        const take = buf.subarray(0, cap - kept);
        parts.push(Buffer.from(take));
        kept += take.length;
      }
      if (!forward.write(buf)) source.pause();
    });
    forward.on("drain", () => source.resume());
    source.on("end", () => {
      forward.end();
      resolve({
        head: Buffer.concat(parts),
        size,
        sha256: hash.digest("hex"),
        ...(type ? { contentType: type } : {}),
      });
    });
    source.on("error", (err) => {
      forward.destroy(err);
      reject(err);
    });
  });
  return { forward, done };
}

function connectTunnel(upstream: Upstream, host: string, port: number): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = netConnect(upstream.port, upstream.hostname);
    const fail = (err: Error) => {
      socket.destroy();
      reject(err);
    };
    socket.once("error", fail);
    socket.once("connect", () => {
      socket.write(`CONNECT ${host}:${port} HTTP/1.1\r\nHost: ${host}:${port}\r\n\r\n`);
      let buf = Buffer.alloc(0);
      const onData = (chunk: Buffer) => {
        buf = Buffer.concat([buf, chunk]);
        const split = buf.indexOf("\r\n\r\n");
        if (split < 0) return;
        socket.off("data", onData);
        socket.off("error", fail);
        const status = buf.subarray(0, split).toString("utf8").split("\r\n")[0] ?? "";
        if (!/^HTTP\/1\.[01] 200\b/.test(status)) {
          socket.destroy();
          reject(new Error(`upstream CONNECT failed: ${status}`));
          return;
        }
        const rest = buf.subarray(split + 4);
        if (rest.length) socket.unshift(rest);
        resolve(socket);
      };
      socket.on("data", onData);
    });
  });
}

function responseOf(req: ReturnType<typeof httpRequest>, body: Readable): Promise<IncomingMessage> {
  body.pipe(req);
  return new Promise((resolve, reject) => {
    req.once("response", resolve);
    req.once("error", reject);
  });
}

async function openUpstream(
  target: URL,
  method: string,
  headers: Record<string, string | string[]>,
  body: Readable,
  upstream: Upstream | null,
  insecureUpstream: boolean,
): Promise<IncomingMessage> {
  const port = Number(target.port || (target.protocol === "https:" ? 443 : 80));
  if (!upstream) {
    if (target.protocol === "https:") {
      return responseOf(httpsRequest({
        hostname: target.hostname,
        port,
        method,
        path: `${target.pathname}${target.search}`,
        headers,
        rejectUnauthorized: !insecureUpstream,
        ...(isIP(target.hostname) ? {} : { servername: target.hostname }),
      }), body);
    }
    return responseOf(httpRequest({
      hostname: target.hostname,
      port,
      method,
      path: `${target.pathname}${target.search}`,
      headers,
    }), body);
  }
  if (target.protocol === "http:") {
    return responseOf(httpRequest({
      hostname: upstream.hostname,
      port: upstream.port,
      method,
      path: target.href,
      headers: { ...headers, host: target.host },
    }), body);
  }
  const tunnel = await connectTunnel(upstream, target.hostname, port);
  const tlsSock = tlsConnect({
    socket: tunnel,
    ...(isIP(target.hostname) ? { host: target.hostname } : { servername: target.hostname }),
    rejectUnauthorized: !insecureUpstream,
  });
  await once(tlsSock, "secureConnect");
  return responseOf(httpRequest({
    createConnection: () => tlsSock,
    hostname: target.hostname,
    port,
    method,
    path: `${target.pathname}${target.search}`,
    headers,
  }), body);
}

/**
 * Local recording proxy. Binds `127.0.0.1:0` only and returns env vars for a
 * child process. It does not change the host proxy configuration.
 */
export async function startTrafficProxy(opts: TrafficProxyOptions): Promise<TrafficProxy> {
  const retention = resolveTrafficRetention();
  const mode = opts.mode ?? resolveTrafficMode();
  const windowConfig = trafficWindowDefaults();

  if (shouldUseGoBackend()) {
    parseUpstream(opts.upstream);
    const initialIntent = opts.getIntentId?.() ?? opts.intentId;
    const started = await netdJsonAsync<{
      proxyId: string;
      port: number;
      caPath: string;
      proxyUrl: string;
    }>("POST", "/v1/proxy/start", {
      taskId: opts.taskId,
      taskDir: opts.taskDir,
      ...(opts.workerId ? { workerId: opts.workerId } : {}),
      ...(initialIntent ? { intentId: initialIntent } : {}),
      ...(opts.upstream ? { upstream: opts.upstream } : {}),
      insecureUpstream: opts.insecureUpstream === true,
      mode,
      retention,
      windowConfig,
    });
    markGoTaskDir(opts.taskDir);

    let lastIntent = initialIntent ?? "";
    let intentTimer: ReturnType<typeof setInterval> | null = null;
    if (opts.getIntentId) {
      intentTimer = setInterval(() => {
        const next = opts.getIntentId?.() ?? "";
        if (next === lastIntent) return;
        lastIntent = next;
        void netdJsonAsync("POST", `/v1/proxy/${started.proxyId}/context`, {
          intentId: next,
        }).catch(() => {});
      }, 50);
      intentTimer.unref();
    }

    return {
      port: started.port,
      caPath: started.caPath,
      getProxyEnv() {
        const proxyUrl = `http://127.0.0.1:${started.port}`;
        return {
          HTTP_PROXY: proxyUrl,
          HTTPS_PROXY: proxyUrl,
          http_proxy: proxyUrl,
          https_proxy: proxyUrl,
          NODE_EXTRA_CA_CERTS: started.caPath,
          REQUESTS_CA_BUNDLE: started.caPath,
          SSL_CERT_FILE: started.caPath,
          CURL_CA_BUNDLE: started.caPath,
          NODE_USE_ENV_PROXY: "1",
        };
      },
      setUpstream(url: string | null) {
        parseUpstream(url);
        netdJsonSync("POST", `/v1/proxy/${started.proxyId}/upstream`, {
          upstream: url ?? "",
        });
      },
      async close() {
        if (intentTimer) {
          clearInterval(intentTimer);
          intentTimer = null;
        }
        await netdJsonAsync("POST", `/v1/proxy/${started.proxyId}/stop`, {}).catch(() => {});
        closeTrafficDb(opts.taskDir);
      },
    };
  }

  const ca = ensureTaskCa(opts.taskDir);
  const previewBytes = retention.maxPreviewChars;
  const ringBodyBytes = windowConfig.ringBodyBytes;
  let upstream = parseUpstream(opts.upstream);
  const insecureUpstream = opts.insecureUpstream === true;
  const sockets = new Set<Socket>();
  const tlsServers = new Map<string, ReturnType<typeof createTlsServer>>();
  const connectMeta = new WeakMap<Socket, { host: string; port: number }>();

  const plain = createServer((req, res) => {
    void handle(req, res).catch((err: unknown) => {
      if (!res.headersSent) res.writeHead(502, { "content-type": "text/plain" });
      res.end(err instanceof Error ? err.message : "proxy error");
    });
  });

  async function recordExchange(
    target: URL,
    req: IncomingMessage,
    res: ServerResponse,
    upstreamRes: IncomingMessage,
    reqSpool: Spool,
    started: number,
  ): Promise<void> {
    const resHeaders = headerMap(upstreamRes.headers);
    const type = contentType(resHeaders);
    const resSpool = spool(upstreamRes, opts.taskDir, type, previewBytes, resHeaders);
    const headers = { ...resHeaders };
    delete headers["content-length"];
    // Hold the client response open until the index row is durable.
    const gate = new PassThrough();
    res.writeHead(upstreamRes.statusCode ?? 502, headers);
    gate.pipe(res);
    resSpool.forward.pipe(gate, { end: false });
    const reqHeaders = headerMap(req.headers);
    const [reqBody, resBody] = await Promise.all([reqSpool.done, resSpool.done]);
    const currentIntentId = opts.getIntentId?.() ?? opts.intentId;
    const windowIds = matchFindingWindows(opts.taskDir, { intentId: currentIntentId, host: target.hostname });
    try {
      insertTraffic(opts.taskDir, {
        taskId: opts.taskId,
        ...(currentIntentId ? { intentId: currentIntentId } : {}),
        ...(opts.workerId ? { workerId: opts.workerId } : {}),
        method: (req.method ?? "GET").toUpperCase(),
        url: target.href,
        host: target.hostname,
        path: `${target.pathname}${target.search}` || "/",
        status: upstreamRes.statusCode ?? 0,
        durationMs: Date.now() - started,
        startedAt: new Date(started).toISOString(),
        reqHeaders,
        resHeaders,
        ...(reqBody.ref ? { reqBody: reqBody.ref } : {}),
        ...(resBody.ref ? { resBody: resBody.ref } : {}),
        reqPreview: reqBody.preview,
        resPreview: resBody.preview,
        ...(windowIds.length ? { findingIds: windowIds } : {}),
      });
      if (windowIds.length) consumeFindingWindows(opts.taskDir, windowIds);
    } finally {
      gate.end();
    }
  }

  /**
   * finding-window mode. Static assets and repeated 404s stream straight
   * through (no memory, no disk). Exchanges that hit a live finding
   * post-window go to blobs/ + index.sqlite. Everything else lands only in the
   * bounded in-memory ring.
   */
  async function handleWindowed(target: URL, req: IncomingMessage, res: ServerResponse, started: number): Promise<void> {
    const method = (req.method ?? "GET").toUpperCase();
    const reqHeaders = headerMap(req.headers);
    const reqCap = capture(req, ringBodyBytes, contentType(reqHeaders));
    reqCap.done.catch(() => {});
    const upstreamRes = await openUpstream(target, method, reqHeaders, reqCap.forward, upstream, insecureUpstream);
    const resHeaders = headerMap(upstreamRes.headers);
    const outHeaders = { ...resHeaders };
    delete outHeaders["content-length"];
    const currentIntentId = opts.getIntentId?.() ?? opts.intentId;
    const write: Omit<TrafficWrite, "reqBody" | "resBody" | "findingIds" | "id"> = {
      taskId: opts.taskId,
      ...(currentIntentId ? { intentId: currentIntentId } : {}),
      ...(opts.workerId ? { workerId: opts.workerId } : {}),
      method,
      url: target.href,
      host: target.hostname,
      path: `${target.pathname}${target.search}` || "/",
      status: upstreamRes.statusCode ?? 0,
      durationMs: 0,
      startedAt: new Date(started).toISOString(),
      reqHeaders,
      resHeaders,
    };
    const skip = (retention.compactStaticAssets && isStaticAssetExchange(write))
      || isNoiseExchange(write, noteNoise404(opts.taskDir, write), retention);
    res.writeHead(upstreamRes.statusCode ?? 502, outHeaders);
    if (skip) {
      upstreamRes.on("error", () => {});
      upstreamRes.pipe(res);
      return;
    }
    const resCap = capture(upstreamRes, ringBodyBytes, contentType(resHeaders));
    // Hold the client response open until the exchange is searchable.
    const gate = new PassThrough();
    gate.pipe(res);
    resCap.forward.pipe(gate, { end: false });
    try {
      const [reqBody, resBody] = await Promise.all([reqCap.done, resCap.done]);
      const done = { ...write, durationMs: Date.now() - started };
      const windowIds = matchFindingWindows(opts.taskDir, { intentId: currentIntentId, host: target.hostname });
      if (windowIds.length) {
        persistCapturedExchange(opts.taskDir, { write: done, reqBody, resBody, findingIds: windowIds });
        consumeFindingWindows(opts.taskDir, windowIds);
      } else {
        pushTrafficRing(opts.taskDir, { id: randomUUID(), atMs: started, write: done, reqBody, resBody });
      }
    } finally {
      gate.end();
    }
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const started = Date.now();
    const socket = req.socket as TLSSocket & { __gyHost?: string; __gyPort?: number };
    const mitmHost = socket.__gyHost;
    let target: URL;
    if (mitmHost) {
      const port = socket.__gyPort ?? 443;
      const path = req.url ?? "/";
      target = new URL(path, `https://${mitmHost}${port === 443 ? "" : `:${port}`}`);
    } else if (req.url && /^https?:\/\//i.test(req.url)) {
      target = new URL(req.url);
    } else {
      const host = req.headers.host;
      if (!host) throw new Error("proxy request is missing a host");
      target = new URL(req.url ?? "/", `http://${host}`);
    }
    if (mode === "finding-window") {
      await handleWindowed(target, req, res, started);
      return;
    }
    const reqHeaders = headerMap(req.headers);
    const reqSpool = spool(req, opts.taskDir, contentType(reqHeaders), previewBytes, reqHeaders);
    const upstreamRes = await openUpstream(
      target,
      (req.method ?? "GET").toUpperCase(),
      reqHeaders,
      reqSpool.forward,
      upstream,
      insecureUpstream,
    );
    await recordExchange(target, req, res, upstreamRes, reqSpool, started);
  }

  function tlsFor(host: string): ReturnType<typeof createTlsServer> {
    const cached = tlsServers.get(host);
    if (cached) return cached;
    const pem = leafFor(ca, host);
    const server = createTlsServer({ cert: pem.cert, key: pem.key, SNICallback: (_name, cb) => {
      cb(null, createSecureContext(leafFor(ca, host)));
    } });
    server.on("secureConnection", (clear) => {
      const raw = (clear as TLSSocket & { _parent?: Socket })._parent;
      const meta = (raw && connectMeta.get(raw)) || { host, port: 443 };
      const marked = clear as TLSSocket & { __gyHost?: string; __gyPort?: number };
      marked.__gyHost = meta.host;
      marked.__gyPort = meta.port;
      plain.emit("connection", clear);
    });
    server.on("tlsClientError", () => {});
    tlsServers.set(host, server);
    return server;
  }

  plain.on("connect", (req: IncomingMessage, clientSocket: Socket, head: Buffer) => {
    const [host, portRaw] = String(req.url ?? "").split(":");
    const port = Number(portRaw || 443);
    if (!host) {
      clientSocket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
      return;
    }
    clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    if (head.length) clientSocket.unshift(head);
    connectMeta.set(clientSocket, { host, port });
    tlsFor(host).emit("connection", clientSocket);
  });

  plain.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  plain.on("clientError", (_err, socket) => socket.destroy());

  await new Promise<void>((resolve, reject) => {
    plain.once("error", reject);
    plain.listen(0, "127.0.0.1", () => resolve());
  });
  const address = plain.address();
  if (!address || typeof address === "string" || address.address !== "127.0.0.1") {
    plain.close();
    throw new Error("traffic proxy must listen on 127.0.0.1");
  }

  return {
    port: address.port,
    caPath: ca.certPath,
    getProxyEnv() {
      const proxyUrl = `http://127.0.0.1:${address.port}`;
      return {
        HTTP_PROXY: proxyUrl,
        HTTPS_PROXY: proxyUrl,
        http_proxy: proxyUrl,
        https_proxy: proxyUrl,
        NODE_EXTRA_CA_CERTS: ca.certPath,
        REQUESTS_CA_BUNDLE: ca.certPath,
        SSL_CERT_FILE: ca.certPath,
        CURL_CA_BUNDLE: ca.certPath,
        NODE_USE_ENV_PROXY: "1",
      };
    },
    setUpstream(url: string | null) {
      upstream = parseUpstream(url);
    },
    async close() {
      for (const socket of sockets) socket.destroy();
      for (const server of tlsServers.values()) server.close();
      tlsServers.clear();
      await new Promise<void>((resolve) => plain.close(() => resolve()));
      closeTrafficDb(opts.taskDir);
    },
  };
}

export type { TaskCa };

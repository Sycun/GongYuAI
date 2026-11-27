import { spawn } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

/**
 * 后台作业：一次工具调用之外的命令，活过 120s 工具超时。
 *
 * - 进程 detached + unref，本进程退出后仍在跑；
 * - stdout/stderr 直接落盘，按字节偏移增量读；
 * - 退出码由包装 shell 写入 `exit.code`，重启后据 pid + exit.code 复原状态。
 */

export type JobStatus = "running" | "exited" | "killed" | "failed";

export type JobMeta = {
  id: string;
  label: string;
  command: string;
  cwd: string;
  pid: number | null;
  startedAt: string;
  endedAt: string | null;
  status: JobStatus;
  exitCode: number | null;
  stdoutPath: string;
  stderrPath: string;
  exitPath: string;
  capBytes: number;
};

export type JobChunk = {
  stream: "stdout" | "stderr";
  data: string;
  offset: number;
  nextOffset: number;
  size: number;
  eof: boolean;
};

const CAP_BYTES = 8 * 1024 * 1024;

function pidAlive(pid: number | null): boolean {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

export class JobStore {
  constructor(private readonly baseDir: string) {
    mkdirSync(join(this.baseDir, "jobs"), { recursive: true });
  }

  private jobsDir(): string {
    return join(this.baseDir, "jobs");
  }

  private dir(id: string): string {
    return join(this.jobsDir(), id);
  }

  private metaPath(id: string): string {
    return join(this.dir(id), "meta.json");
  }

  start(input: { command: string; cwd: string; label?: string; env?: NodeJS.ProcessEnv }): JobMeta {
    const id = `${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
    const dir = this.dir(id);
    mkdirSync(dir, { recursive: true });
    const stdoutPath = join(dir, "stdout.log");
    const stderrPath = join(dir, "stderr.log");
    const exitPath = join(dir, "exit.code");
    const out = openSync(stdoutPath, "a");
    const err = openSync(stderrPath, "a");
    const wrapped = `(\n${input.command}\n) ; __gy_ec=$? ; printf '%s' "$__gy_ec" > ${JSON.stringify(exitPath)}`;
    const child = spawn("/bin/bash", ["-lc", wrapped], {
      cwd: input.cwd,
      env: input.env ?? process.env,
      detached: true,
      stdio: ["ignore", out, err],
    });
    closeSync(out);
    closeSync(err);
    const meta: JobMeta = {
      id,
      label: (input.label ?? input.command).slice(0, 120),
      command: input.command,
      cwd: input.cwd,
      pid: child.pid ?? null,
      startedAt: new Date().toISOString(),
      endedAt: null,
      status: "running",
      exitCode: null,
      stdoutPath,
      stderrPath,
      exitPath,
      capBytes: CAP_BYTES,
    };
    writeFileSync(this.metaPath(id), JSON.stringify(meta, null, 2));
    // 同一进程内可即时观察退出；重启后由 reconcile 复原。
    child.on("exit", (code) => {
      try {
        const live = this.get(id);
        if (!live) return;
        if (live.status === "killed") return;
        live.status = "exited";
        live.exitCode = code;
        live.endedAt = new Date().toISOString();
        writeFileSync(this.metaPath(id), JSON.stringify(live, null, 2));
      } catch {
        /* 元数据写失败不阻塞任务 */
      }
    });
    child.unref();
    return meta;
  }

  get(id: string): JobMeta | null {
    const path = this.metaPath(id);
    if (!existsSync(path)) return null;
    try {
      return JSON.parse(readFileSync(path, "utf8")) as JobMeta;
    } catch {
      return null;
    }
  }

  list(): JobMeta[] {
    if (!existsSync(this.jobsDir())) return [];
    return readdirSync(this.jobsDir())
      .map((id) => this.get(id))
      .filter((m): m is JobMeta => !!m)
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  }

  /** 按 pid + exit.code 复原状态；返回有变化的作业。 */
  reconcile(): JobMeta[] {
    const changed: JobMeta[] = [];
    for (const meta of this.list()) {
      if (meta.status !== "running") continue;
      const exitCode = existsSync(meta.exitPath)
        ? Number(readFileSync(meta.exitPath, "utf8").trim() || "0")
        : null;
      if (exitCode !== null && Number.isFinite(exitCode)) {
        meta.status = "exited";
        meta.exitCode = exitCode;
        meta.endedAt = meta.endedAt ?? new Date().toISOString();
        writeFileSync(this.metaPath(meta.id), JSON.stringify(meta, null, 2));
        changed.push(meta);
        continue;
      }
      if (!pidAlive(meta.pid)) {
        meta.status = "failed";
        meta.endedAt = meta.endedAt ?? new Date().toISOString();
        writeFileSync(this.metaPath(meta.id), JSON.stringify(meta, null, 2));
        changed.push(meta);
      }
    }
    return changed;
  }

  read(id: string, stream: "stdout" | "stderr", offset = 0): JobChunk | null {
    const meta = this.get(id);
    if (!meta) return null;
    const path = stream === "stdout" ? meta.stdoutPath : meta.stderrPath;
    if (!existsSync(path)) {
      return { stream, data: "", offset, nextOffset: offset, size: 0, eof: meta.status !== "running" };
    }
    const size = statSync(path).size;
    const start = Math.max(0, Math.min(offset, size));
    const length = Math.max(0, Math.min(size - start, meta.capBytes));
    if (length <= 0) return { stream, data: "", offset: start, nextOffset: start, size, eof: meta.status !== "running" };
    const fd = openSync(path, "r");
    try {
      const buf = Buffer.alloc(length);
      const read = readSync(fd, buf, 0, length, start);
      const data = buf.subarray(0, read).toString("utf8");
      return {
        stream,
        data,
        offset: start,
        nextOffset: start + read,
        size,
        eof: meta.status !== "running" && start + read >= size,
      };
    } finally {
      closeSync(fd);
    }
  }

  kill(id: string): JobMeta | null {
    const meta = this.get(id);
    if (!meta) return null;
    if (meta.status === "running") {
      if (meta.pid) {
        try {
          process.kill(-meta.pid, "SIGKILL");
        } catch {
          try {
            process.kill(meta.pid, "SIGKILL");
          } catch {
            /* already gone */
          }
        }
      }
      meta.status = "killed";
      meta.endedAt = new Date().toISOString();
      writeFileSync(this.metaPath(id), JSON.stringify(meta, null, 2));
    }
    return meta;
  }

  /** Kill every job still marked running, including ones started by another process. */
  killAll(): void {
    for (const meta of this.list()) {
      if (meta.status === "running") this.kill(meta.id);
    }
  }

  /** 等待作业结束（可选按输出空闲判定），用于交互式命令的同步包装。 */
  async wait(
    id: string,
    opts: { timeoutMs?: number; idleMs?: number; untilOutput?: string } = {},
  ): Promise<{ meta: JobMeta | null; stdout: JobChunk | null; idle: boolean; matched: boolean }> {
    const timeoutMs = opts.timeoutMs ?? 30_000;
    const idleMs = opts.idleMs ?? 400;
    const deadline = Date.now() + timeoutMs;
    let lastSize = -1;
    let lastChange = Date.now();
    let out = this.read(id, "stdout", 0);
    while (Date.now() < deadline) {
      const meta = this.get(id);
      out = this.read(id, "stdout", 0);
      const size = out?.size ?? 0;
      if (size !== lastSize) {
        lastSize = size;
        lastChange = Date.now();
      }
      if (opts.untilOutput && out?.data.includes(opts.untilOutput)) {
        return { meta, stdout: out, idle: false, matched: true };
      }
      if (meta && meta.status !== "running") {
        return { meta, stdout: out, idle: false, matched: false };
      }
      if (!opts.untilOutput && Date.now() - lastChange >= idleMs && (out?.data.length ?? 0) > 0) {
        return { meta, stdout: out, idle: true, matched: false };
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    return { meta: this.get(id), stdout: this.read(id, "stdout", 0), idle: false, matched: false };
  }
}

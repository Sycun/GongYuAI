import { spawn } from "node:child_process";

/** 一次性前台执行：异步 spawn，超时/中止时按进程组杀，输出有上限。 */
export type RunResult = {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  killed: boolean;
  truncated: boolean;
  durationMs: number;
  signal: NodeJS.Signals | null;
};

export type RunOptions = {
  command: string;
  cwd: string;
  shellPath?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  maxBytes?: number;
  signal?: AbortSignal;
};

const DEFAULT_MAX_BYTES = 1_000_000;

function killTree(pid: number | undefined, signal: NodeJS.Signals): void {
  if (!pid) return;
  try {
    process.kill(-pid, signal);
  } catch {
    try {
      process.kill(pid, signal);
    } catch {
      /* already gone */
    }
  }
}

export function runCommand(opts: RunOptions): Promise<RunResult> {
  const started = Date.now();
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
  return new Promise((resolve) => {
    const child = spawn(opts.shellPath ?? "/bin/bash", ["-lc", opts.command], {
      cwd: opts.cwd,
      env: opts.env ?? process.env,
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let truncated = false;
    let timedOut = false;
    let killed = false;
    let settled = false;

    const append = (target: "out" | "err", chunk: Buffer) => {
      const current = target === "out" ? stdout : stderr;
      const room = maxBytes - current.length;
      if (room <= 0) {
        truncated = true;
        return;
      }
      const text = chunk.toString("utf8");
      const slice = text.length > room ? text.slice(0, room) : text;
      if (slice.length < text.length) truncated = true;
      if (target === "out") stdout += slice;
      else stderr += slice;
    };

    child.stdout?.on("data", (chunk: Buffer) => append("out", chunk));
    child.stderr?.on("data", (chunk: Buffer) => append("err", chunk));

    const timer =
      opts.timeoutMs && opts.timeoutMs > 0
        ? setTimeout(() => {
            timedOut = true;
            killTree(child.pid, "SIGTERM");
            setTimeout(() => killTree(child.pid, "SIGKILL"), 2_000).unref?.();
          }, opts.timeoutMs)
        : null;
    if (timer?.unref) timer.unref();

    const onAbort = () => {
      killed = true;
      killTree(child.pid, "SIGKILL");
    };
    if (opts.signal) {
      if (opts.signal.aborted) onAbort();
      else opts.signal.addEventListener("abort", onAbort, { once: true });
    }

    const finish = (code: number | null, signal: NodeJS.Signals | null) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
      resolve({
        exitCode: code,
        stdout,
        stderr,
        timedOut,
        killed,
        truncated,
        durationMs: Date.now() - started,
        signal,
      });
    };

    child.on("error", (err) => {
      stderr += `\n[spawn error] ${err.message}\n`;
      finish(null, null);
    });
    child.on("close", (code, signal) => finish(code, signal));

    child.unref?.();
  });
}

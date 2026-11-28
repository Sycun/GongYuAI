import { spawn } from "node:child_process";
import { totalmem } from "node:os";

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

/**
 * Non-interactive defaults so unattended subprocesses never hang waiting on
 * apt/dpkg prompts, git credential dialogs, pip prompts, or sudo password TTYs.
 */
export function buildNonInteractiveEnv(baseEnv?: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const src = baseEnv ?? process.env;
  return {
    DEBIAN_FRONTEND: "noninteractive",
    NEEDRESTART_MODE: "a",
    GIT_TERMINAL_PROMPT: "0",
    PIP_NO_INPUT: "1",
    SUDO_ASKPASS: "/bin/false",
    SSH_ASKPASS: "/bin/false",
    GCM_INTERACTIVE: "never",
    ...src,
  };
}

/**
 * Compute per-subprocess virtual memory ceiling (in KiB) on Linux so a single
 * runaway solver/unpacker script fails locally with MemoryError instead of
 * exhausting host RAM+swap and triggering a cgroup-wide systemd OOM kill.
 * Keeps ≥ 5 GiB headroom so V8 pointer cages, QEMU user-mode, r2, and JVMs run cleanly.
 * Set `GY_SUBPROCESS_MAX_VMEM_KB=0` to disable.
 */
export function resolveLinuxSubprocessMaxVmemKb(
  env?: NodeJS.ProcessEnv,
  hostTotalMemBytes = totalmem(),
): number {
  const raw = env?.GY_SUBPROCESS_MAX_VMEM_KB ?? process.env.GY_SUBPROCESS_MAX_VMEM_KB;
  if (raw !== undefined && raw.trim() !== "") {
    const parsed = Number(raw);
    if (Number.isFinite(parsed) && parsed >= 0) return Math.floor(parsed);
  }
  const hostKb = Math.floor(hostTotalMemBytes / 1024);
  return Math.max(5_242_880, Math.min(8_388_608, Math.floor(hostKb * 0.72)));
}

/**
 * On Linux, raise the child shell's OOM score (`oom_score_adj=500`) and apply
 * `ulimit -v` before running the user command so neither the control plane nor
 * sibling worker processes share the blast radius of a memory spike.
 */
export function wrapSubprocessCommand(
  command: string,
  env?: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
): string {
  if (platform !== "linux") return command;
  const maxVmemKb = resolveLinuxSubprocessMaxVmemKb(env);
  const ulimitClause = maxVmemKb > 0 ? `ulimit -v ${maxVmemKb} 2>/dev/null || true; ` : "";
  return `{ printf '500' > /proc/self/oom_score_adj; } 2>/dev/null || true; ${ulimitClause}${command}`;
}

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
  const effectiveEnv = buildNonInteractiveEnv(opts.env);
  const wrappedCommand = wrapSubprocessCommand(opts.command, effectiveEnv);
  return new Promise((resolve) => {
    const child = spawn(opts.shellPath ?? "/bin/bash", ["-lc", wrappedCommand], {
      cwd: opts.cwd,
      env: effectiveEnv,
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

import { JobStore } from "./jobs.js";
import { runCommand, type RunOptions, type RunResult } from "./proc.js";
import { ShellSessionManager } from "./sessions.js";
import { C2Manager } from "./c2.js";
import { authorizeCommand, type AuthSnapshot, type CommandVerdict } from "./scope.js";

export * from "./scope.js";
export * from "./repeat.js";
export * from "./proc.js";
export * from "./jobs.js";
export * from "./sessions.js";
export * from "./c2.js";

/**
 * 一次任务内的执行面：shell（前台/后台/PTY）+ C2，共用一个授权快照。
 * worker 与控制面都从这里拿执行能力，避免两套闸。
 */
export type ExecRuntimeOptions = {
  baseDir: string;
  auth: AuthSnapshot;
  onC2Event?: ConstructorParameters<typeof C2Manager>[0]["onEvent"];
};

export type ExecRunResult = RunResult & { verdict: CommandVerdict };

export class ExecRuntime {
  readonly jobs: JobStore;
  readonly sessions: ShellSessionManager;
  readonly c2: C2Manager;

  constructor(private readonly options: ExecRuntimeOptions) {
    this.jobs = new JobStore(options.baseDir);
    this.sessions = new ShellSessionManager(options.baseDir);
    this.c2 = new C2Manager({
      baseDir: options.baseDir,
      auth: options.auth,
      // P14-B0: optional shared token for raw listeners (set by deployment).
      ...(process.env.GY_C2_TOKEN ? { token: process.env.GY_C2_TOKEN } : {}),
      ...(options.onC2Event ? { onEvent: options.onC2Event } : {}),
    });
  }

  get auth(): AuthSnapshot {
    return this.options.auth;
  }

  /** 授权快照可随操作员更新而刷新；执行面不缓存旧范围。 */
  updateAuth(auth: AuthSnapshot): void {
    this.options.auth = auth;
    (this.c2 as unknown as { opts: { auth: AuthSnapshot } }).opts.auth = auth;
  }

  authorize(command: string): CommandVerdict {
    return authorizeCommand(this.options.auth, command);
  }

  async run(command: string, opts: Partial<Omit<RunOptions, "command" | "cwd">> & { cwd?: string } = {}): Promise<ExecRunResult> {
    const verdict = this.authorize(command);
    if (!verdict.allowed) {
      return {
        exitCode: null, stdout: "", stderr: verdict.reason, timedOut: false, killed: false,
        truncated: false, durationMs: 0, signal: null, verdict,
      };
    }
    const result = await runCommand({
      command,
      cwd: opts.cwd ?? this.options.baseDir,
      ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
      ...(opts.maxBytes !== undefined ? { maxBytes: opts.maxBytes } : {}),
      ...(opts.env !== undefined ? { env: opts.env } : {}),
      ...(opts.shellPath !== undefined ? { shellPath: opts.shellPath } : {}),
      ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
    });
    return { ...result, verdict };
  }

  /**
   * P14-B4 — sessions are detached footholds: they survive worker restarts by
   * default. `keepSessions:false` is only for explicit cleanup paths.
   */
  close(opts: { keepSessions?: boolean } = {}): void {
    if (opts.keepSessions !== true) this.sessions.closeAll();
    this.c2.close();
  }
}

export * from "./http.js";
export * from "./http-sessions.js";
export * from "./traffic/index.js";
export * from "./oast.js";
export * from "./oast-dns.js";
export * from "./tunnels.js";
export * from "./cleanup.js";

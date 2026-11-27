import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  ExecRuntime,
  JobStore,
  ShellSessionManager,
  TunnelManager,
} from "@gongyuai/exec";
import type { WorkerManifest } from "@gongyuai/contracts";

export type LiveExecResourceEntry = {
  /** Snapshot key suffix, e.g. `tunnel:tun-123` or `session:sess-abc`. */
  key: string;
  /** Concise single-line human + LLM readable summary with exact reuse handle. */
  line: string;
};

/**
 * Inspect `<dataDir>/exec` on disk (read-only when absent) and return all live
 * detached tunnels, PTY foothold sessions, background jobs, and C2 callbacks.
 * Survives Follower per-Intent transcript resets (`root.reset()`) and works across
 * sibling Worker processes sharing `manifest.dataDir`.
 */
export function listLiveExecResources(manifest?: Partial<WorkerManifest> | null): LiveExecResourceEntry[] {
  const dataDir = manifest?.dataDir;
  if (!dataDir) return [];
  const execDir = join(dataDir, "exec");
  if (!existsSync(execDir)) return [];

  const entries: LiveExecResourceEntry[] = [];

  try {
    if (existsSync(join(execDir, "tunnels"))) {
      const tm = new TunnelManager({ baseDir: execDir, authorizeHost: () => true });
      for (const t of tm.list()) {
        if (t.status !== "running") continue;
        const hop =
          t.kind === "ssh-socks" || t.kind === "chisel-socks"
            ? `SOCKS5 代理 127.0.0.1:${t.localPort} (via ${t.via ?? t.targetHost}) — 可直接 curl --socks5-hostname 127.0.0.1:${t.localPort} 或 proxychains 复用`
            : `端口转发 127.0.0.1:${t.localPort} -> ${t.targetHost}:${t.targetPort ?? "?"}${t.via ? ` (via ${t.via})` : ""}`;
        entries.push({
          key: `tunnel:${t.id}`,
          line: `[tunnel:${t.id}] (${t.kind}, pid=${t.pid}) ${hop}`,
        });
      }
    }
  } catch {
    /* best-effort projection */
  }

  try {
    if (existsSync(join(execDir, "sessions"))) {
      const sm = new ShellSessionManager(execDir);
      for (const s of sm.list()) {
        if (s.status !== "open") continue;
        entries.push({
          key: `session:${s.id}`,
          line: `[session:${s.id}] (PTY ${s.shell}, pid=${s.pid}, cwd=${s.cwd}) — 可跨 Intent 调用 shell_session(action="read"|"write", sessionId="${s.id}") 复用立足点`,
        });
      }
    }
  } catch {
    /* best-effort projection */
  }

  try {
    if (existsSync(join(execDir, "jobs"))) {
      const js = new JobStore(execDir);
      for (const j of js.list()) {
        if (j.status !== "running") continue;
        const label = j.label ? ` "${j.label}"` : "";
        const cmdSnippet = j.command.replace(/\s+/g, " ").slice(0, 90);
        entries.push({
          key: `job:${j.id}`,
          line: `[job:${j.id}]${label} (pid=${j.pid}) cmd=\`${cmdSnippet}\` — 可用 shell_job(action="poll", jobId="${j.id}") 读取回显`,
        });
      }
    }
  } catch {
    /* best-effort projection */
  }

  try {
    entries.push(...readLiveC2Sessions(execDir));
  } catch {
    /* best-effort projection */
  }

  return entries;
}

function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Read `c2/state.json` without constructing `C2Manager` (that marks every
 * on-disk session closed and starts a sweep timer). Show a session only when
 * its listener is still running inside a live slot process.
 */
function readLiveC2Sessions(execDir: string): LiveExecResourceEntry[] {
  const statePath = join(execDir, "c2", "state.json");
  if (!existsSync(statePath)) return [];
  const raw = JSON.parse(readFileSync(statePath, "utf8")) as {
    listeners?: Array<{ id?: string; status?: string; ownerPid?: number; pid?: number }>;
    sessions?: Array<{
      id?: string;
      kind?: string;
      status?: string;
      allowed?: boolean;
      user?: string;
      host?: string;
      peer?: string;
      listenerId?: string;
    }>;
  };
  const liveListeners = new Set<string>();
  for (const listener of raw.listeners ?? []) {
    if (!listener?.id || listener.status !== "running") continue;
    const pid = typeof listener.ownerPid === "number" ? listener.ownerPid : listener.pid;
    if (typeof pid === "number" && pidAlive(pid)) liveListeners.add(listener.id);
  }
  if (liveListeners.size === 0) return [];
  const entries: LiveExecResourceEntry[] = [];
  for (const session of raw.sessions ?? []) {
    if (!session?.id || !session.listenerId || !liveListeners.has(session.listenerId)) continue;
    if (session.status !== "active" && session.status !== "idle") continue;
    if (session.allowed === false) continue;
    const who = `${session.user ? `${session.user}@` : ""}${session.host || session.peer || ""}`;
    entries.push({
      key: `c2:${session.id}`,
      line: `[c2:${session.id}] (${session.kind ?? "raw"}) ${who} — 可用 c2(action="read"|"task", sessionId="${session.id}") 交互（C2 TCP 会话绑定在开启监听的槽位进程内）`,
    });
  }
  return entries;
}

export function formatLiveExecResourcesBlock(manifest?: Partial<WorkerManifest> | null): string {
  const entries = listLiveExecResources(manifest);
  if (entries.length === 0) return "";
  return [
    "## 存活持久连接与后台设施（跨 Intent / 跨槽位可直接复用，无需重复打穿边界）",
    ...entries.map((e) => `- ${e.line}`),
  ].join("\n");
}

/**
 * 一次运行内复用的执行面（shell / job / PTY / C2 共用）。
 * 按 dataDir + taskId 缓存；授权范围更新时刷新，不缓存旧范围。
 */
let cached: { key: string; runtime: ExecRuntime } | null = null;

export function execRuntimeFor(manifest: WorkerManifest): ExecRuntime {
  const key = `${manifest.dataDir}::${manifest.taskId}`;
  if (cached && cached.key === key) {
    cached.runtime.updateAuth(manifest.auth);
    return cached.runtime;
  }
  cached?.runtime.close();
  const runtime = new ExecRuntime({
    baseDir: join(manifest.dataDir, "exec"),
    auth: manifest.auth,
  });
  cached = { key, runtime };
  return runtime;
}

/**
 * 进程退出前收掉监听器；**会话按 P14-B4 默认保留**（detached，跨 worker
 * 重启可 list/read/write）。只有显式清理路径才传 keepSessions=false。
 */
export function closeExecRuntime(opts: { keepSessions?: boolean } = { keepSessions: true }): void {
  cached?.runtime.close(opts);
  cached = null;
}

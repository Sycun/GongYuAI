import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  C2Manager,
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
    if (existsSync(join(execDir, "c2")) && manifest?.auth) {
      const c2 = new C2Manager({ baseDir: execDir, auth: manifest.auth });
      try {
        for (const c of c2.sessionList()) {
          if ((c.status !== "active" && c.status !== "idle") || !c.allowed) continue;
          const who = `${c.user ? `${c.user}@` : ""}${c.host || c.peer}`;
          entries.push({
            key: `c2:${c.id}`,
            line: `[c2:${c.id}] (${c.kind}) ${who} — 可用 c2(action="read"|"exec", sessionId="${c.id}") 交互`,
          });
        }
      } finally {
        c2.close();
      }
    }
  } catch {
    /* best-effort projection */
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

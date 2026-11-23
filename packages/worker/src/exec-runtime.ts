import { join } from "node:path";
import { ExecRuntime } from "@gongyuai/exec";
import type { WorkerManifest } from "@gongyuai/contracts";

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

import { existsSync } from "node:fs";
import { JobStore } from "./jobs.js";
import { ShellSessionManager } from "./sessions.js";
import { TunnelManager } from "./tunnels.js";

/**
 * Reap detached exec children under `<dataDir>/exec`.
 * Safe to call from another process: sessions, tunnels, and jobs are read from disk.
 * Missing directory is a no-op.
 */
export async function cleanupExecDir(execDir: string): Promise<void> {
  if (!execDir.trim() || !existsSync(execDir)) return;
  try {
    new ShellSessionManager(execDir).closeAll();
  } catch {
    /* idempotent */
  }
  try {
    new JobStore(execDir).killAll();
  } catch {
    /* idempotent */
  }
  try {
    const tunnels = new TunnelManager({ baseDir: execDir, authorizeHost: () => true });
    await tunnels.closeAll();
  } catch {
    /* idempotent */
  }
}

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { cleanupExecDir } from "./cleanup.js";
import { JobStore } from "./jobs.js";
import { ShellSessionManager } from "./sessions.js";
import { TunnelManager } from "./tunnels.js";

function sleepDetached(): number {
  const child = spawn("sleep", ["60"], { detached: true, stdio: "ignore" });
  child.unref();
  if (!child.pid) throw new Error("sleep did not start");
  return child.pid;
}

async function waitDead(pid: number): Promise<void> {
  const deadline = Date.now() + 4_000;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  assert.fail(`pid ${pid} still alive`);
}

test("cleanupExecDir reaps PTY, tunnel, and job processes it did not spawn", async () => {
  const execDir = mkdtempSync(join(tmpdir(), "gy-exec-cleanup-"));
  const sessions = new ShellSessionManager(execDir);
  const jobs = new JobStore(execDir);
  let sessionPid = 0;
  let jobPid = 0;
  let tunnelPid = 0;
  try {
    const session = sessions.open({ cwd: execDir });
    sessionPid = session.pid ?? 0;
    assert.ok(sessionPid > 0);
    const job = jobs.start({ command: "sleep 60", cwd: execDir, label: "orphan-job" });
    jobPid = job.pid ?? 0;
    assert.ok(jobPid > 0);
    tunnelPid = sleepDetached();
    const tunnelId = "tun-orphan";
    const tunnelDir = join(execDir, "tunnels", tunnelId);
    mkdirSync(tunnelDir, { recursive: true });
    writeFileSync(join(tunnelDir, "meta.json"), JSON.stringify({
      id: tunnelId,
      kind: "socat",
      targetHost: "127.0.0.1",
      targetPort: 9,
      localPort: 39001,
      pid: tunnelPid,
      status: "running",
      command: "sleep 60",
      logPath: join(tunnelDir, "socat.log"),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }));

    await cleanupExecDir(execDir);
    await waitDead(sessionPid);
    await waitDead(jobPid);
    await waitDead(tunnelPid);
    assert.equal(new ShellSessionManager(execDir).get(session.id)?.status, "closed");
    assert.equal(new JobStore(execDir).get(job.id)?.status, "killed");
    assert.equal(
      new TunnelManager({ baseDir: execDir, authorizeHost: () => true }).list().some((meta) => meta.status === "running"),
      false,
    );
  } finally {
    for (const pid of [sessionPid, jobPid, tunnelPid]) {
      if (!pid) continue;
      try { process.kill(-pid, "SIGKILL"); } catch { /* already gone */ }
    }
    rmSync(execDir, { recursive: true, force: true });
  }
});

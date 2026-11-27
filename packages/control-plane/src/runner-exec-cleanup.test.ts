import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { CreateTaskRequestSchema } from "@gongyuai/contracts";
import { JobStore, ShellSessionManager } from "@gongyuai/exec";
import { WorkerRunner } from "./runner.js";
import { SettingsStore } from "./settings.js";
import { ControlStore } from "./store.js";

async function pidAlive(pid: number): Promise<boolean> {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitDead(pid: number): Promise<void> {
  const deadline = Date.now() + 4_000;
  while (Date.now() < deadline) {
    if (!(await pidAlive(pid))) return;
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  assert.fail(`pid ${pid} still alive`);
}

test("pause keeps detached exec sessions; finishWorkerRun reaps them", async () => {
  const root = mkdtempSync(join(tmpdir(), "gy-runner-exec-"));
  const store = new ControlStore(root);
  const settings = new SettingsStore(root, root);
  const runner = new WorkerRunner(store, {
    ownerId: "exec-cleanup",
    leaseMs: 10_000,
    mode: "local",
    workerImage: "",
  }, settings);
  const task = store.createTask(CreateTaskRequestSchema.parse({
    name: "exec cleanup",
    mock: true,
    auth: { authorizationNote: "local fixture", targets: ["example.invalid"] },
    goals: [{ id: "g", title: "t", description: "d", evidencePatterns: ["x.txt"] }],
  }));
  const execDir = join(task.dataDir, "exec");
  const sessions = new ShellSessionManager(execDir);
  const jobs = new JobStore(execDir);
  let sessionPid = 0;
  let jobPid = 0;
  try {
    task.status = "running";
    store.save(task);
    const session = sessions.open({ cwd: execDir });
    sessionPid = session.pid ?? 0;
    const job = jobs.start({ command: "sleep 60", cwd: execDir, label: "keep-on-pause" });
    jobPid = job.pid ?? 0;
    assert.ok(sessionPid > 0 && jobPid > 0);

    const paused = await runner.pause(task.id);
    assert.equal(paused?.status, "paused");
    assert.equal(await pidAlive(sessionPid), true);
    assert.equal(await pidAlive(jobPid), true);
    assert.equal(new ShellSessionManager(execDir).get(session.id)?.status, "open");

    const latest = store.get(task.id)!;
    runner.finishWorkerRun(latest, "stopped", null);
    await waitDead(sessionPid);
    await waitDead(jobPid);
    assert.equal(new ShellSessionManager(execDir).get(session.id)?.status, "closed");
    assert.equal(new JobStore(execDir).get(job.id)?.status, "killed");
  } finally {
    for (const pid of [sessionPid, jobPid]) {
      if (!pid) continue;
      try { process.kill(-pid, "SIGKILL"); } catch { /* already gone */ }
    }
    runner.dispose();
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

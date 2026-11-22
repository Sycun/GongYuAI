import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { CreateTaskRequestSchema } from "@gongyuai/contracts";
import { WorkerRunner } from "./runner.js";
import { SettingsStore } from "./settings.js";
import { ControlStore } from "./store.js";
import { Watchdog } from "./watchdog.js";

test("leader terminal status stops a remaining worker before clearing its runtime handles", { timeout: 5000 }, async (t) => {
  const root = mkdtempSync(join(tmpdir(), "gy-terminal-pool-"));
  const store = new ControlStore(root);
  const settings = new SettingsStore(root, root);
  const ownerId = "terminal-test";
  const runner = new WorkerRunner(store, {
    ownerId,
    leaseMs: 10_000,
    mode: "local",
    workerImage: "",
  }, settings);
  const watchdog = new Watchdog(store, runner, { ownerId, intervalMs: 100, leaseMs: 10_000 });
  const follower = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  const exited = once(follower, "exit");
  t.after(async () => {
    follower.kill();
    await exited;
    await watchdog.stop();
    store.close();
    rmSync(root, { recursive: true, force: true });
  });

  const task = store.createTask(CreateTaskRequestSchema.parse({
    name: "local terminal test",
    mock: true,
    auth: { authorizationNote: "Local process fixture only", targets: ["example.invalid"] },
    goals: [{ id: "test", title: "Synthetic", description: "Local fixture", evidencePatterns: ["proof.txt"] }],
  }));
  assert.ok(follower.pid);
  task.status = "running";
  task.workerPids = [follower.pid];
  store.save(task);
  writeFileSync(join(task.dataDir, "worker-status.json"), JSON.stringify({ status: "incomplete" }));

  await watchdog.tick();
  const [code, signal] = await exited;
  assert.equal(code, null);
  assert.equal(signal, "SIGTERM");
  const finished = store.get(task.id);
  assert.equal(finished?.status, "incomplete");
  assert.ok(finished?.finishedAt);
  assert.deepEqual(finished?.workerPids, []);
  assert.ok(store.setArchived(task.id, true)?.archivedAt);
});

import assert from "node:assert/strict";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { CreateTaskRequestSchema } from "@gongyuai/contracts";
import { CommandLedger } from "@gongyuai/history";
import { bootControlPlane } from "./index.js";

test("independent worker dispatch is held before spawn and the supervisor drains the task", { timeout: 15000 }, async t => {
  const root = mkdtempSync(join(tmpdir(), "gy-command-hold-"));
  const plane = await bootControlPlane({ dataRoot: root, host: "127.0.0.1", port: 0, isolated: true });
  t.after(async () => { await plane.close(); rmSync(root, { recursive: true, force: true }); });
  const calls: string[] = [];
  const fixture = createServer(async (req, res) => {
    const chunks = [];
    for await (const part of req) chunks.push(part);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    const action = JSON.parse(body.messages.at(-1).content);
    calls.push(action.command);
    // Even a false positive must not release an unbounded command.
    const decision = { risk: "low", activity: "read_only", reason: "本地诊断" };
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(decision) } }] }));
  });
  await new Promise<void>(r => fixture.listen(0, "127.0.0.1", r));
  t.after(() => new Promise<void>(r => fixture.close(() => r())));
  const addr = fixture.address();
  assert.ok(addr && typeof addr === "object");
  plane.settings.saveChatProfile({ id: "fixture", name: "fixture", modelId: "judge", baseUrl: "http://127.0.0.1:" + addr.port,
    protocol: "openai", apiKey: "", models: [] }, true);
  const original = plane.store.createTask(CreateTaskRequestSchema.parse({ name: "local diagnostic", mock: true,
    auth: { authorizationNote: "local isolated fixture", targets: ["example.invalid"], capability: "scan" },
    goals: [{ id: "g", title: "local", description: "local", evidencePatterns: ["test.txt"] }] }));
  const lease = plane.store.acquireLease(original.id, "cp-" + hostname() + "-" + process.pid, 60_000);
  assert.ok(lease.ok);
  const task = lease.task;
  const ledger = new CommandLedger(task.dataDir);
  ledger.activate(task.id, task.fence); ledger.close();
  const workerTools = new URL("../../worker/src/tools.ts", import.meta.url).href;
  const script = `
    import {runShell} from ${JSON.stringify(workerTools)};
    import {writeFileSync} from "node:fs";
    const m=JSON.parse(process.argv[1]);
    const ctx={manifest:m,history:{recordToolGate(){}},usage:{toolCalls:0,installs:0}};
    const probe=await runShell(ctx,"uname -m");
    writeFileSync(m.dataDir+"/allowed.txt",probe.stdout);
    try {await runShell(ctx,"touch "+m.dataDir+"/should-not-exist");} catch {}
    setInterval(()=>{},1000);
  `;
  const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script,
    JSON.stringify({ taskId: task.id, dataDir: task.dataDir, workspaceDir: task.dataDir, commandFence: task.fence, auth: task.auth, budget: task.budget })],
    { stdio: "ignore" });
  const ended = once(child, "exit");
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill(); });
  task.workerPid = child.pid!; task.workerPids = [child.pid!]; task.status = "running"; plane.store.save(task);
  for (let i = 0; i < 150 && plane.store.get(task.id)?.status !== "paused"; i++) {
    await plane.watchdog.tick(); await delay(40);
  }
  const paused = plane.store.get(task.id)!;
  assert.equal(paused.status, "paused");
  assert.equal(paused.commandReview?.decision, "block");
  assert.match(paused.error!, /超出任务授权范围或执行器支持范围/);
  // 范围外的 touch 不再送审：只有白名单探针会调用审批模型。
  assert.deepEqual(calls, ["uname -m"]);
  assert.ok(readFileSync(join(task.dataDir, "allowed.txt"), "utf8").trim());
  assert.ok(!existsSync(join(task.dataDir, "should-not-exist")));
  assert.equal((await ended)[1], "SIGTERM");
  await plane.watchdog.tick();
  assert.equal(plane.store.get(task.id)?.status, "paused");
});

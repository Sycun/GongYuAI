import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import type { TaskRecord } from "@gongyuai/contracts";
import { CreateTaskRequestSchema } from "@gongyuai/contracts";
import { ControlStore } from "./store.js";
import { SettingsStore } from "./settings.js";
import { AssignmentService } from "./assignments.js";

async function waitFor<T>(probe: () => T | null, timeoutMs = 8000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = probe();
    if (value) return value;
    await delay(10);
  }
  throw new Error("等待条件超时");
}

function reply(content: string): string {
  return JSON.stringify({ choices: [{ message: { content } }] });
}

test("续接意图绑定同线程既有任务；未命中意图才新建", async t => {
  const root = mkdtempSync(join(tmpdir(), "gy-resume-bind-"));
  const store = new ControlStore(root);
  const settings = new SettingsStore(root);
  const service = new AssignmentService(store, settings);
  const requests: string[] = [];
  const provider = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    requests.push(Buffer.concat(chunks).toString("utf8"));
    res.setHeader("content-type", "application/json");
    res.end(reply(JSON.stringify({ kind: "result", text: "已继续" })));
  });
  await new Promise<void>(resolve => provider.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    service.close();
    await new Promise<void>(resolve => provider.close(() => resolve()));
    store.close();
    rmSync(root, { recursive: true, force: true });
  });
  const address = provider.address();
  assert.ok(address && typeof address === "object");
  settings.saveChatProfile({
    id: "fixture", name: "夹具", modelId: "m", protocol: "openai",
    baseUrl: `http://127.0.0.1:${address.port}`, apiKey: "", models: [],
  }, true);
  const selection = { profileId: "fixture", modelId: "m" };

  // 一个已暂停的 assignment 任务：材料文件里保留原消息与附件。
  const requestId = "a".repeat(32);
  const task = store.createTask(CreateTaskRequestSchema.parse({
    name: "第一轮任务",
    auth: { capability: "observe", authorizationNote: "工作区任务，限提交的材料和本地只读检查", targets: ["local:submitted-materials"] },
    goals: [{ id: "deliver", title: "提交任务结果", description: "第一轮任务", evidencePatterns: ["task-result.md"] }],
  }), { requestId, inputHash: "0".repeat(64), model: "m" });
  task.threadId = "default";
  task.status = "paused";
  task.error = "需要授权后才能继续。";
  store.save(task);
  const originalMessages = [
    { role: "user" as const, content: "先看看这份材料", attachments: [{ name: "a.txt", mediaType: "text/plain" as const, data: "材料内容" }] },
    { role: "assistant" as const, content: "已阅读材料，需要授权后才能动目标。" },
  ];
  writeFileSync(join(task.dataDir, "assignment-input.json"),
    JSON.stringify({ requestId, messages: originalMessages, selection }), { mode: 0o600 });

  const resumeRequestId = "b".repeat(32);
  const resumeMessage = { role: "user" as const, content: "已授权 127.0.0.1，继续" };
  const view = await service.accept({
    requestId: resumeRequestId, threadId: "default",
    messages: [...originalMessages, resumeMessage], selection,
  });

  // 返回同一任务、消息追加、状态=running、授权已登记。
  assert.equal(view.taskId, task.id, "续接不能新建任务");
  assert.equal(view.status, "running");
  const stored = JSON.parse(readFileSync(join(task.dataDir, "assignment-input.json"), "utf8")) as {
    messages: Array<{ role: string; content: string }>;
  };
  assert.equal(stored.messages.length, 3);
  assert.deepEqual(stored.messages[0], originalMessages[0]);
  assert.deepEqual(stored.messages[1], originalMessages[1]);
  assert.equal(stored.messages.at(-1)!.content, "已授权 127.0.0.1，继续");
  const bound = store.get(task.id)!;
  assert.deepEqual(bound.auth.targets, ["127.0.0.1"]);
  assert.equal(bound.auth.capability, "active-lab");
  assert.equal(bound.authorization?.version, 1);
  assert.equal(bound.threadId, "default");
  assert.equal(bound.parentTaskId, null);

  const finished = await waitFor(() => {
    const current = store.get(task.id)!;
    return ["completed", "failed", "paused"].includes(current.status) ? current : null;
  });
  assert.equal(finished.status, "completed", finished.error ?? "");
  assert.equal(readFileSync(join(task.dataDir, "evidence", "task-result.md"), "utf8"), "已继续");

  // 同一续接提交重放：返回同一任务，不重复追加、不重跑模型。
  const replay = await service.accept({
    requestId: resumeRequestId, threadId: "default",
    messages: [...originalMessages, resumeMessage], selection,
  });
  assert.equal(replay.taskId, task.id);
  const afterReplay = JSON.parse(readFileSync(join(task.dataDir, "assignment-input.json"), "utf8")) as {
    messages: Array<{ content: string }>;
  };
  assert.equal(afterReplay.messages.length, 3);
  assert.equal(requests.length, 1);

  // 不命中续接意图：按原逻辑新建任务，旧任务材料不动。
  const before = store.list().length;
  const fresh = await service.accept({
    requestId: "c".repeat(32), threadId: "default",
    messages: [{ role: "user", content: "再看看这份材料" }], selection,
  });
  assert.notEqual(fresh.taskId, task.id);
  assert.equal(store.list().length, before + 1);
  const created = store.get(fresh.taskId)! as TaskRecord;
  assert.equal(created.threadId, "default");
  assert.equal(created.auth.capability, "active-lab");
  const untouched = JSON.parse(readFileSync(join(task.dataDir, "assignment-input.json"), "utf8")) as {
    messages: Array<{ content: string }>;
  };
  assert.equal(untouched.messages.length, 3);
  await waitFor(() => {
    const current = store.get(fresh.taskId)!;
    return ["completed", "failed", "paused"].includes(current.status) ? current : null;
  });
});

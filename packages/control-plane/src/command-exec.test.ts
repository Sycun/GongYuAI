import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import type { AssignmentView } from "@gongyuai/contracts";
import { bootControlPlane } from "./index.js";

const lowRisk = JSON.stringify({ risk: "low", activity: "read_only", reason: "本地回显，只读副作用" });

function providerBody(text: string): string {
  return JSON.stringify({ choices: [{ message: { content: text } }] });
}

async function submit(url: string, messages: Array<Record<string, unknown>>, selection: Record<string, unknown>) {
  return fetch(url + "/tasks/submit", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ requestId: randomUUID().replaceAll("-", ""), messages, selection }),
  });
}

async function settled(url: string, res: Response): Promise<AssignmentView> {
  assert.equal(res.status, 202, await res.clone().text());
  let view = await res.json() as AssignmentView;
  for (let i = 0; ["running", "queued"].includes(view.status) && i < 200; i++) {
    await delay(10);
    view = await (await fetch(url + "/tasks/" + view.taskId + "/assignment")).json() as AssignmentView;
  }
  return view;
}

async function waitForStatus(url: string, taskId: string, wanted: string[]): Promise<AssignmentView> {
  for (let i = 0; i < 400; i++) {
    const view = await (await fetch(url + "/tasks/" + taskId + "/assignment")).json() as AssignmentView;
    if (wanted.includes(view.status)) return view;
    await delay(10);
  }
  throw new Error(`任务 ${taskId} 未进入 ${wanted.join("/")}`);
}

test("授权登记后真实命令执行并留证；越界命令转 needs_authorization 且不执行", { timeout: 30000 }, async t => {
  const root = mkdtempSync(join(tmpdir(), "gy-command-exec-"));
  const plane = await bootControlPlane({ dataRoot: root, host: "127.0.0.1", port: 0, isolated: true });
  t.after(async () => { await plane.close(); rmSync(root, { recursive: true, force: true }); });

  const state = {
    reply: JSON.stringify({ kind: "needs_authorization", targets: ["127.0.0.1"], actions: ["echo"], window: "", reason: "尚未登记授权" }),
  };
  const taskPrompts: string[] = [];
  let reviewCalls = 0;
  const fixture = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { messages?: Array<{ role: string; content: unknown }> };
    res.setHeader("content-type", "application/json");
    const system = body.messages?.[0]?.role === "system" ? String(body.messages[0]!.content) : "";
    if (system.includes("审查即将发生的工具调用")) {
      reviewCalls += 1;
      res.end(providerBody(lowRisk));
      return;
    }
    taskPrompts.push(system);
    res.end(providerBody(state.reply));
  });
  await new Promise<void>(resolve => fixture.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>(resolve => fixture.close(() => resolve())));
  const address = fixture.address();
  assert.ok(address && typeof address === "object");
  plane.settings.saveChatProfile({
    id: "fixture", name: "夹具", modelId: "reply", protocol: "openai",
    baseUrl: `http://127.0.0.1:${address.port}`, apiKey: "", models: ["reply", "judge"],
  }, true);
  const approval = await fetch(plane.url + "/settings/approval", {
    method: "PUT", headers: { "content-type": "application/json" },
    body: JSON.stringify({ scope: "read-only", confirmation: "auto", reviewer: { profileId: "fixture", modelId: "judge" } }),
  });
  assert.equal(approval.status, 200, await approval.clone().text());
  await approval.text();
  const selection = { profileId: "fixture", modelId: "reply" };

  // 1) 没有授权时：结构化请求 + 暂停 + 请求文件（不是“解释为什么不能做”）
  const first = await settled(plane.url, await submit(plane.url, [{ role: "user", content: "检查 127.0.0.1 的本地回显" }], selection));
  assert.equal(first.status, "paused");
  assert.match(first.reason ?? "", /^NEEDS_AUTHORIZATION: /);
  const task1 = plane.store.get(first.taskId)!;
  const request = JSON.parse(readFileSync(join(task1.dataDir, "authorization-request.json"), "utf8")) as {
    kind: string; targets: string[]; current: { version: number };
  };
  assert.equal(request.kind, "needs_authorization");
  assert.deepEqual(request.targets, ["127.0.0.1"]);
  assert.equal(request.current.version, 0);
  assert.equal(readdirSync(join(task1.dataDir, "evidence", "authorization")).filter(name => name.startsWith("request-")).length, 1);

  // 2) 登记授权：台账 v1、能力级 active-lab、原件封存
  const authorized = await fetch(plane.url + "/tasks/" + first.taskId + "/authorization", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ text: "已授权 127.0.0.1，可做 active-lab" }),
  });
  assert.equal(authorized.status, 200, await authorized.clone().text());
  const stored = await authorized.json() as {
    task: { auth: { capability: string; targets: string[] }; scopeVersion: number };
    authorization: { version: number; capability: string; targets: string[]; evidence: { sha256: string; path: string } | null };
  };
  assert.equal(stored.authorization.version, 1);
  assert.equal(stored.authorization.capability, "active-lab");
  assert.deepEqual(stored.authorization.targets, ["127.0.0.1"]);
  assert.ok(stored.authorization.evidence, "文本授权必须封存原件");
  assert.equal(stored.authorization.evidence!.path, "authorization/v1-source.md");
  assert.equal(stored.task.auth.capability, "active-lab");
  assert.equal(stored.task.scopeVersion, 2);
  const digest = await (await fetch(plane.url + "/tasks/" + first.taskId + "/authorization")).json() as {
    taskId: string; digest: string; authorization: { version: number };
  };
  assert.equal(digest.taskId, first.taskId);
  assert.equal(digest.authorization.version, 1);
  assert.match(digest.digest, /^v1\/.*\/127\.0\.0\.1\/active-lab\/生效中$/);
  // 缺目标：400 且明确缺项，不写台账。
  const missing = await fetch(plane.url + "/tasks/" + first.taskId + "/authorization", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "授权人: 张三" }),
  });
  assert.equal(missing.status, 400);
  const missingBody = await missing.json() as { error: string; missing: string[] };
  assert.deepEqual(missingBody.missing, ["targets"]);
  assert.match(missingBody.error, /授权目标为空/);

  // 3) 授权覆盖后：模型给 command，系统执行并落证据
  state.reply = JSON.stringify({ kind: "command", command: "echo gy-ok", purpose: "验证执行链路" });
  const resumed = await fetch(plane.url + "/tasks/" + first.taskId + "/resume", { method: "POST" });
  assert.equal(resumed.status, 200, await resumed.clone().text());
  await resumed.text();
  const done = await waitForStatus(plane.url, first.taskId, ["completed", "failed", "paused"]);
  assert.equal(done.status, "completed", done.reason ?? "");
  assert.match(done.result ?? "", /gy-ok/);
  const commandFiles = readdirSync(join(task1.dataDir, "evidence")).filter(name => /^command-.*\.md$/.test(name));
  assert.equal(commandFiles.length, 1);
  const evidence = readFileSync(join(task1.dataDir, "evidence", commandFiles[0]!), "utf8");
  assert.match(evidence, /echo gy-ok/);
  assert.match(evidence, /gy-ok/);
  assert.match(evidence, /exitCode：0/);
  assert.match(evidence, /本地动作/);
  assert.ok(readFileSync(join(task1.dataDir, "evidence", "task-result.md"), "utf8").includes("gy-ok"));
  assert.ok(reviewCalls >= 1, "真实命令必须经过审批");
  const prompt = taskPrompts.at(-1) ?? "";
  assert.match(prompt, /授权台账（已登记/);
  assert.match(prompt, /active-lab/);
  assert.match(prompt, /needs_authorization/);

  // 4) 越界命令：不执行、转 needs_authorization、请求文件记录目标
  state.reply = JSON.stringify({ kind: "command", command: "curl http://evil.test/", purpose: "越界测试" });
  const second = await settled(plane.url, await submit(plane.url, [{ role: "user", content: "检查 evil.test 是否可达" }], selection));
  assert.equal(second.status, "paused");
  assert.match(second.reason ?? "", /^NEEDS_AUTHORIZATION: /);
  assert.match(second.reason ?? "", /evil\.test/);
  const task2 = plane.store.get(second.taskId)!;
  assert.equal(readdirSync(join(task2.dataDir, "evidence")).filter(name => /^command-.*\.md$/.test(name)).length, 0);
  assert.equal(existsSync(join(task2.dataDir, "evidence", "task-result.md")), false);
  const denied = JSON.parse(readFileSync(join(task2.dataDir, "authorization-request.json"), "utf8")) as {
    kind: string; targets: string[]; command: string; reason: string;
  };
  assert.equal(denied.kind, "command_denied");
  assert.deepEqual(denied.targets, ["evil.test"]);
  assert.match(denied.command, /evil\.test/);
  assert.match(denied.reason, /越界/);
});

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import type { AssignmentView } from "@gongyuai/contracts";
import { bootControlPlane } from "./index.js";

const lowRisk = JSON.stringify({ risk: "low", activity: "read_only", reason: "本地回显，只读副作用" });
const refusal = JSON.stringify({ kind: "paused", reason: "无法执行：该目标未获授权，我无权进行外部操作" });
const commandReply = (command: string) => JSON.stringify({ kind: "command", command, purpose: "本地验证" });

function providerBody(text: string): string {
  return JSON.stringify({ choices: [{ message: { content: text } }] });
}

async function submit(url: string, content: string, selection: Record<string, unknown>) {
  return fetch(url + "/tasks/submit", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ requestId: randomUUID().replaceAll("-", ""), messages: [{ role: "user", content }], selection }),
  });
}

async function view(url: string, taskId: string): Promise<AssignmentView> {
  return (await fetch(url + "/tasks/" + taskId + "/assignment")).json() as Promise<AssignmentView>;
}

async function waitFor(url: string, taskId: string, wanted: string[], tries = 500): Promise<AssignmentView> {
  let last = await view(url, taskId);
  for (let i = 0; i < tries; i++) {
    if (wanted.includes(last.status)) return last;
    await delay(10);
    last = await view(url, taskId);
  }
  throw new Error(`任务 ${taskId} 未进入 ${wanted.join("/")}，最后状态 ${last.status} / ${last.reason ?? ""}`);
}

test("授权登记后模型层拒绝先纠偏一次，再给 command；手动命令同样走授权与证据", { timeout: 40_000 }, async t => {
  const root = mkdtempSync(join(tmpdir(), "gy-operator-command-"));
  const plane = await bootControlPlane({ dataRoot: root, host: "127.0.0.1", port: 0, isolated: true });
  t.after(async () => { await plane.close(); rmSync(root, { recursive: true, force: true }); });

  const promptLog: string[] = [];
  const fixture = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
      messages?: Array<{ role: string; content: unknown }>;
    };
    res.setHeader("content-type", "application/json");
    const system = body.messages?.[0]?.role === "system" ? String(body.messages[0]!.content) : "";
    if (system.includes("审查即将发生的工具调用")) {
      res.end(providerBody(lowRisk));
      return;
    }
    promptLog.push(system);
    const corrected = (body.messages ?? []).some((m) => String(m.content).includes("系统校验（不是用户请求）"));
    res.end(providerBody(corrected ? commandReply("echo retry-ok") : refusal));
  });
  await new Promise<void>((resolve) => fixture.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve) => fixture.close(() => resolve())));
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

  // 1) 没有授权：模型拒绝原样暂停（不纠偏，因为没有授权事实可引用）
  const submitted = await submit(plane.url, "验证 127.0.0.1 的本地回显", selection);
  assert.equal(submitted.status, 202, await submitted.clone().text());
  const first = await submitted.json() as AssignmentView;
  const paused = await waitFor(plane.url, first.taskId, ["paused"]);
  assert.match(paused.reason ?? "", /无权|未获授权/);
  assert.equal(promptLog.some((p) => p.includes("授权台账（已登记")), false);

  // 2) 登记授权：task.auth 投影为 active-lab + 127.0.0.1
  const registered = await fetch(plane.url + "/tasks/" + first.taskId + "/authorization", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ text: "授权人：张三 / 目标：127.0.0.1 / 能力：active-lab" }),
  });
  assert.equal(registered.status, 200, await registered.clone().text());
  const registeredBody = await registered.json() as { task: { auth: { targets: string[]; capability: string } }; authorization: { version: number } };
  assert.deepEqual(registeredBody.task.auth.targets, ["127.0.0.1"]);
  assert.equal(registeredBody.task.auth.capability, "active-lab");
  assert.equal(registeredBody.authorization.version, 1);

  // 3) 继续：模型第一次仍拒绝 → 系统纠偏一次 → 返回 command → 真执行 + 证据
  const resumed = await fetch(plane.url + "/tasks/" + first.taskId + "/resume", { method: "POST" });
  assert.equal(resumed.status, 200, await resumed.clone().text());
  const done = await waitFor(plane.url, first.taskId, ["completed", "failed", "paused"]);
  assert.equal(done.status, "completed", `${done.status} / ${done.reason ?? ""}`);
  assert.equal(promptLog.some((p) => p.includes("授权台账（已登记")), true, "第二轮的 system 应包含授权台账");
  const task1 = plane.store.get(first.taskId)!;
  const cmdEvidence = readdirSync(join(task1.dataDir, "evidence")).filter((name) => name.startsWith("command-"));
  assert.ok(cmdEvidence.length >= 1, cmdEvidence.join(","));
  const body = readFileSync(join(task1.dataDir, "evidence", cmdEvidence[0]!), "utf8");
  assert.match(body, /retry-ok/);

  // 4) 手动命令：绕过模型，仍走授权 + 审批 + 证据
  const second = await (await submit(plane.url, "再验证一次", selection)).json() as AssignmentView;
  await waitFor(plane.url, second.taskId, ["paused"]);
  const secondAuth = await fetch(plane.url + "/tasks/" + second.taskId + "/authorization", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ text: "授权人：张三 / 目标：127.0.0.1 / 能力：active-lab" }),
  });
  assert.equal(secondAuth.status, 200, await secondAuth.clone().text());
  await secondAuth.text();
  const manual = await fetch(plane.url + "/tasks/" + second.taskId + "/command", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ command: "echo manual-ok", purpose: "操作员手动验证" }),
  });
  assert.equal(manual.status, 200, await manual.clone().text());
  const manualDone = await waitFor(plane.url, second.taskId, ["completed", "failed", "paused"]);
  assert.equal(manualDone.status, "completed", `${manualDone.status} / ${manualDone.reason ?? ""}`);
  const task2 = plane.store.get(second.taskId)!;
  const manualEvidence = readdirSync(join(task2.dataDir, "evidence"))
    .filter((name) => name.startsWith("command-"))
    .map((name) => readFileSync(join(task2.dataDir, "evidence", name), "utf8"))
    .join("\n");
  assert.match(manualEvidence, /manual-ok/);

  // 5) 手动命令越界：不执行，转 needs_authorization
  const third = await (await submit(plane.url, "再验证一次", selection)).json() as AssignmentView;
  await waitFor(plane.url, third.taskId, ["paused"]);
  const thirdAuth = await fetch(plane.url + "/tasks/" + third.taskId + "/authorization", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ text: "授权人：张三 / 目标：127.0.0.1 / 能力：active-lab" }),
  });
  assert.equal(thirdAuth.status, 200, await thirdAuth.clone().text());
  await thirdAuth.text();
  const blocked = await fetch(plane.url + "/tasks/" + third.taskId + "/command", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ command: "curl -s http://evil.test/" }),
  });
  assert.equal(blocked.status, 200, await blocked.clone().text());
  const blockedDone = await waitFor(plane.url, third.taskId, ["paused", "completed", "failed"]);
  assert.equal(blockedDone.status, "paused");
  assert.match(blockedDone.reason ?? "", /evil\.test|越界|授权/);
});

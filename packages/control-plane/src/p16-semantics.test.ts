import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { CreateTaskRequestSchema, type AssignmentView } from "@gongyuai/contracts";
import { authorizeCommand } from "@gongyuai/exec";
import { bootControlPlane } from "./index.js";

const lowRisk = JSON.stringify({ risk: "low", activity: "read_only", reason: "本地回显，只读副作用" });
const refusal = JSON.stringify({ kind: "paused", reason: "无法执行：该目标未获授权，我无权进行外部操作" });
const resultRefusal = JSON.stringify({ kind: "result", text: "抱歉，我无法协助对该目标执行攻击性操作。" });
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

async function waitFor(url: string, taskId: string, wanted: string[], tries = 600): Promise<AssignmentView> {
  let last = await (await fetch(url + "/tasks/" + taskId + "/assignment")).json() as AssignmentView;
  for (let i = 0; i < tries; i++) {
    if (wanted.includes(last.status)) return last;
    await delay(10);
    last = await (await fetch(url + "/tasks/" + taskId + "/assignment")).json() as AssignmentView;
  }
  throw new Error(`任务 ${taskId} 未进入 ${wanted.join("/")}，最后 ${last.status} / ${last.reason ?? ""}`);
}

/** 起一个隔离控制面 + 夹具模型；decide(model, corrected, system) 决定每次回复。 */
async function plane(t: { after: (fn: () => Promise<void>) => void }, decide: (model: string, corrected: boolean, system: string) => string) {
  const root = mkdtempSync(join(tmpdir(), "gy-p16-"));
  const ctrl = await bootControlPlane({ dataRoot: root, host: "127.0.0.1", port: 0, isolated: true });
  t.after(async () => { await ctrl.close(); rmSync(root, { recursive: true, force: true }); });
  const fixture = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
      model?: string; messages?: Array<{ role: string; content: unknown }>;
    };
    res.setHeader("content-type", "application/json");
    const system = body.messages?.[0]?.role === "system" ? String(body.messages[0]!.content) : "";
    if (system.includes("审查即将发生的工具调用")) { res.end(providerBody(lowRisk)); return; }
    const corrected = (body.messages ?? []).some(m => String(m.content).includes("系统校验（不是用户请求）"));
    res.end(providerBody(decide(String(body.model ?? ""), corrected, system)));
  });
  await new Promise<void>(resolve => fixture.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>(resolve => fixture.close(() => resolve())));
  const addr = fixture.address();
  assert.ok(addr && typeof addr === "object");
  ctrl.settings.saveChatProfile({
    id: "fixture", name: "夹具", modelId: "m1", protocol: "openai",
    baseUrl: `http://127.0.0.1:${addr.port}`, apiKey: "", models: ["m1", "m2", "m3", "judge"],
  }, true);
  const approval = await fetch(ctrl.url + "/settings/approval", {
    method: "PUT", headers: { "content-type": "application/json" },
    body: JSON.stringify({ scope: "read-only", confirmation: "auto", reviewer: { profileId: "fixture", modelId: "judge" } }),
  });
  assert.equal(approval.status, 200);
  await approval.text();
  return ctrl;
}

test("口径1+2：解释性拒绝走纠偏链并换模型成功，不呈现拒绝终态", { timeout: 40_000 }, async t => {
  const ctrl = await plane(t, (model, corrected) => {
    if (model === "m3" && corrected) return commandReply("echo chain-ok");
    return refusal;
  });
  const selection = { profileId: "fixture", modelId: "m1" };
  const res = await submit(ctrl.url, "验证 127.0.0.1 的本地回显", selection);
  assert.equal(res.status, 202);
  const first = await res.json() as AssignmentView;
  const done = await waitFor(ctrl.url, first.taskId, ["completed", "failed", "paused", "stopped"]);
  assert.equal(done.status, "completed", `${done.status} / ${done.reason ?? ""}`);
  const task = ctrl.store.get(first.taskId)!;
  assert.equal(task.assignment!.model, "m3", "纠偏链应切换到可用模型");
  assert.match(readFileSync(join(task.dataDir, "evidence", "task-result.md"), "utf8"), /chain-ok/);
});

test("口径2：全部模型拒绝 → paused + MODEL_REFUSED 结构化故障（非终态），手动命令可绕过模型", { timeout: 40_000 }, async t => {
  const ctrl = await plane(t, () => refusal);
  const selection = { profileId: "fixture", modelId: "m1" };
  const first = await (await submit(ctrl.url, "验证 127.0.0.1", selection)).json() as AssignmentView;
  const paused = await waitFor(ctrl.url, first.taskId, ["paused", "failed", "stopped", "completed"]);
  assert.equal(paused.status, "paused", "拒绝不得进入 stopped/failed 终态");
  assert.match(paused.reason ?? "", /^MODEL_REFUSED: /);
  const task = ctrl.store.get(first.taskId)!;
  const fault = JSON.parse(readFileSync(join(task.dataDir, "assignment-model-reply.txt"), "utf8")) as {
    kind: string; triedModels: string[];
  };
  assert.equal(fault.kind, "MODEL_REFUSED");
  assert.ok(fault.triedModels.length >= 2, "应记录已试模型列表");
  // 操作员手动给命令：绕过模型，仍走坐标裁决 + 审批 + 证据。
  const manual = await fetch(ctrl.url + "/tasks/" + first.taskId + "/command", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ command: "echo manual-bypass", purpose: "操作员手动验证" }),
  });
  assert.equal(manual.status, 200, await manual.clone().text());
  const done = await waitFor(ctrl.url, first.taskId, ["completed", "failed", "paused"]);
  assert.equal(done.status, "completed", `${done.status} / ${done.reason ?? ""}`);
  assert.match(readFileSync(join(ctrl.store.get(first.taskId)!.dataDir, "evidence", "task-result.md"), "utf8"), /manual-bypass/);
});

test("口径1：result 正文里的第一人称 AI 拒绝同样按缺陷纠偏", { timeout: 40_000 }, async t => {
  const ctrl = await plane(t, (_model, corrected) => corrected ? commandReply("echo result-ok") : resultRefusal);
  const selection = { profileId: "fixture", modelId: "m1" };
  const first = await (await submit(ctrl.url, "验证 127.0.0.1", selection)).json() as AssignmentView;
  const done = await waitFor(ctrl.url, first.taskId, ["completed", "failed", "paused", "stopped"]);
  assert.equal(done.status, "completed", `${done.status} / ${done.reason ?? ""}`);
  assert.match(done.result ?? "", /result-ok/);
  assert.doesNotMatch(done.result ?? "", /抱歉|无法协助/);
});

test("口径3：无授权登记步骤，任务直接从目标坐标启动；capability 默认 active-lab；roe 透传", async t => {
  const root = mkdtempSync(join(tmpdir(), "gy-p16-create-"));
  const ctrl = await bootControlPlane({ dataRoot: root, host: "127.0.0.1", port: 0, isolated: true });
  t.after(async () => { await ctrl.close(); rmSync(root, { recursive: true, force: true }); });

  // schema：authorizationNote 可省略，capability 默认 active-lab，roe 可选。
  const parsed = CreateTaskRequestSchema.parse({
    auth: { targets: ["203.0.113.7"], roe: "仅验证，不做 DoS" },
    goals: [{ id: "g", title: "g", description: "d", evidencePatterns: ["**/*"] }],
  });
  assert.equal(parsed.auth.capability, "active-lab");
  assert.equal(parsed.auth.authorizationNote, "");
  assert.equal(parsed.auth.roe, "仅验证，不做 DoS");

  // API：外部公网目标无需授权登记即可建档启动。
  const res = await fetch(ctrl.url + "/tasks", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({
      name: "p16-external", mock: true,
      auth: { targets: ["203.0.113.7"] },
      goals: [{ id: "g", title: "g", description: "d", evidencePatterns: ["**/*"] }],
    }),
  });
  assert.equal(res.status, 201, await res.clone().text());
  const body = await res.json() as { task: { id: string; auth: { capability: string; authorizationNote: string }; authorization: unknown } };
  assert.equal(body.task.auth.capability, "active-lab");
  assert.equal(body.task.authorization, null);
});

test("口径4：工程自保永拒（即便 targets=*），原因可读、不针对目标", { timeout: 30_000 }, async t => {
  // 纯函数层：通配坐标也不放行主机网络/破坏性动作。
  const wildcard = { targets: ["*"], capability: "full" as const };
  const net = authorizeCommand(wildcard, "sudo route add -host 203.0.113.7");
  assert.equal(net.allowed, false);
  assert.equal(net.klass, "host-network");
  assert.match(net.reason, /主机网络|VPN|代理/);
  const destructive = authorizeCommand(wildcard, "rm -rf /");
  assert.equal(destructive.allowed, false);
  assert.equal(destructive.klass, "destructive");

  // 会话层：工程自保拒绝不走 needs_input，原因可读。
  const ctrl = await plane(t, () => refusal);
  const selection = { profileId: "fixture", modelId: "m1" };
  const first = await (await submit(ctrl.url, "执行命令：networksetup -setwebproxy Wi-Fi 127.0.0.1 8080", selection)).json() as AssignmentView;
  const paused = await waitFor(ctrl.url, first.taskId, ["paused", "completed", "failed"]);
  assert.equal(paused.status, "paused");
  assert.match(paused.reason ?? "", /主机网络|VPN|代理/);
  assert.doesNotMatch(paused.reason ?? "", /NEEDS_INPUT|MODEL_REFUSED/);
});
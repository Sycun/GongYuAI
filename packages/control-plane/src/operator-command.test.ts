import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
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

async function submit(url: string, content: string, selection: Record<string, unknown>, messages?: Array<{ role: string; content: string }>) {
  return fetch(url + "/tasks/submit", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({
      requestId: randomUUID().replaceAll("-", ""),
      messages: messages ?? [{ role: "user", content }], selection,
    }),
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

test("P16：拒绝先纠偏再给 command（无需授权登记）；授权入口 410；needs_input 澄清环；工程自保", { timeout: 40_000 }, async t => {
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
    const lastUser = [...(body.messages ?? [])].reverse().find((m) => m.role === "user");
    const lastText = String(lastUser?.content ?? "");
    if (corrected) res.end(providerBody(commandReply("echo retry-ok")));
    else if (system.includes("evil.test")) res.end(providerBody(commandReply("echo admitted-ok")));
    else if (lastText.includes("evil.test")) res.end(providerBody(commandReply("curl -s http://evil.test/")));
    else res.end(providerBody(refusal));
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

  // 1) 无授权登记：模型拒绝 → 系统纠偏（目标进入任务即视为授权）→ command → 真执行 + 证据
  const submitted = await submit(plane.url, "验证 127.0.0.1 的本地回显", selection);
  assert.equal(submitted.status, 202, await submitted.clone().text());
  const first = await submitted.json() as AssignmentView;
  const done = await waitFor(plane.url, first.taskId, ["completed", "failed", "paused"]);
  assert.equal(done.status, "completed", `${done.status} / ${done.reason ?? ""}`);
  assert.ok(promptLog.some((p) => p.includes("任务坐标")), "system 应含任务坐标块");
  assert.equal(promptLog.some((p) => p.includes("授权台账（已登记")), false, "不再注入授权台账块");
  assert.ok(promptLog.length >= 2, "拒绝后应至少纠偏一轮");
  const task1 = plane.store.get(first.taskId)!;
  const cmdEvidence = readdirSync(join(task1.dataDir, "evidence")).filter((name) => name.startsWith("command-"));
  assert.ok(cmdEvidence.length >= 1, cmdEvidence.join(","));
  assert.match(readFileSync(join(task1.dataDir, "evidence", cmdEvidence[0]!), "utf8"), /retry-ok/);

  // 2) 授权登记入口已移除：POST 返回 410，指引 /scope；GET 仍可只读回查（无记录为 null）
  const registered = await fetch(plane.url + "/tasks/" + first.taskId + "/authorization", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ text: "授权人：张三 / 目标：127.0.0.1 / 能力：active-lab" }),
  });
  assert.equal(registered.status, 410);
  assert.match((await registered.json() as { error: string }).error, /scope|坐标/);
  const ledgerGet = await fetch(plane.url + "/tasks/" + first.taskId + "/authorization");
  assert.equal(ledgerGet.status, 200);
  assert.equal((await ledgerGet.json() as { authorization: unknown }).authorization, null);

  // 3) 手动命令：绕过模型，仍走坐标裁决 + 审批 + 证据
  const second = await (await submit(plane.url, "执行命令：echo manual-ok", selection)).json() as AssignmentView;
  const manualDone = await waitFor(plane.url, second.taskId, ["completed", "failed", "paused"]);
  assert.equal(manualDone.status, "completed", `${manualDone.status} / ${manualDone.reason ?? ""}`);
  const task2 = plane.store.get(second.taskId)!;
  const manualEvidence = readdirSync(join(task2.dataDir, "evidence"))
    .filter((name) => name.startsWith("command-"))
    .map((name) => readFileSync(join(task2.dataDir, "evidence", name), "utf8"))
    .join("\n");
  assert.match(manualEvidence, /manual-ok/);

  // 4) 手动命令越界：不执行，转 needs_input 澄清（不是授权申请）
  const third = await (await submit(plane.url, "执行命令：curl -s http://evil.test/", selection)).json() as AssignmentView;
  const blocked = await waitFor(plane.url, third.taskId, ["paused", "completed", "failed"]);
  assert.equal(blocked.status, "paused");
  assert.match(blocked.reason ?? "", /NEEDS_INPUT/);
  assert.match(blocked.reason ?? "", /evil\.test|越界|坐标/);
  const task3 = plane.store.get(third.taskId)!;
  assert.ok(existsSync(join(task3.dataDir, "needs-input.json")), "应落 needs-input 澄清请求");
  assert.equal(readdirSync(join(task3.dataDir, "evidence")).filter((n) => n.startsWith("command-")).length, 0, "越界命令不得执行");

  // 5) 澄清环：回复「目标: evil.test，继续」把目标加入坐标 → 续接同任务 → 执行
  const resumed = await submit(plane.url, "", selection, [
    { role: "user", content: "执行命令：curl -s http://evil.test/" },
    { role: "user", content: "目标: evil.test，继续" },
  ]);
  assert.equal(resumed.status, 202, await resumed.clone().text());
  const resumedView = await resumed.json() as AssignmentView;
  assert.equal(resumedView.taskId, third.taskId, "澄清续接必须绑定同一任务");
  const admitted = await waitFor(plane.url, third.taskId, ["completed", "failed", "paused"]);
  assert.equal(admitted.status, "completed", `${admitted.status} / ${admitted.reason ?? ""}`);
  const bound = plane.store.get(third.taskId)!;
  assert.ok(bound.auth.targets.includes("evil.test"), "目标应合并进任务坐标");
  assert.equal(bound.authorization, null, "不再产生授权记录");
  const admittedEvidence = readdirSync(join(bound.dataDir, "evidence"))
    .filter((name) => name.startsWith("command-"))
    .map((name) => readFileSync(join(bound.dataDir, "evidence", name), "utf8"))
    .join("\n");
  assert.match(admittedEvidence, /admitted-ok/);

  // 6) 工程自保：主机网络变更确定性拒绝，与目标无关，不走 needs_input
  const fourth = await (await submit(plane.url, "执行命令：sudo route add -host 192.0.2.1", selection)).json() as AssignmentView;
  const engineering = await waitFor(plane.url, fourth.taskId, ["paused", "completed", "failed"]);
  assert.equal(engineering.status, "paused");
  assert.match(engineering.reason ?? "", /主机网络|VPN|代理/);
  assert.doesNotMatch(engineering.reason ?? "", /NEEDS_INPUT/);
});
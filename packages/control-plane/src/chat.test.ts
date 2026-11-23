import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { existsSync, readFileSync } from "node:fs";
import { selectableChatModels, type AssignmentView } from "@gongyuai/contracts";
import { SettingsStore } from "./settings.js";
import { bootControlPlane } from "./index.js";

const lowRisk = JSON.stringify({ risk: "low", activity: "read_only", reason: "审阅已有文本。" });
function reviewBody(text = lowRisk) {
  return JSON.stringify({ choices: [{ message: { content: text } }],
    content: [{ type: "text", text }], candidates: [{ content: { parts: [{ text }] } }] });
}

async function submit(url: string, body: Record<string, unknown>, requestId = randomUUID().replaceAll("-", "")) {
  return fetch(url + "/tasks/submit", { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ requestId, ...body }) });
}
async function settled(url: string, res: Response): Promise<AssignmentView> {
  assert.equal(res.status, 202, await res.clone().text());
  let view = await res.json() as AssignmentView;
  for (let i = 0; ["running", "queued"].includes(view.status) && i < 100; i++) {
    await delay(10);
    view = await (await fetch(url + "/tasks/" + view.taskId + "/assignment")).json() as AssignmentView;
  }
  return view;
}

test("chat profiles isolate keys, list models and use each provider's native request format", async t => {
  const dataRoot = mkdtempSync(join(tmpdir(), "gy-models-test-"));
  const plane = await bootControlPlane({ dataRoot, host: "127.0.0.1", port: 0, isolated: true });
  t.after(async () => { await plane.close(); rmSync(dataRoot, { recursive: true, force: true }); });
  const calls: Array<{ path: string; headers: import("node:http").IncomingHttpHeaders; body: Record<string, unknown> }> = [];
  const provider = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const url = new URL(req.url!, "http://localhost");
    calls.push({ path: url.pathname, headers: req.headers, body: chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {} });
    res.setHeader("content-type", "application/json");

    if (req.method === "GET") {
      const next = url.searchParams.has("pageToken");
      res.end(JSON.stringify(url.pathname.startsWith("/v1beta")
        ? { models: [{ name: next ? "models/next" : "models/test", supportedGenerationMethods: ["generateContent"] },
          { name: "models/embed", supportedGenerationMethods: ["embedContent"] }], nextPageToken: next ? undefined : "page2" }
        : { data: [{ id: "test" }] }));
    } else {
      res.end(reviewBody(JSON.stringify({ kind: "result", text: "hello" })));
    }
  });
  await new Promise<void>(resolve => provider.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>(resolve => provider.close(() => resolve())));
  const address = provider.address();
  assert.ok(address && typeof address === "object");
  const base = `http://127.0.0.1:${address.port}`;
  async function request(path: string, method: string, body: object) {
    return fetch(plane.url + path, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  }
  const protocols = ["openai", "anthropic", "gemini"] as const;
  const reasoningModels = { openai: "deepseek-flash", anthropic: "claude-sonnet-4-6", gemini: "gemini-3.5-flash-lite" };
  const messages = [{ role: "user", content: "hi" }, { role: "assistant", content: "hello" }, { role: "user", content: "again" }];
  for (const protocol of protocols) {
    const id = "custom-" + protocol;
    const profile = { id, name: protocol, modelId: "test", protocol, models: ["alt", reasoningModels[protocol], "gpt-5.4"], baseUrl: base, apiKey: "fixture-" + protocol };
    const saved = await request("/settings/chat-models", "PUT", { profile, makeDefault: true });
    assert.equal(saved.status, 200);
    const publicJson = await saved.text();
    assert.doesNotMatch(publicJson, /fixture-|apiKey/);
    assert.equal(JSON.parse(publicJson).defaultId, id);
    const queried = await request("/settings/chat-models/query", "POST", { ...profile, apiKey: "" });
    assert.deepEqual(await queried.json(), { models: protocol === "gemini" ? ["next", "test"] : ["test"] });
    const view = await settled(plane.url, await submit(plane.url, { messages, selection: { profileId: id, modelId: "alt" } }));
    assert.equal(view.result, "hello");
    const last = calls.at(-1)!;
    if (protocol === "anthropic") {
      assert.equal(last.path, "/v1/messages");
      assert.equal(last.headers["x-api-key"], profile.apiKey);
      assert.deepEqual(last.body.messages, messages);
      assert.equal(last.body.model, "alt");
    } else if (protocol === "gemini") {
      assert.equal(last.path, "/v1beta/models/alt:generateContent");
      assert.equal(last.headers["x-goog-api-key"], profile.apiKey);
      assert.deepEqual(last.body.contents, messages.map(m => ({ role: m.role === "assistant" ? "model" : "user", parts: [{ text: m.content }] })));
    } else {
      assert.equal(last.path, "/v1/chat/completions");
      assert.equal(last.headers.authorization, "Bearer " + profile.apiKey);
      assert.equal(last.body.model, "alt");
    }
    const selectEffort = (modelId: string, effort?: string) => submit(plane.url, {
      messages, selection: { profileId: id, modelId, effort },
    });
    const reasoningModel = reasoningModels[protocol];
    const high = await selectEffort(reasoningModel, "high");
    assert.equal((await settled(plane.url, high)).status, "completed");
    const payload = calls.at(-1)!.body;
    if (protocol === "openai") {
      assert.deepEqual(payload.thinking, { type: "enabled" });
      assert.equal(payload.reasoning_effort, "high");
      await settled(plane.url, await selectEffort(reasoningModel, "off"));
      assert.deepEqual(calls.at(-1)!.body.thinking, { type: "disabled" });
      assert.equal(calls.at(-1)!.body.reasoning_effort, undefined);
      await settled(plane.url, await selectEffort("gpt-5.4", "off"));
      assert.equal(calls.at(-1)!.body.reasoning_effort, "none");
      assert.equal(calls.at(-1)!.body.thinking, undefined);
    } else if (protocol === "anthropic") {
      assert.deepEqual(payload.thinking, { type: "adaptive" });
      assert.deepEqual(payload.output_config, { effort: "high" });
    } else {
      assert.deepEqual(payload.generationConfig, { thinkingConfig: { thinkingLevel: "HIGH" } });
    }
    await settled(plane.url, await selectEffort(reasoningModel));
    const defaultPayload = calls.at(-1)!.body;
    for (const key of ["thinking", "reasoning_effort", "output_config", "generationConfig"]) assert.equal(defaultPayload[key], undefined);
    const callCount = calls.length;
    const rejected = await selectEffort("alt", "high");
    assert.equal(rejected.status, 400);
    await rejected.text();
    assert.equal(calls.length, callCount);
    const changed = await request("/settings/chat-models/query", "POST", { ...profile, baseUrl: base + "/other/v1", apiKey: "" });
    await changed.text();
    assert.equal(calls.at(-1)!.path, "/other/v1/models");
    const headers = calls.at(-1)!.headers;
    assert.equal(headers.authorization ?? headers["x-goog-api-key"] ?? headers["x-api-key"], undefined);
  }
  const unknown = await submit(plane.url, { messages, selection: { profileId: "missing", modelId: "test" } });
  assert.equal(unknown.status, 400);
  await unknown.text();
});

test("vision settings survive legacy loading, provider edits and explicit clearing", t => {
  const root = mkdtempSync(join(tmpdir(), "gy-vision-profile-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const old = { id: "existing", name: "已有配置", protocol: "openai" as const,
    baseUrl: "https://api.openai.com/v1", apiKey: "", modelId: "text", models: [] };
  writeFileSync(join(root, "settings.json"), JSON.stringify({
    model: { visionModelId: "previous-vision" }, chatProfiles: [old],
  }));
  const store = new SettingsStore(root);
  assert.equal(store.chatProfiles().find(p => p.id === "existing")?.visionModelId, "previous-vision");
  const custom = { ...old, id: "custom-demo", visionModelId: "camera" };
  store.saveChatProfile(custom, false);
  store.saveChatProfile({ ...old, id: custom.id }, false); // older client omits the new field
  const reloaded = new SettingsStore(root);
  const saved = reloaded.chatCatalog().profiles.find(p => p.id === custom.id)!;
  assert.equal(saved.visionModelId, "camera");
  assert.deepEqual(selectableChatModels(saved), ["text", "camera"]);
  reloaded.saveChatProfile({ ...old, visionModelId: "" }, false);
  const cleared = new SettingsStore(root).chatCatalog().profiles.find(p => p.id === "existing")!;
  assert.equal(cleared.visionModelId, "");
  assert.deepEqual(selectableChatModels(cleared), ["text"]);
});

test("workspace submissions create durable tasks and review only actual command proposals", async t => {
  const root = mkdtempSync(join(tmpdir(), "gy-command-approval-"));
  const plane = await bootControlPlane({ dataRoot: root, host: "127.0.0.1", port: 0, isolated: true });
  t.after(async () => { await plane.close(); rmSync(root, { recursive: true, force: true }); });
  const reviewCalls: any[] = [], replyCalls: any[] = [];
  let assessment = lowRisk;
  let unavailable = false;
  const fixture = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    res.setHeader("content-type", "application/json");
    if (body.model === "reviewer") {
      reviewCalls.push(body);
      if (unavailable) { res.statusCode = 503; res.end(); }
      else res.end(reviewBody(assessment));
    } else { replyCalls.push(body); res.end(reviewBody(JSON.stringify({ kind: "result", text: "材料已整理" }))); }
  });
  await new Promise<void>(resolve => fixture.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>(resolve => fixture.close(() => resolve())));
  const addr = fixture.address();
  assert.ok(addr && typeof addr === "object");
  plane.settings.saveChatProfile({ id: "custom-test", name: "夹具", modelId: "text", visionModelId: "vision",
    protocol: "openai", baseUrl: "http://127.0.0.1:" + addr.port, apiKey: "", models: ["reviewer"] }, true);
  const reviewer = { profileId: "custom-test", modelId: "reviewer" };
  const call = (path: string, method: string, body: unknown) => fetch(plane.url + path, {
    method, headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  });
  const save = (scope: string) => call("/settings/approval", "PUT", { reviewer, scope });
  assert.equal((await save("read-only")).status, 200);
  const messages = [{ role: "user", content: "上一轮问题" }, { role: "assistant", content: "上一轮回答" }, {
    role: "user", content: "复核已有材料", attachments: [
      { name: "report.txt", mediaType: "text/plain", data: "报告内容" },
      { name: "pixel.png", mediaType: "image/png", data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO5W7n8AAAAASUVORK5CYII=" },
    ],
  }];
  const selection = { profileId: "custom-test", modelId: "text" };
  const key = randomUUID().replaceAll("-", "");
  const material = await settled(plane.url, await submit(plane.url, { messages, selection }, key));
  assert.equal(material.status, "completed");
  assert.equal(material.model, "vision");
  assert.equal(material.result, "材料已整理");
  assert.equal(reviewCalls.length, 0);
  assert.equal(replyCalls.length, 1);
  assert.match(replyCalls[0].messages.at(-1).content[0].text, /报告内容/);
  assert.equal(replyCalls[0].messages.at(-1).content[1].type, "image_url");
  const task = plane.store.get(material.taskId)!;
  assert.equal(readFileSync(join(task.dataDir, "evidence/task-result.md"), "utf8"), material.result);
  const replay = await settled(plane.url, await submit(plane.url, { messages, selection }, key));
  assert.equal(replay.taskId, material.taskId);
  assert.equal(replyCalls.length, 1);
  assert.equal((await call("/chat", "POST", { messages, selection })).status, 404);

  const run = async (command: string) => settled(plane.url, await submit(plane.url, {
    messages: [{ role: "user", content: "执行命令：" + command }], selection,
  }));
  const allowed = await run("uname -m");
  assert.equal(allowed.status, "completed");
  assert.ok(allowed.result?.trim());
  assert.equal(reviewCalls.length, 1);
  assert.doesNotMatch(JSON.stringify(reviewCalls), /报告内容|image_url|上一轮回答/);

  const marker = join(root, "not-executed");
  const held = await run("touch " + marker);
  assert.equal(held.status, "paused");
  assert.equal(held.commandReview?.decision, "block");
  assert.equal(existsSync(marker), false);
  assert.doesNotMatch(JSON.stringify(reviewCalls), /not-executed/);

  for (const [risk, activity] of [["high", "read_only"], ["unknown", "unknown"], ["low", "local_validation"]]) {
    assessment = JSON.stringify({ risk, activity, reason: "夹具分类" });
    assert.equal((await run("uname -s")).status, "paused");
  }
  assert.equal((await save("local-validation")).status, 200);
  assert.equal((await run("date -u")).status, "completed");
  assessment = '{"risk":"low"}';
  assert.equal((await run("uname -s")).commandReview?.decision, "unavailable");
  unavailable = true;
  assert.equal((await run("uname -s")).status, "paused");
  const count = reviewCalls.length;
  assert.equal((await submit(plane.url, { messages: [{ role: "user", content: "材料",
    attachments: [{ name: "invalid.png", mediaType: "image/png", data: "dGVzdA==" }] }], selection })).status, 400);
  assert.equal(reviewCalls.length, count);
});

test("plain material text is saved, while invalid model replies stay unsuccessful", async t => {
  const root = mkdtempSync(join(tmpdir(), "gy-material-reply-"));
  const plane = await bootControlPlane({ dataRoot: root, host: "127.0.0.1", port: 0, isolated: true });
  t.after(async () => { await plane.close(); rmSync(root, { recursive: true, force: true }); });
  const plain = "待确认事项有两项：\n1. 场地是否改到青禾厅\n2. 字幕预算是否由会务组承担";
  const reviews: unknown[] = [];
  type ReplyScript = { http?: number; raw?: string; content: string };
  const state: { script: ReplyScript } = { script: { content: plain } };
  const fixture = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {};
    const reply = state.script;
    if (JSON.stringify(body.messages ?? "").includes("completeLocalProbe")) {
      reviews.push(body);
      res.setHeader("content-type", "application/json");
      res.end(reviewBody());
      return;
    }
    if (reply.http) { res.statusCode = reply.http; res.end(); return; }
    res.setHeader("content-type", "application/json");
    res.end(reply.raw === undefined ? reviewBody(reply.content) : reply.raw);
  });
  await new Promise<void>(resolve => fixture.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>(resolve => fixture.close(() => resolve())));
  const addr = fixture.address();
  assert.ok(addr && typeof addr === "object");
  plane.settings.saveChatProfile({ id: "custom-test", name: "夹具", modelId: "text", protocol: "openai",
    baseUrl: "http://127.0.0.1:" + addr.port, apiKey: "", models: [] }, true);
  const selection = { profileId: "custom-test", modelId: "text" };
  const messages = [{ role: "user", content: "请列出两个待确认事项", attachments: [
    { name: "pending.txt", mediaType: "text/plain", data: "附件只作为材料" },
  ] }];
  const requestId = randomUUID().replaceAll("-", "");
  const saved = await settled(plane.url, await submit(plane.url, { messages, selection }, requestId));
  assert.equal(saved.status, "completed");
  assert.equal(saved.result, plain);
  assert.equal(reviews.length, 0);
  const task = plane.store.get(saved.taskId)!;
  const file = join(task.dataDir, "evidence/task-result.md");
  assert.equal(existsSync(file), true);
  assert.equal(readFileSync(file, "utf8"), plain);
  const receipt = await (await fetch(plane.url + "/tasks/" + saved.taskId + "/assignment")).json() as AssignmentView;
  assert.equal(receipt.taskId, saved.taskId);
  assert.equal(receipt.status, "completed");
  assert.equal(receipt.result, plain);
  const submission = await (await fetch(plane.url + "/tasks/submissions/" + requestId)).json() as AssignmentView;
  assert.equal(submission.taskId, saved.taskId);
  assert.equal(submission.result, plain);

  state.script = { content: JSON.stringify({ kind: "result", text: "材料已整理" }) };
  const structured = await settled(plane.url, await submit(plane.url, { messages, selection }));
  assert.equal(structured.status, "completed");
  assert.equal(structured.result, "材料已整理");
  assert.notEqual(structured.taskId, saved.taskId);

  state.script = { content: "```json\n" + JSON.stringify({ kind: "result", text: "围栏结果" }) + "\n```" };
  assert.equal((await settled(plane.url, await submit(plane.url, { messages, selection }))).result, "围栏结果");
  state.script = { content: JSON.stringify({ kind: "local_check", check: "uname -m" }) };
  const checked = await settled(plane.url, await submit(plane.url, { messages, selection }));
  assert.equal(checked.status, "completed");
  assert.match(checked.result ?? "", /^\S+$/);
  assert.notEqual(checked.result, "uname -m");
  assert.equal(reviews.length, 1);
  state.script = { content: JSON.stringify({ kind: "paused", reason: "缺少材料" }) };
  const paused = await settled(plane.url, await submit(plane.url, { messages, selection }));
  assert.equal(paused.status, "paused");
  assert.equal(paused.reason, "缺少材料");
  assert.equal(paused.result, undefined);

  const literalCommand = "uname -m";
  state.script = { content: literalCommand };
  const proseCommand = await settled(plane.url, await submit(plane.url, { messages, selection }));
  assert.equal(proseCommand.status, "completed");
  assert.equal(proseCommand.result, literalCommand);
  assert.equal(reviews.length, 1);

  const failures: Array<{ script: ReplyScript; reason: RegExp }> = [
    { script: { content: "" }, reason: /未返回结果/ },
    { script: { content: "   \n" }, reason: /未返回结果/ },
    { script: { http: 503, content: "" }, reason: /HTTP 503/ },
    { script: { raw: "not-json", content: "" }, reason: /无法读取/ },
    { script: { content: "{\"kind\":\"result\",\"text\":\"青禾厅" }, reason: /截断的结构化对象/ },
    { script: { content: "```json\n{\"kind\":\"result\",\"text\":\"青禾厅" }, reason: /截断的结构化对象/ },
    { script: { content: JSON.stringify({ kind: "result", text: "  " }) }, reason: /没有提交可核验的结果/ },
    { script: { content: JSON.stringify({ kind: "local_check", check: "rm -rf /" }) }, reason: /无效的工具请求/ },
    { script: { content: JSON.stringify({ kind: "shell", command: "uname -m" }) }, reason: /无效的工具请求/ },
    { script: { content: JSON.stringify({ items: ["青禾厅", "字幕预算"] }) }, reason: /未返回有效的结构化结果/ },
  ];
  for (const failure of failures) {
    state.script = failure.script;
    const reviewCount: number = reviews.length;
    const view = await settled(plane.url, await submit(plane.url, { messages, selection }));
    assert.equal(view.status, "failed", failure.reason.source);
    assert.equal(view.result, undefined);
    assert.match(view.reason ?? "", failure.reason);
    assert.equal(reviews.length, reviewCount);
    const failedTask = plane.store.get(view.taskId)!;
    assert.equal(existsSync(join(failedTask.dataDir, "evidence/task-result.md")), false);
  }
});

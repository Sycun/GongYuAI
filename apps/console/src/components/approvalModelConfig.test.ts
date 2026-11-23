import test from "node:test";
import assert from "node:assert/strict";
import type { PublicChatProfile } from "@gongyuai/contracts";
import { approvalModelForm, approvalModelProfile } from "./approvalModelConfig.js";

const deepseek: PublicChatProfile = {
  id: "deepseek", name: "DeepSeek", protocol: "openai", baseUrl: "https://api.deepseek.com",
  modelId: "deepseek-flash", models: ["deepseek-v4-pro"], hasKey: true,
};

test("新建表单：全新 custom 服务，预填审批模型提示", () => {
  const form = approvalModelForm(undefined, "old-model", () => "abc123");
  assert.equal(form.id, "custom-abc123");
  assert.equal(form.protocol, "openai");
  assert.equal(form.modelId, "old-model");
  assert.equal(form.baseUrl, "");
  assert.equal(form.apiKey, "");
  const fresh = approvalModelForm(undefined, undefined, () => "xyz");
  assert.equal(fresh.modelId, "");
});

test("编辑表单：沿用既有连接，模型字段取审批正在使用的模型", () => {
  const form = approvalModelForm(deepseek, "deepseek-v4-pro", () => "unused");
  assert.equal(form.id, "deepseek");
  assert.equal(form.name, "DeepSeek");
  assert.equal(form.baseUrl, "https://api.deepseek.com");
  assert.equal(form.modelId, "deepseek-v4-pro");
  assert.equal(form.apiKey, "");
  assert.deepEqual(form.models, ["deepseek-v4-pro"]);
});

test("新建保存：主模型即审批模型，名称回退为审批模型", () => {
  const base = approvalModelForm(undefined, undefined, () => "new1");
  const form = { ...base, baseUrl: "https://relay.example.com", modelId: "my-own-model-id" };
  const profile = approvalModelProfile(form, undefined, null);
  assert.equal(profile.id, "custom-new1");
  assert.equal(profile.name, "审批模型");
  assert.equal(profile.modelId, "my-own-model-id");
  assert.deepEqual(profile.models, ["my-own-model-id"]);
  assert.equal(profile.apiKey, "");
});

test("编辑保存：既有服务商主模型保持不变，手填模型进入候选列表", () => {
  const base = approvalModelForm(deepseek, "deepseek-v4-pro", () => "unused");
  const form = { ...base, modelId: "deepseek-chat-2099" };
  const profile = approvalModelProfile(form, deepseek, null);
  assert.equal(profile.id, "deepseek");
  assert.equal(profile.modelId, "deepseek-flash");
  assert.ok(profile.models.includes("deepseek-v4-pro"));
  assert.ok(profile.models.includes("deepseek-chat-2099"));
});

test("查询结果替换候选列表，且始终包含审批所选模型", () => {
  const base = approvalModelForm(deepseek, "deepseek-v4-pro", () => "unused");
  const form = { ...base, modelId: " deepseek-v4-pro " };
  const profile = approvalModelProfile(form, deepseek, ["listed-a", "listed-b"]);
  assert.deepEqual(profile.models, ["listed-a", "listed-b", "deepseek-v4-pro"]);
});

test("未选模型时不写入空候选", () => {
  const form = approvalModelForm(undefined, undefined, () => "new2");
  const profile = approvalModelProfile(form, undefined, null);
  assert.deepEqual(profile.models, []);
  assert.equal(profile.modelId, "");
});

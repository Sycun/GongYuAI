import test from "node:test";
import assert from "node:assert/strict";
import { DETAIL_TABS, ROUTE_META } from "./labels.js";

test("任务详情页签包含 P14", () => {
  const p14 = DETAIL_TABS.find((tab) => tab.key === "p14");
  assert.ok(p14, "DETAIL_TABS 应包含 p14");
  assert.equal(p14.label, "P14");
});

test("P14 路由有标题与副标题", () => {
  assert.equal(ROUTE_META.p14?.title, "P14 能力");
  assert.equal(ROUTE_META.p14?.subtitle, "事务证据 · 计划 · 凭据 · 复测 · 带外回调");
});

test("任务详情页签包含 P15 观察与复核", () => {
  const p15 = DETAIL_TABS.find((tab) => tab.key === "p15");
  assert.ok(p15, "DETAIL_TABS 应包含 p15");
  assert.equal(p15.label, "P15");
  assert.equal(ROUTE_META.p15?.title, "P15 观察与复核");
});

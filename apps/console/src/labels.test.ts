import test from "node:test";
import assert from "node:assert/strict";
import { DETAIL_TABS, ROUTE_META } from "./labels.js";

test("执行记录页签沿用 p14 路由", () => {
  const p14 = DETAIL_TABS.find((tab) => tab.key === "p14");
  assert.ok(p14, "DETAIL_TABS 应包含 p14");
  assert.equal(p14.label, "执行记录");
});

test("执行记录路由有标题与副标题", () => {
  assert.equal(ROUTE_META.p14?.title, "执行记录");
  assert.equal(ROUTE_META.p14?.subtitle, "事务证据 · 计划 · 凭据 · 复测 · 带外回调");
});

test("观察与复核页签沿用 p15 路由", () => {
  const p15 = DETAIL_TABS.find((tab) => tab.key === "p15");
  assert.ok(p15, "DETAIL_TABS 应包含 p15");
  assert.equal(p15.label, "观察与复核");
  assert.equal(ROUTE_META.p15?.title, "观察与复核");
});

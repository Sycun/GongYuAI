import test from "node:test";
import assert from "node:assert/strict";
import {
  DETAIL_TABS,
  LEGACY_TAB_REDIRECTS,
  ROUTE_META,
  effectiveQualification,
  resolveDetailTab,
} from "./labels.js";

test("任务详情收敛为 6 个 Tab", () => {
  assert.deepEqual(DETAIL_TABS.map((t) => t.key), ["live", "assets", "graph", "traffic", "findings", "logs"]);
  assert.deepEqual(DETAIL_TABS.map((t) => t.label), ["运行态", "资产与战场", "意图图谱", "流量记录", "漏洞与报告", "执行与日志"]);
});

test("每个 Tab 都有标题与副标题", () => {
  for (const tab of DETAIL_TABS) {
    assert.ok(ROUTE_META[tab.key]?.title, `${tab.key} 缺少标题`);
    assert.ok(ROUTE_META[tab.key]?.subtitle, `${tab.key} 缺少副标题`);
  }
});

test("旧版 10 Tab 路由重定向到 6 Tab，不断链", () => {
  assert.equal(resolveDetailTab("goals"), "graph");
  assert.equal(resolveDetailTab("history"), "graph");
  assert.equal(resolveDetailTab("evidence"), "findings");
  assert.equal(resolveDetailTab("report"), "findings");
  assert.equal(resolveDetailTab("p14"), "assets");
  assert.equal(resolveDetailTab("p15"), "findings");
  for (const tab of DETAIL_TABS) assert.equal(resolveDetailTab(tab.key), tab.key);
  assert.equal(resolveDetailTab("unknown-route"), null);
  assert.deepEqual(Object.keys(LEGACY_TAB_REDIRECTS).sort(), ["evidence", "goals", "history", "p14", "p15", "report"]);
});

test("三档定级徽章：缺 qualification 时按生命周期保守推导", () => {
  assert.equal(effectiveQualification({ qualification: "exploited" }), "exploited");
  assert.equal(effectiveQualification({ qualification: "unconfirmed", status: "verified" }), "unconfirmed");
  assert.equal(effectiveQualification({ status: "verified" }), "confirmed");
  assert.equal(effectiveQualification({ status: "retested" }), "confirmed");
  assert.equal(effectiveQualification({ status: "accepted" }), "confirmed");
  assert.equal(effectiveQualification({ status: "tentative" }), "unconfirmed");
  assert.equal(effectiveQualification({}), "unconfirmed");
});
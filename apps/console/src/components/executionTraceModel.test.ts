import assert from "node:assert/strict";
import test from "node:test";
import type { ExecutionStep } from "@gongyuai/contracts";
import { buildTrace, mergeTraceSteps, orderTraceView } from "./executionTraceModel.js";

const stepsNewestFirst: ExecutionStep[] = [
  {
    id: "step-731",
    at: "2026-11-27T14:43:18.000Z",
    number: 731,
    workerSlot: 2,
    tools: ["shell"],
    tokens: 43859433,
    shellCallCount: 1,
    intentId: "22222222-2222-4222-8222-222222222222",
  },
  {
    id: "step-708",
    at: "2026-11-27T14:43:06.000Z",
    number: 708,
    workerSlot: 3,
    tools: ["shell_job"],
    tokens: 42259683,
    shellCallCount: 0,
    intentId: "11111111-1111-4111-8111-111111111111",
  },
];

const progress = [
  "2026-11-27 22:43:01 shell_job start mwz3ckr1",
  "2026-11-27 22:43:20 auto_skill exploitation (triggers=rce, chars=156)",
  "2026-11-27 22:43:20 auto_skill mcp-health-and-parser (triggers=MCP, chars=945)",
];

test("默认倒序（最新在上）：同秒进度保持先后倒序，最新活跃分组与当前节点排在最上方", () => {
  const nodes = buildTrace(progress, [], mergeTraceSteps({ steps: stepsNewestFirst, nextBefore: 5 }));
  const view = orderTraceView(nodes, { newestFirst: true, groupByIntent: true });

  assert.equal(view.displayNodes[0]?.label, "auto_skill mcp-health-and-parser (triggers=MCP, chars=945)");
  assert.equal(view.currentId, view.displayNodes[0]?.id);
  assert.equal(view.displayNodes[1]?.label, "auto_skill exploitation (triggers=rce, chars=156)");
  assert.equal(view.displayNodes[2]?.label, "第 731 步");
  assert.equal(view.displayNodes[3]?.label, "第 708 步");
  assert.equal(view.displayNodes[4]?.label, "shell_job start mwz3ckr1");

  assert.deepEqual(view.groupKeys, [
    "_other",
    "22222222-2222-4222-8222-222222222222",
    "11111111-1111-4111-8111-111111111111",
  ]);
  assert.equal(
    view.groups?.get("_other")?.[0]?.label,
    "auto_skill mcp-health-and-parser (triggers=MCP, chars=945)",
  );
});

test("切换时间正序：按从旧到新排列，_other 分组排在最后", () => {
  const nodes = buildTrace(progress, [], mergeTraceSteps({ steps: stepsNewestFirst, nextBefore: 5 }));
  const view = orderTraceView(nodes, { newestFirst: false, groupByIntent: true });

  assert.equal(view.displayNodes[0]?.label, "shell_job start mwz3ckr1");
  assert.equal(view.displayNodes.at(-1)?.label, "auto_skill mcp-health-and-parser (triggers=MCP, chars=945)");
  assert.deepEqual(view.groupKeys, [
    "11111111-1111-4111-8111-111111111111",
    "22222222-2222-4222-8222-222222222222",
    "_other",
  ]);
});

test("加载历史分页后继续轮询新步骤：新步骤仍保持在最前且去重", () => {
  const livePage = {
    steps: [
      { ...stepsNewestFirst[0]!, id: "step-732", number: 732, at: "2026-11-27T14:43:25.000Z" },
      stepsNewestFirst[0]!,
    ],
    nextBefore: 10,
  };
  const historyPage = {
    steps: [...stepsNewestFirst],
    nextBefore: null,
  };
  const merged = mergeTraceSteps(livePage, historyPage);
  assert.deepEqual(merged.map((s) => s.number), [708, 731, 732]);

  const view = orderTraceView(buildTrace([], [], merged), { newestFirst: true });
  assert.deepEqual(view.displayNodes.map((n) => n.label), ["第 732 步", "第 731 步", "第 708 步"]);
});

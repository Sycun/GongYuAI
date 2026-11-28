import assert from "node:assert/strict";
import test from "node:test";
import type { GEdge, GNode, GView } from "../workspace/model";
import {
  bezierBetween,
  clipText,
  computeMiniMapMetrics,
  formatBadge,
  isUnknownSurfaceEdge,
  kindMeta,
  layoutThumbScene,
  toggleSelectedNode,
} from "./graphLayout";

test("kindMeta, formatBadge, clipText, and edge helpers handle CJK widths and fallback labels", () => {
  assert.equal(kindMeta("finding").label, "漏洞");
  assert.equal(kindMeta("custom_kind").glyph, "节");

  assert.equal(formatBadge(null, "asset"), "资产");
  assert.equal(formatBadge("verified", "finding"), "已证实");
  assert.equal(formatBadge("live:verified", "asset"), "存活 · 已证实");
  assert.equal(formatBadge("raw-tag", "asset"), "raw-tag");

  assert.equal(clipText("short", 10), "short");
  assert.equal(clipText("这是一段超过二十单位宽度的中文标题测试文本", 10), "这是一段超…");

  const unkEdge: GEdge = { id: "e1", from: "a", to: "b", kind: "coverage", label: "unknown", broken: false };
  assert.equal(isUnknownSurfaceEdge(unkEdge, "surface"), true);
  assert.equal(isUnknownSurfaceEdge(unkEdge, "assets"), false);

  assert.match(bezierBetween({ x: 10, y: 10 }, { x: 240, y: 50 }, 100, 30), /^M110 25 C/);
  assert.match(bezierBetween({ x: 300, y: 10 }, { x: 20, y: 50 }, 100, 30), / S0 65, 20 65$/);

  assert.equal(toggleSelectedNode(null, "n1"), "n1");
  assert.equal(toggleSelectedNode("n1", "n1"), null);
});

test("computeMiniMapMetrics and layoutThumbScene bound node counts and preserve readable geometry", () => {
  const mini = computeMiniMapMetrics(
    { maxX: 2400, maxY: 1600 },
    { x: -200, y: -100, k: 0.5 },
    { width: 800, height: 600 },
  );
  assert.ok(mini.scale > 0);
  assert.ok(mini.nodeW * mini.scale >= 6.5);
  assert.ok(mini.viewRect.width >= 24 && mini.viewRect.height >= 24);

  const nodes: GNode[] = Array.from({ length: 16 }, (_, i) => ({
    id: `n-${i}`,
    kind: i % 3 === 0 ? "asset" : i % 3 === 1 ? "intent" : "finding",
    label: `Node ${i}`,
    badge: null,
    data: {},
  }));
  const edges: GEdge[] = [
    ...Array.from({ length: 14 }, (_, i) => ({
      id: `e-${i}`,
      from: `n-${i}`,
      to: `n-${i + 1}`,
      kind: "flow",
      label: "",
      broken: false,
    })),
    // Duplicate and unknown surface edges should be stripped
    { id: "e-dup", from: `n-0`, to: `n-1`, kind: "flow", label: "", broken: false },
    { id: "e-unk", from: `n-1`, to: `n-2`, kind: "unknown", label: "unknown", broken: false },
  ];
  const graph: GView = { taskId: "t-1", view: "surface", nodes, edges, notes: [], empty: false };
  const thumb = layoutThumbScene(graph);
  assert.equal(thumb.nodes.length, 12);
  assert.ok(thumb.lines.length > 0);
  assert.ok(thumb.vbW >= 180 && thumb.vbH >= 76);
});

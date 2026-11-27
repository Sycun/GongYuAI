import { Graph, layout } from "@dagrejs/dagre";
import type { GEdge, GNode, GView, ViewName } from "../workspace/model";

export const THUMB_W = 114;
export const THUMB_H = 34;

export type KindVisual = { label: string; glyph: string; color: string; bg: string; border: string };

export const KIND_VISUALS: Record<string, KindVisual> = {
  asset: { label: "资产", glyph: "资", color: "#10b981", bg: "#ecfdf5", border: "#a7f3d0" },
  scope: { label: "范围", glyph: "范", color: "#6366f1", bg: "#eef2ff", border: "#c7d2fe" },
  intent: { label: "意图", glyph: "意", color: "#3b82f6", bg: "#eff6ff", border: "#bfdbfe" },
  finding: { label: "漏洞", glyph: "漏", color: "#f43f5e", bg: "#fff1f2", border: "#fecdd3" },
  technique: { label: "检查项", glyph: "检", color: "#8b5cf6", bg: "#f5f3ff", border: "#ddd6fe" },
  material: { label: "证据材料", glyph: "证", color: "#0891b2", bg: "#ecfeff", border: "#a5f3fc" },
  slot: { label: "执行槽", glyph: "槽", color: "#2563eb", bg: "#eff6ff", border: "#bfdbfe" },
  step: { label: "执行步", glyph: "步", color: "#475569", bg: "#f8fafc", border: "#cbd5e1" },
  tool_gate: { label: "工具拦截", glyph: "闸", color: "#dc2626", bg: "#fef2f2", border: "#fecaca" },
  timeout: { label: "超时收卷", glyph: "时", color: "#ea580c", bg: "#fff7ed", border: "#fed7aa" },
  relay: { label: "上下文交接", glyph: "交", color: "#7c3aed", bg: "#f5f3ff", border: "#ddd6fe" },
  job: { label: "后台作业", glyph: "业", color: "#0d9488", bg: "#f0fdfa", border: "#99f6e4" },
  fact: { label: "事实", glyph: "事", color: "#f59e0b", bg: "#fffbeb", border: "#fde68a" },
  memory: { label: "记忆", glyph: "忆", color: "#6366f1", bg: "#eef2ff", border: "#c7d2fe" },
  source: { label: "来源", glyph: "源", color: "#64748b", bg: "#f8fafc", border: "#cbd5e1" },
  task: { label: "任务", glyph: "任", color: "#3b82f6", bg: "#eff6ff", border: "#bfdbfe" },
};

const BADGE_LABELS: Record<string, string> = {
  authorized: "授权范围",
  "out-of-scope": "范围外",
  seed: "种子",
  live: "存活",
  admitted: "已准入",
  candidate: "候选",
  oos: "范围外",
  completed: "已完成",
  succeeded: "成功",
  failed: "失败",
  running: "运行中",
  claimed: "已认领",
  proposed: "待执行",
  pending: "待处理",
  worker: "工作槽",
  handoff: "交接",
  partial: "部分收卷",
  denied: "已拒绝",
  verified: "已证实",
  attempted: "已尝试",
  manual: "人工覆盖",
  material: "已有材料",
  retracted: "已撤回",
  unknown: "未知",
  critical: "严重",
  high: "高危",
  medium: "中危",
  low: "低危",
  info: "信息",
};

export function kindMeta(kind: string): KindVisual {
  return KIND_VISUALS[kind] ?? { label: kind, glyph: "节", color: "#64748b", bg: "#f8fafc", border: "#cbd5e1" };
}

export function formatBadge(badge: string | null, kind: string): string {
  if (!badge) return kindMeta(kind).label;
  if (BADGE_LABELS[badge]) return BADGE_LABELS[badge];
  if (badge.includes(":")) {
    return badge
      .split(":")
      .map((part) => BADGE_LABELS[part] ?? part)
      .join(" · ");
  }
  return badge;
}

export function clipText(input: string, maxUnits = 20): string {
  let units = 0;
  let out = "";
  for (const ch of input) {
    const w = ch.charCodeAt(0) > 0xff ? 1.85 : 1;
    if (units + w > maxUnits) return `${out}…`;
    out += ch;
    units += w;
  }
  return out;
}

export function isUnknownSurfaceEdge(edge: GEdge, view: ViewName): boolean {
  if (view !== "surface") return false;
  if (edge.kind === "unknown") return true;
  if (edge.kind === "coverage" && (edge.label === "unknown" || edge.label === "未知")) return true;
  return false;
}

export function bezierBetween(
  from: { x: number; y: number },
  to: { x: number; y: number },
  w: number,
  h: number,
): string {
  const sx = Math.round(from.x + w);
  const sy = Math.round(from.y + h / 2);
  const tx = Math.round(to.x);
  const ty = Math.round(to.y + h / 2);
  if (tx >= sx - 8) {
    const dx = Math.max(28, Math.round((tx - sx) * 0.48));
    return `M${sx} ${sy} C${sx + dx} ${sy}, ${tx - dx} ${ty}, ${tx} ${ty}`;
  }
  const midY = Math.round(sy <= ty ? (from.y + h + to.y) / 2 : (to.y + h + from.y) / 2);
  const pad = 20;
  return `M${sx} ${sy} C${sx + pad} ${sy}, ${sx + pad} ${midY}, ${Math.round((sx + tx) / 2)} ${midY} S${tx - pad} ${ty}, ${tx} ${ty}`;
}

export function toggleSelectedNode(current: string | null, clickedId: string): string | null {
  return current === clickedId ? null : clickedId;
}

export function computeMiniMapMetrics(
  scene: { maxX: number; maxY: number },
  viewport: { x: number; y: number; k: number },
  frameSize: { width: number; height: number },
  mapPixelBox = { width: 152, height: 94 },
  baseNodeSize = { width: 208, height: 62 },
) {
  const viewW = Math.max(80, Math.round(frameSize.width / viewport.k));
  const viewH = Math.max(60, Math.round(frameSize.height / viewport.k));
  const viewX = Math.round(-viewport.x / viewport.k);
  const viewY = Math.round(-viewport.y / viewport.k);

  const sceneW = Math.max(scene.maxX, 240);
  const sceneH = Math.max(scene.maxY, 160);
  const padX = Math.round(Math.max(120, sceneW * 0.28));
  const padY = Math.round(Math.max(90, sceneH * 0.28));

  const minX = Math.max(-padX, Math.min(0, viewX));
  const minY = Math.max(-padY, Math.min(0, viewY));
  const maxX = Math.min(sceneW + padX, Math.max(sceneW, viewX + viewW));
  const maxY = Math.min(sceneH + padY, Math.max(sceneH, viewY + viewH));
  const totalW = Math.max(240, maxX - minX);
  const totalH = Math.max(160, maxY - minY);

  const scale = Math.min(mapPixelBox.width / totalW, mapPixelBox.height / totalH);
  // 保证缩略图中的每个节点在屏幕上至少有约 7×3.6 px 的实心色块，避免大幅缩小或白色描边后变成纯白。
  const nodeW = Math.max(baseNodeSize.width, Math.round(7 / Math.max(scale, 0.0005)));
  const nodeH = Math.max(baseNodeSize.height, Math.round(3.6 / Math.max(scale, 0.0005)));

  const clampedViewX = Math.max(minX, Math.min(maxX - 24, viewX));
  const clampedViewY = Math.max(minY, Math.min(maxY - 24, viewY));
  const clampedViewW = Math.max(24, Math.min(maxX - clampedViewX, viewW));
  const clampedViewH = Math.max(24, Math.min(maxY - clampedViewY, viewH));

  return {
    minX,
    minY,
    totalW,
    totalH,
    scale,
    nodeW,
    nodeH,
    viewRect: { x: clampedViewX, y: clampedViewY, width: clampedViewW, height: clampedViewH },
  };
}

function pickThumbNodes(nodes: GNode[], activeEdges: GEdge[], limit = 12): GNode[] {
  const uniqueNodes: GNode[] = [];
  const byId = new Map<string, GNode>();
  for (const node of nodes) {
    if (byId.has(node.id)) continue;
    byId.set(node.id, node);
    uniqueNodes.push(node);
  }
  if (uniqueNodes.length <= limit) return uniqueNodes;

  const degree = new Map<string, number>();
  for (const e of activeEdges) {
    if (byId.has(e.from) && byId.has(e.to)) {
      degree.set(e.from, (degree.get(e.from) ?? 0) + 1);
      degree.set(e.to, (degree.get(e.to) ?? 0) + 1);
    }
  }
  const connected = uniqueNodes.filter((n) => (degree.get(n.id) ?? 0) > 0);
  if (connected.length === 0) return uniqueNodes.slice(0, limit);
  if (connected.length <= limit) return connected;

  const picked: GNode[] = [];
  const pickedIds = new Set<string>();
  const kindCounts = new Map<string, number>();
  const distinctKinds = new Set(connected.map((n) => n.kind)).size;
  const softKindCap = distinctKinds >= 3 ? 4 : distinctKinds === 2 ? 6 : limit;

  const tryAdd = (node: GNode | undefined, enforceCap: boolean) => {
    if (!node || pickedIds.has(node.id) || picked.length >= limit) return false;
    const count = kindCounts.get(node.kind) ?? 0;
    if (enforceCap && count >= softKindCap) return false;
    pickedIds.add(node.id);
    picked.push(node);
    kindCounts.set(node.kind, count + 1);
    return true;
  };

  for (const e of activeEdges) {
    if (picked.length >= limit) break;
    const from = byId.get(e.from);
    const to = byId.get(e.to);
    if (!from || !to) continue;
    const fromOk = pickedIds.has(from.id) || (kindCounts.get(from.kind) ?? 0) < softKindCap;
    const toOk = pickedIds.has(to.id) || (kindCounts.get(to.kind) ?? 0) < softKindCap;
    if (!fromOk || !toOk) continue;
    tryAdd(from, true);
    tryAdd(to, true);
  }

  for (const e of activeEdges) {
    if (picked.length >= limit) break;
    tryAdd(byId.get(e.from), false);
    tryAdd(byId.get(e.to), false);
  }

  for (const n of connected) {
    if (picked.length >= limit) break;
    tryAdd(n, false);
  }

  return picked;
}

/** 专为侧边栏窄卡片缩略图设计的高清晰度紧凑横向拓扑，避免将大图直接缩小 8 倍导致字迹发糊。 */
export function layoutThumbScene(graph: GView) {
  const seenEdges = new Set<string>();
  const activeEdges = graph.edges.filter((edge) => {
    if (isUnknownSurfaceEdge(edge, graph.view)) return false;
    const key = `${edge.from}\0${edge.to}\0${edge.kind}`;
    if (seenEdges.has(key)) return false;
    seenEdges.add(key);
    return true;
  });
  const picked = pickThumbNodes(graph.nodes, activeEdges, 12);
  const pickedIds = new Set(picked.map((n) => n.id));
  const edges = activeEdges.filter((e) => pickedIds.has(e.from) && pickedIds.has(e.to));

  const positions = new Map<string, { x: number; y: number }>();

  if (edges.length > 0) {
    const g = new Graph({ multigraph: true });
    g.setGraph({ rankdir: "LR", ranksep: 32, nodesep: 12, marginx: 10, marginy: 10 });
    for (const n of picked) g.setNode(n.id, { width: THUMB_W, height: THUMB_H });
    for (const e of edges) g.setEdge(e.from, e.to, {}, e.id);
    layout(g);

    for (const n of picked) {
      const at = g.node(n.id);
      positions.set(n.id, {
        x: Math.round((at?.x ?? THUMB_W) - THUMB_W / 2),
        y: Math.round((at?.y ?? THUMB_H) - THUMB_H / 2),
      });
    }

    const byX = new Map<number, GNode[]>();
    for (const n of picked) {
      const rx = Math.round((positions.get(n.id)?.x ?? 0) / 14) * 14;
      const bucket = byX.get(rx) ?? [];
      bucket.push(n);
      byX.set(rx, bucket);
    }
    const sortedRanks = [...byX.entries()].sort((a, b) => a[0] - b[0]);
    let extraShiftX = 0;
    let wrappedAny = false;
    let wrappedMaxBottom = 0;
    const wrappedRanks = new Set<number>();

    for (const [rx, bucket] of sortedRanks) {
      bucket.sort((a, b) => (positions.get(a.id)?.y ?? 0) - (positions.get(b.id)?.y ?? 0));
      if (bucket.length <= 3) {
        if (extraShiftX > 0) {
          for (const node of bucket) {
            const p = positions.get(node.id)!;
            positions.set(node.id, { x: p.x + extraShiftX, y: p.y });
          }
        }
        continue;
      }
      wrappedAny = true;
      wrappedRanks.add(rx);
      const rows = 3;
      const subCols = Math.ceil(bucket.length / rows);
      const baseX = (positions.get(bucket[0]!.id)?.x ?? 10) + extraShiftX;
      bucket.forEach((node, idx) => {
        const col = Math.floor(idx / rows);
        const row = idx % rows;
        const y = Math.round(10 + row * (THUMB_H + 10));
        positions.set(node.id, {
          x: Math.round(baseX + col * (THUMB_W + 18)),
          y,
        });
        wrappedMaxBottom = Math.max(wrappedMaxBottom, y + THUMB_H);
      });
      extraShiftX += (subCols - 1) * (THUMB_W + 18) + 8;
    }

    if (wrappedAny && wrappedMaxBottom > 0) {
      for (const [rx, bucket] of sortedRanks) {
        if (wrappedRanks.has(rx)) continue;
        const spanH = bucket.length * THUMB_H + Math.max(0, bucket.length - 1) * 12;
        const startY = Math.max(10, Math.round((wrappedMaxBottom + 10 - spanH) / 2));
        bucket.forEach((node, idx) => {
          const p = positions.get(node.id)!;
          positions.set(node.id, { x: p.x, y: startY + idx * (THUMB_H + 12) });
        });
      }
    }
  } else {
    const cols = Math.min(3, Math.max(1, Math.ceil(Math.sqrt(picked.length * 1.8))));
    picked.forEach((n, idx) => {
      const col = idx % cols;
      const row = Math.floor(idx / cols);
      positions.set(n.id, {
        x: 10 + col * (THUMB_W + 14),
        y: 10 + row * (THUMB_H + 10),
      });
    });
  }

  let minX = Infinity;
  let minY = Infinity;
  let maxX = 140;
  let maxY = 64;
  for (const n of picked) {
    const p = positions.get(n.id)!;
    minX = Math.min(minX, p.x);
    minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x + THUMB_W);
    maxY = Math.max(maxY, p.y + THUMB_H);
  }
  if (!Number.isFinite(minX)) { minX = 0; minY = 0; }

  const pad = 8;
  const vbX = Math.max(0, minX - pad);
  const vbY = Math.max(0, minY - pad);
  const vbW = Math.max(180, maxX - vbX + pad);
  const vbH = Math.max(76, maxY - vbY + pad);

  const lines = edges.flatMap((edge) => {
    const from = positions.get(edge.from);
    const to = positions.get(edge.to);
    if (!from || !to) return [];
    return [{ edge, d: bezierBetween(from, to, THUMB_W, THUMB_H) }];
  });

  return { nodes: picked, lines, positions, vbW, vbH, viewBox: `${vbX} ${vbY} ${vbW} ${vbH}` };
}

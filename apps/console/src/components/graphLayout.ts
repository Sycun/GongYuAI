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

/** 专为侧边栏窄卡片缩略图设计的高清晰度紧凑横向拓扑，避免将大图直接缩小 8 倍导致字迹发糊。 */
export function layoutThumbScene(graph: GView) {
  const activeEdges = graph.edges.filter((edge) => !isUnknownSurfaceEdge(edge, graph.view));
  const degree = new Map<string, number>();
  for (const e of activeEdges) {
    degree.set(e.from, (degree.get(e.from) ?? 0) + 1);
    degree.set(e.to, (degree.get(e.to) ?? 0) + 1);
  }
  const connected = graph.nodes.filter((n) => (degree.get(n.id) ?? 0) > 0);
  const picked = (connected.length > 0 ? connected : graph.nodes).slice(0, 12);
  const pickedIds = new Set(picked.map((n) => n.id));
  const edges = activeEdges.filter((e) => pickedIds.has(e.from) && pickedIds.has(e.to));

  const positions = new Map<string, { x: number; y: number }>();

  if (edges.length > 0) {
    const g = new Graph({ multigraph: true });
    g.setGraph({ rankdir: "LR", ranksep: 32, nodesep: 12, marginx: 10, marginy: 10 });
    for (const n of picked) g.setNode(n.id, { width: THUMB_W, height: THUMB_H });
    for (const e of edges) g.setEdge(e.from, e.to, {}, e.id);
    layout(g);

    const outDeg = new Map<string, number>();
    for (const e of edges) outDeg.set(e.from, (outDeg.get(e.from) ?? 0) + 1);

    for (const n of picked) {
      const at = g.node(n.id);
      positions.set(n.id, {
        x: Math.round((at?.x ?? THUMB_W) - THUMB_W / 2),
        y: Math.round((at?.y ?? THUMB_H) - THUMB_H / 2),
      });
    }

    const byX = new Map<number, GNode[]>();
    for (const n of picked) {
      if ((outDeg.get(n.id) ?? 0) > 0) continue;
      const rx = Math.round((positions.get(n.id)?.x ?? 0) / 10) * 10;
      const bucket = byX.get(rx) ?? [];
      bucket.push(n);
      byX.set(rx, bucket);
    }
    for (const [, bucket] of byX) {
      if (bucket.length <= 3) continue;
      bucket.sort((a, b) => (positions.get(a.id)?.y ?? 0) - (positions.get(b.id)?.y ?? 0));
      const rows = 3;
      const baseX = positions.get(bucket[0]!.id)?.x ?? 140;
      const minY = Math.min(...bucket.map((item) => positions.get(item.id)?.y ?? 10));
      bucket.forEach((node, idx) => {
        const col = Math.floor(idx / rows);
        const row = idx % rows;
        positions.set(node.id, {
          x: Math.round(baseX + col * (THUMB_W + 18)),
          y: Math.round(minY + row * (THUMB_H + 10)),
        });
      });
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

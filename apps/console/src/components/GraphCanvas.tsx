import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Graph, layout, type Point } from "@dagrejs/dagre";
import { Button, Input } from "@douyinfe/semi-ui";
import { IconClose, IconExpand, IconMinus, IconPlus, IconSearch } from "@douyinfe/semi-icons";
import { edgeStatement, nodeNavigation, type GEdge, type GNode, type GView, type ViewName } from "../workspace/model";
import { setGraphSlot, useGraphSlot, type Viewport } from "../workspace/graphStore";

const NODE_W = 184;
const NODE_H = 52;

type KindVisual = { label: string; color: string; bg: string; border: string };

const KIND_VISUALS: Record<string, KindVisual> = {
  asset: { label: "资产", color: "#059669", bg: "#ecfdf5", border: "#a7f3d0" },
  scope: { label: "范围", color: "#4465ed", bg: "#eff3ff", border: "#c7d4fc" },
  intent: { label: "意图", color: "#d97706", bg: "#fffbeb", border: "#fde68a" },
  finding: { label: "漏洞", color: "#dc2626", bg: "#fef2f2", border: "#fecaca" },
  technique: { label: "检查项", color: "#7c3aed", bg: "#f5f3ff", border: "#ddd6fe" },
  material: { label: "证据材料", color: "#0891b2", bg: "#ecfeff", border: "#a5f3fc" },
  slot: { label: "执行槽", color: "#2563eb", bg: "#eff6ff", border: "#bfdbfe" },
  step: { label: "执行步", color: "#475569", bg: "#f8fafc", border: "#cbd5e1" },
  tool_gate: { label: "工具拦截", color: "#dc2626", bg: "#fef2f2", border: "#fecaca" },
  timeout: { label: "超时收卷", color: "#ea580c", bg: "#fff7ed", border: "#fed7aa" },
  relay: { label: "上下文交接", color: "#7c3aed", bg: "#f5f3ff", border: "#ddd6fe" },
  job: { label: "后台作业", color: "#0d9488", bg: "#f0fdfa", border: "#99f6e4" },
  fact: { label: "事实", color: "#4465ed", bg: "#eff3ff", border: "#c7d4fc" },
  memory: { label: "记忆", color: "#6366f1", bg: "#eef2ff", border: "#c7d2fe" },
  source: { label: "来源", color: "#64748b", bg: "#f8fafc", border: "#cbd5e1" },
  task: { label: "任务", color: "#3b82f6", bg: "#eff6ff", border: "#bfdbfe" },
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
  return KIND_VISUALS[kind] ?? { label: kind, color: "#64748b", bg: "#f8fafc", border: "#cbd5e1" };
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

function clipText(input: string, maxUnits = 20): string {
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

function isUnknownSurfaceEdge(edge: GEdge, view: ViewName): boolean {
  if (view !== "surface") return false;
  if (edge.kind === "unknown") return true;
  if (edge.kind === "coverage" && (edge.label === "unknown" || edge.label === "未知")) return true;
  return false;
}

function bezierBetween(
  from: { x: number; y: number },
  to: { x: number; y: number },
  w = NODE_W,
  h = NODE_H,
): string {
  const sx = from.x + w;
  const sy = from.y + h / 2;
  const tx = to.x;
  const ty = to.y + h / 2;
  if (tx >= sx - 8) {
    const dx = Math.max(28, (tx - sx) * 0.48);
    return `M${sx} ${sy} C${sx + dx} ${sy}, ${tx - dx} ${ty}, ${tx} ${ty}`;
  }
  // Row-wrap or backward edge: route smoothly through vertical gap
  const midY = sy <= ty ? (from.y + h + to.y) / 2 : (to.y + h + from.y) / 2;
  const pad = 18;
  return `M${sx} ${sy} C${sx + pad} ${sy}, ${sx + pad} ${midY}, ${(sx + tx) / 2} ${midY} S${tx - pad} ${ty}, ${tx} ${ty}`;
}

function smoothPointsPath(points: Point[]): string {
  if (!points.length) return "";
  if (points.length === 1) return `M${points[0]!.x} ${points[0]!.y}`;
  if (points.length === 2) {
    const [a, b] = points as [Point, Point];
    const dx = Math.max(24, Math.abs(b.x - a.x) * 0.42);
    return `M${a.x} ${a.y} C${a.x + dx} ${a.y}, ${b.x - dx} ${b.y}, ${b.x} ${b.y}`;
  }
  let d = `M${points[0]!.x} ${points[0]!.y}`;
  for (let i = 1; i < points.length - 1; i += 1) {
    const curr = points[i]!;
    const next = points[i + 1]!;
    const mx = (curr.x + next.x) / 2;
    const my = (curr.y + next.y) / 2;
    d += ` Q${curr.x} ${curr.y} ${mx} ${my}`;
  }
  const last = points[points.length - 1]!;
  d += ` L${last.x} ${last.y}`;
  return d;
}

type Scene = {
  nodes: GNode[];
  lines: Array<{ edge: GEdge; d: string }>;
  positions: Map<string, { x: number; y: number }>;
  lanes: Array<{ label: string; x: number; y: number; width: number; height: number }>;
  maxX: number;
  maxY: number;
  unknownEdgeCount: number;
  orphanCount: number;
};

type LayoutOptions = {
  kinds: string[] | null;
  hideUnknown?: boolean;
  hideOrphans?: boolean;
  maxNodes?: number;
};

function layoutExecutionScene(
  nodes: GNode[],
  edges: GEdge[],
  unknownEdgeCount: number,
): Scene {
  const positions = new Map<string, { x: number; y: number }>();
  const lanes: Scene["lanes"] = [];
  const stepNodes = nodes.filter((n) => n.kind === "step");
  const slotNodes = nodes.filter((n) => n.kind === "slot");
  const eventNodes = nodes.filter((n) => n.kind === "tool_gate" || n.kind === "timeout" || n.kind === "relay" || n.kind === "job");
  const otherNodes = nodes.filter(
    (n) => n.kind !== "step" && n.kind !== "slot" && n.kind !== "tool_gate" && n.kind !== "timeout" && n.kind !== "relay" && n.kind !== "job",
  );

  // Map each step to its worker slot
  const stepToSlot = new Map<string, string>();
  for (const edge of edges) {
    if (edge.kind === "lane") stepToSlot.set(edge.to, edge.from);
  }
  const stepsBySlot = new Map<string, GNode[]>();
  for (const slot of slotNodes) stepsBySlot.set(slot.id, []);
  const unassignedSteps: GNode[] = [];
  for (const step of stepNodes) {
    const slotId = stepToSlot.get(step.id)
      ?? (step.badge?.startsWith("slot ") ? slotNodes.find((s) => s.label === step.badge)?.id : undefined);
    if (slotId && stepsBySlot.has(slotId)) {
      stepsBySlot.get(slotId)!.push(step);
    } else {
      unassignedSteps.push(step);
    }
  }

  const COLS = 5;
  const GAP_X = 44;
  const GAP_Y = 26;
  const MARGIN = 24;
  let cursorY = MARGIN;
  let maxX = 420;

  const firstStepOfSlot = new Set<string>();

  for (const slot of slotNodes) {
    const list = stepsBySlot.get(slot.id) ?? [];
    const laneTop = cursorY;
    positions.set(slot.id, { x: MARGIN + 12, y: cursorY + 18 });
    const startX = MARGIN + 12 + NODE_W + 54;
    if (list[0]) firstStepOfSlot.add(`${slot.id}->${list[0].id}`);
    list.forEach((step, index) => {
      const row = Math.floor(index / COLS);
      const col = index % COLS;
      const x = startX + col * (NODE_W + GAP_X);
      const y = cursorY + 18 + row * (NODE_H + GAP_Y);
      positions.set(step.id, { x, y });
      maxX = Math.max(maxX, x + NODE_W + 36);
    });
    const rows = Math.max(1, Math.ceil(list.length / COLS));
    const laneHeight = rows * NODE_H + (rows - 1) * GAP_Y + 36;
    lanes.push({
      label: `工作流 · ${slot.label}（${list.length} 步）`,
      x: MARGIN,
      y: laneTop,
      width: Math.max(maxX - MARGIN - 12, NODE_W * 2 + 96),
      height: laneHeight,
    });
    cursorY += laneHeight + 22;
  }

  if (unassignedSteps.length > 0) {
    const laneTop = cursorY;
    unassignedSteps.forEach((step, index) => {
      const row = Math.floor(index / (COLS + 1));
      const col = index % (COLS + 1);
      const x = MARGIN + 14 + col * (NODE_W + GAP_X);
      const y = cursorY + 28 + row * (NODE_H + GAP_Y);
      positions.set(step.id, { x, y });
      maxX = Math.max(maxX, x + NODE_W + 36);
    });
    const rows = Math.ceil(unassignedSteps.length / (COLS + 1));
    const laneHeight = rows * NODE_H + (rows - 1) * GAP_Y + 42;
    lanes.push({ label: `执行步骤（${unassignedSteps.length}）`, x: MARGIN, y: laneTop, width: maxX - MARGIN - 12, height: laneHeight });
    cursorY += laneHeight + 22;
  }

  const placeGridGroup = (group: GNode[], title: string) => {
    if (!group.length) return;
    const cols = Math.min(6, Math.max(3, COLS + 1));
    const laneTop = cursorY;
    group.forEach((node, index) => {
      const row = Math.floor(index / cols);
      const col = index % cols;
      const x = MARGIN + 14 + col * (NODE_W + 24);
      const y = cursorY + 28 + row * (NODE_H + 16);
      positions.set(node.id, { x, y });
      maxX = Math.max(maxX, x + NODE_W + 36);
    });
    const rows = Math.ceil(group.length / cols);
    const laneHeight = rows * NODE_H + (rows - 1) * 16 + 42;
    lanes.push({ label: `${title}（${group.length}）`, x: MARGIN, y: laneTop, width: maxX - MARGIN - 12, height: laneHeight });
    cursorY += laneHeight + 22;
  };

  placeGridGroup(eventNodes, "运行守卫与交接记录");
  placeGridGroup(otherNodes, "关联意图与上下文");

  // Normalize lane widths to uniform right edge
  const uniformWidth = Math.max(380, maxX - MARGIN - 16);
  for (const lane of lanes) lane.width = uniformWidth;

  // Draw clean edges: keep sequence edges + first lane edge per slot + non-spammy audit edges
  const auditPerSource = new Map<string, number>();
  const lines = edges.flatMap((edge) => {
    const from = positions.get(edge.from);
    const to = positions.get(edge.to);
    if (!from || !to) return [];
    if (edge.kind === "lane" && !firstStepOfSlot.has(`${edge.from}->${edge.to}`)) {
      return [];
    }
    if (edge.kind === "audit") {
      const count = (auditPerSource.get(edge.from) ?? 0) + 1;
      auditPerSource.set(edge.from, count);
      if (count > 4) return [];
    }
    return [{ edge, d: bezierBetween(from, to) }];
  });

  return {
    nodes,
    lines,
    positions,
    lanes,
    maxX: Math.max(420, maxX),
    maxY: Math.max(200, cursorY + 8),
    unknownEdgeCount,
    orphanCount: 0,
  };
}

function layoutScene(graph: GView, options: LayoutOptions): Scene {
  const kindFiltered = graph.nodes.filter((node) => !options.kinds?.length || options.kinds.includes(node.kind));
  const cappedNodes = options.maxNodes ? kindFiltered.slice(0, options.maxNodes) : kindFiltered;
  const candidateIds = new Set(cappedNodes.map((node) => node.id));
  const candidateEdges = graph.edges.filter((edge) => candidateIds.has(edge.from) && candidateIds.has(edge.to));

  const unknownEdgeCount = candidateEdges.filter((edge) => isUnknownSurfaceEdge(edge, graph.view)).length;
  const hideUnknown = options.hideUnknown ?? (graph.view === "surface");
  const activeEdges = hideUnknown
    ? candidateEdges.filter((edge) => !isUnknownSurfaceEdge(edge, graph.view))
    : candidateEdges;

  if (graph.view === "execution" && cappedNodes.some((n) => n.kind === "step" || n.kind === "slot")) {
    return layoutExecutionScene(cappedNodes, activeEdges, unknownEdgeCount);
  }

  const degree = new Map<string, number>();
  for (const edge of activeEdges) {
    degree.set(edge.from, (degree.get(edge.from) ?? 0) + 1);
    degree.set(edge.to, (degree.get(edge.to) ?? 0) + 1);
  }

  const connectedNodes = cappedNodes.filter((n) => (degree.get(n.id) ?? 0) > 0);
  const orphanNodes = cappedNodes.filter((n) => (degree.get(n.id) ?? 0) === 0);
  const orphanCount = connectedNodes.length > 0 ? orphanNodes.length : 0;

  const showOrphans = connectedNodes.length === 0 || !options.hideOrphans;
  const visibleNodes = showOrphans ? cappedNodes : connectedNodes;
  const visibleIds = new Set(visibleNodes.map((n) => n.id));
  const visibleEdges = activeEdges.filter((e) => visibleIds.has(e.from) && visibleIds.has(e.to));

  const positions = new Map<string, { x: number; y: number }>();
  const lanes: Scene["lanes"] = [];
  let maxX = 340;
  let maxY = 180;

  // Layout connected subgraph via Dagre with routed edge points
  const g = new Graph({ multigraph: true });
  g.setGraph({ rankdir: "LR", ranksep: 78, nodesep: 22, marginx: 24, marginy: 24 });
  for (const node of connectedNodes) g.setNode(node.id, { width: NODE_W, height: NODE_H });
  for (const edge of visibleEdges) g.setEdge(edge.from, edge.to, {}, edge.id);
  if (connectedNodes.length) layout(g);

  // Check if rightmost leaf column is overly tall (> 9 leaf nodes) and wrap into compact sub-columns
  const outDegree = new Map<string, number>();
  for (const edge of visibleEdges) outDegree.set(edge.from, (outDegree.get(edge.from) ?? 0) + 1);

  const rawPos = new Map<string, { x: number; y: number }>();
  for (const node of connectedNodes) {
    const at = g.node(node.id);
    rawPos.set(node.id, {
      x: (at?.x ?? NODE_W) - NODE_W / 2,
      y: (at?.y ?? NODE_H) - NODE_H / 2,
    });
  }

  // Group leaf nodes that share the same Dagre X rank if > 9 in one column
  const byRankX = new Map<number, GNode[]>();
  for (const node of connectedNodes) {
    if ((outDegree.get(node.id) ?? 0) > 0) continue;
    const rx = Math.round((rawPos.get(node.id)?.x ?? 0) / 10) * 10;
    const list = byRankX.get(rx) ?? [];
    list.push(node);
    byRankX.set(rx, list);
  }
  const wrappedNodeIds = new Set<string>();
  for (const [, bucket] of byRankX) {
    if (bucket.length <= 9) continue;
    bucket.sort((a, b) => (rawPos.get(a.id)?.y ?? 0) - (rawPos.get(b.id)?.y ?? 0));
    const subCols = bucket.length > 20 ? 3 : 2;
    const rows = Math.ceil(bucket.length / subCols);
    const baseX = rawPos.get(bucket[0]!.id)?.x ?? 260;
    const baseY = 24;
    bucket.forEach((node, idx) => {
      const col = Math.floor(idx / rows);
      const row = idx % rows;
      rawPos.set(node.id, {
        x: baseX + col * (NODE_W + 34),
        y: baseY + row * (NODE_H + 18),
      });
      wrappedNodeIds.add(node.id);
    });
  }

  let connectedBottom = 24;
  for (const node of connectedNodes) {
    const pos = rawPos.get(node.id)!;
    positions.set(node.id, pos);
    maxX = Math.max(maxX, pos.x + NODE_W + 32);
    maxY = Math.max(maxY, pos.y + NODE_H + 32);
    connectedBottom = Math.max(connectedBottom, pos.y + NODE_H);
  }

  // Place orphan nodes in a neat multi-column grid below connected component
  const visibleOrphans = showOrphans ? orphanNodes : [];
  if (visibleOrphans.length > 0) {
    const cols = Math.min(5, Math.max(2, Math.ceil(Math.sqrt(visibleOrphans.length * 1.6))));
    const startY = connectedNodes.length > 0 ? connectedBottom + 44 : 28;
    const laneTop = startY - 24;
    visibleOrphans.forEach((node, index) => {
      const row = Math.floor(index / cols);
      const col = index % cols;
      const x = 28 + col * (NODE_W + 24);
      const y = startY + row * (NODE_H + 16);
      positions.set(node.id, { x, y });
      maxX = Math.max(maxX, x + NODE_W + 32);
      maxY = Math.max(maxY, y + NODE_H + 32);
    });
    if (connectedNodes.length > 0) {
      const rows = Math.ceil(visibleOrphans.length / cols);
      lanes.push({
        label: `独立节点 / 未关联项（${visibleOrphans.length}）`,
        x: 16,
        y: laneTop,
        width: maxX - 32,
        height: rows * NODE_H + (rows - 1) * 16 + 38,
      });
      maxY = Math.max(maxY, laneTop + rows * NODE_H + (rows - 1) * 16 + 52);
    }
  }

  const lines = visibleEdges.flatMap((edge) => {
    const from = positions.get(edge.from);
    const to = positions.get(edge.to);
    if (!from || !to) return [];
    if (!wrappedNodeIds.has(edge.from) && !wrappedNodeIds.has(edge.to)) {
      const routed = g.edge(edge.from, edge.to, edge.id) as { points?: Point[] } | undefined;
      if (routed?.points && routed.points.length >= 2) {
        return [{ edge, d: smoothPointsPath(routed.points) }];
      }
    }
    return [{ edge, d: bezierBetween(from, to) }];
  });

  return {
    nodes: visibleNodes,
    lines,
    positions,
    lanes,
    maxX,
    maxY,
    unknownEdgeCount,
    orphanCount,
  };
}

export function GraphThumb({ graph }: { graph: GView }) {
  const markerId = useId().replace(/:/g, "");
  const scene = useMemo(
    () => layoutScene(graph, { kinds: null, hideUnknown: true, hideOrphans: true, maxNodes: 18 }),
    [graph],
  );
  return (
    <svg
      className="gy-graph-thumb"
      viewBox={`0 0 ${scene.maxX} ${scene.maxY}`}
      preserveAspectRatio="xMidYMid meet"
      role="img"
      aria-label="图谱缩略图"
    >
      <defs>
        <marker id={`${markerId}-arrow`} viewBox="0 0 8 8" refX="7" refY="4" markerWidth="5" markerHeight="5" orient="auto-start-reverse">
          <path d="M0,1 L7,4 L0,7 z" fill="#94a3b8" stroke="none" />
        </marker>
      </defs>
      {scene.lines.map(({ edge, d }) => (
        <path
          key={edge.id}
          d={d}
          className={edge.broken || edge.kind === "unknown" ? "is-broken" : ""}
          markerEnd={edge.broken ? undefined : `url(#${markerId}-arrow)`}
        />
      ))}
      {scene.nodes.map((node) => {
        const pos = scene.positions.get(node.id) ?? { x: 12, y: 12 };
        const meta = kindMeta(node.kind);
        return (
          <g key={node.id} transform={`translate(${pos.x} ${pos.y})`}>
            <rect width={NODE_W} height={NODE_H} rx="10" style={{ stroke: meta.border }} />
            <rect x="0" y="10" width="4" height={NODE_H - 20} rx="2" style={{ fill: meta.color, stroke: "none" }} />
            <text x="14" y="23" className="gy-thumb-title">{clipText(node.label, 18)}</text>
            <text x="14" y="39" className="gy-thumb-sub" style={{ fill: meta.color }}>
              {clipText(formatBadge(node.badge, node.kind), 18)}
            </text>
          </g>
        );
      })}
    </svg>
  );
}

function fitViewport(scene: Scene, box: { width: number; height: number }): Viewport {
  const pad = 20;
  const availW = Math.max(160, box.width - pad * 2);
  const availH = Math.max(140, box.height - pad * 2);
  const rawK = Math.min(availW / scene.maxX, availH / scene.maxY, 1.15);
  const k = Number.isFinite(rawK) && rawK > 0 ? Math.max(0.28, rawK) : 1;
  const x = Math.max(12, Math.round((box.width - scene.maxX * k) / 2));
  const y = Math.max(12, Math.round((box.height - scene.maxY * k) / 2));
  return { x, y, k };
}

export function GraphStage({
  graph,
  taskId,
  view,
  onOpen,
}: {
  graph: GView;
  taskId: string;
  view: ViewName;
  onOpen: (href: string) => void;
}) {
  const slot = useGraphSlot(taskId, view);
  const markerId = useId().replace(/:/g, "");
  const frame = useRef<HTMLDivElement>(null);
  const viewport = useRef(slot.viewport);
  viewport.current = slot.viewport;
  const [search, setSearch] = useState("");

  const hideUnknown = slot.hideUnknown ?? (view === "surface");
  const hideOrphans = slot.hideOrphans ?? (view === "surface");

  const scene = useMemo(
    () => layoutScene(graph, { kinds: slot.kinds, hideUnknown, hideOrphans }),
    [graph, slot.kinds, hideUnknown, hideOrphans],
  );

  const selected = graph.nodes.find((node) => node.id === slot.selectedId)
    ?? graph.edges.find((edge) => `edge:${edge.id}` === slot.selectedId);

  const kindCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const node of graph.nodes) counts.set(node.kind, (counts.get(node.kind) ?? 0) + 1);
    return [...counts.entries()];
  }, [graph.nodes]);
  const kinds = useMemo(() => kindCounts.map(([kind]) => kind), [kindCounts]);

  const applyFit = () => {
    const box = frame.current?.getBoundingClientRect();
    if (!box || box.width < 40 || box.height < 40) return;
    setGraphSlot(taskId, view, { viewport: fitViewport(scene, box), fitted: true });
  };

  // Auto-fit when opening a graph for the first time or before manual zoom/pan
  useLayoutEffect(() => {
    if (slot.fitted) return;
    const el = frame.current;
    if (!el) return;
    const box = el.getBoundingClientRect();
    if (box.width >= 40 && box.height >= 40) {
      setGraphSlot(taskId, view, { viewport: fitViewport(scene, box), fitted: true });
      return;
    }
    const observer = new ResizeObserver(() => {
      const nextBox = el.getBoundingClientRect();
      if (nextBox.width >= 40 && nextBox.height >= 40) {
        setGraphSlot(taskId, view, { viewport: fitViewport(scene, nextBox), fitted: true });
        observer.disconnect();
      }
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [taskId, view, scene, slot.fitted]);

  useEffect(() => {
    const el = frame.current;
    if (!el) return;
    const drag = { active: false, x: 0, y: 0, vx: 0, vy: 0 };
    const onDown = (event: PointerEvent) => {
      if (!(event.target instanceof Element) || event.target.closest("button, a, input, .gy-canvas-node, .gy-edge-group")) return;
      drag.active = true;
      drag.x = event.clientX;
      drag.y = event.clientY;
      drag.vx = viewport.current.x;
      drag.vy = viewport.current.y;
      el.setPointerCapture(event.pointerId);
    };
    const onMove = (event: PointerEvent) => {
      if (!drag.active) return;
      setGraphSlot(taskId, view, {
        viewport: { ...viewport.current, x: drag.vx + event.clientX - drag.x, y: drag.vy + event.clientY - drag.y },
        fitted: true,
      });
    };
    const onUp = () => { drag.active = false; };
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const factor = event.deltaY > 0 ? 0.9 : 1.1;
      const nextK = Math.min(2.4, Math.max(0.22, viewport.current.k * factor));
      const rect = el.getBoundingClientRect();
      const px = event.clientX - rect.left;
      const py = event.clientY - rect.top;
      const ratio = nextK / viewport.current.k;
      setGraphSlot(taskId, view, {
        viewport: {
          k: nextK,
          x: px - (px - viewport.current.x) * ratio,
          y: py - (py - viewport.current.y) * ratio,
        },
        fitted: true,
      });
    };
    el.addEventListener("pointerdown", onDown);
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => {
      el.removeEventListener("pointerdown", onDown);
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      el.removeEventListener("wheel", onWheel);
    };
  }, [taskId, view]);

  const zoomBy = (factor: number) => {
    const el = frame.current;
    const rect = el?.getBoundingClientRect();
    const cx = (rect?.width ?? 640) / 2;
    const cy = (rect?.height ?? 420) / 2;
    const nextK = Math.min(2.4, Math.max(0.22, slot.viewport.k * factor));
    const ratio = nextK / slot.viewport.k;
    setGraphSlot(taskId, view, {
      viewport: {
        k: nextK,
        x: cx - (cx - slot.viewport.x) * ratio,
        y: cy - (cy - slot.viewport.y) * ratio,
      },
      fitted: true,
    });
  };

  const focusNode = (node: GNode) => {
    const updates: Partial<typeof slot> = { selectedId: node.id };
    if (slot.kinds?.length && !slot.kinds.includes(node.kind)) {
      updates.kinds = null;
    }
    if (!scene.positions.has(node.id) && hideOrphans) {
      updates.hideOrphans = false;
    }
    const pos = scene.positions.get(node.id);
    const box = frame.current?.getBoundingClientRect();
    if (pos && box && box.width > 80) {
      const k = Math.max(0.75, Math.min(1.15, slot.viewport.k));
      updates.viewport = {
        k,
        x: Math.round(box.width / 2 - (pos.x + NODE_W / 2) * k),
        y: Math.round(box.height / 2 - (pos.y + NODE_H / 2) * k),
      };
      updates.fitted = true;
    }
    setGraphSlot(taskId, view, updates);
  };

  const nodePanel = selected && "label" in selected && "kind" in selected ? selected as GNode : null;
  const edgePanel = selected && "from" in selected ? selected as GEdge : null;
  const navigation = nodePanel ? nodeNavigation(nodePanel, taskId) : null;
  const related = nodePanel
    ? graph.edges.filter((edge) => edge.from === nodePanel.id || edge.to === nodePanel.id)
    : [];
  const nodeById = useMemo(() => new Map(graph.nodes.map((n) => [n.id, n])), [graph.nodes]);

  const filteredDirectory = useMemo(() => {
    const q = search.trim().toLowerCase();
    return graph.nodes.filter((node) => {
      if (slot.kinds?.length && !slot.kinds.includes(node.kind)) return false;
      if (!q) return true;
      return (
        node.label.toLowerCase().includes(q)
        || node.kind.toLowerCase().includes(q)
        || kindMeta(node.kind).label.toLowerCase().includes(q)
        || (node.badge ?? "").toLowerCase().includes(q)
      );
    });
  }, [graph.nodes, slot.kinds, search]);

  const connectedNeighborIds = useMemo(() => {
    if (!nodePanel) return null;
    const set = new Set<string>([nodePanel.id]);
    for (const edge of scene.lines) {
      if (edge.edge.from === nodePanel.id) set.add(edge.edge.to);
      if (edge.edge.to === nodePanel.id) set.add(edge.edge.from);
    }
    return set;
  }, [nodePanel, scene.lines]);

  return (
    <div className="gy-graph-stage-body">
      <div className="gy-graph-toolbar">
        <div className="gy-graph-filters" role="group" aria-label="节点类型筛选">
          {kindCounts.map(([kind, count]) => {
            const on = !slot.kinds?.length || slot.kinds.includes(kind);
            const meta = kindMeta(kind);
            return (
              <button
                key={kind}
                type="button"
                className={`gy-kind-chip${on ? " is-on" : ""}`}
                aria-pressed={on}
                onClick={() => {
                  const current = new Set(slot.kinds ?? kinds);
                  if (current.has(kind) && current.size > 1) current.delete(kind);
                  else current.add(kind);
                  setGraphSlot(taskId, view, {
                    kinds: current.size === kinds.length ? null : [...current],
                    fitted: false,
                  });
                }}
              >
                <i style={{ background: meta.color }} aria-hidden="true" />
                <span>{meta.label}</span>
                <small>{count}</small>
              </button>
            );
          })}
          {view === "surface" && scene.unknownEdgeCount > 0 && (
            <button
              type="button"
              className={`gy-kind-chip is-aux${!hideUnknown ? " is-on" : ""}`}
              aria-pressed={!hideUnknown}
              onClick={() => setGraphSlot(taskId, view, { hideUnknown: !hideUnknown, fitted: false })}
            >
              <span>未测连线</span>
              <small>{scene.unknownEdgeCount}</small>
            </button>
          )}
          {scene.orphanCount > 0 && (
            <button
              type="button"
              className={`gy-kind-chip is-aux${!hideOrphans ? " is-on" : ""}`}
              aria-pressed={!hideOrphans}
              onClick={() => setGraphSlot(taskId, view, { hideOrphans: !hideOrphans, fitted: false })}
            >
              <span>独立节点</span>
              <small>{scene.orphanCount}</small>
            </button>
          )}
        </div>
        <div className="gy-graph-zoom" role="group" aria-label="画布缩放">
          <Button size="small" theme="borderless" icon={<IconMinus />} aria-label="缩小" title="缩小" onClick={() => zoomBy(0.84)} />
          <button
            type="button"
            className="gy-zoom-pct"
            title="恢复 100% 缩放"
            onClick={() => setGraphSlot(taskId, view, { viewport: { ...slot.viewport, k: 1 }, fitted: true })}
          >
            {Math.round(slot.viewport.k * 100)}%
          </button>
          <Button size="small" theme="borderless" icon={<IconPlus />} aria-label="放大" title="放大" onClick={() => zoomBy(1.18)} />
          <Button size="small" theme="borderless" icon={<IconExpand />} className="gy-zoom-fit" onClick={applyFit}>适应画布</Button>
        </div>
      </div>

      <div className="gy-graph-frame" ref={frame}>
        <svg width="100%" height="100%" role="group" aria-label="图谱画布">
          <defs>
            <pattern id={`${markerId}-grid`} width="20" height="20" patternUnits="userSpaceOnUse">
              <circle cx="1" cy="1" r="1" fill="#dbe2ee" />
            </pattern>
            <marker id={`${markerId}-arrow`} viewBox="0 0 10 10" refX="8.5" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
              <path d="M0,1.5 L9,5 L0,8.5 z" fill="#7c90b6" stroke="none" />
            </marker>
            <marker id={`${markerId}-arrow-active`} viewBox="0 0 10 10" refX="8.5" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
              <path d="M0,1.5 L9,5 L0,8.5 z" fill="#4465ed" stroke="none" />
            </marker>
            <marker id={`${markerId}-arrow-broken`} viewBox="0 0 10 10" refX="8.5" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
              <path d="M0,1.5 L9,5 L0,8.5 z" fill="#d94848" stroke="none" />
            </marker>
          </defs>
          <rect width="100%" height="100%" fill={`url(#${markerId}-grid)`} className="gy-canvas-bg" />
          <g transform={`translate(${slot.viewport.x} ${slot.viewport.y}) scale(${slot.viewport.k})`}>
            {scene.lanes.map((lane) => (
              <g key={lane.label} className="gy-canvas-lane" transform={`translate(${lane.x} ${lane.y})`}>
                <rect width={lane.width} height={lane.height} rx="12" />
                <text x="14" y="18">{lane.label}</text>
              </g>
            ))}
            {scene.lines.map(({ edge, d }) => {
              const broken = edge.broken || edge.kind === "unknown";
              const isSelected = `edge:${edge.id}` === slot.selectedId;
              const isIncident = nodePanel ? edge.from === nodePanel.id || edge.to === nodePanel.id : false;
              const dimmed = Boolean(nodePanel && !isIncident && !isSelected);
              const marker = isSelected || isIncident
                ? `url(#${markerId}-arrow-active)`
                : broken
                  ? `url(#${markerId}-arrow-broken)`
                  : `url(#${markerId}-arrow)`;
              return (
                <g
                  key={edge.id}
                  className={`gy-edge-group${broken ? " is-broken" : ""}${edge.kind === "same-family" ? " is-dashed" : ""}${isSelected || isIncident ? " is-selected" : ""}${dimmed ? " is-dimmed" : ""}`}
                  onClick={() => setGraphSlot(taskId, view, { selectedId: `edge:${edge.id}` })}
                >
                  <path d={d} className="gy-edge-hit" />
                  <path d={d} className="gy-edge-line" markerEnd={marker} />
                </g>
              );
            })}
            {scene.nodes.map((node) => {
              const pos = scene.positions.get(node.id) ?? { x: 12, y: 12 };
              const meta = kindMeta(node.kind);
              const isSelected = slot.selectedId === node.id;
              const dimmed = Boolean(connectedNeighborIds && !connectedNeighborIds.has(node.id));
              const badgeText = formatBadge(node.badge, node.kind);
              return (
                <g
                  key={node.id}
                  transform={`translate(${pos.x} ${pos.y})`}
                  className={`gy-canvas-node${isSelected ? " is-selected" : ""}${dimmed ? " is-dimmed" : ""}`}
                  onClick={() => setGraphSlot(taskId, view, { selectedId: isSelected ? null : node.id })}
                >
                  <title>{`${meta.label}：${node.label}${node.badge ? ` (${node.badge})` : ""}`}</title>
                  <rect width={NODE_W} height={NODE_H} rx="10" className="gy-node-card" style={{ stroke: isSelected ? "#4465ed" : meta.border }} />
                  <rect x="0" y="10" width="4" height={NODE_H - 20} rx="2" className="gy-node-accent" style={{ fill: meta.color }} />
                  <circle cx="15" cy="17" r="3.5" style={{ fill: meta.color, stroke: "none" }} />
                  <text x="24" y="20" className="gy-node-kind">{meta.label}</text>
                  {node.badge && (
                    <text x={NODE_W - 10} y="20" textAnchor="end" className="gy-graph-badge" style={{ fill: meta.color }}>
                      {clipText(badgeText, 11)}
                    </text>
                  )}
                  <text x="14" y="39" className="gy-node-title">{clipText(node.label, 21)}</text>
                </g>
              );
            })}
          </g>
        </svg>
        <div className="gy-canvas-stats">
          <span>画布显示 {scene.nodes.length}/{graph.nodes.length} 节点 · {scene.lines.length} 连线</span>
          <span>滚轮缩放 · 拖拽平移</span>
        </div>
        {slot.selectedId && !nodePanel && !edgePanel && <p className="gy-graph-missing">已选节点不在最新图中，选择仍保留。</p>}
      </div>

      <aside className="gy-graph-detail" aria-live="polite">
        <div className="gy-inspector-card">
          {!selected && <p className="gy-inspector-empty">选择节点或关系查看来源。</p>}
          {nodePanel && (() => {
            const meta = kindMeta(nodePanel.kind);
            return (
              <div className="gy-inspector-selected">
                <div className="gy-inspector-head">
                  <span className="gy-inspector-pill" style={{ color: meta.color, background: meta.bg, borderColor: meta.border }}>
                    {meta.label}
                  </span>
                  {nodePanel.badge && <span className="gy-inspector-sub">{formatBadge(nodePanel.badge, nodePanel.kind)}</span>}
                  <Button
                    size="small"
                    theme="borderless"
                    type="tertiary"
                    icon={<IconClose />}
                    aria-label="取消选择"
                    className="gy-inspector-close"
                    onClick={() => setGraphSlot(taskId, view, { selectedId: null })}
                  />
                </div>
                <h3>{nodePanel.label}</h3>
                {Object.keys(nodePanel.data).length > 0 && (
                  <dl className="gy-inspector-meta">
                    {typeof nodePanel.data.tokens === "number" && <><dt>Token</dt><dd>{nodePanel.data.tokens.toLocaleString()}</dd></>}
                    {typeof nodePanel.data.shellCallCount === "number" && <><dt>Shell 调用</dt><dd>{nodePanel.data.shellCallCount}</dd></>}
                    {typeof nodePanel.data.vulnClass === "string" && nodePanel.data.vulnClass && <><dt>漏洞类别</dt><dd>{nodePanel.data.vulnClass}</dd></>}
                    {typeof nodePanel.data.technique === "string" && nodePanel.data.technique && <><dt>关联手法</dt><dd>{nodePanel.data.technique}</dd></>}
                    {typeof nodePanel.data.source === "string" && nodePanel.data.source && <><dt>发现来源</dt><dd>{nodePanel.data.source}</dd></>}
                    {typeof nodePanel.data.reason === "string" && nodePanel.data.reason && <><dt>原因说明</dt><dd>{nodePanel.data.reason}</dd></>}
                  </dl>
                )}
                {navigation?.kind === "link" && (
                  <Button size="small" theme="light" type="primary" onClick={() => onOpen(navigation.href)}>
                    {navigation.label}
                  </Button>
                )}
                {navigation?.kind === "broken" && <p className="is-broken">{navigation.text}</p>}
                {navigation?.kind === "unknown" && <p className="is-unknown">{navigation.text}</p>}
                {related.length > 0 && (
                  <div className="gy-inspector-edges">
                    <strong>关联边（{related.length}）</strong>
                    <ul>
                      {related.slice(0, 24).map((edge) => {
                        const outgoing = edge.from === nodePanel.id;
                        const peerId = outgoing ? edge.to : edge.from;
                        const peer = nodeById.get(peerId);
                        const statement = edgeStatement(edge);
                        return (
                          <li key={edge.id} className={statement.kind === "plain" ? "" : `is-${statement.kind}`}>
                            <span className="gy-edge-dir">{outgoing ? "→" : "←"}</span>
                            {peer ? (
                              <button type="button" className="gy-edge-peer" onClick={() => focusNode(peer)} title={peer.label}>
                                {peer.label}
                              </button>
                            ) : (
                              <span className="gy-edge-peer">{peerId}</span>
                            )}
                            <small>{statement.text}</small>
                          </li>
                        );
                      })}
                    </ul>
                  </div>
                )}
              </div>
            );
          })()}
          {edgePanel && (
            <div className="gy-inspector-selected">
              <div className="gy-inspector-head">
                <span className="gy-inspector-pill">关系连线</span>
                <Button
                  size="small"
                  theme="borderless"
                  type="tertiary"
                  icon={<IconClose />}
                  aria-label="取消选择"
                  className="gy-inspector-close"
                  onClick={() => setGraphSlot(taskId, view, { selectedId: null })}
                />
              </div>
              <h3>
                {nodeById.get(edgePanel.from)?.label ?? edgePanel.from}
                {" → "}
                {nodeById.get(edgePanel.to)?.label ?? edgePanel.to}
              </h3>
              <p className={edgeStatement(edgePanel).kind === "plain" ? "" : `is-${edgeStatement(edgePanel).kind}`}>
                {edgeStatement(edgePanel).text}
              </p>
            </div>
          )}
        </div>

        <div className="gy-node-directory">
          <div className="gy-node-directory-head">
            <strong>节点目录</strong>
            <span>{filteredDirectory.length}</span>
          </div>
          {graph.nodes.length > 5 && (
            <Input
              size="small"
              prefix={<IconSearch />}
              showClear
              placeholder="搜索节点名称或类型…"
              value={search}
              onChange={setSearch}
              aria-label="搜索图谱节点"
            />
          )}
          <ul className="gy-node-list">
            {filteredDirectory.map((node) => {
              const meta = kindMeta(node.kind);
              const active = slot.selectedId === node.id;
              return (
                <li key={node.id}>
                  <button
                    type="button"
                    aria-pressed={active}
                    onClick={() => focusNode(node)}
                    title={`${meta.label} · ${node.label}`}
                  >
                    <i style={{ background: meta.color }} aria-hidden="true" />
                    <span className="gy-node-item-label">{node.label}</span>
                    <small>{formatBadge(node.badge, node.kind)}</small>
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      </aside>
    </div>
  );
}

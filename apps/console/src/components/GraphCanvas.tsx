import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Graph, layout, type Point } from "@dagrejs/dagre";
import { Button, Input, Toast } from "@douyinfe/semi-ui";
import { IconClose, IconExpand, IconMinus, IconPlus, IconSearch } from "@douyinfe/semi-icons";
import { formatDateTime } from "../time";
import { edgeStatement, nodeNavigation, type GEdge, type GNode, type GView, type ViewName } from "../workspace/model";
import { setGraphSlot, useGraphSlot, type Viewport } from "../workspace/graphStore";
import {
  THUMB_H,
  THUMB_W,
  bezierBetween as baseBezierBetween,
  clipText,
  computeMiniMapMetrics,
  formatBadge,
  isUnknownSurfaceEdge,
  kindMeta,
  layoutThumbScene,
} from "./graphLayout";

export { formatBadge, kindMeta };

const NODE_W = 208;
const NODE_H = 62;

function shortNodeTail(id: string): string {
  const clean = id.includes("::") ? id.split("::").pop() ?? id : id.includes(":") ? id.split(":").pop() ?? id : id;
  return clean.length > 10 ? `#${clean.slice(0, 8)}` : clean;
}

function bezierBetween(
  from: { x: number; y: number },
  to: { x: number; y: number },
  w = NODE_W,
  h = NODE_H,
): string {
  return baseBezierBetween(from, to, w, h);
}

function smoothAnchoredPath(
  from: { x: number; y: number },
  to: { x: number; y: number },
  points: Point[],
  w = NODE_W,
  h = NODE_H,
): string {
  if (points.length <= 3) return bezierBetween(from, to, w, h);
  const start = { x: Math.round(from.x + w), y: Math.round(from.y + h / 2) };
  const end = { x: Math.round(to.x), y: Math.round(to.y + h / 2) };
  const pts = [start, ...points.slice(1, -1).map((p) => ({ x: Math.round(p.x), y: Math.round(p.y) })), end];
  let d = `M${pts[0]!.x} ${pts[0]!.y}`;
  for (let i = 1; i < pts.length - 1; i += 1) {
    const curr = pts[i]!;
    const next = pts[i + 1]!;
    d += ` Q${curr.x} ${curr.y} ${Math.round((curr.x + next.x) / 2)} ${Math.round((curr.y + next.y) / 2)}`;
  }
  const last = pts[pts.length - 1]!;
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

  const COLS = 4;
  const GAP_X = 48;
  const GAP_Y = 28;
  const MARGIN = 24;
  let cursorY = MARGIN;
  let maxX = 460;

  const firstStepOfSlot = new Set<string>();

  for (const slot of slotNodes) {
    const list = stepsBySlot.get(slot.id) ?? [];
    const laneTop = cursorY;
    positions.set(slot.id, { x: MARGIN + 14, y: cursorY + 22 });
    const startX = MARGIN + 14 + NODE_W + 58;
    if (list[0]) firstStepOfSlot.add(`${slot.id}->${list[0].id}`);
    list.forEach((step, index) => {
      const row = Math.floor(index / COLS);
      const col = index % COLS;
      const x = startX + col * (NODE_W + GAP_X);
      const y = cursorY + 22 + row * (NODE_H + GAP_Y);
      positions.set(step.id, { x, y });
      maxX = Math.max(maxX, x + NODE_W + 36);
    });
    const rows = Math.max(1, Math.ceil(list.length / COLS));
    const laneHeight = rows * NODE_H + (rows - 1) * GAP_Y + 42;
    lanes.push({
      label: `工作流 · ${slot.label}（${list.length} 步）`,
      x: MARGIN,
      y: laneTop,
      width: Math.max(maxX - MARGIN - 12, NODE_W * 2 + 104),
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
      const y = cursorY + 30 + row * (NODE_H + GAP_Y);
      positions.set(step.id, { x, y });
      maxX = Math.max(maxX, x + NODE_W + 36);
    });
    const rows = Math.ceil(unassignedSteps.length / (COLS + 1));
    const laneHeight = rows * NODE_H + (rows - 1) * GAP_Y + 46;
    lanes.push({ label: `执行步骤（${unassignedSteps.length}）`, x: MARGIN, y: laneTop, width: maxX - MARGIN - 12, height: laneHeight });
    cursorY += laneHeight + 22;
  }

  const placeGridGroup = (group: GNode[], title: string) => {
    if (!group.length) return;
    const cols = Math.min(5, Math.max(3, COLS + 1));
    const laneTop = cursorY;
    group.forEach((node, index) => {
      const row = Math.floor(index / cols);
      const col = index % cols;
      const x = MARGIN + 14 + col * (NODE_W + 26);
      const y = cursorY + 30 + row * (NODE_H + 18);
      positions.set(node.id, { x, y });
      maxX = Math.max(maxX, x + NODE_W + 36);
    });
    const rows = Math.ceil(group.length / cols);
    const laneHeight = rows * NODE_H + (rows - 1) * 18 + 46;
    lanes.push({ label: `${title}（${group.length}）`, x: MARGIN, y: laneTop, width: maxX - MARGIN - 12, height: laneHeight });
    cursorY += laneHeight + 22;
  };

  placeGridGroup(eventNodes, "运行守卫与交接记录");
  placeGridGroup(otherNodes, "关联意图与上下文");

  const uniformWidth = Math.max(420, maxX - MARGIN - 16);
  for (const lane of lanes) lane.width = uniformWidth;

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
    maxX: Math.max(460, maxX),
    maxY: Math.max(220, cursorY + 8),
    unknownEdgeCount,
    orphanCount: 0,
  };
}

export function layoutScene(graph: GView, options: LayoutOptions): Scene {
  const seenNodeIds = new Set<string>();
  const uniqueGraphNodes = graph.nodes.filter((node) => {
    if (seenNodeIds.has(node.id)) return false;
    seenNodeIds.add(node.id);
    return true;
  });
  const kindFiltered = uniqueGraphNodes.filter((node) => !options.kinds?.length || options.kinds.includes(node.kind));
  const cappedNodes = options.maxNodes ? kindFiltered.slice(0, options.maxNodes) : kindFiltered;
  const candidateIds = new Set(cappedNodes.map((node) => node.id));
  const seenEdges = new Set<string>();
  const candidateEdges = graph.edges.filter((edge) => {
    if (!candidateIds.has(edge.from) || !candidateIds.has(edge.to)) return false;
    const key = `${edge.from}\0${edge.to}\0${edge.kind}\0${edge.label}`;
    if (seenEdges.has(key)) return false;
    seenEdges.add(key);
    return true;
  });

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
  let maxX = 380;
  let maxY = 190;

  const g = new Graph({ multigraph: true });
  g.setGraph({ rankdir: "LR", ranksep: 92, nodesep: 26, marginx: 28, marginy: 28 });
  for (const node of connectedNodes) g.setNode(node.id, { width: NODE_W, height: NODE_H });
  for (const edge of visibleEdges) g.setEdge(edge.from, edge.to, {}, edge.id);
  if (connectedNodes.length) layout(g);

  const rawPos = new Map<string, { x: number; y: number }>();
  for (const node of connectedNodes) {
    const at = g.node(node.id);
    rawPos.set(node.id, {
      x: Math.round((at?.x ?? NODE_W) - NODE_W / 2),
      y: Math.round((at?.y ?? NODE_H) - NODE_H / 2),
    });
  }

  // 对任意高度过长（> 8 个节点）的层级列自动折成多子列，并向右平移后续层级，避免大量资产/漏洞/检查项叠成数千像素高的细长竖条导致画布与缩略图失真。
  const byRankX = new Map<number, GNode[]>();
  for (const node of connectedNodes) {
    const rx = Math.round((rawPos.get(node.id)?.x ?? 0) / 20) * 20;
    const list = byRankX.get(rx) ?? [];
    list.push(node);
    byRankX.set(rx, list);
  }
  const sortedRanks = [...byRankX.entries()].sort((a, b) => a[0] - b[0]);
  const wrappedNodeIds = new Set<string>();
  const wrappedRanks = new Set<number>();
  let extraShiftX = 0;
  let wrappedBottom = 0;

  for (const [rx, bucket] of sortedRanks) {
    bucket.sort((a, b) => (rawPos.get(a.id)?.y ?? 0) - (rawPos.get(b.id)?.y ?? 0));
    if (bucket.length <= 8) {
      if (extraShiftX > 0) {
        for (const node of bucket) {
          const p = rawPos.get(node.id)!;
          rawPos.set(node.id, { x: p.x + extraShiftX, y: p.y });
        }
      }
      continue;
    }
    wrappedRanks.add(rx);
    const subCols = bucket.length > 30 ? 4 : bucket.length > 16 ? 3 : 2;
    const rows = Math.ceil(bucket.length / subCols);
    const baseX = (rawPos.get(bucket[0]!.id)?.x ?? 28) + extraShiftX;
    const baseY = 28;
    bucket.forEach((node, idx) => {
      const col = Math.floor(idx / rows);
      const row = idx % rows;
      const y = Math.round(baseY + row * (NODE_H + 20));
      rawPos.set(node.id, {
        x: Math.round(baseX + col * (NODE_W + 38)),
        y,
      });
      wrappedNodeIds.add(node.id);
      wrappedBottom = Math.max(wrappedBottom, y + NODE_H);
    });
    extraShiftX += (subCols - 1) * (NODE_W + 38) + 24;
  }

  if (wrappedNodeIds.size > 0 && wrappedBottom > 0) {
    for (const [rx, bucket] of sortedRanks) {
      if (wrappedRanks.has(rx)) continue;
      const maxBucketY = Math.max(...bucket.map((n) => (rawPos.get(n.id)?.y ?? 0) + NODE_H));
      if (maxBucketY <= wrappedBottom) continue;
      const spanH = bucket.length * NODE_H + Math.max(0, bucket.length - 1) * 24;
      const startY = Math.max(28, Math.round((wrappedBottom + 28 - spanH) / 2));
      bucket.forEach((node, idx) => {
        const p = rawPos.get(node.id)!;
        rawPos.set(node.id, { x: p.x, y: startY + idx * (NODE_H + 24) });
        wrappedNodeIds.add(node.id);
      });
    }
  }

  let connectedBottom = 28;
  for (const node of connectedNodes) {
    const pos = rawPos.get(node.id)!;
    positions.set(node.id, pos);
    maxX = Math.max(maxX, pos.x + NODE_W + 36);
    maxY = Math.max(maxY, pos.y + NODE_H + 36);
    connectedBottom = Math.max(connectedBottom, pos.y + NODE_H);
  }

  const visibleOrphans = showOrphans ? orphanNodes : [];
  if (visibleOrphans.length > 0) {
    const cols = Math.min(5, Math.max(2, Math.ceil(Math.sqrt(visibleOrphans.length * 1.6))));
    const startY = connectedNodes.length > 0 ? connectedBottom + 48 : 28;
    const laneTop = startY - 26;
    visibleOrphans.forEach((node, index) => {
      const row = Math.floor(index / cols);
      const col = index % cols;
      const x = 28 + col * (NODE_W + 26);
      const y = startY + row * (NODE_H + 18);
      positions.set(node.id, { x, y });
      maxX = Math.max(maxX, x + NODE_W + 36);
      maxY = Math.max(maxY, y + NODE_H + 36);
    });
    if (connectedNodes.length > 0) {
      const rows = Math.ceil(visibleOrphans.length / cols);
      lanes.push({
        label: `独立节点 / 未关联项（${visibleOrphans.length}）`,
        x: 16,
        y: laneTop,
        width: maxX - 32,
        height: rows * NODE_H + (rows - 1) * 18 + 42,
      });
      maxY = Math.max(maxY, laneTop + rows * NODE_H + (rows - 1) * 18 + 56);
    }
  }

  const lines = visibleEdges.flatMap((edge) => {
    const from = positions.get(edge.from);
    const to = positions.get(edge.to);
    if (!from || !to) return [];
    if (!wrappedNodeIds.has(edge.from) && !wrappedNodeIds.has(edge.to)) {
      const routed = g.edge(edge.from, edge.to, edge.id) as { points?: Point[] } | undefined;
      if (routed?.points && routed.points.length >= 2) {
        return [{ edge, d: smoothAnchoredPath(from, to, routed.points) }];
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
  const scene = useMemo(() => layoutThumbScene(graph), [graph]);
  return (
    <svg
      className="gy-graph-thumb"
      viewBox={scene.viewBox}
      preserveAspectRatio="xMidYMid meet"
      role="img"
      aria-label="图谱缩略图"
    >
      <defs>
        <marker id={`${markerId}-arrow`} viewBox="0 0 8 8" refX="7" refY="4" markerWidth="4.5" markerHeight="4.5" orient="auto-start-reverse">
          <path d="M0,1.2 L7,4 L0,6.8 z" fill="#94a3b8" stroke="none" />
        </marker>
      </defs>
      {scene.lines.map(({ edge, d }) => (
        <path
          key={edge.id}
          d={d}
          vectorEffect="non-scaling-stroke"
          className={edge.broken || edge.kind === "unknown" ? "is-broken" : ""}
          markerEnd={edge.broken ? undefined : `url(#${markerId}-arrow)`}
        />
      ))}
      {scene.nodes.map((node) => {
        const pos = scene.positions.get(node.id) ?? { x: 10, y: 10 };
        const meta = kindMeta(node.kind);
        return (
          <g key={node.id} transform={`translate(${pos.x} ${pos.y})`}>
            <rect
              width={THUMB_W}
              height={THUMB_H}
              rx="8"
              vectorEffect="non-scaling-stroke"
              className="gy-thumb-card"
              style={{ stroke: meta.border }}
            />
            <rect x="6" y="7" width="20" height="20" rx="5" style={{ fill: meta.color, stroke: "none" }} />
            <text x="16" y="21" textAnchor="middle" className="gy-thumb-glyph">{meta.glyph}</text>
            <text x="31" y="21" className="gy-thumb-title">{clipText(node.label, 11)}</text>
          </g>
        );
      })}
    </svg>
  );
}

function fitViewport(scene: Scene, box: { width: number; height: number }): Viewport {
  const pad = 24;
  const availW = Math.max(160, box.width - pad * 2);
  const availH = Math.max(140, box.height - pad * 2);
  const rawK = Math.min(availW / scene.maxX, availH / scene.maxY, 1.08);
  const k = Number.isFinite(rawK) && rawK > 0 ? Math.max(0.3, rawK) : 1;
  const x = Math.max(14, Math.round((box.width - scene.maxX * k) / 2));
  const y = Math.max(14, Math.round((box.height - scene.maxY * k) / 2));
  return { x, y, k };
}

function StageMiniMap({
  scene,
  viewport,
  frameSize,
  selectedId,
  onNavigate,
}: {
  scene: Scene;
  viewport: Viewport;
  frameSize: { width: number; height: number };
  selectedId: string | null;
  onNavigate: (worldX: number, worldY: number) => void;
}) {
  if (scene.nodes.length < 2 || frameSize.width < 260) return null;
  const compact = frameSize.height < 280;
  const { minX, minY, totalW, totalH, nodeW, nodeH, viewRect } = computeMiniMapMetrics(
    scene,
    viewport,
    frameSize,
    compact ? { width: 124, height: 72 } : { width: 162, height: 98 },
    { width: NODE_W, height: NODE_H },
  );
  const lineStep = scene.lines.length > 180 ? Math.ceil(scene.lines.length / 180) : 1;

  return (
    <svg
      className="gy-stage-minimap"
      viewBox={`${minX} ${minY} ${totalW} ${totalH}`}
      preserveAspectRatio="xMidYMid meet"
      role="img"
      aria-label="画布缩略导航"
      onClick={(event) => {
        event.stopPropagation();
        const rect = event.currentTarget.getBoundingClientRect();
        if (!rect.width || !rect.height) return;
        const scale = Math.min(rect.width / totalW, rect.height / totalH);
        const padX = (rect.width - totalW * scale) / 2;
        const padY = (rect.height - totalH * scale) / 2;
        const worldX = minX + (event.clientX - rect.left - padX) / scale;
        const worldY = minY + (event.clientY - rect.top - padY) / scale;
        onNavigate(worldX, worldY);
      }}
    >
      <rect
        x={minX}
        y={minY}
        width={totalW}
        height={totalH}
        rx="16"
        fill="#f1f5f9"
        stroke="none"
      />
      {scene.lines.map(({ edge, d }, index) => {
        if (lineStep > 1 && index % lineStep !== 0) return null;
        return (
          <path
            key={edge.id}
            d={d}
            fill="none"
            stroke={edge.broken ? "#fca5a5" : "#94a3b8"}
            strokeOpacity={0.5}
            strokeWidth="0.9"
            vectorEffect="non-scaling-stroke"
          />
        );
      })}
      {scene.nodes.map((node) => {
        const pos = scene.positions.get(node.id);
        if (!pos) return null;
        const meta = kindMeta(node.kind);
        const active = selectedId === node.id;
        const cx = pos.x + NODE_W / 2;
        const cy = pos.y + NODE_H / 2;
        return (
          <rect
            key={node.id}
            x={Math.round(cx - nodeW / 2)}
            y={Math.round(cy - nodeH / 2)}
            width={nodeW}
            height={nodeH}
            rx={Math.round(Math.min(nodeW, nodeH) * 0.22)}
            fill={meta.color}
            fillOpacity={active ? 1 : 0.9}
            stroke={active ? "#0f172a" : "none"}
            strokeWidth={active ? 1.8 : 0}
            vectorEffect="non-scaling-stroke"
          />
        );
      })}
      <rect
        x={viewRect.x}
        y={viewRect.y}
        width={viewRect.width}
        height={viewRect.height}
        rx="8"
        fill="rgba(59, 130, 246, 0.12)"
        stroke="#2563eb"
        strokeWidth="1.6"
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
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
  const [copied, setCopied] = useState(false);
  const [frameSize, setFrameSize] = useState({ width: 720, height: 460 });

  const hideUnknown = slot.hideUnknown ?? (view === "surface");
  const hideOrphans = slot.hideOrphans ?? (view === "surface");

  const scene = useMemo(
    () => layoutScene(graph, { kinds: slot.kinds, hideUnknown, hideOrphans }),
    [graph, slot.kinds, hideUnknown, hideOrphans],
  );

  const selected = graph.nodes.find((node) => node.id === slot.selectedId)
    ?? graph.edges.find((edge) => `edge:${edge.id}` === slot.selectedId);

  useEffect(() => {
    setCopied(false);
  }, [slot.selectedId]);

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

  useLayoutEffect(() => {
    const el = frame.current;
    if (!el) return;
    const syncSize = () => {
      const box = el.getBoundingClientRect();
      if (box.width >= 40 && box.height >= 40) {
        setFrameSize({ width: Math.round(box.width), height: Math.round(box.height) });
        if (!slot.fitted) {
          setGraphSlot(taskId, view, { viewport: fitViewport(scene, box), fitted: true });
        }
      }
    };
    syncSize();
    const observer = new ResizeObserver(syncSize);
    observer.observe(el);
    return () => observer.disconnect();
  }, [taskId, view, scene, slot.fitted]);

  useEffect(() => {
    const el = frame.current;
    if (!el) return;
    const drag = { active: false, x: 0, y: 0, vx: 0, vy: 0 };
    const onDown = (event: PointerEvent) => {
      if (!(event.target instanceof Element) || event.target.closest("button, a, input, .gy-canvas-node, .gy-edge-group, .gy-stage-minimap")) return;
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
        viewport: {
          ...viewport.current,
          x: Math.round(drag.vx + event.clientX - drag.x),
          y: Math.round(drag.vy + event.clientY - drag.y),
        },
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
          x: Math.round(px - (px - viewport.current.x) * ratio),
          y: Math.round(py - (py - viewport.current.y) * ratio),
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
        x: Math.round(cx - (cx - slot.viewport.x) * ratio),
        y: Math.round(cy - (cy - slot.viewport.y) * ratio),
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
      const k = Math.max(0.78, Math.min(1.15, slot.viewport.k));
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

  const copySelectedRaw = (payload: unknown) => {
    const raw = JSON.stringify(payload, null, 2);
    void navigator.clipboard?.writeText(raw).then(
      () => {
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1500);
      },
      () => Toast.error("复制失败"),
    );
  };

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
            <pattern id={`${markerId}-grid`} width="16" height="16" patternUnits="userSpaceOnUse">
              <circle cx="1.2" cy="1.2" r="1.15" fill="#cbd5e1" />
            </pattern>
            <marker id={`${markerId}-arrow`} viewBox="0 0 10 10" refX="8.5" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
              <path d="M0,1.5 L9,5 L0,8.5 z" fill="#64748b" stroke="none" />
            </marker>
            <marker id={`${markerId}-arrow-active`} viewBox="0 0 10 10" refX="8.5" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
              <path d="M0,1.5 L9,5 L0,8.5 z" fill="#3b82f6" stroke="none" />
            </marker>
            <marker id={`${markerId}-arrow-broken`} viewBox="0 0 10 10" refX="8.5" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
              <path d="M0,1.5 L9,5 L0,8.5 z" fill="#dc2626" stroke="none" />
            </marker>
          </defs>
          <rect
            width="100%"
            height="100%"
            fill={`url(#${markerId}-grid)`}
            className="gy-canvas-bg"
            onClick={() => slot.selectedId && setGraphSlot(taskId, view, { selectedId: null })}
          />
          <g transform={`translate(${slot.viewport.x} ${slot.viewport.y}) scale(${slot.viewport.k})`}>
            {scene.lanes.map((lane) => (
              <g key={lane.label} className="gy-canvas-lane" transform={`translate(${lane.x} ${lane.y})`}>
                <rect width={lane.width} height={lane.height} rx="14" />
                <text x="16" y="19">{lane.label}</text>
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
                  <title>{`${meta.label}：${node.label}${node.badge ? ` (${badgeText})` : ""}`}</title>
                  <rect y="2" width={NODE_W} height={NODE_H} rx="12" className="gy-node-shadow" />
                  <rect
                    width={NODE_W}
                    height={NODE_H}
                    rx="12"
                    className="gy-node-card"
                    style={{ stroke: isSelected ? "#3b82f6" : "rgba(15, 23, 42, 0.09)" }}
                  />
                  <rect x="10" y="9" width="20" height="20" rx="6" style={{ fill: meta.color, stroke: "none" }} />
                  <text x="20" y="23" textAnchor="middle" className="gy-node-glyph">{meta.glyph}</text>
                  <text x="36" y="23" className="gy-node-kind">{meta.label}</text>
                  {node.badge && (
                    <text x={NODE_W - 11} y="23" textAnchor="end" className="gy-graph-badge" style={{ fill: meta.color }}>
                      {clipText(badgeText, 12)}
                    </text>
                  )}
                  <text x="11" y="48" className="gy-node-title">{clipText(node.label, 23)}</text>
                </g>
              );
            })}
          </g>
        </svg>
        <StageMiniMap
          scene={scene}
          viewport={slot.viewport}
          frameSize={frameSize}
          selectedId={slot.selectedId}
          onNavigate={(worldX, worldY) => {
            setGraphSlot(taskId, view, {
              viewport: {
                k: slot.viewport.k,
                x: Math.round(frameSize.width / 2 - worldX * slot.viewport.k),
                y: Math.round(frameSize.height / 2 - worldY * slot.viewport.k),
              },
              fitted: true,
            });
          }}
        />
        <div className="gy-canvas-stats">
          <span>画布显示 {scene.nodes.length}/{graph.nodes.length} 节点 · {scene.lines.length} 连线</span>
          <span>滚轮缩放 · 拖拽或点击右下角缩略图导航</span>
        </div>
        {slot.selectedId && !nodePanel && !edgePanel && <p className="gy-graph-missing">已选节点不在最新图中，选择仍保留。</p>}
      </div>

      <aside className="gy-graph-detail" aria-live="polite">
        <div className="gy-inspector-card">
          {!selected && <p className="gy-inspector-empty">点击画布中的任意节点或连线，查看属性详情与原始数据。</p>}
          {nodePanel && (() => {
            const meta = kindMeta(nodePanel.kind);
            const rawAt = typeof nodePanel.data.at === "string"
              ? nodePanel.data.at
              : typeof nodePanel.data.createdAt === "string"
                ? nodePanel.data.createdAt
                : null;
            return (
              <div className="gy-inspector-selected">
                <div className="gy-inspector-head">
                  <span className="gy-inspector-icon" style={{ background: meta.color }}>{meta.glyph}</span>
                  <div className="gy-inspector-titles">
                    <strong>{meta.label}</strong>
                    <code>{shortNodeTail(nodePanel.id)}</code>
                  </div>
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
                <dl className="gy-inspector-meta">
                  <dt>类型</dt><dd>{meta.label}</dd>
                  {nodePanel.badge && <><dt>状态</dt><dd>{formatBadge(nodePanel.badge, nodePanel.kind)}</dd></>}
                  <dt>编号</dt><dd>{nodePanel.id}</dd>
                  {typeof nodePanel.data.tokens === "number" && <><dt>Token</dt><dd>{nodePanel.data.tokens.toLocaleString()}</dd></>}
                  {typeof nodePanel.data.shellCallCount === "number" && <><dt>Shell 调用</dt><dd>{nodePanel.data.shellCallCount}</dd></>}
                  {typeof nodePanel.data.vulnClass === "string" && nodePanel.data.vulnClass && <><dt>漏洞类别</dt><dd>{nodePanel.data.vulnClass}</dd></>}
                  {typeof nodePanel.data.technique === "string" && nodePanel.data.technique && <><dt>关联手法</dt><dd>{nodePanel.data.technique}</dd></>}
                  {typeof nodePanel.data.asset === "string" && nodePanel.data.asset && <><dt>所属资产</dt><dd>{nodePanel.data.asset}</dd></>}
                  {typeof nodePanel.data.source === "string" && nodePanel.data.source && <><dt>发现来源</dt><dd>{nodePanel.data.source}</dd></>}
                  {typeof nodePanel.data.reason === "string" && nodePanel.data.reason && <><dt>原因说明</dt><dd>{nodePanel.data.reason}</dd></>}
                  {rawAt && <><dt>时间</dt><dd>{formatDateTime(rawAt, true)}</dd></>}
                </dl>
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
                <div className="gy-inspector-raw">
                  <div className="gy-inspector-raw-head">
                    <strong>原始数据</strong>
                    <button type="button" onClick={() => copySelectedRaw(nodePanel)}>
                      {copied ? "已复制" : "复制"}
                    </button>
                  </div>
                  <pre>{JSON.stringify(nodePanel, null, 2)}</pre>
                </div>
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
              <div className="gy-inspector-raw">
                <div className="gy-inspector-raw-head">
                  <strong>原始数据</strong>
                  <button type="button" onClick={() => copySelectedRaw(edgePanel)}>
                    {copied ? "已复制" : "复制"}
                  </button>
                </div>
                <pre>{JSON.stringify(edgePanel, null, 2)}</pre>
              </div>
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

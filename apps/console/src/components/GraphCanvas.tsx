import { useEffect, useMemo, useRef } from "react";
import { Graph, layout } from "@dagrejs/dagre";
import { Button } from "@douyinfe/semi-ui";
import { edgeStatement, nodeNavigation, type GEdge, type GNode, type GView, type ViewName } from "../workspace/model";
import { setGraphSlot, useGraphSlot, type Viewport } from "../workspace/graphStore";

const nodeWidth = 156;
const nodeHeight = 40;

type Scene = {
  nodes: GNode[];
  lines: Array<{ edge: GEdge; d: string }>;
  positions: Map<string, { x: number; y: number }>;
  maxX: number;
  maxY: number;
};

function layoutScene(graph: GView, kinds: string[] | null): Scene {
  const nodes = graph.nodes.filter((node) => !kinds?.length || kinds.includes(node.kind));
  const ids = new Set(nodes.map((node) => node.id));
  const edges = graph.edges.filter((edge) => ids.has(edge.from) && ids.has(edge.to));
  const g = new Graph({ multigraph: true });
  g.setGraph({ rankdir: "LR", ranksep: 56, nodesep: 22, marginx: 12, marginy: 12 });
  for (const node of nodes) g.setNode(node.id, { width: nodeWidth, height: nodeHeight });
  for (const edge of edges) g.setEdge(edge.from, edge.to, {}, edge.id);
  if (nodes.length) layout(g);
  const positions = new Map<string, { x: number; y: number }>();
  let maxX = 280;
  let maxY = 140;
  for (const node of nodes) {
    const at = g.node(node.id);
    const x = (at?.x ?? nodeWidth) - nodeWidth / 2;
    const y = (at?.y ?? nodeHeight) - nodeHeight / 2;
    positions.set(node.id, { x, y });
    maxX = Math.max(maxX, x + nodeWidth + 28);
    maxY = Math.max(maxY, y + nodeHeight + 28);
  }
  const lines = edges.flatMap((edge) => {
    const from = positions.get(edge.from);
    const to = positions.get(edge.to);
    if (!from || !to) return [];
    return [{ edge, d: `M${from.x + nodeWidth} ${from.y + nodeHeight / 2} L${to.x} ${to.y + nodeHeight / 2}` }];
  });
  return { nodes, lines, positions, maxX, maxY };
}

export function GraphThumb({ graph }: { graph: GView }) {
  const scene = useMemo(() => layoutScene(graph, null), [graph]);
  return (
    <svg className="gy-graph-thumb" viewBox={`0 0 ${scene.maxX} ${scene.maxY}`} role="img" aria-label="图谱缩略图">
      {scene.lines.map(({ edge, d }) => <path key={edge.id} d={d} className={edge.broken || edge.kind === "unknown" ? "is-broken" : ""} />)}
      {scene.nodes.map((node) => {
        const pos = scene.positions.get(node.id) ?? { x: 12, y: 12 };
        return (
          <g key={node.id} transform={`translate(${pos.x} ${pos.y})`}>
            <rect width={nodeWidth} height={nodeHeight} rx="8" />
            <text x="10" y="25">{node.label.slice(0, 16)}</text>
          </g>
        );
      })}
    </svg>
  );
}

function fitViewport(scene: Scene, box: { width: number; height: number }): Viewport {
  const k = Math.min(box.width / scene.maxX, box.height / scene.maxY, 1.4);
  return { x: 12, y: 12, k: Number.isFinite(k) && k > 0 ? k : 1 };
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
  const frame = useRef<HTMLDivElement>(null);
  const viewport = useRef(slot.viewport);
  viewport.current = slot.viewport;
  const scene = useMemo(() => layoutScene(graph, slot.kinds), [graph, slot.kinds]);
  const selected = graph.nodes.find((node) => node.id === slot.selectedId)
    ?? graph.edges.find((edge) => `edge:${edge.id}` === slot.selectedId);
  const kinds = [...new Set(graph.nodes.map((node) => node.kind))];

  useEffect(() => {
    const el = frame.current;
    if (!el) return;
    const drag = { active: false, x: 0, y: 0, vx: 0, vy: 0 };
    const onDown = (event: PointerEvent) => {
      if (!(event.target instanceof Element) || event.target.closest("button, a, input, svg g")) return;
      drag.active = true;
      drag.x = event.clientX;
      drag.y = event.clientY;
      drag.vx = viewport.current.x;
      drag.vy = viewport.current.y;
      el.setPointerCapture(event.pointerId);
    };
    const onMove = (event: PointerEvent) => {
      if (!drag.active) return;
      setGraphSlot(taskId, view, { viewport: { ...viewport.current, x: drag.vx + event.clientX - drag.x, y: drag.vy + event.clientY - drag.y } });
    };
    const onUp = () => { drag.active = false; };
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const next = Math.min(2.4, Math.max(0.35, viewport.current.k * (event.deltaY > 0 ? 0.9 : 1.1)));
      setGraphSlot(taskId, view, { viewport: { ...viewport.current, k: next } });
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

  const nodePanel = selected && "label" in selected && "kind" in selected ? selected as GNode : null;
  const edgePanel = selected && "from" in selected ? selected as GEdge : null;
  const navigation = nodePanel ? nodeNavigation(nodePanel, taskId) : null;
  const related = nodePanel
    ? graph.edges.filter((edge) => edge.from === nodePanel.id || edge.to === nodePanel.id)
    : [];

  return (
    <div className="gy-graph-stage-body">
      <div className="gy-graph-toolbar">
        <Button size="small" onClick={() => {
          const box = frame.current?.getBoundingClientRect();
          setGraphSlot(taskId, view, { viewport: fitViewport(scene, { width: box?.width ?? 640, height: box?.height ?? 420 }) });
        }}>适应画布</Button>
        {kinds.map((kind) => {
          const on = !slot.kinds?.length || slot.kinds.includes(kind);
          return <Button key={kind} size="small" theme={on ? "solid" : "light"} type={on ? "primary" : "tertiary"} onClick={() => {
            const current = new Set(slot.kinds ?? kinds);
            if (current.has(kind) && current.size > 1) current.delete(kind);
            else current.add(kind);
            setGraphSlot(taskId, view, { kinds: current.size === kinds.length ? null : [...current] });
          }}>{kind}</Button>;
        })}
      </div>
      <div className="gy-graph-frame" ref={frame}>
        <svg width="100%" height="100%" role="group" aria-label="图谱画布">
          <g transform={`translate(${slot.viewport.x} ${slot.viewport.y}) scale(${slot.viewport.k})`}>
            {scene.lines.map(({ edge, d }) => (
              <path key={edge.id} d={d} className={(edge.broken || edge.kind === "unknown" ? "is-broken " : "") + (`edge:${edge.id}` === slot.selectedId ? "is-selected" : "")}
                onClick={() => setGraphSlot(taskId, view, { selectedId: `edge:${edge.id}` })} />
            ))}
            {scene.nodes.map((node) => {
              const pos = scene.positions.get(node.id) ?? { x: 12, y: 12 };
              const hidden = slot.kinds?.length && !slot.kinds.includes(node.kind);
              if (hidden) return null;
              return (
                <g key={node.id} transform={`translate(${pos.x} ${pos.y})`} className={slot.selectedId === node.id ? "is-selected" : ""}
                  onClick={() => setGraphSlot(taskId, view, { selectedId: node.id })}>
                  <rect width={nodeWidth} height={nodeHeight} rx="8" />
                  <text x="10" y="17">{node.label.slice(0, 16)}</text>
                  <text x="10" y="32" className="gy-graph-badge">{node.badge ?? node.kind}</text>
                </g>
              );
            })}
          </g>
        </svg>
        {slot.selectedId && !nodePanel && !edgePanel && <p className="gy-graph-missing">已选节点不在最新图中，选择仍保留。</p>}
      </div>
      <aside className="gy-graph-detail" aria-live="polite">
        <ul className="gy-node-list">
          {graph.nodes.map((node) => (
            <li key={node.id}><button type="button" aria-pressed={slot.selectedId === node.id} onClick={() => setGraphSlot(taskId, view, { selectedId: node.id })}>{node.label}</button></li>
          ))}
        </ul>
        {!selected && <p>选择节点或关系查看来源。</p>}
        {nodePanel && <>
          <h3>{nodePanel.label}</h3>
          <p>{nodePanel.kind}{nodePanel.badge ? ` · ${nodePanel.badge}` : ""}</p>
          {navigation?.kind === "link" && <Button size="small" onClick={() => onOpen(navigation.href)}>{navigation.label}</Button>}
          {navigation?.kind === "broken" && <p className="is-broken">{navigation.text}</p>}
          {navigation?.kind === "unknown" && <p className="is-unknown">{navigation.text}</p>}
          {related.map((edge) => {
            const statement = edgeStatement(edge);
            return <p key={edge.id} className={statement.kind === "plain" ? "" : `is-${statement.kind}`}>{statement.text}</p>;
          })}
        </>}
        {edgePanel && <p className={edgeStatement(edgePanel).kind === "plain" ? "" : `is-${edgeStatement(edgePanel).kind}`}>{edgeStatement(edgePanel).text}</p>}
      </aside>
    </div>
  );
}

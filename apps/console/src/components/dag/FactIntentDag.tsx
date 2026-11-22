import { useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Button, Empty, Spin } from "@douyinfe/semi-ui";
import { IconBranch, IconClose, IconExpand, IconMinus, IconPlus } from "@douyinfe/semi-icons";
import {
  Background, BaseEdge, Handle, MarkerType, Position, ReactFlow, ReactFlowProvider,
  getViewportForBounds, useReactFlow, useViewport, type Edge, type EdgeProps, type Node, type NodeProps,
  type OnNodesChange, type ReactFlowInstance,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { STATUS_LABEL } from "../../labels";
import { buildDagLayout, CARD_SIZE, collectDag, type DagFact, type DagIntent, type DagRecord } from "./buildDagLayout";

type Props = { facts: DagFact[]; intents: DagIntent[]; height: number; loading?: boolean };
type RecordNode = Node<DagRecord, "record">;
type RoutedEdge = Edge<{ path: string }, "routed">;
const KIND = { origin: "起点", fact: "事实", intent: "意图" };
const MIN_ZOOM = 0.01;
const MAX_ZOOM = 2;
const FIT = { padding: "20px" as const, minZoom: MIN_ZOOM, maxZoom: 1 };
const ARIA = { "node.a11yDescription.keyboardDisabled": "按回车或空格查看详情，按 Esc 关闭。" };

function RecordCard({ data, targetPosition, sourcePosition }: NodeProps<RecordNode>) {
  return (
    <div className={`gy-dag-node gy-dag-node-${data.kind}`} title={data.title}>
      <Handle type="target" position={targetPosition ?? Position.Left} />
      <span className="gy-dag-node-meta">
        <i aria-hidden="true" />{KIND[data.kind]}
        {data.meta && <span>{STATUS_LABEL[data.meta] ?? data.meta}</span>}
      </span>
      <strong>{data.title}</strong>
      <Handle type="source" position={sourcePosition ?? Position.Right} />
    </div>
  );
}

function RouteLine({ id, data, markerEnd }: EdgeProps<RoutedEdge>) {
  return data && <BaseEdge id={id} path={data.path} markerEnd={markerEnd} interactionWidth={0} />;
}

const nodeTypes = { record: RecordCard };
const edgeTypes = { routed: RouteLine };

function ZoomControls() {
  const { fitView, zoomIn, zoomOut, zoomTo } = useReactFlow();
  const { zoom } = useViewport();
  return (
    <div role="group" aria-label="画布视图" className="gy-dag-controls">
      <Button icon={<IconMinus />} aria-label="缩小" title="缩小" disabled={zoom <= MIN_ZOOM}
        onClick={() => void zoomOut()} />
      <Button className="gy-dag-percent" aria-label="恢复原始大小" title="恢复原始大小"
        onClick={() => void zoomTo(1)}>{Math.round(zoom * 100)}%</Button>
      <Button icon={<IconPlus />} aria-label="放大" title="放大" disabled={zoom >= MAX_ZOOM}
        onClick={() => void zoomIn()} />
      <Button icon={<IconExpand />} className="gy-dag-fit" onClick={() => void fitView(FIT)}>适应画布</Button>
    </div>
  );
}

export default function FactIntentDag({ facts, intents, height, loading }: Props) {
  const section = useRef<HTMLElement>(null);
  const viewport = useRef<HTMLDivElement>(null);
  const flowId = useId().replace(/:/g, "");
  const [vertical, setVertical] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const { records, topologyKey } = useMemo(() => collectDag(facts, intents), [facts, intents]);
  const geometry = useMemo(() => buildDagLayout(topologyKey, vertical), [topologyKey, vertical]);
  const selected = selectedId ? records.get(selectedId) : undefined;

  useLayoutEffect(() => {
    const el = section.current!;
    const measure = () => setVertical(el.clientWidth < 560);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const nodes = useMemo<RecordNode[]>(() => geometry.positions.map(({ id, position }) => {
    const data = records.get(id)!;
    return {
      id, position, data, ...CARD_SIZE, type: "record", selected: id === selectedId,
      sourcePosition: vertical ? Position.Bottom : Position.Right,
      targetPosition: vertical ? Position.Top : Position.Left,
      ariaRole: "button", ariaLabel: `${KIND[data.kind]}，${data.title}`,
      domAttributes: {
        "aria-pressed": id === selectedId,
        "aria-controls": id === selectedId ? `${flowId}-detail` : undefined,
      },
    };
  }), [geometry, records, selectedId, vertical, flowId]);

  const edges = useMemo<RoutedEdge[]>(() => geometry.edges.map(({ id, source, target, kind, path }) => {
    const active = selectedId === source || selectedId === target;
    return {
      id, source, target, type: "routed", data: { path }, selectable: false,
      className: `gy-dag-edge-${kind}${active ? " gy-dag-edge-active" : ""}`,
      markerEnd: { type: MarkerType.ArrowClosed, color: active ? "var(--semi-color-primary)" : "var(--semi-color-text-2)" },
    };
  }), [geometry, selectedId]);

  const onNodesChange: OnNodesChange<RecordNode> = (changes) => {
    for (const change of changes) {
      if (change.type === "select") {
        setSelectedId((current) => change.selected ? change.id : current === change.id ? null : current);
      }
    }
  };

  const openCanvas = (flow: ReactFlowInstance<RecordNode, RoutedEdge>) => {
    const { clientWidth: width, clientHeight: height } = viewport.current!;
    const bounds = flow.getNodesBounds(nodes);
    const overview = getViewportForBounds(bounds, width, height, MIN_ZOOM, 1, FIT.padding);
    if (overview.zoom >= 0.65) {
      void flow.setViewport(overview);
      return;
    }
    // At overview scale a long graph is illegible. Open at its first node at reading size.
    const first = nodes.find((node) => node.data.kind === "origin") ?? nodes[0];
    void flow.setViewport({
      zoom: 1,
      x: (vertical ? (width - CARD_SIZE.width) / 2 : 20) - first.position.x,
      y: (vertical ? 20 : (height - CARD_SIZE.height) / 2) - first.position.y,
    });
  };

  const closeDetails = () => {
    section.current?.querySelector<HTMLElement>(`[data-id="${CSS.escape(selectedId!)}"]`)?.focus();
    setSelectedId(null);
  };

  return (
    <section className="gy-dag" ref={section} aria-label="事实与意图关系图">
      <ReactFlowProvider key={vertical ? "vertical" : "horizontal"}>
        <header className="gy-dag-toolbar">
          <div className="gy-dag-heading">
            <IconBranch />
            <h3>事实与意图</h3>
            {nodes.length > 0 && <span>{nodes.length} 个节点 · {edges.length} 条连线</span>}
          </div>
          {nodes.length > 0 && <ZoomControls />}
        </header>
        {nodes.length ? (
          <>
            <div className="gy-dag-viewport" style={{ height }} ref={viewport}>
              <ReactFlow<RecordNode, RoutedEdge>
                id={flowId} nodes={nodes} edges={edges} nodeTypes={nodeTypes} edgeTypes={edgeTypes}
                onNodesChange={onNodesChange} onInit={openCanvas}
                onNodeClick={(_, node) => { if (node.id === selectedId) setSelectedId(null); }}
                minZoom={MIN_ZOOM} maxZoom={MAX_ZOOM} nodesDraggable={false} nodesConnectable={false}
                edgesReconnectable={false} edgesFocusable={false} deleteKeyCode={null}
                multiSelectionKeyCode={null} selectionKeyCode={null}
                zoomOnScroll={false} preventScrolling={false} ariaLabelConfig={ARIA}
              >
                <Background gap={20} size={1} color="var(--semi-color-border)" />
              </ReactFlow>
            </div>
            <footer className="gy-dag-legend">
              <span><i />触发</span><span><i className="gy-dashed" />产出</span>
              <span className="gy-dag-hint">拖动画布 · 选择节点查看详情</span>
            </footer>
          </>
        ) : loading ? (
          <div className="gy-dag-empty" role="status"><Spin /> 正在加载关系图…</div>
        ) : (
          <Empty className="gy-dag-empty" title="暂无可绘制的节点" description="记录事实或意图后，关系图会显示在这里。" />
        )}
      </ReactFlowProvider>
      {selected && (
        <section className="gy-dag-detail" id={`${flowId}-detail`} aria-label="节点详情" onKeyDown={(event) => {
          if (event.key === "Escape") closeDetails();
        }}>
          <div className="gy-dag-detail-heading">
            <div>
              <span>{KIND[selected.kind]}{selected.meta && ` · ${STATUS_LABEL[selected.meta] ?? selected.meta}`}</span>
              <h4>{selected.title}</h4>
            </div>
            <Button icon={<IconClose />} theme="borderless" type="tertiary" aria-label="关闭节点详情" onClick={closeDetails} />
          </div>
          {selected.summary && <p>{selected.summary}</p>}
          <dl>
            <dt>节点 ID</dt><dd>{selectedId}</dd>
            {selected.sources && <><dt>前驱</dt><dd>{selected.sources.join("、")}</dd></>}
          </dl>
        </section>
      )}
    </section>
  );
}

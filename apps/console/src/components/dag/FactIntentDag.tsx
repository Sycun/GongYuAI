import { useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Button, Empty, Spin, Switch, Tag } from "@douyinfe/semi-ui";
import { IconBranch, IconClose, IconExpand, IconMinus, IconPlus } from "@douyinfe/semi-icons";
import {
  Background, BaseEdge, Handle, MarkerType, Position, ReactFlow, ReactFlowProvider,
  getViewportForBounds, useReactFlow, useViewport, type Edge, type EdgeProps, type Node, type NodeProps,
  type OnNodesChange, type ReactFlowInstance,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { FINDING_SEVERITY_LABEL, STATUS_LABEL } from "../../labels";
import {
  buildDagLayout, CARD_SIZE, collectDag,
  type DagAsset, type DagFact, type DagFinding, type DagIntent, type DagRecord,
} from "./buildDagLayout";

type Props = {
  facts: DagFact[];
  intents: DagIntent[];
  findings?: DagFinding[];
  assets?: DagAsset[];
  height: number;
  loading?: boolean;
  focusId?: string;
};
type RecordNode = Node<DagRecord, "record">;
type RoutedEdge = Edge<{ path: string }, "routed">;

const KIND: Record<string, string> = { asset: "资产", fact: "事实", intent: "意图", finding: "漏洞" };
const EDGE_KIND: Record<string, string> = {
  "asserted-by": "资产凭据", anchors: "前驱事实", produces: "Explore 回写",
  evidences: "支撑发现", yields: "意图产出", escalates: "同证据推进",
};
const ABSTENTION_LABEL: Record<string, string> = {
  missing_shared_artifact: "缺少共享对象指纹", timestamp_inversion: "时间倒挂",
  ungrounded_reference: "引用缺失", missing_timestamp: "缺少时间戳",
};
const MIN_ZOOM = 0.01;
const MAX_ZOOM = 2;
const FIT = { padding: "20px" as const, minZoom: MIN_ZOOM, maxZoom: 1 };
const ARIA = { "node.a11yDescription.keyboardDisabled": "按回车或空格查看详情，按 Esc 关闭。" };

function nodeMetaLabel(data: DagRecord): string {
  if (!data.meta) return "";
  if (data.kind === "finding") {
    const [severity] = data.meta.split("/");
    return FINDING_SEVERITY_LABEL[severity] ?? data.meta;
  }
  return STATUS_LABEL[data.meta] ?? data.meta;
}

function RecordCard({ data, targetPosition, sourcePosition }: NodeProps<RecordNode>) {
  return (
    <div className={`gy-dag-node gy-dag-node-${data.kind}`} title={data.title}>
      <Handle type="target" position={targetPosition ?? Position.Left} />
      <span className="gy-dag-node-meta">
        <i aria-hidden="true" />{KIND[data.kind]}
        {data.meta && <span>{nodeMetaLabel(data)}</span>}
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

function edgeClass(link: { structural?: boolean; verification?: string; broken?: boolean }, active: boolean): string {
  const base = link.broken ? "gy-dag-edge-broken"
    : link.structural ? "gy-dag-edge-structural"
    : link.verification === "proposed" ? "gy-dag-edge-proposed"
    : "gy-dag-edge-proven";
  return `${base}${active ? " gy-dag-edge-active" : ""}`;
}

export default function FactIntentDag({ facts, intents, findings = [], assets = [], height, loading, focusId }: Props) {
  const section = useRef<HTMLElement>(null);
  const viewport = useRef<HTMLDivElement>(null);
  const flowId = useId().replace(/:/g, "");
  const [vertical, setVertical] = useState(false);
  const [showOrphans, setShowOrphans] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(focusId ?? null);
  const dag = useMemo(() => collectDag(facts, intents, findings, assets), [facts, intents, findings, assets]);
  const geometry = useMemo(
    () => buildDagLayout(dag, vertical, showOrphans),
    [dag.topologyKey, vertical, showOrphans],
  );
  const selected = selectedId ? dag.records.get(selectedId) : undefined;
  const incidentEdges = useMemo(
    () => selectedId ? dag.links.filter((l) => l.source === selectedId || l.target === selectedId) : [],
    [dag.links, selectedId],
  );

  useLayoutEffect(() => {
    const el = section.current!;
    const measure = () => setVertical(el.clientWidth < 560);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const nodes = useMemo<RecordNode[]>(() => geometry.positions.map(({ id, position }) => {
    const data = dag.records.get(id)!;
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
  }), [geometry, dag.records, selectedId, vertical, flowId]);

  const edges = useMemo<RoutedEdge[]>(() => geometry.edges.map((link) => {
    const active = selectedId === link.source || selectedId === link.target;
    return {
      id: link.id, source: link.source, target: link.target, type: "routed", data: { path: link.path },
      selectable: false, className: edgeClass(link, active),
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
    const focused = focusId && nodes.find((node) => node.id === focusId);
    if (focused) {
      void flow.setCenter(
        focused.position.x + CARD_SIZE.width / 2,
        focused.position.y + CARD_SIZE.height / 2,
        { zoom: 1 },
      );
      return;
    }
    const { clientWidth: width, clientHeight: viewHeight } = viewport.current!;
    const bounds = flow.getNodesBounds(nodes);
    const overview = getViewportForBounds(bounds, width, viewHeight, MIN_ZOOM, 1, FIT.padding);
    if (overview.zoom >= 0.65) {
      void flow.setViewport(overview);
      return;
    }
    const first = nodes.find((node) => node.data.kind === "asset") ?? nodes[0];
    if (!first) return;
    void flow.setViewport({
      zoom: 1,
      x: (vertical ? (width - CARD_SIZE.width) / 2 : 20) - first.position.x,
      y: (vertical ? 20 : (viewHeight - CARD_SIZE.height) / 2) - first.position.y,
    });
  };

  const closeDetails = () => {
    section.current?.querySelector<HTMLElement>(`[data-id="${CSS.escape(selectedId!)}"]`)?.focus();
    setSelectedId(null);
  };

  const orphanCount = dag.orphanIds.size;

  return (
    <section className="gy-dag" ref={section} aria-label="资产事实意图漏洞因果图">
      <ReactFlowProvider key={vertical ? "vertical" : "horizontal"}>
        <header className="gy-dag-toolbar">
          <div className="gy-dag-heading">
            <IconBranch />
            <h3>意图图谱</h3>
            {nodes.length > 0 && <span>{nodes.length} 个节点 · {edges.length} 条连线</span>}
          </div>
          <div className="gy-dag-toolbar-right">
            {orphanCount > 0 && (
              <label className="gy-dag-orphan-toggle">
                <Switch size="small" checked={showOrphans} onChange={setShowOrphans} aria-label="显示孤立节点" />
                <span>显示孤立节点（{orphanCount}）</span>
              </label>
            )}
            {nodes.length > 0 && <ZoomControls />}
          </div>
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
              <span><i />已验证因果</span>
              <span><i className="gy-dashed" />模型提议</span>
              <span><i className="gy-structural" />结构关联</span>
              <span className="gy-dag-hint">拖动画布 · 选择节点查看详情</span>
            </footer>
          </>
        ) : loading ? (
          <div className="gy-dag-empty" role="status"><Spin /> 正在加载关系图…</div>
        ) : (
          <Empty className="gy-dag-empty" title="暂无可绘制的节点" description="记录事实、意图或漏洞后，因果图会显示在这里。" />
        )}
      </ReactFlowProvider>
      {selected && (
        <section className="gy-dag-detail" id={`${flowId}-detail`} aria-label="节点详情" onKeyDown={(event) => {
          if (event.key === "Escape") closeDetails();
        }}>
          <div className="gy-dag-detail-heading">
            <div>
              <span>{KIND[selected.kind]}{selected.meta && ` · ${nodeMetaLabel(selected)}`}</span>
              <h4>{selected.title}</h4>
            </div>
            <Button icon={<IconClose />} theme="borderless" type="tertiary" aria-label="关闭节点详情" onClick={closeDetails} />
          </div>
          {selected.summary && <p>{selected.summary}</p>}
          <dl>
            <dt>节点 ID</dt><dd>{selectedId}</dd>
            {selected.sources && <><dt>前驱</dt><dd>{selected.sources.join("、")}</dd></>}
            {typeof selected.data?.asset === "string" && <><dt>资产</dt><dd>{selected.data.asset}</dd></>}
            {typeof selected.data?.vulnClass === "string" && <><dt>类别</dt><dd>{selected.data.vulnClass}</dd></>}
            {typeof selected.data?.technique === "string" && selected.data.technique && <><dt>手法</dt><dd>{selected.data.technique}</dd></>}
            {typeof selected.data?.assetRoot === "string" && selected.data.assetRoot && <><dt>资产根</dt><dd>{selected.data.assetRoot}</dd></>}
          </dl>
          {incidentEdges.length > 0 && (
            <div className="gy-dag-detail-edges">
              <strong>关联因果边</strong>
              <ul>
                {incidentEdges.map((link) => {
                  const outgoing = link.source === selectedId;
                  const other = outgoing ? link.target : link.source;
                  const otherTitle = dag.records.get(other)?.title ?? other;
                  return (
                    <li key={`${link.source}-${link.target}-${link.kind}`}>
                      <span className="gy-dag-edge-direction">{outgoing ? "→" : "←"}</span>
                      <span className="gy-dag-edge-other" title={other}>{otherTitle}</span>
                      <Tag size="small" color="grey">{EDGE_KIND[link.kind] ?? link.kind}</Tag>
                      {link.structural ? (
                        <Tag size="small" color="blue">结构</Tag>
                      ) : link.verification === "proven" ? (
                        <Tag size="small" color="green">已验证</Tag>
                      ) : (
                        <Tag size="small" color="orange">提议</Tag>
                      )}
                      {link.abstentionReason && (
                        <span className="gy-dag-abstention">
                          {ABSTENTION_LABEL[link.abstentionReason] ?? link.abstentionReason}
                        </span>
                      )}
                    </li>
                  );
                })}
              </ul>
            </div>
          )}
        </section>
      )}
    </section>
  );
}
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Button, Empty, SideSheet, Spin, Switch, Tag, Toast } from "@douyinfe/semi-ui";
import { IconBranch, IconExpand, IconMinus, IconPlus } from "@douyinfe/semi-icons";
import {
  Background, BackgroundVariant, BaseEdge, Handle, MarkerType, MiniMap, Position,
  ReactFlow, ReactFlowProvider, getViewportForBounds, useReactFlow, useViewport,
  type Edge, type EdgeProps, type Node, type NodeProps, type ReactFlowInstance,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import {
  ASSET_KIND_LABEL,
  FINDING_QUALIFICATION_LABEL,
  FINDING_SEVERITY_LABEL,
  FINDING_STATUS_LABEL,
  STATUS_LABEL,
  effectiveQualification,
  shortId,
} from "../../labels";
import { formatDateTime } from "../../time";
import {
  buildDagLayout, CARD_SIZE, collectDag,
  type DagAsset, type DagFact, type DagFinding, type DagIntent, type DagLink, type DagRecord, type ServerDagExport,
} from "./buildDagLayout";
import { toggleSelectedNode } from "../graphLayout";

type Props = {
  taskId?: string;
  facts: DagFact[];
  intents: DagIntent[];
  findings?: DagFinding[];
  assets?: DagAsset[];
  serverDag?: ServerDagExport | null;
  height: number;
  loading?: boolean;
  focusId?: string;
};

type VisualKind = "origin" | "asset" | "intent" | "fact" | "finding";
type RecordNodeData = DagRecord & { nodeId: string; dimmed?: boolean };
type RecordNode = Node<RecordNodeData, "record">;
type RoutedEdge = Edge<{ path: string }, "routed">;

type KindMeta = {
  label: string;
  hex: string;
  softBg: string;
  softText: string;
  icon: ReactNode;
};

const KIND_META: Record<VisualKind, KindMeta> = {
  origin: {
    label: "起点",
    hex: "#64748b",
    softBg: "rgba(100, 116, 139, 0.12)",
    softText: "#475569",
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.1" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z" />
        <line x1="4" y1="22" x2="4" y2="15" />
      </svg>
    ),
  },
  asset: {
    label: "资产",
    hex: "#10b981",
    softBg: "rgba(16, 185, 129, 0.12)",
    softText: "#047857",
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.1" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <circle cx="12" cy="12" r="9" />
        <circle cx="12" cy="12" r="5" />
        <circle cx="12" cy="12" r="1.5" fill="currentColor" />
      </svg>
    ),
  },
  intent: {
    label: "意图",
    hex: "#3b82f6",
    softBg: "rgba(59, 130, 246, 0.12)",
    softText: "#1d4ed8",
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.1" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <circle cx="12" cy="12" r="9" />
        <polygon points="15.8 8.2 13.7 13.7 8.2 15.8 10.3 10.3 15.8 8.2" />
      </svg>
    ),
  },
  fact: {
    label: "事实",
    hex: "#f59e0b",
    softBg: "rgba(245, 158, 11, 0.13)",
    softText: "#b45309",
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.1" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M10 2v6.3L5.1 17a2.5 2.5 0 0 0 2.2 3.8h9.4a2.5 2.5 0 0 0 2.2-3.8L14 8.3V2" />
        <path d="M8.5 2h7" />
        <path d="M7.5 14.5h9" />
      </svg>
    ),
  },
  finding: {
    label: "漏洞",
    hex: "#f43f5e",
    softBg: "rgba(244, 63, 94, 0.12)",
    softText: "#be123c",
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.1" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <rect x="8" y="6" width="8" height="14" rx="4" />
        <path d="m19 7-3 2" />
        <path d="m5 7 3 2" />
        <path d="m19 19-3-2" />
        <path d="m5 19 3-2" />
        <path d="M20 13h-4" />
        <path d="M4 13h4" />
        <path d="m10 4 1 2" />
        <path d="m14 4-1 2" />
      </svg>
    ),
  },
};

const FACT_LAYER_LABEL: Record<string, string> = {
  title: "标题层",
  summary: "摘要层",
  evidence: "证据层",
  origin: "起点",
};

const EDGE_KIND: Record<string, string> = {
  "asserted-by": "资产凭据",
  anchors: "前驱事实",
  produces: "Explore 回写",
  evidences: "支撑发现",
  yields: "意图产出",
  escalates: "同证据推进",
  affects: "所属资产",
};

const EDGE_COLOR: Record<string, string> = {
  "asserted-by": "#10b981",
  anchors: "#6366f1",
  produces: "#f59e0b",
  evidences: "#f43f5e",
  yields: "#ef4444",
  escalates: "#e11d48",
  affects: "#ef4444",
};

const ABSTENTION_LABEL: Record<string, string> = {
  missing_shared_artifact: "缺少共享对象指纹",
  timestamp_inversion: "时间倒挂",
  ungrounded_reference: "引用缺失",
  missing_timestamp: "缺少时间戳",
};

const MIN_ZOOM = 0.1;
const MAX_ZOOM = 2;
const FIT = { padding: 0.18, minZoom: MIN_ZOOM, maxZoom: 1 };
const MINIMAP_STYLE = { width: 204, height: 136 } as const;
const ARIA = { "node.a11yDescription.keyboardDisabled": "按回车或空格查看详情，按 Esc 关闭。" };

type StatusVisual = { label: string; dot: string; bg: string; fg: string };

function visualKind(data: DagRecord): VisualKind {
  if (data.kind === "fact" && (data.meta === "origin" || data.data?.synthetic === true)) return "origin";
  return data.kind;
}

function statusVisual(data: DagRecord): StatusVisual | null {
  const vk = visualKind(data);
  if (vk === "origin") {
    return { label: "任务起点", dot: "#64748b", bg: "rgba(100, 116, 139, 0.12)", fg: "#475569" };
  }
  if (!data.meta) return null;
  if (data.kind === "intent") {
    const label = STATUS_LABEL[data.meta] ?? data.meta;
    if (data.meta === "running" || data.meta === "claimed") {
      return { label, dot: "#3b82f6", bg: "rgba(59, 130, 246, 0.12)", fg: "#1d4ed8" };
    }
    if (data.meta === "succeeded" || data.meta === "completed") {
      return { label, dot: "#10b981", bg: "rgba(16, 185, 129, 0.12)", fg: "#047857" };
    }
    if (data.meta === "proposed" || data.meta === "pending") {
      return { label, dot: "#f59e0b", bg: "rgba(245, 158, 11, 0.14)", fg: "#b45309" };
    }
    if (data.meta === "expired" || data.meta === "budget_exhausted") {
      return { label, dot: "#8b5cf6", bg: "rgba(139, 92, 246, 0.13)", fg: "#6d28d9" };
    }
    if (data.meta === "failed") {
      return { label, dot: "#ef4444", bg: "rgba(239, 68, 68, 0.12)", fg: "#b91c1c" };
    }
    return { label, dot: "#64748b", bg: "rgba(100, 116, 139, 0.12)", fg: "#475569" };
  }
  if (data.kind === "finding") {
    const [severity = "", status = ""] = data.meta.split("/");
    const sevLabel = FINDING_SEVERITY_LABEL[severity] ?? severity;
    const stLabel = FINDING_STATUS_LABEL[status] ?? status;
    const label = stLabel ? `${sevLabel} · ${stLabel}` : sevLabel;
    if (severity === "critical" || severity === "high") {
      return { label, dot: "#f43f5e", bg: "rgba(244, 63, 94, 0.12)", fg: "#be123c" };
    }
    if (severity === "medium") {
      return { label, dot: "#f59e0b", bg: "rgba(245, 158, 11, 0.14)", fg: "#b45309" };
    }
    return { label, dot: "#3b82f6", bg: "rgba(59, 130, 246, 0.12)", fg: "#1d4ed8" };
  }
  if (data.kind === "asset") {
    const label = ASSET_KIND_LABEL[data.meta] ?? data.meta;
    if (data.meta === "oos") {
      return { label, dot: "#94a3b8", bg: "rgba(148, 163, 184, 0.15)", fg: "#64748b" };
    }
    return { label, dot: "#10b981", bg: "rgba(16, 185, 129, 0.12)", fg: "#047857" };
  }
  const label = FACT_LAYER_LABEL[data.meta] ?? STATUS_LABEL[data.meta] ?? data.meta;
  return { label, dot: "#f59e0b", bg: "rgba(245, 158, 11, 0.13)", fg: "#b45309" };
}

function StatusPill({ status }: { status: StatusVisual }) {
  return (
    <span className="gy-dag-status-pill" style={{ background: status.bg, color: status.fg }}>
      <i style={{ background: status.dot }} aria-hidden="true" />
      <span>{status.label}</span>
    </span>
  );
}

function minimapNodeColor(node: RecordNode): string {
  return KIND_META[visualKind(node.data)]?.hex ?? "#94a3b8";
}

function edgeStrokeColor(link: { kind: string; broken?: boolean }): string {
  if (link.broken) return "#dc2626";
  return EDGE_COLOR[link.kind] ?? "#64748b";
}

function compactNodeId(id: string): string {
  if (id === "origin") return "origin";
  if (id.startsWith("asset:")) return clipDisplay(id.slice("asset:".length), 14);
  return `#${shortId(id)}`;
}

function clipDisplay(text: string, max = 16): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function cardBodyText(data: DagRecord): string {
  const title = data.title?.trim() ?? "";
  const summary = data.summary?.trim() ?? "";
  if (!summary || summary === title) return title;
  if (title.length >= 24) return title;
  return `${title} — ${summary}`;
}

function cardAuxBadge(data: DagRecord): string | null {
  if (data.kind === "intent" && typeof data.data?.technique === "string" && data.data.technique) {
    return clipDisplay(data.data.technique, 12);
  }
  if (data.kind === "finding" && typeof data.data?.vulnClass === "string" && data.data.vulnClass) {
    return clipDisplay(data.data.vulnClass, 12);
  }
  if (data.kind === "fact" && data.data?.evidencePath) {
    return "含证据";
  }
  return null;
}

function RecordCard({ data, selected, targetPosition, sourcePosition }: NodeProps<RecordNode>) {
  const vk = visualKind(data);
  const meta = KIND_META[vk];
  const status = statusVisual(data);
  const isLive = data.kind === "intent" && data.meta === "running";
  const aux = cardAuxBadge(data);

  return (
    <div
      className={`gy-dag-card-shell${selected ? " is-selected" : ""}${isLive ? " is-live" : ""}${data.dimmed ? " is-dimmed" : ""}`}
      style={{ "--gy-kind-color": meta.hex } as React.CSSProperties}
      title={data.summary ? `${data.title}\n${data.summary}` : data.title}
    >
      <div className="gy-dag-node">
        <Handle type="target" position={targetPosition ?? Position.Left} />
        <div className="gy-dag-node-head">
          <span className="gy-dag-node-icon" style={{ background: meta.hex }}>
            {meta.icon}
          </span>
          <span className="gy-dag-node-kind">{meta.label}</span>
          {isLive && (
            <span className="gy-dag-live-dot" title="正在执行">
              <i />
              <b />
            </span>
          )}
          {aux && <span className="gy-dag-node-chip">{aux}</span>}
        </div>
        <div className="gy-dag-node-body">{cardBodyText(data) || meta.label}</div>
        <div className="gy-dag-node-foot">
          {status ? <StatusPill status={status} /> : <span className="gy-dag-node-muted">{meta.label}</span>}
          <span className="gy-dag-node-id">{compactNodeId(data.nodeId)}</span>
        </div>
        <Handle type="source" position={sourcePosition ?? Position.Right} />
      </div>
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
        onClick={() => void zoomOut({ duration: 160 })} />
      <Button className="gy-dag-percent" aria-label="恢复原始大小" title="恢复原始大小"
        onClick={() => void zoomTo(1, { duration: 160 })}>{Math.round(zoom * 100)}%</Button>
      <Button icon={<IconPlus />} aria-label="放大" title="放大" disabled={zoom >= MAX_ZOOM}
        onClick={() => void zoomIn({ duration: 160 })} />
      <Button icon={<IconExpand />} className="gy-dag-fit" onClick={() => void fitView({ ...FIT, duration: 200 })}>适应画布</Button>
    </div>
  );
}

function edgeClass(
  link: { kind: string; structural?: boolean; verification?: string; broken?: boolean },
  active: boolean,
  dimmed: boolean,
  liveTarget: boolean,
): string {
  const base = link.broken ? "gy-dag-edge-broken"
    : link.structural ? "gy-dag-edge-structural"
    : link.verification === "proposed" ? "gy-dag-edge-proposed"
    : "gy-dag-edge-proven";
  const semantic = `gy-dag-edge-kind-${link.kind}`;
  return `${base} ${semantic}${liveTarget ? " gy-dag-edge-live" : ""}${active ? " gy-dag-edge-active" : ""}${dimmed ? " gy-dag-edge-dimmed" : ""}`;
}

function DetailRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="gy-sheet-row">
      <span className="gy-sheet-label">{label}</span>
      <div className="gy-sheet-value">{children}</div>
    </div>
  );
}

function NodeDetailSheet({
  taskId,
  nodeId,
  record,
  records,
  incidentEdges,
  onSelectNode,
  onClose,
}: {
  taskId?: string;
  nodeId: string | null;
  record: DagRecord | undefined;
  records: Map<string, DagRecord>;
  incidentEdges: DagLink[];
  onSelectNode: (id: string) => void;
  onClose: () => void;
}) {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    setCopied(false);
  }, [nodeId]);

  const vk = record ? visualKind(record) : "intent";
  const meta = KIND_META[vk];
  const status = record ? statusVisual(record) : null;
  const rawPayload = useMemo(() => {
    if (!record || !nodeId) return "";
    const obj = record.raw ?? {
      id: nodeId,
      kind: record.kind,
      title: record.title,
      ...(record.meta ? { state: record.meta } : {}),
      ...(record.summary ? { summary: record.summary } : {}),
      ...(record.sources ? { sources: record.sources } : {}),
      ...(record.data ?? {}),
    };
    return JSON.stringify(obj, null, 2);
  }, [record, nodeId]);

  const copyRaw = () => {
    if (!rawPayload) return;
    void navigator.clipboard?.writeText(rawPayload).then(
      () => {
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1500);
      },
      () => Toast.error("复制失败"),
    );
  };

  const producedByIntentId = typeof record?.data?.intentId === "string" && record.data.intentId
    ? record.data.intentId
    : null;
  const tags = Array.isArray(record?.data?.tags)
    ? (record!.data!.tags as unknown[]).filter((t): t is string => typeof t === "string" && Boolean(t))
    : [];
  const findingQual = record?.kind === "finding"
    ? effectiveQualification({
        qualification: typeof record.data?.qualification === "string" ? record.data.qualification : null,
        status: typeof record.data?.status === "string" ? record.data.status : undefined,
      })
    : null;

  return (
    <SideSheet
      visible={Boolean(record && nodeId)}
      placement="right"
      width="min(460px, 92vw)"
      mask={false}
      disableScroll={false}
      closeOnEsc
      onCancel={onClose}
      aria-label="节点详情"
      className="gy-node-sheet"
      headerStyle={{ padding: "14px 18px", borderBottom: "1px solid var(--semi-color-border)" }}
      bodyStyle={{ padding: "16px 18px 24px", overflowY: "auto" }}
      title={
        record && nodeId ? (
          <div className="gy-sheet-header">
            <span className="gy-sheet-header-icon" style={{ background: meta.hex }}>
              {meta.icon}
            </span>
            <div className="gy-sheet-header-titles">
              <strong>{meta.label}</strong>
              <code>{nodeId}</code>
            </div>
          </div>
        ) : "节点详情"
      }
    >
      {record && nodeId && (
        <div className="gy-sheet-content">
          <section className="gy-sheet-section">
            <h4>属性</h4>
            <DetailRow label="类型">{meta.label}</DetailRow>
            {status && (
              <DetailRow label="状态">
                <StatusPill status={status} />
              </DetailRow>
            )}
            <DetailRow label="标题">
              <strong className="gy-sheet-title-text">{record.title}</strong>
            </DetailRow>

            {record.kind === "intent" && (
              <>
                <DetailRow label="来源">
                  <code>{typeof record.data?.claimedBy === "string" && record.data.claimedBy ? `worker (${record.data.claimedBy})` : "planner"}</code>
                </DetailRow>
                {typeof record.data?.technique === "string" && record.data.technique && (
                  <DetailRow label="手法"><code>{record.data.technique}</code></DetailRow>
                )}
                {typeof record.data?.assetRoot === "string" && record.data.assetRoot && (
                  <DetailRow label="资产根"><code>{record.data.assetRoot}</code></DetailRow>
                )}
                {record.createdAt && (
                  <DetailRow label="时间">{formatDateTime(record.createdAt, true)}</DetailRow>
                )}
                {record.concludedAt && (
                  <DetailRow label="收卷">{formatDateTime(record.concludedAt, true)}</DetailRow>
                )}
                {!record.concludedAt && record.updatedAt && record.updatedAt !== record.createdAt && (
                  <DetailRow label="更新">{formatDateTime(record.updatedAt, true)}</DetailRow>
                )}
              </>
            )}

            {record.kind === "fact" && vk !== "origin" && (
              <>
                {record.meta && (
                  <DetailRow label="层级">{FACT_LAYER_LABEL[record.meta] ?? record.meta}</DetailRow>
                )}
                {producedByIntentId && (
                  <DetailRow label="来源">
                    {records.has(producedByIntentId) ? (
                      <button type="button" className="gy-sheet-inline-link" onClick={() => onSelectNode(producedByIntentId)}>
                        意图 #{shortId(producedByIntentId)}
                      </button>
                    ) : (
                      <code>{producedByIntentId}</code>
                    )}
                  </DetailRow>
                )}
                {typeof record.data?.evidencePath === "string" && record.data.evidencePath && (
                  <DetailRow label="证据"><code>{record.data.evidencePath}</code></DetailRow>
                )}
                {tags.length > 0 && (
                  <DetailRow label="标签">
                    <div className="gy-sheet-tags">
                      {tags.map((tag) => <span key={tag} className="gy-sheet-tag">{tag}</span>)}
                    </div>
                  </DetailRow>
                )}
                {record.createdAt && (
                  <DetailRow label="时间">{formatDateTime(record.createdAt, true)}</DetailRow>
                )}
              </>
            )}

            {record.kind === "finding" && (
              <>
                {findingQual && (
                  <DetailRow label="定级">{FINDING_QUALIFICATION_LABEL[findingQual]}</DetailRow>
                )}
                {typeof record.data?.asset === "string" && record.data.asset && (
                  <DetailRow label="资产"><code>{record.data.asset}</code></DetailRow>
                )}
                {typeof record.data?.endpoint === "string" && record.data.endpoint && (
                  <DetailRow label="端点"><code>{record.data.endpoint}</code></DetailRow>
                )}
                {typeof record.data?.vulnClass === "string" && record.data.vulnClass && (
                  <DetailRow label="类别"><code>{record.data.vulnClass}</code></DetailRow>
                )}
                {typeof record.data?.cvss === "string" && record.data.cvss && (
                  <DetailRow label="CVSS"><code>{record.data.cvss}</code></DetailRow>
                )}
                {typeof record.data?.verifiedBy === "string" && record.data.verifiedBy && (
                  <DetailRow label="验证者"><code>{record.data.verifiedBy}</code></DetailRow>
                )}
                {record.createdAt && (
                  <DetailRow label="时间">{formatDateTime(record.createdAt, true)}</DetailRow>
                )}
                {typeof record.data?.verifiedAt === "string" && record.data.verifiedAt && (
                  <DetailRow label="复现">{formatDateTime(record.data.verifiedAt, true)}</DetailRow>
                )}
                {taskId && (
                  <div className="gy-sheet-jump">
                    <Button
                      size="small"
                      theme="light"
                      type="primary"
                      onClick={() => {
                        location.hash = `#/findings/${encodeURIComponent(taskId)}?finding=${encodeURIComponent(nodeId)}`;
                      }}
                    >
                      查看完整漏洞报告与证据
                    </Button>
                  </div>
                )}
              </>
            )}

            {record.kind === "asset" && (
              <>
                {typeof record.data?.source === "string" && record.data.source && (
                  <DetailRow label="来源"><code>{record.data.source}</code></DetailRow>
                )}
                {typeof record.data?.assetType === "string" && record.data.assetType && (
                  <DetailRow label="分类"><code>{record.data.assetType}</code></DetailRow>
                )}
                {typeof record.data?.weight === "number" && (
                  <DetailRow label="权重">{record.data.weight}</DetailRow>
                )}
                {record.createdAt && (
                  <DetailRow label="时间">{formatDateTime(record.createdAt, true)}</DetailRow>
                )}
                {taskId && typeof record.data?.address === "string" && (
                  <div className="gy-sheet-jump">
                    <Button
                      size="small"
                      theme="light"
                      type="primary"
                      onClick={() => {
                        location.hash = `#/assets/${encodeURIComponent(taskId)}?asset=${encodeURIComponent(String(record.data?.address))}`;
                      }}
                    >
                      前往资产与战场查看详情
                    </Button>
                  </div>
                )}
              </>
            )}
          </section>

          {(record.summary || record.conclusion) && (
            <section className="gy-sheet-section">
              <h4>详细说明</h4>
              {record.summary && <p className="gy-sheet-prose">{record.summary}</p>}
              {record.conclusion && (
                <div className="gy-sheet-conclusion">
                  <strong>执行结论</strong>
                  <p className="gy-sheet-prose">{record.conclusion}</p>
                </div>
              )}
            </section>
          )}

          {incidentEdges.length > 0 && (
            <section className="gy-sheet-section">
              <h4>关联因果链路（{incidentEdges.length}）</h4>
              <div className="gy-sheet-neighbors">
                {incidentEdges.map((link) => {
                  const outgoing = link.source === nodeId;
                  const peerId = outgoing ? link.target : link.source;
                  const peer = records.get(peerId);
                  const peerVk = peer ? visualKind(peer) : "fact";
                  const peerMeta = KIND_META[peerVk];
                  return (
                    <button
                      key={`${link.source}-${link.target}-${link.kind}`}
                      type="button"
                      className="gy-sheet-neighbor-btn"
                      onClick={() => onSelectNode(peerId)}
                    >
                      <span className="gy-sheet-neighbor-icon" style={{ background: peerMeta.hex }}>
                        {peerMeta.icon}
                      </span>
                      <span className="gy-sheet-neighbor-main">
                        <span className="gy-sheet-neighbor-title">
                          {outgoing ? "→ " : "← "}
                          {peer?.title ?? peerId}
                        </span>
                        <span className="gy-sheet-neighbor-meta">
                          {peerMeta.label} · {compactNodeId(peerId)} · {EDGE_KIND[link.kind] ?? link.kind}
                        </span>
                      </span>
                      {link.structural ? (
                        <Tag size="small" color="blue">结构</Tag>
                      ) : link.verification === "proven" ? (
                        <Tag size="small" color="green">已验证</Tag>
                      ) : (
                        <span title={link.abstentionReason ? (ABSTENTION_LABEL[link.abstentionReason] ?? link.abstentionReason) : undefined}>
                          <Tag size="small" color="orange">提议</Tag>
                        </span>
                      )}
                    </button>
                  );
                })}
              </div>
            </section>
          )}

          <section className="gy-sheet-section">
            <div className="gy-sheet-section-head">
              <h4>原始数据</h4>
              <button type="button" className="gy-sheet-copy-btn" onClick={copyRaw}>
                {copied ? "已复制" : "复制"}
              </button>
            </div>
            <pre className="gy-sheet-raw">{rawPayload}</pre>
          </section>
        </div>
      )}
    </SideSheet>
  );
}

export default function FactIntentDag({
  taskId,
  facts,
  intents,
  findings = [],
  assets = [],
  serverDag,
  height,
  loading,
  focusId,
}: Props) {
  const section = useRef<HTMLElement>(null);
  const viewport = useRef<HTMLDivElement>(null);
  const flowId = useId().replace(/:/g, "");
  const [vertical, setVertical] = useState(false);
  const [showOrphans, setShowOrphans] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(focusId ?? null);

  useEffect(() => {
    if (focusId) setSelectedId(focusId);
  }, [focusId]);

  const dag = useMemo(
    () => collectDag(facts, intents, findings, assets, serverDag),
    [facts, intents, findings, assets, serverDag],
  );
  const geometry = useMemo(
    () => buildDagLayout(dag, vertical, showOrphans),
    [dag.topologyKey, vertical, showOrphans],
  );
  const flowRef = useRef<ReactFlowInstance<RecordNode, RoutedEdge> | null>(null);
  const selected = selectedId ? dag.records.get(selectedId) : undefined;
  const positionById = useMemo(
    () => new Map(geometry.positions.map((item) => [item.id, item.position])),
    [geometry.positions],
  );

  const incidentEdges = useMemo(
    () => (selectedId ? dag.links.filter((l) => l.source === selectedId || l.target === selectedId) : []),
    [dag.links, selectedId],
  );
  const relatedNodeIds = useMemo(() => {
    if (!selectedId) return null;
    const set = new Set<string>([selectedId]);
    for (const l of incidentEdges) {
      set.add(l.source);
      set.add(l.target);
    }
    return set;
  }, [selectedId, incidentEdges]);

  const liveIntentIds = useMemo(() => {
    const set = new Set<string>();
    for (const [id, rec] of dag.records.entries()) {
      if (rec.kind === "intent" && rec.meta === "running") set.add(id);
    }
    return set;
  }, [dag.records]);

  useLayoutEffect(() => {
    const el = section.current!;
    const measure = () => setVertical(el.clientWidth < 560);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const nodes = useMemo<RecordNode[]>(() => geometry.positions.map(({ id, position }) => {
    const record = dag.records.get(id)!;
    const dimmed = relatedNodeIds ? !relatedNodeIds.has(id) : false;
    const data: RecordNodeData = { ...record, nodeId: id, ...(dimmed ? { dimmed: true } : {}) };
    const vk = visualKind(record);
    return {
      id,
      position,
      data,
      ...CARD_SIZE,
      type: "record",
      selected: id === selectedId,
      sourcePosition: vertical ? Position.Bottom : Position.Right,
      targetPosition: vertical ? Position.Top : Position.Left,
      ariaRole: "button",
      ariaLabel: `${KIND_META[vk].label}，${record.title}`,
      domAttributes: {
        "aria-pressed": id === selectedId,
      },
    };
  }), [geometry, dag.records, selectedId, relatedNodeIds, vertical]);

  const edges = useMemo<RoutedEdge[]>(() => geometry.edges.map((link) => {
    const active = selectedId === link.source || selectedId === link.target;
    const dimmed = Boolean(selectedId) && !active;
    const liveTarget = liveIntentIds.has(link.target) || liveIntentIds.has(link.source);
    const stroke = edgeStrokeColor(link);
    return {
      id: link.id,
      source: link.source,
      target: link.target,
      type: "routed",
      data: { path: link.path },
      animated: liveTarget && !link.broken,
      selectable: false,
      className: edgeClass(link, active, dimmed, liveTarget),
      zIndex: active ? 10 : liveTarget ? 5 : 0,
      markerEnd: { type: MarkerType.ArrowClosed, color: stroke, width: 14, height: 14 },
    };
  }), [geometry, selectedId, liveIntentIds]);

  const selectAndFocusNode = (targetId: string) => {
    if (!positionById.has(targetId) && dag.orphanIds.has(targetId)) {
      setShowOrphans(true);
    }
    setSelectedId(targetId);
    const pos = positionById.get(targetId);
    const flow = flowRef.current;
    if (pos && flow) {
      void flow.setCenter(
        pos.x + CARD_SIZE.width / 2,
        pos.y + CARD_SIZE.height / 2,
        { zoom: Math.max(flow.getZoom(), 0.78), duration: 240 },
      );
    }
  };

  const openCanvas = (flow: ReactFlowInstance<RecordNode, RoutedEdge>) => {
    flowRef.current = flow;
    const focused = focusId && nodes.find((node) => node.id === focusId);
    if (focused) {
      void flow.setCenter(
        focused.position.x + CARD_SIZE.width / 2,
        focused.position.y + CARD_SIZE.height / 2,
        { zoom: 0.92 },
      );
      return;
    }
    const { clientWidth: width, clientHeight: viewHeight } = viewport.current!;
    const bounds = flow.getNodesBounds(nodes);
    const overview = getViewportForBounds(bounds, width, viewHeight, MIN_ZOOM, 1, FIT.padding);
    if (overview.zoom >= 0.34) {
      void flow.setViewport({
        x: Math.round(overview.x),
        y: Math.round(overview.y),
        zoom: overview.zoom,
      });
      return;
    }
    const first = nodes.find((node) => visualKind(node.data) === "origin" || node.data.kind === "asset") ?? nodes[0];
    if (!first) return;
    const readableZoom = 0.72;
    void flow.setViewport({
      zoom: readableZoom,
      x: Math.round((vertical ? (width - CARD_SIZE.width * readableZoom) / 2 : 36) - first.position.x * readableZoom),
      y: Math.round((vertical ? 36 : (viewHeight - CARD_SIZE.height * readableZoom) / 2) - first.position.y * readableZoom),
    });
  };

  const closeDetails = () => {
    if (selectedId) {
      section.current?.querySelector<HTMLElement>(`[data-id="${CSS.escape(selectedId)}"]`)?.focus({ preventScroll: true });
    }
    setSelectedId(null);
  };

  const orphanCount = dag.orphanIds.size;

  return (
    <section
      className="gy-dag"
      ref={section}
      aria-label="资产事实意图漏洞因果图"
      onKeyDown={(event) => {
        if (event.key === "Escape" && selectedId) {
          closeDetails();
          return;
        }
        if ((event.key === "Enter" || event.key === " ") && event.target instanceof HTMLElement) {
          const host = event.target.closest<HTMLElement>(".react-flow__node[data-id]");
          const id = host?.dataset.id;
          if (id) {
            event.preventDefault();
            setSelectedId((cur) => (cur === id ? null : id));
          }
        }
      }}
    >
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
                id={flowId}
                nodes={nodes}
                edges={edges}
                nodeTypes={nodeTypes}
                edgeTypes={edgeTypes}
                onInit={openCanvas}
                onNodeClick={(_, node) => setSelectedId((cur) => toggleSelectedNode(cur, node.id))}
                onPaneClick={() => setSelectedId(null)}
                minZoom={MIN_ZOOM}
                maxZoom={MAX_ZOOM}
                nodesDraggable={false}
                nodesConnectable={false}
                elementsSelectable={false}
                edgesReconnectable={false}
                edgesFocusable={false}
                deleteKeyCode={null}
                multiSelectionKeyCode={null}
                selectionKeyCode={null}
                onlyRenderVisibleElements
                proOptions={{ hideAttribution: true }}
                ariaLabelConfig={ARIA}
              >
                <Background variant={BackgroundVariant.Dots} gap={16} size={1.2} color="#cbd5e1" />
                <MiniMap<RecordNode>
                  position="bottom-right"
                  className="gy-dag-minimap"
                  style={MINIMAP_STYLE}
                  ariaLabel="意图图谱缩略图"
                  pannable
                  zoomable
                  offsetScale={1.4}
                  nodeColor={minimapNodeColor}
                  nodeStrokeColor={(node) => (node.selected ? "#1d4ed8" : "#ffffff")}
                  nodeStrokeWidth={1.5}
                  nodeBorderRadius={6}
                  maskColor="rgba(148, 163, 184, 0.16)"
                  maskStrokeColor="#3b82f6"
                  maskStrokeWidth={1.8}
                  onNodeClick={(_, node) => selectAndFocusNode(node.id)}
                />
              </ReactFlow>
            </div>
            <footer className="gy-dag-legend" aria-label="图例与操作说明">
              <div className="gy-dag-legend-items">
                <div className="gy-dag-legend-group">
                  {(["origin", "asset", "intent", "fact", "finding"] as VisualKind[]).map((k) => {
                    const m = KIND_META[k];
                    return (
                      <span key={k} className="gy-dag-legend-node">
                        <span className="gy-dag-panel-icon" style={{ background: m.hex }}>{m.icon}</span>
                        {m.label}
                      </span>
                    );
                  })}
                </div>
                <span className="gy-dag-legend-sep" aria-hidden="true" />
                <div className="gy-dag-legend-group is-edges">
                  <span><i style={{ background: "#10b981" }} />资产凭据</span>
                  <span><i style={{ background: "#6366f1" }} />前驱事实</span>
                  <span><i style={{ background: "#f59e0b" }} />Explore 回写</span>
                  <span><i style={{ background: "#f43f5e" }} />产出 / 发现</span>
                  <span><i className="is-dashed" />模型提议</span>
                </div>
              </div>
              <span className="gy-dag-legend-hint">滚轮缩放 · 点击节点查看详情</span>
            </footer>
          </>
        ) : loading ? (
          <div className="gy-dag-empty" role="status"><Spin /> 正在加载关系图…</div>
        ) : (
          <Empty className="gy-dag-empty" title="暂无可绘制的节点" description="记录事实、意图或漏洞后，因果图会显示在这里。" />
        )}
      </ReactFlowProvider>
      <NodeDetailSheet
        taskId={taskId}
        nodeId={selected ? selectedId : null}
        record={selected}
        records={dag.records}
        incidentEdges={incidentEdges}
        onSelectNode={selectAndFocusNode}
        onClose={closeDetails}
      />
    </section>
  );
}

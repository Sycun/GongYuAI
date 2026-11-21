import { useMemo, useState } from "react";
import { Empty, Space, Tag, Typography } from "@douyinfe/semi-ui";
import { STATUS_LABEL } from "../../labels";
import {
  DAG_NODE_SIZE,
  buildDagLayout,
  type DagFact,
  type DagIntent,
  type DagNode,
} from "./buildDagLayout";

type Props = {
  facts: DagFact[];
  intents: DagIntent[];
  height?: number;
};

function edgePath(
  from: DagNode,
  to: DagNode,
  nw: number,
  nh: number,
): string {
  const x1 = from.x + nw;
  const y1 = from.y + nh / 2;
  const x2 = to.x;
  const y2 = to.y + nh / 2;
  const mx = (x1 + x2) / 2;
  return `M ${x1} ${y1} C ${mx} ${y1}, ${mx} ${y2}, ${x2} ${y2}`;
}

function kindLabel(kind: DagNode["kind"]): string {
  if (kind === "origin") return "Origin";
  if (kind === "intent") return "Intent";
  return "Fact";
}

export function FactIntentDag({ facts, intents, height = 360 }: Props) {
  const layout = useMemo(() => buildDagLayout(facts, intents), [facts, intents]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selected = layout.nodes.find((n) => n.id === selectedId) ?? null;
  const { w: nw, h: nh } = DAG_NODE_SIZE;

  if (!layout.nodes.length) {
    return (
      <Empty
        title="图尚空"
        description="尚无 Fact / Intent。Worker 写入 History 后会出现 Fact→Intent→Fact 路径。"
        style={{ padding: 32 }}
      />
    );
  }

  const detailFact = selected?.kind === "fact" ? facts.find((f) => f.id === selected.id) : null;
  const detailIntent =
    selected?.kind === "intent" ? intents.find((i) => i.id === selected.id) : null;

  return (
    <div className="gy-dag">
      <div className="gy-dag-legend">
        <Space spacing={12}>
          <span className="gy-dag-legend-item">
            <i className="gy-dag-swatch gy-dag-swatch-origin" /> Origin
          </span>
          <span className="gy-dag-legend-item">
            <i className="gy-dag-swatch gy-dag-swatch-fact" /> Fact
          </span>
          <span className="gy-dag-legend-item">
            <i className="gy-dag-swatch gy-dag-swatch-intent" /> Intent
          </span>
          <Typography.Text type="quaternary" size="small">
            实线触发 · 虚线产出
          </Typography.Text>
        </Space>
      </div>

      <div className="gy-dag-viewport" style={{ height }}>
        <svg
          className="gy-dag-svg"
          width={Math.max(layout.width, 480)}
          height={Math.max(layout.height, height - 8)}
          role="img"
          aria-label="Fact Intent DAG"
        >
          <defs>
            <marker
              id="gy-dag-arrow"
              viewBox="0 0 10 10"
              refX="9"
              refY="5"
              markerWidth="7"
              markerHeight="7"
              orient="auto-start-reverse"
            >
              <path d="M 0 0 L 10 5 L 0 10 z" fill="var(--semi-color-text-3)" />
            </marker>
          </defs>

          {layout.edges.map((e) => {
            const from = layout.nodes.find((n) => n.id === e.from);
            const to = layout.nodes.find((n) => n.id === e.to);
            if (!from || !to) return null;
            const active =
              selectedId && (e.from === selectedId || e.to === selectedId);
            return (
              <path
                key={e.id}
                d={edgePath(from, to, nw, nh)}
                className={
                  e.kind === "produce" ? "gy-dag-edge gy-dag-edge-produce" : "gy-dag-edge"
                }
                data-active={active ? "1" : undefined}
                markerEnd="url(#gy-dag-arrow)"
              />
            );
          })}

          {layout.nodes.map((n) => {
            const active = selectedId === n.id;
            return (
              <g
                key={n.id}
                className={`gy-dag-node gy-dag-node-${n.kind}`}
                data-active={active ? "1" : undefined}
                transform={`translate(${n.x}, ${n.y})`}
                onClick={() => setSelectedId(active ? null : n.id)}
                style={{ cursor: "pointer" }}
              >
                <rect width={nw} height={nh} rx={8} ry={8} />
                <text className="gy-dag-node-kind" x={12} y={18}>
                  {kindLabel(n.kind)}
                  {n.sub ? ` · ${STATUS_LABEL[n.sub] ?? n.sub}` : ""}
                </text>
                <text className="gy-dag-node-label" x={12} y={38}>
                  {n.label}
                </text>
              </g>
            );
          })}
        </svg>
      </div>

      {selected ? (
        <div className="gy-dag-detail">
          <Space align="center" spacing={8}>
            <Tag size="small" color={selected.kind === "intent" ? "orange" : "blue"}>
              {kindLabel(selected.kind)}
            </Tag>
            <Typography.Text strong>{selected.label}</Typography.Text>
            <Typography.Text type="quaternary" size="small" className="gy-mono">
              {selected.id === "origin" ? "origin" : selected.id.slice(0, 8)}
            </Typography.Text>
          </Space>
          {detailFact?.summary ? (
            <Typography.Paragraph type="tertiary" style={{ margin: "6px 0 0" }}>
              {detailFact.summary}
            </Typography.Paragraph>
          ) : null}
          {detailIntent?.summary ? (
            <Typography.Paragraph type="tertiary" style={{ margin: "6px 0 0" }}>
              {detailIntent.summary}
            </Typography.Paragraph>
          ) : null}
          {detailIntent?.sourceFactIds?.length ? (
            <Typography.Text type="quaternary" size="small" style={{ display: "block", marginTop: 4 }}>
              前驱：{detailIntent.sourceFactIds.map((id) => (id === "origin" ? "origin" : id.slice(0, 8))).join(", ")}
            </Typography.Text>
          ) : null}
        </div>
      ) : (
        <Typography.Text type="quaternary" size="small" style={{ display: "block", marginTop: 8 }}>
          点击节点查看详情
        </Typography.Text>
      )}
    </div>
  );
}

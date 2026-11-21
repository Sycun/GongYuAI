import { useEffect, useMemo, useState } from "react";
import { Collapsible, Empty, Space, Tag, Timeline, Typography } from "@douyinfe/semi-ui";
import { IconChevronDown, IconChevronRight } from "@douyinfe/semi-icons";
import { STATUS_LABEL } from "../labels";
import { formatDateTime, parseTime } from "../time";

export type TraceFact = {
  title: string;
  summary: string;
  layer: string;
  createdAt: string;
};

export type ExecutionTraceProps = {
  progress?: string[];
  facts?: TraceFact[];
  active?: boolean;
  emptyHint?: string;
  /** 切换任务时重置展开态 */
  resetKey?: string;
};

type Detail = {
  title: string;
  summary: string;
  layer?: string;
};

type TraceNode = {
  id: string;
  at: string;
  label: string;
  tools: string[];
  stepNum?: number;
  tokens?: number;
  details: Detail[];
  kind: "step" | "event";
  timelineType: "default" | "ongoing" | "success" | "warning" | "error";
};

/** `2026-11-21 16:27 第 10 步 · 工具 shell · Token 66626`（旧行仍可能是 ISO Z） */
function parseProgressLine(line: string): {
  at: string;
  body: string;
  stepNum?: number;
  tools: string[];
  tokens?: number;
} {
  const m = line.match(
    /^(\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z)?)?)\s+(.*)$/,
  );
  const at = m?.[1] ?? "";
  const body = m?.[2] ?? line;
  const stepM = body.match(/第\s*(\d+)\s*步/);
  const toolM = body.match(/工具\s+([^·]+)/);
  const tokenM = body.match(/Token\s+(\d+)/i);
  const tools = toolM
    ? toolM[1]
        .split(/[、,，/\s]+/)
        .map((t) => t.trim())
        .filter(Boolean)
        .filter((t) => t !== "无")
    : [];
  return {
    at,
    body,
    stepNum: stepM ? Number(stepM[1]) : undefined,
    tools,
    tokens: tokenM ? Number(tokenM[1]) : undefined,
  };
}

function buildTrace(progress: string[], facts: TraceFact[], active: boolean): TraceNode[] {
  const progressChrono = [...progress];
  const factChrono = [...facts].sort((a, b) => parseTime(a.createdAt) - parseTime(b.createdAt));

  const nodes: TraceNode[] = progressChrono.map((line, idx) => {
    const p = parseProgressLine(line);
    const isLast = idx === progressChrono.length - 1;
    let timelineType: TraceNode["timelineType"] = "default";
    if (p.stepNum != null) timelineType = "success";
    if (/失败|错误|error/i.test(p.body)) timelineType = "error";
    if (/重试|警告|warning/i.test(p.body)) timelineType = "warning";
    if (isLast && active) timelineType = "ongoing";

    const label =
      p.stepNum != null
        ? `第 ${p.stepNum} 步`
        : p.body.replace(/\s*·\s*工具.*$/, "").replace(/\s*·\s*Token.*$/i, "").trim() ||
          p.body;

    return {
      id: `p-${idx}-${p.at || idx}`,
      at: p.at,
      label,
      tools: p.tools,
      stepNum: p.stepNum,
      tokens: p.tokens,
      details: [],
      kind: p.stepNum != null ? ("step" as const) : ("event" as const),
      timelineType,
    };
  });

  // 按时间窗把事实挂到对应进度节点：落在 (prev.at, curr.at] 内
  const times = nodes.map((n) => parseTime(n.at));
  const used = new Set<number>();
  for (let fi = 0; fi < factChrono.length; fi++) {
    const f = factChrono[fi];
    const ft = parseTime(f.createdAt);
    let assigned = -1;
    for (let i = 0; i < nodes.length; i++) {
      const start = i === 0 ? 0 : times[i - 1];
      const end = times[i] || Number.POSITIVE_INFINITY;
      if (ft > start && ft <= end + 1500) {
        assigned = i;
        break;
      }
    }
    if (assigned < 0) {
      // 回退：挂到时间最近的步骤
      let best = -1;
      let bestDist = Number.POSITIVE_INFINITY;
      for (let i = 0; i < nodes.length; i++) {
        const dist = Math.abs(times[i] - ft);
        if (dist < bestDist) {
          bestDist = dist;
          best = i;
        }
      }
      if (best >= 0 && bestDist < 60_000) assigned = best;
    }
    if (assigned >= 0) {
      nodes[assigned].details.push({
        title: f.title,
        summary: f.summary,
        layer: f.layer,
      });
      used.add(fi);
    }
  }

  const orphanNodes: TraceNode[] = factChrono
    .filter((_, i) => !used.has(i))
    .map((f, i) => ({
      id: `f-${i}-${f.createdAt}`,
      at: f.createdAt,
      label: f.title,
      tools: [] as string[],
      details: [{ title: f.title, summary: f.summary, layer: f.layer }],
      kind: "event" as const,
      timelineType: "default" as const,
    }));

  // Progress nodes win ties so "当前" stays on the live step, not a same-second Fact.
  return [...nodes, ...orphanNodes].sort((a, b) => {
    const dt = parseTime(a.at) - parseTime(b.at);
    if (dt !== 0) return dt;
    if (a.kind === b.kind) return 0;
    return a.id.startsWith("p-") ? -1 : 1;
  });
}

function ToolChain({ tools }: { tools: string[] }) {
  if (!tools.length) return null;
  return (
    <div className="gy-tool-chain" aria-label="工具链路">
      {tools.map((t, i) => (
        <span key={`${t}-${i}`} className="gy-tool-chain-item">
          {i > 0 ? <span className="gy-tool-chain-arrow">→</span> : null}
          <Tag size="small" color="cyan">
            {t}
          </Tag>
        </span>
      ))}
    </div>
  );
}

export function ExecutionTrace({
  progress = [],
  facts = [],
  active = false,
  emptyHint = "暂无执行步骤",
  resetKey,
}: ExecutionTraceProps) {
  const nodes = useMemo(
    () => buildTrace(progress, facts, active),
    [progress, facts, active],
  );

  const toolSequence = useMemo(() => {
    const seq: string[] = [];
    for (const n of nodes) {
      for (const t of n.tools) {
        if (seq[seq.length - 1] !== t) seq.push(t);
      }
    }
    return seq.slice(-24);
  }, [nodes]);

  /** 运行中「当前」优先落在 PROGRESS 节点；孤儿 Fact 只作挂靠，不抢跟跑焦点 */
  const currentId = useMemo(() => {
    if (!nodes.length) return null;
    if (!active) return nodes[nodes.length - 1]?.id ?? null;
    const fromProgress = [...nodes].reverse().find((n) => n.id.startsWith("p-"));
    return (fromProgress ?? nodes[nodes.length - 1]).id;
  }, [nodes, active]);

  const seedOpen = useMemo(() => {
    const keys = new Set<string>();
    if (!nodes.length) return keys;
    if (currentId) keys.add(currentId);
    const withDetail = [...nodes].reverse().find((n) => n.details.length > 0);
    if (withDetail) keys.add(withDetail.id);
    return keys;
  }, [nodes, currentId]);

  const [open, setOpen] = useState<Set<string>>(() => new Set());
  const [seededFor, setSeededFor] = useState<string | undefined>(undefined);

  useEffect(() => {
    // 任务切换或首次：用种子展开；轮询更新时若用户已操作则保留
    const stamp = resetKey ?? "__default__";
    if (seededFor !== stamp) {
      setOpen(new Set(seedOpen));
      setSeededFor(stamp);
      return;
    }
    // 同任务新出现的当前节点：自动展开，便于跟跑
    setOpen((prev) => {
      if (!currentId || !active) return prev;
      if (prev.has(currentId)) return prev;
      const next = new Set(prev);
      next.add(currentId);
      return next;
    });
  }, [resetKey, seededFor, seedOpen, currentId, active]);

  const toggle = (id: string) => {
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  if (!nodes.length) {
    return <Empty description={emptyHint} style={{ padding: "24px 0" }} />;
  }

  return (
    <div className="gy-exec-trace">
      <div className="gy-exec-trace-meta">
        <Typography.Text type="tertiary" size="small">
          共 {nodes.length} 个节点 · 按时间串联，点击步骤展开详情
        </Typography.Text>
        <ToolChain tools={toolSequence} />
      </div>

      <Timeline mode="left" className="gy-exec-timeline">
        {nodes.map((n) => {
          const expanded = open.has(n.id);
          const canExpand = n.details.length > 0 || n.tokens != null || n.tools.length > 0;

          return (
            <Timeline.Item
              key={n.id}
              time={formatDateTime(n.at)}
              type={n.timelineType}
              extra={
                <Typography.Text type="quaternary" size="small">
                  {n.kind === "step" ? "进度" : "事件"}
                </Typography.Text>
              }
            >
              <button
                type="button"
                className="gy-exec-step-btn"
                onClick={() => canExpand && toggle(n.id)}
                aria-expanded={expanded}
                disabled={!canExpand}
              >
                <span className="gy-exec-chevron" aria-hidden>
                  {canExpand ? (
                    expanded ? (
                      <IconChevronDown size="small" />
                    ) : (
                      <IconChevronRight size="small" />
                    )
                  ) : null}
                </span>
                <Space wrap spacing={8}>
                  <Typography.Text strong>{n.label}</Typography.Text>
                  {n.tools.map((t) => (
                    <Tag key={t} size="small" color="blue">
                      {t}
                    </Tag>
                  ))}
                  {n.tokens != null ? (
                    <Tag size="small" color="grey">
                      Token {n.tokens.toLocaleString()}
                    </Tag>
                  ) : null}
                  {active && n.id === currentId ? (
                    <Tag size="small" color="orange">
                      当前
                    </Tag>
                  ) : null}
                  {n.details.length > 0 ? (
                    <Typography.Text type="tertiary" size="small">
                      {n.details.length} 条详情
                    </Typography.Text>
                  ) : null}
                </Space>
              </button>

              <Collapsible isOpen={expanded}>
                <div className="gy-exec-details">
                  {n.details.length ? (
                    n.details.map((d, i) => (
                      <div key={`${n.id}-d-${i}`} className="gy-exec-detail">
                        <Space spacing={6}>
                          <Typography.Text type="tertiary" size="small">
                            {STATUS_LABEL[d.layer ?? ""] ?? d.layer ?? "详情"}
                          </Typography.Text>
                          <Typography.Text size="small">{d.title}</Typography.Text>
                        </Space>
                        {d.summary ? (
                          <pre className="gy-mono gy-exec-summary">{d.summary}</pre>
                        ) : (
                          <Typography.Text type="quaternary" size="small">
                            （无摘要）
                          </Typography.Text>
                        )}
                      </div>
                    ))
                  ) : (
                    <Typography.Text type="quaternary" size="small">
                      本步暂无挂载的命令 / 事实详情
                    </Typography.Text>
                  )}
                </div>
              </Collapsible>
            </Timeline.Item>
          );
        })}
      </Timeline>
    </div>
  );
}

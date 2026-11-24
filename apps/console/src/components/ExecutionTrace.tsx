import { useEffect, useMemo, useState } from "react";
import { Button, Collapsible, Empty, Space, Tag, Timeline, Toast, Typography } from "@douyinfe/semi-ui";
import { IconChevronDown, IconChevronRight } from "@douyinfe/semi-icons";
import type { ExecutionStep, ExecutionTracePage, ShellTraceCall } from "@gongyuai/contracts";
import { api } from "../api";
import { STATUS_LABEL, shortId } from "../labels";
import { formatDateTime, parseTime } from "../time";

export type TraceFact = {
  id?: string;
  title: string;
  summary: string;
  layer: string;
  createdAt: string;
};

export type ExecutionTraceProps = {
  taskId: string;
  progress?: string[];
  facts?: TraceFact[];
  trace?: ExecutionTracePage;
  active?: boolean;
  emptyHint?: string;
  /** 按 Intent 分组折叠（执行与日志页的结构化视图）。 */
  groupByIntent?: boolean;
  intents?: Array<{ id: string; title: string }>;
};

type TraceNode = {
  id: string;
  at: string;
  label: string;
  tools: string[];
  stepNum?: number;
  tokens?: number;
  step?: ExecutionStep;
  fact?: TraceFact;
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

function buildTrace(progress: string[], facts: TraceFact[], steps: ExecutionStep[]): TraceNode[] {
  const seenLines = new Map<string, number>();
  const nodes: TraceNode[] = [];
  for (const line of progress) {
    // Structured steps are loaded from the trace store by ID. Skip their log mirrors.
    if (/ · stepId=\S+$/.test(line)) continue;
    const p = parseProgressLine(line);
    const occurrence = (seenLines.get(line) ?? 0) + 1;
    seenLines.set(line, occurrence);
    let timelineType: TraceNode["timelineType"] = p.stepNum == null ? "default" : "success";
    if (/失败|错误|error/i.test(p.body)) timelineType = "error";
    if (/重试|警告|warning/i.test(p.body)) timelineType = "warning";

    const label =
      p.stepNum != null
        ? `第 ${p.stepNum} 步`
        : p.body.replace(/\s*·\s*工具.*$/, "").replace(/\s*·\s*Token.*$/i, "").trim() ||
          p.body;

    nodes.push({
      id: `p-${occurrence}-${line}`,
      at: p.at,
      label,
      tools: p.tools,
      stepNum: p.stepNum,
      tokens: p.tokens,
      kind: p.stepNum != null ? ("step" as const) : ("event" as const),
      timelineType,
    });
  }

  steps.forEach((step) => nodes.push({
    id: `s-${step.id}`,
    at: step.at,
    label: `第 ${step.number} 步`,
    tools: step.tools,
    tokens: step.tokens,
    step,
    kind: "step",
    timelineType: "success",
  }));
  facts.forEach((fact, i) => nodes.push({
    id: `f-${fact.id ?? `${fact.createdAt}-${i}`}`,
    at: fact.createdAt,
    label: fact.title,
    tools: [],
    fact,
    kind: "event",
    timelineType: "default",
  }));
  return nodes.sort((a, b) => parseTime(a.at) - parseTime(b.at));
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

function ShellStepDetails({ taskId, stepId }: { taskId: string; stepId: string }) {
  const [calls, setCalls] = useState<ShellTraceCall[]>();
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    api.executionStepCalls(taskId, stepId, controller.signal).then(
      ({ json }) => {
        if (!controller.signal.aborted) setCalls(json.calls);
      },
      (err) => {
        if (!controller.signal.aborted) setError(String(err instanceof Error ? err.message : err));
      },
    );
    return () => controller.abort();
  }, [taskId, stepId, attempt]);

  if (error) {
    return (
      <Space>
        <Typography.Text type="danger" size="small">读取命令详情失败 · {error}</Typography.Text>
        <Button size="small" onClick={() => {
          setError("");
          setAttempt(attempt + 1);
        }}>重试</Button>
      </Space>
    );
  }
  if (!calls) return <Typography.Text type="tertiary" size="small">正在读取命令详情…</Typography.Text>;

  return calls.map((call, i) => (
    <div key={call.id} className="gy-exec-detail">
      <Typography.Text strong size="small">Shell 命令 {i + 1}</Typography.Text>
      <pre className="gy-mono gy-exec-summary">{call.command ?? "命令参数不可用"}</pre>
      <Typography.Text type="tertiary" size="small">执行结果</Typography.Text>
      <pre className="gy-mono gy-exec-summary">{call.result ?? "执行结果未记录"}</pre>
    </div>
  ));
}

export function ExecutionTrace({
  taskId,
  progress = [],
  facts = [],
  trace,
  active = false,
  emptyHint = "暂无执行步骤",
  groupByIntent = false,
  intents = [],
}: ExecutionTraceProps) {
  const [historyPage, setHistoryPage] = useState<ExecutionTracePage>();
  const [loadingOlder, setLoadingOlder] = useState(false);
  const nodes = useMemo(() => {
    const byId = new Map<string, ExecutionStep>();
    for (const step of [...(historyPage?.steps ?? []), ...(trace?.steps ?? [])]) {
      byId.set(step.id, step);
    }
    return buildTrace(progress, facts, [...byId.values()].reverse());
  }, [progress, facts, historyPage, trace]);

  const page = historyPage ?? trace;
  const before = page?.nextBefore;
  const loadOlder = async () => {
    if (!page || page.nextBefore == null) return;
    setLoadingOlder(true);
    try {
      const { json } = await api.executionTrace(taskId, page.nextBefore);
      setHistoryPage({ steps: [...page.steps, ...json.steps], nextBefore: json.nextBefore });
    } catch {
      Toast.error("读取更早的执行步骤失败");
    } finally {
      setLoadingOlder(false);
    }
  };

  const toolSequence = useMemo(() => {
    const seq: string[] = [];
    for (const n of nodes) {
      for (const t of n.tools) {
        if (seq[seq.length - 1] !== t) seq.push(t);
      }
    }
    return seq.slice(-24);
  }, [nodes]);

  const currentId = useMemo(() => {
    const newestProgress = [...nodes].reverse().find((n) => !n.fact);
    return newestProgress?.id ?? null;
  }, [nodes]);

  const [open, setOpen] = useState<Set<string>>(() => new Set());

  useEffect(() => {
    if (currentId && active) setOpen((prev) => new Set([...prev, currentId]));
  }, [currentId, active]);

  const toggle = (id: string) => {
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(() => new Set());
  const toggleGroup = (key: string) => {
    setCollapsedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const groups = useMemo(() => {
    if (!groupByIntent) return null;
    const map = new Map<string, TraceNode[]>();
    for (const n of nodes) {
      const key = n.step?.intentId ?? "_other";
      const bucket = map.get(key);
      if (bucket) bucket.push(n);
      else map.set(key, [n]);
    }
    return map;
  }, [groupByIntent, nodes]);

  const intentTitle = (id: string) => intents.find((i) => i.id === id)?.title ?? shortId(id);

  const renderItem = (n: TraceNode) => {
    const expanded = open.has(n.id);
    const shellCallCount = n.step?.shellCallCount ?? 0;
    const legacyShell = !n.step && n.tools.includes("shell");
    const canExpand = Boolean(n.fact || shellCallCount || legacyShell);

    return (
      <Timeline.Item
        key={n.id}
        time={formatDateTime(n.at, Boolean(n.step))}
        type={active && n.id === currentId ? "ongoing" : n.timelineType}
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
          aria-expanded={canExpand ? expanded : undefined}
          disabled={!canExpand}
        >
          <span className="gy-exec-chevron" aria-hidden>
            {canExpand ? (
              expanded ? <IconChevronDown size="small" /> : <IconChevronRight size="small" />
            ) : null}
          </span>
          <Space wrap spacing={8}>
            <Typography.Text strong>{n.label}</Typography.Text>
            {Boolean(n.step?.workerSlot) && (
              <Tag size="small" color="grey">节点 {n.step?.workerSlot}</Tag>
            )}
            {n.tools.map((t) => (
              <Tag key={t} size="small" color="blue">{t}</Tag>
            ))}
            {n.tokens != null ? (
              <Tag size="small" color="grey">Token {n.tokens.toLocaleString()}</Tag>
            ) : null}
            {active && n.id === currentId ? (
              <Tag size="small" color="orange">当前</Tag>
            ) : null}
            {shellCallCount > 0 ? (
              <Typography.Text type="tertiary" size="small">{shellCallCount} 条命令</Typography.Text>
            ) : null}
          </Space>
        </button>

        {canExpand && (
          <Collapsible isOpen={expanded}>
            {expanded && (
              <div className="gy-exec-details">
                {n.step && shellCallCount > 0 && <ShellStepDetails taskId={taskId} stepId={n.step.id} />}
                {legacyShell && (
                  <Typography.Text type="tertiary" size="small">这条进度未保存可按步骤 ID 查询的命令详情</Typography.Text>
                )}
                {n.fact && (
                  <div className="gy-exec-detail">
                    <Typography.Text type="tertiary" size="small">
                      {STATUS_LABEL[n.fact.layer] ?? n.fact.layer}
                    </Typography.Text>
                    <pre className="gy-mono gy-exec-summary">{n.fact.summary || "（无摘要）"}</pre>
                  </div>
                )}
              </div>
            )}
          </Collapsible>
        )}
      </Timeline.Item>
    );
  };

  if (!nodes.length) {
    return <Empty description={emptyHint} style={{ padding: "24px 0" }} />;
  }

  const groupKeys = groups
    ? [...groups.keys()].sort((a, b) => (a === "_other" ? 1 : b === "_other" ? -1 : 0))
    : [];

  return (
    <div className="gy-exec-trace">
      <div className="gy-exec-trace-meta">
        <Typography.Text type="tertiary" size="small">
          共 {nodes.length} 个节点{groups ? ` · ${groupKeys.length} 个意图分组` : ""}
        </Typography.Text>
        <ToolChain tools={toolSequence} />
        {before != null && (
          <Button size="small" loading={loadingOlder} onClick={() => void loadOlder()}>
            加载更早的步骤
          </Button>
        )}
      </div>

      {groups ? (
        groupKeys.map((key) => {
          const groupNodes = groups.get(key)!;
          const collapsed = collapsedGroups.has(key);
          return (
            <section key={key} className="gy-exec-group">
              <button type="button" className="gy-exec-group-head" onClick={() => toggleGroup(key)} aria-expanded={!collapsed}>
                <span className="gy-exec-chevron" aria-hidden>
                  {collapsed ? <IconChevronRight size="small" /> : <IconChevronDown size="small" />}
                </span>
                <Typography.Text strong>{key === "_other" ? "其他动态" : intentTitle(key)}</Typography.Text>
                <Tag size="small" color="grey">{groupNodes.length}</Tag>
              </button>
              <Collapsible isOpen={!collapsed}>
                <Timeline mode="left" className="gy-exec-timeline">
                  {groupNodes.map(renderItem)}
                </Timeline>
              </Collapsible>
            </section>
          );
        })
      ) : (
        <Timeline mode="left" className="gy-exec-timeline">
          {nodes.map(renderItem)}
        </Timeline>
      )}
    </div>
  );
}

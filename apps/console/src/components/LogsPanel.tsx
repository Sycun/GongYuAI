import { useEffect, useMemo, useRef, useState } from "react";
import { Button, Collapsible, Empty, Input, Select, Space, Switch, Tag, Typography } from "@douyinfe/semi-ui";
import { IconSearch } from "@douyinfe/semi-icons";
import type { PlanStep } from "@gongyuai/contracts";
import { api, type RuntimePayload } from "../api";
import { ExecutionTrace } from "./ExecutionTrace";
import { PlanSection } from "./RecordSections";
import { filterLogLines, highlightSegments, splitLogSlots, LOG_LEVEL_OPTIONS, type LogLevel } from "./logsFormat";

type Props = {
  taskId: string;
  runtime?: RuntimePayload | null;
  active: boolean;
  intents?: Array<{ id: string; title: string }>;
  plan?: PlanStep[];
};

export function LogsPanel({ taskId, runtime, active, intents = [], plan = [] }: Props) {
  const [view, setView] = useState<"steps" | "raw">("steps");
  const [logsText, setLogsText] = useState("");
  const [loading, setLoading] = useState(false);
  const [keyword, setKeyword] = useState("");
  const [level, setLevel] = useState<LogLevel | "all">("all");
  const [slot, setSlot] = useState<string>("");
  const [autoScroll, setAutoScroll] = useState(true);
  const [planOpen, setPlanOpen] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    const pull = async () => {
      setLoading(true);
      try {
        const r = await api.logs(taskId);
        if (!cancelled) setLogsText(r.text || "");
      } catch { /* 轮询失败静默 */ }
      finally { if (!cancelled) setLoading(false); }
    };
    void pull();
    if (!active) return () => { cancelled = true; };
    const timer = window.setInterval(() => void pull(), 2500);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, [taskId, active]);

  const slots = useMemo(() => splitLogSlots(logsText).map((s) => s.slot).filter((s): s is string => Boolean(s)), [logsText]);
  const lines = useMemo(
    () => filterLogLines(logsText, { keyword, level, slot: slot || null }),
    [logsText, keyword, level, slot],
  );

  useEffect(() => {
    if (view === "raw" && autoScroll && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [lines, view, autoScroll]);

  return (
    <div className="gy-logs">
      <div className="gy-logs-toolbar">
        <Space spacing={8}>
          <Button size="small" theme={view === "steps" ? "solid" : "light"} type={view === "steps" ? "primary" : "tertiary"} onClick={() => setView("steps")}>
            结构化步骤流
          </Button>
          <Button size="small" theme={view === "raw" ? "solid" : "light"} type={view === "raw" ? "primary" : "tertiary"} onClick={() => setView("raw")}>
            实时原始日志
          </Button>
        </Space>
        {view === "raw" && (
          <Space wrap spacing={8}>
            <Input prefix={<IconSearch />} aria-label="日志关键字" placeholder="关键字高亮" value={keyword} onChange={setKeyword} style={{ width: 200 }} showClear />
            <Select aria-label="日志级别" value={level} onChange={(v) => setLevel(v as LogLevel | "all")} optionList={LOG_LEVEL_OPTIONS} style={{ width: 110 }} />
            {slots.length > 0 && (
              <Select aria-label="Worker Slot" placeholder="全部节点" value={slot || undefined} onChange={(v) => setSlot(String(v ?? ""))}
                optionList={slots.map((s) => ({ value: s, label: s.replace("worker-", "").replace(".log", "") }))} style={{ width: 130 }} showClear />
            )}
            <label className="gy-logs-autoscroll">
              <Switch size="small" checked={autoScroll} onChange={setAutoScroll} aria-label="自动滚底跟随" />
              <span>自动滚底</span>
            </label>
            <Tag size="small" color="grey">{lines.length} 行</Tag>
          </Space>
        )}
      </div>

      {view === "steps" ? (
        <div className="gy-logs-steps">
          <div className="gy-logs-steps-inner">
            <ExecutionTrace
              taskId={taskId}
              progress={runtime?.progress}
              facts={runtime?.recentFacts}
              trace={runtime?.trace}
              active={active}
              groupByIntent
              intents={intents}
              emptyHint={active ? "等待执行节点上报步骤…" : "暂无执行步骤"}
            />
            {plan.length > 0 && (
              <div className="gy-logs-plan">
                <button type="button" className="gy-exec-group-head" onClick={() => setPlanOpen((v) => !v)} aria-expanded={planOpen}>
                  <Typography.Text strong>计划步骤</Typography.Text>
                  <Tag size="small" color="grey">{plan.length}</Tag>
                </button>
                <Collapsible isOpen={planOpen}>
                  <PlanSection rows={plan} />
                </Collapsible>
              </div>
            )}
          </div>
        </div>
      ) : (
        <div className="gy-logs-raw" ref={scrollRef}>
          {loading && !logsText ? (
            <Typography.Text type="tertiary" style={{ padding: 16, display: "block" }}>正在读取日志…</Typography.Text>
          ) : lines.length === 0 ? (
            <Empty title="暂无日志" description={keyword || level !== "all" ? "没有匹配当前过滤条件的日志行。" : "执行节点产生日志后会显示在这里。"} style={{ padding: 32 }} />
          ) : (
            <div className="gy-logs-raw-inner">
              {lines.map((line, i) => (
                <div key={i} className={`gy-log-line gy-log-${line.level}`}>
                  {highlightSegments(line.text, keyword).map((seg, j) =>
                    seg.hit ? <mark key={j}>{seg.text}</mark> : <span key={j}>{seg.text}</span>,
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
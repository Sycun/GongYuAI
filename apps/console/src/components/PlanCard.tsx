import { useEffect, useRef, useState } from "react";
import { probe } from "../api";
import { STATUS_LABEL } from "../labels";
import { ChatMarkdown } from "./ChatMarkdown";
import { consultLabel, diffNotices, goalOutcomeLabel, type NoticeItem, type WorkSignal, writeNotices } from "../workspace/model";

type Goal = { id: string; title: string; description?: string; passes?: boolean };
type Intent = { id: string; title: string; status?: string; claimedBy?: string | null };
type Consult = { id: string; question: string; status?: string; releasedAt?: string | null; blocking?: boolean };
type RecordedPlan = {
  error?: string;
  name: string;
  status: string;
  description: string;
  goals: string[];
  latestResult?: string;
  consultStatus: string;
  openConsults: Consult[];
};

function signalOf(input: {
  goals: Goal[];
  intents: Intent[];
  facts: Array<{ id?: string; title?: string }>;
  status: string;
  consults: Consult[] | "unregistered" | "failed";
}): WorkSignal {
  const plan = input.goals.map((goal) => `${goal.id}:${goal.passes ? 1 : 0}:${goal.title}`).sort().join("|");
  const planText = input.goals.map((goal) => `${goal.title} ${goalOutcomeLabel(Boolean(goal.passes))}`).join("；");
  const latest = [...input.facts].reverse().find((fact) => fact.title);
  const result = latest?.id ?? "";
  const blocked = ["failed", "paused", "pause_requested", "budget_exhausted", "stopped"].includes(input.status) ? input.status : "";
  const open = Array.isArray(input.consults) ? input.consults.filter((item) => item.status === "open") : [];
  return {
    plan,
    planText,
    result,
    resultText: latest?.title ?? "",
    block: blocked,
    blockText: blocked ? `任务状态 ${STATUS_LABEL[blocked] ?? blocked}` : "",
    decision: Array.isArray(input.consults) ? open.map((item) => item.id).sort().join("|") : "",
    decisionText: open.map((item) => item.question).join("；"),
  };
}

export function PlanCard({
  taskId,
  turnId,
  question,
  conversationId,
  onNotices,
  onOpen,
}: {
  taskId: string | null;
  turnId: string | null;
  question: string | null;
  conversationId?: string;
  onNotices: (items: NoticeItem[]) => void;
  onOpen: (href: string) => void;
}) {
  const [plan, setPlan] = useState<RecordedPlan | string>("正在读取计划…");
  const [sourceOpen, setSourceOpen] = useState(false);
  const report = useRef(onNotices);
  report.current = onNotices;
  useEffect(() => {
    if (!taskId || !conversationId) {
      setPlan("收到任务回执后，这里会显示计划。");
      return;
    }
    const requested = taskId;
    const controller = new AbortController();
    let timer = 0;
    const pull = async () => {
      const [task, history, consult] = await Promise.all([
        probe<{ task?: { name?: string; status?: string; goals?: Goal[] } }>(`/tasks/${encodeURIComponent(requested)}`, controller.signal),
        probe<{ goals?: Goal[]; intents?: Intent[]; facts?: Array<{ id?: string; title?: string }> }>(`/tasks/${encodeURIComponent(requested)}/history`, controller.signal),
        probe<{ consults?: Consult[] }>(`/tasks/${encodeURIComponent(requested)}/consults`, controller.signal),
      ]);
      if (controller.signal.aborted) return;
      const recordedGoals = task.ok ? task.json.task?.goals ?? [] : [];
      const historyGoals = history.ok ? history.json.goals ?? [] : [];
      const goals = historyGoals.length ? historyGoals : recordedGoals;
      const intents = history.ok ? history.json.intents ?? [] : [];
      const facts = history.ok ? history.json.facts ?? [] : [];
      const status = task.ok ? task.json.task?.status ?? "" : "";
      const name = task.ok ? task.json.task?.name ?? "" : "";
      const described = (task.ok ? task.json.task?.goals : undefined) ?? goals;
      const ownDescription = described.map((goal) => goal.description || goal.title).filter(Boolean).join("；");
      const consultState = consult.ok ? consult.json.consults ?? [] : consult.kind === "unregistered" ? "unregistered" as const : "failed" as const;
      const open = Array.isArray(consultState) ? consultState.filter((item) => item.status === "open") : [];
      setPlan({
        error: !task.ok && !history.ok ? `读取计划失败：${task.error}` : undefined,
        name, status, description: ownDescription || name,
        goals: goals.map((goal) => {
          const owner = intents.find((intent) => intent.title === goal.title)?.claimedBy;
          return `${goal.title}（${goalOutcomeLabel(Boolean(goal.passes))}，${owner || "未记录处理人"}）`;
        }),
        latestResult: history.ok ? [...facts].reverse().find((fact) => fact.title)?.title : "暂时无法读取结果",
        consultStatus: consult.ok ? (open.length ? `${open.length} 条待答` : "暂无待答问题")
          : consult.kind === "unregistered" ? "求助接口尚未注册" : `读取失败：${consult.error}`,
        openConsults: open,
      });
      const signal = signalOf({ goals, intents, facts, status, consults: consultState });
      const saved = JSON.parse(localStorage.getItem("gongyuai.chat.notice.v1." + conversationId + "." + requested) || "null") as { signal?: WorkSignal; items?: NoticeItem[] } | null;
      const previous = saved?.signal ?? null;
      const messages = diffNotices(previous, signal);
      const items = [...(saved?.items ?? [])];
      if (messages.length || !previous) {
        const now = Date.now();
        for (const message of messages) items.push({ id: `${now}:${items.length}`, at: now, text: message });
        writeNotices(conversationId, requested, { signal, items });
        if (messages.length) report.current(items);
      }
      if (!controller.signal.aborted) timer = window.setTimeout(() => void pull(), 12000);
    };
    void pull();
    return () => {
      controller.abort();
      window.clearTimeout(timer);
    };
  }, [taskId, conversationId]);

  return (
    <section className="gy-plan-card" aria-label="计划">
      <header><strong>计划</strong>{typeof plan !== "string" && <span>{STATUS_LABEL[plan.status] ?? (plan.status || "状态未记录")}</span>}</header>
      {typeof plan === "string" ? <p>{plan}</p> : <>
        {plan.error ? <p role="status">{plan.error}</p> : <dl className="gy-plan-facts">
          <dt>业务目标</dt><dd>{plan.goals.length
            ? <ul>{plan.goals.map((goal, i) => <li key={i}>{goal}</li>)}</ul> : "暂无已记录的目标"}</dd>
          <dt>最近结果</dt><dd>{plan.latestResult || "暂无已记录的结果"}</dd>
          <dt>需要你回答</dt><dd>{plan.consultStatus}</dd>
        </dl>}
        {plan.openConsults.map((item) => (
          <button type="button" key={item.id} className="gy-question-link" onClick={() => taskId && onOpen(`#/live/${encodeURIComponent(taskId)}?consult=${encodeURIComponent(item.id)}`)}>
            {consultLabel(item)} · {item.question}
            {item.releasedAt ? " · 阻塞已解除，仍待答" : ""}
          </button>
        ))}
        <details className="gy-plan-source" onToggle={event => setSourceOpen(event.currentTarget.open)}>
          <summary>{question ? "查看本轮要求" : "查看任务说明"}</summary>
          <dl className="gy-plan-facts">
            <dt>任务编号</dt><dd>{taskId}</dd>
            {plan.name && <><dt>任务名称</dt><dd>{plan.name}</dd></>}
            {turnId && <><dt>对应轮次</dt><dd>{turnId}</dd></>}
          </dl>
          {sourceOpen && <ChatMarkdown text={question || plan.description || "暂无任务说明"} />}
        </details>
      </>}
    </section>
  );
}

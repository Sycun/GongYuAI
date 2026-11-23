import { useEffect, useRef, useState } from "react";
import { probe } from "../api";
import { consultLabel, diffNotices, goalOutcomeLabel, type NoticeItem, type WorkSignal, writeNotices } from "../workspace/model";

type Goal = { id: string; title: string; description?: string; passes?: boolean };
type Intent = { id: string; title: string; status?: string; claimedBy?: string | null };
type Consult = { id: string; question: string; status?: string; releasedAt?: string | null; blocking?: boolean };

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
    blockText: blocked ? `任务状态 ${blocked}` : "",
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
  const [text, setText] = useState("正在读取已记录的计划…");
  const [consults, setConsults] = useState<Consult[]>([]);
  const report = useRef(onNotices);
  report.current = onNotices;
  useEffect(() => {
    if (!taskId || !conversationId) {
      setText("等待任务回执。计划要等控制面记下任务后才显示。");
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
      const name = task.ok ? task.json.task?.name ?? requested : requested;
      const described = (task.ok ? task.json.task?.goals : undefined) ?? goals;
      const ownDescription = described.map((goal) => goal.description || goal.title).filter(Boolean).join("；");
      const consultState = consult.ok ? consult.json.consults ?? [] : consult.kind === "unregistered" ? "unregistered" as const : "failed" as const;
      const open = Array.isArray(consultState) ? consultState.filter((item) => item.status === "open") : [];
      setConsults(open);
      const lines = [
        `任务编号：${requested}`,
        `任务状态：${status || "未记录"}`,
        question
          ? `对应轮次：${turnId ?? "未记录"}\n你的要求：${question}`
          : `没有对应的会话轮次。\n该任务的说明：${ownDescription || name}`,
        `已记录的任务：${name}`,
        "规划者复述：服务端没有单独的复述字段。",
        goals.length
          ? `目标：${goals.map((goal) => {
            const owner = intents.find((intent) => intent.title === goal.title)?.claimedBy;
            return `${goal.title}（${goalOutcomeLabel(Boolean(goal.passes))}，${owner || "未记录处理人"}）`;
          }).join("；")}`
          : "目标：控制面还没有记下目标。",
        facts.length ? `最近结果：${[...facts].reverse().find((fact) => fact.title)?.title}` : "最近结果：尚无已记录结果。",
        consultState === "unregistered"
          ? "是否需要你回答：求助接口未注册，不能判断。"
          : consultState === "failed"
            ? `是否需要你回答：求助读取失败。${!consult.ok ? consult.error : ""}`
            : open.length
              ? `需要你回答：${open.length} 条待答。`
              : "是否需要你回答：当前没有待答问题。",
        "作业执行成功和业务目标通过是两件独立的事。",
      ];
      setText(lines.join("\n"));
      if (!history.ok && !task.ok) setText(`读取失败：${task.ok ? "" : task.error}`);
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
  }, [taskId, conversationId, question, turnId]);

  return (
    <section className="gy-plan-card" aria-label="计划">
      <header><strong>计划</strong><span>只显示控制面已经记下的内容</span></header>
      <p>{text}</p>
      {consults.map((item) => (
        <button type="button" key={item.id} className="gy-question-link" onClick={() => taskId && onOpen(`#/live/${encodeURIComponent(taskId)}?consult=${encodeURIComponent(item.id)}`)}>
          {consultLabel(item)} · {item.question}
          {item.releasedAt ? " · 阻塞已解除，仍待答" : ""}
        </button>
      ))}
    </section>
  );
}

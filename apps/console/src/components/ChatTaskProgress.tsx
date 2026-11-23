import { useEffect, useState } from "react";
import { IconChevronRight, IconList } from "@douyinfe/semi-icons";
import { api, type HistoryPayload, type RuntimePayload, type TaskRecord } from "../api";
import { isActiveStatus, STATUS_LABEL } from "../labels";
import { formatDateTime, parseTime } from "../time";
import { CommandReviewCard } from "./CommandReviewCard";

const phases: Record<string, string> = { bootstrap: "初始化", explore: "执行", reason: "规划", report: "汇总", relay: "交接" };

type Adjustment = { at: string; label: string; reason: string };

function latestAdjustment(history: HistoryPayload, runtime: RuntimePayload) {
  const entries: Adjustment[] = [];
  // Phase transitions only carry a reason when the worker actually recorded one.
  for (const line of runtime.progress ?? []) {
    const match = /^(\d{4}-\d\d-\d\d [\d:.]+) phase=(\w+) \((.+)\)$/.exec(line);
    if (match) entries.push({ at: match[1], label: "转入" + (phases[match[2]] ?? match[2]) + "阶段", reason: match[3] });
  }
  for (const fact of history.facts) {
    if (!fact.tags?.includes("scope") || !fact.tags.some(tag => tag.startsWith("scopeVersion:"))) continue;
    const reason = fact.summary.match(/；原因：([\s\S]+)$/)?.[1];
    if (reason) entries.push({ at: fact.createdAt, label: fact.title, reason });
  }
  for (const request of history.retestRequests ?? []) {
    if (request.reason.trim()) entries.push({ at: request.createdAt, label: "新增复核请求", reason: request.reason });
  }
  return entries.sort((a, b) => parseTime(b.at) - parseTime(a.at))[0];
}

function describeProgress(task: TaskRecord, history: HistoryPayload, runtime: RuntimePayload) {
  const goals = history.goals.length ? history.goals : task.goals;
  const open = history.intents.filter(i => ["claimed", "running", "proposed"].includes(i.status));
  const active = open.filter(i => i.status !== "proposed");
  const plan = open.length
    ? [...active, ...open.filter(i => i.status === "proposed")].map(i => ({ id: i.id, title: i.title, state: STATUS_LABEL[i.status] ?? i.status }))
    : goals.map(g => ({ id: g.id, title: g.title, state: g.passes ? "已通过" : "待核验" }));
  let status = STATUS_LABEL[task.status] ?? task.status;
  if (task.status === "running" && runtime.externalState === "unknown") status = "运行状态待确认";
  const phase = isActiveStatus(task.status) && runtime.externalState === "running" && runtime.phase
    ? phases[runtime.phase] ?? runtime.phase : null;
  return { name: task.name, commandReview: task.commandReview, status, phase, plan, adjustment: latestAdjustment(history, runtime),
    goalCount: goals.length, passed: goals.filter(g => g.passes).length };
}

export function ChatTaskProgress({ taskId }: { taskId: string }) {
  const [snapshot, setSnapshot] = useState<ReturnType<typeof describeProgress>>();
  const [review, setReview] = useState<TaskRecord["commandReview"]>();
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    let timer: number | undefined;
    let fetching = false;
    async function refresh() {
      window.clearTimeout(timer);
      if (fetching || document.hidden || controller.signal.aborted) return;
      fetching = true;
      let delay = 12_000;
      try {
        const [task, history, runtime] = await Promise.all([
          api.task(taskId, controller.signal).then(r => { if (!controller.signal.aborted) setReview(r.json.task.commandReview); return r; }), api.history(taskId, controller.signal), api.runtime(taskId, controller.signal),
        ]);
        if (controller.signal.aborted) return;
        setSnapshot(describeProgress(task.json.task, history.json, runtime.json));
        setFailed(false);
        if (!isActiveStatus(task.json.task.status)) delay = 60_000;
      } catch {
        if (!controller.signal.aborted) setFailed(true);
      } finally {
        fetching = false;
        if (!document.hidden && !controller.signal.aborted) timer = window.setTimeout(refresh, delay);
      }
    }
    void refresh();
    document.addEventListener("visibilitychange", refresh);
    return () => { controller.abort(); window.clearTimeout(timer); document.removeEventListener("visibilitychange", refresh); };
  }, [taskId, attempt]);

  return <details open className="gy-task-progress">
    <summary><IconList aria-hidden="true" /><strong>任务进展</strong>
      {snapshot && <span className="gy-task-name" title={snapshot.name}>{snapshot.name}</span>}
      <IconChevronRight className="gy-task-caret" size="small" /></summary>
    <div className="gy-task-content">
        {review && <CommandReviewCard taskId={taskId} review={review} onDecided={() => setAttempt(n => n + 1)} />}
      {failed && <p role="status">暂时无法读取任务进展。{snapshot && "以下为上次读取的记录。"} <button type="button" onClick={() => setAttempt(n => n + 1)}>重试</button></p>}
      {!failed && !snapshot && <p role="status">正在读取任务记录…</p>}
      {snapshot && <>
        <h3>当前进度</h3><p><strong>{snapshot.status}</strong>{snapshot.phase && " · " + snapshot.phase + "阶段"}
          {snapshot.goalCount > 0 && ` · 已通过 ${snapshot.passed} / ${snapshot.goalCount} 项目标`}</p>
        <h3>计划</h3>
        {snapshot.plan.length ? <ul>{snapshot.plan.slice(0, 4).map(item => <li key={item.id}>
          <span>{item.title}</span><small>{item.state}</small></li>)}</ul> : <p>暂无已记录的计划。</p>}
        {snapshot.plan.length > 4 && <p>另有 {snapshot.plan.length - 4} 项，可在任务详情查看。</p>}
        <h3>调整原因</h3>
        {snapshot.adjustment ? <p>{snapshot.adjustment.label} · {snapshot.adjustment.reason}
          <small className="gy-task-date">{formatDateTime(snapshot.adjustment.at)}</small></p> : <p>最近记录中暂无调整原因。</p>}
      </>}
      <a className="gy-task-detail-link" href={"#/live/" + encodeURIComponent(taskId)}>查看任务详情 <IconChevronRight size="small" /></a>
    </div>
  </details>;
}

export function ChatTaskSelect({ value, onChange }: { value: string; onChange: (id: string) => void }) {
  const [tasks, setTasks] = useState<TaskRecord[]>();
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setFailed(false);
    api.tasks(controller.signal).then(r => { if (!controller.signal.aborted) setTasks(r.json.tasks); })
      .catch(() => { if (!controller.signal.aborted) setFailed(true); });
    return () => controller.abort();
  }, [attempt]);
  return <div>
    <select aria-label="关联任务" value={value} onChange={e => onChange(e.target.value)}>
      <option value="">未关联任务</option>
      {value && !tasks?.some(t => t.id === value) && <option value={value}>已关联 · {value}</option>}
      {tasks?.map(t => <option key={t.id} value={t.id}>{t.name} · {t.id.slice(0, 8)}</option>)}
    </select>
    {failed ? <small role="status">任务列表读取失败。<button type="button" onClick={() => setAttempt(n => n + 1)}>重试</button></small>
      : !tasks ? <small role="status">正在读取任务…</small>
      : tasks.length === 0 && <small>暂无可关联的任务</small>}
  </div>;
}

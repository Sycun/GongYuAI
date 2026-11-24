import { useEffect, useRef, useState } from "react";
import { Button } from "@douyinfe/semi-ui";
import { api } from "../api";
import { STATUS_LABEL } from "../labels";
import { GraphStage, GraphThumb } from "./GraphCanvas";
import { rememberGraphTask } from "../workspace/graphStore";
import { useTaskGraph } from "../workspace/useTaskGraph";
import { type GraphState, type ViewName } from "../workspace/model";
import {
  controlFace,
  ViewedTaskControlsController,
  type TaskAction,
  type TaskControlFace,
} from "./viewedTaskControls";

const views: Array<{ view: ViewName; title: string }> = [
  { view: "assets", title: "资产图" },
  { view: "surface", title: "攻击面图" },
  { view: "execution", title: "执行图" },
  { view: "memory", title: "记忆图" },
];

function statusText(state: GraphState): string | null {
  if (state.kind === "waiting") return "等待任务回执";
  if (state.kind === "loading") return "正在读取";
  if (state.kind === "empty") return "已有任务，暂无数据";
  if (state.kind === "unregistered") return "当前控制面未注册这条图接口";
  if (state.kind === "forbidden") return "无权查看";
  if (state.kind === "failed") return `读取失败：${state.message}`;
  if (state.kind === "withheld" || state.kind === "unavailable") return state.message;
  return null;
}

function useViewedTaskControls(taskId: string | null, taskName: string) {
  const controls = useRef<ViewedTaskControlsController | null>(null);
  if (!controls.current) controls.current = new ViewedTaskControlsController();
  const api = controls.current;
  const [snap, setSnap] = useState(() => {
    api.show(taskId, taskName, false);
    return api.snapshot();
  });
  const identity = `${taskId ?? ""}\0${taskName}`;
  const [seen, setSeen] = useState(identity);
  if (seen !== identity) {
    setSeen(identity);
    api.show(taskId, taskName, false);
    setSnap(api.snapshot());
  }
  useEffect(() => api.subscribe(() => setSnap(api.snapshot())), [api]);
  useEffect(() => {
    if (!taskId) return;
    const requested = taskId;
    const ac = new AbortController();
    let timer = 0;
    const pull = async () => {
      const epoch = api.pollEpoch(requested);
      try {
        const res = await fetch(`/tasks/${encodeURIComponent(requested)}`, { signal: ac.signal });
        const body = await res.json().catch(() => ({}));
        if (ac.signal.aborted) return;
        api.applyPolledStatus(requested, String(body?.task?.status ?? ""), String(body?.task?.id ?? ""), epoch, body?.task?.error ?? "");
      } catch { /* 下一次刷新再读。 */ }
    };
    void pull();
    timer = window.setInterval(() => void pull(), 2000);
    return () => { ac.abort(); window.clearInterval(timer); };
  }, [api, taskId]);
  return {
    face: controlFace(snap, (status) => STATUS_LABEL[status] ?? status),
    act: (action: TaskAction) => api.act(action),
  };
}

function ViewedTaskControls({ face, onAct }: { face: TaskControlFace; onAct: (action: TaskAction) => void }) {
  return (
    <div className="gy-view-ops" aria-label="当前任务操作">
      <span>当前任务操作</span>
      <strong>操作对象：{face.subject}</strong>
      <span role="status">任务状态：{face.statusText}</span>
      {face.pauseReason && <p role="status">暂停原因：{face.pauseReason}</p>}
      {face.note && <p role="status">{face.note}</p>}
      {face.pause && <Button size="small" loading={face.pause.busy} onClick={() => void onAct("pause")}>{face.pause.label}</Button>}
      {face.resume && <Button size="small" loading={face.resume.busy} onClick={() => void onAct("resume")}>{face.resume.label}</Button>}
    </div>
  );
}

function GraphCard({
  taskId,
  view,
  title,
  onOpen,
}: {
  taskId: string | null;
  view: ViewName;
  title: string;
  onOpen: (view: ViewName) => void;
}) {
  const enabled = view !== "memory" && Boolean(taskId);
  const state = useTaskGraph(taskId, view, enabled, enabled ? 8000 : 0);
  const message = view === "memory"
    ? "普通会话不读取记忆。此前留在页面缓存里的记忆图也不会显示。"
    : statusText(taskId ? state : { kind: "waiting" });
  const graph = state.kind === "ready" ? state.graph : state.kind === "empty" ? state.graph : undefined;
  const change = graph?.notes[0] || graph?.generatedAt || (state.kind === "ready" ? state.source : "");
  return (
    <article className="gy-graph-card">
      <header><h3>{title}</h3>{change && <small title={change}>{change}</small>}</header>
      {graph && graph.nodes.length > 0 ? <GraphThumb graph={graph} /> : <div className="gy-graph-placeholder" role="status">{message}</div>}
      {graph && graph.nodes.length > 0 && <p className="gy-graph-source">{state.kind === "ready" ? state.source : ""}</p>}
      <Button size="small" theme="borderless" disabled={!taskId || view === "memory"} onClick={() => onOpen(view)}>查看大图</Button>
    </article>
  );
}

export function TaskGraphRail({
  taskId,
  mode,
  choices,
  onPin,
  onFollow,
  onStage,
}: {
  taskId: string | null;
  mode: "follow" | "pinned" | "waiting";
  choices: string[];
  onPin: (taskId: string) => void;
  onFollow: () => void;
  onStage: (view: ViewName | null) => void;
}) {
  const [names, setNames] = useState<Record<string, string>>({});
  useEffect(() => {
    if (taskId) rememberGraphTask(taskId);
  }, [taskId]);
  useEffect(() => {
    const controller = new AbortController();
    api.tasks(controller.signal).then((result) => {
      if (controller.signal.aborted) return;
      const next: Record<string, string> = {};
      for (const task of result.json.tasks ?? []) next[task.id] = task.name;
      setNames(next);
    }).catch(() => { /* 名称读不到时仍显示编号。 */ });
    return () => controller.abort();
  }, [taskId]);
  const currentName = taskId ? (names[taskId] || taskId.slice(0, 8)) : "等待任务回执";
  const viewed = useViewedTaskControls(taskId, currentName);
  const options = [...new Set(choices.filter(Boolean))];
  return (
    <aside className="gy-graph-rail" aria-label="任务图谱">
      <div className="gy-graph-focus">
        <span>当前任务</span>
        <strong title={viewed.face.taskName}>{viewed.face.taskName}</strong>
        <select aria-label="切换当前任务" value={taskId ?? ""} disabled={!options.length} onChange={(event) => onPin(event.target.value)}>
          {!taskId && <option value="">等待任务回执</option>}
          {options.map((id) => <option key={id} value={id}>{names[id] || id.slice(0, 8)}</option>)}
        </select>
        <div className="gy-focus-actions">
          <Button size="small" theme="borderless" disabled={!taskId || mode === "pinned"} onClick={() => taskId && onPin(taskId)}>固定查看</Button>
          <Button size="small" theme="borderless" disabled={mode !== "pinned"} onClick={onFollow}>跟随最新任务</Button>
        </div>
        <ViewedTaskControls face={viewed.face} onAct={viewed.act} />
      </div>
      {views.map((item) => (
        <GraphCard key={item.view} taskId={taskId} view={item.view} title={item.title} onOpen={onStage} />
      ))}
    </aside>
  );
}

export function GraphDetail({ taskId, view, onOpenRecord }: { taskId: string; view: ViewName; onOpenRecord: (href: string) => void }) {
  const state = useTaskGraph(taskId, view, view !== "memory", 8000);
  if (view === "memory") {
    return <p role="status">普通会话不读取记忆，也不展示缓存里的记忆内容。</p>;
  }
  const graph = state.kind === "ready" ? state.graph : state.kind === "empty" ? state.graph : undefined;
  return (
    <>
      {state.kind === "ready" && <p className="gy-graph-source">{state.source}</p>}
      {view === "surface" && state.kind === "ready" && <CoverageTable cells={state.cells ?? []} />}
      {view === "surface" && state.kind === "empty" && <CoverageTable cells={state.cells ?? []} />}
      {graph && graph.nodes.length > 0
        ? <GraphStage graph={graph} taskId={taskId} view={view} onOpen={onOpenRecord} />
        : <p role="status">{statusText(state)}</p>}
    </>
  );
}

export function CoverageTable({ cells }: { cells: Array<{ asset: string; technique: string; state: string; notes?: string[] }> }) {
  if (!cells.length) return <p role="status">已有任务，暂无覆盖数据。</p>;
  return (
    <table className="gy-coverage-table">
      <thead><tr><th>资产</th><th>检查项</th><th>状态</th></tr></thead>
      <tbody>
        {cells.map((cell) => (
          <tr key={`${cell.asset}:${cell.technique}`}>
            <td>{cell.asset}</td>
            <td>{cell.technique}</td>
            <td>{cell.state}{cell.notes?.length ? ` · ${cell.notes.join("；")}` : ""}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function graphStatusText(state: GraphState): string | null {
  return statusText(state);
}

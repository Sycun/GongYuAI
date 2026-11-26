import { useEffect, useMemo, useRef, useState } from "react";
import { Button, Input } from "@douyinfe/semi-ui";
import { IconArchive, IconSearch, IconUndo } from "@douyinfe/semi-icons";
import type { TaskArchiveState } from "@gongyuai/contracts";
import { isArchivableStatus, STATUS_LABEL } from "../labels";
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

const views: Array<{ view: ViewName; title: string; dot: string }> = [
  { view: "assets", title: "资产图", dot: "#059669" },
  { view: "surface", title: "攻击面图", dot: "#7c3aed" },
  { view: "execution", title: "执行图", dot: "#2563eb" },
  { view: "memory", title: "记忆图", dot: "#64748b" },
];

function statusText(state: GraphState): string | null {
  if (state.kind === "waiting") return "等待任务回执";
  if (state.kind === "loading") return "正在读取…";
  if (state.kind === "empty") return "已有任务，暂无数据";
  if (state.kind === "unregistered") return "当前控制面未注册这条图接口";
  if (state.kind === "forbidden") return "无权查看";
  if (state.kind === "failed") return `读取失败：${state.message}`;
  if (state.kind === "withheld" || state.kind === "unavailable") return state.message;
  return null;
}

export function shortSourceLabel(source: string): string {
  if (!source) return "";
  const cleaned = source.replace(/^\/tasks\/[^/]+\//, "/");
  return cleaned.startsWith("/") ? `接口 ${cleaned}` : cleaned;
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

function ViewedTaskControls({ face, onAct, task, archiveBusy, onArchive }: {
  face: TaskControlFace; onAct: (action: TaskAction) => void; task?: TaskArchiveState;
  archiveBusy: boolean; onArchive: (id: string, archived: boolean) => void;
}) {
  return (
    <div className="gy-view-ops" aria-label="当前任务操作">
      <div className="gy-view-ops-row">
        <span className="gy-view-ops-label">任务状态</span>
        <span className="gy-view-ops-status" role="status">{face.statusText}</span>
      </div>
      <div className="gy-view-ops-subject" title={face.subject}>操作对象：{face.subject}</div>
      {face.pauseReason && <p role="status" className="gy-view-ops-note">暂停原因：{face.pauseReason}</p>}
      {face.note && <p role="status" className="gy-view-ops-note">{face.note}</p>}
      {(face.pause || face.resume || (task && (task.archivedAt || isArchivableStatus(task.status)))) && (
        <div className="gy-view-ops-actions">
          {face.pause && <Button size="small" theme="light" loading={face.pause.busy} onClick={() => void onAct("pause")}>{face.pause.label}</Button>}
          {face.resume && <Button size="small" theme="light" type="primary" loading={face.resume.busy} onClick={() => void onAct("resume")}>{face.resume.label}</Button>}
          {task && (task.archivedAt || isArchivableStatus(task.status)) && (
            <Button
              size="small"
              theme="borderless"
              type="tertiary"
              disabled={archiveBusy}
              icon={task.archivedAt ? <IconUndo aria-hidden="true" /> : <IconArchive aria-hidden="true" />}
              onClick={() => onArchive(task.id, !task.archivedAt)}
            >
              {task.archivedAt ? "取消归档任务" : "归档任务"}
            </Button>
          )}
        </div>
      )}
    </div>
  );
}

function GraphCard({
  taskId,
  view,
  title,
  dot,
  active,
  onOpen,
}: {
  taskId: string | null;
  view: ViewName;
  title: string;
  dot: string;
  active?: boolean;
  onOpen: (view: ViewName) => void;
}) {
  const enabled = view !== "memory" && Boolean(taskId);
  const state = useTaskGraph(taskId, view, enabled, enabled ? 8000 : 0);
  const message = view === "memory"
    ? "普通会话不读取记忆。此前留在页面缓存里的记忆图也不会显示。"
    : statusText(taskId ? state : { kind: "waiting" });
  const graph = state.kind === "ready" ? state.graph : state.kind === "empty" ? state.graph : undefined;
  const note = graph?.notes[0] ?? "";
  const canOpen = Boolean(taskId && view !== "memory");
  const source = state.kind === "ready" ? state.source : "";

  return (
    <article className={`gy-graph-card${active ? " is-active" : ""}`}>
      <header className="gy-graph-card-head">
        <div className="gy-graph-card-title">
          <i style={{ background: dot }} aria-hidden="true" />
          <h3>{title}</h3>
        </div>
        {graph && graph.nodes.length > 0 && (
          <span className="gy-graph-count">{graph.nodes.length} 节点</span>
        )}
      </header>
      {note && <p className="gy-graph-note" title={note}>{note}</p>}
      {graph && graph.nodes.length > 0 ? (
        <div
          className={`gy-graph-thumb-wrap${canOpen ? " is-clickable" : ""}`}
          onClick={canOpen ? () => onOpen(view) : undefined}
        >
          <GraphThumb graph={graph} />
        </div>
      ) : (
        <div className="gy-graph-placeholder" role="status">{message}</div>
      )}
      <footer className="gy-graph-card-foot">
        {source ? (
          <span className="gy-graph-source" title={source}>{shortSourceLabel(source)}</span>
        ) : <span />}
        <Button
          size="small"
          theme={active ? "light" : "borderless"}
          type={active ? "primary" : "tertiary"}
          disabled={!canOpen}
          onClick={() => onOpen(view)}
        >
          查看大图
        </Button>
      </footer>
    </article>
  );
}

const MODE_LABEL: Record<"follow" | "pinned" | "waiting", string> = {
  follow: "跟随最新",
  pinned: "已固定",
  waiting: "等待回执",
};

export function TaskGraphRail({
  taskId,
  mode,
  choices,
  tasks,
  archiveBusy,
  activeView,
  onArchive,
  onPin,
  onFollow,
  onStage,
}: {
  taskId: string | null;
  mode: "follow" | "pinned" | "waiting";
  choices: string[];
  tasks: Map<string, TaskArchiveState>;
  archiveBusy: boolean;
  activeView?: ViewName | null;
  onArchive: (id: string, archived: boolean) => void;
  onPin: (taskId: string) => void;
  onFollow: () => void;
  onStage: (view: ViewName | null) => void;
}) {
  useEffect(() => {
    if (taskId) rememberGraphTask(taskId);
  }, [taskId]);
  const task = taskId ? tasks.get(taskId) : undefined;
  const currentName = task?.name ?? taskId?.slice(0, 8) ?? "等待任务回执";
  const viewed = useViewedTaskControls(taskId, currentName);
  const options = [...new Set(choices.filter(Boolean))];
  return (
    <aside className="gy-graph-rail" aria-label="任务图谱">
      <div className="gy-graph-focus">
        <div className="gy-focus-head">
          <span>当前任务</span>
          <em className={`gy-mode-badge is-${mode}`}>{MODE_LABEL[mode]}</em>
        </div>
        <strong title={viewed.face.taskName}>{viewed.face.taskName}</strong>
        <select aria-label="切换当前任务" value={taskId ?? ""} disabled={!options.length} onChange={(event) => onPin(event.target.value)}>
          {!taskId && <option value="">等待任务回执</option>}
          {options.map((id) => <option key={id} value={id}>{tasks.get(id)?.name ?? id.slice(0, 8)}</option>)}
        </select>
        <div className="gy-focus-actions">
          <Button size="small" theme="light" type="tertiary" disabled={!taskId || mode === "pinned"} onClick={() => taskId && onPin(taskId)}>固定查看</Button>
          <Button size="small" theme="light" type="tertiary" disabled={mode !== "pinned"} onClick={onFollow}>跟随最新任务</Button>
        </div>
        <ViewedTaskControls face={viewed.face} onAct={viewed.act} task={task} archiveBusy={archiveBusy} onArchive={onArchive} />
      </div>
      {views.map((item) => (
        <GraphCard
          key={item.view}
          taskId={taskId}
          view={item.view}
          title={item.title}
          dot={item.dot}
          active={activeView === item.view}
          onOpen={(nextView) => onStage(activeView === nextView ? null : nextView)}
        />
      ))}
    </aside>
  );
}

export function GraphDetail({ taskId, view, onOpenRecord }: { taskId: string; view: ViewName; onOpenRecord: (href: string) => void }) {
  const state = useTaskGraph(taskId, view, view !== "memory", 8000);
  const [surfaceLayout, setSurfaceLayout] = useState<"both" | "graph" | "table">("both");

  if (view === "memory") {
    return <p className="gy-stage-status" role="status">普通会话不读取记忆，也不展示缓存里的记忆内容。</p>;
  }
  const graph = state.kind === "ready" ? state.graph : state.kind === "empty" ? state.graph : undefined;
  const cells = state.kind === "ready" || state.kind === "empty" ? (state.cells ?? []) : [];

  return (
    <div className="gy-graph-detail-stack">
      {(state.kind === "ready" || graph?.notes.length) && (
        <div className="gy-graph-meta-bar">
          {graph?.notes[0] && <span className="gy-graph-meta-note">{graph.notes[0]}</span>}
          <div className="gy-graph-meta-right">
            {view === "surface" && (state.kind === "ready" || state.kind === "empty") && (
              <div className="gy-surface-mode" role="group" aria-label="攻击面展示方式">
                <button type="button" className={surfaceLayout === "both" ? "is-active" : ""} onClick={() => setSurfaceLayout("both")}>图谱 + 矩阵</button>
                <button type="button" className={surfaceLayout === "graph" ? "is-active" : ""} onClick={() => setSurfaceLayout("graph")}>仅看图谱</button>
                <button type="button" className={surfaceLayout === "table" ? "is-active" : ""} onClick={() => setSurfaceLayout("table")}>仅看矩阵</button>
              </div>
            )}
            {state.kind === "ready" && (
              <span className="gy-graph-source" title={state.source}>{shortSourceLabel(state.source)}</span>
            )}
          </div>
        </div>
      )}
      {(view !== "surface" || surfaceLayout !== "table") && (
        graph && graph.nodes.length > 0
          ? <GraphStage graph={graph} taskId={taskId} view={view} onOpen={onOpenRecord} />
          : <p className="gy-stage-status" role="status">{statusText(state)}</p>
      )}
      {view === "surface" && (state.kind === "ready" || state.kind === "empty") && surfaceLayout !== "graph" && (
        <CoverageTable cells={cells} expanded={surfaceLayout === "table"} />
      )}
    </div>
  );
}

const COV_STATE_META: Record<string, { label: string; rank: number; cls: string }> = {
  verified: { label: "已证实", rank: 0, cls: "is-verified" },
  retracted: { label: "已撤回", rank: 1, cls: "is-retracted" },
  manual: { label: "人工覆盖", rank: 2, cls: "is-manual" },
  attempted: { label: "已尝试", rank: 3, cls: "is-attempted" },
  material: { label: "已有材料", rank: 4, cls: "is-material" },
  unknown: { label: "未测", rank: 5, cls: "is-unknown" },
};

function covMeta(state: string) {
  return COV_STATE_META[state] ?? { label: state, rank: 4, cls: "is-other" };
}

export function CoverageTable({
  cells,
  expanded = false,
}: {
  cells: Array<{ asset: string; technique: string; state: string; notes?: string[] }>;
  expanded?: boolean;
}) {
  const [filter, setFilter] = useState<string>("all");
  const [query, setQuery] = useState("");

  const stats = useMemo(() => {
    const counts = { all: cells.length, active: 0, verified: 0, attempted: 0, manual: 0, material: 0, retracted: 0, unknown: 0 };
    for (const c of cells) {
      if (c.state !== "unknown") counts.active += 1;
      if (c.state === "verified") counts.verified += 1;
      else if (c.state === "attempted") counts.attempted += 1;
      else if (c.state === "manual") counts.manual += 1;
      else if (c.state === "material") counts.material += 1;
      else if (c.state === "retracted") counts.retracted += 1;
      else if (c.state === "unknown") counts.unknown += 1;
    }
    return counts;
  }, [cells]);

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    return [...cells]
      .filter((cell) => {
        if (filter === "active" && cell.state === "unknown") return false;
        if (filter !== "all" && filter !== "active" && cell.state !== filter) return false;
        if (!q) return true;
        return (
          cell.asset.toLowerCase().includes(q)
          || cell.technique.toLowerCase().includes(q)
          || cell.state.toLowerCase().includes(q)
          || (cell.notes?.some((n) => n.toLowerCase().includes(q)) ?? false)
        );
      })
      .sort((a, b) => covMeta(a.state).rank - covMeta(b.state).rank || a.asset.localeCompare(b.asset) || a.technique.localeCompare(b.technique));
  }, [cells, filter, query]);

  if (!cells.length) return <p className="gy-stage-status" role="status">已有任务，暂无覆盖数据。</p>;

  const filterChips: Array<{ key: string; label: string; count: number }> = [
    { key: "all", label: "全部", count: stats.all },
    { key: "active", label: "已触达", count: stats.active },
    ...(stats.verified > 0 ? [{ key: "verified", label: "已证实", count: stats.verified }] : []),
    ...(stats.attempted > 0 ? [{ key: "attempted", label: "已尝试", count: stats.attempted }] : []),
    ...(stats.manual > 0 ? [{ key: "manual", label: "人工覆盖", count: stats.manual }] : []),
    ...(stats.material > 0 ? [{ key: "material", label: "已有材料", count: stats.material }] : []),
    ...(stats.retracted > 0 ? [{ key: "retracted", label: "已撤回", count: stats.retracted }] : []),
    ...(stats.unknown > 0 ? [{ key: "unknown", label: "未测", count: stats.unknown }] : []),
  ];

  return (
    <section className="gy-coverage-card" aria-label="攻击面覆盖矩阵">
      <header className="gy-coverage-toolbar">
        <div className="gy-coverage-chips" role="group" aria-label="覆盖状态筛选">
          <strong>覆盖矩阵</strong>
          {filterChips.map((chip) => (
            <button
              key={chip.key}
              type="button"
              className={`gy-cov-chip${filter === chip.key ? " is-active" : ""}`}
              aria-pressed={filter === chip.key}
              onClick={() => setFilter(chip.key)}
            >
              <span>{chip.label}</span>
              <small>{chip.count}</small>
            </button>
          ))}
        </div>
        <Input
          size="small"
          prefix={<IconSearch />}
          showClear
          placeholder="筛选资产或检查项…"
          value={query}
          onChange={setQuery}
          className="gy-coverage-search"
          aria-label="筛选覆盖矩阵"
        />
      </header>
      <div className={`gy-coverage-scroll${expanded ? " is-expanded" : ""}`}>
        <table className="gy-coverage-table">
          <thead>
            <tr>
              <th>资产</th>
              <th>检查项 / 手法</th>
              <th>状态</th>
            </tr>
          </thead>
          <tbody>
            {rows.length > 0 ? rows.map((cell) => {
              const meta = covMeta(cell.state);
              return (
                <tr key={`${cell.asset}:${cell.technique}`}>
                  <td className="gy-cov-asset"><code>{cell.asset}</code></td>
                  <td className="gy-cov-tech">{cell.technique}</td>
                  <td className="gy-cov-state">
                    <span className={`gy-cov-badge ${meta.cls}`} title={cell.state}>{meta.label}</span>
                    {cell.notes?.length ? <span className="gy-cov-notes">{cell.notes.join("；")}</span> : null}
                  </td>
                </tr>
              );
            }) : (
              <tr>
                <td colSpan={3} className="gy-cov-empty">当前筛选条件下无匹配项</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}

export function graphStatusText(state: GraphState): string | null {
  return statusText(state);
}

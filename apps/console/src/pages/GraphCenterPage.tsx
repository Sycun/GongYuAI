import { useEffect, useState } from "react";
import { Input } from "@douyinfe/semi-ui";
import { api, type TaskRecord } from "../api";
import { CoverageTable, graphStatusText, shortSourceLabel } from "../components/TaskGraphRail";
import { GraphStage } from "../components/GraphCanvas";
import { rememberedGraphTask, rememberGraphTask, setGraphSlot } from "../workspace/graphStore";
import { discardMemoryCache, useTaskGraph } from "../workspace/useTaskGraph";
import { resolveSurfaceDisplay, type SurfaceLayout, type ViewName } from "../workspace/model";

const views: Array<{ view: ViewName; title: string }> = [
  { view: "assets", title: "资产图" },
  { view: "surface", title: "攻击面图" },
  { view: "execution", title: "执行图" },
  { view: "memory", title: "记忆图" },
];

export function GraphCenterPage({ onOpen }: { onOpen: (href: string) => void }) {
  const [tasks, setTasks] = useState<TaskRecord[]>([]);
  const [taskId, setTaskId] = useState(rememberedGraphTask() ?? "");
  const [view, setView] = useState<ViewName>("assets");
  const [surfaceLayout, setSurfaceLayout] = useState<SurfaceLayout>("both");
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    api.tasks(controller.signal).then((result) => {
      if (controller.signal.aborted) return;
      const list = result.json.tasks ?? [];
      setTasks(list);
      setTaskId((current) => current || rememberedGraphTask() || list[0]?.id || "");
    }).catch(() => { if (!controller.signal.aborted) setFailed(true); });
    return () => controller.abort();
  }, []);
  useEffect(() => { if (taskId) rememberGraphTask(taskId); }, [taskId]);
  useEffect(() => { discardMemoryCache(); }, [view, taskId]);
  const state = useTaskGraph(taskId || null, view, Boolean(taskId), view === "memory" ? 0 : 8000);
  const graph = state.kind === "ready" ? state.graph : state.kind === "empty" ? state.graph : undefined;

  return (
    <div className="gy-graph-center">
      <header className="gy-graph-center-bar">
        <div className="gy-graph-center-pickers">
          <label className="gy-center-select-wrap">
            <span>任务</span>
            <select aria-label="图谱任务" value={taskId} onChange={(event) => setTaskId(event.target.value)}>
              <option value="">选择任务</option>
              {taskId && !tasks.some((task) => task.id === taskId) && <option value={taskId}>{taskId.slice(0, 8)}</option>}
              {tasks.map((task) => <option key={task.id} value={task.id}>{task.name}</option>)}
            </select>
          </label>
          <Input aria-label="任务编号" placeholder="或粘贴任务编号…" value={taskId} onChange={setTaskId} className="gy-center-id-input" />
        </div>
        <div className="gy-stage-tabs" role="tablist" aria-label="图谱类型">
          {views.map((item) => (
            <button
              key={item.view}
              type="button"
              role="tab"
              aria-selected={view === item.view}
              className={view === item.view ? "is-active" : ""}
              onClick={() => setView(item.view)}
            >
              {item.title}
            </button>
          ))}
        </div>
      </header>

      {failed && <p className="gy-notice" role="status">任务列表读取失败。仍可粘贴任务编号查看。</p>}

      <div className="gy-graph-meta-bar">
        <span className="gy-graph-meta-note">
          {graph?.notes[0] ?? "小图、展开视图和图谱中心共用同一份任务缓存、节点标识与选中项；Fact–Intent 因果图位于任务详情的「意图图谱」页。"}
        </span>
        <div className="gy-graph-meta-right">
          {Boolean(taskId) && view === "surface" && (state.kind === "ready" || state.kind === "empty") && (
            <div className="gy-surface-mode" role="group" aria-label="攻击面展示方式">
              <button
                type="button"
                aria-pressed={surfaceLayout === "both"}
                className={surfaceLayout === "both" ? "is-active" : ""}
                onClick={() => {
                  if (surfaceLayout !== "both") {
                    setSurfaceLayout("both");
                    setGraphSlot(taskId, view, { fitted: false });
                  }
                }}
              >
                图谱 + 矩阵
              </button>
              <button
                type="button"
                aria-pressed={surfaceLayout === "graph"}
                className={surfaceLayout === "graph" ? "is-active" : ""}
                onClick={() => {
                  if (surfaceLayout !== "graph") {
                    setSurfaceLayout("graph");
                    setGraphSlot(taskId, view, { fitted: false });
                  }
                }}
              >
                仅看图谱
              </button>
              <button
                type="button"
                aria-pressed={surfaceLayout === "table"}
                className={surfaceLayout === "table" ? "is-active" : ""}
                onClick={() => setSurfaceLayout("table")}
              >
                仅看矩阵
              </button>
            </div>
          )}
          {taskId && state.kind === "ready" && (
            <span className="gy-graph-source" title={state.source}>{shortSourceLabel(state.source)}</span>
          )}
        </div>
      </div>

      {view === "memory" && (
        <div className="gy-memory-callout" role="status">
          {state.kind === "unavailable" || state.kind === "forbidden" || state.kind === "withheld"
            ? graphStatusText(state)
            : "正在向服务端确认记忆读取权限。页面隐藏、tenantId 和返回中的 taskId 都不能作为授权；未获内部授权时不展示记忆内容，包括此前留在页面缓存中的内容。"}
        </div>
      )}

      {(() => {
        const cells = state.kind === "ready" || state.kind === "empty" ? (state.cells ?? []) : [];
        const display = resolveSurfaceDisplay(view, surfaceLayout, state.kind, cells.length);
        return (
          <div className={`gy-graph-detail-stack is-${display.layout}`} data-surface-layout={display.layout}>
            {display.showGraph && (
              taskId && view !== "memory" && graph && graph.nodes.length > 0
                ? <GraphStage graph={graph} taskId={taskId} view={view} onOpen={onOpen} />
                : view === "memory"
                  ? null
                  : <p className="gy-stage-status" role="status">{taskId ? graphStatusText(state) : "先选择任务。"}</p>
            )}

            {display.showTable && (
              <CoverageTable cells={cells} expanded={display.layout === "table"} />
            )}
          </div>
        );
      })()}

      <section className="gy-graph-center-notes">
        <h2>第二批内部能力说明</h2>
        <ul>
          <li>GET /memory/nodes 与记忆图由服务端决定。这版没有可核验身份，读取保持关闭，本页不展示返回里的节点。</li>
          <li>GET /trends、/proposals、/evaluations：客户自助入口暂缓，避免在授权修复前串读。</li>
          <li>撤回记忆时，页面只在任务级记忆图确实返回该状态后显示「节点已撤回」。旧 Hint 是否仍进入后续模型请求，以该响应里的字段为准，没有字段就不推断。</li>
        </ul>
      </section>
    </div>
  );
}

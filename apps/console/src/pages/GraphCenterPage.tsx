import { useEffect, useState } from "react";
import { Button, Input } from "@douyinfe/semi-ui";
import { api, type TaskRecord } from "../api";
import { CoverageTable } from "../components/TaskGraphRail";
import { GraphStage, GraphThumb } from "../components/GraphCanvas";
import { rememberedGraphTask, rememberGraphTask } from "../workspace/graphStore";
import { discardMemoryCache } from "../workspace/useTaskGraph";
import { graphStatusText } from "../components/TaskGraphRail";
import { useTaskGraph } from "../workspace/useTaskGraph";
import type { ViewName } from "../workspace/model";

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
      <header>
        <label>任务
          <select aria-label="图谱任务" value={taskId} onChange={(event) => setTaskId(event.target.value)}>
            <option value="">选择任务</option>
            {taskId && !tasks.some((task) => task.id === taskId) && <option value={taskId}>{taskId.slice(0, 8)}</option>}
            {tasks.map((task) => <option key={task.id} value={task.id}>{task.name}</option>)}
          </select>
        </label>
        <Input aria-label="任务编号" placeholder="或粘贴任务编号" value={taskId} onChange={setTaskId} />
        {views.map((item) => (
          <Button key={item.view} size="small" theme={view === item.view ? "solid" : "light"} onClick={() => setView(item.view)}>{item.title}</Button>
        ))}
      </header>
      {failed && <p role="status">任务列表读取失败。仍可粘贴任务编号查看。</p>}
      <p>小图、展开视图和这里使用同一份任务缓存、节点标识和选中项。Fact–Intent 关系图仍在任务的目标和历史页，它表示另一组关系。</p>
      {view === "memory" && (
        <p role="status">{state.kind === "unavailable" || state.kind === "forbidden" || state.kind === "withheld" ? graphStatusText(state) : "正在向服务端确认记忆读取权限。页面隐藏、tenantId 和返回中的 taskId 都不能作为授权；未获内部授权时不展示记忆内容，包括此前留在页面缓存中的内容。"}</p>
      )}
      {taskId && view !== "memory" && graph && graph.nodes.length > 0 && <GraphThumb graph={graph} />}
      {taskId && state.kind === "ready" && <p className="gy-graph-source">{state.source}</p>}
      {view === "surface" && (state.kind === "ready" || state.kind === "empty") && <CoverageTable cells={state.cells ?? []} />}
      {taskId && view !== "memory" && graph && graph.nodes.length > 0
        ? <GraphStage graph={graph} taskId={taskId} view={view} onOpen={onOpen} />
        : view === "memory"
          ? null
          : <p role="status">{taskId ? graphStatusText(state) : "先选择任务。"}</p>}
      <section>
        <h2>第二批内部能力</h2>
        <ul>
          <li>GET /memory/nodes 与记忆图由服务端决定。这版没有可核验身份，读取保持关闭，本页不展示返回里的节点。</li>
          <li>GET /trends、/proposals、/evaluations：客户自助入口暂缓，避免在授权修复前串读。</li>
          <li>撤回记忆时，页面只在任务级记忆图确实返回该状态后显示「节点已撤回」。旧 Hint 是否仍进入后续模型请求，以该响应里的字段为准，没有字段就不推断。</li>
        </ul>
      </section>
    </div>
  );
}

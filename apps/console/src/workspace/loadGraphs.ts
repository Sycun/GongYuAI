import { probe, type Probe } from "../api";
import {
  graphFromCells,
  graphPath,
  memoryDisplay,
  projectAssetGraph,
  projectExecutionGraph,
  readCells,
  readGraph,
  surfacePath,
  type GraphState,
  type GView,
  type ViewName,
} from "./model";

export type Getter = (path: string, signal?: AbortSignal) => Promise<Probe<unknown>>;

function failed(path: string, message: string): GraphState {
  return { kind: "failed", path, message };
}

function fromProbe(path: string, result: Probe<unknown>): GraphState | null {
  if (result.kind === "aborted") return { kind: "loading" };
  if (result.ok) return null;
  if (result.kind === "unregistered") return { kind: "unregistered", path };
  if (result.kind === "forbidden") return { kind: "forbidden", path };
  return failed(path, result.error || "读取失败");
}

function owned(graph: GView, taskId: string): GraphState {
  if (graph.taskId && graph.taskId !== taskId) {
    return { kind: "withheld", message: "响应属于另一个任务，已忽略。" };
  }
  if (graph.empty || graph.nodes.length === 0) return { kind: "empty", source: graph.view };
  return { kind: "ready", source: graph.view, graph: { ...graph, taskId } };
}

export async function loadAssetGraph(taskId: string, signal: AbortSignal, get: Getter = probe): Promise<GraphState> {
  const path = graphPath(taskId, "assets");
  const primary = await get(path, signal);
  if (signal.aborted) return { kind: "loading" };
  if (primary.ok) {
    const graph = readGraph(primary.json, "assets");
    if (!graph) return failed(path, "资产图响应无法识别");
    const state = owned(graph, taskId);
    return state.kind === "ready" || state.kind === "empty" ? { ...state, source: path } : state;
  }
  const blocked = fromProbe(path, primary);
  if (!blocked || blocked.kind !== "unregistered") return blocked ?? failed(path, "读取失败");
  const [task, assets, history] = await Promise.all([
    get(`/tasks/${encodeURIComponent(taskId)}`, signal),
    get(`/tasks/${encodeURIComponent(taskId)}/assets`, signal),
    get(`/tasks/${encodeURIComponent(taskId)}/history`, signal),
  ]);
  if (signal.aborted) return { kind: "loading" };
  if (!task.ok) return fromProbe(`/tasks/${encodeURIComponent(taskId)}`, task) ?? failed(path, "任务不存在");
  if (!assets.ok || !history.ok) return failed(path, "资产或历史读取失败");
  const assetJson = assets.json as { assets?: Array<{ address: string; kind?: string; factId?: string; intentId?: string | null; source?: string }> };
  const historyJson = history.json as { intents?: Array<{ id: string; title: string; status?: string; claimedBy?: string | null; sourceFactIds?: string[] }> };
  const graph = projectAssetGraph(taskId, assetJson.assets ?? [], historyJson.intents ?? []);
  if (graph.empty) return { kind: "empty", source: "GET /assets + /history" };
  return { kind: "ready", source: "GET /assets + /history（/graphs/assets 未注册）", graph };
}

export async function loadSurface(taskId: string, signal: AbortSignal, get: Getter = probe): Promise<GraphState> {
  const path = surfacePath(taskId);
  const result = await get(path, signal);
  if (signal.aborted) return { kind: "loading" };
  if (!result.ok) return fromProbe(path, result) ?? failed(path, "读取失败");
  const cells = readCells(result.json);
  if (!cells) return failed(path, "覆盖矩阵响应没有 cells");
  const embedded = readGraph(result.json, "surface");
  const graph = embedded && (!embedded.taskId || embedded.taskId === taskId)
    ? { ...embedded, taskId, empty: cells.length === 0 }
    : graphFromCells(taskId, cells);
  if (embedded?.taskId && embedded.taskId !== taskId) {
    return { kind: "withheld", message: "矩阵里的图属于另一个任务，已忽略。" };
  }
  if (!cells.length) return { kind: "empty", source: path, cells, graph };
  return { kind: "ready", source: path, graph, cells };
}

export async function loadExecutionGraph(taskId: string, signal: AbortSignal, get: Getter = probe): Promise<GraphState> {
  const path = graphPath(taskId, "execution");
  const primary = await get(path, signal);
  if (signal.aborted) return { kind: "loading" };
  if (primary.ok) {
    const graph = readGraph(primary.json, "execution");
    if (!graph) return failed(path, "执行图响应无法识别");
    const state = owned(graph, taskId);
    return state.kind === "ready" || state.kind === "empty" ? { ...state, source: path } : state;
  }
  const blocked = fromProbe(path, primary);
  if (!blocked || blocked.kind !== "unregistered") return blocked ?? failed(path, "读取失败");
  const [trace, jobs] = await Promise.all([
    get(`/tasks/${encodeURIComponent(taskId)}/trace`, signal),
    get(`/tasks/${encodeURIComponent(taskId)}/jobs`, signal),
  ]);
  if (signal.aborted) return { kind: "loading" };
  if (!trace.ok) return failed(path, "执行记录读取失败");
  const steps = ((trace.json as { steps?: Array<{ id: string; number: number; tools?: string[]; at?: string }> }).steps) ?? [];
  const jobRows = jobs.ok
    ? (((jobs.json as { jobs?: Array<{ id: string; label?: string; status?: string }> }).jobs) ?? [])
    : [];
  const graph = projectExecutionGraph(taskId, steps, jobRows);
  if (!jobs.ok && jobs.kind === "unregistered") graph.notes.push("作业接口未在当前控制面注册。");
  if (graph.empty) return { kind: "empty", source: "GET /trace" };
  return { kind: "ready", source: jobs.ok ? "GET /trace + /jobs（/graphs/execution 未注册）" : "GET /trace（/graphs/execution 未注册）", graph };
}

function memoryGrant(json: unknown): boolean {
  const root = json && typeof json === "object" ? json as Record<string, unknown> : null;
  const graph = root && typeof root.graph === "object" && root.graph ? root.graph as Record<string, unknown> : root;
  return graph?.access === "internal-engagement" && graph.available === true;
}

export async function loadMemoryGraph(taskId: string, signal: AbortSignal, get: Getter = probe): Promise<GraphState> {
  const path = graphPath(taskId, "memory");
  const result = await get(path, signal);
  if (signal.aborted) return { kind: "loading" };
  if (!result.ok) {
    const message = result.error || "记忆读取已关闭";
    if (result.kind === "forbidden" || result.kind === "unregistered") return { kind: "unavailable", message };
    return fromProbe(path, result) ?? failed(path, message);
  }
  const granted = memoryGrant(result.json);
  if (!granted) {
    return { kind: "unavailable", message: "服务端没有给出当前委托的内部授权，页面不展示记忆内容。" };
  }
  const graph = readGraph(result.json, "memory");
  if (!graph) return failed(path, "记忆图响应无法识别");
  const display = memoryDisplay(graph, taskId, true);
  if (display === "withheld") return { kind: "withheld", message: "记忆响应未限定到当前任务，已拒绝展示。" };
  if (display !== "show") return { kind: "unavailable", message: "记忆读取未获授权。" };
  if (graph.empty) return { kind: "empty", source: path, graph: { ...graph, taskId } };
  return { kind: "ready", source: path, graph: { ...graph, taskId } };
}

export function loadGraph(taskId: string, view: ViewName, signal: AbortSignal, get?: Getter): Promise<GraphState> {
  if (view === "assets") return loadAssetGraph(taskId, signal, get);
  if (view === "surface") return loadSurface(taskId, signal, get);
  if (view === "execution") return loadExecutionGraph(taskId, signal, get);
  return loadMemoryGraph(taskId, signal, get);
}

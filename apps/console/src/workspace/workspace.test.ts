import assert from "node:assert/strict";
import test from "node:test";
import {
  acceptPayload,
  consultLabel,
  diffNotices,
  goalOutcomeLabel,
  graphFromCells,
  jobOutcomeLabel,
  lateResultLabel,
  memoryDisplay,
  projectAssetGraph,
  providerDisposition,
  railRequests,
  readGraph,
  questionForTask,
  resolveViewedTask,
  surfacePath,
} from "./model.js";
import type { Probe } from "../api";
import type { TaskArchiveState } from "@gongyuai/contracts";
import { archiveKey, workspaceArchives } from "../chat/archives";
import { defaultProject } from "../chat/projects";
import type { Conversation } from "../chat/useConversations";
import { loadAssetGraph, loadMemoryGraph, loadSurface, type Getter } from "./loadGraphs.js";

const signal = new AbortController().signal;

test("task archives move conversations and projects only after all of their children are archived", () => {
  const conversations: Conversation[] = [
    { id: "first", title: "核对材料", updated: 0, turns: [
      { id: "turn-a", conversationId: "first", created: 0, question: "核对甲", answer: "", taskId: "a" },
      { id: "turn-b", conversationId: "first", created: 1, question: "核对乙", answer: "", submissionKey: "turn-b" },
    ] },
    { id: "second", title: "补充记录", updated: 0, turns: [] },
  ];
  const tasks = new Map<string, TaskArchiveState>([
    ["a", { id: "a", name: "核对甲", status: "completed", archivedAt: "2026-11-24T01:00:00Z" }],
    ["b", { id: "b", name: "核对乙", status: "paused", archivedAt: null, submissionKey: "turn-b" }],
  ]);
  const state = (isSubmitting = false) => workspaceArchives({
    projects: ["材料核对", "空项目"], conversations, tasks, projectOf: () => "材料核对",
    linkedTaskOf: id => id === "first" ? "a" : undefined,
    isSubmitting: id => id === "first" && isSubmitting,
    localArchives: new Set([archiveKey("chat", "second"), archiveKey("project", "空项目")]),
  });
  assert.deepEqual([...state().archivedChats], ["second"]);
  assert.deepEqual([...state().archivedProjects], ["空项目"]);

  tasks.get("b")!.archivedAt = "2026-11-24T01:00:00Z";
  assert.deepEqual([...state().archivedChats], ["first", "second"]);
  assert.deepEqual([...state().archivedProjects], ["材料核对", "空项目"]);
  assert.equal(state(true).archivedProjects.has("材料核对"), false);

  tasks.get("a")!.archivedAt = null;
  assert.deepEqual([...state().archivedChats], ["second"]);
  assert.equal(state().archivedProjects.has("材料核对"), false);
});

test("the default conversation area stays active with a legacy archive flag or all its chats archived", () => {
  const state = (conversations: Conversation[]) => workspaceArchives({
    projects: [defaultProject, "另一个项目"], conversations, tasks: new Map(), projectOf: () => defaultProject,
    linkedTaskOf: () => undefined, isSubmitting: () => false,
    localArchives: new Set([
      archiveKey("project", defaultProject), archiveKey("project", "另一个项目"), archiveKey("chat", "old-chat"),
    ]),
  });

  assert.deepEqual([...state([]).archivedProjects], ["另一个项目"]);
  const populated = state([{ id: "old-chat", title: "旧会话", updated: 0, turns: [] }]);
  assert.deepEqual([...populated.archivedChats], ["old-chat"]);
  assert.deepEqual([...populated.archivedProjects], ["另一个项目"]);
});

function ok(json: unknown): Promise<Probe<unknown>> {
  return Promise.resolve({ ok: true, status: 200, json, text: "", kind: "ok" });
}
function status(code: number, kind: "unregistered" | "forbidden" | "failed"): Promise<Probe<unknown>> {
  return Promise.resolve({ ok: false, status: code, error: kind, kind });
}

test("pinned task stays selected and follow uses the latest receipt", () => {
  const turns = [{ taskId: "A" }, { taskId: "B" }];
  assert.equal(resolveViewedTask({ turns, linkedTaskId: "C" }).taskId, "B");
  assert.equal(resolveViewedTask({ stored: { mode: "pinned", taskId: "A" }, turns }).taskId, "A");
  assert.equal(resolveViewedTask({ turns: [], linkedTaskId: null }).mode, "waiting");
});

test("the plan question belongs to the viewed task, not the latest turn", () => {
  const turns = [
    { id: "t1", taskId: "A", question: "从会议材料 A 提取三个决定" },
    { id: "t2", taskId: "B", question: "从会议材料 B 提取待确认事项" },
  ];
  assert.deepEqual(questionForTask(turns, "A"), { turnId: "t1", taskId: "A", question: "从会议材料 A 提取三个决定" });
  assert.equal(questionForTask(turns, "manual"), null);
});

test("a late payload for A is dropped while B is on screen", () => {
  assert.equal(acceptPayload("A", "B", { body: "A 的正文" }), null);
  assert.deepEqual(acceptPayload("B", "B", { body: "B 的正文" }), { body: "B 的正文" });
});

test("rail requests never include the independent surface graph or memory", () => {
  const paths = railRequests("task-1");
  assert.deepEqual(paths, [
    "/tasks/task-1/graphs/assets",
    "/tasks/task-1/coverage-matrix",
    "/tasks/task-1/graphs/execution",
  ]);
  assert.equal(paths.some((path) => path.includes("/graphs/surface") || path.endsWith("/memory")), false);
  assert.equal(surfacePath("task-1"), "/tasks/task-1/coverage-matrix");
});

test("surface thumbnail and table share the matrix cells, including a retraction", () => {
  const cells = [{ asset: "app.example", technique: "CWE-89", state: "retracted", notes: ["唯一依据已撤回"] }];
  const graph = graphFromCells("task-1", cells);
  assert.equal(graph.edges[0]?.broken, true);
  assert.equal(graph.edges[0]?.label, "retracted");
  assert.equal(graph.view, "surface");
});

test("asset projection marks a missing intent as broken and does not invent lineage", () => {
  const graph = projectAssetGraph("task-1", [
    { address: "10.0.0.8", kind: "admitted", factId: "f1", intentId: "missing" },
  ], []);
  assert.equal(graph.edges.some((edge) => edge.broken), true);
  assert.equal(graph.nodes.some((node) => node.kind === "intent" && node.badge === "unknown"), true);
});

test("memory stays unavailable unless the server grants the current engagement", () => {
  assert.equal(memoryDisplay({ taskId: "A", nodes: [{ data: { taskId: "A" } }] }, "A"), "unavailable");
  assert.equal(memoryDisplay({ taskId: "A", nodes: [{ data: { taskId: "A" } }] }, "A", false), "unavailable");
  assert.equal(memoryDisplay({ taskId: "A", nodes: [] }, "B", true), "withheld");
  assert.equal(memoryDisplay({ taskId: "A", nodes: [{ data: { taskIds: ["A", "B"] } }] }, "A", true), "withheld");
  assert.equal(memoryDisplay({ taskId: "A", nodes: [{ data: { taskId: "A" } }] }, "A", true), "show");
});

test("asset loader does not project when the graph route is forbidden", async () => {
  const calls: string[] = [];
  const get: Getter = (path) => {
    calls.push(path);
    return path.endsWith("/graphs/assets") ? status(403, "forbidden") : ok({ assets: [{ address: "secret.example" }] });
  };
  const state = await loadAssetGraph("task-1", signal, get);
  assert.equal(state.kind, "forbidden");
  assert.deepEqual(calls, ["/tasks/task-1/graphs/assets"]);
});

test("asset loader projects registered assets only after the graph route is missing", async () => {
  const get: Getter = (path) => {
    if (path.endsWith("/graphs/assets")) return status(404, "unregistered");
    if (path.endsWith("/assets")) return ok({ assets: [{ address: "app.example", kind: "live", factId: "f1" }] });
    if (path.endsWith("/history")) return ok({ intents: [] });
    return ok({ id: "task-1" });
  };
  const state = await loadAssetGraph("task-1", signal, get);
  assert.equal(state.kind, "ready");
  if (state.kind === "ready") {
    assert.match(state.source, /\/assets/);
    assert.equal(state.graph.nodes[0]?.label, "app.example");
  }
});

test("a graph body for task A is not accepted as task B", async () => {
  const get: Getter = () => ok({
    graph: { taskId: "A", view: "assets", nodes: [{ id: "n", kind: "asset", label: "only-a", data: {} }], edges: [] },
  });
  const state = await loadAssetGraph("B", signal, get);
  assert.equal(state.kind, "withheld");
});

test("surface loader reads only the matrix and keeps cells with the graph", async () => {
  const calls: string[] = [];
  const get: Getter = (path) => {
    calls.push(path);
    if (path.endsWith("/graphs/surface")) return ok({ graph: { taskId: "task-1", view: "surface", nodes: [{ id: "stale", kind: "asset", label: "stale", data: {} }], edges: [] } });
    return ok({
      cells: [{ asset: "app.example", technique: "CWE-89", state: "retracted" }],
      graph: {
        taskId: "task-1",
        view: "surface",
        nodes: [{ id: "asset:app.example", kind: "asset", label: "app.example", data: { address: "app.example" } }],
        edges: [{ id: "e", from: "asset:app.example", to: "technique:CWE-89", kind: "retracted", label: "retracted", broken: true }],
      },
    });
  };
  const state = await loadSurface("task-1", signal, get);
  assert.equal(calls.includes("/tasks/task-1/graphs/surface"), false);
  assert.equal(state.kind, "ready");
  if (state.kind === "ready") {
    assert.equal(state.cells?.[0]?.state, "retracted");
    assert.equal(state.graph.edges[0]?.broken, true);
  }
});

test("progress text is added only for a plan change, result, block, or decision", () => {
  const base = { plan: "g1", result: "", block: "", decision: "", planText: "核对范围", resultText: "", blockText: "", decisionText: "" };
  assert.deepEqual(diffNotices(null, { ...base, result: "r1", resultText: "发现门户" }), []);
  assert.deepEqual(diffNotices(base, base), []);
  assert.deepEqual(diffNotices(base, { ...base, result: "r1", resultText: "发现门户" }), ["收到结果。发现门户"]);
  assert.deepEqual(diffNotices(base, { ...base, decision: "c1", decisionText: "是否继续" }), ["需要你决定。是否继续"]);
});

test("job success and goal pass stay distinct, and a released consult stays unanswered", () => {
  assert.equal(jobOutcomeLabel("succeeded"), "作业执行成功");
  assert.equal(goalOutcomeLabel(true), "业务目标通过");
  assert.notEqual(jobOutcomeLabel("succeeded"), goalOutcomeLabel(true));
  assert.equal(consultLabel({ status: "open" }), "待答");
  assert.equal(lateResultLabel(true), "范围已变化，待复核");
});

test("blocked provider action stays blocked when egress is still allowed", () => {
  const view = providerDisposition("blocked", true);
  assert.equal(view.label, "已阻塞");
  assert.equal(view.raw.egressAllowed, true);
  assert.equal(providerDisposition("retry").label, "计划重试");
  assert.equal(providerDisposition("switch").label, "计划切换");
});

test("a memory body is not shown when the server omits an internal grant", async () => {
  const secret = "虚构委托记忆-不应出现";
  const get: Getter = () => ok({
    graph: {
      taskId: "task-1",
      view: "memory",
      nodes: [{ id: "m", kind: "memory", label: secret, data: { taskId: "task-1" } }],
      edges: [],
    },
  });
  const state = await loadMemoryGraph("task-1", signal, get);
  assert.equal(state.kind, "unavailable");
  assert.equal(JSON.stringify(state).includes(secret), false);
});

test("graph parser rejects a view that does not match the requested picture", () => {
  assert.equal(readGraph({ graph: { view: "surface", nodes: [], edges: [] } }, "assets"), null);
});

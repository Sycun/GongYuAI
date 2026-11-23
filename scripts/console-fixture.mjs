/**
 * 浏览器验收用的虚构控制面。只实现当前页面会调用的路径，
 * 不替代正式服务。/graphs/surface 故意返回过期覆盖，用来确认页面不读取它。
 */
import http from "node:http";

const now = "2026-11-23T01:16:00.000Z";
const normal = "11111111-1111-4111-8111-111111111111";
const empty = "22222222-2222-4222-8222-222222222222";
const failed = "33333333-3333-4333-8333-333333333333";
const slowA = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const fastB = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const paused = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const retracted = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const evidence = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const forbidden = "44444444-4444-4444-8444-444444444444";
const stats = { surface: 0, memory: 0, handoff: 0 };

const pausedJob = {
  id: "job-paused",
  label: "对照纪要",
  status: "running",
  kind: "material-check",
  lateResult: false,
  inputs: [{ path: "minutes-a.txt", sha256: null }],
  artifacts: [],
};
setTimeout(() => {
  pausedJob.status = "succeeded";
  pausedJob.lateResult = true;
  pausedJob.artifacts = [{ path: "diff.txt", sha256: "abc" }];
}, 1200);

function task(id, name, status) {
  return {
    id, name, status, mock: true, scopeVersion: 2, fence: 1,
    leaseOwner: null, leaseUntil: null, workerPid: null, containerId: null, dataDir: "/tmp/fixture",
    auth: { authorizationNote: "虚构委托", targets: ["app.example"], outOfScope: [] },
    goals: [{ id: "goal-1", title: "汇总一致结论", description: "对照两份会议材料", evidencePatterns: [], passes: false }],
    budget: { maxTokens: 1, maxWallMs: 1, maxToolCalls: 1, maxInstalls: 0 },
    usage: { tokens: 0, toolCalls: 0, installs: 0 },
    error: null, createdAt: now, updatedAt: now,
  };
}

const tasks = [
  task(normal, "对照会议材料", "running"),
  task(empty, "空委托", "completed"),
  task(failed, "失败委托", "failed"),
  task(slowA, "迟到任务 A", "running"),
  task(fastB, "当前任务 B", "running"),
  task(paused, "已暂停仍收结果", "paused"),
  task(retracted, "撤回后的覆盖", "completed"),
  task(evidence, "证据迟到", "completed"),
  task(forbidden, "无权任务", "running"),
];

function graph(id, label) {
  return {
    graph: {
      taskId: id,
      view: "assets",
      generatedAt: now,
      empty: false,
      nodes: [{ id: `asset:${label}`, kind: "asset", label, badge: "live", data: { address: label } }],
      edges: [],
      notes: [`最近变化 ${label}`],
    },
  };
}

function send(res, code, body, type = "application/json; charset=utf-8") {
  res.writeHead(code, { "content-type": type, "cache-control": "no-store" });
  res.end(typeof body === "string" ? body : JSON.stringify(body));
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  const path = url.pathname;
  if (path === "/__fixture/stats") return send(res, 200, stats);
  if (path === "/health") return send(res, 200, { ok: true });
  if (path === "/chat/models") {
    return send(res, 200, {
      defaultId: "fixture",
      profiles: [{ id: "fixture", name: "Fixture", protocol: "openai", baseUrl: "http://127.0.0.1:8877", modelId: "fixture", models: ["fixture"], hasKey: false }],
    });
  }
  if (path === "/settings/approval") return send(res, 200, { scope: "read-only", reviewer: null });
  if (path === "/overview") {
    return send(res, 200, { total: tasks.length, active: 4, byStatus: { running: 4, completed: 3, failed: 1, paused: 1 }, recent: tasks.slice(0, 4) });
  }
  if (path === "/tasks" && req.method === "GET") return send(res, 200, { tasks });
  if (path === "/tasks/submit" && req.method === "POST") {
    return send(res, 201, { taskId: normal, status: "running", model: "fixture" });
  }
  if (path === "/today") {
    const tenant = url.searchParams.get("tenantId");
    if (tenant === "boom") return send(res, 500, { error: "today failed" });
    if (tenant === "none") return send(res, 200, { tasks: [], generatedAt: now });
    return send(res, 200, {
      generatedAt: now,
      tasks: [{
        taskId: normal, name: "对照会议材料", status: "running", scopeVersion: 2,
        runningJobs: 1, openQuestions: 1, blockedGoals: 1, staleFacts: 0, nextAction: "回答人工求助", consultId: "consult-1",
      }],
    });
  }

  const match = path.match(/^\/tasks\/([^/]+)(.*)$/);
  if (!match) return send(res, 404, { error: "not found" });
  const id = decodeURIComponent(match[1]);
  const rest = match[2] || "";
  const found = tasks.find((item) => item.id === id);
  if (!found) return send(res, 404, { error: "not found" });
  if (rest === "/assignment" || rest.startsWith("/submissions/")) {
    return send(res, 200, { taskId: id, status: found.status, model: "fixture", result: id === normal ? "两份材料都写了下周三评审。" : "" });
  }
  if (rest === "" && req.method === "GET") return send(res, 200, { task: found });
  if (["/pause", "/stop", "/resume", "/start"].includes(rest) && req.method === "POST") {
    found.status = rest === "/pause" ? "paused" : rest === "/resume" || rest === "/start" ? "running" : "stopped";
    return send(res, 200, { task: found });
  }
  if (id === failed && ["/graphs/assets", "/graphs/execution", "/coverage-matrix", "/jobs", "/history"].includes(rest)) {
    return send(res, 500, { error: "fixture failure" });
  }
  if (id === forbidden && (rest.startsWith("/graphs/") || rest === "/coverage-matrix")) return send(res, 403, { error: "forbidden" });
  if (rest === "/graphs/surface") {
    stats.surface += 1;
    return send(res, 200, { graph: { taskId: id, view: "surface", nodes: [{ id: "stale", kind: "asset", label: "过期覆盖", data: {} }], edges: [], notes: ["这是过期的 surface"] } });
  }
  if (rest === "/graphs/memory") {
    stats.memory += 1;
    const body = graph(id, "memory-node");
    body.graph.view = "memory";
    body.graph.nodes[0].kind = "memory";
    body.graph.nodes[0].data = { taskId: id };
    return send(res, 200, body);
  }
  if (rest === "/graphs/assets" || rest === "/graphs/execution") {
    if (id === slowA) await new Promise((resolve) => setTimeout(resolve, 900));
    if (id === empty) return send(res, 200, { graph: { taskId: id, view: rest.endsWith("assets") ? "assets" : "execution", nodes: [], edges: [], empty: true, notes: [] } });
    const label = id === slowA ? "资产-A" : id === fastB ? "资产-B" : id === retracted ? "app.example" : "app.example";
    const body = graph(id, label);
    body.graph.view = rest.endsWith("execution") ? "execution" : "assets";
    if (rest.endsWith("execution")) {
      body.graph.nodes = [{ id: "job:job-1", kind: "job", label: "对照纪要", badge: "succeeded", data: { jobId: "job-1", status: "succeeded" } }];
      body.graph.notes = ["作业执行成功，业务目标仍未通过"];
    }
    return send(res, 200, body);
  }
  if (rest === "/coverage-matrix") {
    if (id === empty) return send(res, 200, { cells: [], graph: { taskId: id, view: "surface", nodes: [], edges: [], empty: true } });
    const state = id === retracted ? "retracted" : "verified";
    return send(res, 200, {
      cells: [{ asset: "app.example", technique: "CWE-89", state, notes: state === "retracted" ? ["唯一依据已撤回"] : [] }],
      graph: {
        taskId: id, view: "surface", generatedAt: now, empty: false,
        nodes: [
          { id: "asset:app.example", kind: "asset", label: "app.example", badge: null, data: { address: "app.example" } },
          { id: "technique:CWE-89", kind: "technique", label: "CWE-89", badge: state, data: {} },
        ],
        edges: [{ id: "e", from: "asset:app.example", to: "technique:CWE-89", kind: state, label: state, broken: state === "retracted" }],
        notes: [state === "retracted" ? "矩阵已撤回" : "矩阵已验证"],
      },
    });
  }
  if (rest === "/history") {
    if (id === empty) return send(res, 200, { overview: "", goals: [], facts: [], intents: [], events: [], findings: [] });
    return send(res, 200, {
      overview: "虚构委托",
      goals: found.goals,
      facts: [{ id: "fact-1", layer: "title", title: "下周三评审", summary: "两边一致", createdAt: now }],
      intents: [{ id: "intent-1", title: "汇总一致结论", status: "claimed", claimedBy: "记录员", sourceFactIds: [] }],
      events: [],
      findings: [{ id: "finding-1", title: "预算不一致", asset: "app.example", vulnClass: "CWE-89", severity: "low", confidence: "medium", status: "tentative", dedupKey: "k", evidence: [], createdAt: now }],
    });
  }
  if (rest === "/assets") return send(res, 200, { assets: id === empty ? [] : [{ address: "app.example", kind: "live", factId: "fact-1", title: "应用", summary: "会议里提到的应用", source: "discover", createdAt: now }] });
  if (rest === "/runtime") return send(res, 200, { leaseOwner: null, leaseUntil: null, fence: 1, workerPid: null, containerId: null, workerStatus: {}, hasCheckpoint: false, dataDir: "/tmp", externalState: found.status === "paused" ? "paused" : "running", scopeVersion: 2 });
  if (rest === "/trace") return send(res, 200, { steps: [], nextBefore: null });
  if (rest === "/jobs" || rest.startsWith("/jobs")) {
    if (id === empty) return send(res, 200, { jobs: [] });
    if (id === paused) return send(res, 200, { jobs: [pausedJob] });
    if (rest === "/jobs/job-1/retry" || rest === "/jobs/job-paused/retry") return send(res, 202, { job: { ...pausedJob, status: "queued" } });
    return send(res, 200, { jobs: [{ id: "job-1", label: "对照纪要", status: "succeeded", kind: "material-check", lateResult: false, inputs: [{ path: "a.txt" }], artifacts: [{ path: "out.txt" }] }] });
  }
  if (rest === "/consults") {
    if (id === empty) return send(res, 200, { consults: [] });
    return send(res, 200, { consults: [{ id: "consult-1", question: "预算以哪一份为准？", status: "open", blocking: false, releasedAt: now, options: ["甲", "乙"] }] });
  }
  if (rest === "/handoff") {
    stats.handoff += 1;
    return send(res, 200, { taskId: id, generatedAt: now, scopeVersion: 2, status: found.status, openQuestions: [{ id: "consult-1", question: "预算以哪一份为准？", blocking: false, releasedAt: now }], notes: ["按当前时间生成"] });
  }
  if (rest === "/evidence" && req.method === "GET") return send(res, 200, { files: [{ path: "a.txt", size: 4, mtime: now }, { path: "b.txt", size: 4, mtime: now }] });
  if (rest === "/evidence/file") {
    const file = url.searchParams.get("path");
    if (file === "a.txt") await new Promise((resolve) => setTimeout(resolve, 1200));
    return send(res, 200, `正文 ${file}`, "text/plain; charset=utf-8");
  }
  if (rest === "/evidence" && req.method === "POST") return send(res, 201, { path: "saved.txt" });
  if (rest === "/logs") return send(res, 200, "（空）", "text/plain; charset=utf-8");
  if (rest === "/delivery") return send(res, 200, { summary: "虚构摘要", hasReport: false });
  if (rest === "/scorecard") {
    return send(res, 200, { scorecard: { taskId: id, capturedAt: now, snapshotSha256: "abc", denominator: 1, totalGoals: 1, applicable: true, historicallyPassed: 0, currentlySupported: 0, unknownAttribution: 0, retractedReferences: 0, coverage: { tested: 1, partial: 0, blocked: 0, untested: 0, unregistered: 1 }, findings: { verified: 0, tentative: 0, retracted: 0, other: 0 }, goals: [{ goalId: "goal-1", title: "汇总", historicalPass: false, currentSupported: false, verdict: "not-passed", coverage: "unregistered", missingAttribution: false }] } });
  }
  return send(res, 404, { error: "not found" });
});

server.listen(8877, "127.0.0.1", () => {
  console.log("console fixture http://127.0.0.1:8877");
});

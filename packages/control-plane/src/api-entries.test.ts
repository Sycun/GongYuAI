/**
 * 新增正常入口的 API 验收：
 * - 原始材料差异核算 POST/GET /tasks/:id/reconcile（验收项 2）
 * - 客户复测申请 POST/GET /tasks/:id/retest-requests（验收项 6）
 * - 同一委托内跨任务署名复核 POST/GET /tasks/:id/peer-reviews + 委托隔离（验收项 6）
 *
 * 全部通过 HTTP 正常入口调用，不直接改数据库。
 */
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { CreateTaskRequestSchema } from "@gongyuai/contracts";
import { openHistory } from "@gongyuai/history";
import { bootControlPlane, taskPaths } from "./index.js";

const BASELINE_CSV = "host,role,version\napp-a-1,web,1.4\napp-a-2,db,2.1\n";
const CURRENT_CSV = "host,role,version\napp-a-1,web,1.5\napp-a-2,db,2.1\napp-a-3,worker,1.0\n";

async function fixture(t: TestContext, options: { engagementId?: string; name?: string } = {}) {
  const root = mkdtempSync(join(tmpdir(), "gy-api-"));
  const plane = await bootControlPlane({ dataRoot: root, host: "127.0.0.1", port: 0, runtime: "local", watchdogMs: 60_000 });
  t.after(async () => { await plane.close(); rmSync(root, { recursive: true, force: true }); });
  const task = plane.store.createTask(CreateTaskRequestSchema.parse({
    name: options.name ?? "入口验收委托",
    ...(options.engagementId ? { engagementId: options.engagementId } : {}),
    auth: { targets: ["diff.invalid"], authorizationNote: "虚构材料，仅用于工程验收" },
    goals: [{ id: "asset-baseline", title: "资产基线核对", description: "核对两份原始清单", evidencePatterns: ["reconcile/*.json"] }],
    mock: true,
  }));
  const paths = taskPaths(task.dataDir);
  const history = openHistory({ dbPath: paths.historyDb, evidenceDir: paths.evidenceDir });
  history.seedGoals(task.id, task.goals);
  t.after(() => history.close());
  return { plane, task, paths, history, base: plane.url + "/tasks/" + task.id };
}

async function call(method: string, url: string, body?: unknown) {
  const res = await fetch(url, {
    method,
    ...(body === undefined ? {} : {
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  });
  const text = await res.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch { /* markdown/text endpoints */ }
  return { status: res.status, text, json };
}

async function upload(base: string, path: string, content: string) {
  const res = await call("POST", base + "/evidence", { path, content });
  assert.equal(res.status, 201, res.text);
}

test("原始材料差异核算：正常入口导入两份材料后算出新增/移除/变更/未变，并落成带哈希的证据", async (t) => {
  const { task, paths, base } = await fixture(t);
  await upload(base, "inventory/baseline.csv", BASELINE_CSV);
  await upload(base, "inventory/current.csv", CURRENT_CSV);

  const run = await call("POST", base + "/reconcile", {
    name: "asset-diff",
    baseline: { path: "inventory/baseline.csv" },
    current: { path: "inventory/current.csv" },
    keyField: "host",
  });
  assert.equal(run.status, 201, run.text);
  const { result, evidencePath, evidenceSha256, factId } = run.json;
  assert.deepEqual(
    { added: result.counts.added, removed: result.counts.removed, changed: result.counts.changed, unchanged: result.counts.unchanged, missing: result.counts.missing, unknown: result.counts.unknown },
    { added: 1, removed: 0, changed: 1, unchanged: 1, missing: 0, unknown: 0 },
  );
  const changed = result.items.find((item: { key: string }) => item.key === "app-a-1");
  assert.deepEqual(changed.changes, [{ field: "version", before: "1.4", after: "1.5" }]);
  assert.equal(changed.baselineLine, 2);
  assert.equal(changed.currentLine, 2);

  // 结果本身落成证据，SHA-256 与文件字节一致。
  assert.ok(existsSync(join(paths.evidenceDir, evidencePath)), evidencePath);
  const bytes = readFileSync(join(paths.evidenceDir, evidencePath));
  const { createHash } = await import("node:crypto");
  assert.equal(createHash("sha256").update(bytes).digest("hex"), evidenceSha256);
  assert.ok(factId);
  assert.equal(result.baseline.sha256, createHash("sha256").update(Buffer.from(BASELINE_CSV)).digest("hex"));
  assert.equal(result.current.sha256, createHash("sha256").update(Buffer.from(CURRENT_CSV)).digest("hex"));

  const listed = await call("GET", base + "/reconcile");
  assert.equal(listed.status, 200);
  assert.equal(listed.json.results.length, 1);
  assert.equal(listed.json.results[0].evidencePath, evidencePath);
});

test("原始材料缺失：核算返回缺件/未知，而不是猜一个结论", async (t) => {
  const { base } = await fixture(t);
  await upload(base, "inventory/current.csv", CURRENT_CSV);
  const run = await call("POST", base + "/reconcile", {
    name: "asset-diff-missing",
    baseline: { path: "inventory/baseline.csv" },
    current: { path: "inventory/current.csv" },
    keyField: "host",
    requiredKeys: ["app-a-2"],
  });
  assert.equal(run.status, 201, run.text);
  assert.deepEqual(run.json.result.missingMaterials, ["inventory/baseline.csv"]);
  assert.equal(run.json.result.counts.unknown, run.json.result.counts.totalKeys);
  assert.equal(run.json.counts?.added ?? 0, 0);
  assert.ok(run.json.result.items.every((item: { status: string }) => item.status === "unknown"));
});

test("客户复测申请：正常入口登记、署名与依据留痕，复测完成后关闭申请", async (t) => {
  const { base, history, task, paths } = await fixture(t);
  await upload(base, "findings/proof.txt", "越权读取响应 200\n");
  const { finding } = history.recordFinding({
    taskId: task.id, title: "越权读取", asset: "diff.invalid", vulnClass: "CWE-639", severity: "high",
  });
  history.verifyFinding(task.id, finding.id, { evidencePaths: ["findings/proof.txt"], repro: "curl …" });
  await upload(base, "client/request.md", "客户工单：请在整改后复测该结论\n");

  const request = await call("POST", base + "/retest-requests", {
    requester: "客户安全负责人",
    role: "客户方",
    findingIds: [finding.id],
    reason: "整改已完成，请复测该结论",
    evidencePath: "client/request.md",
  });
  assert.equal(request.status, 201, request.text);
  assert.equal(request.json.request.status, "pending");
  assert.ok(request.json.request.sha256, "申请依据要做哈希留存");

  const listed = await call("GET", base + "/retest-requests");
  assert.equal(listed.json.requests.length, 1);
  assert.equal(listed.json.requests[0].requester, "客户安全负责人");

  // 未知结论不能申请复测。
  const bogus = await call("POST", base + "/retest-requests", {
    requester: "客户", findingIds: ["11111111-1111-4111-8111-111111111111"], reason: "x",
  });
  assert.equal(bogus.status, 400);

  await upload(base, "remediation/retest.txt", "复测：返回 403\n");
  const retest = await call("POST", `${base}/findings/${finding.id}/retest`, {
    result: "fixed",
    evidencePaths: ["remediation/retest.txt"],
    repro: "复测请求返回 403",
  });
  assert.equal(retest.status, 201, retest.text);
  assert.equal(retest.json.fulfilledRequests.length, 1);
  assert.equal(retest.json.fulfilledRequests[0].status, "fulfilled");
  assert.equal(retest.json.fulfilledRequests[0].fulfilledResult, "fixed");

  // 历史只追加：申请记录仍在，状态变为 fulfilled。
  const after = await call("GET", base + "/retest-requests");
  assert.equal(after.json.requests.length, 1);
  assert.equal(after.json.requests[0].status, "fulfilled");
  assert.ok(existsSync(join(paths.historyDb)));
});

test("同一委托内跨任务署名复核：同委托通过，跨委托拒绝，历史只追加", async (t) => {
  const { plane } = await (async () => {
    const root = mkdtempSync(join(tmpdir(), "gy-peer-"));
    const plane = await bootControlPlane({ dataRoot: root, host: "127.0.0.1", port: 0, runtime: "local", watchdogMs: 60_000 });
    t.after(async () => { await plane.close(); rmSync(root, { recursive: true, force: true }); });
    return { plane };
  })();

  const makeTask = (name: string, engagementId: string) => {
    const task = plane.store.createTask(CreateTaskRequestSchema.parse({
      name,
      engagementId,
      auth: { targets: ["peer.invalid"], authorizationNote: "虚构委托，仅用于工程验收" },
      goals: [{ id: "g", title: "目标", description: "离线验收", evidencePatterns: ["g.txt"] }],
      mock: true,
    }));
    const paths = taskPaths(task.dataDir);
    const history = openHistory({ dbPath: paths.historyDb, evidenceDir: paths.evidenceDir });
    history.seedGoals(task.id, task.goals);
    history.close();
    return task;
  };

  const main = makeTask("主任务", "engagement-1");
  const sibling = makeTask("同委托另一任务", "engagement-1");
  const foreign = makeTask("别的委托", "engagement-2");
  const base = plane.url + "/tasks/" + main.id;

  const sameEngagement = await call("POST", base + "/peer-reviews", {
    reviewer: "复核丙",
    role: "second reviewer",
    sourceTaskId: sibling.id,
    factId: "origin",
    decision: "confirm",
    basis: "同委托另一任务的结论与本次材料一致",
  });
  assert.equal(sameEngagement.status, 201, sameEngagement.text);
  assert.equal(sameEngagement.json.review.engagementId, "engagement-1");

  const crossEngagement = await call("POST", base + "/peer-reviews", {
    reviewer: "复核丙",
    role: "second reviewer",
    sourceTaskId: foreign.id,
    factId: "origin",
    decision: "confirm",
    basis: "跨委托",
  });
  assert.equal(crossEngagement.status, 409, crossEngagement.text);
  assert.match(crossEngagement.json.error, /跨委托复核被拒绝/);

  const selfTask = await call("POST", base + "/peer-reviews", {
    reviewer: "复核丙", role: "second reviewer", sourceTaskId: main.id, factId: "origin",
    decision: "confirm", basis: "同任务不属于跨任务复核",
  });
  assert.equal(selfTask.status, 400);

  const listed = await call("GET", base + "/peer-reviews");
  assert.equal(listed.json.reviews.length, 1, "被拒绝的复核不得写入");
  assert.equal(listed.json.reviews[0].reviewer, "复核丙");
  assert.equal(listed.json.reviews[0].sourceTaskId, sibling.id);

  // 另写一条 challenge，历史两条都在（append-only）。
  const second = await call("POST", base + "/peer-reviews", {
    reviewer: "复核丁", role: "质量负责人", sourceTaskId: sibling.id, factId: "origin",
    decision: "challenge", basis: "依据不足，请补材料",
  });
  assert.equal(second.status, 201, second.text);
  const all = await call("GET", base + "/peer-reviews");
  assert.deepEqual(all.json.reviews.map((r: { decision: string }) => r.decision), ["confirm", "challenge"]);
});

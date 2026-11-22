/**
 * 第八轮 API 回归：业务核算目标的正常建档入口，以及材料导入/替换/撤回、
 * 按目标配置核算、操作员触发判定这几条正常入口。
 *
 * 关注点（对应上轮复核的两条缺陷）：
 * 1. 建档只给 business 配置，服务端派生 evidencePatterns 与 reconcileGate，
 *    落库、目标详情、恢复后的任务读到的是同一份配置；
 * 2. 首次通过必须由按目标配置算出的、输入仍有效的核算结果支撑；撤走/替换
 *    材料后旧结果不能支撑通过，而重复触发只产生一条首次通过事件。
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { bootControlPlane } from "./index.js";

const BASELINE = "host,role,version\napp-a-1,web,1.4\napp-a-2,db,2.1\n";
const CURRENT = "host,role,version\napp-a-1,web,1.5\napp-a-2,db,2.1\n";
const CONFLICTING = "host,role,version\napp-a-1,web,1.5\napp-a-1,web,9.9\napp-a-2,db,2.1\n";

function post(value: unknown): RequestInit {
  return { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(value) };
}

async function json<T>(base: string, path: string, init?: RequestInit): Promise<{ status: number; body: T }> {
  const res = await fetch(`${base}${path}`, init);
  const text = await res.text();
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  return { status: res.status, body: body as T };
}

type TaskBody = {
  task: {
    id: string;
    goals: Array<{
      id: string;
      kind?: string;
      business?: { name: string; keyField: string; baseline: { path: string } };
      evidencePatterns: string[];
      reconcileGate?: { pattern: string; maxUnknown: number; maxAmbiguous: number };
      passes: boolean;
    }>;
  };
};

async function bootPlane(t: { after: (fn: () => Promise<void>) => void }) {
  const root = mkdtempSync(join(tmpdir(), "gy-biz-goal-"));
  const plane = await bootControlPlane({
    dataRoot: root,
    host: "127.0.0.1",
    port: 0,
    runtime: "local",
    // 本测试不依赖 worker 跑完；watchdog 拉长，避免它替我们判通过。
    watchdogMs: 60_000,
  });
  t.after(async () => {
    await plane.close();
    rmSync(root, { recursive: true, force: true });
  });
  return plane;
}

async function createBusinessTask(base: string, goalId = "biz-diff"): Promise<string> {
  const created = await json<TaskBody>(base, "/tasks", post({
    name: "业务核算 API 回归",
    mock: true,
    auth: { authorizationNote: "虚构材料：仅用于业务核算目标的接口回归", targets: ["diff.example.com"] },
    goals: [
      {
        id: goalId,
        title: "两份原始清单完成差异比对",
        description: "操作员声明要对照基线与当前两份原始清单",
        kind: "business-reconcile",
        // 故意不给 evidencePatterns / reconcileGate：由服务端从 business 派生。
        business: {
          name: "asset-diff",
          keyField: "host",
          maxUnknown: 0,
          maxAmbiguous: 0,
          baseline: { path: "assets/baseline.csv" },
          current: { path: "assets/current.csv" },
        },
      },
    ],
  }));
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const taskId = created.body.task.id;
  const paused = await json<{ task: { status: string } }>(base, `/tasks/${taskId}/pause`, { method: "POST" });
  assert.equal(paused.status, 200);
  return taskId;
}

test("业务核算目标：建档请求、落库、目标详情与恢复后的任务使用同一份配置", async (t) => {
  const plane = await bootPlane(t);
  const taskId = await createBusinessTask(plane.url);

  // 1) 建档响应里已经是派生后的形态。
  const detail = await json<{ task: TaskBody["task"] }>(plane.url, `/tasks/${taskId}`);
  const goal = detail.body.task.goals[0]!;
  assert.equal(goal.kind, "business-reconcile");
  assert.deepEqual(goal.evidencePatterns, ["reconcile/asset-diff-*.json"]);
  assert.equal(goal.reconcileGate?.pattern, "reconcile/asset-diff-*.json");
  assert.equal(goal.reconcileGate?.maxUnknown, 0);
  assert.equal(goal.reconcileGate?.maxAmbiguous, 0);
  assert.equal(goal.business?.baseline.path, "assets/baseline.csv");
  assert.equal(goal.business?.keyField, "host");

  // 2) History 落库与详情一致（恢复后读的是同一份）。
  const history = await json<{
    goals: Array<{ id: string; kind?: string; business?: { name: string }; reconcileGate?: { pattern: string } }>;
    reconcileRevisions: unknown[];
  }>(plane.url, `/tasks/${taskId}/history`);
  const stored = history.body.goals.find((entry) => entry.id === "biz-diff")!;
  assert.equal(stored.kind, "business-reconcile");
  assert.equal(stored.business?.name, "asset-diff");
  assert.equal(stored.reconcileGate?.pattern, "reconcile/asset-diff-*.json");
  assert.deepEqual(history.body.reconcileRevisions, []);
});

test("业务核算目标：缺件核算不通过并点名缺件；补交后按目标配置核算才首次通过", async (t) => {
  const plane = await bootPlane(t);
  const taskId = await createBusinessTask(plane.url);

  await json(plane.url, `/tasks/${taskId}/evidence`, post({ path: "assets/current.csv", content: CURRENT }));
  const missing = await json<{ revision: { id: string; baseline: { present: boolean } }; result: { counts: { unknown: number } } }>(
    plane.url,
    `/tasks/${taskId}/reconcile`,
    post({ goalId: "biz-diff" }),
  );
  assert.equal(missing.status, 201);
  assert.equal(missing.body.revision.baseline.present, false);
  assert.ok(missing.body.result.counts.unknown > 0);

  const rejected = await json<{ ok: boolean; reason: string }>(
    plane.url,
    `/tasks/${taskId}/goals/assert`,
    post({ goalId: "biz-diff" }),
  );
  assert.equal(rejected.status, 409);
  assert.match(rejected.body.reason, /缺少基线材料 assets\/baseline\.csv/);

  await json(plane.url, `/tasks/${taskId}/evidence`, post({ path: "assets/baseline.csv", content: BASELINE }));
  const good = await json<{ revision: { id: string }; evidencePath: string; evidenceSha256: string }>(
    plane.url,
    `/tasks/${taskId}/reconcile`,
    post({ goalId: "biz-diff" }),
  );
  assert.equal(good.status, 201);
  const passed = await json<{ ok: boolean }>(plane.url, `/tasks/${taskId}/goals/assert`, post({ goalId: "biz-diff" }));
  assert.equal(passed.status, 200);
  assert.equal(passed.body.ok, true);

  const after = await json<{
    goals: Array<{ passes: boolean; reconcileState?: { state: string } }>;
    events: Array<{ kind: string; payload: Record<string, unknown> }>;
    goalProofs: Array<{ path: string; sha256: string }>;
  }>(plane.url, `/tasks/${taskId}/history`);
  assert.equal(after.body.goals[0]!.passes, true);
  assert.equal(after.body.goals[0]!.reconcileState?.state, "passed");
  assert.equal(after.body.goalProofs.length, 1);
  assert.equal(after.body.goalProofs[0]!.path, good.body.evidencePath);
  assert.equal(after.body.goalProofs[0]!.sha256, good.body.evidenceSha256);
  assert.equal(after.body.events.filter((event) => event.kind === "goal_asserted").length, 1);
});

test("业务核算目标：撤回或替换材料后旧结果不能支撑首次通过；重复判定只记一条事件", async (t) => {
  const plane = await bootPlane(t);
  const taskId = await createBusinessTask(plane.url);
  await json(plane.url, `/tasks/${taskId}/evidence`, post({ path: "assets/baseline.csv", content: BASELINE }));
  await json(plane.url, `/tasks/${taskId}/evidence`, post({ path: "assets/current.csv", content: CURRENT }));
  const good = await json<{ evidencePath: string }>(plane.url, `/tasks/${taskId}/reconcile`, post({ goalId: "biz-diff" }));
  assert.equal(good.status, 201);

  // 撤回基线：尚未重算就判定。
  const withdrawn = await json<{ removed: string; sha256: string }>(
    plane.url,
    `/tasks/${taskId}/evidence?path=${encodeURIComponent("assets/baseline.csv")}`,
    { method: "DELETE" },
  );
  assert.equal(withdrawn.status, 200);
  const stateAfterWithdraw = await json<{ goals: Array<{ reconcileState?: { state: string } }> }>(
    plane.url,
    `/tasks/${taskId}/history`,
  );
  assert.equal(stateAfterWithdraw.body.goals[0]!.reconcileState?.state, "missing-material");

  const rejected = await json<{ ok: boolean; reason: string }>(
    plane.url,
    `/tasks/${taskId}/goals/assert`,
    post({ goalId: "biz-diff" }),
  );
  assert.equal(rejected.status, 409);
  assert.match(rejected.body.reason, /基线材料已撤走/);

  // 同一路径替换成冲突重复键材料：新结果歧义，旧结果同样不能用。
  await json(plane.url, `/tasks/${taskId}/evidence`, post({ path: "assets/baseline.csv", content: BASELINE }));
  await json(plane.url, `/tasks/${taskId}/evidence`, post({ path: "assets/current.csv", content: CONFLICTING }));
  const conflict = await json<{ result: { counts: { ambiguous: number } } }>(
    plane.url,
    `/tasks/${taskId}/reconcile`,
    post({ goalId: "biz-diff" }),
  );
  assert.equal(conflict.body.result.counts.ambiguous, 1);
  const rejected2 = await json<{ ok: boolean; reason: string }>(
    plane.url,
    `/tasks/${taskId}/goals/assert`,
    post({ goalId: "biz-diff" }),
  );
  assert.equal(rejected2.status, 409);
  assert.match(rejected2.body.reason, /歧义 1 项/);

  const untouched = await json<{
    goals: Array<{ passes: boolean }>;
    goalProofs: unknown[];
    events: Array<{ kind: string }>;
  }>(plane.url, `/tasks/${taskId}/history`);
  assert.equal(untouched.body.goals[0]!.passes, false);
  assert.deepEqual(untouched.body.goalProofs, []);
  assert.equal(untouched.body.events.filter((event) => event.kind === "goal_asserted").length, 0);

  // 修正后并发触发：只允许一条首次通过事件与一份依据。
  await json(plane.url, `/tasks/${taskId}/evidence`, post({ path: "assets/current.csv", content: CURRENT }));
  const fixed = await json<{ evidencePath: string }>(plane.url, `/tasks/${taskId}/reconcile`, post({ goalId: "biz-diff" }));
  assert.equal(fixed.status, 201);
  const burst = await Promise.all(
    Array.from({ length: 5 }, () =>
      json<{ ok: boolean }>(plane.url, `/tasks/${taskId}/goals/assert`, post({ goalId: "biz-diff" })),
    ),
  );
  assert.ok(burst.every((res) => res.status === 200));
  const final = await json<{
    goalProofs: Array<{ path: string }>;
    events: Array<{ kind: string }>;
  }>(plane.url, `/tasks/${taskId}/history`);
  assert.equal(final.body.goalProofs.length, 1);
  assert.equal(final.body.goalProofs[0]!.path, fixed.body.evidencePath);
  assert.equal(final.body.events.filter((event) => event.kind === "goal_asserted").length, 1);
});

test("业务核算目标：按目标配置核算拒绝被“另跑一份口径”冒充", async (t) => {
  const plane = await bootPlane(t);
  const taskId = await createBusinessTask(plane.url);
  await json(plane.url, `/tasks/${taskId}/evidence`, post({ path: "assets/baseline.csv", content: BASELINE }));
  await json(plane.url, `/tasks/${taskId}/evidence`, post({ path: "assets/current.csv", content: CURRENT }));

  const wrongScope = await json<{ error: string }>(plane.url, `/tasks/${taskId}/reconcile`, post({
    name: "asset-diff",
    baseline: { path: "assets/baseline.csv" },
    current: { path: "assets/current.csv" },
    keyField: "role",
    goalIds: ["biz-diff"],
  }));
  assert.equal(wrongScope.status, 400);
  assert.match(wrongScope.body.error, /核算口径与目标 biz-diff 的声明不一致/);

  const unknownGoal = await json<{ error: string }>(plane.url, `/tasks/${taskId}/reconcile`, post({ goalId: "nope" }));
  assert.equal(unknownGoal.status, 400);
});

test("撤回材料的正常入口：只删文件并留痕，越界路径一律拒绝", async (t) => {
  const plane = await bootPlane(t);
  const taskId = await createBusinessTask(plane.url);
  await json(plane.url, `/tasks/${taskId}/evidence`, post({ path: "assets/current.csv", content: CURRENT }));

  const escape = await json<{ error: string }>(
    plane.url,
    `/tasks/${taskId}/evidence?path=${encodeURIComponent("../history.sqlite")}`,
    { method: "DELETE" },
  );
  assert.equal(escape.status, 400, "不允许撤回 evidence/ 之外的路径");

  const list = await json<{ files: Array<{ path: string }> }>(plane.url, `/tasks/${taskId}/evidence`);
  assert.deepEqual(list.body.files.map((file) => file.path), ["assets/current.csv"]);

  const removed = await json<{ removed: string }>(
    plane.url,
    `/tasks/${taskId}/evidence?path=${encodeURIComponent("assets/current.csv")}`,
    { method: "DELETE" },
  );
  assert.equal(removed.status, 200);
  const after = await json<{ files: Array<{ path: string }> }>(plane.url, `/tasks/${taskId}/evidence`);
  assert.deepEqual(after.body.files, []);

  const events = await json<{ events: Array<{ kind: string; payload: Record<string, unknown> }> }>(
    plane.url,
    `/tasks/${taskId}/history`,
  );
  const written = events.body.events.filter((event) => event.kind === "evidence_written");
  const withdrawn = events.body.events.filter((event) => event.kind === "evidence_removed");
  assert.equal(written.length, 1, "导入也留痕");
  assert.equal(withdrawn.length, 1, "撤回留痕");
  assert.equal(withdrawn[0]!.payload.path, "assets/current.csv");
  assert.match(String(withdrawn[0]!.payload.sha256), /^[0-9a-f]{64}$/, "撤回前的内容哈希留在事件里");
});

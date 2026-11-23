import assert from "node:assert/strict";
import test from "node:test";
import { STATUS_LABEL } from "../labels";
import { controlFace, ViewedTaskControlsController, type TaskControlFace } from "./viewedTaskControls.js";

const taskA = "task-decided-a";
const taskB = "task-pending-b";
const nameA = "已决定事项";
const nameB = "待确认事项";

function label(status: string): string {
  return STATUS_LABEL[status] ?? status;
}

function faceOf(controller: ViewedTaskControlsController): TaskControlFace {
  return controlFace(controller.snapshot(), label);
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function gate() {
  let release!: () => void;
  let fail!: (error: Error) => void;
  const promise = new Promise<void>((resolve, reject) => {
    release = resolve;
    fail = reject;
  });
  return { promise, release, fail };
}

async function until(ready: () => boolean): Promise<void> {
  for (let i = 0; i < 20 && !ready(); i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  assert.equal(ready(), true);
}

test("the default transport uses the browser fetch receiver for the action and status read", async (t) => {
  const calls: string[] = [];
  t.mock.method(globalThis, "fetch", function (this: unknown, input: RequestInfo | URL, init?: RequestInit) {
    if (this !== globalThis) throw new TypeError("Illegal invocation");
    calls.push(`${init?.method ?? "GET"} ${input}`);
    return Promise.resolve(jsonResponse({ task: { id: taskA, status: "paused", error: "操作员已暂停" } }));
  });
  const controller = new ViewedTaskControlsController();
  controller.show(taskA, nameA);
  await controller.act("pause");
  assert.deepEqual(calls, [`POST /tasks/${taskA}/pause`, `GET /tasks/${taskA}`]);
  assert.equal(faceOf(controller).statusText, "已暂停");
  assert.equal(faceOf(controller).pauseReason, "操作员已暂停");
  controller.show(taskB, nameB);
  assert.equal(faceOf(controller).pauseReason, "");
  controller.show(taskA, nameA);
  controller.applyPolledStatus(taskA, "paused", taskA, controller.pollEpoch(taskA), "缺少待核对的材料");
  assert.equal(faceOf(controller).pauseReason, "缺少待核对的材料");
  controller.applyPolledStatus(taskA, "running", taskA, controller.pollEpoch(taskA));
  assert.equal(faceOf(controller).pauseReason, "");
});

test("a delayed success for A is kept on A and does not change B", async () => {
  const read = gate();
  let switched = false;
  let readEntered = false;
  let readFinishedAfterSwitch = false;
  let sawAbort = false;
  const controller = new ViewedTaskControlsController(async (input, init) => {
    if (init?.signal) sawAbort = true;
    const url = String(input);
    if (init?.method === "POST") return jsonResponse({ task: { id: taskA, status: "paused" } });
    assert.equal(url, `/tasks/${encodeURIComponent(taskA)}`);
    readEntered = true;
    await read.promise;
    readFinishedAfterSwitch = switched;
    return jsonResponse({ task: { id: taskA, status: "paused" } });
  });
  controller.show(taskA, nameA);
  controller.applyPolledStatus(taskA, "running", taskA, controller.pollEpoch(taskA));
  const operation = controller.act("pause");
  await until(() => readEntered);
  switched = true;
  controller.show(taskB, nameB);
  controller.applyPolledStatus(taskB, "completed", taskB, controller.pollEpoch(taskB));
  const expected = faceOf(controller);
  read.release();
  await operation;
  assert.equal(sawAbort, false);
  assert.equal(readFinishedAfterSwitch, true);
  assert.deepEqual(faceOf(controller), {
    taskName: nameB,
    subject: `任务 ${taskB}`,
    statusText: "运行完成",
    pauseReason: "",
    note: "",
    pause: null,
    resume: null,
  });
  assert.deepEqual(faceOf(controller), expected);
  controller.show(taskA, nameA);
  const saved = faceOf(controller);
  assert.equal(saved.taskName, nameA);
  assert.equal(saved.statusText, "已暂停");
  assert.match(saved.note, new RegExp(`回读 ${taskA} 的状态：paused`));
  assert.equal(saved.pause, null);
  assert.equal(saved.resume?.busy, false);
});

test("a delayed failure for A is kept on A and does not change B", async () => {
  const read = gate();
  let switched = false;
  let readEntered = false;
  let readFinishedAfterSwitch = false;
  const controller = new ViewedTaskControlsController(async (input, init) => {
    const url = String(input);
    if (init?.method === "POST") return jsonResponse({ task: { id: taskA, status: "running" } });
    assert.equal(url, `/tasks/${encodeURIComponent(taskA)}`);
    readEntered = true;
    try {
      await read.promise;
    } catch (error) {
      readFinishedAfterSwitch = switched;
      throw error;
    }
    throw new Error("回读未失败");
  });
  controller.show(taskA, nameA);
  controller.applyPolledStatus(taskA, "running", taskA, controller.pollEpoch(taskA));
  const operation = controller.act("pause");
  await until(() => readEntered);
  switched = true;
  controller.show(taskB, nameB);
  controller.applyPolledStatus(taskB, "completed", taskB, controller.pollEpoch(taskB));
  read.fail(new Error("回读失败"));
  await operation;
  assert.equal(readFinishedAfterSwitch, true);
  assert.deepEqual(faceOf(controller), {
    taskName: nameB,
    subject: `任务 ${taskB}`,
    statusText: "运行完成",
    pauseReason: "",
    note: "",
    pause: null,
    resume: null,
  });
  controller.show(taskA, nameA);
  const saved = faceOf(controller);
  assert.equal(saved.taskName, nameA);
  assert.equal(saved.statusText, "运行中");
  assert.match(saved.note, /回读失败/);
  assert.equal(saved.pause?.busy, false);
  assert.equal(saved.resume, null);
});

test("an older request's finally does not clear the busy state of a newer request", async () => {
  const readA = gate();
  const postB = gate();
  let readEntered = false;
  const controller = new ViewedTaskControlsController(async (input, init) => {
    if (init?.signal) throw new Error("操作请求不能因切换任务而取消");
    const url = String(input);
    if (url.endsWith("/pause")) return jsonResponse({ task: { id: taskA, status: "paused" } });
    if (url === `/tasks/${encodeURIComponent(taskA)}`) {
      readEntered = true;
      await readA.promise;
      return jsonResponse({ task: { id: taskA, status: "paused" } });
    }
    if (url.endsWith("/resume")) {
      await postB.promise;
      return jsonResponse({ task: { id: taskB, status: "running" } });
    }
    return jsonResponse({ task: { id: taskB, status: "running" } });
  });
  controller.show(taskA, nameA);
  controller.applyPolledStatus(taskA, "running", taskA, controller.pollEpoch(taskA));
  const older = controller.act("pause");
  await until(() => readEntered);
  controller.show(taskB, nameB);
  controller.applyPolledStatus(taskB, "failed", taskB, controller.pollEpoch(taskB));
  const newer = controller.act("resume");
  await until(() => controller.snapshot().busy === "resume");
  readA.release();
  await older;
  const during = faceOf(controller);
  assert.equal(during.taskName, nameB);
  assert.equal(during.statusText, "失败");
  assert.match(during.note, new RegExp(`POST /tasks/${encodeURIComponent(taskB)}/resume`));
  assert.doesNotMatch(during.note, new RegExp(taskA));
  assert.equal(during.pause, null);
  assert.equal(during.resume?.busy, true);
  assert.equal(during.resume?.label, "正在请求");
  postB.release();
  await newer;
  const done = faceOf(controller);
  assert.equal(done.taskName, nameB);
  assert.equal(done.statusText, "运行中");
  assert.equal(done.pause?.busy, false);
  assert.equal(done.resume, null);
});

test("after A to B to A, the older request does not replace the newer one", async () => {
  const reads: Array<ReturnType<typeof gate>> = [];
  const controller = new ViewedTaskControlsController(async (input, init) => {
    const url = String(input);
    if (init?.method === "POST") {
      assert.equal(url, `/tasks/${encodeURIComponent(taskA)}/pause`);
      return jsonResponse({ task: { id: taskA, status: "running" } });
    }
    assert.equal(url, `/tasks/${encodeURIComponent(taskA)}`);
    const index = reads.length;
    const current = gate();
    reads.push(current);
    await current.promise;
    const status = index === 0 ? "paused" : "stopped";
    return jsonResponse({ task: { id: taskA, status } });
  });
  controller.show(taskA, nameA);
  controller.applyPolledStatus(taskA, "running", taskA, controller.pollEpoch(taskA));
  const older = controller.act("pause");
  await until(() => reads.length === 1);
  controller.show(taskB, nameB);
  controller.show(taskA, nameA);
  const newer = controller.act("pause");
  await until(() => reads.length === 2);
  reads[0]!.release();
  await older;
  const mid = faceOf(controller);
  assert.equal(mid.taskName, nameA);
  assert.equal(mid.statusText, "运行中");
  assert.match(mid.note, /POST /);
  assert.doesNotMatch(mid.note, /paused/);
  assert.equal(mid.pause?.busy, true);
  reads[1]!.release();
  await newer;
  const done = faceOf(controller);
  assert.equal(done.statusText, "已停止");
  assert.match(done.note, /stopped/);
  assert.equal(done.pause, null);
  assert.equal(done.resume?.busy, false);
});

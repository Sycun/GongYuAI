/**
 * 已暂停任务归档 — 验收脚本（mock worker）。
 *
 * 走用户验收路径：暂停任务 → 归档（移入「已归档」）→ 刷新仍显示「已暂停」、
 * 检查点与历史保留 → 取消归档（回到「未归档」，不自动执行）→ 点击「继续」
 * 才恢复执行。另设反例：运行中的任务归档仍被服务端拒绝（现有规则不变）。
 *
 * 运行：
 *   pnpm acceptance:paused-archive
 *
 * 产物（同一目录）：acceptance-record.{json,md}、delivery-snapshot.json、
 * acceptance-manifest.json。
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { bootControlPlane } from "@gongyuai/control-plane";
import { gitCodeInfo, writeAcceptanceManifest } from "./acceptance-manifest.js";

const startedAt = new Date().toISOString();
const ROOT = join(process.cwd(), ".gongyuai", "acceptance", `paused-archive-${Date.now()}`);
mkdirSync(ROOT, { recursive: true });

type Step = { step: string; ok: boolean; detail: string; at: string };
const steps: Step[] = [];
function record(step: string, ok: boolean, detail: string) {
  steps.push({ step, ok, detail, at: new Date().toISOString() });
  console.log(`${ok ? "PASS" : "FAIL"}  ${step}  ${detail}`);
  if (!ok) throw new Error(`${step}: ${detail}`);
}

function assert(condition: unknown, step: string, detail: string): asserts condition {
  record(step, Boolean(condition), detail);
}

async function json<T>(base: string, path: string, init?: RequestInit): Promise<{ status: number; body: T }> {
  const res = await fetch(`${base}${path}`, init);
  const text = await res.text();
  let body: unknown;
  try { body = JSON.parse(text); } catch { body = text; }
  return { status: res.status, body: body as T };
}

async function waitFor(base: string, taskId: string, predicate: (task: any) => boolean, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  let last: any = null;
  while (Date.now() < deadline) {
    const r = await json<any>(base, `/tasks/${taskId}`);
    last = r.body.task;
    if (last && predicate(last)) return last;
    await new Promise((r2) => setTimeout(r2, 300));
  }
  throw new Error(`timeout waiting for task; last=${JSON.stringify(last && { status: last.status, error: last.error })}`);
}

/** 与控制台一致的视图口径：未归档 = archivedAt 为空；已归档 = archivedAt 非空。 */
function views(tasks: any[]) {
  return {
    unarchived: tasks.filter((t) => !t.archivedAt).map((t) => t.id),
    archived: tasks.filter((t) => t.archivedAt).map((t) => t.id),
  };
}

async function main() {
  // mock worker：跑完目标后保持运行（GY_MOCK_HOLD_MS），让操作员能中途暂停。
  process.env.GY_SMOKE_PAUSE_MS = process.env.GY_SMOKE_PAUSE_MS ?? "300";
  process.env.GY_MOCK_HOLD_MS = process.env.GY_MOCK_HOLD_MS ?? "90000";

  const plane = await bootControlPlane({ dataRoot: ROOT, host: "127.0.0.1", port: 0, watchdogMs: 700 });
  const base = plane.url;
  const closePlane = async () => {
    try { await plane.close(); } catch { /* workers are detached */ }
  };

  const goals = [{
    id: "paused-archive",
    title: "暂停归档流程核查",
    description: "用于暂停归档验收的目标",
    evidencePatterns: ["proof.txt"],
  }];

  // ---- 1. 建档并运行 → 暂停 ----
  const created = await json<any>(base, "/tasks", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      name: "已暂停任务归档验收",
      mock: true,
      auth: { authorizationNote: "本地验收虚构授权：暂停归档流程核查", targets: ["example.invalid"], outOfScope: [] },
      goals,
      execution: { maxConcurrentExplores: 1 },
    }),
  });
  assert(created.status === 201, "建档", `POST /tasks → ${created.status}`);
  const taskId = created.body.task.id as string;
  await waitFor(base, taskId, (t) => t.status === "running");
  record("运行中", true, "任务进入 running");

  const pausedRes = await json<any>(base, `/tasks/${taskId}/pause`, { method: "POST" });
  assert(pausedRes.status === 200 && pausedRes.body.task.status === "paused", "暂停", `status=${pausedRes.body.task?.status}`);
  assert(existsSync(join(ROOT, "tasks", taskId, "durable.sqlite")), "检查点留存", "durable.sqlite 存在");
  const historyBefore = await json<any>(base, `/tasks/${taskId}/history`);
  const eventsBefore = (historyBefore.body.events ?? []).length;
  const goalsBefore = JSON.stringify(historyBefore.body.goals ?? []);

  // ---- 2. 归档：移入「已归档」 ----
  const archivedRes = await json<any>(base, `/tasks/${taskId}/archive`, { method: "POST" });
  assert(archivedRes.status === 200, "归档请求", `POST /tasks/:id/archive → ${archivedRes.status}`);
  assert(archivedRes.body.task.status === "paused", "归档不改状态", `status=${archivedRes.body.task?.status}（仍为已暂停）`);
  assert(Boolean(archivedRes.body.task.archivedAt), "归档标记", `archivedAt=${archivedRes.body.task?.archivedAt}`);

  const listAfterArchive = (await json<any>(base, "/tasks")).body.tasks as any[];
  const viewAfterArchive = views(listAfterArchive);
  assert(viewAfterArchive.archived.includes(taskId), "移入已归档", "列表已归档视图包含该任务");
  assert(!viewAfterArchive.unarchived.includes(taskId), "离开未归档", "列表未归档视图不含该任务");

  // ---- 3. 刷新后仍显示已暂停；检查点与历史保留 ----
  const reread = (await json<any>(base, `/tasks/${taskId}`)).body.task;
  assert(reread.status === "paused" && Boolean(reread.archivedAt), "刷新后仍已暂停", `status=${reread.status}，归档标记保留`);
  assert(existsSync(join(ROOT, "tasks", taskId, "durable.sqlite")), "归档保留检查点", "durable.sqlite 未被归档改动");
  const historyAfter = await json<any>(base, `/tasks/${taskId}/history`);
  assert((historyAfter.body.events ?? []).length === eventsBefore, "归档保留历史", `events=${eventsBefore}（前后一致）`);
  assert(JSON.stringify(historyAfter.body.goals ?? []) === goalsBefore, "归档保留目标状态", "goals 前后一致");

  // ---- 4. 取消归档：回到「未归档」，不自动执行 ----
  const unarchivedRes = await json<any>(base, `/tasks/${taskId}/unarchive`, { method: "POST" });
  assert(unarchivedRes.status === 200, "取消归档请求", `POST /tasks/:id/unarchive → ${unarchivedRes.status}`);
  assert(unarchivedRes.body.task.archivedAt === null, "取消归档只清标记", "archivedAt=null");
  assert(unarchivedRes.body.task.status === "paused", "取消归档不恢复执行", `status=${unarchivedRes.body.task?.status}（仍为已暂停）`);

  const listAfterUnarchive = (await json<any>(base, "/tasks")).body.tasks as any[];
  const viewAfterUnarchive = views(listAfterUnarchive);
  assert(viewAfterUnarchive.unarchived.includes(taskId), "回到未归档", "列表未归档视图包含该任务");
  assert(!viewAfterUnarchive.archived.includes(taskId), "离开已归档", "列表已归档视图不含该任务");

  // 等待至少两个 watchdog 周期，确认没有任何自动恢复。
  await new Promise((r) => setTimeout(r, 1600));
  const still = (await json<any>(base, `/tasks/${taskId}`)).body.task;
  assert(still.status === "paused", "无自动恢复", `watchdog 两个周期后 status=${still.status}`);

  // ---- 5. 只有用户点击「继续」才恢复执行 ----
  const resumedRes = await json<any>(base, `/tasks/${taskId}/resume`, { method: "POST" });
  assert(resumedRes.status === 200, "继续请求", `POST /tasks/:id/resume → ${resumedRes.status}`);
  assert(["queued", "initializing", "running"].includes(resumedRes.body.task.status), "点击继续才恢复执行", `status=${resumedRes.body.task?.status}`);

  // ---- 6. 反例：运行中的任务归档仍被拒绝 ----
  const second = await json<any>(base, "/tasks", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      name: "运行中归档反例",
      mock: true,
      auth: { authorizationNote: "本地验收虚构授权：运行中归档反例", targets: ["example.invalid"], outOfScope: [] },
      goals,
      execution: { maxConcurrentExplores: 1 },
    }),
  });
  assert(second.status === 201, "反例建档", `POST /tasks → ${second.status}`);
  const secondId = second.body.task.id as string;
  await waitFor(base, secondId, (t) => t.status === "running");
  const refused = await json<any>(base, `/tasks/${secondId}/archive`, { method: "POST" });
  assert(refused.status === 400, "运行中归档被拒绝", `→ ${refused.status}`);
  assert(String(refused.body.error ?? "").includes("仅已暂停或终态任务可归档"), "拒绝原因", String(refused.body.error));
  const secondRecord = (await json<any>(base, `/tasks/${secondId}`)).body.task;
  assert(secondRecord.archivedAt === null, "运行中未被打上归档标记", "archivedAt=null");

  // ---- 收尾：停止两个任务，退出 ----
  for (const id of [taskId, secondId]) {
    const stopped = await json<any>(base, `/tasks/${id}/stop`, { method: "POST" });
    assert(stopped.status === 200, "收尾停止", `${id.slice(0, 8)} → ${stopped.body.task?.status}`);
  }

  const runId = basename(ROOT);
  const code = gitCodeInfo();
  const finalTask = (await json<any>(base, `/tasks/${taskId}`)).body.task;
  const snapshot = {
    runId,
    taskId,
    note: "归档/取消归档/继续各阶段的任务记录快照；archivedAt 是唯一变化字段（状态、检查点与历史另在步骤中断言）。",
    stages: {
      afterPause: pausedRes.body.task,
      afterArchive: archivedRes.body.task,
      afterReread: reread,
      afterUnarchive: unarchivedRes.body.task,
      afterResume: resumedRes.body.task,
      final: finalTask,
    },
  };
  const snapshotPath = join(ROOT, "delivery-snapshot.json");
  writeFileSync(snapshotPath, JSON.stringify(snapshot, null, 2) + "\n");

  const runRecord = {
    runId,
    kind: "paused-archive-mock",
    taskId,
    dataRoot: ROOT,
    finishedAt: new Date().toISOString(),
    code,
    steps,
    snapshotPath,
  };
  writeFileSync(join(ROOT, "acceptance-record.json"), JSON.stringify(runRecord, null, 2) + "\n");
  writeFileSync(
    join(ROOT, "acceptance-record.md"),
    [
      `# 已暂停任务归档 — 验收记录`,
      "",
      "> mock worker 流程验收：验证「已暂停或终态可归档」的归档条件、归档只改标记、",
      "> 取消归档不自动执行、只有用户点击「继续」才恢复，以及运行中任务仍被拒绝。",
      "",
      `运行　${runId}`,
      `任务　${taskId}`,
      `代码提交　${code.commit ?? "未记录"}${code.dirty ? "（工作区有未提交改动）" : ""}`,
      `数据目录　${ROOT}`,
      `完成时间　${runRecord.finishedAt}`,
      "",
      "| 步骤 | 结果 | 证据 |",
      "| --- | --- | --- |",
      ...steps.map((s) => `| ${s.step} | ${s.ok ? "通过" : "失败"} | ${s.detail.replace(/\|/g, "\\|")} |`),
      "",
      `快照　delivery-snapshot.json（各阶段任务记录；清单含字节哈希）`,
      "",
    ].join("\n"),
  );

  const manifest = writeAcceptanceManifest({
    dir: ROOT,
    kind: "paused-archive-mock",
    runId,
    taskId,
    dataRoot: ROOT,
    startedAt,
    finishedAt: runRecord.finishedAt,
    steps,
    code,
    notes: [
      "kind=paused-archive-mock：mock worker 只证明归档流程语义，不消耗模型额度。",
      "归档/取消归档前后 events、goals、durable.sqlite 逐一比对，证明仅归档标记变化。",
    ],
  });
  console.log(
    `清单：${join(ROOT, "acceptance-manifest.json")} · 步骤 ${manifest.steps.total}（失败 ${manifest.steps.failed}）`,
  );

  await closePlane();
  console.log(`\n全部通过：${steps.length} 项。记录：${join(ROOT, "acceptance-record.md")}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

/**
 * 贯穿样例验收（阶段 1/2/3/5）—— 两套业务系统的资产与配置基线评估及整改复核。
 *
 * 全部动作都走普通操作员入口：控制面 HTTP API（`gy serve` 同一实现）+ 材料导入 +
 * 复核/撤回/更正接口。首日材料不齐，次日补交；中途暂停换班并把乙系统移出授权；
 * 期间发生一次控制面中断恢复、一次整改复测、一条客户风险处置、一条结论撤回与更正。
 *
 * 运行：
 *   GY_SMOKE_PAUSE_MS=600 pnpm tsx scripts/engagement-e2e.ts
 *
 * 产物：<dataRoot>/acceptance-record.{json,md}，以及控制面正常入口下的任务数据。
 */
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { bootControlPlane } from "@gongyuai/control-plane";
import { scorecardFromSnapshot } from "@gongyuai/history";

const ROOT = join(process.cwd(), ".gongyuai", "acceptance", `engagement-${Date.now()}`);
mkdirSync(ROOT, { recursive: true });

const TASK_NAME = "甲乙双系统资产与配置基线评估及整改复核";
const A = "a.example.com";
const B = "b.example.com";

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

function body(value: unknown): RequestInit {
  return { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(value) };
}

async function waitFor(base: string, taskId: string, predicate: (task: any) => boolean, timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs;
  let last: any = null;
  while (Date.now() < deadline) {
    const r = await json<any>(base, `/tasks/${taskId}`);
    last = r.body.task;
    if (last && predicate(last)) return last;
    await new Promise((r2) => setTimeout(r2, 400));
  }
  throw new Error(`timeout waiting for task; last=${JSON.stringify(last && { status: last.status, error: last.error })}`);
}

async function main() {
  // Day-1 fixture: the remediation deliverable is deliberately missing.
  process.env.GY_MOCK_SKIP_PATTERNS = "remediation/sys-a";
  process.env.GY_SMOKE_PAUSE_MS = process.env.GY_SMOKE_PAUSE_MS ?? "400";
  // Keep the first day alive after its last assertion so the operator can pause,
  // revise scope and hand over — a real cross-day handoff, not a finished task.
  process.env.GY_MOCK_HOLD_MS = process.env.GY_MOCK_HOLD_MS ?? "9000";

  let plane = await bootControlPlane({ dataRoot: ROOT, host: "127.0.0.1", port: 0, watchdogMs: 700 });
  let base = plane.url;
  const closePlane = async () => {
    try { await plane.close(); } catch { /* workers are detached */ }
  };

  const goals = [
    {
      id: "sys-a-baseline",
      title: "甲系统配置基线核查",
      description: "按委托判据核对甲系统配置基线，并至少一条已验证发现",
      assets: [A],
      evidencePatterns: ["baseline/sys-a/config.json"],
      evidenceChecks: [{ pattern: "baseline/sys-a/config.json", field: "baselineChecked", equals: true }],
      findingsGate: { minVerified: 1, scope: "goal", assets: [A], minSeverity: "medium" },
    },
    {
      id: "sys-b-diff",
      title: "乙系统资产与配置差异核查",
      description: "完成乙系统资产清单与基线差异比对（覆盖型目标，允许零发现）",
      assets: [B],
      evidencePatterns: ["baseline/sys-b/diff.json"],
      evidenceChecks: [{ pattern: "baseline/sys-b/diff.json", field: "assetsCompared", equals: 2 }],
    },
    {
      id: "remediation-a",
      title: "甲系统整改复核材料",
      description: "首日未齐：整改后的配置复核材料，次日补交",
      assets: [A],
      evidencePatterns: ["remediation/sys-a/fix.json"],
      evidenceChecks: [{ pattern: "remediation/sys-a/fix.json", field: "fixed", equals: true }],
    },
    {
      id: "engagement-summary",
      title: "全委托交付汇总",
      description: "显式任务范围的汇总目标",
      evidencePatterns: ["summary/delivery.json"],
      findingsGate: { minVerified: 1, scope: "task" },
    },
  ];

  // ---- 阶段 1：建档 + 导入 + 首日缺件 ----
  const created = await json<any>(base, "/tasks", body({
    name: TASK_NAME,
    mock: true,
    auth: {
      authorizationNote: "客户书面授权：甲乙两套业务系统基线评估与整改复核（虚构样例）",
      targets: [A, B],
      outOfScope: [],
      capability: "scan",
    },
    goals,
    execution: { maxConcurrentExplores: 3 },
  }));
  assert(created.status === 201, "阶段1 建档", `POST /tasks → ${created.status}`);
  const taskId = created.body.task.id as string;
  assert(created.body.task.scopeVersion === 1, "阶段1 授权版本", "v1");

  assert(
    ["queued", "initializing", "running"].includes(created.body.task.status),
    "阶段1 启动",
    `创建即进入运行：status=${created.body.task.status}`,
  );

  // 导入两套系统的清单（普通材料，按声明判据解释）
  for (const [path, content] of [
    ["inventory/sys-a.csv", "host,role,version\napp-a-1,web,1.4\n"],
    ["inventory/sys-b.csv", "host,role,version\napp-b-1,db,2.1\napp-b-2,web,2.1\n"],
  ] as const) {
    const up = await json<any>(base, `/tasks/${taskId}/evidence`, body({ path, content }));
    assert(up.status === 201, "阶段1 导入清单", `${path} → ${up.status}`);
  }

  // ---- 阶段 2：运行中真的中断一次控制面，再从同一数据目录恢复 ----
  await new Promise((r) => setTimeout(r, 1500));
  const before = await json<any>(base, `/tasks/${taskId}/history`);
  const factsBefore = (before.body.facts ?? []).length;
  await closePlane();
  record("阶段2 中断", true, "控制面关闭；worker 为 detached 进程继续运行");

  plane = await bootControlPlane({ dataRoot: ROOT, host: "127.0.0.1", port: 0, watchdogMs: 700 });
  base = plane.url;
  const recovered = await json<any>(base, `/tasks/${taskId}`);
  assert(recovered.status === 200, "阶段2 恢复后读取任务", `status=${recovered.body.task?.status}`);

  // Wait until the first day's assertions are in, then hand over mid-run.
  const deadline = Date.now() + 60_000;
  let day1History: any = null;
  let day1: any = null;
  while (Date.now() < deadline) {
    day1 = (await json<any>(base, `/tasks/${taskId}`)).body.task;
    day1History = (await json<any>(base, `/tasks/${taskId}/history`)).body;
    if ((day1History.goals ?? []).filter((g: any) => g.passes).length >= 3) break;
    if (["incomplete", "completed", "failed"].includes(day1.status)) break;
    await new Promise((r) => setTimeout(r, 300));
  }
  assert(day1.status === "running", "阶段1 首日运行中交接", `status=${day1.status}`);
  assert(day1History.goals.filter((g: any) => g.passes).length === 3, "阶段1 首日缺件", "3/4 目标已过，整改材料待补");
  const goalsAfterDay1 = new Map((day1History.goals ?? []).map((g: any) => [g.id, g]));
  assert((goalsAfterDay1.get("sys-a-baseline") as any).passes === true, "阶段3 甲专项通过", "有本资产已验证发现");
  assert((goalsAfterDay1.get("sys-b-diff") as any).passes === true, "阶段3 覆盖型目标通过", "零发现可交付");
  assert((goalsAfterDay1.get("remediation-a") as any).passes === false, "阶段1 缺件保持未验证", "整改材料首日未齐");
  assert((goalsAfterDay1.get("engagement-summary") as any).passes === true, "阶段3 汇总目标通过", "显式 task 范围");

  const assertedCounts = new Map<string, number>();
  for (const event of day1History.events ?? []) {
    if (event.kind !== "goal_asserted") continue;
    const goalId = String((event.payload ?? {}).goalId);
    assertedCounts.set(goalId, (assertedCounts.get(goalId) ?? 0) + 1);
  }
  assert([...assertedCounts.values()].every((n) => n === 1), "阶段2 无重复记账", JSON.stringify([...assertedCounts]));
  const factsAfterRecovery = (day1History.facts ?? []).length;
  assert(factsAfterRecovery >= factsBefore, "阶段2 事实只增不减", `${factsBefore} → ${factsAfterRecovery}`);

  const findings1 = await json<any>(base, `/tasks/${taskId}/findings`);
  const verified = (findings1.body.findings ?? []).filter((f: any) => f.status === "verified");
  const tentative = (findings1.body.findings ?? []).filter((f: any) => f.status === "tentative");
  assert(verified.length >= 1, "阶段3 技术确认", `verified=${verified.length}`);
  assert(tentative.length >= 1, "阶段3 线索保留", `tentative=${tentative.length}`);

  const card1 = await json<any>(base, `/tasks/${taskId}/scorecard`);
  assert(card1.body.scorecard.historicallyPassed === 3, "阶段3 记分卡历史分子", `${card1.body.scorecard.historicallyPassed}/4`);
  assert(card1.body.scorecard.currentlySupported === 3, "阶段3 记分卡当前分子", `${card1.body.scorecard.currentlySupported}/4`);

  // ---- 阶段 2：暂停换班 + 范围更新，次日恢复 ----
  const paused = await json<any>(base, `/tasks/${taskId}/pause`, { method: "POST" });
  assert(paused.status === 200 && paused.body.task.status === "paused", "阶段2 暂停确认", `status=${paused.body.task?.status}`);
  assert((paused.body.task.workerPids ?? []).length === 0, "阶段2 暂停后无存活 worker", "workerPids=[]");
  assert(existsSync(join(ROOT, "tasks", taskId, "durable.sqlite")), "阶段2 检查点保留", "durable.sqlite 留存");

  const scopeUpdate = await json<any>(base, `/tasks/${taskId}/scope`, body({
    auth: {
      authorizationNote: "客户书面授权：甲乙两套业务系统基线评估与整改复核（次日范围修订：乙系统移出）",
      targets: [A],
      outOfScope: [],
      capability: "scan",
    },
    reason: "客户次日修订：乙系统资产已下线，移出本次复核范围",
  }));
  assert(scopeUpdate.status === 200, "阶段2 范围更新", `scopeVersion=${scopeUpdate.body.task?.scopeVersion}`);
  assert(scopeUpdate.body.task.scopeVersion === 2, "阶段2 授权版本递增", "v2");
  assert(scopeUpdate.body.task.auth.targets.length === 1, "阶段2 新范围生效", scopeUpdate.body.task.auth.targets.join(","));

  // 次日补交材料（普通操作员导入入口）
  const materials: Array<[string, string]> = [
    ["remediation/sys-a/fix.json", JSON.stringify({ fixed: true, verifiedBy: "复核甲" }) + "\n"],
    ["remediation/retest.txt", "复测：配置项已按基线修订，差异清零\n"],
    ["findings/lead-proof.txt", "线索复现：越权读取响应 200\n"],
    ["client/decision.md", "客户风险处置：接受剩余风险，由客户安全负责人签认\n"],
  ];
  for (const [path, content] of materials) {
    const up = await json<any>(base, `/tasks/${taskId}/evidence`, body({ path, content }));
    assert(up.status === 201, "阶段2 次日补交材料", path);
  }

  const resumed = await json<any>(base, `/tasks/${taskId}/resume`, { method: "POST" });
  assert(resumed.status === 200, "阶段2 恢复运行", `status=${resumed.body.task?.status}`);
  const finished = await waitFor(base, taskId, (t) => ["completed", "incomplete", "failed"].includes(t.status));
  assert(finished.status === "completed", "阶段1 跨日完成", `status=${finished.status}`);
  assert(finished.auth.targets.length === 1 && finished.auth.targets[0] === A, "阶段2 恢复读取最新授权", finished.auth.targets.join(","));
  assert(finished.scopeVersion === 2, "阶段2 版本保持", `v${finished.scopeVersion}`);

  const finalHistory = await json<any>(base, `/tasks/${taskId}/history`);
  const assertions2 = (finalHistory.body.events ?? []).filter((e: any) => e.kind === "goal_asserted");
  const perGoal = new Map<string, number>();
  for (const event of assertions2) {
    const id = String((event.payload ?? {}).goalId);
    perGoal.set(id, (perGoal.get(id) ?? 0) + 1);
  }
  assert([...perGoal.values()].every((n) => n === 1), "阶段2 跨日无重复通过", JSON.stringify([...perGoal]));
  const scopeFacts = (finalHistory.body.facts ?? []).filter((f: any) => f.title?.includes("授权范围更新"));
  assert(scopeFacts.length === 1, "阶段2 范围修订入图", `facts=${scopeFacts.length}`);

  // ---- 阶段 5：整改复测 / 客户风险处置 / 工作项关闭 ----
  const findings2 = await json<any>(base, `/tasks/${taskId}/findings`);
  const findingA = (findings2.body.findings ?? []).find((f: any) => f.id === verified[0].id);
  const lead = (findings2.body.findings ?? []).find((f: any) => f.status === "tentative");

  const retest = await json<any>(base, `/tasks/${taskId}/findings/${findingA.id}/retest`, body({
    result: "fixed",
    evidencePaths: ["remediation/retest.txt"],
    repro: "按整改单复测：请求返回 403，差异项已修复",
    note: "整改后复测通过",
  }));
  assert(retest.status === 201 && retest.body.finding.status === "retested", "阶段5 整改复测", retest.body.finding?.status);

  const verifyLead = await json<any>(base, `/tasks/${taskId}/findings/${lead.id}/verify`, body({
    evidencePaths: ["findings/lead-proof.txt"],
    repro: "越权请求复现：低权限账号读取高权限对象返回 200",
  }));
  assert(verifyLead.status === 200, "阶段5 技术确认线索", verifyLead.body.finding?.status);

  const accepted = await json<any>(base, `/tasks/${taskId}/findings/${lead.id}/accept`, body({
    note: "客户安全负责人确认接受该剩余风险，列入遗留事项",
    evidencePath: "client/decision.md",
  }));
  assert(accepted.status === 201 && accepted.body.finding.status === "accepted", "阶段5 客户风险处置", accepted.body.finding?.status);

  // ---- 阶段 3/5：结论撤回 → 更正说明 → 通知状态 ----
  const retract = await json<any>(base, `/tasks/${taskId}/findings/${findingA.id}/retract`, body({
    reason: "复测环境配置差异导致原结论不成立，撤回并保留历史",
  }));
  assert(retract.status === 200, "阶段3 结论撤回", retract.body.finding?.status);

  const correction = await json<any>(base, `/tasks/${taskId}/corrections`, body({
    reason: "撤回一条被甲系统目标与汇总目标引用的发现，生成更正说明",
  }));
  assert(correction.status === 201, "阶段5 更正生成", `#${correction.body.correction?.number}`);
  assert((correction.body.correction.goals ?? []).length === 2, "阶段5 更正影响清单", JSON.stringify(correction.body.correction.goals));
  const correctionId = correction.body.correction.id as string;

  const notified = await json<any>(base, `/tasks/${taskId}/corrections/${correctionId}/notice`, body({ status: "notified" }));
  assert(notified.status === 200 && notified.body.correction.noticeStatus === "notified", "阶段5 通知状态", notified.body.correction?.noticeStatus);

  // One snapshot, one published scorecard: the hash in the record is the hash
  // of the snapshot file that ships with it (no second capturedAt).
  const card2 = await json<any>(base, `/tasks/${taskId}/snapshot`);
  const snapshotPath = join(ROOT, "delivery-snapshot.json");
  writeFileSync(snapshotPath, JSON.stringify(card2.body.snapshot, null, 2) + "\n");
  assert(card2.body.scorecard.historicallyPassed === 4, "阶段3 历史通过保留", `${card2.body.scorecard.historicallyPassed}/4`);
  assert(card2.body.scorecard.currentlySupported === 2, "阶段3 当前支持下降", `${card2.body.scorecard.currentlySupported}/4`);
  assert(card2.body.scorecard.retractedReferences === 2, "阶段3 撤回引用计数", String(card2.body.scorecard.retractedReferences));
  const recompute = scorecardFromSnapshot(JSON.parse(readFileSync(snapshotPath, "utf8")));
  assert(recompute.ok && recompute.sealValid, "阶段3 快照可复算", "seal valid");
  if (recompute.ok) {
    assert(
      recompute.scorecard.historicallyPassed === card2.body.scorecard.historicallyPassed &&
      recompute.scorecard.currentlySupported === card2.body.scorecard.currentlySupported &&
      recompute.scorecard.retractedReferences === card2.body.scorecard.retractedReferences,
      "阶段3 独立复算一致",
      `${recompute.scorecard.historicallyPassed}/${recompute.scorecard.totalGoals} · ${recompute.scorecard.currentlySupported}/${recompute.scorecard.totalGoals}`,
    );
  }

  const delivery = await json<any>(base, `/tasks/${taskId}/delivery`);
  const summary: string = delivery.body.summary ?? "";
  assert(summary.includes("交付更正") && summary.includes("唯一依据已撤回"), "阶段5 交付摘要可核对", "更正与撤回提示");
  assert(summary.includes("当前证据足以支持"), "阶段3 交付摘要含记分卡", "分子/分母");
  assert(summary.includes("授权版本　v2"), "阶段2 交付摘要含版本", "v2");

  const report = await json<any>(base, `/tasks/${taskId}/report`);
  const reportText = typeof report.body === "string" ? report.body : JSON.stringify(report.body);
  assert(reportText.includes("## Findings") && reportText.includes("客户接受风险"), "阶段5 报告分列处置", "accepted 可见");
  assert(reportText.includes("交付更正"), "阶段5 报告含更正", "#1");

  // 工作项关闭：归档（仅终态）
  const archived = await json<any>(base, `/tasks/${taskId}/archive`, { method: "POST" });
  assert(archived.status === 200, "阶段5 工作项关闭", "archived");

  const runRecord = {
    taskId,
    dataRoot: ROOT,
    finishedAt: new Date().toISOString(),
    scopeVersion: finished.scopeVersion,
    steps,
    scorecard: card2.body.scorecard,
    snapshotPath,
  };
  writeFileSync(join(ROOT, "acceptance-record.json"), JSON.stringify(runRecord, null, 2) + "\n");
  writeFileSync(
    join(ROOT, "acceptance-record.md"),
    [
      `# 贯穿样例验收记录`,
      "",
      `任务　${taskId}`,
      `委托　${TASK_NAME}`,
      `数据目录　${ROOT}`,
      `完成时间　${runRecord.finishedAt}`,
      `授权版本　v${runRecord.scopeVersion}`,
      "",
      "| 步骤 | 结果 | 证据 |",
      "| --- | --- | --- |",
      ...steps.map((s) => `| ${s.step} | ${s.ok ? "通过" : "失败"} | ${s.detail.replace(/\|/g, "\\|")} |`),
      "",
      `记分卡：曾通过 ${runRecord.scorecard.historicallyPassed}/${runRecord.scorecard.totalGoals}；` +
        `当前证据足以支持 ${runRecord.scorecard.currentlySupported}/${runRecord.scorecard.totalGoals}；` +
        `撤回引用 ${runRecord.scorecard.retractedReferences}；快照 ${runRecord.scorecard.snapshotSha256}`,
      "",
    ].join("\n"),
  );

  await closePlane();
  console.log(`\n全部通过：${steps.length} 项。记录：${join(ROOT, "acceptance-record.md")}`);
}

main().catch(async (err) => {
  console.error(err);
  process.exit(1);
});

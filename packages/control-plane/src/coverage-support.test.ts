/**
 * 覆盖与当前支持的一致性（验收项 3）。
 *
 * 四类覆盖意见（已测 / 部分覆盖 / 受阻 / 未登记）另加“登记为未知”，全部
 * 从正常入口（POST /tasks/:id/coverage）登记；然后比对四个展示入口：
 * API `/scorecard`、`/snapshot`、导出报告 `/report`、交付摘要 `/delivery`。
 * 每一处都必须写清分子、分母与统计时点，并且相同快照重复复算结果相同。
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { CreateTaskRequestSchema } from "@gongyuai/contracts";
import { computeScorecard, openHistory, writeEvidenceFile, writeTaskReport } from "@gongyuai/history";
import { bootControlPlane, taskPaths } from "./index.js";

async function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), "gy-coverage-"));
  const plane = await bootControlPlane({ dataRoot: root, host: "127.0.0.1", port: 0, runtime: "local", watchdogMs: 60_000 });
  t.after(async () => { await plane.close(); rmSync(root, { recursive: true, force: true }); });

  const task = plane.store.createTask(CreateTaskRequestSchema.parse({
    auth: { targets: ["cov.invalid"], authorizationNote: "虚构覆盖登记：仅用于工程验收" },
    goals: [
      { id: "g-tested", title: "已测且零发现", description: "覆盖充分，零发现", assets: ["cov.invalid"], evidencePatterns: ["cov/tested.json"] },
      { id: "g-partial", title: "部分覆盖", description: "只覆盖其中一部分", assets: ["cov.invalid"], evidencePatterns: ["cov/partial.json"] },
      { id: "g-blocked", title: "受阻", description: "外部依赖不可用", assets: ["cov.invalid"], evidencePatterns: ["cov/blocked.json"] },
      { id: "g-untested", title: "登记为未测", description: "已知尚未测试", assets: ["cov.invalid"], evidencePatterns: ["cov/untested.json"] },
      { id: "g-attachment", title: "已有附件但覆盖未登记", description: "附件在，从未登记覆盖意见", assets: ["cov.invalid"], evidencePatterns: ["cov/attachment.json"] },
    ],
    mock: true,
  }));
  const paths = taskPaths(task.dataDir);
  const history = openHistory({ dbPath: paths.historyDb, evidenceDir: paths.evidenceDir });
  history.seedGoals(task.id, task.goals);
  t.after(() => history.close());

  for (const [goalId, file] of [
    ["g-tested", "cov/tested.json"],
    ["g-partial", "cov/partial.json"],
    ["g-attachment", "cov/attachment.json"],
  ] as const) {
    writeEvidenceFile(paths.evidenceDir, file, JSON.stringify({ goalId, checked: true }) + "\n");
    assert.equal(history.assertGoal(task.id, goalId, [file]).ok, true, goalId);
  }
  writeEvidenceFile(paths.evidenceDir, "cov/logs/tested.log", "已测覆盖原始日志\n");
  writeEvidenceFile(paths.evidenceDir, "cov/logs/partial.log", "部分覆盖原始日志\n");
  writeEvidenceFile(paths.evidenceDir, "cov/logs/attachment.log", "附件在，覆盖仍未登记\n");

  return { plane, task, paths, history, base: plane.url + "/tasks/" + task.id };
}

async function postJson(url: string, path: string, body: unknown) {
  const res = await fetch(url + path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, text: await res.text() };
}

test("四类覆盖意见 + 未登记：API/快照/报告/交付摘要读数一致，分子分母与统计时点都在", async (t) => {
  const { base, task, history } = await fixture(t);

  // 正常入口登记覆盖意见（署名 + 依据）。
  const registrations = [
    { goalId: "g-tested", status: "tested", reviewer: "复核甲", reason: "约定检查项全部完成", evidencePath: "cov/logs/tested.log" },
    { goalId: "g-partial", status: "partial", reviewer: "复核甲", reason: "只完成一半检查项", evidencePath: "cov/logs/partial.log" },
    { goalId: "g-blocked", status: "blocked", reviewer: "复核乙", reason: "外部供应商接口未开放，无法进入" },
    { goalId: "g-untested", status: "untested", reviewer: "复核乙", reason: "客户要求暂缓该项，尚未测试" },
  ];
  for (const body of registrations) {
    const res = await postJson(base, "/coverage", body);
    assert.equal(res.status, 201, `${body.goalId}: ${res.text}`);
  }

  // 导出报告：从 History 重新渲染（与服务器终态刷新同一实现）。
  writeTaskReport(
    { taskId: task.id, dataDir: task.dataDir, auth: task.auth },
    history,
    { status: "incomplete", accounting: task },
  );

  const cardRes = await fetch(base + "/scorecard");
  const { scorecard } = (await cardRes.json()) as { scorecard: Record<string, any> };
  assert.equal(scorecard.denominator, 5, "分母 = 本次约定目标总数");
  assert.equal(scorecard.totalGoals, 5);
  assert.equal(scorecard.historicallyPassed, 3);
  assert.equal(scorecard.currentlySupported, 3);
  assert.equal(scorecard.unknownAttribution, 0);
  assert.deepEqual(scorecard.coverage, {
    tested: 1, partial: 1, blocked: 1, untested: 1, unregistered: 1,
  }, "五类互斥：已测/部分覆盖/受阻/未测/未登记");
  assert.ok(Date.parse(scorecard.capturedAt) > 0, "统计时点必须给到");

  // /snapshot 的记分卡必须是同一份快照的纯函数结果。
  const snapshotRes = await fetch(base + "/snapshot");
  const { snapshot, scorecard: published } = (await snapshotRes.json()) as {
    snapshot: { sha256: string; capturedAt: string };
    scorecard: Record<string, any>;
  };
  assert.equal(published.snapshotSha256, snapshot.sha256, "记分卡引用的是同一份快照");
  assert.equal(published.historicallyPassed, scorecard.historicallyPassed);
  assert.equal(published.currentlySupported, scorecard.currentlySupported);

  // 导出报告：同一组数字 + 分母 + 统计时点 + 零发现口径。
  const report = await (await fetch(base + "/report")).text();
  assert.match(report, /## 覆盖与当前支持/);
  assert.match(report, /分母　本次约定目标总数 5/);
  assert.match(report, /当前证据足以支持　3 \/ 5/);
  assert.match(report, /历史通过　3 \/ 5/);
  assert.match(report, /原依据归属未知　0 \/ 5/);
  assert.match(report, /已测 1、部分覆盖 1、受阻 1、未测 1、未登记 1/);
  assert.match(report, /在本次检查范围内未检出/, "覆盖充分零发现要写成未检出");
  assert.match(report, /人工覆盖记录　未登记（没有覆盖意见，不等于已验证覆盖）/);

  // 交付摘要（控制台报告 Tab 的正文来源）用同一套读数。
  const summary = (await (await fetch(base + "/delivery")).json()) as { summary: string };
  assert.match(summary.summary, /统计时点/);
  assert.match(summary.summary, /- 当前证据足以支持的目标数　3 \/ 5/);
  assert.match(summary.summary, /未登记 1/);
  assert.match(summary.summary, /当前证据支持与人工覆盖是两个维度/);

  // 控制台读取的数据源（/history 的 coverage）与记分卡同源。
  const historyPayload = (await (await fetch(base + "/history")).json()) as {
    coverage: Array<{ goalId: string; status: string; reviewer: string; reason: string }>;
  };
  assert.equal(historyPayload.coverage.length, 4);
  assert.deepEqual(
    historyPayload.coverage.map((entry) => [entry.goalId, entry.status]).sort(),
    [["g-blocked", "blocked"], ["g-partial", "partial"], ["g-tested", "tested"], ["g-untested", "untested"]],
  );
  assert.ok(historyPayload.coverage.every((entry) => entry.reviewer && entry.reason), "覆盖意见必须带署名与依据");

  // 同一快照重复复算得到相同结果。
  const first = computeScorecard(snapshot as never);
  const second = computeScorecard(snapshot as never);
  assert.deepEqual(first, second);
  assert.equal(first.coverage.tested, 1);
  assert.equal(JSON.stringify(first), JSON.stringify(second));
});

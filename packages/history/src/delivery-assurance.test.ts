/**
 * Delivery assurance A1–A5 (docs/delivery-assurance-plan.md).
 *
 * These are the acceptance fixtures for "目标的通过到底凭什么、今天是否还能引用":
 * - A1 发现归属：甲的发现不能替乙的专项目标通过
 * - A2 覆盖型目标：完整 / 部分 / 缺失三种材料可区分，零发现不证明覆盖
 * - A3 提交顺序：撤回在先则首次断言失败；断言在先则保留历史并提示当前撤回
 * - A4 旧档：归属未知时保留历史结果，只读重复生成记分卡一致且不改字节
 * - A5 复用与去重：同一发现可被两个目标分别引用，各自只计一次；更正幂等
 *
 * 另含两个兼容回归：普通业务附件同名 ALL_COMPLETE.json、TSecBench 基准语义。
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import { openHistory, type HistoryStore } from "./index.js";
import { describeGoalEvidence } from "./delivery.js";
import { scorecardFromSnapshot } from "./scorecard.js";

function setup(prefix: string) {
  const root = mkdtempSync(join(tmpdir(), prefix));
  const evidenceDir = join(root, "evidence");
  const store = openHistory({ dbPath: join(root, "history.sqlite"), evidenceDir });
  return { root, evidenceDir, store };
}

function writeEvidence(evidenceDir: string, path: string, body: string) {
  mkdirSync(join(evidenceDir, path, ".."), { recursive: true });
  writeFileSync(join(evidenceDir, path), body);
}

function verifiedFinding(
  store: HistoryStore,
  taskId: string,
  evidenceDir: string,
  asset: string,
  vulnClass = "CWE-89",
) {
  const proof = `findings/${randomUUID()}.txt`;
  writeEvidence(evidenceDir, proof, "request/response proof\n");
  const { finding } = store.recordFinding({
    taskId,
    title: `finding on ${asset}`,
    asset,
    vulnClass,
    severity: "high",
  });
  return store.verifyFinding(taskId, finding.id, { evidencePaths: [proof], repro: "curl …" });
}

test("A1 甲资产的发现不能替乙的专项目标通过；显式任务级汇总可以引用", () => {
  const { root, evidenceDir, store } = setup("gy-a1-");
  const taskId = randomUUID();
  try {
    store.seedGoals(taskId, [
      {
        id: "sys-a",
        title: "甲系统配置基线",
        description: "甲系统至少一条已验证发现",
        assets: ["a.example.com"],
        evidencePatterns: ["baseline/a.md"],
        findingsGate: { minVerified: 1, scope: "goal", assets: ["a.example.com"] },
        passes: false, evidencePaths: [], assertedAt: null,
      },
      {
        id: "sys-b",
        title: "乙系统资产差异",
        description: "乙系统自身至少一条已验证发现",
        assets: ["b.example.com"],
        evidencePatterns: ["baseline/b.md"],
        findingsGate: { minVerified: 1, scope: "goal", assets: ["b.example.com"] },
        passes: false, evidencePaths: [], assertedAt: null,
      },
      {
        id: "engagement-summary",
        title: "全委托汇总",
        description: "显式声明统计整个委托的发现",
        evidencePatterns: ["baseline/summary.md"],
        findingsGate: { minVerified: 1, scope: "task" },
        passes: false, evidencePaths: [], assertedAt: null,
      },
    ]);
    writeEvidence(evidenceDir, "baseline/a.md", "# 甲基线\n");
    writeEvidence(evidenceDir, "baseline/b.md", "# 乙差异\n");
    writeEvidence(evidenceDir, "baseline/summary.md", "# 汇总\n");

    const finding = verifiedFinding(store, taskId, evidenceDir, "a.example.com");

    const a = store.assertGoal(taskId, "sys-a", ["baseline/a.md"]);
    assert.equal(a.ok, true, "甲有自己资产上的已验证发现，应通过");

    const b = store.assertGoal(taskId, "sys-b", ["baseline/b.md"]);
    assert.equal(b.ok, false, "甲的发现不得替乙通过");
    if (!b.ok) {
      assert.match(b.reason, /findings gate/);
      assert.match(b.reason, /assets=b\.example\.com/, "拒绝原因须写出目标资产范围");
    }

    const summary = store.assertGoal(taskId, "engagement-summary", ["baseline/summary.md"]);
    assert.equal(summary.ok, true, "显式 task 范围才可引用全委托累计");

    const support = store.listGoalFindings(taskId);
    assert.deepEqual(
      support.map((s) => [s.goalId, s.findingId]).sort((a, b) => a[0]!.localeCompare(b[0]!)),
      [
        ["engagement-summary", finding.id],
        ["sys-a", finding.id],
      ],
    );
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("A1+ 目标级发现闸未声明资产时拒绝，而不是退化为全任务累计", () => {
  const { root, evidenceDir, store } = setup("gy-a1b-");
  const taskId = randomUUID();
  try {
    store.seedGoals(taskId, [{
      id: "unscoped",
      title: "未声明资产",
      description: "缺少 assets",
      evidencePatterns: ["x.md"],
      findingsGate: { minVerified: 1, scope: "goal" },
      passes: false, evidencePaths: [], assertedAt: null,
    }]);
    writeEvidence(evidenceDir, "x.md", "x\n");
    verifiedFinding(store, taskId, evidenceDir, "any.example.com");
    const result = store.assertGoal(taskId, "unscoped", ["x.md"]);
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.reason, /requires goal\.assets/);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("A2 覆盖型目标：完整/部分/缺失可区分，零发现不证明覆盖", () => {
  const { root, evidenceDir, store } = setup("gy-a2-");
  const taskId = randomUUID();
  try {
    store.seedGoals(taskId, [
      {
        id: "coverage-complete", title: "完整覆盖", description: "约定检查项全部完成",
        assets: ["a.example.com"], evidencePatterns: ["cov/full.json"],
        passes: false, evidencePaths: [], assertedAt: null,
      },
      {
        id: "coverage-partial", title: "部分覆盖", description: "只覆盖其中一部分",
        assets: ["a.example.com"], evidencePatterns: ["cov/partial.json"],
        passes: false, evidencePaths: [], assertedAt: null,
      },
      {
        id: "coverage-missing", title: "缺失材料", description: "没有检查记录",
        assets: ["a.example.com"], evidencePatterns: ["cov/missing.json"],
        passes: false, evidencePaths: [], assertedAt: null,
      },
    ]);
    writeEvidence(evidenceDir, "cov/full.json", JSON.stringify({ checked: ["all"] }));
    writeEvidence(evidenceDir, "cov/partial.json", JSON.stringify({ checked: ["half"] }));
    writeEvidence(evidenceDir, "cov/evidence-full.txt", "full coverage log\n");
    writeEvidence(evidenceDir, "cov/evidence-partial.txt", "partial coverage log\n");

    assert.equal(store.assertGoal(taskId, "coverage-complete", ["cov/full.json"]).ok, true);
    assert.equal(store.assertGoal(taskId, "coverage-partial", ["cov/partial.json"]).ok, true);
    store.recordCoverage(taskId, {
      goalId: "coverage-complete", status: "tested", reviewer: "复核甲",
      reason: "约定检查项全部完成", evidencePath: "cov/evidence-full.txt",
    });
    store.recordCoverage(taskId, {
      goalId: "coverage-partial", status: "partial", reviewer: "复核甲",
      reason: "只完成一半检查项", evidencePath: "cov/evidence-partial.txt",
    });

    const card = store.scorecard(taskId);
    assert.equal(card.coverage.tested, 1);
    assert.equal(card.coverage.partial, 1);
    assert.equal(card.coverage.unknown, 1, "缺失材料的目标覆盖必须仍是未知");
    assert.equal(card.findings.verified, 0, "零发现本身不构成覆盖证明");

    const goals = store.listGoals(taskId);
    const byId = new Map(goals.map((g) => [g.id, g]));
    const label = (id: string) => describeGoalEvidence(byId.get(id)!, store.listGoalProofs(taskId), [], {
      goalFindings: store.listGoalFindings(taskId), findings: store.listFindings(taskId),
    });
    assert.match(label("coverage-complete"), /已留存材料/);
    assert.doesNotMatch(label("coverage-missing"), /已通过/);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("A3 撤回在先则首次断言失败；断言在先保留历史并提示当前唯一依据已撤回", () => {
  const { root, evidenceDir, store } = setup("gy-a3-");
  const taskId = randomUUID();
  try {
    store.seedGoals(taskId, [
      {
        id: "before", title: "撤回在先", description: "撤回已提交后才能断言",
        assets: ["a.example.com"], evidencePatterns: ["goal/before.md"],
        findingsGate: { minVerified: 1, scope: "goal", assets: ["a.example.com"] },
        passes: false, evidencePaths: [], assertedAt: null,
      },
      {
        id: "after", title: "断言在先", description: "首次通过后撤回",
        assets: ["a.example.com"], evidencePatterns: ["goal/after.md"],
        findingsGate: { minVerified: 1, scope: "goal", assets: ["a.example.com"] },
        passes: false, evidencePaths: [], assertedAt: null,
      },
      {
        id: "independent", title: "独立依据", description: "两条独立发现，撤一条仍成立",
        assets: ["a.example.com"], evidencePatterns: ["goal/independent.md"],
        findingsGate: { minVerified: 1, scope: "goal", assets: ["a.example.com"] },
        passes: false, evidencePaths: [], assertedAt: null,
      },
    ]);
    writeEvidence(evidenceDir, "goal/before.md", "before\n");
    writeEvidence(evidenceDir, "goal/after.md", "after\n");
    writeEvidence(evidenceDir, "goal/independent.md", "independent\n");

    // 撤回在先：先 verify 再 retract，然后断言。
    const first = verifiedFinding(store, taskId, evidenceDir, "a.example.com", "CWE-89");
    store.retractFinding(taskId, first.id, "复现失败，判定误报");
    const before = store.assertGoal(taskId, "before", ["goal/before.md"]);
    assert.equal(before.ok, false, "撤回已提交，首次断言不得引用");
    if (!before.ok) assert.match(before.reason, /findings gate/);

    // 断言在先：先 verify + 断言，再撤回。
    const second = verifiedFinding(store, taskId, evidenceDir, "a.example.com", "CWE-79");
    assert.equal(store.assertGoal(taskId, "after", ["goal/after.md"]).ok, true);
    store.retractFinding(taskId, second.id, "客户确认误报");
    const goals = store.listGoals(taskId);
    assert.equal(goals.find((g) => g.id === "after")!.passes, true, "首次通过记录保留");
    const support = store.listGoalFindings(taskId).filter((s) => s.goalId === "after");
    assert.deepEqual(support.map((s) => [s.findingId, s.statusAtAssert]), [[second.id, "verified"]]);

    const card = store.scorecard(taskId);
    const after = card.goals.find((g) => g.goalId === "after")!;
    assert.equal(after.historicalPass, true);
    assert.equal(after.currentSupported, false);
    assert.equal(after.verdict, "supported-by-retracted-only");
    const label = describeGoalEvidence(
      goals.find((g) => g.id === "after")!,
      store.listGoalProofs(taskId), [],
      { goalFindings: store.listGoalFindings(taskId), findings: store.listFindings(taskId) },
    );
    assert.match(label, /唯一依据已撤回/);

    // 独立依据：两条都验证后断言，撤回其中一条，当前仍成立。
    const third = verifiedFinding(store, taskId, evidenceDir, "a.example.com", "CWE-22");
    verifiedFinding(store, taskId, evidenceDir, "a.example.com", "CWE-74");
    assert.equal(store.assertGoal(taskId, "independent", ["goal/independent.md"]).ok, true);
    store.retractFinding(taskId, third.id, "一条误报");
    const card2 = store.scorecard(taskId);
    const independent = card2.goals.find((g) => g.goalId === "independent")!;
    assert.equal(independent.currentSupported, true);
    assert.equal(independent.retractedSupportFindingIds.length, 1);
    const label2 = describeGoalEvidence(
      store.listGoals(taskId).find((g) => g.id === "independent")!,
      store.listGoalProofs(taskId), [],
      { goalFindings: store.listGoalFindings(taskId), findings: store.listFindings(taskId) },
    );
    assert.match(label2, /部分依据已撤回/);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("A4 旧档只读：归属未知保留历史结果，两次记分卡一致且字节不变", () => {
  const { root, evidenceDir, store } = setup("gy-a4-");
  const taskId = randomUUID();
  const dbPath = store.dbPath;
  try {
    store.seedGoals(taskId, [{
      id: "legacy",
      title: "旧档已通过",
      description: "缺少发现归属",
      evidencePatterns: ["old/report.md"],
      passes: true,
      evidencePaths: ["old/report.md"],
      assertedAt: "2026-01-01T00:00:00.000Z",
    }]);
    writeEvidence(evidenceDir, "old/report.md", "# 旧报告\n");
    const snapshot = store.deliverySnapshot(taskId);
    const snapshotPath = join(root, "snapshot.json");
    writeFileSync(snapshotPath, JSON.stringify(snapshot, null, 2));
    const before = createHash("sha256").update(readFileSync(snapshotPath)).digest("hex");
    store.close();
    // Hash after the writer closed: opening a WAL database is not allowed to
    // change its bytes, but the writer's own close may checkpoint.
    const dbBefore = createHash("sha256").update(readFileSync(dbPath)).digest("hex");

    const first = openHistory({ dbPath, evidenceDir, readOnly: true });
    const cardA = first.scorecard(taskId);
    first.close();
    const second = openHistory({ dbPath, evidenceDir, readOnly: true });
    const cardB = second.scorecard(taskId);
    second.close();

    assert.equal(cardA.historicallyPassed, 1);
    assert.equal(cardA.unknownAttribution, 1);
    assert.equal(cardA.goals[0]!.verdict, "unknown-attribution");
    assert.equal(cardA.historicallyPassed, cardB.historicallyPassed);
    assert.equal(cardA.currentlySupported, cardB.currentlySupported);
    assert.deepEqual(cardA.goals, cardB.goals);
    const after = createHash("sha256").update(readFileSync(snapshotPath)).digest("hex");
    assert.equal(before, after, "只读复算不得改写快照");
    const dbAfter = createHash("sha256").update(readFileSync(dbPath)).digest("hex");
    assert.equal(dbBefore, dbAfter, "只读打开不得改写历史库");

    const recomputed = scorecardFromSnapshot(JSON.parse(readFileSync(snapshotPath, "utf8")));
    assert.equal(recomputed.ok, true);
    if (recomputed.ok) {
      assert.equal(recomputed.scorecard.historicallyPassed, cardA.historicallyPassed);
      assert.equal(recomputed.scorecard.currentlySupported, cardA.currentlySupported);
      assert.equal(recomputed.scorecard.unknownAttribution, 1);
      assert.equal(recomputed.sealValid, true);
    }
  } finally {
    try { store.close(); } catch { /* already closed */ }
    rmSync(root, { recursive: true, force: true });
  }
});

test("A5 同一发现被两个目标引用各计一次；更正幂等且可从快照复算", () => {
  const { root, evidenceDir, store } = setup("gy-a5-");
  const taskId = randomUUID();
  try {
    const gate = { minVerified: 1, scope: "goal" as const, assets: ["a.example.com"] };
    store.seedGoals(taskId, [
      {
        id: "first", title: "甲专项", description: "同一发现",
        assets: ["a.example.com"], evidencePatterns: ["g1.md"], findingsGate: gate,
        passes: false, evidencePaths: [], assertedAt: null,
      },
      {
        id: "second", title: "乙复用", description: "独立理由复用同一发现",
        assets: ["a.example.com"], evidencePatterns: ["g2.md"], findingsGate: gate,
        passes: false, evidencePaths: [], assertedAt: null,
      },
    ]);
    writeEvidence(evidenceDir, "g1.md", "g1\n");
    writeEvidence(evidenceDir, "g2.md", "g2\n");
    const finding = verifiedFinding(store, taskId, evidenceDir, "a.example.com");
    assert.equal(store.assertGoal(taskId, "first", ["g1.md"]).ok, true);
    assert.equal(store.assertGoal(taskId, "second", ["g2.md"]).ok, true);

    const supports = store.listGoalFindings(taskId);
    assert.equal(supports.filter((s) => s.goalId === "first" && s.findingId === finding.id).length, 1);
    assert.equal(supports.filter((s) => s.goalId === "second" && s.findingId === finding.id).length, 1);

    store.retractFinding(taskId, finding.id, "客户确认误报");
    const first = store.recordDeliveryCorrection(taskId, { reason: "撤回一条被两个目标引用的发现" });
    assert.equal(first.created, true);
    assert.deepEqual(first.correction.goals, ["first", "second"]);
    assert.deepEqual(first.correction.findings, [finding.id]);
    assert.equal(first.correction.number, 1);
    const again = store.recordDeliveryCorrection(taskId, { reason: "重复处理同一撤回" });
    assert.equal(again.created, false, "同一撤回只产生一份更正");
    assert.equal(store.listDeliveryCorrections(taskId).length, 1);

    const snapshot = store.deliverySnapshot(taskId);
    const recomputed = scorecardFromSnapshot(JSON.parse(JSON.stringify(snapshot)));
    assert.equal(recomputed.ok, true);
    if (recomputed.ok) {
      const card = store.scorecard(taskId);
      assert.equal(recomputed.scorecard.historicallyPassed, card.historicallyPassed);
      assert.equal(recomputed.scorecard.currentlySupported, 0);
      assert.equal(recomputed.scorecard.retractedReferences, 2, "两个目标各引用一次");
      assert.equal(recomputed.sealValid, true);
    }
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("普通业务附件同名 ALL_COMPLETE.json 按文件判据处理；TSecBench 基准仍做清板校验", () => {
  const { root, evidenceDir, store } = setup("gy-board-");
  const taskId = randomUUID();
  try {
    store.seedGoals(taskId, [
      {
        id: "business", title: "普通委托附件", description: "同名业务附件",
        evidencePatterns: ["business/ALL_COMPLETE.json"],
        passes: false, evidencePaths: [], assertedAt: null,
      },
      {
        id: "benchmark", title: "基准清板", description: "明确选择 TSecBench 基准",
        evidencePatterns: ["tsec/ALL_COMPLETE.json"],
        boardGate: "tsecbench",
        passes: false, evidencePaths: [], assertedAt: null,
      },
    ]);
    // 业务附件不是挑战数组；按文件判据应当通过。
    writeEvidence(evidenceDir, "business/ALL_COMPLETE.json",
      JSON.stringify({ project: "甲乙双系统", delivered: true, items: [{ is_completed: false }] }));
    const business = store.assertGoal(taskId, "business", ["business/ALL_COMPLETE.json"]);
    assert.equal(business.ok, true, "普通委托不得因为文件名触发清板语义");

    // 基准入口：未清板必须拒绝。
    writeEvidence(evidenceDir, "tsec/ALL_COMPLETE.json",
      JSON.stringify([{ unique_code: "e1-01", is_completed: false }]));
    const blocked = store.assertGoal(taskId, "benchmark", ["tsec/ALL_COMPLETE.json"]);
    assert.equal(blocked.ok, false);
    if (!blocked.ok) assert.match(blocked.reason, /incomplete challenges/);

    writeEvidence(evidenceDir, "tsec/ALL_COMPLETE.json",
      JSON.stringify([{ unique_code: "e1-01", is_completed: true }]));
    const cleared = store.assertGoal(taskId, "benchmark", ["tsec/ALL_COMPLETE.json"]);
    assert.equal(cleared.ok, true);

    const goals = store.listGoals(taskId);
    const proofs = store.listGoalProofs(taskId);
    const findings = store.listFindings(taskId);
    const support = { goalFindings: store.listGoalFindings(taskId), findings };
    const businessLabel = describeGoalEvidence(goals.find((g) => g.id === "business")!, proofs, [], support);
    const benchLabel = describeGoalEvidence(goals.find((g) => g.id === "benchmark")!, proofs, [], support);
    assert.match(businessLabel, /仅文件判据/);
    assert.match(benchLabel, /内容判据/);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

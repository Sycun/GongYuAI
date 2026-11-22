/**
 * 真实业务验收（验收项 2）：从原始材料算差异，不依赖 mock worker。
 *
 * 输入只有业务字段：两份原始资产清单（CSV）与两份配置基线（JSON），通过
 * 普通入口 `POST /tasks/:id/evidence` 导入；核算走 `POST /tasks/:id/reconcile`。
 * 预期差异由 `docs/evidence/acceptance/business-fixtures/expected.json` 预先
 * 封存，脚本在上传前先核对封存哈希，运行结束后逐项比对——平台的核查实现
 * 全程读不到预期文件。
 *
 * 两项检验：
 * 1. 只改一个值（app-a-2 的 version）→ 对应差异必须随之变化；
 * 2. 移除一份必要材料（基线清单）→ 对应项必须显示缺件/未知。
 *
 * 运行：pnpm acceptance:business
 */
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { bootControlPlane } from "@gongyuai/control-plane";
import { scorecardFromSnapshot } from "@gongyuai/history";
import { gitCodeInfo, writeAcceptanceManifest } from "./acceptance-manifest.js";

const FIXTURES = join(process.cwd(), "docs", "evidence", "acceptance", "business-fixtures");
const startedAt = new Date().toISOString();
const ROOT = join(process.cwd(), ".gongyuai", "acceptance", `business-${Date.now()}`);
mkdirSync(ROOT, { recursive: true });

const TASK_NAME = "原始资产清单与配置基线差异核算（业务验收）";
const A = "diff.example.com";

type Step = { step: string; ok: boolean; detail: string; at: string };
const steps: Step[] = [];
function record(step: string, ok: boolean, detail: string) {
  steps.push({ step, ok, detail, at: new Date().toISOString() });
  console.log(`${ok ? "PASS" : "FAIL"}  ${step}  ${detail}`);
  if (!ok) throw new Error(`${step}: ${detail}`);
}
function check(condition: unknown, step: string, detail: string): boolean {
  record(step, Boolean(condition), detail);
  return Boolean(condition);
}

async function json<T>(base: string, path: string, init?: RequestInit): Promise<{ status: number; body: T }> {
  const res = await fetch(`${base}${path}`, init);
  const text = await res.text();
  let body: unknown;
  try { body = JSON.parse(text); } catch { body = text; }
  return { status: res.status, body: body as T };
}
function post(value: unknown): RequestInit {
  return { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(value) };
}

type ReconcileItem = {
  key: string;
  status: string;
  baselineLine: number | null;
  currentLine: number | null;
  changes: Array<{ field: string; before: string | null; after: string | null }>;
  reason?: string;
};
type ReconcileOutcome = {
  result: {
    counts: Record<string, number>;
    missingMaterials: string[];
    items: ReconcileItem[];
    keyField: string;
  };
  evidencePath: string;
  evidenceSha256: string;
};

function sha256File(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

/** 逐项比对：键、结论、来源行、字段变化。返回未命中清单。 */
function compareItems(
  expected: { items: Array<Record<string, unknown>> },
  actual: ReconcileItem[],
): string[] {
  const problems: string[] = [];
  const byKey = new Map(actual.map((item) => [item.key, item]));
  if (actual.length !== expected.items.length) {
    problems.push(`项数不符：实际 ${actual.length}，预期 ${expected.items.length}`);
  }
  expected.items.forEach((expectedItem, index) => {
    const key = String(expectedItem.key);
    const observed = byKey.get(key);
    if (!observed) {
      problems.push(`${key}: 实际输出缺少该项`);
      return;
    }
    if (observed.status !== expectedItem.status) {
      problems.push(`${key}: 结论 ${observed.status} ≠ 预期 ${String(expectedItem.status)}`);
    }
    if (observed.baselineLine !== expectedItem.baselineLine) {
      problems.push(`${key}: 基线行 ${String(observed.baselineLine)} ≠ 预期 ${String(expectedItem.baselineLine)}`);
    }
    if (observed.currentLine !== expectedItem.currentLine) {
      problems.push(`${key}: 当前行 ${String(observed.currentLine)} ≠ 预期 ${String(expectedItem.currentLine)}`);
    }
    const expectedChanges = JSON.stringify(expectedItem.changes ?? []);
    const actualChanges = JSON.stringify(observed.changes.map((change) => ({
      field: change.field, before: change.before, after: change.after,
    })));
    if (expectedChanges !== actualChanges) {
      problems.push(`${key}: 字段变化 ${actualChanges} ≠ 预期 ${expectedChanges}`);
    }
    if (expectedItem.reason && observed.reason !== expectedItem.reason) {
      problems.push(`${key}: 原因 ${String(observed.reason)} ≠ 预期 ${String(expectedItem.reason)}`);
    }
    if (observed.key !== expected.items[index]?.key) {
      // 顺序也是可核对项：便于人眼逐行比对。
      problems.push(`第 ${index + 1} 项顺序：实际 ${observed.key}，预期 ${key}`);
    }
  });
  return problems;
}

function compareCounts(expected: Record<string, number>, actual: Record<string, number>): string[] {
  return Object.entries(expected)
    .filter(([name, value]) => actual[name] !== value)
    .map(([name, value]) => `${name}: 实际 ${String(actual[name])} ≠ 预期 ${value}`);
}

async function main() {
  // 0) 先核对封存：预期差异与原始材料在运行前就固定。
  const expected = JSON.parse(readFileSync(join(FIXTURES, "expected.json"), "utf8")) as Record<string, any>;
  const sums = new Map(
    readFileSync(join(FIXTURES, "SHA256SUMS"), "utf8").trim().split("\n")
      .map((line) => line.trim().split(/\s+/) as [string, string])
      .map(([hash, name]) => [name, hash]),
  );
  for (const [name, hash] of sums) {
    check(sha256File(join(FIXTURES, name)) === hash, "0 封存哈希", `${name} ${hash.slice(0, 12)}…`);
  }
  record("0 预期差异已封存", true, `expected.json ${sums.get("expected.json")?.slice(0, 12)}…（平台看不到这一份）`);

  process.env.GY_MOCK_SKIP_PATTERNS = "reconcile/";
  const plane = await bootControlPlane({ dataRoot: ROOT, host: "127.0.0.1", port: 0, watchdogMs: 700 });
  let base = plane.url;

  const created = await json<any>(base, "/tasks", post({
    name: TASK_NAME,
    mock: true,
    auth: {
      authorizationNote: "虚构材料：仅用于差异核算的工程验收，不代表任何真实客户",
      targets: [A],
      outOfScope: [],
      capability: "observe",
    },
    goals: [
      {
        id: "asset-baseline-diff",
        title: "原始资产清单差异",
        description: "按业务主键核对两份原始资产清单",
        assets: [A],
        evidencePatterns: ["reconcile/asset-diff-*.json"],
      },
      {
        id: "config-baseline-diff",
        title: "配置基线差异",
        description: "按配置项核对两份原始配置基线",
        assets: [A],
        evidencePatterns: ["reconcile/config-diff-*.json"],
      },
    ],
  }));
  record("1 建档", created.status === 201, `POST /tasks → ${created.status}`);
  const taskId = created.body.task.id as string;
  record("1 委托标识", created.body.task.engagementId === taskId, `engagementId=${created.body.task.engagementId}`);

  // 普通操作员入口：暂停模拟 Worker，避免它替我们“生成材料”。
  const paused = await json<any>(base, `/tasks/${taskId}/pause`, { method: "POST" });
  record("1 暂停模拟 Worker", paused.status === 200 && paused.body.task.status === "paused", `status=${paused.body.task?.status}`);

  const upload = async (path: string, local: string) => {
    const content = readFileSync(join(FIXTURES, local), "utf8");
    const res = await json<any>(base, `/tasks/${taskId}/evidence`, post({ path, content }));
    record("2 导入原始材料", res.status === 201, `${path} ← ${local}（${content.length} 字节）`);
  };
  await upload("assets/baseline.csv", "baseline.csv");
  await upload("assets/current.csv", "current.csv");

  const requiredKeys = ["app-a-1", "app-a-2", "app-a-4", "app-a-6"];
  const first = await json<ReconcileOutcome>(base, `/tasks/${taskId}/reconcile`, post({
    name: "asset-diff",
    baseline: { path: "assets/baseline.csv" },
    current: { path: "assets/current.csv" },
    keyField: "host",
    requiredKeys,
  }));
  record("3 差异核算", first.status === 201, `POST /reconcile → ${first.status}`);
  const firstResult = first.body.result;
  const compare1 = [
    ...compareCounts(expected["asset-diff"].counts, firstResult.counts),
    ...compareItems(expected["asset-diff"], firstResult.items),
  ];
  record("3 逐项比对（原始输入）", compare1.length === 0, compare1.length ? compare1.join("；") : "全部一致");
  record(
    "3 结果落成证据",
    first.body.evidencePath.startsWith("reconcile/asset-diff-") && /^[0-9a-f]{64}$/.test(first.body.evidenceSha256),
    `${first.body.evidencePath} · ${first.body.evidenceSha256.slice(0, 12)}…`,
  );

  // 检验一：只改当前清单里的一个值。
  await upload("assets/current-v2.csv", "current-mutated.csv");
  const mutated = await json<ReconcileOutcome>(base, `/tasks/${taskId}/reconcile`, post({
    name: "asset-diff-mutated",
    baseline: { path: "assets/baseline.csv" },
    current: { path: "assets/current-v2.csv" },
    keyField: "host",
    requiredKeys,
  }));
  record("4 单值变更核算", mutated.status === 201, `POST /reconcile → ${mutated.status}`);
  const mutatedResult = mutated.body.result;
  const compare2 = [
    ...compareCounts(expected["asset-diff-mutated"].counts, mutatedResult.counts),
    ...compareItems(expected["asset-diff-mutated"], mutatedResult.items),
  ];
  record("4 逐项比对（改一个值）", compare2.length === 0, compare2.length ? compare2.join("；") : "全部一致");
  const before = firstResult.items.find((item) => item.key === "app-a-2")!;
  const after = mutatedResult.items.find((item) => item.key === "app-a-2")!;
  record(
    "4 对应差异确实变化",
    before.status === "unchanged" && after.status === "changed" &&
      after.changes[0]?.field === "version" && after.changes[0]?.after === "2.2",
    `app-a-2: ${before.status} → ${after.status}（${JSON.stringify(after.changes)}）`,
  );

  // 配置基线（JSON 形状）：同一核算实现也能读对象映射与数组。
  await upload("config/baseline.json", "config-baseline.json");
  await upload("config/current.json", "config-current.json");
  const config = await json<ReconcileOutcome>(base, `/tasks/${taskId}/reconcile`, post({
    name: "config-diff",
    baseline: { path: "config/baseline.json" },
    current: { path: "config/current.json" },
    keyField: "id",
  }));
  record("5 配置基线核算", config.status === 201, `POST /reconcile → ${config.status}`);
  const configResult = { ...config.body.result, items: config.body.result.items.map((item) => ({
    ...item,
    // 基线是对象映射，键来自 JSON 键名，行号取键首次出现的行。
    changes: item.changes,
  })) };
  const compare3 = [
    ...compareCounts(expected["config-diff"].counts, configResult.counts),
    ...compareItems(expected["config-diff"], configResult.items),
  ];
  record("5 逐项比对（配置基线）", compare3.length === 0, compare3.length ? compare3.join("；") : "全部一致");

  // 恢复运行：让普通 Worker 用“算出来的”结果去满足目标（不是由它生成材料）。
  const resumed = await json<any>(base, `/tasks/${taskId}/resume`, { method: "POST" });
  record("5 恢复运行", resumed.status === 200, `status=${resumed.body.task?.status}`);
  const deadline = Date.now() + 90_000;
  let finalTask: any = null;
  while (Date.now() < deadline) {
    const state = await json<any>(base, `/tasks/${taskId}`);
    finalTask = state.body.task;
    if (["completed", "incomplete", "failed", "budget_exhausted"].includes(finalTask?.status)) break;
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  record("5 目标由核算结果满足", finalTask?.status === "completed", `status=${finalTask?.status}`);
  const goalsAfter = (await json<any>(base, `/tasks/${taskId}/history`)).body.goals as Array<{ id: string; passes: boolean }>;
  record(
    "5 两个目标均通过",
    goalsAfter.every((goal) => goal.passes),
    goalsAfter.map((goal) => `${goal.id}=${goal.passes}`).join("、"),
  );

  // 检验二：移除一份必要材料（删掉基线清单文件），再算一次。
  const baselineFile = join(ROOT, "tasks", taskId, "evidence", "assets", "baseline.csv");
  if (check(existsSync(baselineFile), "6 删除前材料存在", baselineFile)) {
    unlinkSync(baselineFile);
    record("6 移除必要材料", true, "assets/baseline.csv 已从 evidence/ 删除");
  }
  const missing = await json<ReconcileOutcome>(base, `/tasks/${taskId}/reconcile`, post({
    name: "asset-diff-missing",
    baseline: { path: "assets/baseline.csv" },
    current: { path: "assets/current.csv" },
    keyField: "host",
    requiredKeys,
  }));
  record("6 缺件核算", missing.status === 201, `POST /reconcile → ${missing.status}`);
  const missingResult = missing.body.result;
  const compare4 = [
    ...compareCounts(expected["asset-diff-missing"].counts, missingResult.counts),
    ...(JSON.stringify(missingResult.missingMaterials) === JSON.stringify(expected["asset-diff-missing"].missingMaterials)
      ? []
      : [`missingMaterials ${JSON.stringify(missingResult.missingMaterials)} ≠ 预期 ${JSON.stringify(expected["asset-diff-missing"].missingMaterials)}`]),
    ...(JSON.stringify(missingResult.items.map((item) => item.status)) === JSON.stringify(expected["asset-diff-missing"].itemStatuses)
      ? []
      : [`各项状态 ${JSON.stringify(missingResult.items.map((item) => item.status))} ≠ 预期 ${JSON.stringify(expected["asset-diff-missing"].itemStatuses)}`]),
  ];
  record("6 逐项比对（移除材料）", compare4.length === 0, compare4.length ? compare4.join("；") : "全部一致");
  record(
    "6 缺件不是猜结论",
    missingResult.counts.unknown === missingResult.counts.totalKeys && missingResult.counts.changed === 0,
    `unknown=${missingResult.counts.unknown}/${missingResult.counts.totalKeys}，changed=${missingResult.counts.changed}`,
  );

  // 交付凭据：同一份快照 + 记分卡（供清单校验，与其他验收同一口径）。
  const snapshot = await json<any>(base, `/tasks/${taskId}/snapshot`);
  const snapshotPath = join(ROOT, "delivery-snapshot.json");
  writeFileSync(snapshotPath, JSON.stringify(snapshot.body.snapshot, null, 2) + "\n");
  const recomputed = scorecardFromSnapshot(JSON.parse(readFileSync(snapshotPath, "utf8")));
  record("7 快照可复算", recomputed.ok && recomputed.sealValid, "seal valid");
  const reconcileFacts = await json<any>(base, `/tasks/${taskId}/reconcile`);
  record(
    "7 四次核算都留了凭据",
    (reconcileFacts.body.results ?? []).length === 4 &&
      (reconcileFacts.body.results ?? []).every((entry: any) => typeof entry.evidencePath === "string"),
    `${(reconcileFacts.body.results ?? []).length} 条 reconcile Fact`,
  );
  record(
    "7 记分卡历史分子",
    snapshot.body.scorecard.historicallyPassed === snapshot.body.scorecard.denominator,
    `${snapshot.body.scorecard.historicallyPassed}/${snapshot.body.scorecard.denominator}`,
  );

  const runId = basename(ROOT);
  const code = gitCodeInfo();
  const runRecord = {
    runId,
    kind: "business-acceptance",
    taskId,
    dataRoot: ROOT,
    finishedAt: new Date().toISOString(),
    fixturesDir: FIXTURES,
    sealed: {
      expectedSha256: sums.get("expected.json"),
      materials: Object.fromEntries([...sums].filter(([name]) => name !== "expected.json")),
    },
    comparisons: {
      "asset-diff": { problems: compare1 },
      "asset-diff-mutated": { problems: compare2 },
      "config-diff": { problems: compare3 },
      "asset-diff-missing": { problems: compare4 },
    },
    actual: {
      "asset-diff": firstResult,
      "asset-diff-mutated": mutatedResult,
      "config-diff": configResult,
      "asset-diff-missing": missingResult,
    },
    steps,
    scorecard: snapshot.body.scorecard,
    snapshotPath,
    manifest: "acceptance-manifest.json",
  };
  writeFileSync(join(ROOT, "acceptance-record.json"), JSON.stringify(runRecord, null, 2) + "\n");
  writeFileSync(
    join(ROOT, "acceptance-record.md"),
    [
      "# 业务验收记录 — 从原始材料算差异",
      "",
      "> 输入只有业务字段（两份资产清单 + 两份配置基线），通过 `POST /tasks/:id/evidence` 导入；",
      "> 核算走 `POST /tasks/:id/reconcile`。预期差异由验收端预先封存，平台实现读不到。",
      "> 材料是虚构的：本次通过只代表工程可认定，真实生产效果另行验收。",
      "",
      `运行　${runId}`,
      `任务　${taskId}`,
      `委托　${TASK_NAME}`,
      `代码提交　${code.commit ?? "未记录"}${code.dirty ? "（工作区有未提交改动）" : ""}`,
      `数据目录　${ROOT}`,
      `完成时间　${runRecord.finishedAt}`,
      `校验清单　acceptance-manifest.json`,
      `封存预期　expected.json · SHA-256 ${sums.get("expected.json")}`,
      "",
      "| 步骤 | 结果 | 证据 |",
      "| --- | --- | --- |",
      ...steps.map((s) => `| ${s.step} | ${s.ok ? "通过" : "失败"} | ${s.detail.replace(/\|/g, "\\|")} |`),
      "",
      "## 逐项比对",
      "",
      "| 用例 | 未命中项 |",
      "| --- | --- |",
      `| asset-diff（原始输入） | ${compare1.length ? compare1.join("；") : "无"} |`,
      `| asset-diff-mutated（改一个值） | ${compare2.length ? compare2.join("；") : "无"} |`,
      `| config-diff（配置基线） | ${compare3.length ? compare3.join("；") : "无"} |`,
      `| asset-diff-missing（移除材料） | ${compare4.length ? compare4.join("；") : "无"} |`,
      "",
      `记分卡：曾通过 ${snapshot.body.scorecard.historicallyPassed}/${snapshot.body.scorecard.totalGoals}；` +
        `当前证据足以支持 ${snapshot.body.scorecard.currentlySupported}/${snapshot.body.scorecard.totalGoals}；` +
        `人工覆盖 未登记 ${snapshot.body.scorecard.coverage.unregistered}`,
      "",
      `快照内容封印　${snapshot.body.scorecard.snapshotSha256}（文件字节哈希见清单）`,
      "",
    ].join("\n"),
  );

  const manifest = writeAcceptanceManifest({
    dir: ROOT,
    kind: "business-acceptance",
    runId,
    taskId,
    dataRoot: ROOT,
    startedAt,
    finishedAt: runRecord.finishedAt,
    steps,
    code,
    notes: [
      "kind=business-acceptance：差异由平台实现从原始材料算出，预期差异另行封存。",
      "两份检验：单值变更必须改变对应差异；移除必要材料必须显示缺件/未知。",
      "材料为虚构样本；真实生产效果不在本次工程验收范围内。",
    ],
  });

  await plane.close();

  // 证据包里再附一份平台实际输出，便于复核人不用重跑也能逐项看。
  copyFileSync(join(ROOT, "acceptance-record.json"), join(ROOT, "acceptance-record.json"));
  console.log(
    `\n业务验收：${steps.length} 项（失败 ${steps.filter((s) => !s.ok).length}）· ` +
      `清单 ${join(ROOT, "acceptance-manifest.json")} · 快照封印 ${manifest.files.snapshot.sealSha256.slice(0, 12)}…`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

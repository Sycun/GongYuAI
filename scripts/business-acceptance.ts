/**
 * 真实业务验收（验收项 2）：从原始材料算差异，不依赖 mock worker 编造结论。
 *
 * 输入只有业务字段：两份原始资产清单（CSV）与两份配置基线（JSON），通过
 * 普通入口 `POST /tasks/:id/evidence` 导入；核算走 `POST /tasks/:id/reconcile`。
 * 预期差异由 `docs/evidence/acceptance/business-fixtures/expected.json` 预先
 * 封存，脚本在上传前先核对封存哈希，运行结束后逐项比对——平台的核查实现
 * 全程读不到预期文件。
 *
 * 覆盖（第七轮扩到 9 组）：
 * 1. 缺件 → 报告缺件且目标未通过 → 补交 → 重新核算 → 合格结果首次通过；
 * 2. 单值变更必须改变对应差异；
 * 3. 移除一份必要材料 → 对应项显示缺件/未知；
 * 4. 物理行号：空行占行号，原文件第 3 行的变化必须报第 3 行；
 * 5. 重复主键冲突 → 歧义，不报“未变”，目标不因它通过；
 * 6. 重复主键内容相同 → 收敛为一行（固定规则）；
 * 7. CRLF + 引号内逗号 → 行号不偏移、字段不被切碎。
 *
 * 运行：pnpm acceptance:business
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
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
const REQUIRED_KEYS = ["app-a-1", "app-a-2", "app-a-4", "app-a-6"];

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
  duplicates?: Array<{ material: string; line: number }>;
};
type ReconcileOutcome = {
  result: {
    counts: Record<string, number>;
    missingMaterials: string[];
    items: ReconcileItem[];
    keyField: string;
    name: string;
    baseline: { path: string; sha256: string | null };
    current: { path: string; sha256: string | null };
  };
  evidencePath: string;
  evidenceSha256: string;
};

function sha256File(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

/** 逐项比对：键、结论、来源行、字段变化、重复主键出处。返回未命中清单。 */
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
    if (expectedItem.reasonContains && !String(observed.reason ?? "").includes(String(expectedItem.reasonContains))) {
      problems.push(`${key}: 原因 ${String(observed.reason)} 不含 ${String(expectedItem.reasonContains)}`);
    }
    if (expectedItem.duplicates) {
      const actualDup = (observed.duplicates ?? []).map((entry) => [entry.material, entry.line]);
      if (JSON.stringify(actualDup) !== JSON.stringify(expectedItem.duplicates)) {
        problems.push(`${key}: 重复主键出处 ${JSON.stringify(actualDup)} ≠ 预期 ${JSON.stringify(expectedItem.duplicates)}`);
      }
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
  const base = plane.url;

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
        // 目标自报“完成比对”：必须由满足业务条件的核算结果满足。
        reconcileGate: { pattern: "reconcile/asset-diff-*.json", maxUnknown: 0, maxAmbiguous: 0 },
      },
      {
        id: "config-baseline-diff",
        title: "配置基线差异",
        description: "按配置项核对两份原始配置基线",
        assets: [A],
        evidencePatterns: ["reconcile/config-diff-*.json"],
        reconcileGate: { pattern: "reconcile/config-diff-*.json", maxUnknown: 0, maxAmbiguous: 0 },
      },
      {
        id: "gated-both-lists",
        title: "两份原始清单完成差异比对",
        description: "缺任一侧材料都不算完成比对；两份齐全后缺项本身是有效核查结论",
        assets: [A],
        evidencePatterns: ["reconcile/gated-*.json"],
        reconcileGate: { pattern: "reconcile/gated-*.json", maxUnknown: 0, maxAmbiguous: 0 },
      },
    ],
  }));
  record("1 建档", created.status === 201, `POST /tasks → ${created.status}`);
  const taskId = created.body.task.id as string;
  record("1 委托标识", created.body.task.engagementId === taskId, `engagementId=${created.body.task.engagementId}`);

  const paused = await json<any>(base, `/tasks/${taskId}/pause`, { method: "POST" });
  record("1 暂停模拟 Worker", paused.status === 200 && paused.body.task.status === "paused", `status=${paused.body.task?.status}`);

  const upload = async (path: string, local: string) => {
    const content = readFileSync(join(FIXTURES, local), "utf8");
    const res = await json<any>(base, `/tasks/${taskId}/evidence`, post({ path, content }));
    record("2 导入原始材料", res.status === 201, `${path} ← ${local}（${content.length} 字节）`);
    return content;
  };

  const waitTerminal = async (deadlineMs = 90_000) => {
    const deadline = Date.now() + deadlineMs;
    let state: any = null;
    while (Date.now() < deadline) {
      const res = await json<any>(base, `/tasks/${taskId}`);
      state = res.body.task;
      if (["completed", "incomplete", "failed", "budget_exhausted", "stopped"].includes(state?.status)) break;
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
    return state;
  };

  // ── 缺件阶段：只交当前清单 ───────────────────────────────────────────────
  const currentText = await upload("assets/current.csv", "current.csv");
  const gatedMissing = await json<ReconcileOutcome>(base, `/tasks/${taskId}/reconcile`, post({
    name: "gated-missing",
    baseline: { path: "assets/baseline.csv" },
    current: { path: "assets/current.csv" },
    keyField: "host",
    requiredKeys: REQUIRED_KEYS,
  }));
  record("3 缺基线核算被接受", gatedMissing.status === 201, `POST /reconcile → ${gatedMissing.status}`);
  const gatedMissingResult = gatedMissing.body.result;
  const compareMissing = [
    ...compareCounts(expected["gated-missing"].counts, gatedMissingResult.counts),
    ...(JSON.stringify(gatedMissingResult.missingMaterials) === JSON.stringify(expected["gated-missing"].missingMaterials)
      ? []
      : [`missingMaterials ${JSON.stringify(gatedMissingResult.missingMaterials)} ≠ 预期 ${JSON.stringify(expected["gated-missing"].missingMaterials)}`]),
    ...(gatedMissingResult.items.every((item) => item.status === "unknown")
      ? []
      : [`各项状态应为 unknown：${JSON.stringify(gatedMissingResult.items.map((item) => item.status))}`]),
  ];
  record("3 缺件结论逐项正确", compareMissing.length === 0, compareMissing.length ? compareMissing.join("；") : "全部一致（unknown 5/5）");

  // 走正常的任务恢复 → 目标判定 → 报告 → 记分卡。
  const resume1 = await json<any>(base, `/tasks/${taskId}/resume`, { method: "POST" });
  record("3 任务恢复", resume1.status === 200, `status=${resume1.body.task?.status}`);
  const afterMissing = await waitTerminal();
  record(
    "3 缺件运行没有判通过",
    afterMissing?.status === "incomplete",
    `任务 status=${afterMissing?.status}（缺件只交一侧时不得 completed）`,
  );
  const historyAfterMissing = await json<any>(base, `/tasks/${taskId}/history`);
  const gatedGoal = (historyAfterMissing.body.goals ?? []).find((goal: any) => goal.id === "gated-both-lists");
  record("3 该目标保持未通过", gatedGoal?.passes === false, `gated-both-lists passes=${String(gatedGoal?.passes)}`);
  const rejection = (historyAfterMissing.body.events ?? []).find(
    (event: any) => event.kind === "goal_assert_rejected" && event.payload?.goalId === "gated-both-lists",
  );
  record(
    "3 未通过原因点名缺件材料",
    String(rejection?.payload?.reason ?? "").includes("缺少基线材料 assets/baseline.csv"),
    String(rejection?.payload?.reason ?? "没有拒绝记录").slice(0, 160),
  );
  const proofsAfterMissing = (historyAfterMissing.body.goalProofs ?? []).filter(
    (proof: any) => proof.goalId === "gated-both-lists",
  );
  record("3 缺件阶段没有首次通过依据", proofsAfterMissing.length === 0, `goalProofs=${proofsAfterMissing.length}`);
  const cardAfterMissing = await json<any>(base, `/tasks/${taskId}/snapshot`);
  record(
    "3 记分卡当前支持为 0",
    cardAfterMissing.body.scorecard.currentlySupported === 0 &&
      cardAfterMissing.body.scorecard.historicallyPassed === 0,
    `历史 ${cardAfterMissing.body.scorecard.historicallyPassed}/${cardAfterMissing.body.scorecard.denominator} · ` +
      `当前 ${cardAfterMissing.body.scorecard.currentlySupported}/${cardAfterMissing.body.scorecard.denominator}`,
  );
  const reportAfterMissing = await (await fetch(`${base}/tasks/${taskId}/report`)).text();
  record(
    "3 报告写出缺件与未通过",
    reportAfterMissing.includes("缺少基线材料 assets/baseline.csv") &&
      !reportAfterMissing.includes("首次通过采用的核算文件"),
    "报告含缺件原因，且没有首次通过核算文件",
  );

  // ── 补交阶段：两份齐全后重新核算 ────────────────────────────────────────
  await upload("assets/baseline.csv", "baseline.csv");
  const first = await json<ReconcileOutcome>(base, `/tasks/${taskId}/reconcile`, post({
    name: "asset-diff",
    baseline: { path: "assets/baseline.csv" },
    current: { path: "assets/current.csv" },
    keyField: "host",
    requiredKeys: REQUIRED_KEYS,
  }));
  record("4 补交后差异核算", first.status === 201, `POST /reconcile → ${first.status}`);
  const firstResult = first.body.result;
  const compare1 = [
    ...compareCounts(expected["asset-diff"].counts, firstResult.counts),
    ...compareItems(expected["asset-diff"], firstResult.items),
  ];
  record("4 逐项比对（原始输入）", compare1.length === 0, compare1.length ? compare1.join("；") : "全部一致");
  record(
    "4 结果落成证据",
    first.body.evidencePath.startsWith("reconcile/asset-diff-") && /^[0-9a-f]{64}$/.test(first.body.evidenceSha256),
    `${first.body.evidencePath} · ${first.body.evidenceSha256.slice(0, 12)}…`,
  );

  const gatedGood = await json<ReconcileOutcome>(base, `/tasks/${taskId}/reconcile`, post({
    name: "gated-diff",
    baseline: { path: "assets/baseline.csv" },
    current: { path: "assets/current.csv" },
    keyField: "host",
    requiredKeys: REQUIRED_KEYS,
  }));
  record("4 合格核算（两份齐全）", gatedGood.status === 201, `POST /reconcile → ${gatedGood.status}`);
  const gatedGoodResult = gatedGood.body.result;
  record(
    "4 合格核算两侧材料都有封存哈希",
    /^[0-9a-f]{64}$/.test(gatedGoodResult.baseline.sha256 ?? "") &&
      /^[0-9a-f]{64}$/.test(gatedGoodResult.current.sha256 ?? "") &&
      gatedGoodResult.missingMaterials.length === 0,
    `baseline ${String(gatedGoodResult.baseline.sha256).slice(0, 12)}… · current ${String(gatedGoodResult.current.sha256).slice(0, 12)}…`,
  );

  // 单值变更（只改当前清单里的一个值）。
  await upload("assets/current-v2.csv", "current-mutated.csv");
  const mutated = await json<ReconcileOutcome>(base, `/tasks/${taskId}/reconcile`, post({
    name: "asset-diff-mutated",
    baseline: { path: "assets/baseline.csv" },
    current: { path: "assets/current-v2.csv" },
    keyField: "host",
    requiredKeys: REQUIRED_KEYS,
  }));
  record("5 单值变更核算", mutated.status === 201, `POST /reconcile → ${mutated.status}`);
  const mutatedResult = mutated.body.result;
  const compare2 = [
    ...compareCounts(expected["asset-diff-mutated"].counts, mutatedResult.counts),
    ...compareItems(expected["asset-diff-mutated"], mutatedResult.items),
  ];
  record("5 逐项比对（改一个值）", compare2.length === 0, compare2.length ? compare2.join("；") : "全部一致");
  const before = firstResult.items.find((item) => item.key === "app-a-2")!;
  const after = mutatedResult.items.find((item) => item.key === "app-a-2")!;
  record(
    "5 对应差异确实变化",
    before.status === "unchanged" && after.status === "changed" &&
      after.changes[0]?.field === "version" && after.changes[0]?.after === "2.2",
    `app-a-2: ${before.status} → ${after.status}（${JSON.stringify(after.changes)}）`,
  );

  // 配置基线（JSON 形状）。
  await upload("config/baseline.json", "config-baseline.json");
  await upload("config/current.json", "config-current.json");
  const config = await json<ReconcileOutcome>(base, `/tasks/${taskId}/reconcile`, post({
    name: "config-diff",
    baseline: { path: "config/baseline.json" },
    current: { path: "config/current.json" },
    keyField: "id",
  }));
  record("6 配置基线核算", config.status === 201, `POST /reconcile → ${config.status}`);
  const compare3 = [
    ...compareCounts(expected["config-diff"].counts, config.body.result.counts),
    ...compareItems(expected["config-diff"], config.body.result.items),
  ];
  record("6 逐项比对（配置基线）", compare3.length === 0, compare3.length ? compare3.join("；") : "全部一致");

  // ── 第七轮新增反例（全部走正常核算入口） ────────────────────────────────
  await upload("assets/baseline-line3.csv", "baseline-line3.csv");
  await upload("assets/current-line3.csv", "current-line3.csv");
  const line3 = await json<ReconcileOutcome>(base, `/tasks/${taskId}/reconcile`, post({
    name: "line3-diff",
    baseline: { path: "assets/baseline-line3.csv" },
    current: { path: "assets/current-line3.csv" },
    keyField: "host",
  }));
  record("7 行号核算", line3.status === 201, `POST /reconcile → ${line3.status}`);
  const compare4 = [
    ...compareCounts(expected["line3-diff"].counts, line3.body.result.counts),
    ...compareItems(expected["line3-diff"], line3.body.result.items),
  ];
  record("7 原文件第 3 行的变化报第 3 行", compare4.length === 0, compare4.length ? compare4.join("；") : "全部一致");
  const line3Item = line3.body.result.items.find((item) => item.key === "app-a-1")!;
  record(
    "7 行号读数",
    line3Item.baselineLine === 3 && line3Item.currentLine === 3,
    `app-a-1 基线第 ${String(line3Item.baselineLine)} 行 / 当前第 ${String(line3Item.currentLine)} 行`,
  );

  await upload("assets/baseline-dup.csv", "baseline-dup.csv");
  await upload("assets/current-dup.csv", "current-dup.csv");
  const dup = await json<ReconcileOutcome>(base, `/tasks/${taskId}/reconcile`, post({
    name: "dup-diff",
    baseline: { path: "assets/baseline-dup.csv" },
    current: { path: "assets/current-dup.csv" },
    keyField: "host",
  }));
  record("8 重复主键核算", dup.status === 201, `POST /reconcile → ${dup.status}`);
  const compare5 = [
    ...compareCounts(expected["dup-diff"].counts, dup.body.result.counts),
    ...compareItems(expected["dup-diff"], dup.body.result.items),
  ];
  record("8 冲突重复主键标为歧义而非未变", compare5.length === 0, compare5.length ? compare5.join("；") : "全部一致");
  const dupItem = dup.body.result.items.find((item) => item.key === "test-A")!;
  record(
    "8 冲突项列出全部来源行",
    dupItem.status === "ambiguous" && (dupItem.duplicates ?? []).length === 2,
    `test-A ${dupItem.status}；出处 ${JSON.stringify((dupItem.duplicates ?? []).map((entry) => `${entry.material}:${entry.line}`))}`,
  );

  await upload("assets/baseline-dup-same.csv", "baseline-dup-same.csv");
  await upload("assets/current-dup-same.csv", "current-dup-same.csv");
  const dupSame = await json<ReconcileOutcome>(base, `/tasks/${taskId}/reconcile`, post({
    name: "dup-same-diff",
    baseline: { path: "assets/baseline-dup-same.csv" },
    current: { path: "assets/current-dup-same.csv" },
    keyField: "host",
  }));
  record("9 相同重复行核算", dupSame.status === 201, `POST /reconcile → ${dupSame.status}`);
  const compare6 = [
    ...compareCounts(expected["dup-same-diff"].counts, dupSame.body.result.counts),
    ...compareItems(expected["dup-same-diff"], dupSame.body.result.items),
  ];
  record("9 内容相同的重复行收敛为一行", compare6.length === 0, compare6.length ? compare6.join("；") : "全部一致");

  await upload("assets/baseline-quoted.csv", "baseline-quoted.csv");
  await upload("assets/current-quoted.csv", "current-quoted.csv");
  const quoted = await json<ReconcileOutcome>(base, `/tasks/${taskId}/reconcile`, post({
    name: "quoted-diff",
    baseline: { path: "assets/baseline-quoted.csv" },
    current: { path: "assets/current-quoted.csv" },
    keyField: "host",
  }));
  record("10 CRLF+引号内逗号核算", quoted.status === 201, `POST /reconcile → ${quoted.status}`);
  const compare7 = [
    ...compareCounts(expected["quoted-diff"].counts, quoted.body.result.counts),
    ...compareItems(expected["quoted-diff"], quoted.body.result.items),
  ];
  record("10 CRLF 与引号内逗号不影响行号与字段", compare7.length === 0, compare7.length ? compare7.join("；") : "全部一致");

  // ── 首次通过：重新判定同一批目标 ────────────────────────────────────────
  const resume2 = await json<any>(base, `/tasks/${taskId}/resume`, { method: "POST" });
  record(
    "11 补交后从正常入口重新判定",
    resume2.status === 200,
    `POST /resume → ${resume2.status} status=${resume2.body.task?.status}`,
  );
  const finalTask = await waitTerminal();
  record("11 目标由核算结果满足", finalTask?.status === "completed", `status=${finalTask?.status}`);
  const historyFinal = await json<any>(base, `/tasks/${taskId}/history`);
  const goalsFinal = historyFinal.body.goals as Array<{ id: string; passes: boolean }>;
  record(
    "11 三个目标均通过",
    goalsFinal.every((goal) => goal.passes),
    goalsFinal.map((goal) => `${goal.id}=${goal.passes}`).join("、"),
  );

  const gatedProofs = (historyFinal.body.goalProofs ?? []).filter((proof: any) => proof.goalId === "gated-both-lists");
  record(
    "11 首次通过只指向一份核算文件",
    gatedProofs.length === 1 && String(gatedProofs[0]?.path).startsWith("reconcile/gated-diff-"),
    JSON.stringify(gatedProofs.map((proof: any) => `${proof.path} ${String(proof.sha256).slice(0, 12)}…`)),
  );
  const adoptedEvent = (historyFinal.body.events ?? []).find(
    (event: any) => event.kind === "goal_asserted" && event.payload?.goalId === "gated-both-lists",
  );
  const adopted = adoptedEvent?.payload?.adoptedReconcile as { path: string; sha256: string } | undefined;
  record(
    "11 首次通过事件指向实际采用的核算文件",
    Boolean(adopted) && adopted!.path === gatedProofs[0]?.path && adopted!.sha256 === gatedProofs[0]?.sha256,
    `${String(adopted?.path)} · ${String(adopted?.sha256).slice(0, 12)}…`,
  );
  record(
    "11 采用的核算文件哈希与生成时一致",
    adopted?.sha256 === gatedGood.body.evidenceSha256,
    `生成时 ${gatedGood.body.evidenceSha256.slice(0, 12)}… / 首次通过 ${String(adopted?.sha256).slice(0, 12)}…`,
  );
  record(
    "11 重复提交不重复记账",
    (historyFinal.body.events ?? []).filter(
      (event: any) => event.kind === "goal_asserted" && event.payload?.goalId === "gated-both-lists",
    ).length === 1,
    "goal_asserted 只有一条",
  );

  const snapshot = await json<any>(base, `/tasks/${taskId}/snapshot`);
  const snapshotPath = join(ROOT, "delivery-snapshot.json");
  writeFileSync(snapshotPath, JSON.stringify(snapshot.body.snapshot, null, 2) + "\n");
  const recomputed = scorecardFromSnapshot(JSON.parse(readFileSync(snapshotPath, "utf8")));
  record("12 快照可复算", recomputed.ok && recomputed.sealValid, "seal valid");
  record(
    "12 记分卡历史分子与当前支持",
    snapshot.body.scorecard.historicallyPassed === snapshot.body.scorecard.denominator &&
      snapshot.body.scorecard.currentlySupported === snapshot.body.scorecard.denominator,
    `历史 ${snapshot.body.scorecard.historicallyPassed}/${snapshot.body.scorecard.denominator} · ` +
      `当前 ${snapshot.body.scorecard.currentlySupported}/${snapshot.body.scorecard.denominator}`,
  );
  const reportFinal = await (await fetch(`${base}/tasks/${taskId}/report`)).text();
  record(
    "12 报告引用采用的核算文件与哈希",
    reportFinal.includes(String(adopted?.path)) && reportFinal.includes(String(adopted?.sha256)),
    `${String(adopted?.path)} · ${String(adopted?.sha256).slice(0, 12)}…`,
  );

  // ── 移除必要材料：核算必须降级为未知 ────────────────────────────────────
  const baselineFile = join(ROOT, "tasks", taskId, "evidence", "assets", "baseline.csv");
  if (check(existsSync(baselineFile), "13 删除前材料存在", baselineFile)) {
    unlinkSync(baselineFile);
    record("13 移除必要材料", true, "assets/baseline.csv 已从 evidence/ 删除");
  }
  const missing = await json<ReconcileOutcome>(base, `/tasks/${taskId}/reconcile`, post({
    name: "asset-diff-missing",
    baseline: { path: "assets/baseline.csv" },
    current: { path: "assets/current.csv" },
    keyField: "host",
    requiredKeys: REQUIRED_KEYS,
  }));
  record("13 缺件核算", missing.status === 201, `POST /reconcile → ${missing.status}`);
  const missingResult = missing.body.result;
  const compare8 = [
    ...compareCounts(expected["asset-diff-missing"].counts, missingResult.counts),
    ...(JSON.stringify(missingResult.missingMaterials) === JSON.stringify(expected["asset-diff-missing"].missingMaterials)
      ? []
      : [`missingMaterials ${JSON.stringify(missingResult.missingMaterials)} ≠ 预期 ${JSON.stringify(expected["asset-diff-missing"].missingMaterials)}`]),
    ...(JSON.stringify(missingResult.items.map((item) => item.status)) === JSON.stringify(expected["asset-diff-missing"].itemStatuses)
      ? []
      : [`各项状态 ${JSON.stringify(missingResult.items.map((item) => item.status))} ≠ 预期 ${JSON.stringify(expected["asset-diff-missing"].itemStatuses)}`]),
  ];
  record("13 逐项比对（移除材料）", compare8.length === 0, compare8.length ? compare8.join("；") : "全部一致");
  record(
    "13 缺件不是猜结论",
    missingResult.counts.unknown === missingResult.counts.totalKeys && missingResult.counts.changed === 0,
    `unknown=${missingResult.counts.unknown}/${missingResult.counts.totalKeys}，changed=${missingResult.counts.changed}`,
  );

  // 历史通过记录保留：已通过的目标不因后续材料缺失被改写。
  const historyAfterDelete = await json<any>(base, `/tasks/${taskId}/history`);
  const gatedAfterDelete = (historyAfterDelete.body.goals ?? []).find((goal: any) => goal.id === "gated-both-lists");
  record(
    "13 历史通过记录保留",
    gatedAfterDelete?.passes === true,
    `gated-both-lists passes=${String(gatedAfterDelete?.passes)}（材料缺失不改写历史通过）`,
  );

  const reconcileFacts = await json<any>(base, `/tasks/${taskId}/reconcile`);
  record(
    "14 每次核算都留了凭据",
    (reconcileFacts.body.results ?? []).length === 10 &&
      (reconcileFacts.body.results ?? []).every((entry: any) => typeof entry.evidencePath === "string"),
    `${(reconcileFacts.body.results ?? []).length} 条 reconcile Fact`,
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
    gate: {
      goalId: "gated-both-lists",
      missingStage: {
        missingMaterials: gatedMissingResult.missingMaterials,
        counts: gatedMissingResult.counts,
        taskStatus: afterMissing?.status,
        rejectionReason: String(rejection?.payload?.reason ?? ""),
        currentlySupported: cardAfterMissing.body.scorecard.currentlySupported,
      },
      firstPass: {
        adoptedPath: adopted?.path ?? null,
        adoptedSha256: adopted?.sha256 ?? null,
        generatedSha256: gatedGood.body.evidenceSha256,
        proofCount: gatedProofs.length,
      },
    },
    comparisons: {
      "gated-missing": { problems: compareMissing },
      "asset-diff": { problems: compare1 },
      "asset-diff-mutated": { problems: compare2 },
      "config-diff": { problems: compare3 },
      "line3-diff": { problems: compare4 },
      "dup-diff": { problems: compare5 },
      "dup-same-diff": { problems: compare6 },
      "quoted-diff": { problems: compare7 },
      "asset-diff-missing": { problems: compare8 },
    },
    actual: {
      "gated-missing": gatedMissingResult,
      "asset-diff": firstResult,
      "asset-diff-mutated": mutatedResult,
      "config-diff": config.body.result,
      "line3-diff": line3.body.result,
      "dup-diff": dup.body.result,
      "dup-same-diff": dupSame.body.result,
      "quoted-diff": quoted.body.result,
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
      "## 缺件 → 补交 → 首次通过",
      "",
      `1. 只交当前清单：核算 missingMaterials=${JSON.stringify(gatedMissingResult.missingMaterials)}，` +
        `unknown=${gatedMissingResult.counts.unknown}/${gatedMissingResult.counts.totalKeys}；任务 status=${afterMissing?.status}；` +
        `当前支持 ${cardAfterMissing.body.scorecard.currentlySupported}/${cardAfterMissing.body.scorecard.denominator}。`,
      `2. 拒绝原因（事件台账）：${String(rejection?.payload?.reason ?? "无")}`,
      `3. 补交基线后重新核算：${String(adopted?.path)} · SHA-256 ${String(adopted?.sha256)}`,
      `4. 首次通过采用的核算文件与上面这一份相同：${adopted?.sha256 === gatedGood.body.evidenceSha256}；` +
        `首次通过依据 ${gatedProofs.length} 条（重复提交不重复记账）。`,
      "",
      "| 步骤 | 结果 | 证据 |",
      "| --- | --- | --- |",
      ...steps.map((s) => `| ${s.step} | ${s.ok ? "通过" : "失败"} | ${s.detail.replace(/\|/g, "\\|")} |`),
      "",
      "## 逐项比对",
      "",
      "| 用例 | 未命中项 |",
      "| --- | --- |",
      `| gated-missing（只交一侧） | ${compareMissing.length ? compareMissing.join("；") : "无"} |`,
      `| asset-diff（原始输入） | ${compare1.length ? compare1.join("；") : "无"} |`,
      `| asset-diff-mutated（改一个值） | ${compare2.length ? compare2.join("；") : "无"} |`,
      `| config-diff（配置基线） | ${compare3.length ? compare3.join("；") : "无"} |`,
      `| line3-diff（空行占行号） | ${compare4.length ? compare4.join("；") : "无"} |`,
      `| dup-diff（重复主键冲突） | ${compare5.length ? compare5.join("；") : "无"} |`,
      `| dup-same-diff（重复行内容相同） | ${compare6.length ? compare6.join("；") : "无"} |`,
      `| quoted-diff（CRLF + 引号内逗号） | ${compare7.length ? compare7.join("；") : "无"} |`,
      `| asset-diff-missing（移除材料） | ${compare8.length ? compare8.join("；") : "无"} |`,
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
      "缺件阶段必须报告缺件且目标未通过；补交后同一目标才能首次通过。",
      "行号、重复主键、CRLF 与引号内逗号都是正常核算入口的实测。",
      "材料为虚构样本；真实生产效果不在本次工程验收范围内。",
    ],
  });

  await plane.close();

  console.log(
    `\n业务验收：${steps.length} 项（失败 ${steps.filter((s) => !s.ok).length}）· ` +
      `清单 ${join(ROOT, "acceptance-manifest.json")} · 快照封印 ${manifest.files.snapshot.sealSha256.slice(0, 12)}…`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

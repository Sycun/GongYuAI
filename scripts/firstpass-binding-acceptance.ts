/**
 * 第八轮验收：首次通过必须绑定“判定时有效的那一版输入”，且业务核算目标只能
 * 由控制台/接口正常建档入口产生。
 *
 * 两条主线（对应上轮独立复核的两个反例）：
 * A. 业务核算目标只交当前清单 → 核算报告缺基线 → 判定点名缺件、0/1、首次通过 0；
 *    补交基线后重新核算 → 1/1，首次通过引用刚生成的真实文件与那一版输入哈希。
 * B. 两笔独立任务，各自先生成一份合格旧结果，并确认还没有首次通过事件：
 *    B1 撤回基线：在“撤回后未重算”“重算已报缺件”两个时点判定都必须 0/1；
 *    B2 同一路径替换成含冲突重复键的材料：新结果歧义、界面能读到冲突键与来源行，
 *       旧合格结果仍可查，首次通过仍为 0；两笔修正后重新核算才首次通过。
 *
 * 另外覆盖：输入一变就显示待补/待重算、并发判定只产生一条首次通过事件、
 * 输入哈希/结果文件/封存原件/报告引用/记分卡逐项一致。
 *
 * 运行：pnpm acceptance:firstpass
 */
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { bootControlPlane } from "@gongyuai/control-plane";
import { gitCodeInfo } from "./acceptance-manifest.js";

const ROOT = join(process.cwd(), ".gongyuai", "acceptance", `firstpass-${Date.now()}`);
mkdirSync(ROOT, { recursive: true });
const RUN_ID = `firstpass-${Date.now()}`;

const BASELINE = [
  "host,role,version",
  "app-a-1,web,1.4",
  "app-a-2,db,2.1",
  "app-a-6,queue,3.0",
].join("\n");
const CURRENT = [
  "host,role,version",
  "app-a-1,web,1.5",
  "app-a-2,db,2.1",
  "app-a-6,queue,3.0",
].join("\n");
/** 同一路径但含冲突重复主键：app-a-1 第 2、3 行内容冲突。 */
const CONFLICTING = [
  "host,role,version",
  "app-a-1,web,1.5",
  "app-a-1,web,9.9",
  "app-a-2,db,2.1",
  "app-a-6,queue,3.0",
].join("\n");
const REQUIRED_KEYS = ["app-a-1", "app-a-6"];

type Step = { step: string; ok: boolean; detail: string; at: string };
const steps: Step[] = [];
function record(step: string, ok: boolean, detail: string) {
  steps.push({ step, ok, detail, at: new Date().toISOString() });
  console.log(`${ok ? "PASS" : "FAIL"}  ${step}  ${detail}`);
  if (!ok) throw new Error(`${step}: ${detail}`);
}
function check(step: string, condition: unknown, detail: string): boolean {
  record(step, Boolean(condition), detail);
  return Boolean(condition);
}
function sha256(data: string | Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

async function call<T>(
  base: string,
  path: string,
  init?: RequestInit,
): Promise<{ status: number; body: T }> {
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
/** 取证据原文（不解析 JSON）：复核“文件字节没变”要用原始字节算哈希。 */
async function fetchText(base: string, path: string): Promise<{ status: number; text: string }> {
  const res = await fetch(`${base}${path}`);
  return { status: res.status, text: await res.text() };
}
const post = (value: unknown): RequestInit => ({
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(value),
});

type Revision = {
  id: string;
  goalIds: string[];
  configDigest: string;
  inputDigest: string;
  baseline: { path: string; present: boolean; sha256: string | null };
  current: { path: string; present: boolean; sha256: string | null };
};
type Outcome = {
  result: {
    name: string;
    counts: Record<string, number>;
    missingMaterials: string[];
    items: Array<{
      key: string;
      status: string;
      reason?: string;
      duplicates?: Array<{ material: string; line: number; endLine: number }>;
    }>;
  };
  evidencePath: string;
  evidenceSha256: string;
  revision: Revision;
};
type HistoryBody = {
  goals: Array<{
    id: string;
    passes: boolean;
    evidencePaths?: string[];
    reconcileState?: { state: string; reason: string | null; latestRevisionId: string | null };
    business?: unknown;
    kind?: string;
  }>;
  events: Array<{ kind: string; payload: Record<string, unknown> }>;
  goalProofs: Array<{ goalId: string; path: string; sha256: string }>;
  reconcileRevisions?: Array<{ revision: Revision; evidencePath: string; evidenceSha256: string }>;
};


/** 走正常入口收尾：恢复任务 → 等终态 → 取报告（报告只在终态写出）。 */
async function finalizeAndReport(base: string, taskId: string): Promise<string> {
  const resumed = await call<{ task: { status: string } }>(base, `/tasks/${taskId}/resume`, { method: "POST" });
  record(`恢复任务 ${taskId.slice(0, 8)}`, resumed.status === 200, `status=${resumed.body.task?.status}`);
  const deadline = Date.now() + 90_000;
  let status = "";
  while (Date.now() < deadline) {
    const res = await call<{ task: { status: string } }>(base, `/tasks/${taskId}`);
    status = res.body.task?.status ?? "";
    if (["completed", "incomplete", "failed", "budget_exhausted", "stopped"].includes(status)) break;
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  record(`任务到达终态 ${taskId.slice(0, 8)}`, status === "completed", `status=${status}`);
  return (await call<string>(base, `/tasks/${taskId}/report`)).body;
}

async function createBusinessTask(
  base: string,
  name: string,
  goalId = "biz-diff",
): Promise<string> {
  const created = await call<{ task: { id: string; goals: Array<Record<string, unknown>> } }>(
    base,
    "/tasks",
    post({
      name,
      mock: true,
      auth: {
        authorizationNote: "虚构材料：仅用于首次通过与核算输入绑定的工程验收",
        targets: ["diff.example.com"],
        outOfScope: [],
        capability: "observe",
      },
      goals: [
        {
          id: goalId,
          title: "两份原始清单完成差异比对",
          description: "操作员声明要对照基线与当前两份原始清单",
          kind: "business-reconcile",
          // 关键：不写 evidencePatterns / reconcileGate，由服务端从 business 派生。
          business: {
            name: "asset-diff",
            keyField: "host",
            requiredKeys: REQUIRED_KEYS,
            maxUnknown: 0,
            maxAmbiguous: 0,
            baseline: { path: "assets/baseline.csv" },
            current: { path: "assets/current.csv" },
          },
        },
      ],
    }),
  );
  record(
    `建档 ${name}`,
    created.status === 201,
    `POST /tasks → ${created.status}`,
  );
  const goal = created.body.task.goals[0] as Record<string, unknown>;
  record(
    `建档 ${name} · 系统派生核算条件`,
    goal.kind === "business-reconcile" &&
      JSON.stringify(goal.evidencePatterns) === JSON.stringify(["reconcile/asset-diff-*.json"]) &&
      (goal.reconcileGate as { pattern?: string } | undefined)?.pattern === "reconcile/asset-diff-*.json",
    `kind=${String(goal.kind)} patterns=${JSON.stringify(goal.evidencePatterns)} gate=${JSON.stringify(goal.reconcileGate)}`,
  );
  const taskId = created.body.task.id;
  // 暂停模拟 worker：本验收只走操作员入口的核算与判定。
  const paused = await call<{ task: { status: string } }>(base, `/tasks/${taskId}/pause`, { method: "POST" });
  record(`建档 ${name} · 暂停 worker`, paused.status === 200, `status=${paused.body.task?.status}`);
  return taskId;
}

async function upload(base: string, taskId: string, path: string, content: string) {
  const res = await call<{ path: string; sha256: string; replaced: boolean }>(
    base,
    `/tasks/${taskId}/evidence`,
    post({ path, content }),
  );
  record(
    `导入材料 ${path}`,
    res.status === 201 && res.body.sha256 === sha256(content),
    `→ ${res.status} sha256=${String(res.body.sha256).slice(0, 12)}… replaced=${res.body.replaced}`,
  );
  return res.body;
}

async function withdraw(base: string, taskId: string, path: string, expectSha: string) {
  const res = await call<{ removed: string; sha256: string }>(
    base,
    `/tasks/${taskId}/evidence?path=${encodeURIComponent(path)}`,
    { method: "DELETE" },
  );
  record(
    `撤回材料 ${path}`,
    res.status === 200 && res.body.sha256 === expectSha,
    `→ ${res.status} 撤回前 sha256=${String(res.body.sha256).slice(0, 12)}…`,
  );
}

async function reconcile(base: string, taskId: string, goalId: string): Promise<Outcome> {
  const res = await call<Outcome>(base, `/tasks/${taskId}/reconcile`, post({ goalId }));
  record(
    `按目标配置核算 ${goalId}`,
    res.status === 201 && Boolean(res.body.revision?.id),
    `→ ${res.status} revision=${res.body.revision?.id} 结果=${res.body.evidencePath}`,
  );
  return res.body;
}

async function assertGoal(
  base: string,
  taskId: string,
  goalId: string,
): Promise<{ status: number; ok: boolean; reason?: string }> {
  const res = await call<{ ok: boolean; reason?: string }>(
    base,
    `/tasks/${taskId}/goals/assert`,
    post({ goalId }),
  );
  return { status: res.status, ok: Boolean(res.body.ok), ...(res.body.reason ? { reason: res.body.reason } : {}) };
}

async function history(base: string, taskId: string): Promise<HistoryBody> {
  const res = await call<HistoryBody>(base, `/tasks/${taskId}/history`);
  return res.body;
}

async function scorecard(base: string, taskId: string) {
  const res = await call<{ scorecard: { historicallyPassed: number; currentlySupported: number; denominator: number } }>(
    base,
    `/tasks/${taskId}/scorecard`,
  );
  return res.body.scorecard;
}

function provesNothingYet(body: HistoryBody, goalId: string): boolean {
  return (
    body.goals.find((goal) => goal.id === goalId)?.passes === false &&
    body.events.filter((event) => event.kind === "goal_asserted").length === 0 &&
    body.goalProofs.filter((proof) => proof.goalId === goalId).length === 0
  );
}

async function main() {
  const startedAt = new Date().toISOString();
  // 与既有验收一致：显式 dataRoot 保证数据隔离，同时保留 watchdog——
  // 任务终态与报告由它从 worker-status 侧车提升，去掉它任务会停在 recovering。
  const plane = await bootControlPlane({ dataRoot: ROOT, host: "127.0.0.1", port: 0, watchdogMs: 300 });
  const base = plane.url;
  const evidence: Record<string, unknown> = {};

  try {
    // ── A：缺基线 → 补交 → 首次通过 ────────────────────────────────────────
    const taskA = await createBusinessTask(base, "A 业务核算（缺基线→补交）");
    await upload(base, taskA, "assets/current.csv", CURRENT);

    const missing = await reconcile(base, taskA, "biz-diff");
    check(
      "A1 缺基线时核算点名缺件",
      missing.result.missingMaterials.includes("assets/baseline.csv") && missing.revision.baseline.present === false,
      `missingMaterials=${JSON.stringify(missing.result.missingMaterials)} unknown=${missing.result.counts.unknown}`,
    );
    check(
      "A1 缺基线时结论不是“完成”",
      missing.result.counts.unknown > 0,
      `unknown=${missing.result.counts.unknown} totalKeys=${missing.result.counts.totalKeys}`,
    );

    const stateA1 = await history(base, taskA);
    check(
      "A1 目标显示待补材料",
      stateA1.goals[0]?.reconcileState?.state === "missing-material" &&
        String(stateA1.goals[0]?.reconcileState?.reason).includes("assets/baseline.csv"),
      `state=${stateA1.goals[0]?.reconcileState?.state} reason=${stateA1.goals[0]?.reconcileState?.reason}`,
    );

    const rejectA = await assertGoal(base, taskA, "biz-diff");
    check("A2 判定不通过", rejectA.status === 409 && rejectA.ok === false, `→ ${rejectA.status}`);
    check(
      "A2 不通过原因点名缺哪份材料",
      String(rejectA.reason).includes("缺少基线材料 assets/baseline.csv"),
      String(rejectA.reason).slice(0, 180),
    );
    const afterRejectA = await history(base, taskA);
    check("A2 目标未完成", afterRejectA.goals[0]?.passes === false, `passes=${afterRejectA.goals[0]?.passes}`);
    check(
      "A2 首次通过事件与依据都为 0",
      afterRejectA.events.filter((event) => event.kind === "goal_asserted").length === 0 &&
        afterRejectA.goalProofs.length === 0,
      `goal_asserted=${afterRejectA.events.filter((event) => event.kind === "goal_asserted").length} proofs=${afterRejectA.goalProofs.length}`,
    );
    const cardA1 = await scorecard(base, taskA);
    check(
      "A2 记分卡历史/当前均为 0/1",
      cardA1.historicallyPassed === 0 && cardA1.currentlySupported === 0 && cardA1.denominator === 1,
      `历史 ${cardA1.historicallyPassed}/${cardA1.denominator} · 当前 ${cardA1.currentlySupported}/${cardA1.denominator}`,
    );

    await upload(base, taskA, "assets/baseline.csv", BASELINE);
    const goodA = await reconcile(base, taskA, "biz-diff");
    check(
      "A3 补交后核算无未知无歧义",
      goodA.result.counts.unknown === 0 && (goodA.result.counts.ambiguous ?? 0) === 0,
      `unknown=${goodA.result.counts.unknown} ambiguous=${goodA.result.counts.ambiguous ?? 0}`,
    );
    check(
      "A3 版本记录绑定了目标与两侧材料哈希",
      goodA.revision.goalIds.includes("biz-diff") &&
        goodA.revision.baseline.sha256 === sha256(BASELINE) &&
        goodA.revision.current.sha256 === sha256(CURRENT),
      `goalIds=${JSON.stringify(goodA.revision.goalIds)} baseline=${String(goodA.revision.baseline.sha256).slice(0, 12)}… current=${String(goodA.revision.current.sha256).slice(0, 12)}…`,
    );

    const passA = await assertGoal(base, taskA, "biz-diff");
    check("A4 判定通过", passA.status === 200 && passA.ok === true, `→ ${passA.status}`);
    const histA = await history(base, taskA);
    const proofA = histA.goalProofs.find((proof) => proof.goalId === "biz-diff");
    check(
      "A4 首次通过只引用刚生成的核算文件",
      proofA?.path === goodA.evidencePath && proofA?.sha256 === goodA.evidenceSha256,
      `${proofA?.path} · ${String(proofA?.sha256).slice(0, 12)}…`,
    );
    const eventA = histA.events.find((event) => event.kind === "goal_asserted");
    const adoptedA = (eventA?.payload as { adoptedReconcile?: Record<string, unknown> } | undefined)?.adoptedReconcile;
    check(
      "A4 事件里写明采用的输入版本与哈希",
      adoptedA?.revisionId === goodA.revision.id &&
        adoptedA?.inputDigest === goodA.revision.inputDigest &&
        (adoptedA?.baseline as { sha256?: string } | undefined)?.sha256 === sha256(BASELINE),
      `revisionId=${String(adoptedA?.revisionId)} inputDigest=${String(adoptedA?.inputDigest).slice(0, 12)}…`,
    );
    const cardA2 = await scorecard(base, taskA);
    check(
      "A4 记分卡历史/当前均为 1/1",
      cardA2.historicallyPassed === 1 && cardA2.currentlySupported === 1,
      `历史 ${cardA2.historicallyPassed}/1 · 当前 ${cardA2.currentlySupported}/1`,
    );
    // 并发重复判定：只允许一条首次通过事件。
    const burst = await Promise.all(
      Array.from({ length: 6 }, () => call<{ ok: boolean }>(base, `/tasks/${taskA}/goals/assert`, post({ goalId: "biz-diff" }))),
    );
    const histBurst = await history(base, taskA);
    check(
      "A5 并发重复判定只产生一条首次通过事件",
      burst.every((res) => res.status === 200) &&
        histBurst.events.filter((event) => event.kind === "goal_asserted").length === 1 &&
        histBurst.goalProofs.length === 1,
      `并发 6 次 → goal_asserted=${histBurst.events.filter((event) => event.kind === "goal_asserted").length} proofs=${histBurst.goalProofs.length}`,
    );
    const reportA = await finalizeAndReport(base, taskA);
    check(
      "A4 报告引用采用的核算文件、输入版本与两侧哈希",
      reportA.includes("首次通过采用的核算文件") &&
        reportA.includes(goodA.revision.id) &&
        reportA.includes(sha256(BASELINE)),
      `报告含 ${goodA.revision.id} 与基线哈希 ${sha256(BASELINE).slice(0, 12)}…`,
    );
    evidence.A = { taskId: taskA, adopted: goodA.revision.id, result: goodA.evidencePath };

    // ── B1：撤回基线 ────────────────────────────────────────────────────────
    const taskB1 = await createBusinessTask(base, "B1 业务核算（撤回基线）");
    await upload(base, taskB1, "assets/baseline.csv", BASELINE);
    const currentB1 = await upload(base, taskB1, "assets/current.csv", CURRENT);
    const oldB1 = await reconcile(base, taskB1, "biz-diff");
    check(
      "B1 先生成一份合格旧结果",
      oldB1.result.counts.unknown === 0 && (oldB1.result.counts.ambiguous ?? 0) === 0,
      `unknown=${oldB1.result.counts.unknown} revision=${oldB1.revision.id}`,
    );
    const beforeWithdraw = await history(base, taskB1);
    check("B1 此时还没有首次通过事件", provesNothingYet(beforeWithdraw, "biz-diff"), "passes=false · goal_asserted=0 · proofs=0");

    await withdraw(base, taskB1, "assets/baseline.csv", sha256(BASELINE));
    // 时点 1：撤回后尚未重算。
    const staleB1 = await history(base, taskB1);
    check(
      "B1 撤回后未重算就显示待补材料",
      staleB1.goals[0]?.reconcileState?.state === "missing-material",
      `state=${staleB1.goals[0]?.reconcileState?.state} reason=${staleB1.goals[0]?.reconcileState?.reason}`,
    );
    const rejectB1a = await assertGoal(base, taskB1, "biz-diff");
    const histB1a = await history(base, taskB1);
    check(
      "B1 撤回后未重算的判定保持 0/1",
      rejectB1a.status === 409 &&
        histB1a.goals[0]?.passes === false &&
        histB1a.events.filter((event) => event.kind === "goal_asserted").length === 0 &&
        histB1a.goalProofs.length === 0,
      `→ ${rejectB1a.status} · ${String(rejectB1a.reason).slice(0, 140)}`,
    );
    const cardB1a = await scorecard(base, taskB1);
    check(
      "B1 撤回后未重算的记分卡 0/1 · 0/1",
      cardB1a.historicallyPassed === 0 && cardB1a.currentlySupported === 0,
      `历史 ${cardB1a.historicallyPassed}/1 · 当前 ${cardB1a.currentlySupported}/1`,
    );

    // 时点 2：重算已经报告缺件。
    const missingB1 = await reconcile(base, taskB1, "biz-diff");
    check(
      "B1 重算报告缺基线",
      missingB1.result.missingMaterials.includes("assets/baseline.csv"),
      `missingMaterials=${JSON.stringify(missingB1.result.missingMaterials)}`,
    );
    const rejectB1b = await assertGoal(base, taskB1, "biz-diff");
    const histB1b = await history(base, taskB1);
    check(
      "B1 重算报缺件后的判定仍是 0/1",
      rejectB1b.status === 409 &&
        histB1b.goals[0]?.passes === false &&
        histB1b.events.filter((event) => event.kind === "goal_asserted").length === 0,
      `→ ${rejectB1b.status} · ${String(rejectB1b.reason).slice(0, 140)}`,
    );
    const oldFile = await fetchText(base, `/tasks/${taskB1}/evidence/file?path=${encodeURIComponent(oldB1.evidencePath)}`);
    check(
      "B1 旧合格结果仍可查（保留供追溯）",
      oldFile.status === 200 && sha256(oldFile.text) === oldB1.evidenceSha256,
      `${oldB1.evidencePath} sha256=${sha256(oldFile.text).slice(0, 12)}… 与生成时一致`,
    );
    check(
      "B1 两次同名核算各自留档且版本可区分",
      (histB1b.reconcileRevisions ?? []).length === 2 &&
        new Set((histB1b.reconcileRevisions ?? []).map((entry) => entry.revision.id)).size === 2,
      (histB1b.reconcileRevisions ?? []).map((entry) => `${entry.revision.id}:${entry.evidencePath}`).join(" | "),
    );

    // 修正：补回基线 → 重新核算 → 首次通过。
    await upload(base, taskB1, "assets/baseline.csv", BASELINE);
    const fixedB1 = await reconcile(base, taskB1, "biz-diff");
    const passB1 = await assertGoal(base, taskB1, "biz-diff");
    const histB1c = await history(base, taskB1);
    const proofB1 = histB1c.goalProofs.find((proof) => proof.goalId === "biz-diff");
    check(
      "B1 修正后基于最新有效输入首次通过",
      passB1.status === 200 &&
        proofB1?.path === fixedB1.evidencePath &&
        proofB1?.sha256 === fixedB1.evidenceSha256 &&
        histB1c.events.filter((event) => event.kind === "goal_asserted").length === 1,
      `proof=${proofB1?.path} sha256=${String(proofB1?.sha256).slice(0, 12)}…`,
    );
    check(
      "B1 首次通过引用的输入哈希等于当前材料",
      fixedB1.revision.baseline.sha256 === sha256(BASELINE) && fixedB1.revision.current.sha256 === currentB1.sha256,
      `baseline=${String(fixedB1.revision.baseline.sha256).slice(0, 12)}… current=${String(fixedB1.revision.current.sha256).slice(0, 12)}…`,
    );
    const reportB1 = await finalizeAndReport(base, taskB1);
    check(
      "B1 报告引用最新采用的核算文件与哈希",
      reportB1.includes(fixedB1.evidencePath) && reportB1.includes(fixedB1.evidenceSha256),
      `${fixedB1.evidencePath} · ${fixedB1.evidenceSha256.slice(0, 12)}…`,
    );
    evidence.B1 = { taskId: taskB1, adopted: fixedB1.revision.id, result: fixedB1.evidencePath };

    // ── B2：同一路径替换成含冲突重复键的材料 ────────────────────────────────
    const taskB2 = await createBusinessTask(base, "B2 业务核算（同路径冲突重复键）");
    await upload(base, taskB2, "assets/baseline.csv", BASELINE);
    await upload(base, taskB2, "assets/current.csv", CURRENT);
    const oldB2 = await reconcile(base, taskB2, "biz-diff");
    const beforeB2 = await history(base, taskB2);
    check("B2 先生成一份合格旧结果且无首次通过", oldB2.result.counts.unknown === 0 && provesNothingYet(beforeB2, "biz-diff"), `revision=${oldB2.revision.id}`);

    const replaced = await upload(base, taskB2, "assets/current.csv", CONFLICTING);
    check("B2 同一路径替换为新材料", replaced.replaced === true, `sha256=${replaced.sha256.slice(0, 12)}…`);
    const conflictB2 = await reconcile(base, taskB2, "biz-diff");
    const ambiguousItem = conflictB2.result.items.find((item) => item.status === "ambiguous");
    check(
      "B2 新结果标为歧义并给出冲突键与来源行",
      (conflictB2.result.counts.ambiguous ?? 0) === 1 &&
        ambiguousItem?.key === "app-a-1" &&
        (ambiguousItem?.duplicates?.length ?? 0) >= 2,
      `${ambiguousItem?.key} lines=${JSON.stringify(ambiguousItem?.duplicates?.map((dup) => dup.line))} reason=${String(ambiguousItem?.reason).slice(0, 80)}`,
    );
    const rejectB2 = await assertGoal(base, taskB2, "biz-diff");
    const histB2a = await history(base, taskB2);
    check(
      "B2 冲突材料的判定保持 0/1",
      rejectB2.status === 409 &&
        histB2a.goals[0]?.passes === false &&
        histB2a.events.filter((event) => event.kind === "goal_asserted").length === 0 &&
        histB2a.goalProofs.length === 0,
      `→ ${rejectB2.status} · ${String(rejectB2.reason).slice(0, 160)}`,
    );
    const oldFileB2 = await fetchText(base, `/tasks/${taskB2}/evidence/file?path=${encodeURIComponent(oldB2.evidencePath)}`);
    check(
      "B2 旧合格结果仍可查",
      oldFileB2.status === 200 && sha256(oldFileB2.text) === oldB2.evidenceSha256,
      `${oldB2.evidencePath} sha256=${sha256(oldFileB2.text).slice(0, 12)}…`,
    );
    const cardB2 = await scorecard(base, taskB2);
    check("B2 记分卡 0/1 · 0/1", cardB2.historicallyPassed === 0 && cardB2.currentlySupported === 0, `历史 ${cardB2.historicallyPassed}/1 · 当前 ${cardB2.currentlySupported}/1`);

    // 修正冲突 → 重新核算 → 首次通过。
    await upload(base, taskB2, "assets/current.csv", CURRENT);
    const fixedB2 = await reconcile(base, taskB2, "biz-diff");
    const passB2 = await assertGoal(base, taskB2, "biz-diff");
    const histB2b = await history(base, taskB2);
    const proofB2 = histB2b.goalProofs.find((proof) => proof.goalId === "biz-diff");
    check(
      "B2 修正冲突后基于最新有效输入首次通过",
      passB2.status === 200 &&
        proofB2?.path === fixedB2.evidencePath &&
        fixedB2.result.counts.ambiguous === 0 &&
        histB2b.events.filter((event) => event.kind === "goal_asserted").length === 1,
      `proof=${proofB2?.path} sha256=${String(proofB2?.sha256).slice(0, 12)}…`,
    );
    const reportB2 = await finalizeAndReport(base, taskB2);
    check(
      "B2 报告引用最新采用的核算文件与哈希",
      reportB2.includes(fixedB2.evidencePath) && reportB2.includes(fixedB2.evidenceSha256),
      `${fixedB2.evidencePath} · ${fixedB2.evidenceSha256.slice(0, 12)}…`,
    );
    evidence.B2 = { taskId: taskB2, adopted: fixedB2.revision.id, result: fixedB2.evidencePath };

    // ── 汇总 ────────────────────────────────────────────────────────────────
    const failed = steps.filter((step) => !step.ok);
    const summary = {
      runId: RUN_ID,
      code: gitCodeInfo(),
      startedAt,
      finishedAt: new Date().toISOString(),
      dataRoot: ROOT,
      steps: steps.length,
      failed: failed.length,
      tasks: evidence,
    };
    writeFileSync(join(ROOT, "firstpass-acceptance.json"), JSON.stringify(summary, null, 2) + "\n");
    console.log(
      `\n首次通过绑定验收：${steps.length} 项（失败 ${failed.length}）· 清单 ${join(ROOT, "firstpass-acceptance.json")}`,
    );
    if (failed.length) process.exitCode = 1;
  } finally {
    await plane.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

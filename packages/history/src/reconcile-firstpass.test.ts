/**
 * 第八轮：首次通过必须绑定“判定时有效的那一版输入”。
 *
 * 上轮独立复核的两个反例在这里逐条固定成回归：
 * 1. 先用完整材料算出合格结果，再撤走基线（尚未重算 / 已重算出缺件结论），
 *    旧合格结果都不得支撑首次通过；
 * 2. 用同一路径提交含冲突重复键的新材料，新结果是歧义，旧结果同样不得被采用；
 * 3. 输入在“核算完成之后、首次通过提交之前”变化，首次通过整体回滚；
 * 4. 同名连续核算必须可区分（版本号唯一，不靠文件名排序或秒级时间戳）；
 * 5. 跨目标 / 跨口径的结果不能套用；
 * 6. 修正材料后重新核算 → 首次通过，并留下可复验的输入版本与结果哈希。
 */
import { mkdtempSync, mkdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  reconcileConfigDigest,
  type BusinessReconcileConfig,
  type ReconcileRequest,
} from "@gongyuai/contracts";
import { openHistory, writeEvidenceFile } from "./index.js";

const BASELINE = [
  "host,role,version",
  "app-a-1,web,1.4",
  "app-a-2,db,2.1",
].join("\n");
const CURRENT = [
  "host,role,version",
  "app-a-1,web,1.5",
  "app-a-2,db,2.1",
].join("\n");
/** 同一路径、含冲突重复主键的新材料（app-a-1 出现两次且内容冲突）。 */
const CONFLICTING = [
  "host,role,version",
  "app-a-1,web,1.5",
  "app-a-1,web,9.9",
  "app-a-2,db,2.1",
].join("\n");

type Ctx = {
  root: string;
  evidenceDir: string;
  store: ReturnType<typeof openHistory>;
  taskId: string;
  close: () => void;
};

function businessConfig(overrides: Partial<BusinessReconcileConfig> = {}): BusinessReconcileConfig {
  return {
    name: "asset-diff",
    keyField: "host",
    maxUnknown: 0,
    maxAmbiguous: 0,
    baseline: { path: "assets/baseline.csv" },
    current: { path: "assets/current.csv" },
    ...overrides,
  } as BusinessReconcileConfig;
}

function setup(goalId = "biz-goal", config = businessConfig()): Ctx {
  const root = mkdtempSync(join(tmpdir(), "gy-firstpass-"));
  const evidenceDir = join(root, "evidence");
  mkdirSync(join(evidenceDir, "reconcile"), { recursive: true });
  const store = openHistory({ dbPath: join(root, "history.sqlite"), evidenceDir });
  const taskId = "12345678-1234-4123-8123-1234567890ab";
  const digest = reconcileConfigDigest(config);
  assert.match(digest, /^[0-9a-f]{64}$/);
  store.seedGoals(taskId, [{
    id: goalId,
    title: "两份原始清单的差异核算",
    description: "比对基线清单与当前清单",
    kind: "business-reconcile",
    business: config,
    evidencePatterns: [`reconcile/${config.name}-*.json`],
    reconcileGate: {
      pattern: `reconcile/${config.name}-*.json`,
      maxUnknown: config.maxUnknown,
      maxAmbiguous: config.maxAmbiguous,
    },
    passes: false,
    evidencePaths: [],
    assertedAt: null,
  } as Parameters<typeof store.seedGoals>[1][number]]);
  return {
    root,
    evidenceDir,
    store,
    taskId,
    close: () => {
      store.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

function material(ctx: Ctx, path: string, content: string) {
  writeEvidenceFile(ctx.evidenceDir, path, content);
}

function archive(
  ctx: Ctx,
  overrides: Partial<ReconcileRequest> = {},
  goalIds: string[] = ["biz-goal"],
) {
  const request = {
    name: "asset-diff",
    baseline: { path: "assets/baseline.csv" },
    current: { path: "assets/current.csv" },
    keyField: "host",
    ...overrides,
  } as ReconcileRequest;
  return ctx.store.archiveReconcile({ taskId: ctx.taskId, request, goalIds });
}

function sha256File(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function evidenceAbs(ctx: Ctx, relative: string): string {
  return join(ctx.evidenceDir, relative);
}

// ── 反例 1：核算完成后撤走基线 ─────────────────────────────────────────────

test("撤走基线（尚未重算）：旧合格结果保留但不得支撑首次通过", () => {
  const ctx = setup();
  try {
    material(ctx, "assets/baseline.csv", BASELINE);
    material(ctx, "assets/current.csv", CURRENT);
    const good = archive(ctx);
    assert.equal(good.result.counts.unknown, 0);
    assert.equal(good.result.counts.ambiguous, 0);
    assert.equal(good.revision.baseline.present, true);

    // 撤走基线：不重算，直接判定（上轮反例的确切顺序）。
    unlinkSync(evidenceAbs(ctx, "assets/baseline.csv"));

    const state = ctx.store.goalReconcileState(ctx.taskId, "biz-goal");
    assert.equal(state?.state, "missing-material", "输入一撤走就必须显示待补材料");
    assert.match(String(state?.reason), /待补材料：assets\/baseline\.csv/);

    const rejected = ctx.store.assertGoal(ctx.taskId, "biz-goal", []);
    assert.equal(rejected.ok, false, "旧结果不得支撑这次首次通过");
    if (!rejected.ok) assert.match(rejected.reason, /基线材料已撤走/);

    assert.equal(ctx.store.listGoals(ctx.taskId)[0]!.passes, false);
    assert.deepEqual(ctx.store.listGoalProofs(ctx.taskId), [], "没有首次通过就没有依据");
    assert.equal(
      ctx.store.listEvents(ctx.taskId).filter((event) => event.kind === "goal_asserted").length,
      0,
      "首次通过事件必须仍为 0",
    );
    // 旧结果保留供追溯。
    assert.ok(readFileSync(evidenceAbs(ctx, good.evidencePath)).length > 0);
    // 归档记录也还在：复核时能查到“当时读过什么”。
    assert.equal(ctx.store.listReconcileRevisions(ctx.taskId).length, 1);
  } finally {
    ctx.close();
  }
});

test("撤走基线后重新核算（缺件结论）：两个时点都保持未通过，补交后才首次通过", () => {
  const ctx = setup();
  try {
    material(ctx, "assets/baseline.csv", BASELINE);
    material(ctx, "assets/current.csv", CURRENT);
    const good = archive(ctx);

    unlinkSync(evidenceAbs(ctx, "assets/baseline.csv"));
    // 时点 A：撤回后尚未重算。
    const atWithdraw = ctx.store.assertGoal(ctx.taskId, "biz-goal", []);
    assert.equal(atWithdraw.ok, false);

    // 时点 B：重算已经报告缺件。
    const missing = archive(ctx);
    assert.deepEqual(missing.result.missingMaterials, ["assets/baseline.csv"]);
    assert.equal(missing.result.counts.unknown, 2);
    const atRecompute = ctx.store.assertGoal(ctx.taskId, "biz-goal", []);
    assert.equal(atRecompute.ok, false);
    if (!atRecompute.ok) assert.match(atRecompute.reason, /缺少基线材料 assets\/baseline\.csv/);
    assert.deepEqual(ctx.store.listGoalProofs(ctx.taskId), []);

    // 补交基线 → 重新核算 → 首次通过，采用刚生成的那一份。
    material(ctx, "assets/baseline.csv", BASELINE);
    const good2 = archive(ctx);
    const passed = ctx.store.assertGoal(ctx.taskId, "biz-goal", []);
    assert.equal(passed.ok, true);
    const proofs = ctx.store.listGoalProofs(ctx.taskId);
    assert.equal(proofs.length, 1);
    assert.equal(proofs[0]!.path, good2.evidencePath);
    assert.notEqual(good2.evidencePath, good.evidencePath, "同名连续核算的文件必须可区分");
    assert.equal(proofs[0]!.sha256, sha256File(evidenceAbs(ctx, good2.evidencePath)));
    assert.equal(
      ctx.store.listEvents(ctx.taskId).filter((event) => event.kind === "goal_asserted").length,
      1,
      "只记一条首次通过事件",
    );
  } finally {
    ctx.close();
  }
});

// ── 反例 2：同一路径提交含冲突重复键的新材料 ────────────────────────────────

test("同一路径替换成含冲突重复键的材料：新旧结果都不能让目标通过，界面报冲突键与来源行", () => {
  const ctx = setup();
  try {
    material(ctx, "assets/baseline.csv", BASELINE);
    material(ctx, "assets/current.csv", CURRENT);
    const good = archive(ctx);
    assert.equal(good.result.counts.unknown, 0);

    // 同一路径覆盖成冲突材料，再核算。
    material(ctx, "assets/current.csv", CONFLICTING);
    const conflict = archive(ctx);
    assert.equal(conflict.result.counts.ambiguous, 1);
    const item = conflict.result.items.find((entry) => entry.status === "ambiguous");
    assert.ok(item, "必须给出歧义项");
    assert.equal(item!.key, "app-a-1");
    assert.match(String(item!.reason), /duplicate-key-conflict/);
    assert.ok(Array.isArray(item!.duplicates) && item!.duplicates.length >= 2, "要列出全部来源行");
    const lines = item!.duplicates!.map((entry) => entry.line).sort((a, b) => a - b);
    assert.deepEqual(lines, [2, 3], "冲突来源行是原文件的物理行号");

    const rejected = ctx.store.assertGoal(ctx.taskId, "biz-goal", []);
    assert.equal(rejected.ok, false);
    if (!rejected.ok) assert.match(rejected.reason, /歧义 1 项/);
    assert.equal(ctx.store.listGoals(ctx.taskId)[0]!.passes, false);
    assert.equal(
      ctx.store.listEvents(ctx.taskId).filter((event) => event.kind === "goal_asserted").length,
      0,
    );

    const state = ctx.store.goalReconcileState(ctx.taskId, "biz-goal");
    assert.equal(state?.state, "unsatisfied");
    assert.equal(state?.latestRevisionId, conflict.revision.id);

    // 旧合格结果仍可查（保留供追溯），但它不参与判定。
    assert.ok(readFileSync(evidenceAbs(ctx, good.evidencePath)).length > 0);
    assert.equal(ctx.store.listReconcileRevisions(ctx.taskId).length, 2);

    // 修正冲突（改回单行）→ 重新核算 → 首次通过，采用最新结果。
    material(ctx, "assets/current.csv", CURRENT);
    const fixed = archive(ctx);
    assert.equal(fixed.result.counts.ambiguous, 0);
    const passed = ctx.store.assertGoal(ctx.taskId, "biz-goal", []);
    assert.equal(passed.ok, true);
    const proofs = ctx.store.listGoalProofs(ctx.taskId);
    assert.equal(proofs.length, 1);
    assert.equal(proofs[0]!.path, fixed.evidencePath);
    assert.equal(
      ctx.store.listEvents(ctx.taskId).filter((event) => event.kind === "goal_asserted").length,
      1,
    );
  } finally {
    ctx.close();
  }
});

// ── 窗口：核算完成后、首次通过提交前输入变化 ───────────────────────────────

test("核算完成后、首次通过提交前材料被替换：提交整体回滚，首次通过事件为 0", () => {
  const ctx = setup();
  try {
    material(ctx, "assets/baseline.csv", BASELINE);
    material(ctx, "assets/current.csv", CURRENT);
    archive(ctx);

    let mutated = false;
    const outcome = ctx.store.assertGoal(ctx.taskId, "biz-goal", [], {
      beforeCommit: () => {
        // 恰好落在这个窗口里：通过事务已更新，封存还没写。
        material(ctx, "assets/current.csv", CONFLICTING);
        mutated = true;
      },
    });
    assert.equal(mutated, true, "注入点必须真的执行了");
    assert.equal(outcome.ok, false, "输入在提交窗口内变化，必须整体回滚");
    if (!outcome.ok) assert.match(outcome.reason, /不能支撑本次首次通过/);
    assert.equal(ctx.store.listGoals(ctx.taskId)[0]!.passes, false, "回滚后不得留下已通过状态");
    assert.deepEqual(ctx.store.listGoalProofs(ctx.taskId), [], "回滚后不得留下首次通过依据");
    assert.equal(
      ctx.store.listEvents(ctx.taskId).filter((event) => event.kind === "goal_asserted").length,
      0,
      "回滚后不得留下首次通过事件",
    );
  } finally {
    ctx.close();
  }
});

// ── 同名连续核算必须可区分 ──────────────────────────────────────────────────

test("同名连续核算：版本号唯一、文件不同、顺序稳定，采用最新合格版本", () => {
  const ctx = setup();
  try {
    material(ctx, "assets/baseline.csv", BASELINE);
    material(ctx, "assets/current.csv", CURRENT);
    const first = archive(ctx);
    const second = archive(ctx);
    const third = archive(ctx);

    const revisions = ctx.store.listReconcileRevisions(ctx.taskId);
    assert.equal(revisions.length, 3);
    const ids = revisions.map((entry) => entry.revision.id);
    assert.equal(new Set(ids).size, 3, "三次同名核算必须是三个不同版本");
    assert.deepEqual(ids, [...ids].sort().reverse(), "按版本号倒序返回");
    assert.equal(revisions[0]!.revision.id, third.revision.id);
    const paths = revisions.map((entry) => entry.evidencePath);
    assert.equal(new Set(paths).size, 3, "结果文件路径互不覆盖");
    assert.ok(first.evidencePath !== second.evidencePath);

    const passed = ctx.store.assertGoal(ctx.taskId, "biz-goal", []);
    assert.equal(passed.ok, true);
    const proofs = ctx.store.listGoalProofs(ctx.taskId);
    assert.equal(proofs[0]!.path, third.evidencePath, "采用最新合格版本");
  } finally {
    ctx.close();
  }
});

// ── 跨目标 / 跨口径不可套用 ────────────────────────────────────────────────

test("跨目标套用被拒：另一目标的核算结果不能支撑本目标的首次通过", () => {
  const ctx = setup();
  try {
    // 第二个业务目标，同一份配置、不同 id。
    ctx.store.seedGoals(ctx.taskId, [{
      id: "other-goal",
      title: "另一笔业务核算",
      description: "同样是两份清单比对",
      kind: "business-reconcile",
      business: businessConfig(),
      evidencePatterns: ["reconcile/asset-diff-*.json"],
      reconcileGate: { pattern: "reconcile/asset-diff-*.json", maxUnknown: 0, maxAmbiguous: 0 },
      passes: false,
      evidencePaths: [],
      assertedAt: null,
    } as Parameters<typeof ctx.store.seedGoals>[1][number]]);

    material(ctx, "assets/baseline.csv", BASELINE);
    material(ctx, "assets/current.csv", CURRENT);
    archive(ctx, {}, ["other-goal"]); // 只记到 other-goal 名下

    const rejected = ctx.store.assertGoal(ctx.taskId, "biz-goal", []);
    assert.equal(rejected.ok, false);
    if (!rejected.ok) assert.match(rejected.reason, /记在别的目标名下（other-goal）/);
    const otherPassed = ctx.store.assertGoal(ctx.taskId, "other-goal", []);
    assert.equal(otherPassed.ok, true, "记到它名下的核算可以支撑它自己");
  } finally {
    ctx.close();
  }
});

test("跨口径套用被拒：主键字段不同的核算结果不能支撑目标", () => {
  const ctx = setup();
  try {
    material(ctx, "assets/baseline.csv", BASELINE);
    material(ctx, "assets/current.csv", CURRENT);
    // 目标声明 keyField=host，这次核算用 role：口径不同。
    archive(ctx, { keyField: "role" });
    const rejected = ctx.store.assertGoal(ctx.taskId, "biz-goal", []);
    assert.equal(rejected.ok, false);
    if (!rejected.ok) {
      assert.match(rejected.reason, /核算口径与目标声明不一致/);
      assert.match(rejected.reason, /主键 host ≠ role/);
    }

    // 用目标口径重新核算即可通过。
    archive(ctx, { keyField: "host" });
    assert.equal(ctx.store.assertGoal(ctx.taskId, "biz-goal", []).ok, true);
  } finally {
    ctx.close();
  }
});

// ── 核算态：输入一变就显示待补 / 待重算 ────────────────────────────────────

test("核算态：无结果→待补材料→待重算→可判定→已通过，逐段可读", () => {
  const ctx = setup();
  try {
    // 两份材料都还没交：直接点名要补哪两份，而不是含糊地说“没有结果”。
    const empty = ctx.store.goalReconcileState(ctx.taskId, "biz-goal");
    assert.equal(empty?.state, "missing-material");
    assert.match(String(empty?.reason), /待补材料：assets\/baseline\.csv、assets\/current\.csv/);

    material(ctx, "assets/current.csv", CURRENT);
    const missing = ctx.store.goalReconcileState(ctx.taskId, "biz-goal");
    assert.equal(missing?.state, "missing-material");
    assert.match(String(missing?.reason), /待补材料：assets\/baseline\.csv/);

    material(ctx, "assets/baseline.csv", BASELINE);
    const readyToRun = ctx.store.goalReconcileState(ctx.taskId, "biz-goal");
    assert.equal(readyToRun?.state, "no-result", "材料齐了但还没核算");
    assert.equal(readyToRun?.materials?.baseline.present, true);

    const archived = archive(ctx);
    const ready = ctx.store.goalReconcileState(ctx.taskId, "biz-goal");
    assert.equal(ready?.state, "ready");
    assert.equal(ready?.readyRevisionId, archived.revision.id);

    // 材料替换但没重算 → 待重算。
    material(ctx, "assets/current.csv", CURRENT + "\napp-a-3,cache,1.0");
    const stale = ctx.store.goalReconcileState(ctx.taskId, "biz-goal");
    assert.equal(stale?.state, "stale", "输入变了还没重算必须显示待重算");
    assert.match(String(stale?.drift?.reason), /当前材料已替换/);

    // 重算后回到可判定，并且判定通过。
    archive(ctx);
    assert.equal(ctx.store.goalReconcileState(ctx.taskId, "biz-goal")?.state, "ready");
    assert.equal(ctx.store.assertGoal(ctx.taskId, "biz-goal", []).ok, true);
    const passed = ctx.store.goalReconcileState(ctx.taskId, "biz-goal");
    assert.equal(passed?.state, "passed");
  } finally {
    ctx.close();
  }
});

// ── 旧格式结果与重复提交 ────────────────────────────────────────────────────

test("没有版本记录的旧格式结果不得支撑首次通过；重复提交只记一条事件", () => {
  const ctx = setup();
  try {
    // 手写一份“结果”写到证据目录，但没有任何归档记录。
    const handWritten = {
      version: 1,
      name: "asset-diff",
      keyField: "host",
      compareFields: ["role", "version"],
      baseline: { path: "assets/baseline.csv", format: "csv", rows: 2, sha256: "a".repeat(64) },
      current: { path: "assets/current.csv", format: "csv", rows: 2, sha256: "b".repeat(64) },
      missingMaterials: [],
      counts: { added: 0, removed: 0, changed: 1, unchanged: 1, missing: 0, unknown: 0, ambiguous: 0, totalKeys: 2 },
      items: [{ key: "app-a-1", status: "changed", baselineLine: 2, currentLine: 2, changes: [] }],
    };
    material(ctx, "reconcile/asset-diff-handwritten.json", JSON.stringify(handWritten, null, 2));
    const rejected = ctx.store.assertGoal(ctx.taskId, "biz-goal", ["reconcile/asset-diff-handwritten.json"]);
    assert.equal(rejected.ok, false);
    if (!rejected.ok) assert.match(rejected.reason, /该目标还没有按目标配置核算过/);

    // 真实核算两次后判定：只通过一次、只记一条事件。
    material(ctx, "assets/baseline.csv", BASELINE);
    material(ctx, "assets/current.csv", CURRENT);
    archive(ctx);
    archive(ctx);
    assert.equal(ctx.store.assertGoal(ctx.taskId, "biz-goal", []).ok, true);
    assert.equal(ctx.store.assertGoal(ctx.taskId, "biz-goal", []).ok, true);
    assert.equal(ctx.store.assertGoal(ctx.taskId, "biz-goal", []).ok, true);
    assert.equal(
      ctx.store.listEvents(ctx.taskId).filter((event) => event.kind === "goal_asserted").length,
      1,
    );
    assert.equal(ctx.store.listGoalProofs(ctx.taskId).length, 1);
  } finally {
    ctx.close();
  }
});

test("核算态：材料补齐但还没重算时是「待重算」，说清最近一版仍按缺件算", () => {
  const ctx = setup();
  try {
    material(ctx, "assets/current.csv", CURRENT);
    const missing = archive(ctx);
    assert.equal(missing.revision.baseline.present, false);
    const before = ctx.store.goalReconcileState(ctx.taskId, "biz-goal");
    assert.equal(before?.state, "missing-material");

    // 补交基线但还没有重算：状态必须变成待重算，不能继续报“待补材料”。
    material(ctx, "assets/baseline.csv", BASELINE);
    const after = ctx.store.goalReconcileState(ctx.taskId, "biz-goal");
    assert.equal(after?.state, "stale");
    assert.match(String(after?.reason), /材料已补齐，需要重新核算/);
    assert.equal(after?.latestRevisionId, missing.revision.id);
    assert.equal(after?.materials?.baseline.present, true);

    // 重新核算后回到可判定，判定即通过。
    archive(ctx);
    assert.equal(ctx.store.goalReconcileState(ctx.taskId, "biz-goal")?.state, "ready");
    assert.equal(ctx.store.assertGoal(ctx.taskId, "biz-goal", []).ok, true);
  } finally {
    ctx.close();
  }
});

test("核算态：冲突重复键要把键与来源行带到界面上，而不是只给一个计数", () => {
  const ctx = setup();
  try {
    material(ctx, "assets/baseline.csv", BASELINE);
    material(ctx, "assets/current.csv", CONFLICTING);
    const conflict = archive(ctx);
    assert.equal(conflict.result.counts.ambiguous, 1);

    const state = ctx.store.goalReconcileState(ctx.taskId, "biz-goal");
    assert.equal(state?.state, "unsatisfied");
    assert.equal(state?.ambiguous.length, 1);
    assert.equal(state?.ambiguous[0]!.key, "app-a-1");
    assert.match(state!.ambiguous[0]!.reason, /duplicate-key-conflict/);
    const lines = state!.ambiguous[0]!.lines
      .filter((entry) => entry.material === "current")
      .map((entry) => entry.line)
      .sort((a, b) => a - b);
    assert.deepEqual(lines, [2, 3], "来源行是原文件的物理行号");
  } finally {
    ctx.close();
  }
});

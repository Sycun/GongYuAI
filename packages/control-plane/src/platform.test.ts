/**
 * 平台级持久层验收（PlatformStore）：记忆 / 注入 / 提案 / 评测。
 *
 * 每条测试对应一条验收：
 * 1. 无溯源不记忆（provenance 为空直接拒绝，且不落半条记录）
 * 2. draft 不能注入（matchMemory 不入选 + recordInjection 拒绝）
 * 3. confirm 后状态为 confirmed，重复 confirm 幂等
 * 4. retract 保留节点与原因，仍可查
 * 5. supersedes 把目标置 superseded 并指回新节点
 * 6. 依据撤回只置 supportRetracted，不自动 retract
 * 7. 注入落库并累加 reuseCount
 * 8. 无证据不提案
 * 9. promote 需要 approved + 有裁决样本的评测
 * 10. rollback 后可回读原 promotedAt
 * 11. 评测乱序被拒
 * 12. 组间隔离缺失被拒
 * 13. 冻结 cases 不可替换（相同则幂等）
 * 14. 同 dataRoot 重开仍能回读
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import {
  FindingEvalCaseSchema,
  matchMemory,
  type CreateMemoryDraftInput,
  type CreateProposalInput,
  type FindingEvalCase,
  type Provenance,
  type RunEvaluationInput,
} from "@gongyuai/contracts";
import { PlatformStore } from "./platform.js";

const T0 = "2026-11-22T10:00:00.000Z";
const T1 = "2026-11-22T10:00:01.000Z";
const T2 = "2026-11-22T10:00:02.000Z";
const T3 = "2026-11-22T10:00:03.000Z";
const T4 = "2026-11-22T10:00:04.000Z";

function openStore(t: TestContext): { store: PlatformStore; dataRoot: string } {
  const dataRoot = mkdtempSync(join(tmpdir(), "gy-platform-"));
  const store = new PlatformStore(dataRoot);
  t.after(() => {
    store.close();
    rmSync(dataRoot, { recursive: true, force: true });
  });
  return { store, dataRoot };
}

function provenance(taskId: string): Provenance {
  return {
    taskId,
    engagementId: "eng-accept",
    refKind: "finding",
    refId: "finding-1",
    path: "evidence/finding-1.json",
    sha256: null,
  };
}

function draftInput(over: Partial<CreateMemoryDraftInput> = {}): CreateMemoryDraftInput {
  return {
    kind: "lesson",
    title: "回显与盲注都要复验",
    body: "先验证回显，再用延时确认无回显通道。",
    matchKeys: [{ kind: "cwe", value: "CWE-89", strength: "hard" }],
    provenance: [provenance(randomUUID())],
    createdBy: "operator",
    ...over,
  };
}

function proposalInput(over: Partial<CreateProposalInput> = {}): CreateProposalInput {
  return {
    kind: "memory",
    title: "把双通道复验写进 playbook",
    body: "先回显后延时，两步都留证据。",
    evidence: [{ taskId: randomUUID(), pointer: "evidence/finding-1.json", sha256: null }],
    expectedGain: "少一次误报",
    createdBy: "operator",
    ...over,
  };
}

/** 已人工裁决：计入 tp/fp/fn，不算 pending。 */
function confirmedCase(over: Partial<FindingEvalCase> = {}): FindingEvalCase {
  return FindingEvalCaseSchema.parse({
    id: "case-1",
    expectedPresent: true,
    actualPresent: true,
    actualStatus: "verified",
    adjudication: "confirmed",
    ...over,
  });
}

/** 待裁决：只计入 pending，adjudicated 仍为 0。 */
function pendingCase(over: Partial<FindingEvalCase> = {}): FindingEvalCase {
  return FindingEvalCaseSchema.parse({
    id: "case-pending",
    expectedPresent: true,
    actualPresent: true,
    actualStatus: "tentative",
    ...over,
  });
}

function evaluationInput(over: {
  suite: string;
  group: string;
  order?: number;
  frozen?: boolean;
  seed?: string | null;
  cases?: FindingEvalCase[];
  isolatedFrom?: string[];
  taskIds?: string[];
}): RunEvaluationInput {
  const input: RunEvaluationInput = {
    suite: over.suite,
    group: over.group,
    order: over.order ?? 0,
    frozen: over.frozen ?? true,
    cases: over.cases ?? [confirmedCase()],
    taskIds: over.taskIds ?? [],
    isolatedFrom: over.isolatedFrom ?? [],
  };
  if (over.seed !== null) input.seed = over.seed ?? "seed-1";
  return input;
}

test("无溯源不记忆：provenance 为空直接拒绝，且不落任何行", (t) => {
  const { store } = openStore(t);
  assert.throws(() => store.createDraft(draftInput({ provenance: [] }), T0));
  assert.equal(store.listNodes().length, 0);
});

test("draft 不能注入：matchMemory 不入选，recordInjection 也拒绝", (t) => {
  const { store } = openStore(t);
  const taskId = randomUUID();
  const draft = store.createDraft(draftInput({ provenance: [provenance(taskId)] }), T0);
  assert.equal(draft.status, "draft");

  // 硬键命中也不入选：draft 不是可注入状态。
  assert.equal(matchMemory(store.listNodes(), { cwes: ["CWE-89"] }).length, 0);
  assert.throws(
    () =>
      store.recordInjection({
        memoryId: draft.id,
        taskId,
        engagementId: "eng-accept",
        hintId: null,
        layer: "bootstrap",
        matchedKeys: ["cwe:CWE-89"],
        reason: "硬键命中",
        at: T1,
      }),
    /memory-not-injectable:draft/,
  );

  // 确认之后才进入候选集。
  store.reviewNode(draft.id, { decision: "confirm", reviewer: "operator", reason: "复验通过" }, T1);
  const matched = matchMemory(store.listNodes(), { cwes: ["CWE-89"] });
  assert.equal(matched.length, 1);
  assert.equal(matched[0]?.layer, "bootstrap");
  assert.equal(matched[0]?.hard, true);

  // 撤回后再次退出候选集，注入同样被拒。
  store.reviewNode(draft.id, { decision: "retract", reviewer: "operator", reason: "依据不足" }, T2);
  assert.equal(matchMemory(store.listNodes(), { cwes: ["CWE-89"] }).length, 0);
  assert.throws(
    () =>
      store.recordInjection({
        memoryId: draft.id,
        taskId,
        engagementId: "eng-accept",
        hintId: null,
        layer: "bootstrap",
        matchedKeys: ["cwe:CWE-89"],
        reason: "硬键命中",
        at: T3,
      }),
    /memory-not-injectable:retracted/,
  );
});

test("复核 confirm：draft→confirmed，重复 confirm 幂等不重写复核人", (t) => {
  const { store } = openStore(t);
  const node = store.createDraft(draftInput(), T0);
  const confirmed = store.reviewNode(
    node.id,
    { decision: "confirm", reviewer: "reviewer-a", reason: "两条证据一致" },
    T1,
  );
  assert.equal(confirmed.status, "confirmed");
  assert.equal(confirmed.reviewer, "reviewer-a");
  assert.equal(confirmed.reviewedAt, T1);
  assert.equal(confirmed.reviewReason, "两条证据一致");

  const again = store.reviewNode(
    node.id,
    { decision: "confirm", reviewer: "reviewer-b", reason: "二次复核" },
    T2,
  );
  assert.equal(again.status, "confirmed");
  assert.equal(again.reviewer, "reviewer-a");
  assert.equal(again.reviewedAt, T1);
  assert.equal(store.listNodes({ status: "confirmed" }).length, 1);
  assert.equal(store.listNodes({ kind: "lesson" }).length, 1);
  assert.equal(store.listNodes({ kind: "playbook" }).length, 0);
});

test("复核 retract：节点保留可查，状态与原因都在", (t) => {
  const { store } = openStore(t);
  const taskId = randomUUID();
  const node = store.createDraft(draftInput({ provenance: [provenance(taskId)] }), T0);
  store.reviewNode(node.id, { decision: "confirm", reviewer: "operator", reason: "先确认" }, T1);
  const retracted = store.reviewNode(
    node.id,
    { decision: "retract", reviewer: "operator", reason: "原文材料已过期" },
    T2,
  );
  assert.equal(retracted.status, "retracted");
  assert.equal(retracted.reviewReason, "原文材料已过期");
  assert.equal(retracted.reviewedAt, T2);

  const reread = store.getNode(node.id);
  assert.ok(reread);
  assert.equal(reread.status, "retracted");
  assert.equal(reread.reviewReason, "原文材料已过期");
  assert.equal(reread.provenance.length, 1);
  assert.equal(store.listNodes({ status: "retracted" }).length, 1);
  assert.equal(store.listNodes({ status: "confirmed" }).length, 0);
  assert.equal(store.listNodes({ taskId }).length, 1);

  // 已撤回的不能 confirm 回来（确认不覆盖撤回）。
  assert.throws(
    () => store.reviewNode(node.id, { decision: "confirm", reviewer: "operator", reason: "再确认" }, T3),
    /memory-confirm-invalid:retracted/,
  );
});

test("supersedes：目标置 superseded、supersededBy 指向新节点", (t) => {
  const { store } = openStore(t);
  const old = store.createDraft(draftInput({ title: "旧结论" }), T0);
  store.reviewNode(old.id, { decision: "confirm", reviewer: "operator", reason: "当时成立" }, T1);
  const next = store.createDraft(
    draftInput({ title: "新结论", supersedes: old.id, body: "补充了无回显通道" }),
    T2,
  );

  const overwritten = store.getNode(old.id);
  assert.ok(overwritten);
  assert.equal(overwritten.status, "superseded");
  assert.equal(overwritten.supersededBy, next.id);
  assert.equal(next.supersedes, old.id);
  assert.equal(next.status, "draft");
  assert.equal(store.listNodes({ status: "superseded" }).length, 1);

  assert.throws(
    () => store.createDraft(draftInput({ supersedes: randomUUID() }), T3),
    /memory-supersedes-not-found/,
  );
});

test("依据撤回：markSupportRetracted 只置位，不自动 retract", (t) => {
  const { store } = openStore(t);
  const taskId = randomUUID();
  const otherTask = randomUUID();
  const supported = store.createDraft(draftInput({ provenance: [provenance(taskId)] }), T0);
  store.reviewNode(supported.id, { decision: "confirm", reviewer: "operator", reason: "当时有证据" }, T1);
  const untouched = store.createDraft(draftInput({ provenance: [provenance(otherTask)] }), T1);
  store.reviewNode(untouched.id, { decision: "confirm", reviewer: "operator", reason: "另一任务" }, T1);

  const flagged = store.markSupportRetracted(taskId, "finding 被撤回");
  assert.equal(flagged.length, 1);
  assert.equal(flagged[0]?.id, supported.id);
  assert.equal(flagged[0]?.supportRetracted, true);
  // 不自动 retract：结论仍是 confirmed，等人工复核。
  assert.equal(flagged[0]?.status, "confirmed");

  const reread = store.getNode(supported.id);
  assert.equal(reread?.status, "confirmed");
  assert.equal(reread?.supportRetracted, true);
  assert.equal(store.getNode(untouched.id)?.supportRetracted, false);

  const events = store.listMemoryEvents(supported.id);
  assert.equal(events.length, 1);
  assert.equal(events[0]?.action, "support-retracted");
  assert.equal(events[0]?.reason, "finding 被撤回");
  assert.equal(events[0]?.taskId, taskId);
});

test("注入记录：reuseCount 累加，referencesFor 可按记忆回读", (t) => {
  const { store } = openStore(t);
  const taskId = randomUUID();
  const node = store.createDraft(draftInput({ provenance: [provenance(taskId)] }), T0);
  store.reviewNode(node.id, { decision: "confirm", reviewer: "operator", reason: "可用于注入" }, T1);

  const first = store.recordInjection({
    memoryId: node.id,
    taskId,
    engagementId: "eng-accept",
    hintId: null,
    layer: "bootstrap",
    matchedKeys: ["cwe:CWE-89"],
    reason: "硬键命中",
    at: T2,
  });
  const second = store.recordInjection({
    memoryId: node.id,
    taskId,
    engagementId: "eng-accept",
    hintId: randomUUID(),
    layer: "explore-extra",
    matchedKeys: ["cwe:CWE-89", "stack:php"],
    reason: "当前资产再追加",
    at: T3,
  });

  assert.notEqual(first.id, second.id);
  assert.equal(first.layer, "bootstrap");
  assert.equal(second.layer, "explore-extra");
  assert.equal(first.injectedAt, T2);
  assert.equal(store.getNode(node.id)?.reuseCount, 2);
  assert.equal(store.referencesFor(node.id).length, 2);
  assert.equal(store.listInjections({ memoryId: node.id, taskId }).length, 2);
  assert.equal(store.listInjections({ engagementId: "eng-other" }).length, 0);

  assert.throws(
    () =>
      store.recordInjection({
        memoryId: randomUUID(),
        taskId,
        engagementId: "eng-accept",
        hintId: null,
        layer: "bootstrap",
        matchedKeys: [],
        reason: "不存在的记忆",
        at: T3,
      }),
    /memory-not-found/,
  );
});

test("无证据不提案：evidence 为空直接拒绝", (t) => {
  const { store } = openStore(t);
  assert.throws(() => store.createProposal(proposalInput({ evidence: [] }), T0));
  assert.equal(store.listProposals().length, 0);

  const draft = store.createProposal(proposalInput(), T1);
  assert.equal(draft.status, "draft");
  assert.equal(draft.version, 1);
  assert.equal(draft.evidence.length, 1);
  assert.equal(store.listProposals({ status: "draft" }).length, 1);
  assert.equal(store.listProposals({ status: "approved" }).length, 0);
  assert.equal(store.listProposals({ kind: "memory" }).length, 1);
});

test("提案裁决 reject：记原因、不可 promote", (t) => {
  const { store } = openStore(t);
  const proposal = store.createProposal(proposalInput(), T0);
  const rejected = store.decideProposal(
    proposal.id,
    { decision: "reject", decidedBy: "reviewer", reason: "收益不明确" },
    T1,
  );
  assert.equal(rejected.status, "rejected");
  assert.equal(rejected.rejectedReason, "收益不明确");
  assert.equal(rejected.approvedBy, null);
  assert.equal(rejected.approvedAt, null);
  assert.equal(store.listProposals({ status: "rejected" }).length, 1);

  assert.throws(
    () => store.promoteProposal(proposal.id, { promotedBy: "reviewer", evaluationRunId: randomUUID() }, T2),
    /proposal-not-approved:rejected/,
  );
  assert.throws(
    () => store.decideProposal(proposal.id, { decision: "approve", decidedBy: "reviewer", reason: "改判" }, T2),
    /proposal-not-decidable:rejected/,
  );
  const events = store.listProposalEvents(proposal.id);
  assert.deepEqual(
    events.map((event) => event.action),
    ["created", "rejected"],
  );
  assert.equal(events[1]?.reason, "收益不明确");
});

test("promote 需要 approved + 有裁决样本的评测", (t) => {
  const { store } = openStore(t);
  const pending = store.recordEvaluation(
    evaluationInput({ suite: "suite-flywheel", group: "A", order: 0, seed: "seed-pending", cases: [pendingCase()] }),
    T0,
  );
  assert.equal(pending.metrics.adjudicated, 0);
  assert.equal(pending.metrics.pending, 1);
  const adjudicated = store.recordEvaluation(
    evaluationInput({
      suite: "suite-flywheel",
      group: "A",
      order: 0,
      seed: "seed-adjudicated",
      cases: [confirmedCase()],
    }),
    T1,
  );
  assert.equal(adjudicated.metrics.adjudicated, 1);
  assert.equal(adjudicated.metrics.tp, 1);

  const draft = store.createProposal(proposalInput(), T1);
  assert.throws(
    () => store.promoteProposal(draft.id, { promotedBy: "reviewer", evaluationRunId: adjudicated.id }, T2),
    /proposal-not-approved:draft/,
  );

  const approved = store.decideProposal(
    draft.id,
    { decision: "approve", decidedBy: "reviewer", reason: "复核通过" },
    T2,
  );
  assert.equal(approved.status, "approved");
  assert.equal(approved.approvedBy, "reviewer");
  assert.equal(approved.approvedAt, T2);

  assert.throws(
    () => store.promoteProposal(draft.id, { promotedBy: "reviewer", evaluationRunId: pending.id }, T3),
    /evaluation-not-adjudicated/,
  );
  assert.throws(
    () => store.promoteProposal(draft.id, { promotedBy: "reviewer", evaluationRunId: randomUUID() }, T3),
    /evaluation-not-found/,
  );

  const promoted = store.promoteProposal(
    draft.id,
    { promotedBy: "reviewer", evaluationRunId: adjudicated.id },
    T3,
  );
  assert.equal(promoted.status, "promoted");
  assert.equal(promoted.promotedAt, T3);
  assert.equal(promoted.evaluationRunId, adjudicated.id);
  assert.equal(store.listProposals({ status: "promoted" }).length, 1);

  // 已裁决的提案不能再裁决。
  assert.throws(
    () => store.decideProposal(draft.id, { decision: "reject", decidedBy: "reviewer", reason: "改主意" }, T4),
    /proposal-not-decidable:promoted/,
  );
});

test("rollback 后可回读原 promotedAt", (t) => {
  const { store } = openStore(t);
  const evaluation = store.recordEvaluation(
    evaluationInput({ suite: "suite-rollback", group: "A", order: 0, seed: "seed-1", cases: [confirmedCase()] }),
    T0,
  );
  const draft = store.createProposal(proposalInput(), T0);
  store.decideProposal(draft.id, { decision: "approve", decidedBy: "reviewer", reason: "复核通过" }, T1);
  const promoted = store.promoteProposal(
    draft.id,
    { promotedBy: "reviewer", evaluationRunId: evaluation.id },
    T2,
  );
  assert.equal(promoted.promotedAt, T2);

  const rolled = store.rollbackProposal(
    promoted.id,
    { rolledBackBy: "operator", reason: "线上指标回退" },
    T3,
  );
  assert.equal(rolled.status, "rolled-back");
  assert.equal(rolled.promotedAt, T2);
  assert.equal(rolled.rolledBackAt, T3);
  assert.equal(rolled.evaluationRunId, evaluation.id);

  const reread = store.getProposal(promoted.id);
  assert.ok(reread);
  assert.equal(reread.status, "rolled-back");
  assert.equal(reread.promotedAt, T2);
  assert.equal(store.listProposals({ status: "rolled-back" }).length, 1);

  const events = store.listProposalEvents(promoted.id);
  assert.deepEqual(
    events.map((event) => event.action),
    ["created", "approved", "promoted", "rolled-back"],
  );
  assert.equal(events[3]?.actor, "operator");
  assert.equal(events[3]?.reason, "线上指标回退");

  assert.throws(
    () => store.rollbackProposal(promoted.id, { rolledBackBy: "operator", reason: "再回滚" }, T4),
    /proposal-not-promoted:rolled-back/,
  );
  assert.throws(
    () => store.promoteProposal(promoted.id, { promotedBy: "reviewer", evaluationRunId: evaluation.id }, T4),
    /proposal-not-approved:rolled-back/,
  );
});

test("评测乱序被拒：组顺序由首次运行定义", (t) => {
  const { store } = openStore(t);
  const a = store.recordEvaluation(evaluationInput({ suite: "suite-order", group: "A", order: 0 }), T0);
  assert.equal(a.notes[0], "suite-order:1");
  const b = store.recordEvaluation(
    evaluationInput({ suite: "suite-order", group: "B", order: 1, isolatedFrom: ["A"] }),
    T1,
  );
  assert.equal(b.notes[0], "suite-order:2");

  // 已登记的组改 order：等同重排实验，拒绝。
  assert.throws(
    () =>
      store.recordEvaluation(
        evaluationInput({ suite: "suite-order", group: "A", order: 2, isolatedFrom: ["B"], seed: "seed-2" }),
        T2,
      ),
    /evaluation-group-order-mismatch/,
  );
  // 新组插到已登记组之前：拒绝。
  assert.throws(
    () =>
      store.recordEvaluation(
        evaluationInput({ suite: "suite-order", group: "C", order: 0, isolatedFrom: ["A", "B"] }),
        T2,
      ),
    /evaluation-group-order-mismatch/,
  );
  // 追加到末尾可以。
  const c = store.recordEvaluation(
    evaluationInput({ suite: "suite-order", group: "C", order: 2, isolatedFrom: ["A", "B"] }),
    T3,
  );
  assert.equal(c.order, 2);
  assert.equal(store.listEvaluations({ suite: "suite-order" }).length, 3);
  assert.deepEqual(
    store.listEvaluations({ suite: "suite-order" }).map((run) => run.group),
    ["A", "B", "C"],
  );
});

test("组间隔离：缺 isolatedFrom 被拒，补齐后通过", (t) => {
  const { store } = openStore(t);
  store.recordEvaluation(evaluationInput({ suite: "suite-iso", group: "A", order: 0 }), T0);
  assert.throws(
    () => store.recordEvaluation(evaluationInput({ suite: "suite-iso", group: "B", order: 1 }), T1),
    /evaluation-isolation-missing:A/,
  );

  const b = store.recordEvaluation(
    evaluationInput({ suite: "suite-iso", group: "B", order: 1, isolatedFrom: ["A"] }),
    T1,
  );
  assert.deepEqual(b.isolatedFrom, ["A"]);
  assert.equal(b.metrics.adjudicated, 1);

  // 回跑 A 也必须隔离已完成的 B。
  assert.throws(
    () =>
      store.recordEvaluation(
        evaluationInput({ suite: "suite-iso", group: "A", order: 0, seed: "seed-2" }),
        T2,
      ),
    /evaluation-isolation-missing:B/,
  );
  store.recordEvaluation(
    evaluationInput({ suite: "suite-iso", group: "A", order: 0, seed: "seed-2", isolatedFrom: ["B"] }),
    T2,
  );
  assert.equal(store.listEvaluations({ suite: "suite-iso" }).length, 3);
});

test("冻结 cases 不可替换；完全相同则幂等返回", (t) => {
  const { store } = openStore(t);
  const cases = [confirmedCase({ id: "case-1" }), confirmedCase({ id: "case-2", actualPresent: false })];
  const first = store.recordEvaluation(
    evaluationInput({ suite: "suite-frozen", group: "A", order: 0, seed: "seed-1", cases }),
    T0,
  );
  assert.equal(first.frozen, true);
  assert.equal(first.metrics.adjudicated, 2);
  assert.equal(first.metrics.fn, 1);

  // 同一批样本换个提交顺序：内容相同 → 幂等返回原记录。
  const replay = store.recordEvaluation(
    evaluationInput({ suite: "suite-frozen", group: "A", order: 0, seed: "seed-1", cases: [cases[1]!, cases[0]!] }),
    T1,
  );
  assert.equal(replay.id, first.id);
  assert.equal(store.listEvaluations({ suite: "suite-frozen" }).length, 1);

  // 替换其中一条：拒绝。
  assert.throws(
    () =>
      store.recordEvaluation(
        evaluationInput({
          suite: "suite-frozen",
          group: "A",
          order: 0,
          seed: "seed-1",
          cases: [cases[0]!],
        }),
        T2,
      ),
    /frozen-evaluation-mismatch/,
  );

  // 冻结但没给 seed：不可复现，拒绝。
  assert.throws(
    () =>
      store.recordEvaluation(
        evaluationInput({ suite: "suite-frozen", group: "A", order: 0, seed: null, cases }),
        T2,
      ),
    /evaluation-frozen-requires-seed/,
  );

  // 非冻结的新 seed 允许追加（同一组、同一 order）。
  const iterated = store.recordEvaluation(
    evaluationInput({ suite: "suite-frozen", group: "A", order: 0, seed: "seed-2", frozen: false, cases }),
    T3,
  );
  assert.equal(iterated.frozen, false);
  assert.equal(store.listEvaluations({ suite: "suite-frozen" }).length, 2);
  assert.equal(store.getEvaluation(first.id)?.seed, "seed-1");
});

test("同 dataRoot 重开：记忆 / 提案 / 评测都能回读", (t) => {
  const dataRoot = mkdtempSync(join(tmpdir(), "gy-platform-"));
  const first = new PlatformStore(dataRoot);
  const node = first.createDraft(draftInput(), T0);
  first.reviewNode(node.id, { decision: "confirm", reviewer: "operator", reason: "复验通过" }, T1);
  const proposal = first.createProposal(proposalInput(), T1);
  const evaluation = first.recordEvaluation(
    evaluationInput({ suite: "suite-persist", group: "A", order: 0 }),
    T1,
  );
  assert.equal(existsSync(join(dataRoot, "platform.sqlite")), true);
  first.close();

  const second = new PlatformStore(dataRoot);
  t.after(() => {
    second.close();
    rmSync(dataRoot, { recursive: true, force: true });
  });
  assert.equal(second.getNode(node.id)?.status, "confirmed");
  assert.equal(second.getProposal(proposal.id)?.status, "draft");
  assert.equal(second.listEvaluations({ suite: "suite-persist" })[0]?.id, evaluation.id);
  assert.equal(second.listNodes({ status: "confirmed" }).length, 1);
});

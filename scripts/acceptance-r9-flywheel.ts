/**
 * 第九轮验收 · 第三/四优先级（记忆、飞轮、角色、韧性）。
 *
 * 覆盖：
 * P3 全局记忆（候选→草稿→人工确认→反例→撤回→取代）、来源强制、注入上限与分层、
 *    历史接触（非阻塞、委托/租户隔离）、经验撤回后的引用清单、模拟模型请求不出客户；
 *    F2 趋势/提案（无证据拒绝、批准、晋升需冻结评测、回退保留版本）；
 *    F3 冻结评测、组顺序与隔离、Finding 级指标（误报/漏项/待裁决单列）；
 * P4 规划者/复核者/事故辅助者（模拟）、辅助者 pause 权、供应商故障（429/超时/余额/外发）、
 *    成本可见性、重复记账、无进展告警。
 *
 * 运行：pnpm tsx scripts/acceptance-r9-flywheel.ts
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { openHistory } from "@gongyuai/history";
import {
  Recorder,
  gy,
  httpJson,
  repoRoot,
  roomPort,
  startPlane,
  waitHealth,
  writeRunRecord,
  type Plane,
} from "./r9-harness.js";

const startedAt = new Date().toISOString();
const runId = `r9-flywheel-${Date.now()}`;
const root = join(repoRoot, ".gongyuai", "acceptance", runId);
const evidenceRun = join(repoRoot, "docs", "evidence", "r9", runId);
mkdirSync(root, { recursive: true });
mkdirSync(evidenceRun, { recursive: true });
const rec = new Recorder(runId, "r9-flywheel", root);
const commands: string[] = [];
const notes: string[] = [];

type AnyRec = Record<string, any>;

async function waitFor<T>(fn: () => Promise<T | null>, timeoutMs = 30_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await fn();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error("timeout waiting for condition");
}

async function main(): Promise<void> {
  const port = roomPort() + 7;
  const plane: Plane = await startPlane(root, port, { GY_MOCK_SKIP_PATTERNS: "reconcile/", GY_MOCK_FINDINGS: "off" });
  const base = plane.base;
  await waitHealth(base);

  const createA = await httpJson<AnyRec>(base, "POST", "/tasks", {
    tenantId: "customer-a",
    engagementId: "eng-a",
    name: "A 客户（记忆与飞轮）",
    mock: true,
    auth: { authorizationNote: "虚构夹具：客户 A", targets: ["app-a-1.example.com"], outOfScope: [], capability: "scan" },
    goals: [{ id: "g-a", title: "A 目标", description: "夹具", evidencePatterns: ["recon/*.txt"] }],
  });
  const createB = await httpJson<AnyRec>(base, "POST", "/tasks", {
    tenantId: "customer-b",
    engagementId: "eng-b",
    name: "B 客户（同名资产）",
    mock: true,
    auth: { authorizationNote: "虚构夹具：客户 B", targets: ["app-a-1.example.com"], outOfScope: [], capability: "scan" },
    goals: [{ id: "g-b", title: "B 目标", description: "夹具", evidencePatterns: ["recon/*.txt"] }],
  });
  const taskA = String(createA.body.task.id);
  const taskB = String(createB.body.task.id);
  rec.eq("两个客户建档（同名资产）", [createA.status, createB.status], [201, 201]);

  // 种子：A 的 finding + 证据，供记忆溯源使用。
  const historyA = openHistory({
    dbPath: join(root, "tasks", taskA, "history.sqlite"),
    evidenceDir: join(root, "tasks", taskA, "evidence"),
  });
  let findingId: string;
  try {
    const write = await httpJson<AnyRec>(base, "POST", `/tasks/${taskA}/evidence`, {
      path: "http/tx-a.txt",
      content: "POST /login HTTP/1.1\nHost: app-a-1.example.com\n\nHTTP/1.1 200 OK\n",
    });
    const finding = historyA.recordFinding({
      taskId: taskA,
      title: "A 客户专属 SQL 注入（marker A-ONLY-7731）",
      asset: "app-a-1.example.com",
      vulnClass: "CWE-89",
      severity: "high",
      endpoint: "https://app-a-1.example.com/login",
      confidence: "firm",
      repro: "curl ...",
    });
    findingId = finding.finding.id;
    historyA.verifyFinding(taskA, findingId, { evidencePaths: ["http/tx-a.txt"], repro: "curl ..." });
    rec.truthy("A 的 finding 与证据落库（作为记忆溯源）", Boolean(write.body.sha256), "证据 SHA", write.body.sha256);
  } finally {
    historyA.close();
  }

  // ---------------- 记忆：候选 → 草稿 → 复核 → 注入 ----------------
  const draft = await httpJson<AnyRec>(base, "POST", "/memory/nodes", {
    kind: "lesson",
    title: "A 专属经验：登录口先测布尔盲注（marker A-ONLY-7731）",
    body: "在 app-a-1 登录口先用布尔差异确认注入点，再决定是否上工具。",
    matchKeys: [{ kind: "family", value: "web-login", strength: "hard" }],
    provenance: [{ taskId: taskA, engagementId: "eng-a", refKind: "finding", refId: findingId, path: "http/tx-a.txt", sha256: null }],
    createdBy: "op-a",
  });
  rec.eq("记忆草稿：201 且状态 draft", [draft.status, draft.body.node.status], [201, "draft"]);
  const memoryId = String(draft.body.node.id);
  const noProvenance = await httpJson<AnyRec>(base, "POST", "/memory/nodes", {
    kind: "lesson",
    title: "无源经验",
    matchKeys: [{ kind: "family", value: "web-login", strength: "hard" }],
    provenance: [],
  });
  rec.eq("无源不记忆：空 provenance 被拒 400", noProvenance.status, 400);

  const nodesForB = await httpJson<AnyRec>(base, "GET", "/memory/nodes?tenantId=customer-b&engagementId=eng-b");
  rec.eq("草稿阶段：客户 B 看不到客户 A 的记忆节点", nodesForB.body.nodes.length, 0);
  const injectDraft = await httpJson<AnyRec>(base, "POST", `/tasks/${taskA}/memory/inject`, { familyKey: "web-login" });
  rec.eq("draft 不可注入（0 条）", injectDraft.body.injected.length, 0);

  const review = await httpJson<AnyRec>(base, "POST", `/memory/nodes/${memoryId}/review`, {
    decision: "confirm",
    reviewer: "op-a",
    reason: "已在 A 委托复现并复核",
  });
  rec.eq("人工确认：draft→confirmed", [review.body.node.status, review.body.node.reviewer], ["confirmed", "op-a"]);

  const injectA = await httpJson<AnyRec>(base, "POST", `/tasks/${taskA}/memory/inject`, { familyKey: "web-login" });
  rec.eq("分层匹配：硬键命中注入 1 条", [injectA.body.injected.length, injectA.body.injected[0]?.layer], [1, "bootstrap"]);
  const hintsA = await httpJson<AnyRec>(base, "GET", `/tasks/${taskA}/hints`);
  rec.truthy("注入只写 Hint（source=system），不当事实", hintsA.body.hints.some((hint: AnyRec) => hint.source === "system" && hint.tags.includes(`memory:${memoryId}`)), "Hint 含 memory 标签", "");

  const refs = await httpJson<AnyRec>(base, "GET", `/memory/nodes/${memoryId}/references?engagementId=eng-a`);
  rec.eq("记忆引用可回查：列出引用过它的任务", refs.body.references.map((ref: AnyRec) => ref.taskId), [taskA]);

  // 客户 B：命中数、下钻、导出、模拟模型请求都不得出现 A 的专属标记
  const injectB = await httpJson<AnyRec>(base, "POST", `/tasks/${taskB}/memory/inject`, { familyKey: "web-login" });
  rec.eq("客户 B：注入命中 0 条", injectB.body.injected.length, 0);
  const hintsB = await httpJson<AnyRec>(base, "GET", `/tasks/${taskB}/hints`);
  rec.eq("客户 B：Hint 里没有 A 的专属标记", JSON.stringify(hintsB.body).includes("A-ONLY-7731"), false);
  const contactB = await httpJson<AnyRec>(base, "GET", "/archive/contact?targets=app-a-1.example.com&tenantId=customer-b");
  rec.eq("客户 B：历史接触不含客户 A 的任务", contactB.body.hits.some((hit: AnyRec) => hit.taskId === taskA), false);
  rec.eq("客户 B：历史接触命中自己的同名资产任务", contactB.body.hits.some((hit: AnyRec) => hit.taskId === taskB), true);
  const contactA = await httpJson<AnyRec>(base, "GET", "/archive/contact?targets=app-a-1.example.com&tenantId=customer-a");
  rec.eq("客户 A：历史接触命中自己的任务并带 finding 计数", contactA.body.hits.find((hit: AnyRec) => hit.taskId === taskA)?.verifiedFindings, 1);
  const modelB = await httpJson<AnyRec>(base, "POST", `/tasks/${taskB}/model-request`, {});
  rec.eq("客户 B：模拟模型请求不含 A 的标记", JSON.stringify(modelB.body).includes("A-ONLY-7731"), false);
  rec.eq("模拟模型请求：声明 simulated + 无账单", [modelB.body.authenticity, modelB.body.billing], ["simulated", "none"]);

  // 反例 / 取代 / 撤回
  const counter = await httpJson<AnyRec>(base, "POST", "/memory/nodes", {
    kind: "counterexample",
    title: "反例：该登录口对布尔注入返回统一 200",
    matchKeys: [{ kind: "family", value: "web-login", strength: "hard" }],
    provenance: [{ taskId: taskA, engagementId: "eng-a", refKind: "fact", refId: findingId, path: null, sha256: null }],
    contradicts: memoryId,
  });
  rec.eq("反例节点：201 且指向被反驳的经验", [counter.status, counter.body.node.contradicts], [201, memoryId]);
  const memoryGraph = await httpJson<AnyRec>(base, "GET", `/tasks/${taskA}/graphs/memory`);
  rec.truthy("记忆图：contradicts 边可见", memoryGraph.body.graph.edges.some((edge: AnyRec) => edge.kind === "contradicts"), "含 contradicts 边", "");
  const supersede = await httpJson<AnyRec>(base, "POST", "/memory/nodes", {
    kind: "lesson",
    title: "升级经验：登录口先做基线差分的布尔验证",
    matchKeys: [{ kind: "family", value: "web-login", strength: "hard" }],
    provenance: [{ taskId: taskA, engagementId: "eng-a", refKind: "fact", refId: findingId, path: null, sha256: null }],
    supersedes: memoryId,
  });
  rec.eq("取代：新节点取代旧经验，旧节点标 superseded", supersede.body.node.supersedes, memoryId);
  const afterSupersede = await httpJson<AnyRec>(base, "GET", `/memory/nodes/${memoryId}/references?engagementId=eng-a`);
  rec.eq("被取代节点仍可回查引用（append-only）", afterSupersede.body.references.length >= 1, true);
  const supersedingId = String(supersede.body.node.id);
  const retractMemory = await httpJson<AnyRec>(base, "POST", `/memory/nodes/${supersedingId}/review`, {
    decision: "retract",
    reviewer: "op-b",
    reason: "反例成立，停止注入",
  });
  rec.eq("撤回经验：节点保留且状态 retracted", [retractMemory.body.node?.status, retractMemory.body.node?.reviewer], ["retracted", "op-b"]);
  const injectAfterRetract = await httpJson<AnyRec>(base, "POST", `/tasks/${taskA}/memory/inject`, { familyKey: "web-login" });
  rec.eq("撤回后不再注入被撤回节点（原节点已被取代）", injectAfterRetract.body.injected.length, 0);
  const retractedRefs = await httpJson<AnyRec>(base, "GET", `/memory/nodes/${memoryId}/references?engagementId=eng-a`);
  rec.eq("撤回/取代后仍能列出引用过的任务", retractedRefs.body.references.map((ref: AnyRec) => ref.taskId), [taskA]);

  // ---------------- 飞轮：冻结评测、组隔离、指标分母 ----------------
  const evalCases = [
    { id: "c1", asset: "app-a-1.example.com", vulnClass: "CWE-89", expectedPresent: true, expectedSeverity: "high", actualPresent: true, actualSeverity: "high", actualStatus: "verified", adjudication: "confirmed" },
    { id: "c2", asset: "app-a-1.example.com", vulnClass: "CWE-79", expectedPresent: false, actualPresent: true, actualSeverity: "medium", actualStatus: "verified", adjudication: "confirmed" },
    { id: "c3", asset: "app-a-1.example.com", vulnClass: "CWE-22", expectedPresent: true, actualPresent: false, adjudication: "confirmed" },
    { id: "c4", asset: "app-a-1.example.com", vulnClass: "CWE-352", expectedPresent: true, actualPresent: true, actualStatus: "tentative", adjudication: "pending" },
  ];
  const runG1 = await httpJson<AnyRec>(base, "POST", "/evaluations", {
    suite: "finding-bench",
    group: "history+findings",
    order: 0,
    frozen: true,
    seed: "seed-1",
    cases: evalCases,
    taskIds: [taskA],
  });
  rec.eq("冻结评测：201 且记录 seed", [runG1.status, runG1.body.evaluation.seed], [201, "seed-1"]);
  rec.eq("Finding 级指标：误报 1 / 漏项 1 / 待裁决 1 分母单列", [runG1.body.evaluation.metrics.fp, runG1.body.evaluation.metrics.fn, runG1.body.evaluation.metrics.pending, runG1.body.evaluation.metrics.denominators.adjudicated], [1, 1, 1, 3]);
  rec.eq("Finding 级指标：precision/recall 只按已裁决样本算", [runG1.body.evaluation.metrics.precision, runG1.body.evaluation.metrics.recall], [0.5, 0.5]);
  const runG1Id = String(runG1.body.evaluation.id);

  const runG2 = await httpJson<AnyRec>(base, "POST", "/evaluations", {
    suite: "finding-bench",
    group: "bare",
    order: 1,
    frozen: true,
    seed: "seed-1",
    cases: [evalCases[0]],
    taskIds: [taskA],
    isolatedFrom: ["history+findings"],
  });
  rec.eq("组间隔离：第二组声明隔离后 201", runG2.status, 201);
  const rerunWithoutIsolation = await httpJson<AnyRec>(base, "POST", "/evaluations", {
    suite: "finding-bench",
    group: "history+findings",
    order: 0,
    frozen: true,
    seed: "seed-1",
    cases: evalCases,
    isolatedFrom: [],
  });
  rec.eq("交换组顺序的反例：缺隔离声明被拒 400", rerunWithoutIsolation.status, 400);
  const rerunWithIsolation = await httpJson<AnyRec>(base, "POST", "/evaluations", {
    suite: "finding-bench",
    group: "history+findings",
    order: 0,
    frozen: true,
    seed: "seed-1",
    cases: evalCases,
    isolatedFrom: ["bare"],
  });
  rec.eq("正确隔离下回跑同组：幂等返回同一评测", rerunWithIsolation.body.evaluation?.id ?? rerunWithIsolation.text, runG1Id);
  const outOfOrder = await httpJson<AnyRec>(base, "POST", "/evaluations", {
    suite: "finding-bench",
    group: "third",
    order: 0,
    frozen: true,
    seed: "seed-1",
    cases: [evalCases[0]],
  });
  rec.eq("乱序新增组被拒 400", outOfOrder.status, 400);
  const frozenMismatch = await httpJson<AnyRec>(base, "POST", "/evaluations", {
    suite: "finding-bench",
    group: "history+findings",
    order: 0,
    frozen: true,
    seed: "seed-1",
    cases: [evalCases[0]],
    isolatedFrom: ["bare"],
  });
  rec.eq("冻结用例被替换 → 400（不能拿先跑组的答案改题）", frozenMismatch.status, 400);

  // ---------------- 提案：无证据拒绝 → 批准 → 晋升（需评测）→ 回退 ----------------
  const noEvidence = await httpJson<AnyRec>(base, "POST", "/proposals", {
    kind: "param",
    title: "把注入上限从 5 调到 8",
    evidence: [],
  });
  rec.eq("无证据不提案：被拒 400", noEvidence.status, 400);
  const proposal = await httpJson<AnyRec>(base, "POST", "/proposals", {
    kind: "param",
    title: "Observe 注入标题上限 5→6（带证据）",
    body: "两组差分显示召回提升但成本未显著上升",
    evidence: [{ taskId: taskA, pointer: `evaluation:${runG1Id}`, sha256: null }],
    expectedGain: "finding recall +0pp（样本不足，不作强断言）",
    configKey: "memory.injectLimit",
    previousValue: "5",
    proposedValue: "6",
    createdBy: "op-a",
  });
  rec.eq("提案：201 且 draft", [proposal.status, proposal.body.proposal.status], [201, "draft"]);
  const proposalId = String(proposal.body.proposal.id);
  const earlyPromote = await httpJson<AnyRec>(base, "POST", `/proposals/${proposalId}/promote`, { promotedBy: "op-a", evaluationRunId: runG1Id });
  rec.eq("未批准不可晋升：400", earlyPromote.status, 400);
  await httpJson(base, "POST", `/proposals/${proposalId}/decide`, { decision: "approve", decidedBy: "owner", reason: "证据可复核" });
  const promoteNoEval = await httpJson<AnyRec>(base, "POST", `/proposals/${proposalId}/promote`, { promotedBy: "owner", evaluationRunId: "00000000-0000-4000-8000-000000000000" });
  rec.eq("晋升必须有真实评测：404/400", [400, 404].includes(promoteNoEval.status), true, String(promoteNoEval.status));
  const promoted = await httpJson<AnyRec>(base, "POST", `/proposals/${proposalId}/promote`, { promotedBy: "owner", evaluationRunId: runG1Id });
  rec.eq("晋升成功：status=promoted + 记录评测", [promoted.body.proposal.status, promoted.body.proposal.evaluationRunId], ["promoted", runG1Id]);
  const rolledBack = await httpJson<AnyRec>(base, "POST", `/proposals/${proposalId}/rollback`, { rolledBackBy: "owner", reason: "复跑后收益不显著" });
  rec.eq("回退：status=rolled-back，保留晋升时间与所用户评测", [rolledBack.body.proposal.status, Boolean(rolledBack.body.proposal.promotedAt), rolledBack.body.proposal.evaluationRunId], ["rolled-back", true, runG1Id]);
  const events = await httpJson<AnyRec>(base, "GET", `/proposals/${proposalId}/events`);
  rec.eq("回退可复算：事件链 created→approved→promoted→rolled-back", events.body.events.map((event: AnyRec) => event.action), ["created", "approved", "promoted", "rolled-back"]);

  const trend = await httpJson<AnyRec>(base, "GET", "/trends?tenantId=customer-a");
  rec.truthy("趋势：按批次列出 A 的目标与 finding 计数", trend.body.points.some((point: AnyRec) => point.taskId === taskA), "含 taskA", JSON.stringify(trend.body.points?.length ?? 0));

  // ---------------- 角色：规划者 / 复核者 / 辅助者 ----------------
  const planJob = await httpJson<AnyRec>(base, "POST", `/tasks/${taskA}/roles`, {
    role: "planner",
    kind: "plan",
    input: {
      assets: ["app-a-1.example.com"],
      coverage: [
        { asset: "app-a-1.example.com", technique: "CWE-89", state: "verified" },
        { asset: "app-a-1.example.com", technique: "CWE-22", state: "unknown" },
      ],
      goals: [{ id: "g-a", passes: false }],
    },
    simulated: true,
  });
  rec.eq("规划者作业：202 入队", planJob.status, 202);
  const planDone = await waitFor(async () => {
    const r = await httpJson<AnyRec>(base, "GET", `/tasks/${taskA}/jobs/${planJob.body.job.id}`);
    return r.body.job.status === "succeeded" ? r.body.job : null;
  });
  rec.eq("规划者产出：有依据的提案（含 unknown 覆盖）", planDone.result.output.proposals[0]?.basis?.includes("覆盖矩阵"), true, JSON.stringify(planDone.result.output.proposals));
  rec.eq("角色输出标记 simulated + 无账单", [planDone.result.authenticity, planDone.result.billing], ["simulated", "none"]);
  notes.push("角色规划/复核为确定性模拟适配器；真实供应商表现单列「待验证」，未用于任何收益结论。");

  const reviewJob = await httpJson<AnyRec>(base, "POST", `/tasks/${taskA}/roles`, {
    role: "reviewer",
    kind: "review",
    input: {
      claims: [
        { id: "c1", text: "登录口存在 SQL 注入", evidence: ["http/tx-a.txt"] },
        { id: "c2", text: "管理后台可越权（无证据）", evidence: [] },
      ],
      counterEvidenceRequired: true,
      counterEvidence: [],
    },
  });
  const reviewDone = await waitFor(async () => {
    const r = await httpJson<AnyRec>(base, "GET", `/tasks/${taskA}/jobs/${reviewJob.body.job.id}`);
    return r.body.job.status === "succeeded" ? r.body.job : null;
  });
  const verdicts = reviewDone.result.output.opinions.map((opinion: AnyRec) => opinion.verdict);
  rec.eq("复核者意见：支持/需补证据/反证缺失分别表达", [verdicts.includes("support"), verdicts.includes("needs-evidence"), verdicts.includes("challenge")], [true, true, true]);

  const incident = await httpJson<AnyRec>(base, "POST", `/tasks/${taskA}/roles`, {
    role: "assistant",
    kind: "incident",
    input: { signals: [{ kind: "canary-token-touched", detail: "疑似金丝雀", severity: "critical" }] },
  });
  rec.eq("辅助者：按既有权限请求暂停（非终态）", [incident.body.output.pauseRequested, incident.body.paused], [true, true]);
  const paused = await httpJson<AnyRec>(base, "GET", `/tasks/${taskA}`);
  rec.eq("辅助者：任务进入 paused，恢复留给操作员", paused.body.task.status, "paused");
  const resume = await httpJson<AnyRec>(base, "POST", `/tasks/${taskA}/resume`);
  rec.eq("操作员恢复：paused→运行态", ["queued", "running", "initializing"].includes(resume.body.task.status), true, resume.body.task.status);

  // ---------------- 供应商韧性（故障注入）----------------
  const rl = await httpJson<AnyRec>(base, "POST", `/tasks/${taskA}/provider`, {
    provider: "primary",
    fault: "rate-limit",
    attempt: 0,
    billing: "none",
  });
  rec.eq("429：退避重试，不切换", [rl.body.plan.action, rl.body.plan.backoffMs > 0], ["retry", true]);
  rec.eq("无账单时成本不可见（不把 Token 降低写成省钱）", rl.body.plan.costVisible, false);
  const quota = await httpJson<AnyRec>(base, "POST", `/tasks/${taskA}/provider`, {
    provider: "primary",
    fault: "insufficient-balance",
    attempt: 0,
    fallbackAllowed: true,
    billing: "usage-only",
    tokens: 120,
  });
  rec.eq("余额不足：切到获准的备用供应商", [quota.body.plan.action, quota.body.plan.nextProvider, quota.body.plan.egressAllowed], ["failover", "primary-fallback", true]);
  rec.eq("费用可见性：有 usage 计费时 costVisible=true", quota.body.plan.costVisible, true);
  const quotaAgain = await httpJson<AnyRec>(base, "POST", `/tasks/${taskA}/provider`, {
    provider: "primary",
    fault: "insufficient-balance",
    attempt: 0,
    fallbackAllowed: true,
    billing: "usage-only",
    tokens: 120,
  });
  rec.eq("故障恢复后的重复记账被识别（同一键第二次）", quotaAgain.body.duplicateAccounting, true);
  const egress = await httpJson<AnyRec>(base, "POST", `/tasks/${taskA}/provider`, {
    provider: "primary",
    fault: "egress-denied",
    attempt: 0,
    fallbackAllowed: false,
  });
  rec.eq("外发受限：不得切换供应商，只能阻塞等人", [egress.body.plan.action, egress.body.plan.nextProvider], ["blocked", null]);
  const timeout = await httpJson<AnyRec>(base, "POST", `/tasks/${taskA}/provider`, {
    provider: "primary",
    fault: "timeout",
    attempt: 1,
    fallbackAllowed: false,
  });
  rec.eq("超时且备用未获准：blocked", timeout.body.plan.action, "blocked");

  // ---------------- 无进展告警（tool_gate 计数）----------------
  // 先暂停，避免 mock worker 继续追加事实把“无新事实”的判定窗口挪走。
  await httpJson(base, "POST", `/tasks/${taskA}/pause`);
  await new Promise((resolve) => setTimeout(resolve, 600));
  const seedGates = openHistory({
    dbPath: join(root, "tasks", taskA, "history.sqlite"),
    evidenceDir: join(root, "tasks", taskA, "evidence"),
  });
  try {
    for (let index = 0; index < 3; index += 1) {
      seedGates.recordToolGate(taskA, { tool: "shell", ok: false, reason: "fixture-deny", detail: { seq: index } });
    }
  } finally {
    seedGates.close();
  }
  const alarm = await httpJson<AnyRec>(base, "GET", `/tasks/${taskA}/alerts?threshold=2`);
  rec.eq("无进展告警：连续工具调用无新事实 → alarm", [alarm.body.alarm, alarm.body.toolCallsSinceFact >= 3], [true, true]);
  const consult = await httpJson<AnyRec>(base, "POST", `/tasks/${taskA}/consults`, {
    question: "等待人工判断（用于抑制误报）",
    blocking: true,
    askedBy: "agent",
  });
  const alarmSuppressed = await httpJson<AnyRec>(base, "GET", `/tasks/${taskA}/alerts?threshold=2`);
  rec.eq("等待人工答复期间不报无进展", [alarmSuppressed.body.alarm, alarmSuppressed.body.waitingOnConsult], [false, true]);
  await httpJson(base, "POST", `/tasks/${taskA}/consults/${consult.body.consult.id}/answer`, { answer: "继续", answeredBy: "owner", injectHint: true });
  await httpJson(base, "POST", `/tasks/${taskA}/resume`);

  // ---------------- 记录 ----------------
  const snapshot = await httpJson<AnyRec>(base, "GET", `/tasks/${taskA}/snapshot`);
  writeFileSync(join(evidenceRun, "snapshot.json"), JSON.stringify(snapshot.body.snapshot, null, 2));
  const recorded = writeRunRecord({
    dir: evidenceRun,
    runId,
    kind: "r9-flywheel",
    taskId: taskA,
    dataRoot: root,
    startedAt,
    steps: rec.snapshot(),
    summary: {
      taskA,
      taskB,
      memoryId,
      findingId,
      evaluations: { group1: runG1Id, group2: runG2.body.evaluation?.id ?? null },
      proposalId,
      scorecard: snapshot.body.scorecard,
    },
    commands,
    notes,
  });
  rec.record("记录落盘", true, "acceptance-record.json", recorded.recordJson);
  // 上一步是对落盘结果的断言；把它本身也写进记录（二次落盘，哈希以最终文件为准）。
  const finalRecord = writeRunRecord({
    dir: evidenceRun,
    runId,
    kind: "r9-flywheel",
    taskId: taskA,
    dataRoot: root,
    startedAt,
    steps: rec.snapshot(),
    summary: {
      taskA,
      taskB,
      memoryId,
      findingId,
      evaluations: { group1: runG1Id, group2: runG2.body.evaluation?.id ?? null },
      proposalId,
      scorecard: snapshot.body.scorecard,
    },
    commands,
    notes,
  });
  writeFileSync(join(evidenceRun, "run-summary.json"), JSON.stringify({ runId, taskA, taskB, memoryId, findingId, runG1Id, proposalId, hashes: finalRecord.hashes }, null, 2));
  await plane.stop();
  console.log(`\nDONE ${runId}: ${rec.steps.length} steps, ${rec.steps.filter((step) => step.ok).length} passed`);
}

main().catch((error) => {
  console.error(error);
  try {
    writeRunRecord({
      dir: evidenceRun,
      runId,
      kind: "r9-flywheel",
      taskId: "",
      dataRoot: root,
      startedAt,
      steps: rec.snapshot(),
      summary: { error: error instanceof Error ? error.message : String(error) },
      commands,
      notes,
    });
  } catch {
    /* 保留原始错误 */
  }
  process.exit(1);
});

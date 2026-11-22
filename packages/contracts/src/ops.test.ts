import assert from "node:assert/strict";
import { test } from "node:test";
import {
  CONSULT_BLOCKING_TTL_MS,
  deriveCoverageMatrix,
  enforceRoleAction,
  findingMetrics,
  freshnessOf,
  jobPauseDisposition,
  jobReceiptKey,
  matchMemory,
  planProviderAttempt,
  reconcileJobAfterBoot,
  sweepConsult,
  visibilityDenial,
  type Consultation,
  type FindingEvalCase,
  type MemoryNode,
} from "./index.js";

const DAY = 86_400_000;

function memory(id: string, overrides: Partial<MemoryNode> = {}): MemoryNode {
  return {
    id,
    kind: "lesson",
    title: `lesson-${id}`,
    body: "",
    status: "confirmed",
    matchKeys: [{ kind: "family", value: "web-login", strength: "hard" }],
    provenance: [{ taskId: "11111111-1111-4111-8111-111111111111", engagementId: "eng", refKind: "fact", refId: "f1", path: null, sha256: null }],
    contradicts: null,
    supersedes: null,
    supersededBy: null,
    reviewer: "op",
    reviewedAt: "2026-11-22T00:00:00.000Z",
    reviewReason: "",
    reuseCount: 0,
    createdAt: "2026-11-22T00:00:00.000Z",
    updatedAt: "2026-11-22T00:00:00.000Z",
    supportRetracted: false,
    ...overrides,
  };
}

test("可见性：租户/委托不匹配拒绝，缺委托的任务自成一委托", () => {
  const task = { id: "t1", tenantId: "customer-a", engagementId: "eng-a" };
  assert.equal(visibilityDenial({ tenantId: "customer-b", role: "operator" }, task)?.code, "tenant-mismatch");
  assert.equal(visibilityDenial({ tenantId: "customer-a", engagementId: "eng-b", role: "operator" }, task)?.code, "engagement-mismatch");
  assert.equal(visibilityDenial({ tenantId: "customer-a", engagementId: "eng-a", role: "operator" }, task), null);
  const legacy = { id: "t2", tenantId: "default" };
  assert.equal(visibilityDenial({ tenantId: "default", engagementId: "t2", role: "operator" }, legacy), null);
});

test("记忆匹配：只取 confirmed，硬键优先，N=5 上限 + 命中资产追加 2", () => {
  const nodes: MemoryNode[] = [];
  for (let i = 0; i < 7; i += 1) nodes.push(memory(`m${i}`, { createdAt: `2026-11-2${i}T00:00:00.000Z` }));
  nodes.push(memory("draft", { status: "draft" }));
  nodes.push(memory("retracted", { status: "retracted" }));
  nodes.push(memory("soft1", { matchKeys: [{ kind: "cwe", value: "CWE-89", strength: "soft" }] }));
  const selected = matchMemory(nodes, { familyKey: "web-login", cwes: ["CWE-89"] });
  assert.equal(selected.length, 5, "标题层上限 N=5");
  assert.ok(selected.every((entry) => entry.node.status === "confirmed"));
  assert.ok(selected.every((entry) => entry.layer === "bootstrap"));
  const assetExtra = matchMemory(
    [...nodes, memory("asset", { matchKeys: [{ kind: "asset-class", value: "app-a-1.example.com", strength: "soft" }] })],
    { familyKey: "web-login", assetKey: "app-a-1.example.com", cwes: ["CWE-89"] },
    { limit: 2, assetExtra: 2 },
  );
  assert.equal(assetExtra.filter((entry) => entry.layer === "bootstrap").length, 2);
  assert.equal(assetExtra.filter((entry) => entry.layer === "explore-extra").length, 1);
  const onlySoft = matchMemory([nodes.find((node) => node.id === "soft1")!], { cwes: ["CWE-89"] });
  assert.equal(onlySoft.length, 0, "单个软键不注入");
});

test("材料分类：格式/归属/过期分别表达，accepted 要三项都过", () => {
  const now = Date.parse("2026-11-22T00:00:00.000Z");
  const base = {
    path: "materials/hosts.csv",
    content: "host,version\napp-a-1.example.com,1\n",
    asset: "app-a-1.example.com",
    targets: ["app-a-1.example.com"],
    observedAt: "2026-11-21T00:00:00.000Z",
    nowMs: now,
  };
  assert.equal((requireClassify({ ...base, content: "binary", path: "x.bin" })).status, "unsupported");
  assert.equal(requireClassify({ ...base, asset: "app-z.example.com" }).status, "unknown-owner");
  assert.equal(requireClassify({ ...base, observedAt: "2026-09-01T00:00:00.000Z" }).status, "expired");
  assert.equal(requireClassify(base).status, "accepted");
});

import { classifyMaterial } from "./index.js";
function requireClassify(input: Parameters<typeof classifyMaterial>[0]) {
  return classifyMaterial(input);
}

test("覆盖矩阵：verified > manual > attempted > retracted > material", () => {
  const cells = deriveCoverageMatrix({
    assets: ["a.example.com"],
    techniques: ["CWE-89", "CWE-79", "CWE-22", "CWE-352", "CWE-78"],
    materials: [
      { asset: "a.example.com", kind: "asset-inventory", status: "accepted", materialPath: "m.csv", sha256: "1".repeat(64) },
    ],
    findings: [
      { id: "f1", asset: "a.example.com", vulnClass: "CWE-89", status: "verified", evidence: [{ path: "tx1", sha256: "2".repeat(64) }] },
      { id: "f2", asset: "a.example.com", vulnClass: "CWE-79", status: "verified", evidence: [{ path: "tx2", sha256: "3".repeat(64) }] },
      { id: "f3", asset: "a.example.com", vulnClass: "CWE-22", status: "verified", evidence: [{ path: "tx3", sha256: "4".repeat(64) }] },
    ],
    intents: [{ technique: "CWE-352", asset: "a.example.com", status: "failed" }],
    manual: [{ asset: "a.example.com", technique: "CWE-78", state: "manual", evidenceRefs: ["tx9"] }],
    retractedEvidence: ["tx3"],
  });
  const state = (technique: string) => cells.find((cell) => cell.technique === technique)?.state;
  assert.equal(state("CWE-89"), "verified");
  assert.equal(state("CWE-79"), "verified");
  assert.equal(state("CWE-22"), "retracted", "唯一依据撤回后压过材料存在");
  assert.equal(state("CWE-352"), "attempted");
  assert.equal(state("CWE-78"), "manual");
  // 人工覆盖未附证据：仍算 manual，不得被当成 retracted。
  const noRefs = deriveCoverageMatrix({
    assets: ["b.example.com"],
    techniques: ["AUTHZ-BOLA"],
    materials: [],
    findings: [],
    intents: [],
    manual: [{ asset: "b.example.com", technique: "AUTHZ-BOLA", state: "manual", evidenceRefs: [] }],
  });
  assert.equal(noRefs[0]?.state, "manual");
  // 人工覆盖附的证据被撤回：降为 retracted。
  const retractedManual = deriveCoverageMatrix({
    assets: ["b.example.com"],
    techniques: ["AUTHZ-BOLA"],
    materials: [],
    findings: [],
    intents: [],
    manual: [{ asset: "b.example.com", technique: "AUTHZ-BOLA", state: "manual", evidenceRefs: ["gone.txt"] }],
    retractedEvidence: ["gone.txt"],
  });
  assert.equal(retractedManual[0]?.state, "retracted");
});

test("事实时效：TTL 只产生待复核派生态，不改原事实", () => {
  const fact = { id: "f1", tags: ["asset"], createdAt: "2026-11-01T00:00:00.000Z" };
  const fresh = freshnessOf(fact, Date.parse("2026-11-03T00:00:00.000Z"));
  assert.equal(fresh.state, "fresh");
  const stale = freshnessOf(fact, Date.parse("2026-11-20T00:00:00.000Z"));
  assert.equal(stale.state, "needs-review");
  assert.equal(stale.reason, "fact-older-than-7d");
});

test("24h 求助：到期只解除阻塞，问题仍 open", () => {
  const consult: Consultation = {
    id: "c1",
    taskId: "11111111-1111-4111-8111-111111111111",
    engagementId: "eng",
    question: "继续?",
    options: [],
    context: "",
    blocking: true,
    status: "open",
    scopeVersion: 1,
    createdAt: "2026-11-22T00:00:00.000Z",
    dueAt: new Date(Date.parse("2026-11-22T00:00:00.000Z") + CONSULT_BLOCKING_TTL_MS).toISOString(),
    releasedAt: null,
    answeredAt: null,
    answeredBy: null,
    answer: null,
    relatedIntentId: null,
    relatedJobId: null,
  };
  assert.equal(sweepConsult(consult, Date.parse("2026-11-22T23:00:00.000Z")).changed, false);
  const swept = sweepConsult(consult, Date.parse("2026-11-23T00:00:01.000Z"));
  assert.equal(swept.changed, true);
  assert.equal(swept.next.status, "open");
  assert.equal(swept.next.blocking, false);
});

test("作业暂停三态与重启对账", () => {
  assert.equal(jobPauseDisposition("running", true), "draining");
  assert.equal(jobPauseDisposition("running", false), "stopped");
  assert.equal(jobPauseDisposition("queued", false), "stopped");
  assert.equal(jobPauseDisposition("succeeded", false), "unchanged");
  assert.equal(reconcileJobAfterBoot({ status: "running", bootId: "boot-1" }, "boot-2"), "unknown");
  assert.equal(reconcileJobAfterBoot({ status: "running", bootId: "boot-2" }, "boot-2"), null);
  assert.equal(jobReceiptKey("j1", 0), "j1:0");
});

test("Finding 指标：待裁决不进 FP/FN，recall 分母为已裁决正例", () => {
  const cases: FindingEvalCase[] = [
    { id: "1", asset: "", vulnClass: "CWE-89", expectedPresent: true, expectedSeverity: "high", actualPresent: true, actualSeverity: "high", actualStatus: "verified", adjudication: "confirmed" },
    { id: "2", asset: "", vulnClass: "CWE-79", expectedPresent: false, expectedSeverity: null, actualPresent: true, actualSeverity: "low", actualStatus: "verified", adjudication: "confirmed" },
    { id: "3", asset: "", vulnClass: "CWE-22", expectedPresent: true, expectedSeverity: null, actualPresent: false, actualSeverity: null, actualStatus: null, adjudication: "confirmed" },
    { id: "4", asset: "", vulnClass: "CWE-352", expectedPresent: true, expectedSeverity: null, actualPresent: true, actualSeverity: null, actualStatus: "tentative", adjudication: "pending" },
  ];
  const metrics = findingMetrics(cases);
  assert.equal(metrics.tp, 1);
  assert.equal(metrics.fp, 1);
  assert.equal(metrics.fn, 1);
  assert.equal(metrics.pending, 1);
  assert.equal(metrics.precision, 0.5);
  assert.equal(metrics.recall, 0.5, "1/(1+1)，待裁决不计入");
  assert.deepEqual(metrics.denominators, { expected: 3, reported: 3, adjudicated: 3, pending: 1 });
});

test("供应商韧性：外发受限禁止切换，429 先退避", () => {
  const policy = {
    engagementId: "eng",
    materialDataClass: "customer-material",
    providers: [
      { name: "primary", priority: 0, allowedDataClasses: ["customer-material"] },
      { name: "fallback", priority: 1, allowedDataClasses: [] },
    ],
  };
  const egress = planProviderAttempt({ policy, provider: "primary", fault: "egress-denied", attempt: 0, billing: "billed" });
  assert.equal(egress.action, "blocked");
  assert.equal(egress.nextProvider, null, "外发受限时不得换一个同样未获准的通道");
  const rl = planProviderAttempt({ policy, provider: "primary", fault: "rate-limit", attempt: 0 });
  assert.equal(rl.action, "retry");
  assert.ok((rl.backoffMs ?? 0) > 0);
  const quota = planProviderAttempt({
    policy: { ...policy, providers: [policy.providers[0]!, { name: "fallback", priority: 1, allowedDataClasses: ["customer-material"] }] },
    provider: "primary",
    fault: "insufficient-balance",
    attempt: 0,
    billing: "usage-only",
  });
  assert.equal(quota.action, "failover");
  assert.equal(quota.costVisible, true);
});

test("角色权限：辅助者可请求暂停，不可 stop/扩 scope/派单", () => {
  assert.equal(enforceRoleAction("assistant", "pause").allowed, true);
  assert.equal(enforceRoleAction("assistant", "request-pause").allowed, true);
  assert.equal(enforceRoleAction("assistant", "stop").allowed, false);
  assert.equal(enforceRoleAction("assistant", "expand-scope").allowed, false);
  assert.equal(enforceRoleAction("assistant", "dispatch-intent").allowed, false);
  assert.equal(enforceRoleAction("planner", "propose").allowed, true);
  assert.equal(enforceRoleAction("reviewer", "review").allowed, true);
});

import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import {
  ORIGIN_FACT_ID,
  type AssetRecord,
  type Fact,
  type Finding,
  type Intent,
} from "@gongyuai/contracts";
import { buildDagExport } from "./dag.js";
import { openHistory, writeEvidenceFile } from "./index.js";

const TASK = "55555555-5555-4555-8555-555555555555";
const T0 = "2026-11-24T00:00:00.000Z";
const T1 = "2026-11-24T00:01:00.000Z";
const T2 = "2026-11-24T00:02:00.000Z";
const T3 = "2026-11-24T00:03:00.000Z";
const SHA = "c".repeat(64);

function fact(overrides: Partial<Fact> & { id: string }): Fact {
  return {
    taskId: TASK,
    layer: "title",
    title: "fact",
    summary: "",
    evidencePath: null,
    tags: [],
    createdAt: T0,
    intentId: null,
    ...overrides,
  };
}

function intent(overrides: Partial<Intent> & { id: string }): Intent {
  return {
    taskId: TASK,
    title: "intent",
    summary: "",
    status: "claimed",
    sourceFactIds: [ORIGIN_FACT_ID],
    technique: null,
    assetRoot: null,
    claimedBy: "w0",
    createdAt: T1,
    updatedAt: T1,
    concludedAt: null,
    conclusion: null,
    ...overrides,
  };
}

function finding(overrides: Partial<Finding> & { id: string }): Finding {
  return {
    taskId: TASK,
    title: "finding",
    asset: "app.example.com",
    vulnClass: "CWE-89",
    severity: "high",
    cvss: null,
    confidence: "firm",
    status: "verified",
    endpoint: "/login",
    dedupKey: "app.example.com|cwe-89|/login",
    intentId: null,
    factIds: [],
    evidence: [],
    repro: "curl",
    impact: "",
    fix: "",
    createdAt: T2,
    verifiedAt: T2,
    verifiedBy: "w0",
    ...overrides,
  };
}

const ASSET: AssetRecord = {
  address: "app.example.com",
  kind: "live",
  assetType: "domain",
  parentAddress: null,
  weight: 0,
  factId: "asset-fact",
  title: "资产 · live · app.example.com",
  summary: "",
  source: "discover",
  createdAt: T0,
  intentId: null,
};

test("纯函数导出：资产 → 事实 → 意图 → 漏洞 全链路连线 + findings 稳定字段", () => {
  const assetFact = fact({
    id: "asset-fact",
    tags: ["asset", "asset.kind:live", "asset.addr:app.example.com", "asset.source:discover"],
    title: "资产 · live · app.example.com",
  });
  const evidenceFact = fact({
    id: "evidence-fact",
    intentId: "intent-1",
    createdAt: T1,
    title: "sqli 复现",
    evidencePath: "findings/sqli.txt",
  });
  const umbrella = intent({
    id: "intent-1",
    sourceFactIds: ["asset-fact"],
    assetRoot: "app.example.com",
  });
  const sqli = finding({
    id: "finding-1",
    intentId: "intent-1",
    factIds: ["evidence-fact"],
    trafficIds: ["0b7c0b7c-0000-4000-8000-000000000001"],
    qualification: "confirmed",
    evidence: [{ path: "findings/sqli.txt", sha256: SHA, role: "proof" }],
  });

  const dag = buildDagExport({
    taskId: TASK,
    generatedAt: T2,
    facts: [assetFact, evidenceFact],
    intents: [umbrella],
    findings: [sqli],
    assets: [ASSET],
  });

  const ids = new Set(dag.nodes.map((entry) => entry.id));
  assert.ok(ids.has("asset:app.example.com"));
  assert.ok(ids.has("fact:asset-fact"));
  assert.ok(ids.has("fact:evidence-fact"));
  assert.ok(ids.has("intent:intent-1"));
  assert.ok(ids.has("finding:finding-1"));

  const edgeOf = (from: string, to: string, kind: string) =>
    dag.edges.find((entry) => entry.from === from && entry.to === to && entry.kind === kind);

  const assertedBy = edgeOf("asset:app.example.com", "fact:asset-fact", "asserted-by");
  assert.ok(assertedBy);
  assert.equal(assertedBy.verification, undefined);

  const anchors = edgeOf("fact:asset-fact", "intent:intent-1", "anchors");
  assert.ok(anchors);
  assert.equal(anchors.verification, "proven");
  assert.equal(anchors.broken, false);

  const produces = edgeOf("intent:intent-1", "fact:evidence-fact", "produces");
  assert.ok(produces);
  assert.equal(produces.verification, "proven");

  const evidences = edgeOf("fact:evidence-fact", "finding:finding-1", "evidences");
  assert.ok(evidences);
  assert.equal(evidences.verification, "proven");

  const yields = edgeOf("intent:intent-1", "finding:finding-1", "yields");
  assert.ok(yields);
  assert.equal(yields.verification, "proven");

  assert.equal(dag.findings.length, 1);
  const exposed = dag.findings[0]!;
  assert.equal(exposed.intentId, "intent-1");
  assert.deepEqual(exposed.factIds, ["evidence-fact"]);
  assert.deepEqual(exposed.trafficIds, ["0b7c0b7c-0000-4000-8000-000000000001"]);
  assert.equal(exposed.qualification, "confirmed");
  assert.equal(exposed.evidence[0]!.sha256, SHA);

  const findingNode = dag.nodes.find((entry) => entry.id === "finding:finding-1")!;
  assert.equal((findingNode.data as Record<string, unknown>).intentId, "intent-1");
  assert.deepEqual((findingNode.data as Record<string, unknown>).factIds, ["evidence-fact"]);

  assert.ok(dag.notes.some((note) => note.includes("因果边")));
});

test("纯函数导出：origin 挂靠不参与因果校验；无共同证据的边标 proposed", () => {
  const umbrella = intent({ id: "intent-origin", sourceFactIds: [ORIGIN_FACT_ID] });
  const orphanFact = fact({ id: "fact-orphan" });
  const dag = buildDagExport({
    taskId: TASK,
    generatedAt: T2,
    facts: [orphanFact],
    intents: [umbrella],
    findings: [],
    assets: [],
  });
  const originNode = dag.nodes.find((entry) => entry.id === `fact:${ORIGIN_FACT_ID}`);
  assert.ok(originNode);
  const originEdge = dag.edges.find(
    (entry) => entry.from === `fact:${ORIGIN_FACT_ID}` && entry.to === "intent:intent-origin",
  );
  assert.ok(originEdge);
  assert.equal(originEdge.verification, undefined);
  assert.ok(dag.notes.some((note) => note.includes("孤立事实 1 条")));
});

test("纯函数导出：Finding → Finding 只按时间正序派生（同证据推进 proven，无反向边）", () => {
  const first = finding({
    id: "finding-a",
    factIds: [],
    evidence: [{ path: "findings/a.txt", sha256: SHA, role: "proof" }],
  });
  const second = finding({
    id: "finding-b",
    createdAt: T3,
    dedupKey: "app.example.com|cwe-89|/login|b",
    evidence: [{ path: "findings/b.txt", sha256: SHA, role: "proof" }],
  });
  const forward = buildDagExport({
    taskId: TASK,
    generatedAt: T2,
    facts: [],
    intents: [],
    findings: [first, second],
    assets: [],
  });
  const escalates = forward.edges.find(
    (entry) => entry.kind === "escalates" && entry.from === "finding:finding-a",
  );
  assert.ok(escalates);
  assert.equal(escalates.verification, "proven");
  assert.equal(escalates.abstentionReason, undefined);
  // 反向边不派生（倒挂由校验器判定，不由投影编造）。
  assert.equal(
    forward.edges.some(
      (entry) => entry.kind === "escalates" && entry.from === "finding:finding-b",
    ),
    false,
  );
});

type Setup = ReturnType<typeof setup>;

function setup(prefix: string) {
  const root = mkdtempSync(join(tmpdir(), prefix));
  const evidenceDir = join(root, "evidence");
  mkdirSync(evidenceDir, { recursive: true });
  const dbPath = join(root, "history.sqlite");
  const store = openHistory({ dbPath, evidenceDir });
  return { root, dbPath, evidenceDir, store };
}

const AUTH = {
  targets: ["*.example.com"],
  outOfScope: [] as string[],
  pivotPolicy: { mode: "off" as const, cidrs: [] as string[] },
};

test("HistoryStore.dagExport：Explore 写入自动挂伞形 Intent，链路 proven + 独立复核可见", () => {
  const { root, evidenceDir, store }: Setup = setup("gy-dag-");
  try {
    const taskId = TASK;
    // 资产事实 → 意图（伞形）→ Explore 事实（不传 intentId）→ 发现。
    const asset = store.recordAsset({
      taskId,
      address: "app.example.com",
      auth: AUTH,
      live: true,
    });
    const umbrella = store.proposeIntent({
      taskId,
      title: "伞形测试 app.example.com",
      sourceFactIds: [asset.fact.id],
      assetRoot: "app.example.com",
    });
    store.claimIntent(taskId, umbrella.id, "w0");
    // 不给 intentId：必须自动继承。
    const evidenceFact = store.appendFact({
      taskId,
      layer: "title",
      title: "sqli 复现",
      summary: "布尔盲注返回差异",
    });
    assert.equal(evidenceFact.intentId, umbrella.id);

    const lead = store.recordFinding({
      taskId,
      title: "登录处 SQL 注入",
      asset: "app.example.com",
      vulnClass: "CWE-89",
      severity: "high",
      endpoint: "/login",
      factIds: [evidenceFact.id],
    });
    assert.equal(lead.finding.intentId, umbrella.id);

    writeEvidenceFile(evidenceDir, "findings/sqli.txt", "POST /login → 500 SQL error\n");
    const verified = store.verifyFinding(taskId, lead.finding.id, {
      evidencePaths: ["findings/sqli.txt"],
      repro: "curl -d \"user='\" https://app.example.com/login",
      verifiedBy: "w0",
    });
    const reviewed = store.recordFindingValidation(taskId, verified.id, {
      verdict: "confirmed",
      method: "evidence-only",
      evidencePaths: ["findings/sqli.txt"],
      note: "独立复核：证据可复现",
      validator: "operator:reviewer",
    });
    assert.equal(reviewed.validation.independent, true);

    const dag = store.dagExport(taskId, T2);
    const edgeOf = (from: string, to: string, kind: string) =>
      dag.edges.find((entry) => entry.from === from && entry.to === to && entry.kind === kind);

    assert.ok(dag.nodes.some((node) => node.id === "asset:app.example.com"));
    const anchors = edgeOf(`fact:${asset.fact.id}`, `intent:${umbrella.id}`, "anchors");
    assert.equal(anchors?.verification, "proven");
    const produces = edgeOf(`intent:${umbrella.id}`, `fact:${evidenceFact.id}`, "produces");
    assert.equal(produces?.verification, "proven");
    const evidences = edgeOf(`fact:${evidenceFact.id}`, `finding:${verified.id}`, "evidences");
    assert.equal(evidences?.verification, "proven");
    const yields = edgeOf(`intent:${umbrella.id}`, `finding:${verified.id}`, "yields");
    assert.equal(yields?.verification, "proven");

    assert.equal(dag.findings.length, 1);
    assert.equal(dag.findings[0]!.intentId, umbrella.id);
    assert.deepEqual(dag.findings[0]!.factIds, [evidenceFact.id]);
    assert.equal(dag.findings[0]!.qualification, null);
    assert.equal(dag.findings[0]!.validations.confirmed, 1);
    assert.equal(dag.findings[0]!.validations.independentConfirmed, true);
    // 导出幂等：同一时点两次投影逐字节相同。
    assert.deepEqual(dag, store.dagExport(taskId, T2));
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("HistoryStore.dagExport：时间倒挂的边诚实标 proposed + timestamp_inversion", () => {
  const { root, dbPath, store }: Setup = setup("gy-dag-invert-");
  try {
    const taskId = TASK;
    const asset = store.recordAsset({ taskId, address: "app.example.com", auth: AUTH, live: true });
    const umbrella = store.proposeIntent({
      taskId,
      title: "inversion",
      sourceFactIds: [asset.fact.id],
    });
    store.claimIntent(taskId, umbrella.id, "w0");
    const lead = store.recordFinding({
      taskId,
      title: "线索",
      asset: "app.example.com",
      vulnClass: "CWE-79",
      severity: "medium",
    });
    // 制造倒挂：把 Intent 的 createdAt 改到 finding 之后（真实运行中不会发生，
    // 这里用直接写库模拟“被外部导入/时钟回拨污染”的 DAG）。
    const db = new DatabaseSync(dbPath);
    const poisoned = new Date(Date.now() + 60_000).toISOString();
    db.prepare("UPDATE intents SET created_at = ? WHERE id = ?").run(poisoned, umbrella.id);
    db.close();

    const dag = store.dagExport(taskId, T2);
    const yields = dag.edges.find(
      (entry) => entry.kind === "yields" && entry.to === `finding:${lead.finding.id}`,
    );
    assert.ok(yields);
    assert.equal(yields.verification, "proposed");
    assert.equal(yields.abstentionReason, "timestamp_inversion");
    assert.equal(yields.broken, false);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("无显式 intentId/factIds 的漏洞：按共享证据连 Fact，否则兜底连所属资产", () => {
  const seed = fact({ id: "f-seed", tags: ["asset.addr:10.0.186.1"] });
  const evFact = fact({ id: "f-ev", evidencePath: "findings/gradio.txt", createdAt: T0 });
  const withSharedEv = finding({
    id: "finding-ev",
    asset: "10.0.186.1",
    intentId: null,
    factIds: [],
    evidence: [{ path: "findings/gradio.txt", sha256: SHA, role: "proof" }],
    createdAt: T1,
  });
  const assetOnly = finding({
    id: "finding-asset",
    asset: "10.0.186.1",
    intentId: null,
    factIds: [],
    evidence: [],
    createdAt: T1,
  });

  const dag = buildDagExport({
    taskId: TASK,
    generatedAt: T2,
    facts: [seed, evFact],
    intents: [],
    findings: [withSharedEv, assetOnly],
    assets: [{ ...ASSET, address: "10.0.186.1", factId: seed.id }],
  });

  const evEdge = dag.edges.find(
    (e) => e.from === "fact:f-ev" && e.to === "finding:finding-ev" && e.kind === "evidences",
  );
  assert.ok(evEdge, "共享证据文件的漏洞应连到对应 Fact");
  assert.equal(evEdge.verification, "proven");

  const assetEdge = dag.edges.find(
    (e) => e.from === "asset:10.0.186.1" && e.to === "finding:finding-asset" && e.kind === "affects",
  );
  assert.ok(assetEdge, "无证据匹配的漏洞应兜底连到所属资产");
  assert.equal(assetEdge.broken, false);
});

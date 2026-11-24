import test from "node:test";
import assert from "node:assert/strict";
import { collectDag, buildDagLayout, assetNodeId, type DagAsset, type DagFact, type DagFinding, type DagIntent } from "./buildDagLayout.js";

const assets: DagAsset[] = [{ address: "app.example", kind: "live", factId: "f-seed" }];
const facts: DagFact[] = [
  { id: "f-seed", layer: "title", title: "种子资产", createdAt: "2026-11-24T01:00:00Z", tags: ["asset.addr:app.example"] },
  { id: "f1", layer: "summary", title: "发现登录口", createdAt: "2026-11-24T02:00:00Z", intentId: "i1", tags: ["asset.addr:app.example"] },
  { id: "f-orphan", layer: "summary", title: "孤立杂项", createdAt: "2026-11-24T03:00:00Z" },
];
const intents: DagIntent[] = [
  { id: "i1", title: "测 SQL 注入", status: "succeeded", sourceFactIds: ["f-seed"], assetRoot: "app.example", createdAt: "2026-11-24T01:30:00Z" },
];
const findings: DagFinding[] = [
  { id: "v1", title: "SQL 注入", asset: "app.example", vulnClass: "CWE-89", severity: "high", status: "verified", intentId: "i1", factIds: ["f1"], createdAt: "2026-11-24T02:30:00Z", evidence: [{ path: "evidence/poc.txt", sha256: "a".repeat(64) }] },
];

const link = (dag: ReturnType<typeof collectDag>, source: string, target: string, kind: string) =>
  dag.links.find((l) => l.source === source && l.target === target && l.kind === kind);

test("四层节点齐全：资产 → 事实 → 意图 → 漏洞", () => {
  const dag = collectDag(facts, intents, findings, assets);
  assert.equal(dag.records.get(assetNodeId("app.example"))?.kind, "asset");
  assert.equal(dag.records.get("f1")?.kind, "fact");
  assert.equal(dag.records.get("i1")?.kind, "intent");
  assert.equal(dag.records.get("v1")?.kind, "finding");
});

test("因果链路边边可连，显式引用判 proven", () => {
  const dag = collectDag(facts, intents, findings, assets);
  assert.equal(link(dag, assetNodeId("app.example"), "f-seed", "asserted-by")?.structural, true);
  assert.equal(link(dag, "f-seed", "i1", "anchors")?.verification, "proven");
  assert.equal(link(dag, "i1", "f1", "produces")?.verification, "proven");
  assert.equal(link(dag, "f1", "v1", "evidences")?.verification, "proven");
  assert.equal(link(dag, "i1", "v1", "yields")?.verification, "proven");
});

test("无任何连线的孤立 Fact 默认折叠，开关释放", () => {
  const dag = collectDag(facts, intents, findings, assets);
  assert.ok(dag.orphanIds.has("f-orphan"));
  const hidden = buildDagLayout(dag, false, false);
  assert.equal(hidden.positions.some((p) => p.id === "f-orphan"), false);
  const shown = buildDagLayout(dag, false, true);
  assert.equal(shown.positions.some((p) => p.id === "f-orphan"), true);
});

test("时间倒挂的因果边判 proposed 并给出弃证理由", () => {
  const badIntents: DagIntent[] = [
    { id: "i-bad", title: "倒挂意图", status: "proposed", sourceFactIds: ["f-seed"], createdAt: "2026-11-24T00:00:00Z" },
  ];
  const dag = collectDag(facts, badIntents, [], []);
  const edge = link(dag, "f-seed", "i-bad", "anchors");
  assert.equal(edge?.verification, "proposed");
  assert.equal(edge?.abstentionReason, "timestamp_inversion");
});

test("缺时间戳的因果边诚实弃证，不编造 proven", () => {
  const noTime: DagFact[] = [{ id: "f-nt", layer: "summary", title: "无时间" }];
  const ntIntents: DagIntent[] = [{ id: "i-nt", title: "引用无时间事实", status: "proposed", sourceFactIds: ["f-nt"], createdAt: "2026-11-24T01:30:00Z" }];
  const dag = collectDag(noTime, ntIntents, [], []);
  const edge = link(dag, "f-nt", "i-nt", "anchors");
  assert.equal(edge?.verification, "proposed");
  assert.equal(edge?.abstentionReason, "missing_timestamp");
});

test("origin 挂靠为结构边，不做因果校验", () => {
  const originIntents: DagIntent[] = [{ id: "i0", title: "起点意图", status: "proposed", sourceFactIds: ["origin"] }];
  const dag = collectDag([], originIntents, [], []);
  const edge = link(dag, "origin", "i0", "anchors");
  assert.equal(edge?.structural, true);
  assert.equal(edge?.verification, undefined);
});

test("布局产出可渲染的路径与稳定边 ID", () => {
  const dag = collectDag(facts, intents, findings, assets);
  const geometry = buildDagLayout(dag, false, false);
  assert.ok(geometry.positions.length > 0);
  assert.ok(geometry.edges.every((e) => e.path.startsWith("M")));
  assert.ok(geometry.edges.every((e) => typeof e.id === "string" && e.id.length > 0));
});
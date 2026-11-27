import test from "node:test";
import assert from "node:assert/strict";
import { computeMiniMapMetrics, layoutThumbScene, toggleSelectedNode } from "../graphLayout.js";
import type { GView } from "../../workspace/model.js";
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

test("无显式 intentId/factIds 的漏洞兜底连到所属资产，不沦为孤立节点", () => {
  const looseFinding: DagFinding = {
    id: "v-loose",
    title: "Gradio 文件读取",
    asset: "app.example",
    vulnClass: "CWE-22",
    severity: "critical",
    status: "verified",
    intentId: null,
    factIds: [],
    createdAt: "2026-11-24T02:30:00Z",
  };
  const dag = collectDag(facts, intents, [looseFinding], assets);
  assert.equal(dag.orphanIds.has("v-loose"), false);
  assert.equal(link(dag, assetNodeId("app.example"), "v-loose", "affects")?.structural, true);
});

test("系统生命周期 Fact（如「执行节点已启动」）不作为孤立节点出现，无论是否传 serverDag", () => {
  const lifecycleFacts: DagFact[] = [
    ...facts.filter((f) => f.id !== "f-orphan"),
    { id: "f-boot-legacy", layer: "title", title: "执行节点已启动", createdAt: "2026-11-24T00:59:00Z" },
    { id: "f-boot-tagged", layer: "title", title: "节点初始化", tags: ["system", "lifecycle"], createdAt: "2026-11-24T00:59:30Z" },
    { id: "f-scope", layer: "summary", title: "授权范围更新至 v2", tags: ["scope", "scopeVersion:2"], createdAt: "2026-11-24T01:10:00Z" },
    { id: "f-skill-linked", layer: "summary", title: "加载 Skill web-sqli", tags: ["system", "skill"], intentId: "i1", createdAt: "2026-11-24T01:40:00Z" },
  ];
  const clientDag = collectDag(lifecycleFacts, intents, findings, assets);
  assert.equal(clientDag.records.has("f-boot-legacy"), false);
  assert.equal(clientDag.records.has("f-boot-tagged"), false);
  assert.equal(clientDag.records.has("f-scope"), false);
  assert.equal(clientDag.records.has("f-skill-linked"), true);
  assert.equal(clientDag.orphanIds.size, 0);

  const serverEdges = [
    { id: "e1", from: "asset:app.example", to: "fact:f-seed", kind: "asserted-by" },
    { id: "e2", from: "fact:f-seed", to: "intent:i1", kind: "anchors", verification: "proven" as const },
    { id: "e3", from: "intent:i1", to: "fact:f1", kind: "produces", verification: "proven" as const },
    { id: "e4", from: "intent:i1", to: "fact:f-skill-linked", kind: "produces", verification: "proven" as const },
    { id: "e5", from: "fact:f1", to: "finding:v1", kind: "evidences", verification: "proven" as const },
    { id: "e6", from: "intent:i1", to: "finding:v1", kind: "yields", verification: "proven" as const },
  ];
  const withServer = collectDag(lifecycleFacts, intents, findings, assets, { edges: serverEdges });
  assert.equal(withServer.records.has("f-boot-legacy"), false);
  assert.equal(withServer.orphanIds.size, 0);
});

test("同一资产升级后的旧资产 Fact 也连回资产节点，不沦为孤立节点", () => {
  const upgradedFacts: DagFact[] = [
    { id: "f-seed-old", layer: "title", title: "资产 · seed · app.example", tags: ["asset", "asset.kind:seed", "asset.addr:app.example"], createdAt: "2026-11-24T00:50:00Z" },
    { id: "f-live-new", layer: "title", title: "资产 · live · app.example", tags: ["asset", "asset.kind:live", "asset.addr:app.example"], createdAt: "2026-11-24T01:00:00Z" },
  ];
  const upgradedAssets: DagAsset[] = [{ address: "app.example", kind: "live", factId: "f-live-new" }];
  const dag = collectDag(upgradedFacts, [], [], upgradedAssets);
  assert.equal(dag.orphanIds.size, 0);
  assert.equal(link(dag, assetNodeId("app.example"), "f-seed-old", "asserted-by")?.structural, true);
  assert.equal(link(dag, assetNodeId("app.example"), "f-live-new", "asserted-by")?.structural, true);
});

test("未启动委托简报过滤、已启动简报挂资产、子端点挂父主机且不残留孤立节点", () => {
  const hostAssets: DagAsset[] = [
    { address: "10.0.160.128", kind: "live", assetType: "ip", factId: "f-host", createdAt: "2026-11-24T01:00:00Z" },
    {
      address: "10.0.160.128/secret-data/flag.txt",
      kind: "live",
      assetType: "endpoint",
      parentAddress: "10.0.160.128",
      factId: "f-ep",
      intentId: "i-s3",
      createdAt: "2026-11-24T02:00:00Z",
    },
  ];
  const briefFacts: DagFact[] = [
    { id: "f-host", layer: "title", title: "资产 · live · 10.0.160.128", tags: ["asset", "asset.addr:10.0.160.128"], createdAt: "2026-11-24T01:00:00Z" },
    { id: "f-brief-live", layer: "title", title: "委托简报 [d-01]", tags: ["scope-brief", "asset.addr:10.0.160.128"], createdAt: "2026-11-24T01:00:01Z" },
    { id: "f-brief-idle", layer: "title", title: "委托简报 [e1-04]", tags: ["scope-brief", "challenge:e1-04"], createdAt: "2026-11-24T01:00:02Z" },
    { id: "f-ep", layer: "title", title: "资产 · live · endpoint", tags: ["asset", "asset.addr:10.0.160.128/secret-data/flag.txt", "asset.parent:10.0.160.128"], intentId: "i-s3", createdAt: "2026-11-24T02:00:00Z" },
  ];
  const s3Intents: DagIntent[] = [
    { id: "i-s3", title: "S3 枚举", status: "succeeded", sourceFactIds: ["origin"], assetRoot: "10.0.160.128:9000", createdAt: "2026-11-24T01:30:00Z" },
  ];
  const dag = collectDag(briefFacts, s3Intents, [], hostAssets);
  assert.equal(dag.records.has("f-brief-idle"), false);
  assert.equal(dag.records.has("origin"), false);
  assert.equal(dag.orphanIds.size, 0);
  assert.equal(link(dag, assetNodeId("10.0.160.128"), "f-brief-live", "asserted-by")?.structural, true);
  assert.equal(link(dag, assetNodeId("10.0.160.128"), assetNodeId("10.0.160.128/secret-data/flag.txt"), "contains")?.structural, true);
  assert.equal(link(dag, "f-host", "i-s3", "anchors")?.verification, "proven");
});

test("节点记录完整保留原始数据与平滑曲线坐标，供右侧详情抽屉展示与复制", () => {
  const richIntents: DagIntent[] = [
    {
      id: "i-rich",
      title: "审计文件传输面",
      status: "running",
      summary: "先核对归属再做匿名目录检查",
      sourceFactIds: ["f-seed"],
      assetRoot: "app.example",
      technique: "CWE-287",
      claimedBy: "w1",
      createdAt: "2026-11-24T01:30:00Z",
      updatedAt: "2026-11-24T01:35:00Z",
      conclusion: "已完成被动核查",
    },
  ];
  const dag = collectDag(facts, richIntents, findings, assets);
  const intentRecord = dag.records.get("i-rich");
  assert.ok(intentRecord);
  assert.equal(intentRecord.conclusion, "已完成被动核查");
  assert.equal(intentRecord.data?.claimedBy, "w1");
  assert.equal(intentRecord.raw?.id, "i-rich");
  assert.equal(intentRecord.raw?.summary, "先核对归属再做匿名目录检查");

  const findingRecord = dag.records.get("v1");
  assert.equal(findingRecord?.raw?.vulnClass, "CWE-89");

  const geometry = buildDagLayout(dag, false, false);
  assert.ok(geometry.positions.every((p) => Number.isInteger(p.position.x) && Number.isInteger(p.position.y)));
  assert.ok(geometry.edges.every((e) => e.path.includes("C") || e.path.includes("Q")));
});

test("缩略图紧凑拓扑在多叶子节点下自动折列保持横向宽高比，且节点点击选择不回跳取消", () => {
  assert.equal(toggleSelectedNode(null, "i1"), "i1");
  assert.equal(toggleSelectedNode("i1", "f1"), "f1");
  assert.equal(toggleSelectedNode("f1", "f1"), null);

  const leafNodes = Array.from({ length: 8 }, (_, idx) => ({
    id: `intent:i-${idx}`,
    kind: "intent",
    label: `检查目录遍历 ${idx}`,
    badge: "running",
    data: { intentId: `i-${idx}` },
  }));
  const sampleGraph: GView = {
    taskId: "t1",
    view: "assets",
    empty: false,
    notes: [],
    nodes: [
      { id: "asset:app.example", kind: "asset", label: "app.example", badge: "live", data: {} },
      ...leafNodes,
    ],
    edges: leafNodes.map((n) => ({
      id: `asset->${n.id}`,
      from: "asset:app.example",
      to: n.id,
      kind: "discovered",
      label: "发现",
      broken: false,
    })),
  };
  const thumb = layoutThumbScene(sampleGraph);
  assert.equal(thumb.nodes.length, 9);
  assert.ok(thumb.lines.every((l) => l.d.includes("C")));
  assert.ok(thumb.vbW > thumb.vbH, `缩略图应保持横向宽高比避免在窄卡片中缩成竖条（当前 ${thumb.vbW}x${thumb.vbH}）`);
});

test("攻击面缩略图跨类型均衡抽样资产/检查项/漏洞并连线，且大图缩略导航保证最小色块可见尺寸", () => {
  const manyAssets: GView["nodes"] = Array.from({ length: 20 }, (_, idx) => ({
    id: `asset:10.0.160.${idx + 1}`,
    kind: "asset",
    label: `10.0.160.${idx + 1}`,
    badge: "live",
    data: {},
  }));
  const manyTechs: GView["nodes"] = Array.from({ length: 12 }, (_, idx) => ({
    id: `technique:CWE-${80 + idx}`,
    kind: "technique",
    label: `CWE-${80 + idx}`,
    badge: null,
    data: {},
  }));
  const manyFindings: GView["nodes"] = Array.from({ length: 10 }, (_, idx) => ({
    id: `finding:f-${idx}`,
    kind: "finding",
    label: `漏洞 ${idx}`,
    badge: "high:verified",
    data: {},
  }));
  const surfaceGraph: GView = {
    taskId: "t-surface",
    view: "surface",
    empty: false,
    notes: [],
    nodes: [...manyAssets, ...manyTechs, ...manyFindings],
    edges: [
      ...manyAssets.map((a, idx) => ({
        id: `cov-${idx}`,
        from: a.id,
        to: manyTechs[idx % manyTechs.length]!.id,
        kind: "coverage",
        label: "verified",
        broken: false,
      })),
      ...manyFindings.map((f, idx) => ({
        id: `found-${idx}`,
        from: manyAssets[idx]!.id,
        to: f.id,
        kind: "found-on",
        label: "verified",
        broken: false,
      })),
    ],
  };

  const thumb = layoutThumbScene(surfaceGraph);
  const pickedKinds = new Set(thumb.nodes.map((n) => n.kind));
  assert.ok(pickedKinds.size >= 2, "攻击面缩略图不应只截取前 12 个同类型资产节点");
  assert.ok(thumb.lines.length > 0, "攻击面缩略图应保留跨层连线而非单节点孤岛");
  assert.ok(thumb.vbW > thumb.vbH);

  const metrics = computeMiniMapMetrics(
    { maxX: 2400, maxY: 4200 },
    { x: -600, y: -300, k: 2.4 },
    { width: 640, height: 420 },
    { width: 162, height: 98 },
    { width: 208, height: 62 },
  );
  assert.ok(metrics.nodeW * metrics.scale >= 6.5, "大图缩小后节点色块宽度至少约 7px，避免在缩略图中消失变白");
  assert.ok(metrics.nodeH * metrics.scale >= 3.2, "大图缩小后节点色块高度至少约 3.5px，避免在缩略图中消失变白");
});

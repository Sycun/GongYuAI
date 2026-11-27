import assert from "node:assert/strict";
import test from "node:test";
import type { AssetRecord, Finding } from "@gongyuai/contracts";
import { buildAssetGraph, buildSurfaceGraph } from "./graphs.js";

test("buildSurfaceGraph and buildAssetGraph keep endpoint asset IDs distinct and avoid multiplying host coverage cells", () => {
  const assets: AssetRecord[] = [
    {
      address: "10.0.0.0/8",
      kind: "seed",
      assetType: "ip",
      parentAddress: null,
      weight: 1,
      title: "10.0.0.0/8",
      summary: "seed cidr",
      factId: "f-seed",
      intentId: null,
      source: "auth",
      createdAt: "2026-11-27T00:00:00.000Z",
    },
    {
      address: "10.0.160.128",
      kind: "live",
      assetType: "ip",
      parentAddress: null,
      weight: 1,
      title: "10.0.160.128",
      summary: "host",
      factId: "f-host",
      intentId: null,
      source: "discover",
      createdAt: "2026-11-27T00:01:00.000Z",
    },
    {
      address: "10.0.160.128/admin",
      kind: "live",
      assetType: "endpoint",
      parentAddress: "10.0.160.128",
      weight: 1,
      title: "/admin",
      summary: "admin endpoint",
      factId: "f-ep1",
      intentId: null,
      source: "discover",
      createdAt: "2026-11-27T00:02:00.000Z",
    },
    {
      address: "10.0.160.128/login.php",
      kind: "live",
      assetType: "endpoint",
      parentAddress: "10.0.160.128",
      weight: 1,
      title: "/login.php",
      summary: "login endpoint",
      factId: "f-ep2",
      intentId: null,
      source: "discover",
      createdAt: "2026-11-27T00:03:00.000Z",
    },
  ];

  const finding: Finding = {
    id: "00000000-0000-4000-8000-000000000001",
    taskId: "00000000-0000-4000-8000-000000000002",
    title: "Admin SQLi",
    asset: "10.0.160.128",
    vulnClass: "CWE-89",
    severity: "high",
    cvss: null,
    confidence: "firm",
    status: "verified",
    endpoint: "10.0.160.128/admin",
    dedupKey: "10.0.160.128|CWE-89|10.0.160.128/admin",
    intentId: null,
    factIds: [],
    evidence: [{ path: "http/1.txt", sha256: "a".repeat(64), note: "200 OK" }],
    repro: "curl",
    impact: "db read",
    fix: "parameterize",
    createdAt: "2026-11-27T00:05:00.000Z",
    verifiedAt: "2026-11-27T00:06:00.000Z",
    verifiedBy: "worker-1",
  };

  const surface = buildSurfaceGraph({
    taskId: finding.taskId,
    engagementId: "eng-1",
    generatedAt: "2026-11-27T00:10:00.000Z",
    assets,
    facts: [],
    findings: [finding],
    intents: [],
    materials: [],
    manual: [],
    retractedEvidence: [],
  });

  const assetNodes = surface.nodes.filter((n) => n.kind === "asset");
  assert.equal(assetNodes.length, 4);
  assert.equal(new Set(assetNodes.map((n) => n.id)).size, 4, "主机与子路径端点应拥有独立的图节点 ID");
  assert.equal(new Set(surface.edges.map((e) => e.id)).size, surface.edges.length, "覆盖边 ID 不应重复堆叠");
  assert.match(surface.notes[0] ?? "", /覆盖单元 3 个/, "2 个主机资产 + 1 个命中漏洞的端点 = 3 个覆盖单元，而非 4×1 重复膨胀");

  const assetGraph = buildAssetGraph({
    taskId: finding.taskId,
    engagementId: "eng-1",
    generatedAt: "2026-11-27T00:10:00.000Z",
    targets: ["10.0.0.0/8"],
    outOfScope: [],
    assets,
    facts: [],
    intents: [],
  });
  const assetGraphIds = assetGraph.nodes.filter((n) => n.kind === "asset").map((n) => n.id);
  assert.equal(new Set(assetGraphIds).size, 4);
});

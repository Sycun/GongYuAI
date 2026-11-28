import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import type { WorkerManifest } from "@gongyuai/contracts";
import { openHistory } from "@gongyuai/history";
import { extractFingerprints, isBenchmarkContaminatedHit, openFingerprintKnowledgeRag } from "./knowledge-rag.js";
import { matchesTrigger } from "./skills/runtime.js";

function createTestKnowledgeDb(dbPath: string): void {
  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE materials (
      id TEXT PRIMARY KEY,
      scope_key TEXT NOT NULL,
      scope_json TEXT NOT NULL,
      source_key TEXT NOT NULL,
      title TEXT NOT NULL,
      publisher TEXT NOT NULL,
      source_kind TEXT NOT NULL,
      source_url TEXT,
      note TEXT,
      tags_json TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      current_version_id TEXT NOT NULL
    );
    CREATE TABLE material_versions (
      id TEXT PRIMARY KEY,
      material_id TEXT NOT NULL,
      version_no INTEGER NOT NULL,
      content_sha256 TEXT NOT NULL,
      byte_size INTEGER NOT NULL,
      imported_at TEXT NOT NULL,
      format TEXT NOT NULL,
      body_status TEXT NOT NULL,
      body_status_reason TEXT,
      upstream_version TEXT,
      upstream_commit TEXT,
      status TEXT NOT NULL DEFAULT 'active',
      deprecated_at TEXT,
      deprecated_reason TEXT,
      snapshot_path TEXT NOT NULL
    );
    CREATE TABLE material_sections (
      version_id TEXT NOT NULL,
      ordinal INTEGER NOT NULL,
      locator TEXT NOT NULL,
      heading TEXT,
      page INTEGER,
      text TEXT NOT NULL,
      char_start INTEGER NOT NULL,
      char_end INTEGER NOT NULL,
      heading_path_json TEXT NOT NULL DEFAULT '[]',
      parent_locator TEXT NOT NULL DEFAULT '',
      chunk_sha256 TEXT NOT NULL DEFAULT '',
      page_basis TEXT,
      PRIMARY KEY (version_id, ordinal)
    );
  `);
  db.prepare(`
    INSERT INTO materials VALUES (
      'mat-1', 'shared', '{"kind":"shared"}', 'geoserver-guide',
      'GeoServer 2.23.2 JXPath RCE Guide', 'internal', 'internal',
      NULL, NULL, '["geoserver"]', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z', 'ver-1'
    )
  `).run();
  db.prepare(`
    INSERT INTO material_versions VALUES (
      'ver-1', 'mat-1', 1, 'abc123', 120, '2026-01-01T00:00:00Z',
      'md', 'ready', NULL, '2.23.2', NULL, 'active', NULL, NULL, '/tmp/snap'
    )
  `).run();
  db.prepare(`
    INSERT INTO material_sections VALUES (
      'ver-1', 0, 'sec-1', 'CVE-2024-36401 valueReference', NULL,
      'GeoServer 2.23.2 evaluates XPath expressions via Commons JXPath in WFS GetPropertyValue valueReference.',
      0, 102, '["GeoServer"]', '', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', NULL
    )
  `).run();
  db.close();
}

function makeManifest(root: string): WorkerManifest {
  return {
    taskId: "22222222-2222-4222-8222-222222222222",
    engagementId: "eng-rag-test",
    dataDir: join(root, "tasks", "22222222-2222-4222-8222-222222222222"),
    historyDb: join(root, "tasks", "22222222-2222-4222-8222-222222222222", "history.sqlite"),
    durableDb: join(root, "tasks", "22222222-2222-4222-8222-222222222222", "durable.sqlite"),
    evidenceDir: join(root, "tasks", "22222222-2222-4222-8222-222222222222", "evidence"),
    workspaceDir: join(root, "tasks", "22222222-2222-4222-8222-222222222222", "workspace"),
    auth: { authorizationNote: "lab test", targets: ["127.0.0.1"], outOfScope: [], capability: "full" },
    scopeVersion: 1,
    goals: [],
    budget: { maxTokens: 0, maxWallMs: 0, maxToolCalls: 0, maxInstalls: 0, relayTokenThreshold: 30_000, relayMinToolCalls: 2 },
    execution: { maxConcurrentExplores: 1, maxIntentsPerReason: 4, maxIntentsPerAssetRoot: 2, exploreTimeoutMs: 900_000, reasonLeaseMs: 120_000 },
    workerId: "w0",
    workerSlot: 0,
    workerCount: 1,
    commandConfirmation: "auto",
    mock: true,
    mcpServers: [],
    mcpPool: [],
    mcpCatalog: [],
    skillPacks: [],
    skillPool: [],
    skillCatalog: [],
    assetCollectors: [],
  };
}

test("extractFingerprints extracts product+version and CVE while skipping generic tokens", () => {
  const fps = extractFingerprints([
    { title: "HTTP 1.1 response from GeoServer 2.23.2", summary: "Possible CVE-2024-36401 on Apache/2.4.49; exit 0, port 8080" },
  ]);
  const keys = fps.map((f) => f.key);
  assert.ok(keys.includes("cve-2024-36401"));
  assert.ok(keys.includes("geoserver@2.23.2"));
  assert.ok(keys.includes("apache@2.4.49"));
  assert.ok(!keys.some((k) => k.startsWith("http@")));
});

test("openFingerprintKnowledgeRag queries local knowledge.sqlite, deduplicates, and records material_citations", () => {
  const root = mkdtempSync(join(tmpdir(), "gy-rag-"));
  try {
    const manifest = makeManifest(root);
    mkdirSync(manifest.workspaceDir, { recursive: true });
    mkdirSync(manifest.evidenceDir, { recursive: true });
    createTestKnowledgeDb(join(root, "knowledge.sqlite"));
    const history = openHistory({ dbPath: manifest.historyDb, evidenceDir: manifest.evidenceDir });
    try {
      const rag = openFingerprintKnowledgeRag(manifest, history);
      const facts = [{ title: "Detected GeoServer 2.23.2 on 10.0.0.1:8080" }];
      const first = rag.autoInjectForFacts(facts);
      assert.match(first, /GeoServer 2\.23\.2/);
      assert.match(first, /JXPath/);
      // Second call for same fingerprint must be deduplicated.
      const second = rag.autoInjectForFacts(facts);
      assert.equal(second, "");
      const citations = history.listMaterialCitations(manifest.taskId);
      assert.equal(citations.length, 1);
      assert.equal(citations[0]!.materialId, "mat-1");
    } finally {
      history.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("matchesTrigger enforces word boundaries for ASCII triggers and keeps CJK substring matching", () => {
  assert.equal(matchesTrigger("admin login page with upload and csrf", "ad"), false);
  assert.equal(matchesTrigger("ssrf and csrf protection check", "rf"), false);
  assert.equal(matchesTrigger("main domain plain text chain", "ai"), false);
  assert.equal(matchesTrigger("found active directory kerberos ticket", "kerberos"), true);
  assert.equal(matchesTrigger("存在越权读取漏洞", "越权"), true);
});

test("isBenchmarkContaminatedHit filters benchmark scorecards and hint logs while keeping real CVE guides", () => {
  assert.equal(
    isBenchmarkContaminatedHit({
      materialTitle: "upstream-sapperlens.md",
      locator: "docs/evidence/knowledge-library/upstream-sapperlens.md:1057",
      heading: "Baseline Run",
      text: "f2-05 1/1 解出（VM 障眼法 + bytecode recipe，用了 1 条提示）",
    }),
    true,
  );
  assert.equal(
    isBenchmarkContaminatedHit({
      materialTitle: "GeoServer 2.23.2 JXPath RCE Guide",
      locator: "sec-1",
      heading: "CVE-2024-36401 valueReference",
      text: "GeoServer 2.23.2 evaluates XPath expressions via Commons JXPath in WFS GetPropertyValue.",
    }),
    false,
  );
});

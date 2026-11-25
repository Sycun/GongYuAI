/**
 * Fingerprint-driven read-only local knowledge RAG.
 *
 * When Facts mention a concrete product+version or CVE (e.g. "GeoServer 2.23.2",
 * "HugeGraph 1.2.0", "CVE-2024-36401"), query the workspace `knowledge.sqlite`
 * once per fingerprint per session, return 1-2 compact excerpts (bounded chars),
 * and best-effort record `material_citations` in task history.
 */
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { WorkerManifest } from "@gongyuai/contracts";
import type { HistoryStore } from "@gongyuai/history";
import { appendProgress } from "./tools.js";

export type FingerprintQuery = {
  /** Normalized dedup key (lowercased). */
  key: string;
  /** Primary product/CVE token. */
  product: string;
  /** Optional version string. */
  version: string | null;
  /** Human-readable label. */
  label: string;
};

export type KnowledgeRagHub = {
  autoInjectForFacts(
    facts: ReadonlyArray<{ title: string; summary?: string; tags?: readonly string[] }>,
    opts?: { maxChars?: number; maxHits?: number },
  ): string;
};

const STOP_PRODUCTS = new Set([
  "http", "https", "html", "json", "xml", "yaml", "utf", "ascii", "base64",
  "port", "ports", "host", "hosts", "step", "steps", "exit", "code", "status",
  "token", "tokens", "version", "timeout", "error", "errors", "line", "lines",
  "file", "files", "byte", "bytes", "round", "relay", "phase", "intent", "fact",
  "finding", "target", "asset", "ipv4", "ipv6", "tcp", "udp", "tls", "ssl",
  "python", "python3", "node", "bash", "curl", "wget", "linux", "ubuntu", "debian",
]);

/** Extract concrete `Product Version` and `CVE-YYYY-NNNN` fingerprints from recent facts. */
export function extractFingerprints(
  facts: ReadonlyArray<{ title: string; summary?: string; tags?: readonly string[] }>,
): FingerprintQuery[] {
  const out: FingerprintQuery[] = [];
  const seen = new Set<string>();
  const text = facts
    .slice(-25)
    .map((f) => `${f.title} ${f.summary ?? ""} ${(f.tags ?? []).join(" ")}`)
    .join("\n");

  const cveRe = /\b(CVE-\d{4}-\d{4,7})\b/gi;
  for (const m of text.matchAll(cveRe)) {
    const cve = m[1]!.toUpperCase();
    const key = cve.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ key, product: cve, version: null, label: cve });
  }

  // Matches e.g. "GeoServer 2.23.2", "Apache/2.4.49", "HugeGraph v1.2.0", "ComfyUI 0.9.2"
  const prodVerRe = /\b([A-Za-z][A-Za-z0-9._-]{2,28})[\s/]+v?(\d+\.\d+(?:\.\d+){0,2})\b/g;
  for (const m of text.matchAll(prodVerRe)) {
    const product = m[1]!;
    const version = m[2]!;
    const prodLower = product.toLowerCase();
    if (STOP_PRODUCTS.has(prodLower)) continue;
    if (/^\d/.test(prodLower)) continue;
    const key = `${prodLower}@${version}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ key, product, version, label: `${product} ${version}` });
  }

  return out;
}

export function resolveKnowledgeDbPath(manifest: Pick<WorkerManifest, "dataDir">, explicitPath?: string): string | null {
  if (explicitPath) return existsSync(explicitPath) ? explicitPath : null;
  const fromEnv = process.env.GY_KNOWLEDGE_DB?.trim();
  if (fromEnv && existsSync(fromEnv)) return fromEnv;
  // Standard layout: <dataRoot>/tasks/<taskId> -> <dataRoot>/knowledge.sqlite
  const candidates = [
    resolve(manifest.dataDir, "..", "..", "knowledge.sqlite"),
    resolve(manifest.dataDir, "..", "knowledge.sqlite"),
    join(manifest.dataDir, "knowledge.sqlite"),
  ];
  for (const p of candidates) {
    if (existsSync(p)) return p;
  }
  return null;
}

type KnowledgeSectionHit = {
  materialId: string;
  versionId: string;
  materialTitle: string;
  publisher: string;
  sourceKind: string;
  versionNo: number;
  upstreamVersion: string | null;
  format: string;
  locator: string;
  heading: string | null;
  page: number | null;
  ordinal: number;
  text: string;
  charStart: number;
  charEnd: number;
  chunkSha256: string;
  headingPathJson: string;
  pageBasis: string | null;
};

function queryKnowledgeDb(
  dbPath: string,
  fp: FingerprintQuery,
  engagementId: string | null,
  limit: number,
): KnowledgeSectionHit[] {
  let db: DatabaseSync | null = null;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
    db.exec("PRAGMA busy_timeout = 300");
    const prodLike = `%${fp.product.toLowerCase()}%`;
    const verLike = fp.version ? `%${fp.version.toLowerCase()}%` : null;
    const scopeClause = engagementId
      ? `(m.scope_key = 'shared' OR m.scope_key = ?)`
      : `m.scope_key = 'shared'`;
    const baseSelect = `
      SELECT
        m.id AS materialId,
        v.id AS versionId,
        m.title AS materialTitle,
        m.publisher AS publisher,
        m.source_kind AS sourceKind,
        v.version_no AS versionNo,
        v.upstream_version AS upstreamVersion,
        v.format AS format,
        s.locator AS locator,
        s.heading AS heading,
        s.page AS page,
        s.ordinal AS ordinal,
        s.text AS text,
        s.char_start AS charStart,
        s.char_end AS charEnd,
        s.chunk_sha256 AS chunkSha256,
        s.heading_path_json AS headingPathJson,
        s.page_basis AS pageBasis
      FROM material_sections s
      JOIN material_versions v ON v.id = s.version_id
      JOIN materials m ON m.id = v.material_id
      WHERE v.status = 'active'
        AND v.body_status = 'ready'
        AND ${scopeClause}
    `;

    // Prefer exact product + version hits first.
    if (verLike) {
      const exactSql = `${baseSelect}
        AND (lower(m.title) LIKE ? OR lower(COALESCE(s.heading, '')) LIKE ? OR lower(s.text) LIKE ?)
        AND (lower(m.title) LIKE ? OR lower(s.text) LIKE ?)
        LIMIT ?`;
      const params = engagementId
        ? [`engagement:${engagementId}`, prodLike, prodLike, prodLike, verLike, verLike, limit]
        : [prodLike, prodLike, prodLike, verLike, verLike, limit];
      const exact = db.prepare(exactSql).all(...params) as KnowledgeSectionHit[];
      if (exact.length > 0) return exact;
    }

    // Fallback: match product name in material title or section heading (avoid noisy body-only matches).
    const titleSql = `${baseSelect}
      AND (lower(m.title) LIKE ? OR lower(COALESCE(s.heading, '')) LIKE ?)
      LIMIT ?`;
    const params = engagementId
      ? [`engagement:${engagementId}`, prodLike, prodLike, limit]
      : [prodLike, prodLike, limit];
    return db.prepare(titleSql).all(...params) as KnowledgeSectionHit[];
  } catch {
    return [];
  } finally {
    try { db?.close(); } catch { /* ignore */ }
  }
}

function recordCitationBestEffort(
  manifest: WorkerManifest,
  history: HistoryStore,
  fp: FingerprintQuery,
  hit: KnowledgeSectionHit,
): void {
  const engagementId = manifest.engagementId?.trim() || manifest.taskId;
  try {
    let headingPath: string[] = [];
    try {
      const parsed = JSON.parse(hit.headingPathJson || "[]");
      if (Array.isArray(parsed)) headingPath = parsed.map(String);
    } catch {
      headingPath = [];
    }
    const bodyFormat = (hit.format === "markdown" || hit.format === "md"
      ? "markdown"
      : hit.format === "pdf"
        ? "pdf"
        : "text") as "text" | "pdf" | "markdown";
    const sourceKind = (hit.sourceKind === "excerpt" || hit.sourceKind === "original" || hit.sourceKind === "editorial"
      ? hit.sourceKind
      : "original") as "excerpt" | "original" | "editorial";
    const pageBasis = hit.pageBasis === "physical-page" || hit.pageBasis === "legacy-paragraph" ? hit.pageBasis : null;
    const validChunkSha = /^[a-f0-9]{64}$/.test(hit.chunkSha256) ? hit.chunkSha256 : undefined;
    history.recordMaterialCitation(
      manifest.taskId,
      engagementId,
      {
        materialId: hit.materialId,
        versionId: hit.versionId,
        locator: hit.locator,
        claim: `Fingerprint auto-RAG (${fp.label})`,
        ...(hit.charEnd > hit.charStart ? { charStart: hit.charStart, charEnd: hit.charEnd } : {}),
        ...(validChunkSha ? { chunkSha256: validChunkSha } : {}),
      },
      {
        snapshot: Buffer.from(hit.text, "utf8"),
        bodyFormat,
        materialTitle: hit.materialTitle,
        publisher: hit.publisher,
        sourceKind,
        versionNo: hit.versionNo,
        versionLabel: hit.upstreamVersion ?? `v${hit.versionNo}`,
        sectionHeading: hit.heading,
        sectionPage: hit.page,
        sectionOrdinal: hit.ordinal,
        sectionMeta: {
          ordinal: hit.ordinal,
          locator: hit.locator,
          heading: hit.heading,
          page: hit.page,
          charStart: hit.charStart,
          charEnd: hit.charEnd,
          headingPath,
          parentLocator: "",
          chunkSha256: hit.chunkSha256 || "",
          chunkIndex: 0,
          chunkCount: 1,
          lineStart: 1,
          lineEnd: 1,
          pageBasis,
        },
      },
    );
  } catch {
    /* citation recording is advisory and must never break execution */
  }
}

export function openFingerprintKnowledgeRag(
  manifest: WorkerManifest,
  history: HistoryStore,
  opts?: { knowledgeDbPath?: string },
): KnowledgeRagHub {
  const queried = new Set<string>();
  const citedKeys = new Set<string>();

  return {
    autoInjectForFacts(facts, callOpts) {
      if (!facts.length) return "";
      const dbPath = resolveKnowledgeDbPath(manifest, opts?.knowledgeDbPath);
      if (!dbPath) return "";

      const maxChars = Math.max(400, Math.min(callOpts?.maxChars ?? 2200, 4000));
      const maxHits = Math.max(1, Math.min(callOpts?.maxHits ?? 2, 3));
      const fps = extractFingerprints(facts).filter((fp) => !queried.has(fp.key));
      if (!fps.length) return "";

      const engagementId = manifest.engagementId?.trim() || null;
      const sections: string[] = [];
      let used = 0;

      for (const fp of fps) {
        queried.add(fp.key);
        if (sections.length >= maxHits || maxChars - used < 220) continue;
        const hits = queryKnowledgeDb(dbPath, fp, engagementId, maxHits - sections.length);
        for (const hit of hits) {
          if (sections.length >= maxHits) break;
          const citeKey = `${hit.versionId}:${hit.locator}`;
          if (citedKeys.has(citeKey)) continue;
          const remaining = maxChars - used;
          if (remaining < 200) break;
          const cap = Math.min(900, remaining - 80);
          const excerpt = hit.text.trim().length > cap
            ? `${hit.text.trim().slice(0, cap)}…`
            : hit.text.trim();
          const headingPart = hit.heading ? ` · ${hit.heading}` : "";
          const block = `### 知识库命中（${fp.label}）：${hit.materialTitle}${headingPart} [${hit.locator}]\n${excerpt}`;
          sections.push(block);
          used += block.length;
          citedKeys.add(citeKey);
          recordCitationBestEffort(manifest, history, fp, hit);
          appendProgress(
            manifest.workspaceDir,
            `auto_rag ${fp.label} → ${hit.materialTitle} (${hit.locator}, chars=${excerpt.length})`,
          );
        }
      }

      if (!sections.length) return "";
      return `## 本地知识库指纹参考（自动去重推送 · ≤${maxChars} chars）\n${sections.join("\n\n")}`;
    },
  };
}

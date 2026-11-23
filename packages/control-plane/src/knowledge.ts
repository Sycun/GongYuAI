import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  KnowledgeImportSchema,
  KnowledgePreviewSchema,
  knowledgeScopeKey,
  type KnowledgeEmbeddingProvider,
  type KnowledgeEmbeddingSettings,
  type KnowledgeImportInput,
  type KnowledgeImportResult,
  type KnowledgeIndexStatus,
  type KnowledgeMatchField,
  type KnowledgeMaterial,
  type KnowledgePreview,
  type KnowledgePreviewInput,
  type KnowledgeReaderScope,
  type KnowledgeRetrieval,
  type KnowledgeScope,
  type KnowledgeSearchHit,
  type KnowledgeSearchMode,
  type KnowledgeSearchResult,
  type KnowledgeSection,
  type KnowledgeSectionContext,
  type KnowledgeSummary,
  type KnowledgeVersion,
} from "@gongyuai/contracts";
import {
  CHUNKER_VERSION,
  EXTRACTION_VERSION,
  deriveSourceKey,
  extractKnowledgeBody,
  findSection,
  parentRangeOf,
  sectionsFromSnapshot,
} from "./knowledge-parse.js";
import { EmbeddingUnavailable, dot, resolveEmbeddingRuntime } from "./knowledge-embed.js";
import { KnowledgeIndexPool, type IndexRuntimes } from "./knowledge-index-pool.js";

export function sha256Hex(bytes: Buffer | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** 共享资料对任何读者可见；委托专属资料只对该委托的读者可见。 */
export function materialVisible(material: Pick<KnowledgeMaterial, "scope">, scope: KnowledgeReaderScope): boolean {
  if (material.scope.kind === "shared") return true;
  return scope.engagementId !== null && material.scope.engagementId === scope.engagementId;
}

/**
 * 语义召回门槛。绝对下限挡住完全无关的片段；相对边界保证跨语言召回不被误杀——
 * 中英跨语言配对的余弦普遍低于同语言，只用一个高绝对阈值会整份英文资料都召不回来。
 */
const SEMANTIC_MIN_COSINE = 0.35;
const SEMANTIC_RELATIVE_MARGIN = 0.2;
/** 每份资料最多贡献几条语义候选：既防止长文档垄断召回，也不至于把本文档内的目标片段挤掉。 */
const SEMANTIC_PER_VERSION_CAP = 5;
const SEMANTIC_CANDIDATE_FLOOR = 30;
/** 融合权重：正文字面命中权重最高，元数据（标题/标签）命中显著折价。 */
const SEMANTIC_WEIGHT = 0.8;
const TITLE_ONLY_SCORE = 0.3;
const TAG_ONLY_SCORE = 0.22;

type MaterialRow = {
  id: string;
  scope_key: string;
  scope_json: string;
  source_key: string;
  title: string;
  publisher: string;
  source_kind: KnowledgeMaterial["sourceKind"];
  source_url: string | null;
  note: string | null;
  tags_json: string;
  created_at: string;
  updated_at: string;
  current_version_id: string;
};

type VersionRow = {
  id: string;
  material_id: string;
  version_no: number;
  content_sha256: string;
  byte_size: number;
  imported_at: string;
  format: KnowledgeVersion["format"];
  body_status: KnowledgeVersion["bodyStatus"];
  body_status_reason: string | null;
  upstream_version: string | null;
  upstream_commit: string | null;
  status: KnowledgeVersion["status"];
  deprecated_at: string | null;
  deprecated_reason: string | null;
  snapshot_path: string;
  chunker_version: number;
  extraction_version: number;
};

type SectionRow = {
  ordinal: number;
  locator: string;
  heading: string | null;
  page: number | null;
  text: string;
  char_start: number;
  char_end: number;
  heading_path_json: string;
  parent_locator: string;
  chunk_sha256: string;
  chunk_index: number;
  chunk_count: number;
  line_start: number;
  line_end: number;
  page_basis: KnowledgeSection["pageBasis"];
};

const SECTION_COLUMNS = `ordinal, locator, heading, page, text, char_start, char_end,
  heading_path_json, parent_locator, chunk_sha256, chunk_index, chunk_count, line_start, line_end, page_basis`;

function toSection(row: SectionRow): KnowledgeSection {
  return {
    ordinal: row.ordinal,
    locator: row.locator,
    heading: row.heading,
    page: row.page,
    text: row.text,
    charStart: row.char_start,
    charEnd: row.char_end,
    headingPath: JSON.parse(row.heading_path_json) as string[],
    parentLocator: row.parent_locator,
    chunkSha256: row.chunk_sha256,
    chunkIndex: row.chunk_index,
    chunkCount: row.chunk_count,
    lineStart: row.line_start,
    lineEnd: row.line_end,
    pageBasis: row.page_basis,
  };
}

/**
 * 参考资料库（用户级 · data-root）。快照内容寻址存放，版本行只追加；
 * 任务事实与证据仍在各任务的 history.sqlite，这里不复制任务证据。
 *
 * 检索是关键词 + 向量混合。两路都先按读者可见范围筛版本，再召回、合并、计数。
 */
export class KnowledgeStore {
  readonly dataRoot: string;
  readonly snapshotDir: string;
  readonly index: KnowledgeIndexPool;
  private readonly db: DatabaseSync;
  private readonly embeddingSettings: () => KnowledgeEmbeddingSettings;

  constructor(dataRoot: string, opts: { embeddingSettings?: () => KnowledgeEmbeddingSettings } = {}) {
    this.dataRoot = dataRoot;
    this.snapshotDir = join(dataRoot, "knowledge", "snapshots");
    mkdirSync(this.snapshotDir, { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(join(dataRoot, "knowledge.sqlite"));
    this.db.exec("PRAGMA busy_timeout = 10000;");
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec("PRAGMA foreign_keys = ON;");
    this.migrate();
    this.embeddingSettings = opts.embeddingSettings ?? (() => ({
      enabled: false,
      provider: "local",
      local: { baseUrl: "", model: "", apiKeyEnv: "", apiKey: "", batchSize: 16, timeoutMs: 30_000 },
      cloud: { baseUrl: "", model: "", apiKeyEnv: "", apiKey: "", batchSize: 16, timeoutMs: 30_000 },
      cloudEngagements: [],
    }));
    this.index = new KnowledgeIndexPool(
      { db: this.db, sectionsOf: (versionId) => this.sectionsOf(versionId) },
      this.currentRuntimes(),
      CHUNKER_VERSION,
      (versionId) => this.providerForVersion(versionId),
    );
    this.rechunkStaleVersions();
  }

  close(): void {
    this.index.dispose();
    this.db.close();
  }

  private currentRuntimes(): IndexRuntimes {
    const settings = this.embeddingSettings();
    return {
      local: resolveEmbeddingRuntime(settings, "local"),
      cloud: resolveEmbeddingRuntime(settings, "cloud"),
    };
  }

  /** 设置变了就换客户端与索引指纹；旧向量留在盘上，不与新服务混用。 */
  refreshEmbeddingConfig(): void {
    this.index.refresh(this.currentRuntimes());
  }

  /**
   * 资料该由哪套服务索引：共享资料跟工作区选定的服务；
   * 委托专属资料一律本地，只有该委托在 cloudEngagements 里明确允许后才走云端。
   */
  private providerForMaterialScope(scope: KnowledgeScope): KnowledgeEmbeddingProvider {
    const settings = this.embeddingSettings();
    if (settings.provider !== "cloud") return "local";
    if (scope.kind === "shared") return "cloud";
    return settings.cloudEngagements.includes(scope.engagementId) ? "cloud" : "local";
  }

  private providerForVersion(versionId: string): KnowledgeEmbeddingProvider {
    const row = this.db.prepare(
      `SELECT m.scope_json AS scope_json FROM material_versions v
       JOIN materials m ON m.id = v.material_id WHERE v.id = ?`,
    ).get(versionId) as { scope_json: string } | undefined;
    if (!row) return "local";
    return this.providerForMaterialScope(JSON.parse(row.scope_json) as KnowledgeScope);
  }

  /**
   * 本次读者范围允许把正文与查询文本发给哪些服务。
   * 未声明委托的读者只看共享资料，按工作区选定服务；
   * 委托读者即使能看见云端索引的共享资料，未获允许时也不得把查询发往云端。
   */
  private allowedProviders(scope: KnowledgeReaderScope): Set<KnowledgeEmbeddingProvider> {
    const settings = this.embeddingSettings();
    const allowed = new Set<KnowledgeEmbeddingProvider>(["local"]);
    if (settings.provider === "cloud"
      && (scope.engagementId === null || settings.cloudEngagements.includes(scope.engagementId))) {
      allowed.add("cloud");
    }
    return allowed;
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS materials (
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
      -- 同一范围 + 同一来源只有一份资料；正文变化成为它的新版本。
      CREATE UNIQUE INDEX IF NOT EXISTS idx_materials_identity ON materials(scope_key, source_key);

      CREATE TABLE IF NOT EXISTS material_versions (
        id TEXT PRIMARY KEY,
        material_id TEXT NOT NULL REFERENCES materials(id),
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
      -- 重放与并发导入靠这两个唯一索引收敛，不靠应用层判重。
      CREATE UNIQUE INDEX IF NOT EXISTS idx_versions_content ON material_versions(material_id, content_sha256);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_versions_no ON material_versions(material_id, version_no);

      CREATE TABLE IF NOT EXISTS material_sections (
        version_id TEXT NOT NULL REFERENCES material_versions(id),
        ordinal INTEGER NOT NULL,
        locator TEXT NOT NULL,
        heading TEXT,
        page INTEGER,
        text TEXT NOT NULL,
        char_start INTEGER NOT NULL,
        char_end INTEGER NOT NULL,
        PRIMARY KEY (version_id, ordinal)
      );
      CREATE INDEX IF NOT EXISTS idx_sections_locator ON material_sections(version_id, locator);
    `);
    this.addColumns("material_versions", {
      chunker_version: "INTEGER NOT NULL DEFAULT 0",
      extraction_version: "INTEGER NOT NULL DEFAULT 0",
    });
    this.addColumns("material_sections", {
      heading_path_json: "TEXT NOT NULL DEFAULT '[]'",
      parent_locator: "TEXT NOT NULL DEFAULT ''",
      chunk_sha256: "TEXT NOT NULL DEFAULT ''",
      chunk_index: "INTEGER NOT NULL DEFAULT 0",
      chunk_count: "INTEGER NOT NULL DEFAULT 1",
      line_start: "INTEGER NOT NULL DEFAULT 1",
      line_end: "INTEGER NOT NULL DEFAULT 1",
      page_basis: "TEXT",
    });
  }

  private addColumns(table: string, columns: Record<string, string>): void {
    const have = new Set((this.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>)
      .map((row) => row.name));
    for (const [name, definition] of Object.entries(columns)) {
      if (!have.has(name)) this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`);
    }
  }

  /**
   * 切分算法升级后原地重切分：只替换片段行，不动版本号、内容 SHA-256 与快照，
   * 因此已有资料版本与报告引用继续可用。
   */
  private rechunkStaleVersions(): void {
    const stale = this.db.prepare(
      `SELECT * FROM material_versions WHERE chunker_version < ? AND body_status = 'ready'`,
    ).all(CHUNKER_VERSION) as VersionRow[];
    for (const row of stale) {
      const bytes = this.readSnapshot({ snapshotPath: row.snapshot_path, contentSha256: row.content_sha256 });
      if (!bytes) continue;
      const sections = sectionsFromSnapshot(bytes.toString("utf8"), row.format, {
        extractionVersion: row.extraction_version,
      });
      this.replaceSections(row.id, sections);
      this.db.prepare(`UPDATE material_versions SET chunker_version = ? WHERE id = ?`).run(CHUNKER_VERSION, row.id);
      this.index.markPending(row.id);
    }
  }

  private now(): string {
    return new Date().toISOString();
  }

  private toMaterial(row: MaterialRow): KnowledgeMaterial {
    const versions = this.versionRows(row.id);
    const effective = versions.find((v) => v.status === "active");
    return {
      id: row.id,
      scope: JSON.parse(row.scope_json) as KnowledgeScope,
      scopeKey: row.scope_key,
      sourceKey: row.source_key,
      title: row.title,
      publisher: row.publisher,
      sourceKind: row.source_kind,
      sourceUrl: row.source_url ?? undefined,
      note: row.note ?? undefined,
      tags: JSON.parse(row.tags_json) as string[],
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      currentVersionId: row.current_version_id,
      effectiveVersionId: effective?.id ?? null,
      versionCount: versions.length,
    };
  }

  private toVersion(row: VersionRow, sectionCount: number): KnowledgeVersion {
    return {
      id: row.id,
      materialId: row.material_id,
      versionNo: row.version_no,
      versionLabel: `本地 v${row.version_no}`,
      contentSha256: row.content_sha256,
      byteSize: row.byte_size,
      importedAt: row.imported_at,
      format: row.format,
      bodyStatus: row.body_status,
      bodyStatusReason: row.body_status_reason ?? undefined,
      sectionCount,
      upstreamVersion: row.upstream_version ?? undefined,
      upstreamCommit: row.upstream_commit ?? undefined,
      status: row.status,
      deprecatedAt: row.deprecated_at ?? undefined,
      deprecatedReason: row.deprecated_reason ?? undefined,
      snapshotPath: row.snapshot_path,
      chunkerVersion: row.chunker_version,
      extractionVersion: row.extraction_version,
    };
  }

  /** 版本号倒序：最新的未停用版本即检索默认使用的有效版本。 */
  private versionRows(materialId: string): VersionRow[] {
    return this.db
      .prepare(`SELECT * FROM material_versions WHERE material_id = ? ORDER BY version_no DESC`)
      .all(materialId) as VersionRow[];
  }

  private sectionsOf(versionId: string): KnowledgeSection[] {
    const rows = this.db
      .prepare(`SELECT ${SECTION_COLUMNS} FROM material_sections WHERE version_id = ? ORDER BY ordinal`)
      .all(versionId) as SectionRow[];
    return rows.map(toSection);
  }

  private replaceSections(versionId: string, sections: KnowledgeSection[]): void {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare(`DELETE FROM material_sections WHERE version_id = ?`).run(versionId);
      this.insertSections(versionId, sections);
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  private insertSections(versionId: string, sections: KnowledgeSection[]): void {
    const insert = this.db.prepare(
      `INSERT INTO material_sections (version_id, ordinal, locator, heading, page, text, char_start, char_end,
         heading_path_json, parent_locator, chunk_sha256, chunk_index, chunk_count, line_start, line_end, page_basis)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const section of sections) {
      insert.run(versionId, section.ordinal, section.locator, section.heading, section.page, section.text,
        section.charStart, section.charEnd, JSON.stringify(section.headingPath), section.parentLocator,
        section.chunkSha256, section.chunkIndex, section.chunkCount, section.lineStart, section.lineEnd,
        section.pageBasis);
    }
  }

  private materialRow(id: string): MaterialRow | undefined {
    return this.db.prepare(`SELECT * FROM materials WHERE id = ?`).get(id) as MaterialRow | undefined;
  }

  private versionRow(versionId: string): VersionRow | undefined {
    return this.db.prepare(`SELECT * FROM material_versions WHERE id = ?`).get(versionId) as VersionRow | undefined;
  }

  /** 内容寻址快照：临时文件 + rename，写完复算哈希，失败不留半写入版本。 */
  private writeSnapshot(sha256: string, bytes: Buffer): string {
    const relative = join("knowledge", "snapshots", sha256);
    const absolute = join(this.dataRoot, relative);
    if (existsSync(absolute) && sha256Hex(readFileSync(absolute)) === sha256) return relative;
    mkdirSync(dirname(absolute), { recursive: true, mode: 0o700 });
    const temp = join(dirname(absolute), `.${sha256}-${randomUUID()}.tmp`);
    try {
      writeFileSync(temp, bytes, { flag: "wx", mode: 0o600 });
      renameSync(temp, absolute);
    } finally {
      rmSync(temp, { force: true });
    }
    if (sha256Hex(readFileSync(absolute)) !== sha256) {
      throw new Error(`快照写入后校验失败：${sha256}`);
    }
    return relative;
  }

  readSnapshot(version: Pick<KnowledgeVersion, "snapshotPath" | "contentSha256">): Buffer | null {
    const absolute = join(this.dataRoot, version.snapshotPath);
    if (!existsSync(absolute)) return null;
    const bytes = readFileSync(absolute);
    return sha256Hex(bytes) === version.contentSha256 ? bytes : null;
  }

  /** 快照是否存在且校验通过，与正文是否为空分开判断。 */
  snapshotState(version: KnowledgeVersion): "ok" | "missing" | "corrupt" {
    const absolute = join(this.dataRoot, version.snapshotPath);
    if (!existsSync(absolute)) return "missing";
    return sha256Hex(readFileSync(absolute)) === version.contentSha256 ? "ok" : "corrupt";
  }

  preview(input: KnowledgePreviewInput): KnowledgePreview {
    const parsed = KnowledgePreviewSchema.parse(input);
    const extracted = extractKnowledgeBody(parsed);
    const bytes = Buffer.from(extracted.body, "utf8");
    return {
      title: parsed.title,
      publisher: parsed.publisher,
      sourceKind: parsed.sourceKind,
      format: parsed.format,
      sourceUrl: parsed.sourceUrl,
      sourceKey: deriveSourceKey(parsed),
      tags: parsed.tags,
      note: parsed.note,
      upstreamVersion: parsed.upstreamVersion,
      upstreamCommit: parsed.upstreamCommit,
      contentSha256: sha256Hex(bytes),
      byteSize: bytes.length,
      bodyStatus: extracted.bodyStatus,
      bodyStatusReason: extracted.bodyStatusReason,
      sections: extracted.sections,
    };
  }

  import(input: KnowledgeImportInput): KnowledgeImportResult {
    const parsed = KnowledgeImportSchema.parse(input);
    const extracted = extractKnowledgeBody(parsed);
    const bytes = Buffer.from(extracted.body, "utf8");
    const contentSha256 = sha256Hex(bytes);
    const sourceKey = deriveSourceKey(parsed);
    const scopeKey = knowledgeScopeKey(parsed.scope);
    const now = this.now();

    this.db.exec("BEGIN IMMEDIATE");
    try {
      let row = this.db
        .prepare(`SELECT * FROM materials WHERE scope_key = ? AND source_key = ?`)
        .get(scopeKey, sourceKey) as MaterialRow | undefined;
      if (!row) {
        const id = randomUUID();
        this.db.prepare(
          `INSERT INTO materials (id, scope_key, scope_json, source_key, title, publisher, source_kind,
             source_url, note, tags_json, created_at, updated_at, current_version_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '')`,
        ).run(id, scopeKey, JSON.stringify(parsed.scope), sourceKey, parsed.title, parsed.publisher,
          parsed.sourceKind, parsed.sourceUrl ?? null, parsed.note ?? null, JSON.stringify(parsed.tags), now, now);
        row = this.materialRow(id)!;
      }

      const existing = this.db
        .prepare(`SELECT * FROM material_versions WHERE material_id = ? AND content_sha256 = ?`)
        .get(row.id, contentSha256) as VersionRow | undefined;
      if (existing) {
        this.db.exec("COMMIT");
        this.index.markPending(existing.id);
        return {
          material: this.toMaterial(row),
          version: this.toVersion(existing, this.sectionsOf(existing.id).length),
          reused: true,
          sections: this.sectionsOf(existing.id),
          index: this.index.versionState(existing.id),
        };
      }

      const snapshotPath = this.writeSnapshot(contentSha256, bytes);
      const nextNo = Number(
        (this.db.prepare(`SELECT COALESCE(MAX(version_no), 0) AS n FROM material_versions WHERE material_id = ?`)
          .get(row.id) as { n: number }).n,
      ) + 1;
      const versionId = randomUUID();
      this.db.prepare(
        `INSERT INTO material_versions (id, material_id, version_no, content_sha256, byte_size, imported_at,
           format, body_status, body_status_reason, upstream_version, upstream_commit, status, snapshot_path,
           chunker_version, extraction_version)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)`,
      ).run(versionId, row.id, nextNo, contentSha256, bytes.length, now, parsed.format,
        extracted.bodyStatus, extracted.bodyStatusReason ?? null, parsed.upstreamVersion ?? null,
        parsed.upstreamCommit ?? null, snapshotPath, CHUNKER_VERSION, EXTRACTION_VERSION);

      this.insertSections(versionId, extracted.sections);
      this.db.prepare(`UPDATE materials SET current_version_id = ?, updated_at = ? WHERE id = ?`)
        .run(versionId, now, row.id);
      this.db.exec("COMMIT");

      this.index.markPending(versionId);
      const version = this.toVersion(this.versionRow(versionId)!, extracted.sections.length);
      return {
        material: this.toMaterial(this.materialRow(row.id)!),
        version,
        reused: false,
        sections: extracted.sections,
        index: this.index.versionState(versionId),
      };
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  /** 范围内资料清单。范围外的资料不出现在结果里，也不计数。 */
  list(scope: KnowledgeReaderScope): KnowledgeMaterial[] {
    const rows = this.db.prepare(`SELECT * FROM materials ORDER BY created_at`).all() as MaterialRow[];
    return rows.map((row) => this.toMaterial(row)).filter((material) => materialVisible(material, scope));
  }

  /** 越界一律返回 null（路由回 404），不区分“不存在”与“无权”，避免泄露存在性。 */
  get(materialId: string, scope: KnowledgeReaderScope): KnowledgeMaterial | null {
    const row = this.materialRow(materialId);
    if (!row) return null;
    const material = this.toMaterial(row);
    return materialVisible(material, scope) ? material : null;
  }

  versions(materialId: string, scope: KnowledgeReaderScope): KnowledgeVersion[] | null {
    const material = this.get(materialId, scope);
    if (!material) return null;
    return this.versionRows(materialId).map((row) => this.toVersion(row, this.sectionsOf(row.id).length));
  }

  version(materialId: string, versionId: string, scope: KnowledgeReaderScope):
    { material: KnowledgeMaterial; version: KnowledgeVersion } | null {
    const material = this.get(materialId, scope);
    if (!material) return null;
    const row = this.versionRow(versionId);
    if (!row || row.material_id !== materialId) return null;
    return { material, version: this.toVersion(row, this.sectionsOf(versionId).length) };
  }

  sections(materialId: string, versionId: string, scope: KnowledgeReaderScope): KnowledgeSection[] | null {
    if (!this.version(materialId, versionId, scope)) return null;
    return this.sectionsOf(versionId);
  }

  section(materialId: string, versionId: string, locator: string, scope: KnowledgeReaderScope):
    { material: KnowledgeMaterial; version: KnowledgeVersion; section: KnowledgeSection } | null {
    const found = this.version(materialId, versionId, scope);
    if (!found) return null;
    const section = findSection(this.sectionsOf(versionId), locator);
    return section ? { ...found, section } : null;
  }

  /** 命中片段的原文与上下文：整章范围与同章相邻片段，都从版本正文回读。 */
  sectionContext(materialId: string, versionId: string, locator: string, scope: KnowledgeReaderScope): {
    material: KnowledgeMaterial; version: KnowledgeVersion; section: KnowledgeSection; context: KnowledgeSectionContext;
  } | null {
    const found = this.section(materialId, versionId, locator, scope);
    if (!found) return null;
    const sections = this.sectionsOf(versionId);
    const range = parentRangeOf(sections, found.section);
    const body = this.readSnapshot(found.version)?.toString("utf8") ?? null;
    const parentText = body !== null
      ? body.slice(range.charStart, range.charEnd)
      : sections.filter((s) => s.parentLocator === found.section.parentLocator).map((s) => s.text).join("\n\n");
    return {
      ...found,
      context: {
        headingPath: found.section.headingPath,
        parentLocator: found.section.parentLocator,
        parentCharStart: range.charStart,
        parentCharEnd: range.charEnd,
        parentText,
        previous: range.previous ? { locator: range.previous.locator, text: range.previous.text } : null,
        next: range.next ? { locator: range.next.locator, text: range.next.text } : null,
      },
    };
  }

  deprecate(materialId: string, versionId: string, reason: string, scope: KnowledgeReaderScope): KnowledgeVersion | null {
    const found = this.version(materialId, versionId, scope);
    if (!found) return null;
    if (found.version.status === "deprecated") return found.version;
    const now = this.now();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare(
        `UPDATE material_versions SET status = 'deprecated', deprecated_at = ?, deprecated_reason = ? WHERE id = ?`,
      ).run(now, reason, versionId);
      this.db.prepare(`UPDATE materials SET updated_at = ? WHERE id = ?`).run(now, materialId);
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
    return this.toVersion(this.versionRow(versionId)!, found.version.sectionCount);
  }

  /** 范围内的版本 id：检索、索引计数、重建都以此为唯一入口。 */
  private scopedVersionIds(scope: KnowledgeReaderScope, opts: { materialId?: string; versionId?: string } = {}): string[] {
    const ids: string[] = [];
    for (const material of this.list(scope)) {
      if (opts.materialId && material.id !== opts.materialId) continue;
      const rows = opts.versionId
        ? this.versionRows(material.id).filter((row) => row.id === opts.versionId)
        : this.versionRows(material.id);
      for (const row of rows) ids.push(row.id);
    }
    return ids;
  }

  indexStatus(scope: KnowledgeReaderScope): KnowledgeIndexStatus {
    this.refreshEmbeddingConfig();
    return this.index.status(this.scopedVersionIds(scope), {
      selected: this.embeddingSettings().provider,
      allowed: this.allowedProviders(scope),
    });
  }

  /**
   * 重建索引：按当前切分算法重切分，再重新向量化。
   * 只动片段行与向量表，资料版本号、内容 SHA-256、快照与报告引用都不变。
   */
  rebuildIndex(scope: KnowledgeReaderScope, opts: { materialId?: string; versionId?: string } = {}): {
    versions: string[]; status: KnowledgeIndexStatus;
  } {
    this.refreshEmbeddingConfig();
    const ids = this.scopedVersionIds(scope, opts);
    for (const versionId of ids) {
      const row = this.versionRow(versionId);
      if (!row || row.body_status !== "ready") continue;
      const bytes = this.readSnapshot({ snapshotPath: row.snapshot_path, contentSha256: row.content_sha256 });
      if (!bytes) continue;
      const sections = sectionsFromSnapshot(bytes.toString("utf8"), row.format, {
        extractionVersion: row.extraction_version,
      });
      this.replaceSections(versionId, sections);
      this.db.prepare(`UPDATE material_versions SET chunker_version = ? WHERE id = ?`).run(CHUNKER_VERSION, versionId);
    }
    this.index.rebuild(ids);
    return { versions: ids, status: this.index.status(ids, {
      selected: this.embeddingSettings().provider, allowed: this.allowedProviders(scope),
    }) };
  }

  retryIndex(scope: KnowledgeReaderScope, opts: { materialId?: string; versionId?: string } = {}): {
    queued: string[]; status: KnowledgeIndexStatus;
  } {
    this.refreshEmbeddingConfig();
    const ids = this.scopedVersionIds(scope, opts);
    const queued = this.index.retry(ids);
    return { queued, status: this.index.status(ids, {
      selected: this.embeddingSettings().provider, allowed: this.allowedProviders(scope),
    }) };
  }

  /**
   * 混合检索。先按读者范围筛资料与版本，关键词与语义两路都只在这批版本上召回，
   * 合并、计数、返回正文与查询向量缓存都不越出该范围。
   *
   * 关键词保住 `R-017`、`54/60`、`§6.4` 这类精确值；语义补中文同义与中英跨语言。
   * 语义命中只标 semantic，绝不标 body。向量不可用时降级为关键词并如实返回状态。
   */
  async search(query: string, scope: KnowledgeReaderScope, opts: {
    limit?: number; versionId?: string; mode?: KnowledgeSearchMode;
  } = {}): Promise<KnowledgeSearchResult> {
    const limit = Math.min(Math.max(opts.limit ?? 20, 1), 200);
    const mode: KnowledgeSearchMode = opts.mode ?? "hybrid";
    const terms = query.trim().split(/\s+/).filter(Boolean);
    const materials = this.list(scope);
    this.refreshEmbeddingConfig();

    type Target = { material: KnowledgeMaterial; version: KnowledgeVersion; sections: KnowledgeSection[] };
    const targets: Target[] = [];
    for (const material of materials) {
      const versionId = opts.versionId ?? material.effectiveVersionId;
      if (!versionId) continue;
      const row = this.versionRow(versionId);
      if (!row || row.material_id !== material.id) continue;
      targets.push({ material, version: this.toVersion(row, 0), sections: this.sectionsOf(versionId) });
    }
    const versionIds = targets.map((t) => t.version.id);

    const contains = (haystack: string, needle: string) => haystack.toLowerCase().includes(needle.toLowerCase());
    const occurrencesOf = (haystack: string, needle: string) => {
      if (!needle) return 0;
      let count = 0;
      let at = haystack.indexOf(needle);
      while (at !== -1) {
        count += 1;
        at = haystack.indexOf(needle, at + needle.length);
      }
      return count;
    };
    const contextAround = (text: string, term: string | undefined) => {
      const index = term ? text.toLowerCase().indexOf(term.toLowerCase()) : -1;
      if (index === -1) return text.slice(0, 200).replace(/\s+/g, " ");
      const start = Math.max(0, index - 60);
      const end = Math.min(text.length, index + (term?.length ?? 0) + 100);
      return `${start > 0 ? "…" : ""}${text.slice(start, end).replace(/\s+/g, " ")}${end < text.length ? "…" : ""}`;
    };

    type Candidate = {
      target: Target;
      section: KnowledgeSection | null;
      keywordScore: number;
      semanticScore: number | null;
      titleHit: boolean;
      tagHit: boolean;
      matchedTags: string[];
      bodyHit: boolean;
      locatorHit: boolean;
      metaOnly: boolean;
    };
    const candidates = new Map<string, Candidate>();
    const bodyCandidate = (target: Target, section: KnowledgeSection): Candidate => {
      const key = `${target.version.id}#${section.ordinal}`;
      let found = candidates.get(key);
      if (!found) {
        found = {
          target, section, keywordScore: 0, semanticScore: null, titleHit: false, tagHit: false,
          matchedTags: [], bodyHit: false, locatorHit: false, metaOnly: false,
        };
        candidates.set(key, found);
      }
      return found;
    };

    // --- 关键词一路 ---
    // 章节地址查询（`§6.4` / `6.4`）按定位精确命中：原文里往往不写「§6.4」这个字面。
    const addressQuery = terms.length === 1 ? terms[0]!.toLowerCase().replace(/^§/, "") : "";
    const matchesAddress = (section: KnowledgeSection) => {
      if (!addressQuery) return false;
      const strip = (value: string) => value.toLowerCase().replace(/^§/, "");
      return strip(section.locator) === addressQuery || strip(section.parentLocator) === addressQuery;
    };
    let keywordRecall = 0;
    const keywordHitsByVersion = new Map<string, number>();
    for (const target of targets) {
      const { material, sections } = target;
      const titleAll = terms.length > 0 && terms.every((term) => contains(material.title, term));
      const matchedTags = material.tags.filter((tag) => terms.some((term) => contains(tag, term)));
      const tagsAll = terms.length > 0 && terms.every((term) => matchedTags.some((tag) => contains(tag, term)));

      let keywordHits = 0;
      for (const section of sections) {
        const bodyHit = terms.length > 0 && terms.every((term) => contains(section.text, term));
        const locatorHit = matchesAddress(section);
        if (!bodyHit && !locatorHit) continue;
        keywordHits += 1;
        const candidate = bodyCandidate(target, section);
        let score = 0;
        if (bodyHit) {
          const lower = section.text.toLowerCase();
          const hits = terms.reduce((sum, term) => sum + occurrencesOf(lower, term.toLowerCase()), 0);
          const density = hits / Math.max(1, section.text.length / 200);
          const exact = lower.includes(query.trim().toLowerCase());
          const path = section.headingPath.join(" ").toLowerCase();
          const headingAll = terms.every((term) => path.includes(term.toLowerCase()));
          score = 1 + (exact ? 0.6 : 0) + (headingAll ? 0.35 : 0) + Math.min(density, 2) * 0.25;
        }
        // 显式章节地址是最强的关键词信号，排在普通字面命中之前。
        if (locatorHit) score = Math.max(score, 1.6);
        candidate.keywordScore = Math.max(candidate.keywordScore, score);
        candidate.bodyHit = candidate.bodyHit || bodyHit;
        candidate.locatorHit = candidate.locatorHit || locatorHit;
        candidate.titleHit = titleAll;
        candidate.tagHit = tagsAll;
        candidate.matchedTags = tagsAll ? matchedTags : [];
        keywordRecall += 1;
      }
      keywordHitsByVersion.set(target.version.id, keywordHits);
      if (keywordHits) continue;
      // 正文没有整段命中时，才给标题级或标签级命中，并如实标明命中字段。
      if (titleAll || tagsAll) {
        const key = `${target.version.id}#meta`;
        candidates.set(key, {
          target,
          section: sections[0] ?? null,
          keywordScore: titleAll ? TITLE_ONLY_SCORE : TAG_ONLY_SCORE,
          semanticScore: null,
          titleHit: titleAll,
          tagHit: tagsAll,
          matchedTags: tagsAll ? matchedTags : [],
          bodyHit: false,
          locatorHit: false,
          metaOnly: true,
        });
        keywordRecall += 1;
      }
    }

    // --- 语义一路：只在上面这批已授权版本上取向量，且只走本范围获授权的服务 ---
    // 每套服务各算一次查询向量：不同模型的向量空间不可混用。
    let semanticRecall = 0;
    let semanticCutoff: number | null = null;
    let semanticFailure: string | null = null;
    const allowed = this.allowedProviders(scope);
    const providers: KnowledgeEmbeddingProvider[] = ["local", "cloud"];
    const usable = providers.filter((p) => allowed.has(p) && this.index.index(p).semanticReady);
    if (mode === "hybrid" && terms.length && usable.length) {
      const scored: Array<{ target: Target; ordinal: number; cosine: number }> = [];
      for (const provider of usable) {
        try {
          const vectors = this.index.vectorsFor(versionIds, provider);
          if (!vectors.size) continue;
          const queryVector = await this.index.queryVector(query.trim(), provider);
          for (const target of targets) {
            for (const entry of vectors.get(target.version.id) ?? []) {
              const cosine = dot(queryVector, entry.vector);
              if (cosine >= SEMANTIC_MIN_COSINE) scored.push({ target, ordinal: entry.ordinal, cosine });
            }
          }
        } catch (err) {
          semanticFailure = err instanceof EmbeddingUnavailable ? err.message
            : `语义召回失败：${err instanceof Error ? err.message : String(err)}`;
        }
      }
      scored.sort((a, b) => b.cosine - a.cosine || a.target.version.id.localeCompare(b.target.version.id)
        || a.ordinal - b.ordinal);
      if (scored.length) {
        semanticCutoff = Math.max(SEMANTIC_MIN_COSINE, scored[0]!.cosine - SEMANTIC_RELATIVE_MARGIN);
        const perVersion = new Map<string, number>();
        const cap = Math.max(SEMANTIC_CANDIDATE_FLOOR, limit * 3);
        for (const entry of scored) {
          if (entry.cosine < semanticCutoff) break;
          const used = perVersion.get(entry.target.version.id) ?? 0;
          if (used >= SEMANTIC_PER_VERSION_CAP) continue;
          const section = entry.target.sections.find((s) => s.ordinal === entry.ordinal);
          if (!section) continue;
          perVersion.set(entry.target.version.id, used + 1);
          const candidate = bodyCandidate(entry.target, section);
          candidate.semanticScore = entry.cosine;
          semanticRecall += 1;
          if (semanticRecall >= cap) break;
        }
      }
    } else if (mode === "hybrid" && terms.length) {
      semanticFailure = this.index.degradedReason(allowed);
    }

    const status = this.index.status(versionIds, {
      selected: this.embeddingSettings().provider, allowed,
    });
    // 共享资料已由云端索引，但本委托未允许云端：这些片段本次不参与语义召回，如实说明。
    if (mode === "hybrid" && terms.length && semanticRecall === 0 && status.blockedChunks > 0 && !semanticFailure) {
      semanticFailure = `本范围有 ${status.blockedChunks} 个片段属于未获授权的向量化服务，未参与语义召回`;
    }

    const hits: KnowledgeSearchHit[] = [];
    const matchedMaterials = new Set<string>();
    for (const candidate of candidates.values()) {
      const { target, section } = candidate;
      const { material, version } = target;
      const semantic = candidate.semanticScore !== null;
      const matchedFields: KnowledgeMatchField[] = [];
      if (candidate.bodyHit) matchedFields.push("body");
      if (candidate.locatorHit) matchedFields.push("locator");
      if (candidate.titleHit) matchedFields.push("title");
      if (semantic) matchedFields.push("semantic");
      if (candidate.tagHit) matchedFields.push("tags");
      const keywordHit = candidate.bodyHit || candidate.locatorHit;
      const retrieval: KnowledgeRetrieval = keywordHit && semantic ? "hybrid"
        : semantic ? "semantic" : "keyword";
      const tagOnly = !keywordHit && !semantic && candidate.tagHit && !candidate.titleHit;
      const score = candidate.keywordScore + (semantic ? SEMANTIC_WEIGHT * Math.max(0, candidate.semanticScore!) : 0);
      const anchor = section ?? target.sections[0] ?? null;
      const context = candidate.metaOnly
        ? (candidate.titleHit ? material.title : `仅标签命中：${candidate.matchedTags.join("、")}。正文未出现该查询词。`)
        : contextAround(section?.text ?? "", candidate.bodyHit ? terms[0] : undefined);
      hits.push({
        materialId: material.id,
        versionId: version.id,
        versionNo: version.versionNo,
        versionLabel: version.versionLabel,
        versionStatus: version.status,
        title: material.title,
        publisher: material.publisher,
        sourceKind: material.sourceKind,
        sourceUrl: material.sourceUrl,
        scope: material.scope,
        bodyStatus: version.bodyStatus,
        matchedFields,
        matchedTags: candidate.matchedTags,
        tagOnly,
        matchCount: candidate.metaOnly ? 0 : keywordHitsByVersion.get(version.id) ?? 0,
        locator: anchor?.locator ?? "¶0",
        heading: anchor?.heading ?? null,
        page: anchor?.page ?? null,
        ordinal: anchor?.ordinal ?? 0,
        context,
        headingPath: anchor?.headingPath ?? [],
        parentLocator: anchor?.parentLocator ?? (anchor?.locator ?? "¶0"),
        charStart: anchor?.charStart ?? 0,
        charEnd: anchor?.charEnd ?? 0,
        chunkSha256: anchor?.chunkSha256 ?? "",
        lineStart: anchor?.lineStart ?? 1,
        lineEnd: anchor?.lineEnd ?? 1,
        pageBasis: anchor?.pageBasis ?? null,
        retrieval,
        score,
        keywordScore: candidate.keywordScore,
        semanticScore: candidate.semanticScore,
      });
      matchedMaterials.add(material.id);
    }
    hits.sort((a, b) => b.score - a.score || a.materialId.localeCompare(b.materialId) || a.ordinal - b.ordinal);

    const degraded = mode === "keyword" || semanticFailure !== null || status.degraded;
    return {
      query,
      scope,
      mode,
      total: hits.length,
      materials: matchedMaterials.size,
      searchedVersions: targets.length,
      limit,
      truncated: hits.length > limit,
      hits: hits.slice(0, limit),
      recall: { keyword: keywordRecall, semantic: semanticRecall, semanticCutoff },
      index: {
        ...status,
        degraded,
        ...(degraded
          ? { degradedReason: mode === "keyword" ? "本次请求指定只用关键词检索" : semanticFailure ?? status.degradedReason ?? "向量索引尚未就绪，本次检索只用关键词" }
          : {}),
      },
    };
  }

  summary(scope: KnowledgeReaderScope): KnowledgeSummary {
    const materials = this.list(scope);
    const bySourceKind = { original: 0, excerpt: 0, editorial: 0 };
    let versions = 0;
    let pendingBody = 0;
    let deprecatedVersions = 0;
    let shared = 0;
    let engagement = 0;
    for (const material of materials) {
      bySourceKind[material.sourceKind] += 1;
      if (material.scope.kind === "shared") shared += 1;
      else engagement += 1;
      for (const row of this.versionRows(material.id)) {
        versions += 1;
        if (row.body_status === "pending_body") pendingBody += 1;
        if (row.status === "deprecated") deprecatedVersions += 1;
      }
    }
    return {
      scope,
      materials: materials.length,
      versions,
      pendingBody,
      deprecatedVersions,
      bySourceKind,
      byScope: { shared, engagement },
    };
  }
}
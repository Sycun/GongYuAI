import { existsSync, readFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { join } from "node:path";
import {
  KnowledgeImportSchema,
  KnowledgePreviewSchema,
  MaterialCitationSchema,
  isTerminalTaskStatus,
  type CitationVerification,
  type ExportSnapshotScope,
  type KnowledgeReaderScope,
  type KnowledgeReportExport,
  type KnowledgeSection,
  type MaterialCitation,
  type MaterialCitationInput,
  type ResolvedCitation,
  type TaskRecord,
} from "@gongyuai/contracts";
import { openHistory, writeTaskReport, type HistoryStore, type MaterialCitationSeal } from "@gongyuai/history";
import { KnowledgeStore, sha256Hex } from "./knowledge.js";
import { findSection, sectionsFromSnapshot } from "./knowledge-parse.js";
import { taskPaths } from "./paths.js";
import type { ControlStore } from "./store.js";

/**
 * 读者可见范围由服务端定下来。任务归属以 store 为准，客户端传入的
 * engagementId 只能用于定位；两者冲突时拒绝，而不是采信客户端。
 *
 * 本运行环境是单操作者、无认证层，因此 declared 上下文是**声明**而非已认证
 * 身份：委托边界按此验收，用户级权限不在本轮验证范围内。
 */
export function scopeFromTask(task: TaskRecord): KnowledgeReaderScope {
  return {
    engagementId: task.engagementId,
    resolvedFrom: "task",
    operatorModel: "single-operator",
    userLevelPermissionVerified: false,
  };
}

export function scopeFromDeclaration(declared?: string | null): KnowledgeReaderScope {
  const trimmed = declared?.trim();
  return {
    engagementId: trimmed || null,
    resolvedFrom: trimmed ? "declared" : "shared-only",
    operatorModel: "single-operator",
    userLevelPermissionVerified: false,
  };
}

export class KnowledgeApiError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

function declaredEngagement(url: URL, req: IncomingMessage): string | null {
  const header = req.headers["x-gy-engagement"];
  const value = url.searchParams.get("engagementId") ?? (Array.isArray(header) ? header[0] : header);
  return value?.trim() || null;
}

/** 库级路由的范围：给了 taskId 就以服务端任务归属为准，否则用声明上下文。 */
function libraryScope(ctx: RouteContext): KnowledgeReaderScope {
  const declared = declaredEngagement(ctx.url, ctx.req);
  const taskId = ctx.url.searchParams.get("taskId")?.trim();
  if (!taskId) return scopeFromDeclaration(declared);
  const task = ctx.store.get(taskId);
  if (!task) throw new KnowledgeApiError(404, "任务不存在");
  if (declared && declared !== task.engagementId) {
    throw new KnowledgeApiError(409, `委托上下文与服务端任务归属不一致：声明 ${declared}，任务属于 ${task.engagementId}`);
  }
  return scopeFromTask(task);
}

function withHistory<T>(task: TaskRecord, render: (history: HistoryStore) => T, readOnly = false): T {
  const paths = taskPaths(task.dataDir);
  const history = openHistory({ dbPath: paths.historyDb, evidenceDir: paths.evidenceDir, readOnly });
  try {
    return render(history);
  } finally {
    history.close();
  }
}

function hasHistory(task: TaskRecord): boolean {
  return existsSync(taskPaths(task.dataDir).historyDb);
}

/**
 * 复验只读任务侧密封件，因此资料更新、旧版停用、重切分、换 embedding 模型、
 * 重建索引、服务重启与上游离线都不影响有权读者回读当时引用的段落。
 *
 * range 定版按固定的原文范围切片并校验片段 SHA-256，完全不依赖索引；
 * locator 定版是旧写法，沿用旧切分回读，保证升级前后是同一段。
 */
export function verifyCitation(
  history: HistoryStore,
  task: TaskRecord,
  citation: MaterialCitation,
): { verification: CitationVerification; paragraph?: ResolvedCitation["paragraph"]; bytes?: Buffer } {
  const expected = citation.snapshotSha256;
  const bytes = history.readProofVersion(task.id, expected);
  if (!bytes) {
    return { verification: { status: "unverifiable", reason: "snapshot_missing", expectedSha256: expected, source: "task-seal", detail: "任务侧密封快照缺失，无法复验当时引用的段落" } };
  }
  const recomputed = sha256Hex(bytes);
  if (recomputed !== expected) {
    return { verification: { status: "unverifiable", reason: "sha256_mismatch", expectedSha256: expected, recomputedSha256: recomputed, source: "task-seal", detail: "快照内容与引用登记的 SHA-256 不一致，无法复验" }, bytes };
  }
  const body = bytes.toString("utf8");
  if (!body.trim()) {
    return { verification: { status: "unverifiable", reason: "body_pending", expectedSha256: expected, recomputedSha256: recomputed, source: "task-seal", detail: "该版本登记时正文待补，没有可回读的段落" }, bytes };
  }
  const verified: CitationVerification = { status: "verified", expectedSha256: expected, recomputedSha256: recomputed, source: "task-seal" };

  if (citation.pinKind === "range" && citation.charStart !== null && citation.charEnd !== null) {
    if (citation.charStart < 0 || citation.charEnd > body.length || citation.charEnd <= citation.charStart) {
      return { verification: { status: "unverifiable", reason: "range_out_of_bounds", expectedSha256: expected, recomputedSha256: recomputed, source: "task-seal", detail: `登记的原文范围 [${citation.charStart}, ${citation.charEnd}) 超出快照正文长度 ${body.length}` }, bytes };
    }
    const text = body.slice(citation.charStart, citation.charEnd);
    const chunkSha256 = sha256Hex(text);
    if (citation.chunkSha256 && chunkSha256 !== citation.chunkSha256) {
      return { verification: { status: "unverifiable", reason: "chunk_sha_mismatch", expectedSha256: expected, recomputedSha256: recomputed, source: "task-seal", detail: `范围切出的片段校验值 ${chunkSha256} 与登记的 ${citation.chunkSha256} 不一致` }, bytes };
    }
    const meta = history.citationSectionMeta(task.id, citation.id);
    const paragraph: KnowledgeSection = {
      ...(meta ?? {
        ordinal: citation.sectionOrdinal,
        locator: citation.locator,
        heading: citation.sectionHeading,
        page: citation.sectionPage,
        charStart: citation.charStart,
        charEnd: citation.charEnd,
        headingPath: citation.headingPath,
        parentLocator: citation.locator,
        chunkSha256,
        chunkIndex: 0,
        chunkCount: 1,
        lineStart: 1,
        lineEnd: 1,
        pageBasis: citation.pageBasis,
      }),
      text,
      chunkSha256,
    };
    return { verification: verified, paragraph, bytes };
  }

  const sections = sectionsFromSnapshot(body, citation.bodyFormat, { legacy: true });
  if (!sections.length) {
    return { verification: { status: "unverifiable", reason: "body_pending", expectedSha256: expected, recomputedSha256: recomputed, source: "task-seal", detail: "该版本登记时正文待补，没有可回读的段落" }, bytes };
  }
  const paragraph = findSection(sections, citation.locator);
  if (!paragraph) {
    return { verification: { status: "unverifiable", reason: "locator_not_found", expectedSha256: expected, recomputedSha256: recomputed, source: "task-seal", detail: `快照校验通过，但其中找不到定位 ${citation.locator}` }, bytes };
  }
  return { verification: verified, paragraph, bytes };
}

export function resolveCitation(
  knowledge: KnowledgeStore,
  history: HistoryStore,
  task: TaskRecord,
  citationId: string,
): ResolvedCitation {
  const citation = history.getMaterialCitation(task.id, citationId);
  if (!citation) throw new KnowledgeApiError(404, "引用不存在");
  const { verification, paragraph } = verifyCitation(history, task, citation);
  const scope = scopeFromTask(task);
  const found = knowledge.version(citation.materialId, citation.versionId, scope);
  return {
    citation,
    verification,
    ...(paragraph ? { paragraph } : {}),
    ...(found ? { versionStatus: found.version.status } : {}),
    librarySnapshotAvailable: found ? knowledge.snapshotState(found.version) === "ok" : false,
  };
}

function createCitation(
  knowledge: KnowledgeStore,
  history: HistoryStore,
  task: TaskRecord,
  input: MaterialCitationInput,
): MaterialCitation {
  const scope = scopeFromTask(task);
  // 越界资料统一按“不存在”处理，不区分无权与不存在，避免泄露其他委托的材料。
  const found = knowledge.version(input.materialId, input.versionId, scope);
  if (!found) throw new KnowledgeApiError(404, "资料或版本不存在，或不在当前委托的可见范围");
  const section = knowledge.section(input.materialId, input.versionId, input.locator, scope)?.section;
  if (!section) throw new KnowledgeApiError(404, `该版本中找不到段落定位 ${input.locator}`);
  if (found.version.bodyStatus !== "ready") {
    throw new KnowledgeApiError(409, "该版本正文待补，不能生成定版段落引用");
  }
  // 前端从命中片段创建引用时带上原文范围；必须与定位指向的片段完全一致。
  if (input.charStart !== undefined && input.charEnd !== undefined) {
    if (input.charStart !== section.charStart || input.charEnd !== section.charEnd) {
      throw new KnowledgeApiError(409, `原文范围 [${input.charStart}, ${input.charEnd}) 与定位 ${input.locator} 指向的片段 [${section.charStart}, ${section.charEnd}) 不一致`);
    }
  }
  if (input.chunkSha256 && input.chunkSha256 !== section.chunkSha256) {
    throw new KnowledgeApiError(409, `片段校验值与定位 ${input.locator} 的正文不一致，请重新检索后再引用`);
  }
  const bytes = knowledge.readSnapshot(found.version);
  if (!bytes) throw new KnowledgeApiError(409, "知识库快照缺失或校验失败，无法密封定版引用");
  if (sha256Hex(bytes) !== found.version.contentSha256) {
    throw new KnowledgeApiError(409, "知识库快照校验失败，无法密封定版引用");
  }
  const { text: _text, ...sectionMeta } = section;
  const seal: MaterialCitationSeal = {
    materialTitle: found.material.title,
    publisher: found.material.publisher,
    sourceKind: found.material.sourceKind,
    versionNo: found.version.versionNo,
    versionLabel: found.version.versionLabel,
    bodyFormat: found.version.format,
    sectionHeading: section.heading,
    sectionPage: section.page,
    sectionOrdinal: section.ordinal,
    sectionMeta,
    snapshot: bytes,
  };
  // 给了定位就给范围：新引用一律按原文范围定版，回读不依赖切分与索引。
  const pinned: MaterialCitationInput = input.charStart === undefined
    ? { ...input, charStart: section.charStart, charEnd: section.charEnd, chunkSha256: section.chunkSha256 }
    : { ...input, chunkSha256: section.chunkSha256 };
  return history.recordMaterialCitation(task.id, task.engagementId, pinned, seal);
}

/**
 * 离线导出：按服务端委托范围打包报告、定版字节与校验信息。
 * snapshotScope 说明打包的到底是整份版本快照还是仅被引用片段。
 */
export function buildReportExport(
  knowledge: KnowledgeStore,
  history: HistoryStore | null,
  task: TaskRecord,
  snapshotScope: ExportSnapshotScope = "full-version",
): KnowledgeReportExport {
  const scope = scopeFromTask(task);
  const reportPath = join(task.dataDir, "report.md");
  const markdown = existsSync(reportPath) ? readFileSync(reportPath, "utf8") : null;
  let withheld = 0;
  const packed: KnowledgeReportExport["citations"] = [];
  if (history) {
    for (const citation of history.listMaterialCitations(task.id)) {
      if (knowledge.get(citation.materialId, scope) === null) {
        withheld += 1;
        continue;
      }
      const { verification, paragraph, bytes } = verifyCitation(history, task, citation);
      let payload: Buffer | null = null;
      let payloadSha = citation.snapshotSha256;
      if (snapshotScope === "full-version") payload = bytes ?? null;
      else if (snapshotScope === "paragraph" && paragraph) {
        payload = Buffer.from(paragraph.text, "utf8");
        payloadSha = paragraph.chunkSha256;
      }
      packed.push({
        citation,
        verification,
        ...(paragraph ? { paragraph } : {}),
        ...(payload ? { snapshot: { sha256: payloadSha, byteSize: payload.length, bytesBase64: payload.toString("base64") } } : {}),
      });
    }
  }
  return {
    version: 1,
    kind: "knowledge-report-export",
    taskId: task.id,
    engagementId: task.engagementId,
    exportedAt: new Date().toISOString(),
    scope,
    snapshotScope,
    report: markdown === null ? null : { path: "report.md", sha256: sha256Hex(markdown), markdown },
    citations: packed,
    withheld: { outOfScopeCitations: withheld },
  };
}

/**
 * 停用某版本后，引用它的终态报告要重渲染，才能留下“该版本已停用”的历史提示。
 * 引用存在各任务的 history.sqlite，这里按任务扫描；范围仍由各任务自己的归属决定。
 */
function refreshReportsCitingVersion(store: ControlStore, knowledge: KnowledgeStore, versionId: string): void {
  for (const task of store.list()) {
    const status = task.status;
    if (!isTerminalTaskStatus(status)) continue;
    const paths = taskPaths(task.dataDir);
    if (!existsSync(paths.historyDb)) continue;
    withHistory(task, (history) => {
      if (!history.listMaterialCitations(task.id).some((citation) => citation.versionId === versionId)) return;
      writeTaskReport(
        { taskId: task.id, dataDir: task.dataDir, auth: task.auth },
        history,
        { status, reason: task.error ?? undefined, accounting: task,
          materialVersionStatus: (id, materialId) =>
            knowledge.version(materialId, id, scopeFromTask(task))?.version.status },
      );
    });
  }
}

export type RouteContext = {
  method: string;
  url: URL;
  req: IncomingMessage;
  res: ServerResponse;
  store: ControlStore;
  knowledge: KnowledgeStore;
  send: (res: ServerResponse, status: number, body: unknown) => void;
  readJson: (req: IncomingMessage, maxBytes?: number) => Promise<unknown>;
};

const MATERIAL = /^\/knowledge\/materials\/([^/]+)$/;
const VERSIONS = /^\/knowledge\/materials\/([^/]+)\/versions$/;
const VERSION = /^\/knowledge\/materials\/([^/]+)\/versions\/([^/]+)$/;
const SECTION = /^\/knowledge\/materials\/([^/]+)\/versions\/([^/]+)\/section$/;
const DEPRECATE = /^\/knowledge\/materials\/([^/]+)\/versions\/([^/]+)\/deprecate$/;
const TASK_CITATIONS = /^\/tasks\/([^/]+)\/citations$/;
const CITATION_RESOLVE = /^\/tasks\/([^/]+)\/citations\/([^/]+)\/resolve$/;
const REPORT_EXPORT = /^\/tasks\/([^/]+)\/report-export$/;

/** 返回 true 表示本请求已由知识库路由处理。 */
export async function routeKnowledge(ctx: RouteContext): Promise<boolean> {
  const { method, url, req, res, send, knowledge, store } = ctx;
  const path = url.pathname;
  const isKnowledge = path === "/knowledge" || path.startsWith("/knowledge/");
  const taskRoute = TASK_CITATIONS.exec(path) ?? CITATION_RESOLVE.exec(path) ?? REPORT_EXPORT.exec(path);
  if (!isKnowledge && !taskRoute) return false;

  try {
    if (method === "POST" && path === "/knowledge/preview") {
      return send(res, 200, knowledge.preview(KnowledgePreviewSchema.parse(await ctx.readJson(req, 32 * 1024 * 1024)))), true;
    }
    if (method === "POST" && path === "/knowledge/materials") {
      const input = KnowledgeImportSchema.parse(await ctx.readJson(req, 32 * 1024 * 1024));
      const result = knowledge.import(input);
      return send(res, result.reused ? 200 : 201, result), true;
    }
    if (method === "GET" && path === "/knowledge/materials") {
      const scope = libraryScope(ctx);
      return send(res, 200, { scope, materials: knowledge.listItems(scope) }), true;
    }
    if (method === "GET" && path === "/knowledge/search") {
      const scope = libraryScope(ctx);
      const query = url.searchParams.get("q") ?? "";
      const limitRaw = url.searchParams.get("limit");
      const versionId = url.searchParams.get("versionId") ?? undefined;
      const modeRaw = url.searchParams.get("mode");
      if (limitRaw !== null && !/^\d+$/.test(limitRaw)) throw new KnowledgeApiError(400, "limit 必须是正整数");
      if (modeRaw !== null && modeRaw !== "keyword" && modeRaw !== "hybrid") {
        throw new KnowledgeApiError(400, "mode 只能是 keyword 或 hybrid");
      }
      return send(res, 200, await knowledge.search(query, scope, {
        ...(limitRaw ? { limit: Number(limitRaw) } : {}),
        ...(versionId ? { versionId } : {}),
        ...(modeRaw ? { mode: modeRaw } : {}),
      })), true;
    }
    if (method === "GET" && path === "/knowledge/index") {
      return send(res, 200, { scope: libraryScope(ctx), index: knowledge.indexStatus(libraryScope(ctx)) }), true;
    }
    if (method === "POST" && (path === "/knowledge/index/rebuild" || path === "/knowledge/index/retry")) {
      const scope = libraryScope(ctx);
      const body = await ctx.readJson(req) as { materialId?: unknown; versionId?: unknown; versionIds?: unknown };
      const opts = {
        ...(typeof body.materialId === "string" && body.materialId.trim() ? { materialId: body.materialId.trim() } : {}),
        ...(typeof body.versionId === "string" && body.versionId.trim() ? { versionId: body.versionId.trim() } : {}),
        ...(Array.isArray(body.versionIds)
          ? { versionIds: body.versionIds
              .filter((id): id is string => typeof id === "string" && id.trim().length > 0)
              .map((id) => id.trim()) }
          : {}),
      };
      if (opts.materialId && knowledge.get(opts.materialId, scope) === null) {
        throw new KnowledgeApiError(404, "资料不存在，或不在当前委托的可见范围");
      }
      const result = path.endsWith("/rebuild")
        ? knowledge.rebuildIndex(scope, opts)
        : knowledge.retryIndex(scope, opts);
      return send(res, 202, { scope, ...result }), true;
    }
    if (method === "GET" && path === "/knowledge/summary") {
      return send(res, 200, knowledge.summary(libraryScope(ctx))), true;
    }

    const materialMatch = MATERIAL.exec(path);
    if (method === "GET" && materialMatch) {
      const scope = libraryScope(ctx);
      const id = decodeURIComponent(materialMatch[1]!);
      const material = knowledge.get(id, scope);
      if (!material) throw new KnowledgeApiError(404, "资料不存在，或不在当前委托的可见范围");
      return send(res, 200, { material, versions: knowledge.versions(id, scope) }), true;
    }
    const versionsMatch = VERSIONS.exec(path);
    if (method === "GET" && versionsMatch) {
      const scope = libraryScope(ctx);
      const id = decodeURIComponent(versionsMatch[1]!);
      const versions = knowledge.versions(id, scope);
      if (!versions) throw new KnowledgeApiError(404, "资料不存在，或不在当前委托的可见范围");
      return send(res, 200, { versions }), true;
    }
    const versionMatch = VERSION.exec(path);
    if (method === "GET" && versionMatch) {
      const scope = libraryScope(ctx);
      const found = knowledge.version(decodeURIComponent(versionMatch[1]!), decodeURIComponent(versionMatch[2]!), scope);
      if (!found) throw new KnowledgeApiError(404, "资料或版本不存在，或不在当前委托的可见范围");
      return send(res, 200, {
        ...found,
        sections: knowledge.sections(found.material.id, found.version.id, scope),
        snapshotState: knowledge.snapshotState(found.version),
      }), true;
    }
    const sectionMatch = SECTION.exec(path);
    if (method === "GET" && sectionMatch) {
      const scope = libraryScope(ctx);
      const locator = url.searchParams.get("locator");
      if (!locator) throw new KnowledgeApiError(400, "需要 locator 查询参数");
      const found = knowledge.sectionContext(decodeURIComponent(sectionMatch[1]!), decodeURIComponent(sectionMatch[2]!), locator, scope);
      if (!found) throw new KnowledgeApiError(404, "资料、版本或段落不存在，或不在当前委托的可见范围");
      return send(res, 200, found), true;
    }
    const deprecateMatch = DEPRECATE.exec(path);
    if (method === "POST" && deprecateMatch) {
      const scope = libraryScope(ctx);
      const body = await ctx.readJson(req) as { reason?: unknown };
      const reason = typeof body.reason === "string" && body.reason.trim() ? body.reason.trim() : "操作员停用该版本";
      const version = knowledge.deprecate(decodeURIComponent(deprecateMatch[1]!), decodeURIComponent(deprecateMatch[2]!), reason, scope);
      if (!version) throw new KnowledgeApiError(404, "资料或版本不存在，或不在当前委托的可见范围");
      refreshReportsCitingVersion(store, knowledge, version.id);
      return send(res, 200, { version }), true;
    }

    if (taskRoute) {
      const taskId = decodeURIComponent(taskRoute[1]!);
      const task = store.get(taskId);
      if (!task) throw new KnowledgeApiError(404, "任务不存在");
      const declared = declaredEngagement(url, req);
      if (declared && declared !== task.engagementId) {
        throw new KnowledgeApiError(409, `委托上下文与服务端任务归属不一致：声明 ${declared}，任务属于 ${task.engagementId}`);
      }
      if (method === "GET" && REPORT_EXPORT.test(path)) {
        const raw = url.searchParams.get("snapshot") ?? "full-version";
        if (raw !== "full-version" && raw !== "paragraph" && raw !== "none") {
          throw new KnowledgeApiError(400, "snapshot 只能是 full-version、paragraph 或 none");
        }
        const snapshotScope = raw as ExportSnapshotScope;
        if (!hasHistory(task)) {
          return send(res, 200, buildReportExport(knowledge, null, task, snapshotScope)), true;
        }
        return send(res, 200, withHistory(task, (history) => buildReportExport(knowledge, history, task, snapshotScope), true)), true;
      }
      if (TASK_CITATIONS.test(path)) {
        if (method === "GET") {
          const citations = hasHistory(task)
            ? withHistory(task, (history) => history.listMaterialCitations(task.id), true)
            : [];
          return send(res, 200, { scope: scopeFromTask(task), citations }), true;
        }
        if (method === "POST") {
          const input = MaterialCitationSchema.parse(await ctx.readJson(req));
          if (input.engagementId && input.engagementId !== task.engagementId) {
            throw new KnowledgeApiError(409, `委托上下文与服务端任务归属不一致：声明 ${input.engagementId}，任务属于 ${task.engagementId}`);
          }
          const citation = withHistory(task, (history) => {
            const created = createCitation(knowledge, history, task, input);
            // 引用属于交付材料：终态任务要重渲染报告，否则报告与引用读数分叉。
            if (isTerminalTaskStatus(task.status)) {
              writeTaskReport(
                { taskId: task.id, dataDir: task.dataDir, auth: task.auth },
                history,
                { status: task.status, reason: task.error ?? undefined, accounting: task,
                  materialVersionStatus: (versionId, materialId) =>
                    knowledge.version(materialId, versionId, scopeFromTask(task))?.version.status },
              );
            }
            return created;
          });
          return send(res, 201, { citation }), true;
        }
      }
      const resolveMatch = CITATION_RESOLVE.exec(path);
      if (method === "GET" && resolveMatch) {
        if (!hasHistory(task)) throw new KnowledgeApiError(404, "引用不存在");
        return send(res, 200, withHistory(task, (history) =>
          resolveCitation(knowledge, history, task, decodeURIComponent(resolveMatch[2]!)), true)), true;
      }
    }
    throw new KnowledgeApiError(405, "该知识库路径不支持此方法");
  } catch (err) {
    if (err instanceof KnowledgeApiError) return send(res, err.status, { error: err.message }), true;
    const message = err instanceof Error ? err.message : String(err);
    // zod 校验失败按 400 返回，其余按 409（与既有任务写入口一致）。
    const invalid = (err instanceof Error && err.name === "ZodError")
      || /invalid|expected|Required|至少提供一项|必须同时提供|必须大于|too_big|too_small/i.test(message);
    return send(res, invalid ? 400 : 409, { error: message }), true;
  }
}
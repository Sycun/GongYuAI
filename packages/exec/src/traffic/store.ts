import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  TrafficRecordSchema,
  TrafficSearchQuerySchema,
  type TrafficBlobRef,
  type TrafficRecord,
  type TrafficSearchQuery,
} from "@gongyuai/contracts";
import { normalizeSlice, readBlobBytes, readBlobSlice, type BlobSlice } from "./blobs.js";
import {
  MAX_COMPRESSED_BLOB_BYTES,
  decodeTrafficBody,
  hasSupportedContentEncoding,
} from "./encoding.js";
import {
  isNoiseExchange,
  isStaticAssetExchange,
  resolveTrafficRetention,
  shapeTrafficWrite,
  trafficPruneCount,
  trafficPruneDue,
  type TrafficRetentionConfig,
} from "./retention.js";

export type TrafficWrite = {
  /** Optional fixed id (ring promotion). Default: a fresh UUID. */
  id?: string;
  taskId: string;
  intentId?: string;
  workerId?: string;
  method: string;
  url: string;
  host: string;
  path: string;
  status: number;
  durationMs: number;
  startedAt: string;
  reqHeaders: Record<string, string | string[]>;
  resHeaders: Record<string, string | string[]>;
  reqBody?: TrafficBlobRef;
  resBody?: TrafficBlobRef;
  reqPreview?: string;
  resPreview?: string;
  findingIds?: string[];
};

export type TrafficQuery = Partial<Omit<TrafficSearchQuery, "taskId">> & {
  taskId: string;
  keyword?: string;
};

export type TrafficPage = {
  traffic: TrafficRecord[];
  total: number;
  nextOffset: number | null;
};

const dbs = new Map<string, DatabaseSync>();

function dbPath(taskDir: string): string {
  return join(taskDir, "traffic", "index.sqlite");
}

export function openTrafficDb(taskDir: string): DatabaseSync {
  const key = join(taskDir);
  const cached = dbs.get(key);
  if (cached) return cached;
  const path = dbPath(taskDir);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const fresh = !existsSync(path);
  const db = new DatabaseSync(path);
  // auto_vacuum is only honored before the first table. New task DBs reclaim
  // pages after rolling deletes so index.sqlite does not keep the high-water mark.
  if (fresh) db.exec("PRAGMA auto_vacuum = INCREMENTAL");
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA busy_timeout = 3000");
  db.exec(`
    CREATE TABLE IF NOT EXISTS exchanges (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      intent_id TEXT,
      worker_id TEXT,
      method TEXT NOT NULL,
      url TEXT NOT NULL,
      host TEXT NOT NULL,
      path TEXT NOT NULL,
      status INTEGER NOT NULL,
      duration_ms INTEGER NOT NULL,
      started_at TEXT NOT NULL,
      req_headers_json TEXT NOT NULL,
      res_headers_json TEXT NOT NULL,
      req_sha256 TEXT,
      req_size INTEGER,
      req_type TEXT,
      res_sha256 TEXT,
      res_size INTEGER,
      res_type TEXT,
      req_preview TEXT NOT NULL DEFAULT '',
      res_preview TEXT NOT NULL DEFAULT '',
      finding_ids_json TEXT NOT NULL DEFAULT '[]'
    );
    CREATE INDEX IF NOT EXISTS idx_exchanges_task ON exchanges(task_id, started_at);
    CREATE INDEX IF NOT EXISTS idx_exchanges_noise ON exchanges(task_id, host, status, path);
    CREATE TABLE IF NOT EXISTS validate_jobs (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      finding_id TEXT NOT NULL,
      status TEXT NOT NULL,
      validation_id TEXT,
      qualification TEXT,
      traffic_ids_json TEXT NOT NULL DEFAULT '[]',
      packet_json TEXT NOT NULL DEFAULT '{}',
      error TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_validate_jobs_finding
      ON validate_jobs(task_id, finding_id, created_at);
  `);
  dbs.set(key, db);
  return db;
}

export function closeTrafficDb(taskDir: string): void {
  const key = join(taskDir);
  const db = dbs.get(key);
  if (!db) return;
  dbs.delete(key);
  insertsSinceCheck.delete(key);
  db.close();
}

function blobOf(sha: unknown, size: unknown, contentType: unknown): TrafficBlobRef | undefined {
  if (typeof sha !== "string" || !sha) return undefined;
  const ref: TrafficBlobRef = { sha256: sha, size: Number(size ?? 0) };
  if (typeof contentType === "string" && contentType) ref.contentType = contentType;
  return ref;
}

function rowToRecord(row: Record<string, unknown>): TrafficRecord {
  const findingIds = JSON.parse(String(row.finding_ids_json ?? "[]")) as string[];
  const record = {
    id: String(row.id),
    taskId: String(row.task_id),
    method: String(row.method),
    url: String(row.url),
    host: String(row.host),
    path: String(row.path),
    status: Number(row.status),
    durationMs: Number(row.duration_ms),
    startedAt: String(row.started_at),
    reqHeaders: JSON.parse(String(row.req_headers_json ?? "{}")) as TrafficRecord["reqHeaders"],
    resHeaders: JSON.parse(String(row.res_headers_json ?? "{}")) as TrafficRecord["resHeaders"],
    ...(typeof row.intent_id === "string" && row.intent_id ? { intentId: row.intent_id } : {}),
    ...(typeof row.worker_id === "string" && row.worker_id ? { workerId: row.worker_id } : {}),
    ...(blobOf(row.req_sha256, row.req_size, row.req_type) ? { reqBodyBlob: blobOf(row.req_sha256, row.req_size, row.req_type) } : {}),
    ...(blobOf(row.res_sha256, row.res_size, row.res_type) ? { resBodyBlob: blobOf(row.res_sha256, row.res_size, row.res_type) } : {}),
    ...(findingIds.length ? { findingIds } : {}),
  };
  return TrafficRecordSchema.parse(record);
}

function noiseCounts(db: DatabaseSync, input: TrafficWrite): { samePath404: number; host404: number } {
  if (input.status !== 404) return { samePath404: 0, host404: 0 };
  const same = db.prepare(
    `SELECT count(*) AS n FROM exchanges
     WHERE task_id = ? AND host = ? AND path = ? AND method = ? AND status = 404`,
  ).get(input.taskId, input.host, input.path, input.method) as { n: number };
  const host = db.prepare(
    `SELECT count(*) AS n FROM exchanges WHERE task_id = ? AND host = ? AND status = 404`,
  ).get(input.taskId, input.host) as { n: number };
  return { samePath404: Number(same.n), host404: Number(host.n) };
}

/** Inserts since the last lagged prune check, per task DB. */
const insertsSinceCheck = new Map<string, number>();

function pruneExchanges(db: DatabaseSync, cfg: TrafficRetentionConfig, protectId: string): number {
  if (cfg.maxExchanges <= 0) return 0;
  const total = Number((db.prepare("SELECT count(*) AS n FROM exchanges").get() as { n: number }).n);
  if (!trafficPruneDue(total, cfg.maxExchanges, cfg.pruneSlack)) return 0;
  const remove = trafficPruneCount(total, cfg.maxExchanges);
  if (remove <= 0) return 0;
  const info = db.prepare(
    `DELETE FROM exchanges
     WHERE id IN (
       SELECT id FROM exchanges
       WHERE id != ?
         AND (
           finding_ids_json = '[]'
           OR finding_ids_json = ''
           OR (json_valid(finding_ids_json) AND json_array_length(finding_ids_json) = 0)
         )
       ORDER BY started_at ASC, rowid ASC
       LIMIT ?
     )`,
  ).run(protectId, remove);
  const deleted = Number(info.changes ?? 0);
  if (deleted > 0 && cfg.vacuumPages > 0) {
    try {
      // Bounded: reclaim at most N pages per prune so the proxy hot path never
      // waits on a full-file vacuum.
      db.prepare(`PRAGMA incremental_vacuum(${Math.floor(cfg.vacuumPages)})`).all();
    } catch {
      /* databases created before auto_vacuum stay at their high-water size */
    }
  }
  return deleted;
}

/** Lagged prune: count + delete only once every `pruneCheckEvery` inserts. */
function maybePrune(taskDir: string, db: DatabaseSync, cfg: TrafficRetentionConfig, protectId: string): number {
  if (cfg.maxExchanges <= 0) return 0;
  const key = join(taskDir);
  const seen = (insertsSinceCheck.get(key) ?? 0) + 1;
  if (seen < Math.max(1, cfg.pruneCheckEvery)) {
    insertsSinceCheck.set(key, seen);
    return 0;
  }
  insertsSinceCheck.set(key, 0);
  return pruneExchanges(db, cfg, protectId);
}

/** Force one prune pass now (ignores the insert counter, honors slack). */
export function pruneTrafficNow(taskDir: string, retention?: Partial<TrafficRetentionConfig>): number {
  const db = openTrafficDb(taskDir);
  insertsSinceCheck.set(join(taskDir), 0);
  return pruneExchanges(db, resolveTrafficRetention(retention), "");
}

export function insertTraffic(
  taskDir: string,
  input: TrafficWrite,
  retention?: Partial<TrafficRetentionConfig>,
): TrafficRecord {
  const db = openTrafficDb(taskDir);
  const cfg = resolveTrafficRetention(retention);
  if (input.id) {
    // Ring promotion keeps the id the agent already saw; a second promote only links.
    const existing = getTraffic(taskDir, input.id);
    if (existing) {
      for (const findingId of input.findingIds ?? []) linkTrafficFinding(taskDir, input.id, findingId);
      return getTraffic(taskDir, input.id) ?? existing;
    }
  }
  const metadataOnly =
    (cfg.compactStaticAssets && isStaticAssetExchange(input))
    || isNoiseExchange(input, noiseCounts(db, input), cfg);
  const shaped = shapeTrafficWrite(input, cfg, metadataOnly);
  const id = input.id ?? randomUUID();
  db.prepare(
    `INSERT INTO exchanges (
      id, task_id, intent_id, worker_id, method, url, host, path, status, duration_ms, started_at,
      req_headers_json, res_headers_json, req_sha256, req_size, req_type, res_sha256, res_size, res_type,
      req_preview, res_preview, finding_ids_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    shaped.taskId,
    shaped.intentId ?? null,
    shaped.workerId ?? null,
    shaped.method,
    shaped.url,
    shaped.host,
    shaped.path,
    shaped.status,
    shaped.durationMs,
    shaped.startedAt,
    JSON.stringify(shaped.reqHeaders),
    JSON.stringify(shaped.resHeaders),
    shaped.reqBody?.sha256 ?? null,
    shaped.reqBody?.size ?? null,
    shaped.reqBody?.contentType ?? null,
    shaped.resBody?.sha256 ?? null,
    shaped.resBody?.size ?? null,
    shaped.resBody?.contentType ?? null,
    shaped.reqPreview ?? "",
    shaped.resPreview ?? "",
    JSON.stringify(shaped.findingIds ?? []),
  );
  const record = getTraffic(taskDir, id);
  maybePrune(taskDir, db, cfg, id);
  if (!record) throw new Error("traffic insert failed");
  return record;
}

export type StoredExchange = {
  id: string;
  reqPreview: string;
  resPreview: string;
  reqHeadersJson: string;
  resHeadersJson: string;
  findingIds: string[];
  startedAt: string;
};

export function readStoredExchange(taskDir: string, id: string): StoredExchange | null {
  const db = openTrafficDb(taskDir);
  const row = db.prepare(
    `SELECT id, req_preview, res_preview, req_headers_json, res_headers_json, finding_ids_json, started_at
     FROM exchanges WHERE id = ?`,
  ).get(id) as
    | {
      id: string;
      req_preview: string;
      res_preview: string;
      req_headers_json: string;
      res_headers_json: string;
      finding_ids_json: string;
      started_at: string;
    }
    | undefined;
  if (!row) return null;
  return {
    id: row.id,
    reqPreview: row.req_preview,
    resPreview: row.res_preview,
    reqHeadersJson: row.req_headers_json,
    resHeadersJson: row.res_headers_json,
    findingIds: JSON.parse(String(row.finding_ids_json ?? "[]")) as string[],
    startedAt: row.started_at,
  };
}

export function countTrafficExchanges(taskDir: string): number {
  const db = openTrafficDb(taskDir);
  return Number((db.prepare("SELECT count(*) AS n FROM exchanges").get() as { n: number }).n);
}

export function getTraffic(taskDir: string, id: string): TrafficRecord | null {
  const db = openTrafficDb(taskDir);
  const row = db.prepare("SELECT * FROM exchanges WHERE id = ?").get(id) as Record<string, unknown> | undefined;
  return row ? rowToRecord(row) : null;
}

export function linkTrafficFinding(taskDir: string, trafficId: string, findingId: string): void {
  const db = openTrafficDb(taskDir);
  const row = db.prepare("SELECT finding_ids_json FROM exchanges WHERE id = ?").get(trafficId) as
    | { finding_ids_json?: string }
    | undefined;
  if (!row) return;
  const ids = JSON.parse(String(row.finding_ids_json ?? "[]")) as string[];
  if (!ids.includes(findingId)) ids.push(findingId);
  db.prepare("UPDATE exchanges SET finding_ids_json = ? WHERE id = ?").run(JSON.stringify(ids), trafficId);
}

function like(value: string | undefined): string | null {
  const text = value?.trim();
  return text ? text : null;
}

export function queryTraffic(taskDir: string, query: TrafficQuery): TrafficPage {
  const parsed = TrafficSearchQuerySchema.parse(query);
  const db = openTrafficDb(taskDir);
  const keyword = like(query.keyword)?.toLowerCase() ?? null;
  const filters = {
    taskId: parsed.taskId,
    intentId: like(parsed.intentId),
    workerId: like(parsed.workerId),
    method: like(parsed.method)?.toUpperCase() ?? null,
    host: like(parsed.host)?.toLowerCase() ?? null,
    path: like(parsed.path),
    status: parsed.status ?? null,
    findingId: like(parsed.findingId),
    startedAfter: parsed.startedAfter ?? null,
    startedBefore: parsed.startedBefore ?? null,
    keyword,
  };
  const where = `
    WHERE task_id = @taskId
      AND (@intentId IS NULL OR intent_id = @intentId)
      AND (@workerId IS NULL OR worker_id = @workerId)
      AND (@method IS NULL OR method = @method)
      AND (@host IS NULL OR lower(host) = @host)
      AND (@path IS NULL OR path = @path)
      AND (@status IS NULL OR status = @status)
      AND (@findingId IS NULL OR instr(finding_ids_json, @findingId) > 0)
      AND (@startedAfter IS NULL OR started_at >= @startedAfter)
      AND (@startedBefore IS NULL OR started_at <= @startedBefore)
      AND (
        @keyword IS NULL OR instr(
          lower(url || char(10) || host || char(10) || path || char(10) || req_preview || char(10) || res_preview || char(10) || req_headers_json || char(10) || res_headers_json),
          @keyword
        ) > 0
      )`;
  const total = Number(
    (db.prepare(`SELECT count(*) AS n FROM exchanges ${where}`).get(filters) as { n: number }).n,
  );
  const rows = db.prepare(
    `SELECT * FROM exchanges ${where} ORDER BY started_at ASC, rowid ASC LIMIT @limit OFFSET @offset`,
  ).all({ ...filters, limit: parsed.limit, offset: parsed.offset }) as Array<Record<string, unknown>>;
  const traffic = rows.map(rowToRecord);
  const next = parsed.offset + traffic.length;
  return { traffic, total, nextOffset: next < total ? next : null };
}

export function queryFromSearchParams(taskDir: string, taskId: string, params: URLSearchParams): TrafficPage {
  const statusRaw = params.get("status");
  const query: TrafficQuery = {
    taskId,
    ...(params.get("intentId") ? { intentId: params.get("intentId")! } : {}),
    ...(params.get("workerId") ? { workerId: params.get("workerId")! } : {}),
    ...(params.get("method") ? { method: params.get("method")! } : {}),
    ...(params.get("host") ? { host: params.get("host")! } : {}),
    ...(params.get("path") ? { path: params.get("path")! } : {}),
    ...(params.get("findingId") ? { findingId: params.get("findingId")! } : {}),
    ...(params.get("startedAfter") ? { startedAfter: params.get("startedAfter")! } : {}),
    ...(params.get("startedBefore") ? { startedBefore: params.get("startedBefore")! } : {}),
    ...(params.get("keyword") ? { keyword: params.get("keyword")! } : {}),
    ...(statusRaw != null && statusRaw !== "" ? { status: Number(statusRaw) } : {}),
    ...(params.get("offset") != null ? { offset: Number(params.get("offset")) } : {}),
    ...(params.get("limit") != null ? { limit: Number(params.get("limit")) } : {}),
  };
  return queryTraffic(taskDir, query);
}

export type TrafficBodySlice = BlobSlice & {
  side: "req" | "res";
  contentType?: string;
  rawSize?: number;
  decodedEncoding?: string;
  body: string;
  evidenceRef: string;
};

export function readTrafficBody(
  taskDir: string,
  trafficId: string,
  side: "req" | "res",
  offset?: number,
  maxBytes?: number,
): TrafficBodySlice {
  const record = getTraffic(taskDir, trafficId);
  if (!record) throw Object.assign(new Error("traffic not found"), { status: 404 });
  const blob = side === "req" ? record.reqBodyBlob : record.resBodyBlob;
  if (!blob) throw Object.assign(new Error(`no ${side} body`), { status: 404 });
  const bounds = normalizeSlice(offset, maxBytes);
  const headers = side === "req" ? record.reqHeaders : record.resHeaders;
  if (hasSupportedContentEncoding(headers)) {
    const raw = readBlobBytes(taskDir, blob.sha256, MAX_COMPRESSED_BLOB_BYTES);
    const decoded = raw ? decodeTrafficBody(raw, headers) : null;
    if (decoded) {
      const end = Math.min(decoded.bytes.length, bounds.offset + bounds.maxBytes);
      const bytes = bounds.offset < decoded.bytes.length
        ? Buffer.from(decoded.bytes.subarray(bounds.offset, end))
        : Buffer.alloc(0);
      const next = bounds.offset + bytes.length;
      return {
        sha256: blob.sha256.trim().toLowerCase(),
        offset: bounds.offset,
        maxBytes: bounds.maxBytes,
        size: decoded.bytes.length,
        rawSize: blob.size,
        decodedEncoding: decoded.encoding,
        bytes,
        nextOffset: next < decoded.bytes.length ? next : null,
        side,
        ...(blob.contentType ? { contentType: blob.contentType } : {}),
        body: bytes.toString("utf8"),
        evidenceRef: `http:${record.id}`,
      };
    }
  }
  const slice = readBlobSlice(taskDir, blob.sha256, bounds.offset, bounds.maxBytes);
  return {
    ...slice,
    side,
    ...(blob.contentType ? { contentType: blob.contentType } : {}),
    body: slice.bytes.toString("utf8"),
    evidenceRef: `http:${record.id}`,
  };
}

export function trafficEvidenceRef(id: string): string {
  return `http:${id}`;
}

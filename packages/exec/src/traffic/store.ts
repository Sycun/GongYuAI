import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  TrafficRecordSchema,
  TrafficSearchQuerySchema,
  type TrafficBlobRef,
  type TrafficRecord,
  type TrafficSearchQuery,
} from "@gongyuai/contracts";
import { readBlobSlice, type BlobSlice } from "./blobs.js";

export type TrafficWrite = {
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
  mkdirSync(dirname(dbPath(taskDir)), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(dbPath(taskDir));
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

export function insertTraffic(taskDir: string, input: TrafficWrite): TrafficRecord {
  const db = openTrafficDb(taskDir);
  const id = randomUUID();
  db.prepare(
    `INSERT INTO exchanges (
      id, task_id, intent_id, worker_id, method, url, host, path, status, duration_ms, started_at,
      req_headers_json, res_headers_json, req_sha256, req_size, req_type, res_sha256, res_size, res_type,
      req_preview, res_preview, finding_ids_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    input.taskId,
    input.intentId ?? null,
    input.workerId ?? null,
    input.method,
    input.url,
    input.host,
    input.path,
    input.status,
    input.durationMs,
    input.startedAt,
    JSON.stringify(input.reqHeaders),
    JSON.stringify(input.resHeaders),
    input.reqBody?.sha256 ?? null,
    input.reqBody?.size ?? null,
    input.reqBody?.contentType ?? null,
    input.resBody?.sha256 ?? null,
    input.resBody?.size ?? null,
    input.resBody?.contentType ?? null,
    input.reqPreview ?? "",
    input.resPreview ?? "",
    JSON.stringify(input.findingIds ?? []),
  );
  return getTraffic(taskDir, id)!;
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
  const slice = readBlobSlice(taskDir, blob.sha256, offset, maxBytes);
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

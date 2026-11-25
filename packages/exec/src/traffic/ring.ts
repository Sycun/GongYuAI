import { createHash } from "node:crypto";
import { join } from "node:path";
import type { TrafficRecord } from "@gongyuai/contracts";
import { normalizeSlice, putBlob, type BlobSlice } from "./blobs.js";
import { capHeaders, resolveTrafficRetention, type TrafficRetentionConfig } from "./retention.js";
import {
  getTraffic,
  insertTraffic,
  linkTrafficFinding,
  queryTraffic,
  readTrafficBody,
  type TrafficBodySlice,
  type TrafficPage,
  type TrafficQuery,
  type TrafficWrite,
} from "./store.js";

/**
 * Finding-window ("black box") traffic retention.
 *
 * In `finding-window` mode the proxy keeps recent exchanges only in a bounded
 * per-task in-memory ring. Nothing reaches disk until a finding is recorded:
 * then the matching recent exchanges are promoted (pre-window) and a short
 * post-window persists the next few matching exchanges directly.
 */

export const TRAFFIC_RING_MAX = 300;
export const TRAFFIC_RING_BODY_BYTES = 64 * 1024;
export const TRAFFIC_PRE_WINDOW_MS = 5 * 60_000;
export const TRAFFIC_PRE_MAX_ITEMS = 25;
export const TRAFFIC_POST_WINDOW_MS = 5 * 60_000;
export const TRAFFIC_POST_MAX_ITEMS = 30;
/** After verify, a window converges to at most this many extra captures. */
export const TRAFFIC_CONFIRM_ITEMS = 5;
const RING_HEADERS_CHARS = 8192;
const NOISE_KEYS_MAX = 10_000;
export const TRUNCATED_HEADER = "x-gy-body-truncated";

function envInt(name: string, fallback: number, min: number): number {
  const raw = process.env[name];
  if (raw == null || raw.trim() === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? Math.max(min, Math.floor(n)) : fallback;
}

export type TrafficWindowConfig = {
  ringMax: number;
  ringBodyBytes: number;
  preWindowMs: number;
  preMaxItems: number;
  postWindowMs: number;
  postMaxItems: number;
};

export function trafficWindowDefaults(): TrafficWindowConfig {
  return {
    ringMax: envInt("GY_TRAFFIC_RING_MAX", TRAFFIC_RING_MAX, 1),
    ringBodyBytes: envInt("GY_TRAFFIC_RING_BODY_BYTES", TRAFFIC_RING_BODY_BYTES, 0),
    preWindowMs: envInt("GY_TRAFFIC_PRE_WINDOW_MS", TRAFFIC_PRE_WINDOW_MS, 0),
    preMaxItems: envInt("GY_TRAFFIC_PRE_MAX_ITEMS", TRAFFIC_PRE_MAX_ITEMS, 0),
    postWindowMs: envInt("GY_TRAFFIC_POST_WINDOW_MS", TRAFFIC_POST_WINDOW_MS, 0),
    postMaxItems: envInt("GY_TRAFFIC_POST_MAX_ITEMS", TRAFFIC_POST_MAX_ITEMS, 0),
  };
}

/** Body kept in memory: at most `ringBodyBytes` of head, plus true size and digest. */
export type CapturedBody = {
  head: Buffer;
  size: number;
  sha256: string;
  contentType?: string;
};

export type RingEntry = {
  id: string;
  atMs: number;
  write: Omit<TrafficWrite, "reqBody" | "resBody" | "findingIds" | "id">;
  reqBody?: CapturedBody;
  resBody?: CapturedBody;
  persisted: boolean;
};

type Ring = { entries: RingEntry[]; byId: Map<string, RingEntry> };

type PostWindow = {
  findingId: string;
  intentId?: string;
  host?: string;
  expiresAt: number;
  remaining: number;
};

const rings = new Map<string, Ring>();
const windows = new Map<string, Map<string, PostWindow>>();
const noise = new Map<string, { samePath: Map<string, number>; host: Map<string, number> }>();

function key(taskDir: string): string {
  return join(taskDir);
}

function ringOf(taskDir: string): Ring {
  const k = key(taskDir);
  let ring = rings.get(k);
  if (!ring) {
    ring = { entries: [], byId: new Map() };
    rings.set(k, ring);
  }
  return ring;
}

/** Push one exchange into the task ring. Oldest entries are dropped (memory freed). */
export function pushTrafficRing(
  taskDir: string,
  entry: Omit<RingEntry, "persisted" | "atMs"> & { atMs?: number },
  cfg: Partial<TrafficWindowConfig> = {},
): RingEntry {
  const max = cfg.ringMax ?? trafficWindowDefaults().ringMax;
  const ring = ringOf(taskDir);
  const stored: RingEntry = {
    ...entry,
    atMs: entry.atMs ?? Date.now(),
    write: {
      ...entry.write,
      reqHeaders: capHeaders(entry.write.reqHeaders, RING_HEADERS_CHARS),
      resHeaders: capHeaders(entry.write.resHeaders, RING_HEADERS_CHARS),
    },
    persisted: false,
  };
  ring.entries.push(stored);
  ring.byId.set(stored.id, stored);
  while (ring.entries.length > max) {
    const dropped = ring.entries.shift();
    if (dropped) ring.byId.delete(dropped.id);
  }
  return stored;
}

export function trafficRingSize(taskDir: string): number {
  return rings.get(key(taskDir))?.entries.length ?? 0;
}

export function getRingEntry(taskDir: string, id: string): RingEntry | undefined {
  return rings.get(key(taskDir))?.byId.get(id);
}

/** Drop the ring, post-windows and noise counters for one task (or all tasks). */
export function clearTrafficRing(taskDir?: string): void {
  if (taskDir == null) {
    rings.clear();
    windows.clear();
    noise.clear();
    return;
  }
  const k = key(taskDir);
  rings.delete(k);
  windows.delete(k);
  noise.delete(k);
}

/** In-memory 404 counters (counts before this exchange). Bounded key space. */
export function noteNoise404(
  taskDir: string,
  input: Pick<TrafficWrite, "status" | "host" | "path" | "method">,
): { samePath404: number; host404: number } {
  if (input.status !== 404) return { samePath404: 0, host404: 0 };
  const k = key(taskDir);
  let state = noise.get(k);
  if (!state) {
    state = { samePath: new Map(), host: new Map() };
    noise.set(k, state);
  }
  if (state.samePath.size > NOISE_KEYS_MAX) state.samePath.clear();
  if (state.host.size > NOISE_KEYS_MAX) state.host.clear();
  const pathKey = `${input.method.toUpperCase()} ${input.host.toLowerCase()} ${input.path}`;
  const hostKey = input.host.toLowerCase();
  const counts = {
    samePath404: state.samePath.get(pathKey) ?? 0,
    host404: state.host.get(hostKey) ?? 0,
  };
  state.samePath.set(pathKey, counts.samePath404 + 1);
  state.host.set(hostKey, counts.host404 + 1);
  return counts;
}

function blobRefOf(body: CapturedBody | undefined): TrafficRecord["reqBodyBlob"] | undefined {
  if (!body || body.size <= 0) return undefined;
  return { sha256: body.sha256, size: body.size, ...(body.contentType ? { contentType: body.contentType } : {}) };
}

/** Ring entry as a TrafficRecord. Blob refs carry the true size and digest. */
export function ringRecord(entry: RingEntry): TrafficRecord {
  const req = blobRefOf(entry.reqBody);
  const res = blobRefOf(entry.resBody);
  return {
    id: entry.id,
    taskId: entry.write.taskId,
    method: entry.write.method,
    url: entry.write.url,
    host: entry.write.host,
    path: entry.write.path,
    status: entry.write.status,
    durationMs: entry.write.durationMs,
    startedAt: entry.write.startedAt,
    reqHeaders: entry.write.reqHeaders,
    resHeaders: entry.write.resHeaders,
    ...(entry.write.intentId ? { intentId: entry.write.intentId } : {}),
    ...(entry.write.workerId ? { workerId: entry.write.workerId } : {}),
    ...(req ? { reqBodyBlob: req } : {}),
    ...(res ? { resBodyBlob: res } : {}),
  };
}

function previewOf(body: CapturedBody | undefined, max: number): string {
  if (!body || max <= 0) return "";
  return body.head.subarray(0, Math.min(8192, max)).toString("utf8");
}

function ringMatches(entry: RingEntry, query: TrafficQuery): boolean {
  const w = entry.write;
  if (w.taskId !== query.taskId) return false;
  if (query.intentId?.trim() && w.intentId !== query.intentId.trim()) return false;
  if (query.workerId?.trim() && w.workerId !== query.workerId.trim()) return false;
  if (query.method?.trim() && w.method.toUpperCase() !== query.method.trim().toUpperCase()) return false;
  if (query.host?.trim() && w.host.toLowerCase() !== query.host.trim().toLowerCase()) return false;
  if (query.path?.trim() && w.path !== query.path.trim()) return false;
  if (query.status != null && w.status !== query.status) return false;
  if (query.findingId?.trim()) return false;
  if (query.startedAfter && w.startedAt < query.startedAfter) return false;
  if (query.startedBefore && w.startedAt > query.startedBefore) return false;
  const keyword = query.keyword?.trim().toLowerCase();
  if (keyword) {
    const hay = [
      w.url,
      w.host,
      w.path,
      previewOf(entry.reqBody, 8192),
      previewOf(entry.resBody, 8192),
      JSON.stringify(w.reqHeaders),
      JSON.stringify(w.resHeaders),
    ].join("\n").toLowerCase();
    if (!hay.includes(keyword)) return false;
  }
  return true;
}

/** Ring-only (not yet persisted) records matching a query, oldest first. */
export function queryTrafficRing(taskDir: string, query: TrafficQuery): TrafficRecord[] {
  const ring = rings.get(key(taskDir));
  if (!ring) return [];
  return ring.entries
    .filter((entry) => !entry.persisted && ringMatches(entry, query))
    .map(ringRecord);
}

export type LiveTrafficPage = TrafficPage & {
  /** Ids served from the in-memory ring (not persisted yet). */
  hotIds: string[];
};

/**
 * Persisted rows plus hot ring rows (deduped by id). Hot rows come first so a
 * fresh exchange is visible on page one; then the index.sqlite rows.
 */
export function queryTrafficLive(taskDir: string, query: TrafficQuery): LiveTrafficPage {
  const offset = Math.max(0, Math.floor(query.offset ?? 0));
  const limit = Math.max(1, Math.min(200, Math.floor(query.limit ?? 50)));
  const hot = queryTrafficRing(taskDir, query);
  const hotPage = hot.slice(offset, offset + limit);
  const dbOffset = Math.max(0, offset - hot.length);
  const dbLimit = limit - hotPage.length;
  const db = queryTraffic(taskDir, { ...query, offset: dbOffset, limit: Math.max(1, dbLimit) });
  const hotIdSet = new Set(hotPage.map((row) => row.id));
  const dbRows = dbLimit > 0 ? db.traffic.filter((row) => !hotIdSet.has(row.id)) : [];
  const traffic = [...hotPage, ...dbRows];
  const total = hot.length + db.total;
  const next = offset + traffic.length;
  return { traffic, total, nextOffset: next < total ? next : null, hotIds: hotPage.map((row) => row.id) };
}

/** Persisted record first, then the ring. */
export function getTrafficLive(taskDir: string, id: string): TrafficRecord | null {
  const stored = getTraffic(taskDir, id);
  if (stored) return stored;
  const entry = getRingEntry(taskDir, id);
  return entry ? ringRecord(entry) : null;
}

export type LiveBodySlice = TrafficBodySlice & {
  /** True when served from memory and the body was longer than the buffered head. */
  truncated?: boolean;
  bufferedBytes?: number;
  source: "store" | "ring";
};

/** Body slice from blobs/ when persisted, else from the buffered ring head. */
export function readTrafficBodyLive(
  taskDir: string,
  trafficId: string,
  side: "req" | "res",
  offset?: number,
  maxBytes?: number,
): LiveBodySlice {
  if (getTraffic(taskDir, trafficId)) {
    return { ...readTrafficBody(taskDir, trafficId, side, offset, maxBytes), source: "store" };
  }
  const entry = getRingEntry(taskDir, trafficId);
  if (!entry) throw Object.assign(new Error("traffic not found"), { status: 404 });
  const body = side === "req" ? entry.reqBody : entry.resBody;
  if (!body || body.size <= 0) throw Object.assign(new Error(`no ${side} body`), { status: 404 });
  const bounds = normalizeSlice(offset, maxBytes);
  const end = Math.min(body.head.length, bounds.offset + bounds.maxBytes);
  const bytes = bounds.offset < body.head.length ? Buffer.from(body.head.subarray(bounds.offset, end)) : Buffer.alloc(0);
  const next = bounds.offset + bytes.length;
  const slice: BlobSlice = {
    sha256: body.sha256,
    offset: bounds.offset,
    maxBytes: bounds.maxBytes,
    size: body.size,
    bytes,
    nextOffset: next < body.head.length ? next : null,
  };
  return {
    ...slice,
    side,
    ...(body.contentType ? { contentType: body.contentType } : {}),
    body: bytes.toString("utf8"),
    evidenceRef: `http:${entry.id}`,
    truncated: body.size > body.head.length,
    bufferedBytes: body.head.length,
    source: "ring",
  };
}

function storedBody(
  taskDir: string,
  body: CapturedBody | undefined,
): { ref?: TrafficRecord["reqBodyBlob"]; truncated?: string } {
  if (!body || body.head.length === 0) return {};
  const ref = putBlob(taskDir, body.head, body.contentType);
  if (body.size <= body.head.length) return ref ? { ref } : {};
  return {
    ...(ref ? { ref } : {}),
    truncated: `size=${body.size} sha256=${body.sha256} kept=${body.head.length}`,
  };
}

/**
 * Persist a buffered exchange: head bytes to blobs/, metadata to index.sqlite
 * (same id as in the ring). A body longer than the buffer keeps its head and
 * notes the true size + digest in `x-gy-body-truncated-{req,res}`.
 */
export function persistCapturedExchange(
  taskDir: string,
  input: {
    id?: string;
    write: RingEntry["write"];
    reqBody?: CapturedBody;
    resBody?: CapturedBody;
    findingIds?: string[];
  },
  retention?: Partial<TrafficRetentionConfig>,
): TrafficRecord {
  const cfg = resolveTrafficRetention(retention);
  const req = storedBody(taskDir, input.reqBody);
  const res = storedBody(taskDir, input.resBody);
  const resHeaders = { ...input.write.resHeaders };
  if (req.truncated) resHeaders[`${TRUNCATED_HEADER}-req`] = req.truncated;
  if (res.truncated) resHeaders[`${TRUNCATED_HEADER}-res`] = res.truncated;
  return insertTraffic(taskDir, {
    ...input.write,
    ...(input.id ? { id: input.id } : {}),
    resHeaders,
    ...(req.ref ? { reqBody: req.ref } : {}),
    ...(res.ref ? { resBody: res.ref } : {}),
    reqPreview: previewOf(input.reqBody, cfg.maxPreviewChars),
    resPreview: previewOf(input.resBody, cfg.maxPreviewChars),
    ...(input.findingIds?.length ? { findingIds: input.findingIds } : {}),
  }, retention);
}

/** Lower-case hostname from a host, URL, or `host:port/path` string. */
export function targetHostOf(value: string | undefined | null): string | undefined {
  const raw = value?.trim();
  if (!raw) return undefined;
  try {
    const url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `http://${raw}`);
    return url.hostname.replace(/^\[|\]$/g, "").toLowerCase() || undefined;
  } catch {
    return undefined;
  }
}

/** Stable UUID for a non-UUID label (e.g. `tsecbench:<code_id>`), so it fits finding_ids. */
export function trafficLabelUuid(label: string): string {
  const hex = createHash("sha256").update(label).digest("hex");
  const variant = ((parseInt(hex[16]!, 16) & 0x3) | 0x8).toString(16);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

export type PromoteTrafficOptions = {
  findingId: string;
  intentId?: string | null;
  host?: string | null;
  /** URL or hostname; host is derived when `host` is not given. */
  asset?: string | null;
  trafficIds?: string[];
  preWindowMs?: number;
  preMaxItems?: number;
  postWindowMs?: number;
  postMaxItems?: number;
  /**
   * Verify path: an open window shrinks to at most `postMaxItems`
   * (default TRAFFIC_CONFIRM_ITEMS) more captures; a missing one opens that small.
   */
  converge?: boolean;
  retention?: Partial<TrafficRetentionConfig>;
  nowMs?: number;
};

export type PromoteTrafficResult = {
  findingId: string;
  /** Every persisted traffic id now linked to the finding. */
  trafficIds: string[];
  /** Ring entries written to disk by this call. */
  promoted: number;
  window: { expiresAt: string; remaining: number; intentId?: string; host?: string } | null;
};

/**
 * Pre-window promote + post-window open for one finding.
 *
 * Pre: explicit `trafficIds`, plus ring entries with the same `intentId` or the
 * same target host in the last `preWindowMs`, newest `preMaxItems`. They go to
 * blobs/ + index.sqlite linked to `findingId`.
 * Post: matching exchanges in the next `postWindowMs` (max `postMaxItems`) are
 * persisted directly by the proxy and linked to `findingId`.
 */
export function promoteTrafficForFinding(taskDir: string, opts: PromoteTrafficOptions): PromoteTrafficResult {
  const defaults = trafficWindowDefaults();
  const now = opts.nowMs ?? Date.now();
  const findingId = opts.findingId;
  const intentId = opts.intentId?.trim() || undefined;
  const host = targetHostOf(opts.host) ?? targetHostOf(opts.asset);
  const preWindowMs = opts.preWindowMs ?? defaults.preWindowMs;
  const preMaxItems = opts.preMaxItems ?? defaults.preMaxItems;
  const linked = new Set<string>();
  let promoted = 0;

  const persistEntry = (entry: RingEntry) => {
    if (entry.persisted || getTraffic(taskDir, entry.id)) {
      entry.persisted = true;
      linkTrafficFinding(taskDir, entry.id, findingId);
      linked.add(entry.id);
      return;
    }
    persistCapturedExchange(taskDir, {
      id: entry.id,
      write: entry.write,
      ...(entry.reqBody ? { reqBody: entry.reqBody } : {}),
      ...(entry.resBody ? { resBody: entry.resBody } : {}),
      findingIds: [findingId],
    }, opts.retention);
    entry.persisted = true;
    promoted += 1;
    linked.add(entry.id);
  };

  for (const id of opts.trafficIds ?? []) {
    const trimmed = id.trim().replace(/^http:/, "");
    if (!trimmed) continue;
    const entry = getRingEntry(taskDir, trimmed);
    if (entry) {
      persistEntry(entry);
    } else if (getTraffic(taskDir, trimmed)) {
      linkTrafficFinding(taskDir, trimmed, findingId);
      linked.add(trimmed);
    }
  }

  if ((intentId || host) && preMaxItems > 0) {
    const ring = rings.get(key(taskDir));
    const since = now - preWindowMs;
    const picks: RingEntry[] = [];
    for (let i = (ring?.entries.length ?? 0) - 1; i >= 0 && picks.length < preMaxItems; i -= 1) {
      const entry = ring!.entries[i]!;
      if (entry.atMs < since) break;
      const sameIntent = intentId != null && entry.write.intentId === intentId;
      const sameHost = host != null && entry.write.host.toLowerCase() === host;
      if (sameIntent || sameHost) picks.push(entry);
    }
    for (const entry of picks.reverse()) persistEntry(entry);
  }

  const window = openFindingWindow(taskDir, {
    findingId,
    ...(intentId ? { intentId } : {}),
    ...(host ? { host } : {}),
    ...(opts.postWindowMs != null ? { postWindowMs: opts.postWindowMs } : {}),
    ...(opts.postMaxItems != null ? { postMaxItems: opts.postMaxItems } : {}),
    ...(opts.converge ? { converge: true } : {}),
    nowMs: now,
  });

  return { findingId, trafficIds: [...linked], promoted, window };
}

/** Open (or converge) the post-window for a finding. Needs an intentId or host. */
export function openFindingWindow(
  taskDir: string,
  opts: {
    findingId: string;
    intentId?: string;
    host?: string;
    postWindowMs?: number;
    postMaxItems?: number;
    converge?: boolean;
    nowMs?: number;
  },
): PromoteTrafficResult["window"] {
  const defaults = trafficWindowDefaults();
  const now = opts.nowMs ?? Date.now();
  const intentId = opts.intentId?.trim() || undefined;
  const host = targetHostOf(opts.host);
  const k = key(taskDir);
  let byFinding = windows.get(k);
  if (!byFinding) {
    byFinding = new Map();
    windows.set(k, byFinding);
  }
  const existing = byFinding.get(opts.findingId);
  const ms = opts.postWindowMs ?? defaults.postWindowMs;
  if (opts.converge) {
    const cap = opts.postMaxItems ?? TRAFFIC_CONFIRM_ITEMS;
    if (existing && existing.expiresAt > now) {
      existing.remaining = Math.min(existing.remaining, cap);
      existing.expiresAt = Math.min(existing.expiresAt, now + ms);
      if (intentId && !existing.intentId) existing.intentId = intentId;
      if (host && !existing.host) existing.host = host;
    } else if (intentId || host) {
      byFinding.set(opts.findingId, {
        findingId: opts.findingId,
        ...(intentId ? { intentId } : {}),
        ...(host ? { host } : {}),
        expiresAt: now + ms,
        remaining: cap,
      });
    }
  } else if (intentId || host) {
    const max = opts.postMaxItems ?? defaults.postMaxItems;
    byFinding.set(opts.findingId, {
      findingId: opts.findingId,
      ...(intentId ? { intentId } : existing?.intentId ? { intentId: existing.intentId } : {}),
      ...(host ? { host } : existing?.host ? { host: existing.host } : {}),
      expiresAt: now + ms,
      remaining: max,
    });
  }
  const win = byFinding.get(opts.findingId);
  if (!win || win.remaining <= 0 || win.expiresAt <= now) {
    byFinding.delete(opts.findingId);
    return null;
  }
  return {
    expiresAt: new Date(win.expiresAt).toISOString(),
    remaining: win.remaining,
    ...(win.intentId ? { intentId: win.intentId } : {}),
    ...(win.host ? { host: win.host } : {}),
  };
}

export function closeFindingWindow(taskDir: string, findingId: string): boolean {
  return windows.get(key(taskDir))?.delete(findingId) ?? false;
}

/** Finding ids whose live post-window matches this exchange (does not consume). */
export function matchFindingWindows(
  taskDir: string,
  input: { intentId?: string | null; host: string },
  nowMs = Date.now(),
): string[] {
  const byFinding = windows.get(key(taskDir));
  if (!byFinding?.size) return [];
  const host = input.host.toLowerCase();
  const out: string[] = [];
  for (const [id, win] of byFinding) {
    if (win.expiresAt <= nowMs || win.remaining <= 0) {
      byFinding.delete(id);
      continue;
    }
    const sameIntent = win.intentId != null && input.intentId === win.intentId;
    const sameHost = win.host != null && win.host === host;
    if (sameIntent || sameHost) out.push(id);
  }
  return out;
}

/** Spend one capture slot on each window. Windows at zero close. */
export function consumeFindingWindows(taskDir: string, findingIds: string[]): void {
  const byFinding = windows.get(key(taskDir));
  if (!byFinding) return;
  for (const id of findingIds) {
    const win = byFinding.get(id);
    if (!win) continue;
    win.remaining -= 1;
    if (win.remaining <= 0) byFinding.delete(id);
  }
}

export function activeFindingWindows(
  taskDir: string,
  nowMs = Date.now(),
): Array<{ findingId: string; intentId?: string; host?: string; expiresAt: number; remaining: number }> {
  const byFinding = windows.get(key(taskDir));
  if (!byFinding) return [];
  return [...byFinding.values()]
    .filter((win) => win.expiresAt > nowMs && win.remaining > 0)
    .map((win) => ({ ...win }));
}

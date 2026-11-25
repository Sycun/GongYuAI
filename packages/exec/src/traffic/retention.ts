import type { TrafficWrite } from "./store.js";

/**
 * Traffic index retention.
 *
 * A 6h TSecBench run kept ~8 KiB of req_preview and ~8 KiB of res_preview on
 * every exchange. At that width, ~11k rows already fill ~178 MB and the
 * Console keyword scan walks all of it. Bodies stay in the content-addressed
 * blob store; the index only needs a short searchable preview plus metadata.
 *
 * Rows linked to finding_ids are never compacted and never deleted.
 */

export type TrafficRetentionConfig = {
  /** Max characters stored in req_preview and res_preview. 0 stores nothing. */
  maxPreviewChars: number;
  /** Max characters stored in each headers JSON column. */
  maxHeadersJsonChars: number;
  /**
   * Soft cap on exchanges for one task DB.
   * 0 disables rolling delete. Linked finding rows can push the table over the cap.
   */
  maxExchanges: number;
  /** GET/HEAD static assets (image/font/js/css, no response Set-Cookie) keep metadata only. */
  compactStaticAssets: boolean;
  /** Repeated 404s keep metadata only after the thresholds below. */
  compactNoise: boolean;
  /** Compact once this many identical method+host+path 404s already exist. */
  noiseRepeatAfter: number;
  /** Compact once this many 404s already exist for the host. */
  noiseHostThreshold: number;
  /**
   * Lagged prune: only count rows once every N inserts per task DB.
   * 1 restores the old check-on-every-insert behavior (tests only).
   */
  pruneCheckEvery: number;
  /** Only prune when the table exceeds maxExchanges + pruneSlack. */
  pruneSlack: number;
  /** Pages reclaimed per prune via bounded `PRAGMA incremental_vacuum(N)`. 0 skips vacuum. */
  vacuumPages: number;
};

export const TRAFFIC_PREVIEW_CHARS = 1024;
export const TRAFFIC_HEADERS_CHARS = 2048;
export const TRAFFIC_MAX_EXCHANGES = 8_000;
export const TRAFFIC_PRUNE_CHECK_EVERY = 200;
export const TRAFFIC_PRUNE_SLACK = 500;
export const TRAFFIC_VACUUM_PAGES = 200;

/**
 * `finding-window` (default): the proxy keeps traffic in a bounded in-memory
 * ring and only persists exchanges around a finding.
 * `all`: every non-static exchange goes to index.sqlite + blobs (debugging).
 */
export type TrafficMode = "finding-window" | "all";

export function resolveTrafficMode(raw: string | undefined = process.env.GY_TRAFFIC_MODE): TrafficMode {
  return raw?.trim().toLowerCase() === "all" ? "all" : "finding-window";
}

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw == null || raw.trim() === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.floor(n);
}

function envOn(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw == null || raw.trim() === "") return fallback;
  return !/^(0|false|off|no)$/i.test(raw.trim());
}

export function trafficRetentionDefaults(): TrafficRetentionConfig {
  return {
    maxPreviewChars: Math.max(0, envInt("GY_TRAFFIC_MAX_PREVIEW_CHARS", TRAFFIC_PREVIEW_CHARS)),
    maxHeadersJsonChars: Math.max(64, envInt("GY_TRAFFIC_MAX_HEADERS_CHARS", TRAFFIC_HEADERS_CHARS)),
    maxExchanges: Math.max(0, envInt("GY_TRAFFIC_MAX_EXCHANGES", TRAFFIC_MAX_EXCHANGES)),
    compactStaticAssets: envOn("GY_TRAFFIC_COMPACT_STATIC", true),
    compactNoise: envOn("GY_TRAFFIC_COMPACT_NOISE", true),
    noiseRepeatAfter: Math.max(1, envInt("GY_TRAFFIC_NOISE_REPEAT_AFTER", 1)),
    noiseHostThreshold: Math.max(1, envInt("GY_TRAFFIC_NOISE_HOST_THRESHOLD", 32)),
    pruneCheckEvery: Math.max(1, envInt("GY_TRAFFIC_PRUNE_CHECK_EVERY", TRAFFIC_PRUNE_CHECK_EVERY)),
    pruneSlack: Math.max(0, envInt("GY_TRAFFIC_PRUNE_SLACK", TRAFFIC_PRUNE_SLACK)),
    vacuumPages: Math.max(0, envInt("GY_TRAFFIC_VACUUM_PAGES", TRAFFIC_VACUUM_PAGES)),
  };
}

export function resolveTrafficRetention(
  partial?: Partial<TrafficRetentionConfig>,
): TrafficRetentionConfig {
  return { ...trafficRetentionDefaults(), ...partial };
}

const HEADER_VALUE_CAP = 240;
const HEADER_PRIORITY = [
  "content-type",
  "content-length",
  "location",
  "host",
  "server",
  "www-authenticate",
  "authorization",
  "cookie",
  "set-cookie",
];
const SLIM_HEADERS = new Set([
  "content-type",
  "content-length",
  "location",
  "host",
  "server",
  "cache-control",
  "etag",
]);

const STATIC_EXT = /\.(?:png|jpe?g|gif|webp|svg|ico|bmp|avif|woff2?|ttf|otf|eot|css|js|mjs|map)$/i;
const STATIC_TYPE = /^(?:image\/|font\/|text\/css\b|text\/javascript\b|application\/javascript\b|application\/x-javascript\b|application\/font-)/i;

export function headerValue(
  headers: Record<string, string | string[]>,
  name: string,
): string {
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() !== name) continue;
    const raw = Array.isArray(value) ? value[0] : value;
    return String(raw ?? "");
  }
  return "";
}

function contentType(headers: Record<string, string | string[]>): string {
  return headerValue(headers, "content-type").split(";")[0]?.trim().toLowerCase() ?? "";
}

function hasFinding(input: TrafficWrite): boolean {
  return (input.findingIds ?? []).some((id) => id.trim().length > 0);
}

function responseSetsState(input: TrafficWrite): boolean {
  return headerValue(input.resHeaders, "set-cookie").trim().length > 0;
}

/** Successful static fetches that do not set a cookie. API and HTML stay full. */
export function isStaticAssetExchange(input: TrafficWrite): boolean {
  if (hasFinding(input) || responseSetsState(input)) return false;
  const method = input.method.toUpperCase();
  if (method !== "GET" && method !== "HEAD") return false;
  if (![200, 204, 301, 302, 304].includes(input.status)) return false;
  const type = contentType(input.resHeaders);
  if (type && /json|html|xml|graphql|text\/plain|problem\+/.test(type)) return false;
  const pathOnly = (input.path.split("?")[0] ?? input.path).toLowerCase();
  if (pathOnly.includes("/api/") || pathOnly.includes("graphql")) return false;
  if (type && STATIC_TYPE.test(type)) return true;
  if (STATIC_EXT.test(pathOnly) && (!type || STATIC_TYPE.test(type) || type === "application/octet-stream")) {
    return true;
  }
  return false;
}

export function isNoiseExchange(
  input: TrafficWrite,
  counts: { samePath404: number; host404: number },
  cfg: TrafficRetentionConfig,
): boolean {
  if (!cfg.compactNoise || hasFinding(input) || responseSetsState(input)) return false;
  if (input.status !== 404) return false;
  if (counts.samePath404 >= cfg.noiseRepeatAfter) return true;
  return counts.host404 >= cfg.noiseHostThreshold;
}

function clip(value: string, max: number): string {
  if (max <= 0) return "";
  return value.length <= max ? value : value.slice(0, max);
}

function usablePreview(text: string, contentTypeName: string, maxChars: number): string {
  if (maxChars <= 0 || !text) return "";
  if (/^(image|audio|video|font)\//.test(contentTypeName)) return "";
  if (/^application\/(octet-stream|zip|gzip|pdf|wasm|x-font|font)/.test(contentTypeName)) return "";
  const sample = text.slice(0, 256);
  let bad = 0;
  for (let i = 0; i < sample.length; i += 1) {
    const c = sample.charCodeAt(i);
    if (c === 0xfffd || c === 0 || (c < 32 && c !== 9 && c !== 10 && c !== 13)) bad += 1;
  }
  if (sample.length > 0 && bad / sample.length > 0.3) return "";
  return clip(text, maxChars);
}

function clipHeaderMap(
  headers: Record<string, string | string[]>,
): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  for (const [key, value] of Object.entries(headers)) {
    out[key] = Array.isArray(value)
      ? value.map((item) => clip(String(item), HEADER_VALUE_CAP))
      : clip(String(value), HEADER_VALUE_CAP);
  }
  return out;
}

export function capHeaders(
  headers: Record<string, string | string[]>,
  maxChars: number,
): Record<string, string | string[]> {
  const full = clipHeaderMap(headers);
  if (JSON.stringify(full).length <= maxChars) return full;
  const keys = Object.keys(full).sort((a, b) => {
    const ra = HEADER_PRIORITY.indexOf(a.toLowerCase());
    const rb = HEADER_PRIORITY.indexOf(b.toLowerCase());
    const pa = ra === -1 ? HEADER_PRIORITY.length : ra;
    const pb = rb === -1 ? HEADER_PRIORITY.length : rb;
    return pa - pb || a.localeCompare(b);
  });
  const kept: Record<string, string | string[]> = {};
  for (const key of keys) {
    const value = full[key];
    if (value == null) continue;
    const next = { ...kept, [key]: value };
    if (JSON.stringify(next).length > maxChars) continue;
    kept[key] = value;
  }
  return kept;
}

function slimHeaders(
  headers: Record<string, string | string[]>,
  maxChars: number,
): Record<string, string | string[]> {
  const slim: Record<string, string | string[]> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (!SLIM_HEADERS.has(key.toLowerCase())) continue;
    slim[key] = value;
  }
  return capHeaders(slim, maxChars);
}

export function shapeTrafficWrite(
  input: TrafficWrite,
  cfg: TrafficRetentionConfig,
  metadataOnly: boolean,
): TrafficWrite {
  if (metadataOnly && !hasFinding(input)) {
    return {
      ...input,
      reqPreview: "",
      resPreview: "",
      reqHeaders: slimHeaders(input.reqHeaders, cfg.maxHeadersJsonChars),
      resHeaders: slimHeaders(input.resHeaders, cfg.maxHeadersJsonChars),
    };
  }
  return {
    ...input,
    reqPreview: usablePreview(input.reqPreview ?? "", contentType(input.reqHeaders), cfg.maxPreviewChars),
    resPreview: usablePreview(input.resPreview ?? "", contentType(input.resHeaders), cfg.maxPreviewChars),
    reqHeaders: capHeaders(input.reqHeaders, cfg.maxHeadersJsonChars),
    resHeaders: capHeaders(input.resHeaders, cfg.maxHeadersJsonChars),
  };
}

/** True once the table is past the soft cap plus the lag slack. */
export function trafficPruneDue(total: number, maxExchanges: number, slack: number): boolean {
  return maxExchanges > 0 && total > maxExchanges + Math.max(0, slack);
}

/** How many oldest unlinked rows to drop so the table sits at 90% of the soft cap. */
export function trafficPruneCount(total: number, maxExchanges: number): number {
  if (maxExchanges <= 0 || total <= maxExchanges) return 0;
  const low = Math.max(1, Math.floor(maxExchanges * 0.9));
  return Math.max(0, total - low);
}

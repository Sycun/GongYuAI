import type { TrafficRecord } from "@gongyuai/contracts";

export type TrafficHeaders = Record<string, string | string[]>;

export function httpStatusColor(status: number): "green" | "blue" | "orange" | "red" | "grey" {
  if (status >= 200 && status < 300) return "green";
  if (status >= 300 && status < 400) return "blue";
  if (status >= 400 && status < 500) return "orange";
  if (status >= 500) return "red";
  return "grey";
}

export function formatDuration(ms: number): string {
  if (ms >= 1000) return `${(ms / 1000).toFixed(2)} s`;
  return `${ms} ms`;
}

export function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${bytes} B`;
}

/** 根据服务端返回的切片偏移与长度计算累计已加载字节数，避免非 UTF-8 替换字符膨胀。 */
export function sliceLoadedBytes(payload: {
  offset: number;
  size: number;
  nextOffset: number | null;
  byteLength?: number;
}): number {
  if (typeof payload.byteLength === "number" && payload.byteLength >= 0) {
    return Math.min(payload.size, Math.max(0, payload.offset + payload.byteLength));
  }
  if (payload.nextOffset != null) {
    return Math.min(payload.size, Math.max(0, payload.nextOffset));
  }
  return Math.max(0, payload.size);
}

export function formatBodyProgress(chunk: {
  loadedBytes: number;
  size: number;
  rawSize?: number;
  decodedEncoding?: string;
}): string {
  const loaded = Math.min(chunk.size, Math.max(0, chunk.loadedBytes));
  const base = `${formatBytes(loaded)} / ${formatBytes(chunk.size)}`;
  if (chunk.decodedEncoding && chunk.rawSize != null) {
    return `${base}（${chunk.decodedEncoding} 解压，原始 ${formatBytes(chunk.rawSize)}）`;
  }
  return base;
}

function headerLines(headers: TrafficHeaders): string[] {
  return Object.entries(headers).map(([key, value]) =>
    `${key}: ${Array.isArray(value) ? value.join(", ") : value}`);
}

/** 请求行 + 头 + 空行 + 体；Host 缺失时按 url 补全。 */
export function buildRawRequest(record: TrafficRecord, body: string): string {
  const headers = { ...record.reqHeaders };
  if (!Object.keys(headers).some((key) => key.toLowerCase() === "host")) {
    headers.Host = record.host;
  }
  const head = `${record.method} ${record.path} HTTP/1.1\r\n${headerLines(headers).join("\r\n")}\r\n\r\n`;
  return head + body;
}

export function buildRawResponse(record: TrafficRecord, body: string): string {
  const head = `HTTP/1.1 ${record.status}\r\n${headerLines(record.resHeaders).join("\r\n")}\r\n\r\n`;
  return head + body;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** 复现 cURL：方法 + URL + 头 + 体；GET 无体时省略 --data-raw。 */
export function buildCurl(record: TrafficRecord, body: string): string {
  const parts = ["curl", "-sS"];
  if (record.method.toUpperCase() !== "GET") parts.push("-X", record.method.toUpperCase());
  parts.push(shellQuote(record.url));
  const headers = { ...record.reqHeaders };
  if (!Object.keys(headers).some((key) => key.toLowerCase() === "host")) {
    headers.Host = record.host;
  }
  for (const line of headerLines(headers)) parts.push("-H", shellQuote(line));
  if (body) parts.push("--data-raw", shellQuote(body));
  return parts.join(" ");
}

/** 关键字在 method/url/host/path/头里本地匹配（大小写不敏感）。 */
export function matchKeyword(record: TrafficRecord, keyword: string): boolean {
  const needle = keyword.trim().toLowerCase();
  if (!needle) return true;
  const haystack = [
    record.method, record.url, record.host, record.path, String(record.status),
    ...headerLines(record.reqHeaders), ...headerLines(record.resHeaders),
  ].join("\n").toLowerCase();
  return haystack.includes(needle);
}

export const HTTP_METHODS = ["GET", "POST", "PUT", "DELETE", "PATCH", "HEAD", "OPTIONS"];
export const STATUS_CLASSES = [
  { value: "2", label: "2xx 成功" },
  { value: "3", label: "3xx 重定向" },
  { value: "4", label: "4xx 客户端错误" },
  { value: "5", label: "5xx 服务端错误" },
];
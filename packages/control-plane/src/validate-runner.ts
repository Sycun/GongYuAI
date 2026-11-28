import { randomUUID } from "node:crypto";
import { request as httpRequest } from "node:http";
import { connect as netConnect, isIP } from "node:net";
import { connect as tlsConnect } from "node:tls";
import { DatabaseSync } from "node:sqlite";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  type Finding,
  type FindingQualification,
  type FindingValidateRunResponse,
  type PivotPolicy,
  type TrafficRecord,
} from "@gongyuai/contracts";
import {
  MAX_COMPRESSED_BLOB_BYTES,
  decodeTrafficPreview,
  hasSupportedContentEncoding,
  hostScopeAllows,
  linkTrafficFinding,
  loadHttpSessions,
  openTrafficDb,
  queryTraffic,
  readBlobBytes,
  readBlobSlice,
  startTrafficProxy,
  type TrafficProxy,
} from "@gongyuai/exec";
import { openHistory, writeEvidenceFile } from "@gongyuai/history";

/** Dark-Moon honesty scale. A higher claim is clamped down to what the replay showed. */
export const DARK_MOON_RUBRIC = {
  exploited: "完整危害证明：响应中出现请求里没有的敏感数据、密钥或越权对象。回显和泛化报错不能升为 exploited。",
  confirmed: "主动验证确认漏洞存在（例如明确的数据库报错），但还没有完整危害证明。",
  unconfirmed: "没有复现流量、只是回显、只有泛化错误，或无法在任务坐标内重放。",
} as const;

const HARM = [
  /root:x:0:0:/,
  /-----BEGIN (?:RSA |OPENSSH )?PRIVATE KEY-----/,
  /AKIA[0-9A-Z]{16}/,
];

const EXISTENCE = [
  /you have an error in your sql syntax/i,
  /ORA-\d{5}/,
  /PostgreSQL.*ERROR/i,
  /sqlite3\.OperationalError/i,
  /Unclosed quotation mark/i,
  /XPATH syntax error/i,
];

const RANK: Record<FindingQualification, number> = { unconfirmed: 0, confirmed: 1, exploited: 2 };

export type ValidatorPacket = {
  version: 1;
  role: "validator";
  independent: true;
  isolatedFrom: ["explorer-messages", "compaction", "relay"];
  task: { id: string; targets: string[] };
  finding: {
    id: string;
    title: string;
    asset: string;
    endpoint: string | null;
    vulnClass: string;
    repro: string;
    pocCurl: string;
    impact: string;
  };
  expectedSignals: typeof DARK_MOON_RUBRIC;
};

export class ValidationBusyError extends Error {
  readonly jobId: string;
  constructor(jobId: string) {
    super("validation already running");
    this.name = "ValidationBusyError";
    this.jobId = jobId;
  }
}

const inflight = new Map<string, string>();

function flightKey(taskId: string, findingId: string): string {
  return `${taskId}:${findingId}`;
}

/** New session packet. Only the listed finding fields are copied; dialogue is not an input. */
export function buildValidatorPacket(input: {
  taskId: string;
  targets: readonly string[];
  finding: Pick<Finding, "id" | "title" | "asset" | "endpoint" | "vulnClass" | "repro" | "impact"> & {
    pocCurl?: string | null;
  };
}): ValidatorPacket {
  const finding = input.finding;
  return {
    version: 1,
    role: "validator",
    independent: true,
    isolatedFrom: ["explorer-messages", "compaction", "relay"],
    task: { id: input.taskId, targets: [...input.targets] },
    finding: {
      id: finding.id,
      title: finding.title,
      asset: finding.asset,
      endpoint: finding.endpoint ?? null,
      vulnClass: finding.vulnClass,
      repro: finding.repro ?? "",
      pocCurl: finding.pocCurl ?? "",
      impact: finding.impact ?? "",
    },
    expectedSignals: DARK_MOON_RUBRIC,
  };
}

function novel(pattern: RegExp, response: string, request: string): boolean {
  const hit = pattern.exec(response);
  if (!hit) return false;
  return !request.includes(hit[0]);
}

function dataRecord(response: string, request: string): boolean {
  const email = response.match(/"email"\s*:\s*"([^"]+)"/);
  if (!email?.[1] || request.includes(email[1])) return false;
  return /"role"\s*:|"password"\s*:|"token"\s*:/.test(response);
}

function distinctive(request: string): string | null {
  const marked = request.match(/alert\(1\)|union\s+select|<script>|'\s*or\s*'1'/i);
  if (marked) return marked[0];
  const query = request.match(/[?&](?:q|payload|id)=([^&\s]+)/i);
  if (!query?.[1] || query[1].length < 4) return null;
  try {
    return decodeURIComponent(query[1]);
  } catch {
    return query[1];
  }
}

function isEcho(request: string, response: string): boolean {
  const payload = distinctive(request);
  if (!payload || !response.includes(payload)) return false;
  return response.split(payload).join("").replace(/\s+/g, "").length < 80;
}

/** Clamp any claimed grade to what the replay actually supports. */
export function gradeDarkMoon(input: {
  requestText: string;
  responseText: string;
  status: number;
  claimed?: FindingQualification | null;
}): { qualification: FindingQualification; reason: string } {
  const request = input.requestText;
  const response = input.responseText;
  let ceiling: FindingQualification = "unconfirmed";
  let reason = "没有可复核的响应，不能升格。";
  if (input.status > 0 && response.trim()) {
    if (HARM.some((pattern) => novel(pattern, response, request)) || dataRecord(response, request)) {
      ceiling = "exploited";
      reason = "响应里出现请求中没有的敏感数据或越权对象，构成完整危害证明。";
    } else if (isEcho(request, response)) {
      ceiling = "unconfirmed";
      reason = "响应只是请求载荷的回显，拒绝升为 exploited 或 confirmed。";
    } else if (EXISTENCE.some((pattern) => pattern.test(response))) {
      ceiling = "confirmed";
      reason = "主动验证看到明确的漏洞特征，但还没有完整危害证明。";
    } else {
      ceiling = "unconfirmed";
      reason = "响应只有泛化错误或弱信号，拒绝升格。";
    }
  }
  const claimed = input.claimed && RANK[input.claimed] !== undefined ? input.claimed : ceiling;
  const qualification = RANK[claimed] > RANK[ceiling] ? ceiling : claimed;
  if (input.claimed && qualification !== input.claimed) {
    reason = `申报 ${input.claimed} 被压到 ${qualification}：${reason}`;
  }
  return { qualification, reason };
}

function urlsIn(text: string): string[] {
  return text.match(/https?:\/\/[^\s"'<>]+/g) ?? [];
}

function replayUrl(packet: ValidatorPacket): URL | null {
  const candidates = [packet.finding.endpoint, ...urlsIn(packet.finding.repro), ...urlsIn(packet.finding.pocCurl)];
  for (const raw of candidates) {
    if (!raw) continue;
    try {
      const url = new URL(raw);
      if (url.protocol === "http:" || url.protocol === "https:") return url;
    } catch {
      /* not a URL */
    }
  }
  return null;
}

export type ValidatorScopeAuth = {
  targets: string[];
  outOfScope?: string[];
  pivotPolicy?: PivotPolicy;
};

/** Merge static task auth with the dynamic admission sidecars under the task directory. */
export function loadEffectiveValidatorAuth(
  taskDir: string,
  base: { targets: readonly string[]; outOfScope?: readonly string[]; pivotPolicy?: PivotPolicy | null },
): ValidatorScopeAuth {
  const targets = [...base.targets];
  for (const name of ["admitted-targets.json", "tsecbench-targets.json"]) {
    const path = join(taskDir, name);
    if (!existsSync(path)) continue;
    try {
      const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
      if (!Array.isArray(parsed)) continue;
      for (const item of parsed) {
        if (typeof item === "string" && item.trim()) targets.push(item.trim());
      }
    } catch {
      /* ignore unreadable sidecar */
    }
  }
  const pivotPolicy = base.pivotPolicy
    ?? (existsSync(join(taskDir, "admitted-pivot.json"))
      ? { mode: "foothold-private" as const, cidrs: [] as string[] }
      : undefined);
  return {
    targets: [...new Set(targets)],
    ...(base.outOfScope?.length ? { outOfScope: [...base.outOfScope] } : {}),
    ...(pivotPolicy ? { pivotPolicy } : {}),
  };
}

export function validatorHostAllowed(url: URL, auth: ValidatorScopeAuth, taskDir?: string): boolean {
  const host = url.hostname.toLowerCase();
  if (host === "127.0.0.1" || host === "localhost" || host === "::1") return true;
  return hostScopeAllows(
    {
      targets: auth.targets,
      outOfScope: auth.outOfScope ?? [],
      ...(auth.pivotPolicy ? { pivotPolicy: auth.pivotPolicy } : {}),
    },
    host,
    { dataDir: taskDir },
  );
}

function replayMethod(packet: ValidatorPacket): string {
  return /^\s*POST\b/i.test(packet.finding.repro) ? "POST" : "GET";
}

function tokenizeCurl(input: string): string[] {
  const tokens: string[] = [];
  let i = 0;
  const src = input.trim();
  while (i < src.length) {
    while (i < src.length && /\s/.test(src[i]!)) i += 1;
    if (i >= src.length) break;
    const quote = src[i];
    if (quote === "'" || quote === "\"") {
      i += 1;
      let buf = "";
      while (i < src.length && src[i] !== quote) {
        if (quote === "\"" && src[i] === "\\" && i + 1 < src.length) {
          buf += src[i + 1];
          i += 2;
          continue;
        }
        buf += src[i];
        i += 1;
      }
      if (src[i] === quote) i += 1;
      tokens.push(buf);
      continue;
    }
    let buf = "";
    while (i < src.length && !/\s/.test(src[i]!)) {
      buf += src[i];
      i += 1;
    }
    tokens.push(buf);
  }
  return tokens;
}

function absorbCurlHeader(headers: Record<string, string>, raw: string): void {
  const idx = raw.indexOf(":");
  if (idx <= 0) return;
  const name = raw.slice(0, idx).trim();
  const value = raw.slice(idx + 1).trim();
  if (!name || value === "<redacted>") return;
  headers[name] = value;
}

/** Pull method, headers, and body out of a `pocCurl` string. Redacted headers are dropped. */
export function parsePocCurl(pocCurl: string): { method?: string; headers: Record<string, string>; body?: string } {
  const tokens = tokenizeCurl(pocCurl);
  let method: string | undefined;
  const headers: Record<string, string> = {};
  const dataParts: string[] = [];
  const take = (index: number) => tokens[index + 1] ?? "";
  for (let i = 0; i < tokens.length; i += 1) {
    const tok = tokens[i]!;
    if (tok === "-X" || tok === "--request") {
      method = take(i).toUpperCase();
      i += 1;
      continue;
    }
    if (tok.startsWith("--request=")) {
      method = tok.slice("--request=".length).toUpperCase();
      continue;
    }
    if (tok === "-H" || tok === "--header") {
      absorbCurlHeader(headers, take(i));
      i += 1;
      continue;
    }
    if (tok.startsWith("--header=")) {
      absorbCurlHeader(headers, tok.slice("--header=".length));
      continue;
    }
    if (tok === "-d" || tok === "--data" || tok === "--data-raw" || tok === "--data-binary") {
      dataParts.push(take(i));
      i += 1;
      continue;
    }
    if (tok.startsWith("--data=") || tok.startsWith("--data-raw=") || tok.startsWith("--data-binary=")) {
      dataParts.push(tok.slice(tok.indexOf("=") + 1));
    }
  }
  return {
    ...(method ? { method } : {}),
    headers,
    ...(dataParts.length ? { body: dataParts.join("&") } : {}),
  };
}

function supplementSessionCookie(taskDir: string, host: string, headers: Record<string, string>): void {
  if (Object.keys(headers).some((name) => name.toLowerCase() === "cookie")) return;
  try {
    const store = loadHttpSessions(taskDir);
    const want = host.toLowerCase();
    const candidates: Array<{ session: string; cookies: Record<string, string> }> = [];
    for (const [sessionName, hosts] of Object.entries(store)) {
      for (const [name, state] of Object.entries(hosts ?? {})) {
        if (name.toLowerCase() !== want) continue;
        if (Object.keys(state.cookies).length > 0) {
          candidates.push({ session: sessionName, cookies: state.cookies });
        }
      }
    }
    if (candidates.length === 0) return;
    // Never blindly merge distinct role jars (e.g. userA + admin) onto an IDOR/BFLA replay:
    // use the jar when unambiguous (single session) or when an explicit `default` jar exists.
    const chosen =
      candidates.length === 1
        ? candidates[0]!.cookies
        : candidates.find((c) => c.session === "default")?.cookies;
    if (!chosen) return;
    const pairs = Object.entries(chosen);
    if (pairs.length) headers.Cookie = pairs.map(([name, value]) => `${name}=${value}`).join("; ");
  } catch {
    /* missing or unreadable jar: keep the original request */
  }
}

export type EvidenceChainStep = {
  id: string;
  method: string;
  url: string;
  headers: Record<string, string>;
  body?: string;
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Ordered evidence chain of a finding: `http:<id>` refs first (author-declared
 * order), then any linked `trafficIds`. Boundary is the caller's (≤4 steps).
 */
export function collectEvidenceChain(
  finding: Pick<Finding, "evidence" | "trafficIds">,
): string[] {
  const ids: string[] = [];
  const push = (raw: string): void => {
    const id = raw.trim().replace(/^http:/, "");
    if (UUID_RE.test(id) && !ids.includes(id)) ids.push(id);
  };
  for (const item of finding.evidence ?? []) {
    if (String(item.path).startsWith("http:")) push(String(item.path));
  }
  for (const id of finding.trafficIds ?? []) push(String(id));
  return ids;
}

/** Load recorded requests for chain replay from the task traffic store. */
export function loadEvidenceChainSteps(
  taskDir: string,
  taskId: string,
  ids: readonly string[],
): EvidenceChainStep[] {
  const db = openTrafficDb(taskDir);
  const stmt = db.prepare(
    `SELECT id, method, url, req_headers_json, req_sha256, req_size
     FROM exchanges WHERE task_id = ? AND id = ?`,
  );
  const steps: EvidenceChainStep[] = [];
  for (const id of ids) {
    const row = stmt.get(taskId, id) as Record<string, unknown> | undefined;
    if (!row) continue;
    let url: URL;
    try {
      url = new URL(String(row.url));
    } catch {
      continue;
    }
    const headers: Record<string, string> = {};
    try {
      const parsed = JSON.parse(String(row.req_headers_json ?? "{}")) as Record<string, unknown>;
      for (const [name, value] of Object.entries(parsed)) {
        if (typeof value === "string") headers[name] = value;
        else if (Array.isArray(value)) headers[name] = value.map(String).join(", ");
      }
    } catch {
      /* malformed recorded headers: replay with defaults */
    }
    for (const name of Object.keys(headers)) {
      if (["content-length", "connection", "transfer-encoding"].includes(name.toLowerCase())) {
        delete headers[name];
      }
    }
    let body: string | undefined;
    const sha = typeof row.req_sha256 === "string" && row.req_sha256 ? row.req_sha256 : null;
    const size = Number(row.req_size ?? 0);
    if (sha && size > 0) {
      try {
        body = readBlobSlice(taskDir, sha, 0, Math.min(size, 64 * 1024)).bytes.toString("utf8");
      } catch {
        body = undefined;
      }
    }
    steps.push({
      id,
      method: String(row.method).toUpperCase(),
      url: url.href,
      headers,
      ...(body ? { body } : {}),
    });
  }
  return steps;
}

/** host → (cookie name → value); replay-local, never touches exploration jars. */
type CookieJar = Map<string, Map<string, string>>;

function cookiePairs(header: string): Array<[string, string]> {
  const pairs: Array<[string, string]> = [];
  for (const part of header.split(";")) {
    const item = part.trim();
    if (!item) continue;
    const idx = item.indexOf("=");
    if (idx <= 0) continue;
    pairs.push([item.slice(0, idx).trim(), item.slice(idx + 1).trim()]);
  }
  return pairs;
}

function absorbSetCookie(jar: CookieJar, host: string, capture: ReplayCapture): void {
  const raw = capture.headers["set-cookie"];
  const cookies = Array.isArray(raw) ? raw : raw ? [raw] : [];
  if (!cookies.length) return;
  const bucket = jar.get(host) ?? new Map<string, string>();
  for (const cookie of cookies) {
    const pair = cookiePairs(String(cookie).split(";")[0] ?? "")[0];
    if (pair) bucket.set(pair[0], pair[1]);
  }
  jar.set(host, bucket);
}

function withJarCookies(step: EvidenceChainStep, jar: CookieJar, target: URL): Record<string, string> {
  const headers: Record<string, string> = { ...step.headers };
  const existingName = Object.keys(headers).find((name) => name.toLowerCase() === "cookie");
  const merged = new Map<string, string>();
  if (existingName) {
    for (const [name, value] of cookiePairs(String(headers[existingName]))) merged.set(name, value);
    delete headers[existingName];
  }
  for (const [name, value] of jar.get(target.hostname.toLowerCase()) ?? []) {
    merged.set(name, value);
  }
  if (merged.size) {
    headers.Cookie = [...merged.entries()].map(([name, value]) => `${name}=${value}`).join("; ");
  }
  if (step.body != null && !hasHeader(headers, "content-length")) {
    headers["Content-Length"] = String(Buffer.byteLength(step.body));
  }
  return headers;
}

type ChainReplayResult = {
  capture: ReplayCapture | null;
  finalUrl: URL | null;
  finalUsedTunnel: boolean;
  replayed: number;
  skipped: number;
  tunnelIds: string[];
};

/**
 * Replay 2–4 recorded requests in causal order through the validator's own
 * proxy session, carrying `Set-Cookie` into later same-host requests. Steps
 * outside the validator scope are skipped (never widened). The final step's
 * response drives Dark-Moon grading.
 */
async function replayEvidenceChain(
  proxy: TrafficProxy,
  taskDir: string,
  auth: ValidatorScopeAuth,
  steps: readonly EvidenceChainStep[],
): Promise<ChainReplayResult> {
  const jar: CookieJar = new Map();
  const result: ChainReplayResult = {
    capture: null,
    finalUrl: null,
    finalUsedTunnel: false,
    replayed: 0,
    skipped: 0,
    tunnelIds: [],
  };
  for (const step of steps) {
    let target: URL;
    try {
      target = new URL(step.url);
    } catch {
      result.skipped += 1;
      continue;
    }
    if (target.protocol !== "http:" && target.protocol !== "https:") {
      result.skipped += 1;
      continue;
    }
    if (!validatorHostAllowed(target, auth, taskDir)) {
      result.skipped += 1;
      continue;
    }
    const headers = withJarCookies(step, jar, target);
    const request: ReplayHttpRequest = {
      method: step.method,
      headers,
      ...(step.body != null ? { body: step.body } : {}),
    };
    const route = findActiveTunnelRoute(taskDir, target);
    const capture = route
      ? await replayDirect(target, route, request)
      : target.protocol === "https:"
        ? await replayHttps(proxy, target, request)
        : await replayHttp(proxy, target, request);
    if (route) result.tunnelIds.push(route.id);
    absorbSetCookie(jar, target.hostname.toLowerCase(), capture);
    result.capture = capture;
    result.finalUrl = target;
    result.finalUsedTunnel = Boolean(route);
    result.replayed += 1;
  }
  return result;
}

export type ReplayHttpRequest = { method: string; headers: Record<string, string>; body?: string };

export function buildReplayRequest(packet: ValidatorPacket, taskDir: string, target: URL): ReplayHttpRequest {
  const parsed = parsePocCurl(packet.finding.pocCurl);
  const method = parsed.method ?? replayMethod(packet);
  const headers = { ...parsed.headers };
  supplementSessionCookie(taskDir, target.hostname, headers);
  if (parsed.body != null && !Object.keys(headers).some((name) => name.toLowerCase() === "content-length")) {
    headers["Content-Length"] = String(Buffer.byteLength(parsed.body));
  }
  return { method, headers, ...(parsed.body != null ? { body: parsed.body } : {}) };
}

export type ReplayCapture = {
  method: string;
  url: URL;
  status: number;
  headers: Record<string, string | string[]>;
  body: string;
};

const MAX_REPLAY_CAPTURE_BYTES = 256 * 1024;
const MAX_CHAIN_STEPS = 4;

function hasHeader(headers: Record<string, string>, name: string): boolean {
  return Object.keys(headers).some((key) => key.toLowerCase() === name);
}

function captureHeaders(headers: NodeJS.Dict<string | string[]>): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value == null) continue;
    out[name.toLowerCase()] = value;
  }
  return out;
}

function decodeChunked(buffer: Buffer): Buffer {
  const out: Buffer[] = [];
  let index = 0;
  while (index < buffer.length) {
    const lineEnd = buffer.indexOf("\r\n", index);
    if (lineEnd < 0) break;
    const sizeHex = (buffer.subarray(index, lineEnd).toString("latin1").split(";")[0] ?? "").trim();
    const size = Number.parseInt(sizeHex, 16);
    if (!Number.isFinite(size) || size <= 0) break;
    const start = lineEnd + 2;
    out.push(buffer.subarray(start, Math.min(start + size, buffer.length)));
    index = start + size + 2;
  }
  return Buffer.concat(out);
}

/** Parse a raw HTTP/1.x response collected over a direct TCP/TLS socket. */
export function parseRawHttpResponse(raw: Buffer): {
  status: number;
  headers: Record<string, string | string[]>;
  body: string;
} {
  const split = raw.indexOf("\r\n\r\n");
  const head = (split < 0 ? raw : raw.subarray(0, split)).toString("latin1");
  const bodyRaw = split < 0 ? Buffer.alloc(0) : raw.subarray(split + 4);
  const lines = head.split("\r\n");
  const statusMatch = /^HTTP\/\d(?:\.\d)?\s+(\d{3})/.exec(lines[0] ?? "");
  const headers: Record<string, string | string[]> = {};
  for (const line of lines.slice(1)) {
    const idx = line.indexOf(":");
    if (idx <= 0) continue;
    const name = line.slice(0, idx).trim().toLowerCase();
    const value = line.slice(idx + 1).trim();
    const prev = headers[name];
    if (prev === undefined) headers[name] = value;
    else if (Array.isArray(prev)) prev.push(value);
    else headers[name] = [prev, value];
  }
  const transferEncoding = String(headers["transfer-encoding"] ?? "").toLowerCase();
  const body = transferEncoding.includes("chunked") ? decodeChunked(bodyRaw) : bodyRaw;
  return {
    status: statusMatch ? Number(statusMatch[1]) : 0,
    headers,
    body: body.toString("utf8").slice(0, 64 * 1024),
  };
}

function replayHttp(proxy: TrafficProxy, target: URL, req: ReplayHttpRequest): Promise<ReplayCapture> {
  const headers: Record<string, string> = { ...req.headers };
  if (!hasHeader(headers, "host")) headers.host = target.host;
  return new Promise((resolve, reject) => {
    const httpReq = httpRequest({
      host: "127.0.0.1",
      port: proxy.port,
      method: req.method,
      path: target.href,
      headers,
    }, (res) => {
      const chunks: Buffer[] = [];
      let size = 0;
      res.on("data", (chunk: Buffer) => {
        if (size >= MAX_REPLAY_CAPTURE_BYTES) return;
        chunks.push(chunk);
        size += chunk.length;
      });
      res.on("end", () =>
        resolve({
          method: req.method,
          url: target,
          status: res.statusCode ?? 0,
          headers: captureHeaders(res.headers),
          body: Buffer.concat(chunks).toString("utf8").slice(0, 64 * 1024),
        }),
      );
      res.on("error", reject);
    });
    httpReq.setTimeout(15_000, () => httpReq.destroy(new Error("replay timeout")));
    httpReq.on("error", reject);
    httpReq.end(req.body);
  });
}

/** Node forbids SNI servername for IP literals; passing one throws synchronously. */
export function replayTlsOptions(hostname: string): { host?: string; servername?: string } {
  return isIP(hostname) ? { host: hostname } : { servername: hostname };
}

function replayHttps(proxy: TrafficProxy, target: URL, req: ReplayHttpRequest): Promise<ReplayCapture> {
  const port = Number(target.port || 443);
  return new Promise((resolve, reject) => {
    const socket = netConnect(proxy.port, "127.0.0.1");
    const fail = (err: Error) => {
      socket.destroy();
      reject(err);
    };
    socket.once("error", fail);
    socket.once("connect", () => {
      socket.write(`CONNECT ${target.hostname}:${port} HTTP/1.1\r\nHost: ${target.host}\r\n\r\n`);
      let buf = Buffer.alloc(0);
      const onData = (chunk: Buffer) => {
        buf = Buffer.concat([buf, chunk]);
        const split = buf.indexOf("\r\n\r\n");
        if (split < 0) return;
        socket.off("data", onData);
        const rest = buf.subarray(split + 4);
        if (rest.length) socket.unshift(rest);
        // Node forbids SNI servername for IP literals; a synchronous throw here
        // escapes the socket data handler and kills the whole control plane.
        let tls: ReturnType<typeof tlsConnect>;
        try {
          tls = tlsConnect({
            socket,
            ca: readFileSync(proxy.caPath),
            rejectUnauthorized: true,
            ...replayTlsOptions(target.hostname),
          });
        } catch (err) {
          fail(err instanceof Error ? err : new Error(String(err)));
          return;
        }
        const chunks: Buffer[] = [];
        let size = 0;
        tls.once("error", fail);
        tls.once("secureConnect", () => {
          const lines = [`${req.method} ${target.pathname}${target.search} HTTP/1.1`];
          const hasHost = hasHeader(req.headers, "host");
          const hasConn = hasHeader(req.headers, "connection");
          if (!hasHost) lines.push(`Host: ${target.host}`);
          for (const [name, value] of Object.entries(req.headers)) lines.push(`${name}: ${value}`);
          if (!hasConn) lines.push("Connection: close");
          tls.write(`${lines.join("\r\n")}\r\n\r\n${req.body ?? ""}`);
        });
        tls.on("data", (chunk: Buffer) => {
          if (size >= MAX_REPLAY_CAPTURE_BYTES) return;
          chunks.push(chunk);
          size += chunk.length;
        });
        tls.on("end", () => {
          try {
            const parsed = parseRawHttpResponse(Buffer.concat(chunks));
            resolve({ method: req.method, url: target, ...parsed });
          } catch (err) {
            fail(err instanceof Error ? err : new Error(String(err)));
          }
        });
      };
      socket.on("data", onData);
    });
  });
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

export type ActiveTunnelRoute = {
  id: string;
  kind: string;
  localPort: number;
  targetHost: string;
  targetPort: number;
};

/** RFC1918 literal check — tunneling is only a second-layer intranet route. */
function isRfc1918(host: string): boolean {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!match) return false;
  const [a, b, c, d] = match.slice(1).map(Number) as [number, number, number, number];
  if ([a, b, c, d].some((octet) => octet > 255)) return false;
  if (a === 10) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  return false;
}

/**
 * Find a live local port-forward (`socat` / `ssh-local`) whose RFC1918 target
 * exactly matches the replay URL. Used to reach intranet assets through a
 * Follower's already-authorized tunnel instead of failing on direct connectivity.
 */
export function findActiveTunnelRoute(taskDir: string, target: URL): ActiveTunnelRoute | null {
  if (!isRfc1918(target.hostname.toLowerCase())) return null;
  const targetPort = Number(target.port || (target.protocol === "https:" ? 443 : 80));
  const tunnelsDir = join(taskDir, "exec", "tunnels");
  let entries: string[];
  try {
    entries = readdirSync(tunnelsDir);
  } catch {
    return null;
  }
  entries.sort();
  for (const entry of entries) {
    let meta: Record<string, unknown>;
    try {
      meta = JSON.parse(readFileSync(join(tunnelsDir, entry, "meta.json"), "utf8")) as Record<
        string,
        unknown
      >;
    } catch {
      continue;
    }
    if (meta.status !== "running") continue;
    if (
      meta.kind !== "socat" &&
      meta.kind !== "ssh-local" &&
      meta.kind !== "http-connect"
    ) {
      continue;
    }
    const pid = Number(meta.pid);
    if (!Number.isInteger(pid) || pid <= 0 || !pidAlive(pid)) continue;
    if (String(meta.targetHost ?? "").toLowerCase() !== target.hostname.toLowerCase()) continue;
    if (Number(meta.targetPort) !== targetPort) continue;
    const localPort = Number(meta.localPort);
    if (!Number.isInteger(localPort) || localPort <= 0 || localPort > 65_535) continue;
    return {
      id: entry,
      kind: String(meta.kind),
      localPort,
      targetHost: String(meta.targetHost),
      targetPort,
    };
  }
  return null;
}

/** Direct replay through a local port-forward: original Host header + SNI kept. */
function replayDirect(
  target: URL,
  route: Pick<ActiveTunnelRoute, "localPort">,
  req: ReplayHttpRequest,
): Promise<ReplayCapture> {
  const headers: Record<string, string> = { ...req.headers };
  if (!hasHeader(headers, "host")) headers.Host = target.host;
  if (!hasHeader(headers, "connection")) headers.Connection = "close";
  if (!hasHeader(headers, "accept-encoding")) headers["Accept-Encoding"] = "identity";
  const payload = Buffer.from(
    `${req.method} ${target.pathname}${target.search} HTTP/1.1\r\n` +
      `${Object.entries(headers)
        .map(([name, value]) => `${name}: ${value}`)
        .join("\r\n")}\r\n\r\n${req.body ?? ""}`,
    "utf8",
  );
  return new Promise((resolve, reject) => {
    const socket = netConnect(route.localPort, "127.0.0.1");
    let activeTls: ReturnType<typeof tlsConnect> | null = null;
    let settled = false;
    const deadline = setTimeout(() => {
      finish(Buffer.alloc(0), new Error("tunnel replay timeout"));
    }, 15_000);
    const finish = (raw: Buffer, error?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      activeTls?.destroy();
      socket.destroy();
      if (error) {
        reject(error);
        return;
      }
      try {
        const parsed = parseRawHttpResponse(raw);
        resolve({ method: req.method, url: target, ...parsed });
      } catch (err) {
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    };
    socket.setTimeout(15_000, () => finish(Buffer.alloc(0), new Error("tunnel replay timeout")));
    socket.once("error", (err) => finish(Buffer.alloc(0), err));
    if (target.protocol === "https:") {
      socket.once("connect", () => {
        // The tunnel forwards raw TCP. SNI keeps the original hostname; certificate
        // verification mirrors the proxy replay lane (insecure upstream), so intranet
        // self-signed certs behave the same as a proxy replay.
        let tls: ReturnType<typeof tlsConnect>;
        try {
          tls = tlsConnect({
            socket,
            rejectUnauthorized: false,
            ...replayTlsOptions(target.hostname),
          });
          activeTls = tls;
        } catch (err) {
          finish(Buffer.alloc(0), err instanceof Error ? err : new Error(String(err)));
          return;
        }
        const chunks: Buffer[] = [];
        let size = 0;
        tls.once("error", (err) => finish(Buffer.alloc(0), err));
        tls.once("secureConnect", () => tls.write(payload));
        tls.on("data", (chunk: Buffer) => {
          if (size >= MAX_REPLAY_CAPTURE_BYTES) return;
          chunks.push(chunk);
          size += chunk.length;
        });
        tls.on("end", () => finish(Buffer.concat(chunks)));
      });
    } else {
      const chunks: Buffer[] = [];
      let size = 0;
      socket.once("connect", () => socket.write(payload));
      socket.on("data", (chunk: Buffer) => {
        if (size >= MAX_REPLAY_CAPTURE_BYTES) return;
        chunks.push(chunk);
        size += chunk.length;
      });
      socket.on("end", () => finish(Buffer.concat(chunks)));
      socket.on("close", () => finish(Buffer.concat(chunks)));
    }
  });
}

function bodyText(taskDir: string, record: TrafficRecord, side: "req" | "res"): string {
  const blob = side === "req" ? record.reqBodyBlob : record.resBodyBlob;
  if (!blob) return "";
  const headers = side === "req" ? record.reqHeaders : record.resHeaders;
  if (hasSupportedContentEncoding(headers)) {
    const raw = readBlobBytes(taskDir, blob.sha256, MAX_COMPRESSED_BLOB_BYTES);
    if (raw) return decodeTrafficPreview(raw, headers, 8192);
  }
  return readBlobSlice(taskDir, blob.sha256, 0, 8192).bytes.toString("utf8");
}

type JobRow = {
  id: string;
  status: string;
  validation_id: string | null;
  qualification: string | null;
  traffic_ids_json: string;
  packet_json: string;
};

function latestSucceeded(taskDir: string, taskId: string, findingId: string): JobRow | undefined {
  const row = openTrafficDb(taskDir).prepare(
    `SELECT id, status, validation_id, qualification, traffic_ids_json, packet_json
     FROM validate_jobs WHERE task_id = ? AND finding_id = ? AND status = 'succeeded'
     ORDER BY created_at DESC LIMIT 1`,
  ).get(taskId, findingId) as JobRow | undefined;
  return row;
}

function saveJob(taskDir: string, row: {
  id: string;
  taskId: string;
  findingId: string;
  status: string;
  validationId?: string;
  qualification?: string;
  trafficIds?: string[];
  packet: ValidatorPacket;
  error?: string;
  createdAt: string;
}): void {
    const db = openTrafficDb(taskDir);
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO validate_jobs (
      id, task_id, finding_id, status, validation_id, qualification, traffic_ids_json, packet_json, error, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      status = excluded.status,
      validation_id = excluded.validation_id,
      qualification = excluded.qualification,
      traffic_ids_json = excluded.traffic_ids_json,
      error = excluded.error,
      updated_at = excluded.updated_at`,
  ).run(
    row.id,
    row.taskId,
    row.findingId,
    row.status,
    row.validationId ?? null,
    row.qualification ?? null,
    JSON.stringify(row.trafficIds ?? []),
    JSON.stringify(row.packet),
    row.error ?? null,
    row.createdAt,
    now,
  );
}

function patchFinding(
  historyDb: string,
  taskId: string,
  findingId: string,
  qualification: FindingQualification,
  trafficIds: string[],
): void {
  const db = new DatabaseSync(historyDb);
  try {
    db.exec("PRAGMA busy_timeout = 3000");
    const columns = new Set(
      (db.prepare("PRAGMA table_info(findings)").all() as Array<{ name: string }>).map((column) => column.name),
    );
    if (!columns.has("qualification")) db.exec("ALTER TABLE findings ADD COLUMN qualification TEXT");
    if (!columns.has("traffic_ids_json")) db.exec("ALTER TABLE findings ADD COLUMN traffic_ids_json TEXT");
    db.prepare(
      "UPDATE findings SET qualification = ?, traffic_ids_json = ? WHERE task_id = ? AND id = ?",
    ).run(qualification, JSON.stringify(trafficIds), taskId, findingId);
  } finally {
    db.close();
  }
}

export type ValidateRunResult = {
  httpStatus: number;
  body: FindingValidateRunResponse & {
    qualification?: FindingQualification;
    trafficIds?: string[];
    independent?: boolean;
    packet?: ValidatorPacket;
  };
};

function done(job: JobRow, httpStatus = 200): ValidateRunResult {
  const trafficIds = JSON.parse(job.traffic_ids_json || "[]") as string[];
  return {
    httpStatus,
    body: {
      jobId: job.id,
      status: job.status as FindingValidateRunResponse["status"],
      ...(job.validation_id ? { validationId: job.validation_id } : {}),
      ...(job.qualification ? { qualification: job.qualification as FindingQualification } : {}),
      trafficIds,
      independent: true,
      packet: JSON.parse(job.packet_json) as ValidatorPacket,
    },
  };
}

/**
 * Start one independent validator. The packet is built before any replay and
 * never receives the explorer transcript, compaction, or relay.
 */
export async function runIndependentValidation(input: {
  taskId: string;
  taskDir: string;
  historyDb: string;
  evidenceDir: string;
  targets: readonly string[];
  outOfScope?: readonly string[];
  pivotPolicy?: PivotPolicy | null;
  findingId: string;
  force?: boolean;
}): Promise<ValidateRunResult> {
  const key = flightKey(input.taskId, input.findingId);
  const running = inflight.get(key);
  if (running) throw new ValidationBusyError(running);
  if (!input.force) {
    const previous = latestSucceeded(input.taskDir, input.taskId, input.findingId);
    if (previous) return done(previous);
  }

  const history = openHistory({ dbPath: input.historyDb, evidenceDir: input.evidenceDir });
  const jobId = randomUUID();
  const createdAt = new Date().toISOString();
  let packet: ValidatorPacket | null = null;
  let proxy: TrafficProxy | null = null;
  try {
    const finding = history.getFinding(input.taskId, input.findingId);
    if (!finding) throw Object.assign(new Error("finding not found"), { status: 404 });
    const effectiveAuth = loadEffectiveValidatorAuth(input.taskDir, {
      targets: input.targets,
      ...(input.outOfScope ? { outOfScope: input.outOfScope } : {}),
      ...(input.pivotPolicy ? { pivotPolicy: input.pivotPolicy } : {}),
    });
    packet = buildValidatorPacket({ taskId: input.taskId, targets: effectiveAuth.targets, finding });
    inflight.set(key, jobId);
    saveJob(input.taskDir, {
      id: jobId,
      taskId: input.taskId,
      findingId: input.findingId,
      status: "running",
      packet,
      createdAt,
    });

    proxy = await startTrafficProxy({
      taskId: input.taskId,
      taskDir: input.taskDir,
      workerId: "independent-validator",
      insecureUpstream: true,
      // This proxy only carries the validator's own replay. Persist every
      // exchange (never ring-only) so the replay is on disk and can be bound
      // to the finding below, whatever GY_TRAFFIC_MODE the worker uses.
      mode: "all",
    });
    const target = replayUrl(packet);
    const chainIds = collectEvidenceChain(finding);
    const chainSteps =
      chainIds.length >= 2
        ? loadEvidenceChainSteps(input.taskDir, input.taskId, chainIds.slice(0, MAX_CHAIN_STEPS))
        : [];
    let chain: ChainReplayResult | null = null;
    let tunnelRoute: ActiveTunnelRoute | null = null;
    let directCapture: ReplayCapture | null = null;
    if (chainSteps.length >= 2) {
      const attempt = await replayEvidenceChain(
        proxy,
        input.taskDir,
        effectiveAuth,
        chainSteps,
      );
      if (attempt.replayed > 0) chain = attempt;
    }
    if (!chain && target && validatorHostAllowed(target, effectiveAuth, input.taskDir)) {
      const replay = buildReplayRequest(packet, input.taskDir, target);
      tunnelRoute = findActiveTunnelRoute(input.taskDir, target);
      if (tunnelRoute) {
        directCapture = await replayDirect(target, tunnelRoute, replay);
      } else if (target.protocol === "https:") {
        directCapture = await replayHttps(proxy, target, replay);
      } else {
        directCapture = await replayHttp(proxy, target, replay);
      }
    }

    const page = queryTraffic(input.taskDir, { taskId: input.taskId, workerId: "independent-validator", limit: 20 });
    const record = page.traffic.at(-1);
    // Tunnel / chain-final-direct replays never traverse the proxy: grade the capture.
    const captureForGrade =
      tunnelRoute !== null
        ? directCapture
        : chain?.finalUsedTunnel
          ? chain.capture
          : null;
    const requestText = captureForGrade
      ? `${captureForGrade.method} ${captureForGrade.url.href}`
      : record
        ? `${record.method} ${record.url}\n${bodyText(input.taskDir, record, "req")}`
        : "";
    const responseText = captureForGrade
      ? captureForGrade.body.slice(0, 8192)
      : record
        ? bodyText(input.taskDir, record, "res")
        : "";
    const replayStatus = captureForGrade ? captureForGrade.status : record?.status ?? 0;
    const grade = gradeDarkMoon({
      requestText,
      responseText,
      status: replayStatus,
    });
    const trafficIds = page.traffic.map((row) => row.id);
    const chainTunnelIds = chain ? [...new Set(chain.tunnelIds)] : [];
    const note = [
      `qualification: ${grade.qualification}`,
      grade.reason,
      ...(chain
        ? [
            `chain: ${chain.replayed}/${chainSteps.length} steps` +
              (chain.skipped ? ` (skipped ${chain.skipped})` : ""),
          ]
        : []),
      ...(tunnelRoute ? [`tunnel: ${tunnelRoute.id} → 127.0.0.1:${tunnelRoute.localPort}`] : []),
      ...(chainTunnelIds.length ? [`tunnel: ${chainTunnelIds.join(",")}`] : []),
      ...trafficIds.map((id) => `http:${id}`),
    ].join("\n");
    const evidencePath = writeEvidenceFile(input.evidenceDir, `validations/${jobId}.txt`, note);
    const verdict = grade.qualification === "unconfirmed" ? "inconclusive" : "confirmed";
    const outcome = history.recordFindingValidation(input.taskId, input.findingId, {
      verdict,
      method: "replay",
      evidencePaths: [evidencePath],
      note,
      validator: `independent-validator:${jobId.slice(0, 8)}`,
    });
    history.close();
    patchFinding(input.historyDb, input.taskId, input.findingId, grade.qualification, trafficIds);
    for (const id of trafficIds) linkTrafficFinding(input.taskDir, id, input.findingId);
    saveJob(input.taskDir, {
      id: jobId,
      taskId: input.taskId,
      findingId: input.findingId,
      status: "succeeded",
      validationId: outcome.validation.id,
      qualification: grade.qualification,
      trafficIds,
      packet,
      createdAt,
    });
    return {
      httpStatus: 200,
      body: {
        jobId,
        status: "succeeded",
        validationId: outcome.validation.id,
        qualification: grade.qualification,
        trafficIds,
        independent: outcome.validation.independent,
        packet,
      },
    };
  } catch (err) {
    if (packet) {
      saveJob(input.taskDir, {
        id: jobId,
        taskId: input.taskId,
        findingId: input.findingId,
        status: "failed",
        packet,
        error: err instanceof Error ? err.message : String(err),
        createdAt,
      });
    }
    throw err;
  } finally {
    if (inflight.get(key) === jobId) inflight.delete(key);
    try { history.close(); } catch { /* already closed */ }
    if (proxy) await proxy.close();
  }
}

type AutoValidateItem = {
  taskId: string;
  taskDir: string;
  historyDb: string;
  evidenceDir: string;
  targets: readonly string[];
  outOfScope?: readonly string[];
  pivotPolicy?: PivotPolicy | null;
  findingId: string;
};

const autoQueue: AutoValidateItem[] = [];
const autoAttempted = new Set<string>();
let autoRunning = false;

/** Clear in-memory auto-validation queue/dedup state (tests). */
export function resetAutoValidationState(): void {
  autoQueue.length = 0;
  autoAttempted.clear();
  autoRunning = false;
}

function drainAutoValidationQueue(): void {
  if (autoRunning) return;
  const next = autoQueue.shift();
  if (!next) return;
  autoRunning = true;
  void runIndependentValidation(next)
    .catch(() => {
      /* independent validation is best-effort and must never crash control-plane */
    })
    .finally(() => {
      autoRunning = false;
      if (autoQueue.length > 0) drainAutoValidationQueue();
    });
}

/**
 * Scan a task's verified findings and asynchronously enqueue independent replay
 * validation for any finding that has a replayable URL and has not yet been
 * validated or attempted in this process. Serialized to max 1 concurrent job.
 */
export function scheduleAutoValidationsForTask(input: {
  taskId: string;
  taskDir: string;
  historyDb: string;
  evidenceDir: string;
  targets: readonly string[];
  outOfScope?: readonly string[];
  pivotPolicy?: PivotPolicy | null;
  findingId?: string;
}): string[] {
  if (!existsSync(input.historyDb)) return [];
  const queued: string[] = [];
  let history: ReturnType<typeof openHistory> | null = null;
  try {
    history = openHistory({ dbPath: input.historyDb, evidenceDir: input.evidenceDir });
    const findings = input.findingId
      ? [history.getFinding(input.taskId, input.findingId)].filter((f): f is Finding => Boolean(f))
      : history.listFindings(input.taskId);
    for (const finding of findings) {
      if (finding.status !== "verified") continue;
      const key = flightKey(input.taskId, finding.id);
      if (autoAttempted.has(key) || inflight.has(key)) continue;
      const existingValidations = history.listFindingValidations(input.taskId, finding.id);
      if (existingValidations.some((v) => v.independent)) {
        autoAttempted.add(key);
        continue;
      }
      if (latestSucceeded(input.taskDir, input.taskId, finding.id)) {
        autoAttempted.add(key);
        continue;
      }
      const effectiveAuth = loadEffectiveValidatorAuth(input.taskDir, {
        targets: input.targets,
        ...(input.outOfScope ? { outOfScope: input.outOfScope } : {}),
        ...(input.pivotPolicy ? { pivotPolicy: input.pivotPolicy } : {}),
      });
      const packet = buildValidatorPacket({
        taskId: input.taskId,
        targets: effectiveAuth.targets,
        finding,
      });
      const target = replayUrl(packet);
      if (!target || !validatorHostAllowed(target, effectiveAuth, input.taskDir)) continue;
      autoAttempted.add(key);
      autoQueue.push({
        taskId: input.taskId,
        taskDir: input.taskDir,
        historyDb: input.historyDb,
        evidenceDir: input.evidenceDir,
        targets: [...input.targets],
        ...(input.outOfScope ? { outOfScope: input.outOfScope } : {}),
        ...(input.pivotPolicy ? { pivotPolicy: input.pivotPolicy } : {}),
        findingId: finding.id,
      });
      queued.push(finding.id);
    }
  } catch {
    return queued;
  } finally {
    try { history?.close(); } catch { /* ignore */ }
  }
  if (queued.length > 0) drainAutoValidationQueue();
  return queued;
}

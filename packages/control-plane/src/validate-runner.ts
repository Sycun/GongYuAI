import { randomUUID } from "node:crypto";
import { request as httpRequest } from "node:http";
import { connect as netConnect, isIP } from "node:net";
import { connect as tlsConnect } from "node:tls";
import { DatabaseSync } from "node:sqlite";
import { existsSync, readFileSync } from "node:fs";
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

function replayHttp(proxy: TrafficProxy, target: URL, req: ReplayHttpRequest): Promise<void> {
  const headers: Record<string, string> = { ...req.headers };
  if (!Object.keys(headers).some((name) => name.toLowerCase() === "host")) headers.host = target.host;
  return new Promise((resolve, reject) => {
    const httpReq = httpRequest({
      host: "127.0.0.1",
      port: proxy.port,
      method: req.method,
      path: target.href,
      headers,
    }, (res) => {
      res.resume();
      res.on("end", () => resolve());
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

function replayHttps(proxy: TrafficProxy, target: URL, req: ReplayHttpRequest): Promise<void> {
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
        tls.once("error", fail);
        tls.once("secureConnect", () => {
          const lines = [`${req.method} ${target.pathname}${target.search} HTTP/1.1`];
          const hasHost = Object.keys(req.headers).some((name) => name.toLowerCase() === "host");
          const hasConn = Object.keys(req.headers).some((name) => name.toLowerCase() === "connection");
          if (!hasHost) lines.push(`Host: ${target.host}`);
          for (const [name, value] of Object.entries(req.headers)) lines.push(`${name}: ${value}`);
          if (!hasConn) lines.push("Connection: close");
          tls.write(`${lines.join("\r\n")}\r\n\r\n${req.body ?? ""}`);
        });
        tls.on("end", () => resolve());
      };
      socket.on("data", onData);
    });
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
    if (target && validatorHostAllowed(target, effectiveAuth, input.taskDir)) {
      const replay = buildReplayRequest(packet, input.taskDir, target);
      if (target.protocol === "https:") await replayHttps(proxy, target, replay);
      else await replayHttp(proxy, target, replay);
    }

    const page = queryTraffic(input.taskDir, { taskId: input.taskId, workerId: "independent-validator", limit: 20 });
    const record = page.traffic.at(-1);
    const requestText = record ? `${record.method} ${record.url}\n${bodyText(input.taskDir, record, "req")}` : "";
    const responseText = record ? bodyText(input.taskDir, record, "res") : "";
    const grade = gradeDarkMoon({
      requestText,
      responseText,
      status: record?.status ?? 0,
    });
    const trafficIds = page.traffic.map((row) => row.id);
    const note = [
      `qualification: ${grade.qualification}`,
      grade.reason,
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

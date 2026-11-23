import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  AuthorizationLedgerSchema,
  AuthorizationRecordSchema,
  authorizationStatus,
  authorizationToAuthScope,
  latestAuthorization,
  type AuthorizationLedger,
  type AuthorizationRecord,
  type TaskRecord,
} from "@gongyuai/contracts";
import { writeEvidenceFile, type HistoryStore } from "@gongyuai/history";
import { taskPaths } from "./paths.js";

/**
 * 授权台账：书面授权的可回查原件 + 版本化范围。
 *
 * 边界：
 * - `task.auth` 仍是执行期唯一权威；台账只回答“这句话依据哪份原件、哪一版范围”；
 * - 台账落在任务 dataDir 内（0600），随任务删除，不进配置或备份；
 * - 记录只增不改：范围变化写新版本，旧版本留在 evidence 与 records 里可回查。
 */

export type AuthorizationCapability = AuthorizationRecord["capability"];

export const DEFAULT_ISSUER = "操作员（会话内声明）";

export type AuthorizationInput = {
  targets: string[];
  outOfScope: string[];
  capability: AuthorizationCapability;
  issuedBy: string | null;
  issuedAt: string | null;
  validFrom: string | null;
  validUntil: string | null;
  constraints: string[];
  note: string;
  source: AuthorizationRecord["source"];
  /** 操作员原始表述；有原文才会封存为证据。 */
  raw: string | null;
};

export type ParsedAuthorization = { input: AuthorizationInput; missing: string[] };

/** 缺项异常：控制面据此返回 400 并告诉调用方还需要补哪个字段。 */
export class AuthorizationInputError extends Error {
  constructor(message: string, readonly missing: string[]) {
    super(message);
    this.name = "AuthorizationInputError";
  }
}

// ---------------------------------------------------------------- 解析

const CJK = /[\u3400-\u9fff]/;
const TARGET_SHAPE =
  /^(?:\*|(?:\*\.)?(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}|(?:\d{1,3}\.){3}\d{1,3}(?:\/\d{1,2})?|local:[a-z0-9._-]+|[a-z0-9][a-z0-9._-]{0,253})$/i;
/** 这些词是能力级/开关，不是目标；否则 "可做 active-lab" 会被当成主机。 */
const CAPABILITY_TOKEN = /^(?:full|scan|active|active[-_ ]?lab|observe|all|none|auto|manual|true|false)$/i;

const CAPABILITY_ALIASES: Array<[RegExp, AuthorizationCapability]> = [
  [/^(?:full|完全|全权|全部|后渗透)$/i, "full"],
  [/^(?:active[-_ ]?lab|active|验证|利用|主动)$/i, "active-lab"],
  [/^(?:scan|扫描|探测)$/i, "scan"],
  [/^(?:observe|只读|观察|只看)$/i, "observe"],
];

export function parseCapabilityValue(value: string): AuthorizationCapability | null {
  const text = value.trim().toLowerCase();
  if (!text) return null;
  for (const [re, capability] of CAPABILITY_ALIASES) if (re.test(text)) return capability;
  if (/(?:full|完全|全权|后渗透)/.test(text)) return "full";
  if (/(?:active[-_ ]?lab|验证|利用)/.test(text)) return "active-lab";
  if (/(?:scan|扫描|探测)/.test(text)) return "scan";
  if (/(?:observe|只读|观察)/.test(text)) return "observe";
  return null;
}

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

/** 日期只写到天时补齐到当日起点/终点；写成别的格式就明确报错，不猜。 */
export function toIsoTimestamp(value: string, edge: "start" | "end", field: string): string {
  const raw = value.trim();
  const dateOnly = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/.exec(raw);
  if (dateOnly) {
    const stamp = `${dateOnly[1]}-${pad2(Number(dateOnly[2]))}-${pad2(Number(dateOnly[3]))}`;
    return edge === "end" ? `${stamp}T23:59:59.999Z` : `${stamp}T00:00:00.000Z`;
  }
  const relaxed = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})[ T](\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(raw);
  const candidate = relaxed
    ? `${relaxed[1]}-${pad2(Number(relaxed[2]))}-${pad2(Number(relaxed[3]))}T${pad2(Number(relaxed[4]))}:${relaxed[5]}:${relaxed[6] ?? "00"}Z`
    : raw;
  const at = Date.parse(candidate);
  if (Number.isNaN(at)) {
    throw new AuthorizationInputError(
      `${field}无法解析（${raw}）：请写成 2026-12-31 这样的日期，或 2026-12-31T00:00:00Z 这样的 ISO 时间。`,
      [],
    );
  }
  return new Date(at).toISOString();
}

export function normalizeTargetToken(raw: string): string | null {
  const token = raw.trim().replace(/^[「『"'`([]+|[」』"'`)\],、，。；;]+$/g, "");
  if (!token || token.length > 255) return null;
  if (CJK.test(token) || CAPABILITY_TOKEN.test(token)) return null;
  return TARGET_SHAPE.test(token) ? token : null;
}

function dedupe(values: string[]): string[] {
  const out: string[] = [];
  for (const value of values) if (value && !out.includes(value)) out.push(value);
  return out;
}

export function splitTargets(value: string): string[] {
  return dedupe(
    value
      .split(/[\s、,，;；]+|与|和|及|以及/)
      .map((piece) => normalizeTargetToken(piece))
      .filter((piece): piece is string => Boolean(piece)),
  );
}

/** 去掉同一句里明显不是目标的从句（“继续”“可做 active-lab”）。 */
function stripNonTargetClauses(value: string): string {
  const keep: string[] = [];
  for (const clause of value.split(/[，,。]/)) {
    const text = clause.trim();
    if (!text) continue;
    if (/(?:继续|接着|执行|开打|开始|推进|可做|能力|有效期|排除|限制|授权人|请先|已经|并|帮我)/.test(text)) continue;
    keep.push(text);
  }
  return keep.join(" ");
}

type FieldName =
  | "issuedBy" | "targets" | "outOfScope" | "capability"
  | "issuedAt" | "validFrom" | "validUntil" | "constraints" | "note";

function fieldFor(key: string): FieldName | null {
  const name = key.trim().toLowerCase().replace(/[\s_]/g, "");
  switch (name) {
    case "授权人": case "委托人": case "授权方": case "出具人": case "issuedby": case "issuer":
      return "issuedBy";
    case "目标": case "授权目标": case "范围": case "授权范围": case "targets": case "target": case "scope":
      return "targets";
    case "排除": case "排除项": case "排除范围": case "不支持": case "禁止": case "outofscope": case "exclude":
      return "outOfScope";
    case "能力": case "能力级": case "级别": case "capability":
      return "capability";
    case "出具时间": case "授权时间": case "issuedat":
      return "issuedAt";
    case "生效": case "生效时间": case "validfrom":
      return "validFrom";
    case "有效期至": case "有效期": case "失效时间": case "validuntil": case "expires":
      return "validUntil";
    case "限制": case "附加限制": case "约束": case "constraints":
      return "constraints";
    case "备注": case "说明": case "note":
      return "note";
    default:
      return null;
  }
}

function stringList(value: unknown): string[] {
  if (typeof value === "string") return dedupe(value.split(/[、,，;；]+|\s+/).map((s) => s.trim()).filter(Boolean));
  if (Array.isArray(value)) return dedupe(value.filter((v): v is string => typeof v === "string").map((s) => s.trim()).filter(Boolean));
  return [];
}

function missingFields(input: AuthorizationInput): string[] {
  return input.targets.length ? [] : ["targets"];
}

function inputFromObject(value: unknown, raw: string | null, source: AuthorizationRecord["source"]): AuthorizationInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new AuthorizationInputError("授权内容无效：请提交含 targets 的对象，或 {text:\"授权人/目标/能力\"}。", ["targets"]);
  }
  const record = value as Record<string, unknown>;
  const capabilityRaw = typeof record.capability === "string" ? record.capability : "";
  return {
    targets: dedupe(stringList(record.targets ?? record.target)),
    outOfScope: dedupe(stringList(record.outOfScope ?? record.exclude)),
    capability: parseCapabilityValue(capabilityRaw) ?? "active-lab",
    issuedBy: typeof record.issuedBy === "string" && record.issuedBy.trim() ? record.issuedBy.trim() : null,
    issuedAt: typeof record.issuedAt === "string" && record.issuedAt.trim() ? record.issuedAt.trim() : null,
    validFrom: typeof record.validFrom === "string" && record.validFrom.trim() ? record.validFrom.trim() : null,
    validUntil: typeof record.validUntil === "string" && record.validUntil.trim() ? record.validUntil.trim() : null,
    constraints: stringList(record.constraints),
    note: typeof record.note === "string" ? record.note.slice(0, 2000) : "",
    source: record.source === "document" ? "document" : source,
    raw,
  };
}

/** 同一请求里文本与显式字段都给时，显式字段优先（操作员点名要改的那一项）。 */
function applyOverrides(base: AuthorizationInput, record: Record<string, unknown>): AuthorizationInput {
  const next: AuthorizationInput = { ...base };
  if (record.targets !== undefined || record.target !== undefined) {
    const targets = dedupe(stringList(record.targets ?? record.target));
    if (targets.length) next.targets = targets;
  }
  if (record.outOfScope !== undefined || record.exclude !== undefined) {
    next.outOfScope = dedupe(stringList(record.outOfScope ?? record.exclude));
  }
  if (typeof record.capability === "string") {
    const capability = parseCapabilityValue(record.capability);
    if (capability) next.capability = capability;
  }
  if (typeof record.issuedBy === "string" && record.issuedBy.trim()) next.issuedBy = record.issuedBy.trim();
  if (typeof record.issuedAt === "string" && record.issuedAt.trim()) next.issuedAt = record.issuedAt.trim();
  if (typeof record.validFrom === "string" && record.validFrom.trim()) next.validFrom = record.validFrom.trim();
  if (typeof record.validUntil === "string" && record.validUntil.trim()) next.validUntil = record.validUntil.trim();
  if (record.constraints !== undefined) next.constraints = dedupe(stringList(record.constraints));
  if (typeof record.note === "string") next.note = record.note.slice(0, 2000);
  return next;
}

/**
 * 认三种形态：结构化 JSON、逐字段中文文本、一句话口语。
 * targets 为空不抛在这里，交给 registerAuthorization 统一报缺项。
 */
export function parseAuthorizationText(text: string): ParsedAuthorization {
  const raw = typeof text === "string" ? text.trim() : "";
  if (!raw) {
    throw new AuthorizationInputError(
      "授权内容为空：请写明授权人与目标，例如「授权人: 张三 / 目标: 10.0.0.0/8 / 能力: active-lab」。",
      ["targets"],
    );
  }
  if (raw.startsWith("{")) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new AuthorizationInputError(
        `授权 JSON 无法解析：请检查引号与逗号，例如 {"targets":["10.0.0.0/8"],"capability":"active-lab"}。`,
        ["targets"],
      );
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new AuthorizationInputError("授权 JSON 需要是对象：例如 {\"targets\":[\"10.0.0.0/8\"]}。", ["targets"]);
    }
    const input = inputFromObject(parsed, raw, "operator-text");
    return { input, missing: missingFields(input) };
  }

  const state: {
    issuedBy: string | null;
    targets: string[];
    outOfScope: string[];
    capability: AuthorizationCapability | null;
    issuedAt: string | null;
    validFrom: string | null;
    validUntil: string | null;
    constraints: string[];
    note: string;
  } = {
    issuedBy: null, targets: [], outOfScope: [], capability: null,
    issuedAt: null, validFrom: null, validUntil: null, constraints: [], note: "",
  };
  const prose: string[] = [];

  // 分隔符用换行/分号/" / "：CIDR 里的 "/" 两侧没有空格，不会被切开。
  for (const segment of raw.split(/\r?\n|[；;]|\s+\/\s+/)) {
    const entry = segment.trim();
    if (!entry) continue;
    const labeled = /^([^:：]{1,16})\s*[:：]\s*([\s\S]*)$/.exec(entry);
    const field = labeled ? fieldFor(labeled[1]!) : null;
    if (!labeled || !field) {
      prose.push(entry);
      continue;
    }
    const value = labeled[2]!.trim();
    switch (field) {
      case "issuedBy": state.issuedBy = value || null; break;
      case "targets": state.targets.push(...splitTargets(value)); break;
      case "outOfScope": state.outOfScope.push(...splitTargets(value)); break;
      case "capability": state.capability = parseCapabilityValue(value) ?? state.capability; break;
      case "issuedAt": state.issuedAt = value || null; break;
      case "validFrom": state.validFrom = value || null; break;
      case "validUntil": state.validUntil = value || null; break;
      case "constraints": state.constraints.push(...value.split(/[、,，;；]+/).map((s) => s.trim()).filter(Boolean)); break;
      case "note": state.note = value; break;
    }
  }

  const proseText = prose.join(" ");
  if (proseText) {
    if (!state.issuedBy) {
      const issuer = /(?:授权人|委托人|授权方)\s*[:：]?\s*([^\s，,、；;/]+)/.exec(proseText);
      if (issuer?.[1]) state.issuedBy = issuer[1];
    }
    if (!state.capability) {
      const declared = /(?:能力级?|可做|可执行|可进行|级别)\s*[:：]?\s*([a-z\u4e00-\u9fff_-]+)/i.exec(proseText);
      state.capability = declared?.[1] ? parseCapabilityValue(declared[1]) : null;
      if (!state.capability) {
        const literal = /\b(observe|scan|active-lab|full)\b/i.exec(proseText);
        state.capability = literal?.[1] ? parseCapabilityValue(literal[1]) : null;
      }
    }
    if (!state.validUntil) {
      const until = /(?:有效期至|有效期到|失效时间)\s*[:：]?\s*(\d{4}[-/]\d{1,2}[-/]\d{1,2}(?:[ T][\d:]+)?)/.exec(proseText);
      if (until?.[1]) state.validUntil = until[1];
    }
    if (!state.targets.length) {
      const declared = /已(?:经)?授[权权](?:范围)?[了]?\s*[:：]?\s*([\s\S]+)/.exec(proseText);
      if (declared?.[1]) state.targets.push(...splitTargets(stripNonTargetClauses(declared[1])));
    }
  }

  const input: AuthorizationInput = {
    targets: dedupe(state.targets),
    outOfScope: dedupe(state.outOfScope),
    capability: state.capability ?? "active-lab",
    issuedBy: state.issuedBy,
    issuedAt: state.issuedAt,
    validFrom: state.validFrom,
    validUntil: state.validUntil,
    constraints: dedupe(state.constraints),
    note: state.note,
    source: "operator-text",
    raw,
  };
  return { input, missing: missingFields(input) };
}

/** API 入口：接受 {text}、部分字段对象，或两者同时给。 */
export function parseAuthorizationInput(input: unknown): ParsedAuthorization {
  if (typeof input === "string") return parseAuthorizationText(input);
  if (input && typeof input === "object" && !Array.isArray(input)) {
    const record = input as Record<string, unknown>;
    if (typeof record.text === "string" && record.text.trim()) {
      const parsed = parseAuthorizationText(record.text);
      const hasStructured = Object.keys(record).some((key) => key !== "text");
      const merged = hasStructured ? applyOverrides(parsed.input, record) : parsed.input;
      return { input: merged, missing: missingFields(merged) };
    }
    const parsed = inputFromObject(record, null, "api");
    return { input: parsed, missing: missingFields(parsed) };
  }
  throw new AuthorizationInputError(
    "授权内容无效：请提交 {text:\"授权人/目标/能力\"} 或至少含 targets 的对象。",
    ["targets"],
  );
}

// ---------------------------------------------------------------- 台账读写

export function ledgerPath(task: TaskRecord): string {
  return join(task.dataDir, "authorization", "ledger.json");
}

export function readLedger(task: TaskRecord): AuthorizationLedger {
  const path = ledgerPath(task);
  if (!existsSync(path)) return { taskId: task.id, current: 0, records: [] };
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new Error(`授权台账无法解析（${path}）：请修复或删除该文件后重新登记授权。`);
  }
  const ledger = AuthorizationLedgerSchema.safeParse(parsed);
  if (!ledger.success) throw new Error(`授权台账结构无效（${path}）：${ledger.error.message}`);
  return ledger.data;
}

export function writeLedger(task: TaskRecord, ledger: AuthorizationLedger): string {
  const path = ledgerPath(task);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, JSON.stringify(ledger, null, 2) + "\n", { mode: 0o600 });
  // 已存在的文件不会被 mode 修正，显式收紧权限。
  chmodSync(path, 0o600);
  return path;
}

export function appendRecord(task: TaskRecord, record: AuthorizationRecord): AuthorizationLedger {
  const ledger = readLedger(task);
  ledger.records.push(record);
  ledger.current = ledger.records.reduce((max, item) => Math.max(max, item.version), 0);
  writeLedger(task, ledger);
  return ledger;
}

/** 当前生效记录：以台账为准；台账缺失时回落到任务记录里的投影。 */
export function currentRecord(task: TaskRecord): AuthorizationRecord | null {
  try {
    const latest = latestAuthorization(readLedger(task));
    if (latest) return latest;
  } catch {
    // 台账损坏不应让任务无法生成提示词：投影仍在 task.authorization 上。
  }
  return task.authorization ?? null;
}

export type RegisterDeps = { save?: (task: TaskRecord) => void; history?: HistoryStore | null };

function isRegisterDeps(value: unknown): value is RegisterDeps {
  return Boolean(value) && typeof value === "object" && ("save" in (value as object) || "history" in (value as object));
}

/**
 * 登记一版授权：封存原件 → 写台账 → 更新任务投影（auth / authorization / scopeVersion）。
 * `auth` 仍是执行期权威，这里只做投影；不扩大任何既有范围。
 */
export function registerAuthorization(
  task: TaskRecord,
  input: unknown,
  deps: HistoryStore | RegisterDeps = {},
): AuthorizationRecord {
  const resolved: RegisterDeps = isRegisterDeps(deps) ? deps : { history: deps as HistoryStore };
  const parsed = parseAuthorizationInput(input);
  if (!parsed.input.targets.length) {
    throw new AuthorizationInputError(
      "授权目标为空：请写明目标，例如「目标: 10.0.0.0/8、*.example.com」，或提交 JSON {\"targets\":[\"10.0.0.0/8\"],\"capability\":\"active-lab\"}。",
      ["targets"],
    );
  }
  const issuedAt = parsed.input.issuedAt
    ? toIsoTimestamp(parsed.input.issuedAt, "start", "授权时间")
    : new Date().toISOString();
  const validFrom = parsed.input.validFrom ? toIsoTimestamp(parsed.input.validFrom, "start", "生效时间") : null;
  const validUntil = parsed.input.validUntil ? toIsoTimestamp(parsed.input.validUntil, "end", "有效期") : null;

  const ledger = readLedger(task);
  const version = ledger.records.reduce((max, item) => Math.max(max, item.version), ledger.current) + 1;

  let evidence: AuthorizationRecord["evidence"] = null;
  if (parsed.input.raw) {
    const relative = `authorization/v${version}-source.md`;
    writeEvidenceFile(taskPaths(task.dataDir).evidenceDir, relative, parsed.input.raw);
    evidence = {
      path: relative,
      sha256: createHash("sha256").update(parsed.input.raw, "utf8").digest("hex"),
      excerpt: Array.from(parsed.input.raw).slice(0, 500).join(""),
      bytes: Buffer.byteLength(parsed.input.raw, "utf8"),
    };
  }

  const record = AuthorizationRecordSchema.parse({
    version,
    issuedBy: parsed.input.issuedBy ?? DEFAULT_ISSUER,
    issuedAt,
    validFrom,
    validUntil,
    targets: parsed.input.targets,
    outOfScope: parsed.input.outOfScope,
    capability: parsed.input.capability,
    constraints: parsed.input.constraints,
    source: parsed.input.source,
    note: parsed.input.note,
    evidence,
    revokedAt: null,
    revokedReason: "",
  });

  appendRecord(task, record);
  task.authorization = record;
  task.auth = authorizationToAuthScope(record);
  task.scopeVersion = (task.scopeVersion ?? 1) + 1;
  resolved.save?.(task);
  return record;
}

/** 一行摘要（UI/日志）：版本/授权人/目标/能力级/状态。 */
export function authorizationDigest(task: TaskRecord): string {
  const record = currentRecord(task);
  if (!record) return "v0/未登记/无授权目标/observe/未登记";
  const status = authorizationStatus(record);
  return [
    `v${record.version}`,
    record.issuedBy,
    record.targets.join("、"),
    record.capability,
    status.active ? "生效中" : status.reason,
  ].join("/");
}

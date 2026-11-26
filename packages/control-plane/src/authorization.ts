import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  AuthorizationLedgerSchema,
  authorizationStatus,
  latestAuthorization,
  type AuthCapability,
  type AuthorizationLedger,
  type AuthorizationRecord,
  type TaskRecord,
} from "@gongyuai/contracts";

/**
 * P16 — 旧授权台账只读兼容 + 任务坐标解析（red-team-positioning.md）。
 *
 * 授权是使用前提，不是运行时功能：新任务不登记授权、不设授权版本、不审查目标；
 * `targets/outOfScope/roe` 是普通任务坐标。本模块只做两件事：
 * - 读取历史任务已封存的台账记录（只回查，不再写入、不再裁决执行）；
 * - 从操作员会话消息解析目标坐标（目标/排除/能力），供续接合并进 `task.auth`。
 */

export type AuthorizationCapability = AuthCapability;
export type TaskCapability = AuthCapability;

// ---------------------------------------------------------------- 坐标解析

const CJK = /[㐀-鿿]/;
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

function fieldFor(key: string): "targets" | "outOfScope" | "capability" | null {
  const name = key.trim().toLowerCase().replace(/[\s_]/g, "");
  switch (name) {
    case "目标": case "授权目标": case "范围": case "授权范围": case "任务坐标": case "targets": case "target": case "scope":
      return "targets";
    case "排除": case "排除项": case "排除范围": case "不支持": case "禁止": case "outofscope": case "exclude":
      return "outOfScope";
    case "能力": case "能力级": case "级别": case "档位": case "capability":
      return "capability";
    default:
      return null;
  }
}

function stringList(value: unknown): string[] {
  if (typeof value === "string") return dedupe(value.split(/[、,，;；]+|\s+/).map((s) => s.trim()).filter(Boolean));
  if (Array.isArray(value)) return dedupe(value.filter((v): v is string => typeof v === "string").map((s) => s.trim()).filter(Boolean));
  return [];
}

export type ScopeMessage = {
  targets: string[];
  outOfScope: string[];
  capability: AuthorizationCapability | null;
};
export type TaskCoordinatesPatch = ScopeMessage;

/**
 * 从续接消息解析任务坐标：JSON、逐字段中文（目标/排除/能力）或一句话口语。
 * 「已授权 X，继续」按旧习惯兼容为「把 X 加入坐标」；不再产生授权记录。
 */
export function parseScopeMessage(text: string): ScopeMessage {
  const raw = typeof text === "string" ? text.trim() : "";
  const state: ScopeMessage = { targets: [], outOfScope: [], capability: null };
  if (!raw) return state;
  if (raw.startsWith("{")) {
    try {
      const parsed: unknown = JSON.parse(raw);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        const record = parsed as Record<string, unknown>;
        state.targets.push(...stringList(record.targets ?? record.target));
        state.outOfScope.push(...stringList(record.outOfScope ?? record.exclude));
        if (typeof record.capability === "string") state.capability = parseCapabilityValue(record.capability);
        return { ...state, targets: dedupe(state.targets), outOfScope: dedupe(state.outOfScope) };
      }
    } catch { /* 不是合法 JSON：按文本解析 */ }
  }

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
      case "targets": state.targets.push(...splitTargets(value)); break;
      case "outOfScope": state.outOfScope.push(...splitTargets(value)); break;
      case "capability": state.capability = parseCapabilityValue(value) ?? state.capability; break;
    }
  }

  const proseText = prose.join(" ");
  if (proseText) {
    if (!state.capability) {
      const declared = /(?:能力级?|可做|可执行|可进行|级别|档位)\s*[:：]?\s*([a-z一-鿿_-]+)/i.exec(proseText);
      state.capability = declared?.[1] ? parseCapabilityValue(declared[1]) : null;
      if (!state.capability) {
        const literal = /\b(observe|scan|active-lab|full)\b/i.exec(proseText);
        state.capability = literal?.[1] ? parseCapabilityValue(literal[1]) : null;
      }
    }
    if (!state.targets.length) {
      const declared = /已(?:经)?授[权权](?:范围)?[了]?\s*[:：]?\s*([\s\S]+)/.exec(proseText);
      if (declared?.[1]) state.targets.push(...splitTargets(stripNonTargetClauses(declared[1])));
    }
  }
  return { targets: dedupe(state.targets), outOfScope: dedupe(state.outOfScope), capability: state.capability };
}

/** `parseScopeMessage` 的语义化别名：解析单兵任务坐标（目标 / 排除项 / 能力档位）。 */
export const parseTaskCoordinates = parseScopeMessage;

/** 当前生效任务坐标摘要（直接投影 `task.auth`，不依赖旧授权台账）。 */
export function taskCoordinatesDigest(task: Pick<TaskRecord, "auth" | "scopeVersion">): string {
  const targets = task.auth.targets.length > 0 ? task.auth.targets.join("、") : "未设目标";
  const excluded = task.auth.outOfScope.length > 0 ? `排除:${task.auth.outOfScope.join("、")}` : "无排除";
  return `scope#v${task.scopeVersion}/${targets}/${excluded}/${task.auth.capability}`;
}

// ---------------------------------------------------------------- 旧台账只读

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
    throw new Error(`旧授权台账无法解析（${path}）：记录只读保留，可修复该文件后回查。`);
  }
  const ledger = AuthorizationLedgerSchema.safeParse(parsed);
  if (!ledger.success) throw new Error(`旧授权台账结构无效（${path}）：${ledger.error.message}`);
  return ledger.data;
}

/** 历史记录回查：以台账为准；台账缺失时回落到任务记录里的投影。 */
export function currentRecord(task: TaskRecord): AuthorizationRecord | null {
  try {
    const latest = latestAuthorization(readLedger(task));
    if (latest) return latest;
  } catch {
    // 台账损坏不应让任务无法生成提示词：投影仍在 task.authorization 上。
  }
  return task.authorization ?? null;
}

/** 一行摘要（UI/日志，仅旧任务）：版本/授权人/目标/能力级/状态。 */
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
import { z } from "zod";

/**
 * 授权台账（Authorization Ledger）。
 *
 * 设计约束：
 * - 委托的书面授权是一份**可引用原件**，不是一个布尔值。`auth` 仍是执行期唯一权威，
 *   本记录负责"这句话依据哪份原件"，并把版本、范围、能力级、时间窗固定下来。
 * - 记录只增不改：撤回写 `revokedAt`，范围变化写新版本；旧版本留在 evidence 里可回查。
 * - 台账不扩大 `auth.targets`：控制面把记录投影为 `AuthScope`，worker 仍按 `auth` 执行。
 */

export const AuthorizationEvidenceSchema = z.object({
  /** 封存副本（相对证据目录）。原件被覆盖后仍可回读。 */
  path: z.string().min(1),
  /** 原件 sha256（hex）。 */
  sha256: z.string().regex(/^[a-f0-9]{64}$/i),
  /** 原件摘录，便于报告直接引用；不替代原件。 */
  excerpt: z.string().default(""),
  /** 原件字节数；缺失表示台账建立时未保存字节。 */
  bytes: z.number().int().nonnegative().default(0),
});
export type AuthorizationEvidence = z.infer<typeof AuthorizationEvidenceSchema>;

export const AuthorizationRecordSchema = z.object({
  /** 台账版本，从 1 递增；恢复任务读取最新版本。 */
  version: z.number().int().positive(),
  /** 授权人/委托方（个人或组织）。 */
  issuedBy: z.string().min(1),
  issuedAt: z.string().datetime(),
  /** 生效/失效窗口；null 表示未约定。 */
  validFrom: z.string().datetime().nullable().default(null),
  validUntil: z.string().datetime().nullable().default(null),
  /** 允许目标：host / IPv4 CIDR / *.domain / 裸域 / `*`。 */
  targets: z.array(z.string().min(1)).min(1),
  /** 明确排除，优先级高于 targets。 */
  outOfScope: z.array(z.string()).default([]),
  /** 能力级：observe < scan < active-lab < full。 */
  capability: z.enum(["observe", "scan", "active-lab", "full"]).default("active-lab"),
  /** 额外限制，例如"仅工作时间""不做 DoS""禁止社工"。 */
  constraints: z.array(z.string()).default([]),
  /** 记录来源：操作员文本、上传的授权文件、API 写入。 */
  source: z.enum(["operator-text", "document", "api"]).default("operator-text"),
  /** 原始表述或解析说明，便于复核。 */
  note: z.string().default(""),
  /** 原件封存；没有原件时明确为 null，不伪造。 */
  evidence: AuthorizationEvidenceSchema.nullable().default(null),
  revokedAt: z.string().datetime().nullable().default(null),
  revokedReason: z.string().default(""),
});
export type AuthorizationRecord = z.infer<typeof AuthorizationRecordSchema>;

export const AuthorizationLedgerSchema = z.object({
  taskId: z.string(),
  /** 当前生效版本号；0 表示尚未登记。 */
  current: z.number().int().nonnegative().default(0),
  records: z.array(AuthorizationRecordSchema).default([]),
});
export type AuthorizationLedger = z.infer<typeof AuthorizationLedgerSchema>;

export type AuthorizationStatus =
  | { active: true; record: AuthorizationRecord }
  | { active: false; reason: string; record: AuthorizationRecord | null };

/** 记录是否在时间窗内、未撤回。 */
export function authorizationStatus(
  record: AuthorizationRecord | null | undefined,
  now: Date = new Date(),
): AuthorizationStatus {
  if (!record) return { active: false, reason: "尚未登记书面授权", record: null };
  if (record.revokedAt) {
    return { active: false, reason: `授权已于 ${record.revokedAt} 撤回：${record.revokedReason || "未说明"}`, record };
  }
  const t = now.getTime();
  if (record.validFrom && Date.parse(record.validFrom) > t) {
    return { active: false, reason: `授权自 ${record.validFrom} 起生效`, record };
  }
  if (record.validUntil && Date.parse(record.validUntil) < t) {
    return { active: false, reason: `授权已于 ${record.validUntil} 失效`, record };
  }
  return { active: true, record };
}

/** 最新一版（按 version 最大），没有则 null。 */
export function latestAuthorization(ledger: AuthorizationLedger): AuthorizationRecord | null {
  let best: AuthorizationRecord | null = null;
  for (const r of ledger.records) if (!best || r.version > best.version) best = r;
  return best;
}

/** 投影为执行期 AuthScope；`auth` 仍是 worker 唯一权威。 */
export function authorizationToAuthScope(record: AuthorizationRecord): {
  authorizationNote: string;
  targets: string[];
  outOfScope: string[];
  capability: AuthorizationRecord["capability"];
} {
  return {
    authorizationNote: `${record.issuedBy} 于 ${record.issuedAt} 出具（授权台账 v${record.version}）${record.note ? `：${record.note}` : ""}`.slice(0, 400),
    targets: [...record.targets],
    outOfScope: [...record.outOfScope],
    capability: record.capability,
  };
}

/**
 * 给模型看的授权块。要点：
 * - 明确"授权已登记 + 版本 + 范围 + 能力级"，避免模型把已登记授权当成未授权；
 * - 明确能力级含义，避免模型把 active-lab 当成只读；
 * - 明确越界返回 needs_authorization，而不是解释为什么不能做。
 */
export function authorizationPromptBlock(record: AuthorizationRecord | null): string {
  if (!record) {
    return [
      "## 授权台账",
      "尚未登记书面授权。只能处理提交的材料与本地只读检查。",
      "任务需要接触外部目标时，返回 needs_authorization，并在 targets/actions 里写清需要补什么；不要用解释代替请求。",
    ].join("\n");
  }
  const st = authorizationStatus(record);
  const lines = [
    "## 授权台账（已登记，执行依据）",
    `- 版本：v${record.version}；授权人：${record.issuedBy}；出具时间：${record.issuedAt}`,
    `- 授权目标：${record.targets.join("、")}`,
    record.outOfScope.length ? `- 明确排除：${record.outOfScope.join("、")}（优先级高于授权目标）` : "- 明确排除：无",
    `- 能力级：${record.capability}（observe=只读；scan=扫描；active-lab=验证与利用；full=含后渗透）`,
    record.validUntil ? `- 有效期至：${record.validUntil}` : "- 有效期：未约定",
    record.constraints.length ? `- 附加限制：${record.constraints.join("；")}` : "- 附加限制：无",
    `- 状态：${st.active ? "生效中" : `未生效（${st.reason}）`}`,
    record.evidence
      ? `- 原件：${record.evidence.path}（sha256 ${record.evidence.sha256.slice(0, 16)}…）`
      : "- 原件：未附；记录仅依据操作员表述",
    "",
    "执行纪律：",
    "1. 目标在授权范围内且动作不高于能力级时，直接执行并留证；不要要求重复授权，也不要输出风险说教。",
    "2. 目标或动作越界时，返回 needs_authorization，列出缺的目标、动作、时间窗；不要用「无法执行」代替结构化请求。",
    "3. 授权不覆盖的动作（例如对非授权第三方的横向、对外部基础设施的 DoS）仍然不做，但要把边界写进 finding/limitation。",
  ];
  return lines.join("\n");
}

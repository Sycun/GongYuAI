import { z } from "zod";

/**
 * 旧授权台账（Authorization Ledger）——只读兼容（P16）。
 *
 * 授权是使用前提，不是运行时功能（red-team-positioning.md）：新任务不再有授权
 * 登记/版本/审查；`targets/outOfScope/roe` 是普通任务坐标。本模块仅保留 schema
 * 与读取助手，让历史任务里已封存的台账记录仍可回查，不阻塞新任务。
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

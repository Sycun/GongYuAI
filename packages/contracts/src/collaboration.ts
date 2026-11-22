/**
 * 阶段 5 的两个协作入口（业务验收项 6）：
 *
 * 1. 客户发起复测申请：客户署名提出“请复测某条结论”，平台留下请求、
 *    依据与时间；操作员完成复测后该申请转为已完成，历史记录不覆盖。
 * 2. 同一委托内跨任务署名复核：复核人可以复核同委托另一个任务的结论；
 *    跨委托一律拒绝，旧记录只追加、不改写。
 */
import { z } from "zod";

export const RetestRequestSchema = z.object({
  /** 申请人署名（客户联系人）。 */
  requester: z.string().trim().min(1),
  /** 申请人角色 / 单位，便于追责。 */
  role: z.string().trim().min(1).optional(),
  /** 需要复测的结论。 */
  findingIds: z.array(z.string().trim().min(1)).min(1),
  /** 申请理由与判据。 */
  reason: z.string().trim().min(1),
  /** 申请依据（邮件、工单截图等）在 evidence/ 下的相对路径。 */
  evidencePath: z.string().trim().min(1).optional(),
});
export type RetestRequestInput = z.infer<typeof RetestRequestSchema>;

export type RetestRequestStatus = "pending" | "fulfilled";

export type RetestRequest = RetestRequestInput & {
  id: string;
  status: RetestRequestStatus;
  createdAt: string;
  fulfilledAt?: string;
  /** 触发完成的复测结论状态（fixed / still-present / partially-fixed）。 */
  fulfilledResult?: string;
  sha256?: string;
};

export const PeerReviewDecisionSchema = z.enum(["confirm", "challenge", "retest-requested"]);
export type PeerReviewDecision = z.infer<typeof PeerReviewDecisionSchema>;

export const PeerReviewSchema = z.object({
  /** 复核人署名。 */
  reviewer: z.string().trim().min(1),
  /** 复核人角色（second reviewer / 质量负责人 等）。 */
  role: z.string().trim().min(1),
  /** 被复核的任务；必须属于同一委托。 */
  sourceTaskId: z.string().uuid(),
  /** 被复核的结论或事实（两者至少一项）。 */
  findingId: z.string().trim().min(1).optional(),
  factId: z.string().trim().min(1).optional(),
  decision: PeerReviewDecisionSchema,
  /** 复核依据与判断说明。 */
  basis: z.string().trim().min(1),
  /** 复核依据材料在 evidence/ 下的相对路径。 */
  evidencePath: z.string().trim().min(1).optional(),
}).refine((value) => Boolean(value.findingId || value.factId), {
  message: "findingId 或 factId 至少提供一项",
});
export type PeerReviewInput = z.infer<typeof PeerReviewSchema>;

export type PeerReview = PeerReviewInput & {
  id: string;
  engagementId: string;
  /** 记录写在哪个任务下（当前任务）。 */
  taskId: string;
  createdAt: string;
  sha256?: string;
};

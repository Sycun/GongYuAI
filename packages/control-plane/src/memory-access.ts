/**
 * 记忆读取与复核写入是否获准。
 *
 * 这版控制面没有可核验的调用方身份，不能把 tenantId、engagementId、
 * 页面是否隐藏，或响应里的 taskId 当成授权。未获内部授权时，真实记忆读取
 * 和会改节点、回传节点内容的复核写入都默认关闭。
 */
import type { IncomingMessage } from "node:http";

export const MEMORY_READ_UNAVAILABLE = {
  error: "memory-unavailable",
  available: false,
  message:
    "当前控制面不能可靠区分调用方身份与委托，已关闭真实记忆读取。tenantId、任务编号和页面入口都不能作为授权。",
} as const;

export const MEMORY_REVIEW_UNAVAILABLE = {
  error: "memory-unavailable",
  available: false,
  message:
    "当前控制面不能可靠区分调用方身份与委托，已关闭记忆复核写入。tenantId、任务编号和页面入口都不能作为授权。",
} as const;

export type MemoryCaller = {
  verified: true;
  tenantId: string;
  engagementId: string;
  canReviewMemory: true;
};

export function verifiedIdentityFromRequest(_req?: IncomingMessage): MemoryCaller | null {
  return null;
}

export function memoryReadAllowed(identity: { verified: boolean } | null): boolean {
  return identity?.verified === true;
}

type ReviewCandidate = {
  verified?: boolean;
  tenantId?: string;
  engagementId?: string;
  canReviewMemory?: boolean;
} | null;

/** 复核写入同时要求已核验身份、复核权限和所属委托。缺任何一项都拒绝。 */
export function memoryReviewAllowed(identity: ReviewCandidate): identity is MemoryCaller {
  return identity?.verified === true
    && identity.canReviewMemory === true
    && typeof identity.tenantId === "string"
    && identity.tenantId.length > 0
    && typeof identity.engagementId === "string"
    && identity.engagementId.length > 0;
}

export function beginMemoryReview(identity: MemoryCaller | null):
  | { proceed: false; status: 403; body: typeof MEMORY_REVIEW_UNAVAILABLE }
  | { proceed: true; identity: MemoryCaller } {
  if (!memoryReviewAllowed(identity)) {
    return { proceed: false, status: 403, body: MEMORY_REVIEW_UNAVAILABLE };
  }
  return { proceed: true, identity };
}

/** 委托归属只比较委托编号，不携带节点正文。 */
export function memoryReviewEngagementMatches(
  ownership: { engagementIds: readonly string[] },
  identity: { engagementId: string },
): boolean {
  return ownership.engagementIds.includes(identity.engagementId);
}

import { z } from "zod";
import { normalizeHost } from "./scope.js";

/**
 * Supervisor advisory inbox + tactical lesson ledger contracts.
 *
 * Advisories are cross-slot, in-flight guidance written by the scheduler (or by
 * peer resource broadcasts) and consumed exactly once by the target Worker.
 * Tactical lessons are post-Intent knowledge with mandatory execution evidence:
 * a falsified hypothesis without command evidence is a guess and must be rejected.
 */

export const WorkerAdvisoryKindSchema = z.enum([
  "tactical_advisory",
  "resource_broadcast",
  "surface_redirect",
]);
export type WorkerAdvisoryKind = z.infer<typeof WorkerAdvisoryKindSchema>;

export const WorkerAdvisoryPrioritySchema = z.enum(["normal", "important", "urgent"]);
export type WorkerAdvisoryPriority = z.infer<typeof WorkerAdvisoryPrioritySchema>;

export const WorkerAdvisorySchema = z.object({
  id: z.string().uuid(),
  taskId: z.string().min(1),
  kind: WorkerAdvisoryKindSchema,
  priority: WorkerAdvisoryPrioritySchema,
  targetIntentId: z.string().min(1).nullable().default(null),
  targetWorkerSlot: z.number().int().nonnegative().nullable().default(null),
  assetScope: z.string().trim().min(1).max(255).nullable().default(null),
  summary: z.string().trim().min(1).max(4000),
  createdBy: z.string().trim().min(1).max(200),
  createdAt: z.string().datetime(),
  consumedAt: z.string().datetime().nullable().default(null),
  consumedBySlot: z.number().int().nonnegative().nullable().default(null),
});
export type WorkerAdvisory = z.infer<typeof WorkerAdvisorySchema>;

export const FalsifiedHypothesisSchema = z.object({
  hypothesis: z.string().trim().min(1),
  commandEvidence: z.string().trim().min(1),
  resultSummary: z.string().trim().min(1),
});
export type FalsifiedHypothesis = z.infer<typeof FalsifiedHypothesisSchema>;

export const TacticalLessonSchema = z.object({
  id: z.string().uuid(),
  taskId: z.string().min(1),
  intentId: z.string().min(1).nullable().default(null),
  assetRoot: z.string().trim().min(1).max(255),
  familyKey: z.string().trim().max(64).default(""),
  techTags: z.array(z.string().trim().min(1)).default([]),
  falsifiedHypotheses: z.array(FalsifiedHypothesisSchema).default([]),
  antipatterns: z.array(z.string().trim().min(1)).default([]),
  effectivePattern: z.string().trim().max(4000).nullable().default(null),
  nextPivotAdvice: z.string().trim().max(2000).default(""),
  createdAt: z.string().datetime(),
});
export type TacticalLesson = z.infer<typeof TacticalLessonSchema>;

/** RFC1918 IPv4 (10/8, 172.16/12, 192.168/16). Hostnames / public IPs are false. */
export function isRfc1918Ipv4(host: string): boolean {
  const h = normalizeHost(host);
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (!m) return false;
  const a = Number(m[1]);
  const b = Number(m[2]);
  const c = Number(m[3]);
  const d = Number(m[4]);
  if ([a, b, c, d].some((n) => n > 255)) return false;
  if (a === 10) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  return false;
}

/**
 * Same concrete asset, or two different hosts inside the same RFC1918 /24.
 * Public addresses only match exactly — cross-host coupling stays private-LAN-only.
 */
export function sameAssetScope(a: string | null | undefined, b: string | null | undefined): boolean {
  const ha = normalizeHost(a ?? "");
  const hb = normalizeHost(b ?? "");
  if (!ha || !hb) return false;
  if (ha === hb) return true;
  const pa = ha.split(".");
  const pb = hb.split(".");
  if (pa.length !== 4 || pb.length !== 4) return false;
  if (!isRfc1918Ipv4(ha) || !isRfc1918Ipv4(hb)) return false;
  return pa[0] === pb[0] && pa[1] === pb[1] && pa[2] === pb[2];
}
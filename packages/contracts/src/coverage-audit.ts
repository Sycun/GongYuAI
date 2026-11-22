import { z } from "zod";
export const CoverageStatusSchema = z.enum(["untested", "partial", "tested", "blocked"]);
export type CoverageStatus = z.infer<typeof CoverageStatusSchema>;

const digest = z.string().regex(/^[a-f0-9]{64}$/);
const goalId = z.string().min(1);
const uniqueIds = (goals: { goalId: string }[]) => new Set(goals.map((g) => g.goalId)).size === goals.length;

export const CoverageReferenceSchema = z.strictObject({
  version: z.literal(1),
  taskId: z.string().uuid(),
  split: z.enum(["development", "holdout"]),
  goals: z.array(z.strictObject({
    goalId, status: CoverageStatusSchema, evidenceSha256: digest.optional(),
  })).min(1).refine(uniqueIds, "底稿中的目标 ID 重复"),
});

const snapshotGoal = z.strictObject({
  goalId,
  status: z.union([CoverageStatusSchema, z.literal("unknown")]),
  proof: z.enum(["none", "missing", "invalid", "verified"]),
  sha256: digest.nullable(),
}).refine((g) => {
  if (g.status === "unknown") return g.proof === "none" && g.sha256 === null;
  if (g.proof === "none") return g.sha256 === null && g.status !== "tested" && g.status !== "partial";
  if (g.proof === "verified" || g.proof === "invalid") return g.sha256 !== null;
  return true;
}, "覆盖状态与证据核验结果矛盾");

export const CoverageSnapshotSchema = z.strictObject({
  version: z.literal(1),
  taskId: z.string().uuid(),
  capturedAt: z.string().datetime(),
  goals: z.array(snapshotGoal).min(1).refine(uniqueIds, "快照中的目标 ID 重复"),
});
export type CoverageSnapshot = z.infer<typeof CoverageSnapshotSchema>;

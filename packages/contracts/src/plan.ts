import { z } from "zod";

/**
 * P14-B5 — a campaign plan that survives Reason wake-ups.
 * Steps are advisory: the plan never dispatches by itself. `intent_propose`
 * still passes the DAG hard gate, and step state is derived by the system from
 * facts/intents/findings — never self-reported by the model.
 */
export const PlanStepStatusSchema = z.enum([
  "pending",
  "ready",
  "dispatched",
  "done",
  "blocked",
]);
export type PlanStepStatus = z.infer<typeof PlanStepStatusSchema>;

export const PlanStepSchema = z.object({
  id: z.string().uuid(),
  taskId: z.string().uuid(),
  ord: z.number().int().nonnegative(),
  title: z.string().min(1).max(300),
  summary: z.string().max(2000).default(""),
  needsFactIds: z.array(z.string()).default([]),
  needsIntentIds: z.array(z.string()).default([]),
  needsFindingIds: z.array(z.string()).default([]),
  status: PlanStepStatusSchema,
  intentId: z.string().uuid().nullable().default(null),
  updatedAt: z.string().datetime(),
});
export type PlanStep = z.infer<typeof PlanStepSchema>;

export const PlanStepDraftSchema = z.object({
  title: z.string().trim().min(1).max(300),
  summary: z.string().trim().max(2000).default(""),
  needsFactIds: z.array(z.string().min(1)).default([]),
  needsIntentIds: z.array(z.string().min(1)).default([]),
  needsFindingIds: z.array(z.string().min(1)).default([]),
});
export type PlanStepDraft = z.infer<typeof PlanStepDraftSchema>;
export type PlanStepDraftInput = z.input<typeof PlanStepDraftSchema>;

export const PlanSetInputSchema = z.object({
  steps: z.array(PlanStepDraftSchema).min(1).max(20),
});
export type PlanSetInput = z.infer<typeof PlanSetInputSchema>;

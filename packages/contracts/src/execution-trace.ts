import { z } from "zod";

export type ShellTraceCall = {
  id: string;
  command: string | null;
  result: string | null;
  exitCode?: number | null;
  durationMs?: number | null;
};

export const ExecutionStepSchema = z.object({
  id: z.string(),
  at: z.string(),
  number: z.number(),
  workerSlot: z.number(),
  tools: z.array(z.string()),
  tokens: z.number(),
  shellCallCount: z.number(),
  intentId: z.string().uuid().optional(),
  durationMs: z.number().int().nonnegative().optional(),
});
export type ExecutionStep = z.infer<typeof ExecutionStepSchema>;

export type ExecutionTracePage = {
  steps: ExecutionStep[];
  nextBefore: number | null;
};

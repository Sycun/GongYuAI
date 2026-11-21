import { z } from "zod";

/** Reserved for multi-user; MVP always "default". */
export const TenantIdSchema = z.string().min(1).default("default");
export type TenantId = z.infer<typeof TenantIdSchema>;

export const TaskStatusSchema = z.enum([
  "queued",
  "initializing",
  "running",
  "recovering",
  "completed",
  "failed",
  "budget_exhausted",
  "stopped",
]);
export type TaskStatus = z.infer<typeof TaskStatusSchema>;

export const BudgetSchema = z.object({
  maxTokens: z.number().int().positive().default(2_000_000),
  maxWallMs: z.number().int().positive().default(3_600_000),
  maxToolCalls: z.number().int().positive().default(500),
  maxInstalls: z.number().int().positive().default(50),
});
export type Budget = z.infer<typeof BudgetSchema>;

export const AuthScopeSchema = z.object({
  /** Explicit written authorization note (required). */
  authorizationNote: z.string().min(8),
  /** Allowed targets: hosts, CIDRs, or URLs. */
  targets: z.array(z.string().min(1)).min(1),
  /** Optional notes on out-of-scope assets. */
  outOfScope: z.array(z.string()).default([]),
});
export type AuthScope = z.infer<typeof AuthScopeSchema>;

export const GoalSpecSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  description: z.string().min(1),
  /** Glob patterns under evidence/ that must exist before pass. */
  evidencePatterns: z.array(z.string().min(1)).min(1),
});
export type GoalSpec = z.infer<typeof GoalSpecSchema>;

export const CreateTaskRequestSchema = z.object({
  tenantId: z.string().min(1).default("default"),
  name: z.string().min(1).default("untitled"),
  auth: AuthScopeSchema,
  goals: z.array(GoalSpecSchema).min(1),
  budget: BudgetSchema.optional().default({
    maxTokens: 2_000_000,
    maxWallMs: 3_600_000,
    maxToolCalls: 500,
    maxInstalls: 50,
  }),
  /** When true, worker uses scripted mock agent (no LLM). */
  mock: z.boolean().default(false),
});
export type CreateTaskRequest = z.infer<typeof CreateTaskRequestSchema>;

export const GoalStateSchema = z.object({
  id: z.string(),
  title: z.string(),
  description: z.string(),
  evidencePatterns: z.array(z.string()),
  passes: z.boolean(),
  evidencePaths: z.array(z.string()).default([]),
  assertedAt: z.string().datetime().nullable().default(null),
});
export type GoalState = z.infer<typeof GoalStateSchema>;

export const TaskRecordSchema = z.object({
  id: z.string().uuid(),
  tenantId: z.string(),
  name: z.string(),
  status: TaskStatusSchema,
  auth: AuthScopeSchema,
  goals: z.array(GoalStateSchema),
  budget: BudgetSchema,
  mock: z.boolean(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  startedAt: z.string().datetime().nullable(),
  finishedAt: z.string().datetime().nullable(),
  leaseOwner: z.string().nullable(),
  leaseUntil: z.string().datetime().nullable(),
  fence: z.number().int().nonnegative(),
  containerId: z.string().nullable(),
  workerPid: z.number().int().nullable(),
  dataDir: z.string(),
  error: z.string().nullable(),
  usage: z.object({
    tokens: z.number().int().nonnegative(),
    toolCalls: z.number().int().nonnegative(),
    installs: z.number().int().nonnegative(),
  }),
});
export type TaskRecord = z.infer<typeof TaskRecordSchema>;

export const FactLayerSchema = z.enum(["title", "summary", "evidence"]);
export type FactLayer = z.infer<typeof FactLayerSchema>;

export const FactSchema = z.object({
  id: z.string().uuid(),
  taskId: z.string().uuid(),
  layer: FactLayerSchema,
  title: z.string().min(1),
  summary: z.string().default(""),
  evidencePath: z.string().nullable().default(null),
  tags: z.array(z.string()).default([]),
  createdAt: z.string().datetime(),
  intentId: z.string().uuid().nullable().default(null),
});
export type Fact = z.infer<typeof FactSchema>;

export const IntentStatusSchema = z.enum([
  "proposed",
  "claimed",
  "running",
  "succeeded",
  "failed",
  "expired",
]);
export type IntentStatus = z.infer<typeof IntentStatusSchema>;

export const IntentSchema = z.object({
  id: z.string().uuid(),
  taskId: z.string().uuid(),
  title: z.string().min(1),
  summary: z.string().default(""),
  status: IntentStatusSchema,
  claimedBy: z.string().nullable().default(null),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  concludedAt: z.string().datetime().nullable().default(null),
  conclusion: z.string().nullable().default(null),
});
export type Intent = z.infer<typeof IntentSchema>;

export const HistoryEventKindSchema = z.enum([
  "fact_appended",
  "intent_proposed",
  "intent_claimed",
  "intent_concluded",
  "goal_asserted",
  "tool_installed",
  "lease_acquired",
  "lease_lost",
  "worker_started",
  "worker_stopped",
  "budget_tick",
  "report_written",
]);
export type HistoryEventKind = z.infer<typeof HistoryEventKindSchema>;

export const HistoryEventSchema = z.object({
  id: z.string().uuid(),
  taskId: z.string().uuid(),
  kind: HistoryEventKindSchema,
  payload: z.record(z.string(), z.unknown()).default({}),
  createdAt: z.string().datetime(),
});
export type HistoryEvent = z.infer<typeof HistoryEventSchema>;

export const WorkerManifestSchema = z.object({
  taskId: z.string().uuid(),
  dataDir: z.string(),
  historyDb: z.string(),
  durableDb: z.string(),
  evidenceDir: z.string(),
  workspaceDir: z.string(),
  auth: AuthScopeSchema,
  goals: z.array(GoalStateSchema),
  budget: BudgetSchema,
  mock: z.boolean(),
  model: z
    .object({
      provider: z.string(),
      modelId: z.string(),
      baseUrl: z.string().optional(),
      apiKeyEnv: z.string().default("OPENAI_API_KEY"),
      /** Pi / OpenAI-compat vision (image input). */
      visionEnabled: z.boolean().default(true),
      visionModelId: z.string().optional(),
    })
    .optional(),
});
export type WorkerManifest = z.infer<typeof WorkerManifestSchema>;

export const ModelSettingsSchema = z.object({
  provider: z.string().default("openai"),
  modelId: z.string().min(1).default("gpt-4.1-mini"),
  baseUrl: z.string().default("https://api.openai.com/v1"),
  /** Stored locally only; never returned in full by API. */
  apiKey: z.string().default(""),
  visionEnabled: z.boolean().default(true),
  visionModelId: z.string().default(""),
});
export type ModelSettings = z.infer<typeof ModelSettingsSchema>;

export const UpdateSettingsSchema = z.object({
  githubUrl: z.string().default("https://github.com/Sycun/GongYuAI"),
  branch: z.string().default("main"),
  /** Optional PAT for private repos; masked in API. */
  githubToken: z.string().default(""),
  lastCheckedAt: z.string().nullable().default(null),
  lastUpdatedAt: z.string().nullable().default(null),
  lastCommit: z.string().nullable().default(null),
});
export type UpdateSettings = z.infer<typeof UpdateSettingsSchema>;

export const AppSettingsSchema = z.object({
  model: ModelSettingsSchema.default({
    provider: "openai",
    modelId: "gpt-4.1-mini",
    baseUrl: "https://api.openai.com/v1",
    apiKey: "",
    visionEnabled: true,
    visionModelId: "",
  }),
  update: UpdateSettingsSchema.default({
    githubUrl: "https://github.com/Sycun/GongYuAI",
    branch: "main",
    githubToken: "",
    lastCheckedAt: null,
    lastUpdatedAt: null,
    lastCommit: null,
  }),
});
export type AppSettings = z.infer<typeof AppSettingsSchema>;

export const ModelSettingsPatchSchema = ModelSettingsSchema.partial();
export type ModelSettingsPatch = z.infer<typeof ModelSettingsPatchSchema>;

export const UpdateSettingsPatchSchema = UpdateSettingsSchema.partial();
export type UpdateSettingsPatch = z.infer<typeof UpdateSettingsPatchSchema>;

export function goalsFromSpecs(specs: GoalSpec[]): GoalState[] {
  return specs.map((g) => ({
    id: g.id,
    title: g.title,
    description: g.description,
    evidencePatterns: g.evidencePatterns,
    passes: false,
    evidencePaths: [],
    assertedAt: null,
  }));
}

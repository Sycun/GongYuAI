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
  /**
   * Session Relay auto-trigger: cumulative tokens since last π.
   * Override with env GY_RELAY_TOKEN_THRESHOLD. Default 30_000 (CHAP-aligned, conservative).
   */
  relayTokenThreshold: z.number().int().positive().default(30_000),
  /** Min tool calls between two Relays (guard against empty handoffs). */
  relayMinToolCalls: z.number().int().nonnegative().default(2),
});
export type Budget = z.infer<typeof BudgetSchema>;

/** Capability ladder (P3): tools filtered by level; VPN/proxy mutations always denied. */
export const AuthCapabilitySchema = z.enum([
  "observe",
  "scan",
  "active-lab",
  "full",
]);
export type AuthCapability = z.infer<typeof AuthCapabilitySchema>;

export const AuthScopeSchema = z.object({
  /** Explicit written authorization note (required). */
  authorizationNote: z.string().min(8),
  /** Allowed targets: hosts, CIDRs, or URLs. */
  targets: z.array(z.string().min(1)).min(1),
  /** Optional notes on out-of-scope assets. */
  outOfScope: z.array(z.string()).default([]),
  /** Default lowest rung; raise explicitly per task. */
  capability: AuthCapabilitySchema.default("observe"),
});
export type AuthScope = z.infer<typeof AuthScopeSchema>;

/** Graph-driven worker phases (P2). Crash recovery still uses Durable; Relay ≠ crash. */
export const WorkerPhaseSchema = z.enum([
  "init",
  "bootstrap",
  "explore",
  "reason",
  "relay",
  "report",
  "done",
  /** Legacy single-loop; treated as explore|reason continuum. */
  "loop",
]);
export type WorkerPhase = z.infer<typeof WorkerPhaseSchema>;

/**
 * Session Relay protocol πₙ (CHAP-aligned). Written to workspace/relay/π{n}.json.
 * Incremental vs prior π; History remains authoritative on conflict.
 */
export const RelayProtocolSchema = z.object({
  generation: z.number().int().nonnegative(),
  createdAt: z.string().datetime(),
  trigger: z.enum(["auto", "agent"]),
  reason: z.string().default(""),
  current_position: z.string().default(""),
  network_map: z.string().default(""),
  tried: z.string().default(""),
  active_sessions: z.string().default(""),
  foothold: z.string().default(""),
  unexplored_surface: z.string().default(""),
  open_intents: z.array(z.string()).default([]),
  budget_spent: z.object({
    tokens: z.number().int().nonnegative().default(0),
    toolCalls: z.number().int().nonnegative().default(0),
    wallMs: z.number().int().nonnegative().default(0),
  }),
});
export type RelayProtocol = z.infer<typeof RelayProtocolSchema>;

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

/** Pseudo Fact id: Intent may hang on origin before any real Fact exists. */
export const ORIGIN_FACT_ID = "origin";

export const IntentSchema = z.object({
  id: z.string().uuid(),
  taskId: z.string().uuid(),
  title: z.string().min(1),
  summary: z.string().default(""),
  status: IntentStatusSchema,
  /** Predecessor Fact ids (or `origin`); empty forbidden — no causeless explore. */
  sourceFactIds: z.array(z.string().min(1)).min(1),
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
  "intent_expired",
  "goal_asserted",
  "tool_installed",
  "lease_acquired",
  "lease_lost",
  "worker_started",
  "worker_stopped",
  "budget_tick",
  "report_written",
  "relay_written",
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

/** One MCP = one tool directory under mcp/builtin|user. Never a monolithic kali-mcp. */
export const McpTransportSchema = z.enum(["builtin", "stdio", "http"]);
export type McpTransport = z.infer<typeof McpTransportSchema>;

export const McpServerConfigSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  description: z.string().default(""),
  category: z.string().default("general"),
  enabled: z.boolean().default(true),
  builtin: z.boolean().default(false),
  source: z.enum(["builtin", "user"]).default("user"),
  transport: McpTransportSchema.default("stdio"),
  rootDir: z.string().optional(),
  command: z.string().optional(),
  args: z.array(z.string()).default([]),
  url: z.string().optional(),
  env: z.record(z.string(), z.string()).default({}),
});
export type McpServerConfig = z.infer<typeof McpServerConfigSchema>;

export const SkillPackConfigSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  description: z.string().default(""),
  enabled: z.boolean().default(true),
  builtin: z.boolean().default(false),
  source: z.enum(["builtin", "user"]).default("user"),
  rootDir: z.string().min(1),
});
export type SkillPackConfig = z.infer<typeof SkillPackConfigSchema>;

export const WorkerMcpServerSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  transport: McpTransportSchema,
  rootDir: z.string().optional(),
  command: z.string().optional(),
  args: z.array(z.string()).default([]),
  url: z.string().optional(),
  env: z.record(z.string(), z.string()).default({}),
});
export type WorkerMcpServer = z.infer<typeof WorkerMcpServerSchema>;

export const WorkerSkillPackSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  rootDir: z.string().min(1),
});
export type WorkerSkillPack = z.infer<typeof WorkerSkillPackSchema>;

/** Short catalog entry so the model can unlock tools it has not enabled yet. */
export const ToolCatalogEntrySchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  description: z.string().default(""),
  category: z.string().default("general"),
});
export type ToolCatalogEntry = z.infer<typeof ToolCatalogEntrySchema>;

/** Always-on MCP core for progressive unlock (task start). */
export const CORE_MCP_IDS = ["nmap", "httpx", "nuclei"] as const;
/** Always-on skill core. */
export const CORE_SKILL_IDS = [
  "auth-scope-discipline",
  "evidence-first",
  "recon",
] as const;

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
      visionEnabled: z.boolean().default(true),
      visionModelId: z.string().optional(),
    })
    .optional(),
  /** Initially enabled MCP servers (settings ∪ core). */
  mcpServers: z.array(WorkerMcpServerSchema).default([]),
  /** Full pool for task-local enable_mcp. */
  mcpPool: z.array(WorkerMcpServerSchema).default([]),
  mcpCatalog: z.array(ToolCatalogEntrySchema).default([]),
  /** Initially enabled skills. */
  skillPacks: z.array(WorkerSkillPackSchema).default([]),
  skillPool: z.array(WorkerSkillPackSchema).default([]),
  skillCatalog: z.array(ToolCatalogEntrySchema).default([]),
});
export type WorkerManifest = z.infer<typeof WorkerManifestSchema>;

export const ModelSettingsSchema = z.object({
  provider: z.string().default("openai"),
  modelId: z.string().min(1).default("gpt-4.1-mini"),
  baseUrl: z.string().default("https://api.openai.com/v1"),
  apiKey: z.string().default(""),
  visionEnabled: z.boolean().default(true),
  visionModelId: z.string().default(""),
});
export type ModelSettings = z.infer<typeof ModelSettingsSchema>;

export const UpdateSettingsSchema = z.object({
  githubUrl: z.string().default("https://github.com/Sycun/GongYuAI"),
  branch: z.string().default("main"),
  githubToken: z.string().default(""),
  lastCheckedAt: z.string().nullable().default(null),
  lastUpdatedAt: z.string().nullable().default(null),
  lastCommit: z.string().nullable().default(null),
});
export type UpdateSettings = z.infer<typeof UpdateSettingsSchema>;

/** Catalog from disk wins metadata; existing wins enabled when ids match. */
export function mergeMcpServers(
  existing: McpServerConfig[],
  catalog: McpServerConfig[],
): McpServerConfig[] {
  const prev = new Map(existing.map((s) => [s.id, s]));
  const out: McpServerConfig[] = [];
  const seen = new Set<string>();
  for (const item of catalog) {
    const old = prev.get(item.id);
    out.push(
      McpServerConfigSchema.parse({
        ...item,
        enabled: old ? old.enabled : item.enabled,
      }),
    );
    seen.add(item.id);
  }
  for (const rest of existing) {
    if (seen.has(rest.id)) continue;
    if (rest.rootDir) continue;
    out.push(McpServerConfigSchema.parse(rest));
  }
  return out;
}

export function mergeSkillPacks(
  existing: SkillPackConfig[],
  catalog: SkillPackConfig[],
): SkillPackConfig[] {
  const prev = new Map(existing.map((s) => [s.id, s]));
  const out: SkillPackConfig[] = [];
  const seen = new Set<string>();
  for (const item of catalog) {
    const old = prev.get(item.id);
    out.push(
      SkillPackConfigSchema.parse({
        ...item,
        enabled: old ? old.enabled : item.enabled,
      }),
    );
    seen.add(item.id);
  }
  for (const rest of existing) {
    if (seen.has(rest.id)) continue;
    out.push(SkillPackConfigSchema.parse(rest));
  }
  return out;
}

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
  mcpServers: z.array(McpServerConfigSchema).default([]),
  skillPacks: z.array(SkillPackConfigSchema).default([]),
});
export type AppSettings = z.infer<typeof AppSettingsSchema>;

export const ModelSettingsPatchSchema = ModelSettingsSchema.partial();
export type ModelSettingsPatch = z.infer<typeof ModelSettingsPatchSchema>;

export const UpdateSettingsPatchSchema = UpdateSettingsSchema.partial();
export type UpdateSettingsPatch = z.infer<typeof UpdateSettingsPatchSchema>;

export const AddUserMcpSchema = z.object({
  id: z.string().min(1).regex(/^[a-z0-9][a-z0-9_-]{0,63}$/i),
  name: z.string().min(1),
  enabled: z.boolean().default(true),
  transport: z.enum(["stdio", "http"]),
  command: z.string().optional(),
  args: z.array(z.string()).default([]),
  url: z.string().optional(),
  env: z.record(z.string(), z.string()).default({}),
});
export type AddUserMcp = z.infer<typeof AddUserMcpSchema>;

export const ImportSkillSchema = z.object({
  id: z.string().min(1).regex(/^[a-z0-9][a-z0-9_-]{0,63}$/i),
  name: z.string().min(1),
  enabled: z.boolean().default(true),
  rootDir: z.string().optional(),
  skillMarkdown: z.string().optional(),
});
export type ImportSkill = z.infer<typeof ImportSkillSchema>;

export const ToggleToolsItemSchema = z.object({
  kind: z.enum(["mcp", "skill"]),
  id: z.string().min(1),
  enabled: z.boolean(),
});
export type ToggleToolsItem = z.infer<typeof ToggleToolsItemSchema>;

export const ToolsSettingsPatchSchema = z.object({
  mcpServers: z.array(McpServerConfigSchema).optional(),
  skillPacks: z.array(SkillPackConfigSchema).optional(),
});
export type ToolsSettingsPatch = z.infer<typeof ToolsSettingsPatchSchema>;

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

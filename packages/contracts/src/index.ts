import { z } from "zod";
export type { ExecutionStep, ExecutionTracePage, ShellTraceCall } from "./execution-trace.js";
import {
  DEFAULT_EXPLORE_TIMEOUT_MS,
  DEFAULT_MAX_INTENTS_PER_ASSET_ROOT,
  DEFAULT_MAX_INTENTS_PER_REASON,
  DEFAULT_REASON_LEASE_MS,
} from "./fanout.js";

/** Reserved for multi-user; MVP always "default". */
export const TenantIdSchema = z.string().min(1).default("default");
export type TenantId = z.infer<typeof TenantIdSchema>;

const ACTIVE_TASK_STATUSES = ["queued", "initializing", "running", "recovering"] as const;
const TERMINAL_TASK_STATUSES = [
  "completed",
  "failed",
  "budget_exhausted",
  /** Loop ended without all goals and without hitting a hard budget gate. */
  "incomplete",
  "stopped",
] as const;

export const TaskStatusSchema = z.enum([...ACTIVE_TASK_STATUSES, ...TERMINAL_TASK_STATUSES]);
export type TaskStatus = z.infer<typeof TaskStatusSchema>;
export type TerminalTaskStatus = (typeof TERMINAL_TASK_STATUSES)[number];

const activeTaskStatuses = new Set<string>(ACTIVE_TASK_STATUSES);
const terminalTaskStatuses = new Set<string>(TERMINAL_TASK_STATUSES);

export function isActiveTaskStatus(status: TaskStatus): boolean {
  return activeTaskStatuses.has(status);
}

export function isTerminalTaskStatus(status: unknown): status is TerminalTaskStatus {
  return typeof status === "string" && terminalTaskStatuses.has(status);
}

/**
 * Budget hard gates. **0 = unlimited** (default): no wall/tool/token/install ceiling;
 * the worker runs until goals pass, fatal error, or operator stop.
 * Pass a positive value via CLI/API only when you want an explicit cap.
 */
export const BUDGET_UNLIMITED = 0;

export function isBudgetUnlimited(max: number | null | undefined): boolean {
  return max == null || max <= 0;
}

/** True when `used` has hit a finite gate. Unlimited max never trips. */
export function isBudgetHit(used: number, max: number | null | undefined): boolean {
  if (isBudgetUnlimited(max)) return false;
  return used >= (max as number);
}

/** True when wall clock since `startedAtMs` exceeds a finite maxWallMs. */
export function isWallHit(
  startedAtMs: number,
  maxWallMs: number | null | undefined,
  nowMs = Date.now(),
): boolean {
  if (isBudgetUnlimited(maxWallMs)) return false;
  return nowMs - startedAtMs >= (maxWallMs as number);
}

/** Optional finite presets (only if you opt in via --max-*). */
export const LONG_RUN_MAX_WALL_MS = 3 * 24 * 60 * 60 * 1000; // 259_200_000
export const LONG_RUN_MAX_TOOL_CALLS = 100_000;
export const LONG_RUN_MAX_TOKENS = 50_000_000;
export const LONG_RUN_MAX_INSTALLS = 200;

export const BudgetSchema = z.object({
  /** 0 = unlimited */
  maxTokens: z.number().int().nonnegative().default(BUDGET_UNLIMITED),
  /** 0 = unlimited */
  maxWallMs: z.number().int().nonnegative().default(BUDGET_UNLIMITED),
  /** 0 = unlimited */
  maxToolCalls: z.number().int().nonnegative().default(BUDGET_UNLIMITED),
  /** 0 = unlimited */
  maxInstalls: z.number().int().nonnegative().default(BUDGET_UNLIMITED),
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
  /**
   * Allowed targets: host, URL host, IPv4 CIDR (`10.0.0.0/8`),
   * wildcard (`*.example.com`), bare domain (covers subdomains), or `*`.
   * Matching is formalized in `scope.ts` (`targetAllows` / `admitAddress`).
   */
  targets: z.array(z.string().min(1)).min(1),
  /** Patterns that always deny even if they also match targets. */
  outOfScope: z.array(z.string()).default([]),
  /** Default lowest rung; raise explicitly per task. */
  capability: AuthCapabilitySchema.default("observe"),
});
export type AuthScope = z.infer<typeof AuthScopeSchema>;

export * from "./scope.js";
export * from "./fanout.js";
export * from "./family-key.js";

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

/**
 * P4 — bounded Explore concurrency (user-set at task create).
 * Default 1 = serial single-worker (current behavior).
 * Hard ceiling 16; effective spawn count is resolved at start.
 */
export const MAX_CONCURRENT_EXPLORES = 16 as const;

export const ExecutionConfigSchema = z.object({
  /**
   * Max concurrent Explore workers for this task.
   * Shared History + Intent CAS; each worker keeps its own Durable checkpoint.
   */
  maxConcurrentExplores: z
    .number()
    .int()
    .min(1)
    .max(MAX_CONCURRENT_EXPLORES)
    .default(1),
  /**
   * Hard cap on Intents proposed during a single Reason wave
   * (open proposed+claimed+running count while phase=reason).
   */
  maxIntentsPerReason: z
    .number()
    .int()
    .min(1)
    .max(64)
    .default(DEFAULT_MAX_INTENTS_PER_REASON),
  /**
   * Max open Intents whose primary asset shares the same root
   * (registrable domain or IPv4 /24).
   */
  maxIntentsPerAssetRoot: z
    .number()
    .int()
    .min(1)
    .max(32)
    .default(DEFAULT_MAX_INTENTS_PER_ASSET_ROOT),
  /**
   * Claimed Explore Intent wall timeout. On expiry Worker force-concludes
   * with a partial Fact (Cairn dual-stage). 0 = disabled.
   */
  exploreTimeoutMs: z
    .number()
    .int()
    .nonnegative()
    .default(DEFAULT_EXPLORE_TIMEOUT_MS),
  /** Reason project-level lease TTL for multi-Explore CAS. 0 = disabled. */
  reasonLeaseMs: z
    .number()
    .int()
    .nonnegative()
    .default(DEFAULT_REASON_LEASE_MS),
});
export type ExecutionConfig = z.infer<typeof ExecutionConfigSchema>;

/** Resolve how many Explore processes to spawn (never above configured or target count). */
export function resolveExploreWorkerCount(opts: {
  maxConcurrentExplores: number;
  targetCount: number;
}): number {
  const configured = Math.min(
    MAX_CONCURRENT_EXPLORES,
    Math.max(1, Math.floor(opts.maxConcurrentExplores) || 1),
  );
  const targets = Math.max(1, Math.floor(opts.targetCount) || 1);
  return Math.min(configured, targets);
}

export const CreateTaskRequestSchema = z.object({
  tenantId: z.string().min(1).default("default"),
  name: z.string().min(1).default("untitled"),
  auth: AuthScopeSchema,
  goals: z.array(GoalSpecSchema).min(1),
  budget: BudgetSchema.optional().default({
    maxTokens: BUDGET_UNLIMITED,
    maxWallMs: BUDGET_UNLIMITED,
    maxToolCalls: BUDGET_UNLIMITED,
    maxInstalls: BUDGET_UNLIMITED,
    relayTokenThreshold: 30_000,
    relayMinToolCalls: 2,
  }),
  /** Parallel Explore pool size + Reason fanout / Explore timeout (defaults filled). */
  execution: ExecutionConfigSchema.default({
    maxConcurrentExplores: 1,
    maxIntentsPerReason: DEFAULT_MAX_INTENTS_PER_REASON,
    maxIntentsPerAssetRoot: DEFAULT_MAX_INTENTS_PER_ASSET_ROOT,
    exploreTimeoutMs: DEFAULT_EXPLORE_TIMEOUT_MS,
    reasonLeaseMs: DEFAULT_REASON_LEASE_MS,
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
  execution: ExecutionConfigSchema.default({
    maxConcurrentExplores: 1,
    maxIntentsPerReason: DEFAULT_MAX_INTENTS_PER_REASON,
    maxIntentsPerAssetRoot: DEFAULT_MAX_INTENTS_PER_ASSET_ROOT,
    exploreTimeoutMs: DEFAULT_EXPLORE_TIMEOUT_MS,
    reasonLeaseMs: DEFAULT_REASON_LEASE_MS,
  }),
  mock: z.boolean(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  startedAt: z.string().datetime().nullable(),
  finishedAt: z.string().datetime().nullable(),
  /** Soft-hide from the default task list; evidence/report/logs retained. */
  archivedAt: z.string().datetime().nullable().default(null),
  leaseOwner: z.string().nullable(),
  leaseUntil: z.string().datetime().nullable(),
  fence: z.number().int().nonnegative(),
  containerId: z.string().nullable(),
  /** Leader / primary worker pid (slot 0); see workerPids for the full pool. */
  workerPid: z.number().int().nullable(),
  /** All local Explore worker pids (slot order). Empty when docker runtime. */
  workerPids: z.array(z.number().int()).default([]),
  /** Docker container ids when runtime=docker (one per Explore slot). */
  containerIds: z.array(z.string()).default([]),
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
  "tool_gate",
  "lease_acquired",
  "lease_lost",
  "worker_started",
  "worker_stopped",
  "budget_tick",
  "report_written",
  "relay_written",
  "hint_appended",
  "technique_broadcast",
  "reason_lease",
  "explore_timeout_conclude",
]);
export type HistoryEventKind = z.infer<typeof HistoryEventKindSchema>;

/** Human / system tactical injection (Cairn Hint). Absorbed via Observe. */
export const HintSourceSchema = z.enum(["human", "system", "family"]);
export type HintSource = z.infer<typeof HintSourceSchema>;

export const HintSchema = z.object({
  id: z.string().uuid(),
  taskId: z.string().uuid(),
  text: z.string().min(1).max(4000),
  source: HintSourceSchema.default("human"),
  tags: z.array(z.string()).default([]),
  createdAt: z.string().datetime(),
});
export type Hint = z.infer<typeof HintSchema>;

export const CreateHintRequestSchema = z.object({
  text: z.string().min(1).max(4000),
  source: HintSourceSchema.optional().default("human"),
  tags: z.array(z.string()).default([]),
});
export type CreateHintRequest = z.infer<typeof CreateHintRequestSchema>;

/** Mark a confirmed technique Fact as reusable across peer assets (同族迁移). */
export const TRANSFERABLE_TAG = "transferable";
export const familyTag = (key: string) => `family:${key.trim().toLowerCase()}`;

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

/** Passive asset discovery APIs (FOFA / 鹰图 Hunter / user-built). */
export const AssetCollectorKindSchema = z.enum(["fofa", "hunter", "custom"]);
export type AssetCollectorKind = z.infer<typeof AssetCollectorKindSchema>;

export const AssetCollectorConfigSchema = z.object({
  id: z.string().min(1).regex(/^[a-z0-9][a-z0-9_-]{0,63}$/i),
  name: z.string().min(1),
  kind: AssetCollectorKindSchema,
  enabled: z.boolean().default(false),
  builtin: z.boolean().default(false),
  /** FOFA email; unused for hunter/custom unless custom auth needs it. */
  email: z.string().default(""),
  apiKey: z.string().default(""),
  baseUrl: z.string().default(""),
  /** custom only */
  method: z.enum(["GET", "POST"]).default("GET"),
  authHeader: z.string().default(""),
  authQueryParam: z.string().default(""),
  queryParam: z.string().default("q"),
  queryEncoding: z.enum(["plain", "base64"]).default("plain"),
  bodyTemplate: z.string().default(""),
  resultPath: z.string().default(""),
  addressFields: z.array(z.string()).default(["host", "ip", "domain", "url"]),
});
export type AssetCollectorConfig = z.infer<typeof AssetCollectorConfigSchema>;

/** Worker-facing collector (secrets via env, not plaintext in manifest). */
export const WorkerAssetCollectorSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  kind: AssetCollectorKindSchema,
  enabled: z.boolean(),
  baseUrl: z.string(),
  emailEnv: z.string().optional(),
  apiKeyEnv: z.string(),
  method: z.enum(["GET", "POST"]).default("GET"),
  authHeader: z.string().default(""),
  authQueryParam: z.string().default(""),
  queryParam: z.string().default("q"),
  queryEncoding: z.enum(["plain", "base64"]).default("plain"),
  bodyTemplate: z.string().default(""),
  resultPath: z.string().default(""),
  addressFields: z.array(z.string()).default(["host", "ip", "domain", "url"]),
});
export type WorkerAssetCollector = z.infer<typeof WorkerAssetCollectorSchema>;

export const BUILTIN_ASSET_COLLECTORS: AssetCollectorConfig[] = [
  {
    id: "fofa",
    name: "FOFA",
    kind: "fofa",
    enabled: false,
    builtin: true,
    email: "",
    apiKey: "",
    baseUrl: "https://fofa.info/api/v1/search/all",
    method: "GET",
    authHeader: "",
    authQueryParam: "",
    queryParam: "qbase64",
    queryEncoding: "base64",
    bodyTemplate: "",
    resultPath: "results",
    addressFields: ["host", "ip", "domain"],
  },
  {
    id: "hunter",
    name: "鹰图 (Hunter)",
    kind: "hunter",
    enabled: false,
    builtin: true,
    email: "",
    apiKey: "",
    baseUrl: "https://hunter.qianxin.com/openApi/search",
    method: "GET",
    authHeader: "",
    authQueryParam: "",
    queryParam: "search",
    queryEncoding: "base64",
    bodyTemplate: "",
    resultPath: "data.arr",
    addressFields: ["url", "domain", "ip"],
  },
];

/** Keep builtin FOFA/Hunter; preserve user credentials + enabled; append custom. */
export function mergeAssetCollectors(
  existing: AssetCollectorConfig[],
): AssetCollectorConfig[] {
  const prev = new Map(existing.map((c) => [c.id, c]));
  const out: AssetCollectorConfig[] = [];
  const seen = new Set<string>();
  for (const item of BUILTIN_ASSET_COLLECTORS) {
    const old = prev.get(item.id);
    out.push(
      AssetCollectorConfigSchema.parse({
        ...item,
        enabled: old?.enabled ?? item.enabled,
        email: old?.email ?? item.email,
        apiKey: old?.apiKey ?? item.apiKey,
        baseUrl: old?.baseUrl || item.baseUrl,
      }),
    );
    seen.add(item.id);
  }
  for (const rest of existing) {
    if (seen.has(rest.id)) continue;
    out.push(
      AssetCollectorConfigSchema.parse({
        ...rest,
        builtin: false,
        kind: rest.kind === "custom" ? "custom" : rest.kind,
      }),
    );
  }
  return out;
}

export function assetCollectorEnvNames(id: string): {
  emailEnv: string;
  apiKeyEnv: string;
} {
  const slug = id.toUpperCase().replace(/[^A-Z0-9]+/g, "_");
  return {
    emailEnv: `GY_ASSET_${slug}_EMAIL`,
    apiKeyEnv: `GY_ASSET_${slug}_KEY`,
  };
}

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
  execution: ExecutionConfigSchema.default({
    maxConcurrentExplores: 1,
    maxIntentsPerReason: DEFAULT_MAX_INTENTS_PER_REASON,
    maxIntentsPerAssetRoot: DEFAULT_MAX_INTENTS_PER_ASSET_ROOT,
    exploreTimeoutMs: DEFAULT_EXPLORE_TIMEOUT_MS,
    reasonLeaseMs: DEFAULT_REASON_LEASE_MS,
  }),
  /** Stable id for Intent claim CAS (unique per Explore slot). */
  workerId: z.string().min(1).default("w0"),
  /** 0-based Explore slot; slot 0 is bootstrap/reason/report leader. */
  workerSlot: z.number().int().nonnegative().default(0),
  /** Total Explore workers spawned for this task. */
  workerCount: z.number().int().positive().default(1),
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
  /** Enabled asset collectors (FOFA / 鹰图 / custom) for asset_search. */
  assetCollectors: z.array(WorkerAssetCollectorSchema).default([]),
});
export type WorkerManifest = z.infer<typeof WorkerManifestSchema>;

/** True when this process should run Bootstrap / Reason / Report. */
export function isExploreLeader(manifest: Pick<WorkerManifest, "workerSlot" | "workerCount">): boolean {
  return (manifest.workerCount ?? 1) <= 1 || (manifest.workerSlot ?? 0) === 0;
}

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
  assetCollectors: z.array(AssetCollectorConfigSchema).default([]),
});
export type AppSettings = z.infer<typeof AppSettingsSchema>;

export const ModelSettingsPatchSchema = ModelSettingsSchema.partial();
export type ModelSettingsPatch = z.infer<typeof ModelSettingsPatchSchema>;

export const UpdateSettingsPatchSchema = UpdateSettingsSchema.partial();
export type UpdateSettingsPatch = z.infer<typeof UpdateSettingsPatchSchema>;

export const AssetCollectorPatchSchema = AssetCollectorConfigSchema.partial().extend({
  id: z.string().min(1),
});
export type AssetCollectorPatch = z.infer<typeof AssetCollectorPatchSchema>;

export const AddAssetCollectorSchema = AssetCollectorConfigSchema.omit({
  builtin: true,
}).extend({
  kind: z.literal("custom"),
  builtin: z.literal(false).default(false),
  enabled: z.boolean().default(true),
});
export type AddAssetCollector = z.infer<typeof AddAssetCollectorSchema>;

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

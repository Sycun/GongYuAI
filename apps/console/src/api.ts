import type { CoverageReview, CoverageReviewInput, ExecutionTracePage, ShellTraceCall, TaskIntegrationUsage, ProjectIntegrationUsage } from "@gongyuai/contracts";

export type TaskRecord = {
  id: string;
  name: string;
  status: string;
  mock: boolean;
  scopeVersion?: number;
  pauseRequestedAt?: string | null;
  pausedAt?: string | null;
  lastHeartbeatAt?: string | null;
  fence: number;
  leaseOwner: string | null;
  leaseUntil: string | null;
  workerPid: number | null;
  workerPids?: number[];
  containerId: string | null;
  containerIds?: string[];
  dataDir: string;
  auth: {
    authorizationNote: string;
    targets: string[];
    outOfScope?: string[];
    capability?: "observe" | "scan" | "active-lab" | "full";
  };
  goals: Array<{
    id: string;
    title: string;
    description: string;
    evidencePatterns: string[];
    passes: boolean;
    evidencePaths?: string[];
    assessment?: string;
  }>;
  budget: {
    maxTokens: number;
    maxWallMs: number;
    maxToolCalls: number;
    maxInstalls: number;
  };
  execution?: {
    maxConcurrentExplores: number;
    maxIntentsPerReason?: number;
    maxIntentsPerAssetRoot?: number;
    exploreTimeoutMs?: number;
    reasonLeaseMs?: number;
  };
  usage: { tokens: number; toolCalls: number; installs: number };
  error: string | null;
  createdAt: string;
  updatedAt: string;
  finishedAt?: string | null;
  archivedAt?: string | null;
};

export type Overview = {
  total: number;
  active: number;
  archived?: number;
  byStatus: Record<string, number>;
  recent: TaskRecord[];
};

export type AssetRecord = {
  address: string;
  kind: "seed" | "candidate" | "admitted" | "live" | "oos" | string;
  factId: string;
  title: string;
  summary: string;
  source: "auth" | "discover" | string;
  createdAt: string;
  intentId?: string | null;
};

export type FindingRecord = {
  id: string;
  title: string;
  asset: string;
  vulnClass: string;
  severity: "info" | "low" | "medium" | "high" | "critical" | string;
  cvss?: string | null;
  confidence: string;
  status: "tentative" | "verified" | "retested" | "accepted" | "retracted" | string;
  endpoint?: string | null;
  dedupKey: string;
  intentId?: string | null;
  factIds?: string[];
  evidence: Array<{ path: string; sha256: string }>;
  repro?: string;
  impact?: string;
  fix?: string;
  createdAt: string;
  verifiedAt?: string | null;
};

export type HistoryPayload = {
  coverage?: CoverageReview[];
  overview: string;
  goals: TaskRecord["goals"];
  facts: Array<{
    id: string;
    layer: string;
    title: string;
    summary: string;
    createdAt: string;
    intentId?: string | null;
    evidencePath?: string | null;
    tags?: string[];
  }>;
  intents: Array<{
    id: string;
    title: string;
    status: string;
    summary?: string;
    sourceFactIds?: string[];
    claimedBy?: string | null;
    createdAt?: string;
    updatedAt?: string;
    concludedAt?: string | null;
    conclusion?: string | null;
  }>;
  events: unknown[];
  assets?: AssetRecord[];
  findings?: FindingRecord[];
  retestRequests?: RetestRequestRecord[];
  peerReviews?: PeerReviewRecord[];
  hints?: Array<{
    id: string;
    text: string;
    source: string;
    tags?: string[];
    createdAt: string;
  }>;
};

export type RetestRequestRecord = {
  id: string;
  requester: string;
  role?: string;
  findingIds: string[];
  reason: string;
  evidencePath?: string;
  sha256?: string;
  status: "pending" | "fulfilled";
  fulfilledAt?: string;
  fulfilledResult?: string;
  createdAt: string;
};

export type PeerReviewRecord = {
  id: string;
  taskId: string;
  engagementId: string;
  reviewer: string;
  role: string;
  sourceTaskId: string;
  findingId?: string;
  factId?: string;
  decision: "confirm" | "challenge" | "retest-requested";
  basis: string;
  evidencePath?: string;
  sha256?: string;
  createdAt: string;
};

export type ScorecardPayload = {
  taskId: string;
  capturedAt: string;
  snapshotSha256: string;
  denominator: number;
  totalGoals: number;
  applicable: boolean;
  historicallyPassed: number;
  currentlySupported: number;
  unknownAttribution: number;
  retractedReferences: number;
  coverage: {
    tested: number;
    partial: number;
    blocked: number;
    untested: number;
    unregistered: number;
  };
  findings: { verified: number; tentative: number; retracted: number; other: number };
  goals: Array<{
    goalId: string;
    title: string;
    historicalPass: boolean;
    currentSupported: boolean;
    verdict: string;
    coverage: string;
    missingAttribution: boolean;
  }>;
};

export type ReconcileResultPayload = {
  result: {
    version: 1;
    name: string;
    keyField: string;
    compareFields: string[];
    baseline: { path: string; format: string | null; rows: number; sha256: string | null };
    current: { path: string; format: string | null; rows: number; sha256: string | null };
    missingMaterials: string[];
    counts: {
      added: number; removed: number; changed: number; unchanged: number;
      missing: number; unknown: number; totalKeys: number;
    };
    items: Array<{
      key: string;
      status: string;
      baselineLine: number | null;
      currentLine: number | null;
      changes: Array<{ field: string; before: string | null; after: string | null }>;
      reason?: string;
    }>;
  };
  evidencePath: string;
  evidenceSha256: string;
  factId: string | null;
  materials: {
    baseline: { path: string; present: boolean; sha256: string | null };
    current: { path: string; present: boolean; sha256: string | null };
  };
};

export type HintRecord = {
  id: string;
  taskId?: string;
  text: string;
  source: string;
  tags?: string[];
  createdAt: string;
};

export type RuntimePayload = {
  externalState?: "running" | "pause_requested" | "stopping" | "paused" | "stopped" | "unknown";
  lastConfirmedAt?: string | null;
  scopeVersion?: number;
  leaseOwner: string | null;
  leaseUntil: string | null;
  fence: number;
  workerPid: number | null;
  workerPids?: number[];
  containerId: string | null;
  containerIds?: string[];
  execution?: TaskRecord["execution"];
  phase?: string | null;
  activeIntentId?: string | null;
  workerStatus: unknown;
  hasCheckpoint: boolean;
  dataDir: string;
  progress?: string[];
  trace?: ExecutionTracePage;
  integrations?: TaskIntegrationUsage;
  recentFacts?: Array<{
    id?: string;
    title: string;
    summary: string;
    layer: string;
    createdAt: string;
  }>;
  recentIntents?: Array<{ title: string; status: string }>;
  usage?: { tokens: number; toolCalls: number; installs: number };
};

export type EvidenceList = {
  files: Array<{ path: string; size: number; mtime: string }>;
};

async function request<T>(path: string, opts?: RequestInit): Promise<{ json: T; text: string }> {
  const res = await fetch(path, opts);
  const text = await res.text();
  let json = null as T | null;
  try {
    json = JSON.parse(text) as T;
  } catch {
    /* plain text */
  }
  if (!res.ok) {
    const err = (json as { error?: string } | null)?.error || text || res.statusText;
    throw new Error(err);
  }
  return { json: (json ?? ({} as T)), text };
}

export type McpServerPublic = {
  id: string;
  name: string;
  description?: string;
  category?: string;
  enabled: boolean;
  builtin: boolean;
  source: "builtin" | "user";
  transport: "builtin" | "stdio" | "http";
  rootDir?: string;
  command?: string;
  args?: string[];
  url?: string;
  envConfigured: boolean;
  envKeys: string[];
};

export type SkillPackPublic = {
  id: string;
  name: string;
  description?: string;
  enabled: boolean;
  builtin: boolean;
  source: "builtin" | "user";
  rootDir: string;
};

export type AssetCollectorPublic = {
  id: string;
  name: string;
  kind: "fofa" | "hunter" | "custom";
  enabled: boolean;
  builtin: boolean;
  baseUrl: string;
  method: "GET" | "POST";
  authHeader: string;
  authQueryParam: string;
  queryParam: string;
  queryEncoding: "plain" | "base64";
  bodyTemplate: string;
  resultPath: string;
  addressFields: string[];
  emailConfigured: boolean;
  apiKeyConfigured: boolean;
  emailMask: string;
  apiKeyMask: string;
};

export type PublicSettings = {
  model: {
    provider: string;
    modelId: string;
    baseUrl: string;
    visionEnabled: boolean;
    visionModelId: string;
    apiKeyConfigured: boolean;
    apiKeyMask: string;
  };
  update: {
    githubUrl: string;
    branch: string;
    githubTokenConfigured: boolean;
    githubTokenMask: string;
    lastCheckedAt: string | null;
    lastUpdatedAt: string | null;
    lastCommit: string | null;
  };
  mcpServers: McpServerPublic[];
  skillPacks: SkillPackPublic[];
  assetCollectors: AssetCollectorPublic[];
  version: string;
};

export type UsageStats = {
  integrations?: ProjectIntegrationUsage;
  totals: { tokens: number; toolCalls: number; installs: number; tasks: number };
  byTask: Array<{
    id: string;
    name: string;
    status: string;
    tokens: number;
    toolCalls: number;
    installs: number;
    updatedAt: string;
  }>;
};

export type UpdateJobStatus = {
  phase: string;
  message: string;
  startedAt: string | null;
  finishedAt: string | null;
  commit: string | null;
  error: string | null;
  silent: boolean;
};

export type CreateTaskBody = {
  name: string;
  mock?: boolean;
  auth: {
    authorizationNote: string;
    targets: string[];
    outOfScope?: string[];
  };
  goals: Array<{
    id: string;
    title: string;
    description: string;
    evidencePatterns: string[];
  }>;
  budget?: {
    maxTokens?: number;
    maxWallMs?: number;
    maxToolCalls?: number;
    maxInstalls?: number;
  };
  execution?: {
    maxConcurrentExplores: number;
  };
};

export const api = {
  health: () => request<{ ok: boolean }>("/health"),
  overview: () => request<Overview>("/overview"),
  tasks: () => request<{ tasks: TaskRecord[] }>("/tasks"),
  createTask: (body: CreateTaskBody) =>
    request<{ task: TaskRecord }>("/tasks", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  stop: (id: string) => request<{ task: TaskRecord }>(`/tasks/${id}/stop`, { method: "POST" }),
  start: (id: string) => request<{ task: TaskRecord }>(`/tasks/${id}/start`, { method: "POST" }),
  pause: (id: string) => request<{ task: TaskRecord }>(`/tasks/${id}/pause`, { method: "POST" }),
  resume: (id: string) => request<{ task: TaskRecord }>(`/tasks/${id}/resume`, { method: "POST" }),
  updateScope: (id: string, body: { auth: TaskRecord["auth"]; reason: string }) =>
    request<{ task: TaskRecord }>(`/tasks/${id}/scope`, { method: "POST", body: JSON.stringify(body) }),
  archive: (id: string) =>
    request<{ task: TaskRecord }>(`/tasks/${id}/archive`, { method: "POST" }),
  unarchive: (id: string) =>
    request<{ task: TaskRecord }>(`/tasks/${id}/unarchive`, { method: "POST" }),
  history: (id: string) => request<HistoryPayload>(`/tasks/${id}/history`),
  assets: (id: string) => request<{ assets: AssetRecord[] }>(`/tasks/${id}/assets`),
  hints: (id: string) => request<{ hints: HintRecord[] }>(`/tasks/${id}/hints`),
  createHint: (id: string, body: { text: string; source?: string; tags?: string[] }) =>
    request<{ hint: HintRecord }>(`/tasks/${id}/hints`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  runtime: (id: string) => request<RuntimePayload>(`/tasks/${id}/runtime`),
  executionTrace: (id: string, before: number) =>
    request<ExecutionTracePage>(`/tasks/${id}/trace?before=${before}`),
  executionStepCalls: (id: string, stepId: string, signal: AbortSignal) =>
    request<{ calls: ShellTraceCall[] }>(`/tasks/${id}/trace/${encodeURIComponent(stepId)}`, { signal }),
  evidence: (id: string) => request<EvidenceList>(`/tasks/${id}/evidence`),
  evidenceFile: (id: string, path: string) =>
    request<string>(`/tasks/${id}/evidence/file?path=${encodeURIComponent(path)}`),
  recordCoverage: (id: string, body: CoverageReviewInput) =>
    request<{ coverage: CoverageReview }>(`/tasks/${id}/coverage`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
    }),
  delivery: (id: string) => request<{ summary: string; hasReport: boolean }>(`/tasks/${id}/delivery`),
  scorecard: (id: string) => request<{ scorecard: ScorecardPayload }>(`/tasks/${id}/scorecard`),
  reconcile: (id: string, body: {
    name?: string;
    baseline: { path: string; format?: "csv" | "json"; keyField?: string };
    current: { path: string; format?: "csv" | "json"; keyField?: string };
    keyField?: string;
    compareFields?: string[];
    requiredKeys?: string[];
  }) =>
    request<ReconcileResultPayload>(`/tasks/${id}/reconcile`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
    }),
  reconcileResults: (id: string) =>
    request<{ results: Array<{ factId: string; title: string; summary: string; evidencePath: string | null; createdAt: string }> }>(`/tasks/${id}/reconcile`),
  retestRequests: (id: string) => request<{ requests: RetestRequestRecord[] }>(`/tasks/${id}/retest-requests`),
  peerReviews: (id: string) => request<{ reviews: PeerReviewRecord[] }>(`/tasks/${id}/peer-reviews`),
  report: (id: string) => request<string>(`/tasks/${id}/report`),
  logs: (id: string) => request<string>(`/tasks/${id}/logs`),
  settings: () => request<PublicSettings>("/settings"),
  saveModel: (body: Record<string, unknown>) =>
    request<PublicSettings>("/settings/model", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  saveUpdateCfg: (body: Record<string, unknown>) =>
    request<PublicSettings>("/settings/update", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  testModel: () =>
    request<{
      ok: boolean;
      status?: number;
      error?: string;
      modelId?: string;
      baseUrl?: string;
      visionEnabled?: boolean;
    }>("/settings/model/test", { method: "POST" }),
  usage: (integrations = false) => request<UsageStats>(integrations ? "/settings/usage?integrations=1" : "/settings/usage"),
  updateStatus: () => request<UpdateJobStatus>("/settings/update/status"),
  runUpdate: () =>
    request<UpdateJobStatus>("/settings/update/run", { method: "POST" }),
  rescanTools: () =>
    request<PublicSettings>("/settings/tools/rescan", { method: "POST" }),
  toggleTools: (body: { kind: "mcp" | "skill"; id: string; enabled: boolean }) =>
    request<PublicSettings>("/settings/tools/toggle", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  addMcp: (body: Record<string, unknown>) =>
    request<PublicSettings>("/settings/tools/mcp", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  removeMcp: (id: string) =>
    request<PublicSettings>(`/settings/tools/mcp/${encodeURIComponent(id)}`, {
      method: "DELETE",
    }),
  importSkill: (body: Record<string, unknown>) =>
    request<PublicSettings>("/settings/tools/skills/import", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  removeSkill: (id: string) =>
    request<PublicSettings>(`/settings/tools/skills/${encodeURIComponent(id)}`, {
      method: "DELETE",
    }),
  saveAssetCollector: (body: Record<string, unknown>) =>
    request<PublicSettings>("/settings/asset-collectors", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  addAssetCollector: (body: Record<string, unknown>) =>
    request<PublicSettings>("/settings/asset-collectors", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  toggleAssetCollector: (body: { id: string; enabled: boolean }) =>
    request<PublicSettings>("/settings/asset-collectors/toggle", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  removeAssetCollector: (id: string) =>
    request<PublicSettings>(`/settings/asset-collectors/${encodeURIComponent(id)}`, {
      method: "DELETE",
    }),
};

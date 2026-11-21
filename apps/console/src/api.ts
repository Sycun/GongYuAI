export type TaskRecord = {
  id: string;
  name: string;
  status: string;
  mock: boolean;
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
  }>;
  budget: {
    maxTokens: number;
    maxWallMs: number;
    maxToolCalls: number;
    maxInstalls: number;
  };
  execution?: {
    maxConcurrentExplores: number;
  };
  usage: { tokens: number; toolCalls: number; installs: number };
  error: string | null;
  createdAt: string;
  updatedAt: string;
};

export type Overview = {
  total: number;
  active: number;
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

export type HistoryPayload = {
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
  hints?: Array<{
    id: string;
    text: string;
    source: string;
    tags?: string[];
    createdAt: string;
  }>;
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
  leaseOwner: string | null;
  leaseUntil: string | null;
  fence: number;
  workerPid: number | null;
  workerPids?: number[];
  containerId: string | null;
  containerIds?: string[];
  execution?: { maxConcurrentExplores: number };
  workerStatus: unknown;
  hasCheckpoint: boolean;
  dataDir: string;
  progress?: string[];
  recentFacts?: Array<{
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
  evidence: (id: string) => request<EvidenceList>(`/tasks/${id}/evidence`),
  evidenceFile: (id: string, path: string) =>
    request<string>(`/tasks/${id}/evidence/file?path=${encodeURIComponent(path)}`),
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
  usage: () => request<UsageStats>("/settings/usage"),
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

export type TaskRecord = {
  id: string;
  name: string;
  status: string;
  mock: boolean;
  fence: number;
  leaseOwner: string | null;
  leaseUntil: string | null;
  workerPid: number | null;
  containerId: string | null;
  dataDir: string;
  auth: { authorizationNote: string; targets: string[]; outOfScope?: string[] };
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

export type HistoryPayload = {
  overview: string;
  goals: TaskRecord["goals"];
  facts: Array<{
    id: string;
    layer: string;
    title: string;
    summary: string;
    createdAt: string;
  }>;
  intents: Array<{ id: string; title: string; status: string }>;
  events: unknown[];
};

export type RuntimePayload = {
  leaseOwner: string | null;
  leaseUntil: string | null;
  fence: number;
  workerPid: number | null;
  containerId: string | null;
  workerStatus: unknown;
  hasCheckpoint: boolean;
  dataDir: string;
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

export const api = {
  health: () => request<{ ok: boolean }>("/health"),
  overview: () => request<Overview>("/overview"),
  tasks: () => request<{ tasks: TaskRecord[] }>("/tasks"),
  stop: (id: string) => request<{ task: TaskRecord }>(`/tasks/${id}/stop`, { method: "POST" }),
  history: (id: string) => request<HistoryPayload>(`/tasks/${id}/history`),
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
};

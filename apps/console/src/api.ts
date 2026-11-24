import type { ChatApproval, ChatCatalog, ChatConnection, ChatProfile, CommandReviewView, CoverageReview, CoverageReviewInput, Credential, ExecutionTracePage, FindingRetest, FindingValidation, HttpTransaction, EngagementAudit, OastHit, OastToken, PlanStep, ShellTraceCall, TaskIntegrationUsage, ProjectIntegrationUsage } from "@gongyuai/contracts";
import type { TaskArchiveState } from "@gongyuai/contracts";
import type {
  KnowledgeEmbeddingPatch,
  KnowledgeEmbeddingTestInput,
  KnowledgeEmbeddingTestResult,
  KnowledgeEmbeddingView,
  KnowledgeImportInput,
  KnowledgeImportResult,
  KnowledgeIndexStatus,
  KnowledgeMaterialListItem,
  KnowledgeReaderScope,
  KnowledgeSearchMode,
  KnowledgeSearchResult,
  KnowledgeSummary,
} from "@gongyuai/contracts";

export type TaskRecord = {
  id: string;
  name: string;
  engagementId: string;
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
    authorizationNote?: string;
    targets: string[];
    outOfScope?: string[];
    capability?: "observe" | "scan" | "active-lab" | "full";
    roe?: string;
  };
  goals: Array<{
    id: string;
    title: string;
    description: string;
    evidencePatterns: string[];
    passes: boolean;
    evidencePaths?: string[];
    assessment?: string;
    /** 目标类型：file = 普通材料留存；business-reconcile = 业务核算。 */
    kind?: "file" | "business-reconcile";
    /** 业务核算配置（建档时由界面填、服务端落库，恢复后仍读这一份）。 */
    business?: BusinessReconcileConfig;
    /** 核算态：缺材料 / 待重算 / 结论不合格 / 可判定 / 已通过。 */
    reconcileState?: ReconcileStateReport | null;
    /** 目标级核算条件：声明后只挂差异文件不算完成比对。 */
    reconcileGate?: {
      pattern: string;
      maxUnknown: number;
      maxAmbiguous: number;
      names?: string[];
    };
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
  commandReview?: CommandReviewView;
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
  /** 任务的核算版本归档（版本号倒序），复核输入与结果一一对应。 */
  reconcileRevisions?: ArchivedReconcile[];
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
  events: Array<{
    id?: string;
    kind?: string;
    payload?: Record<string, unknown>;
    createdAt?: string;
  }>;
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
      duplicates?: Array<{
        material: "baseline" | "current";
        line: number;
        endLine: number;
        fields: Record<string, string>;
      }>;
    }>;
  };
  evidencePath: string;
  evidenceSha256: string;
  factId: string | null;
  /** 本次核算的版本身份（首次判定用它核对输入）。 */
  revision?: ReconcileRevision;
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

/** P14 本地隧道（pivot）元数据；只绑 127.0.0.1。 */
export type TunnelMeta = {
  id: string;
  kind: "socat" | "ssh-local" | "ssh-socks" | "chisel-socks";
  targetHost: string;
  targetPort: number | null;
  localPort: number;
  pid: number | null;
  status: "running" | "closed" | "error";
  command: string;
  logPath: string;
  createdAt: string;
  updatedAt: string;
  via?: string;
  error?: string;
};

/** P14 只读投影：事务、计划、凭据（secretRef 已脱敏）、复测、带外回调与隧道。 */
export type TaskP14Payload = {
  transactions: HttpTransaction[];
  plan: PlanStep[];
  credentials: Credential[];
  retests: FindingRetest[];
  validations?: FindingValidation[];
  oastTokens: OastToken[];
  oastHits: OastHit[];
  tunnels?: TunnelMeta[];
};

export type AssetHistoryHit = {
  taskId: string;
  name: string;
  engagementId: string;
  status: string;
  createdAt: string;
  assets: Array<{
    address: string;
    kind: string;
    assetType: string | null;
    weight: number;
    createdAt: string;
  }>;
  findings: Array<{
    id: string;
    title: string;
    severity: string;
    status: string;
    asset: string;
    endpoint: string | null;
    vulnClass: string;
    verifiedAt: string | null;
  }>;
};

/** 跨任务「历史接触」：只作线索，不是本次授权，也不写入当前图。 */
export type AssetHistoryPayload = {
  host: string;
  hits: AssetHistoryHit[];
  note: string;
};

export type Probe<T> =
  | { ok: true; status: number; json: T; text: string; kind: "ok" }
  | { ok: false; status: number; error: string; kind: "unregistered" | "forbidden" | "failed" | "aborted" };

export async function probe<T>(path: string, signal?: AbortSignal, init?: RequestInit): Promise<Probe<T>> {
  try {
    const res = await fetch(path, { ...init, signal });
    const text = await res.text();
    let json = null as T | null;
    try { json = text ? JSON.parse(text) as T : null; } catch { /* 非 JSON */ }
    if (res.status === 404) return { ok: false, status: 404, error: (json as { error?: string } | null)?.error || "未注册", kind: "unregistered" };
    if (res.status === 401 || res.status === 403) {
      const body = json as { message?: string; error?: string } | null;
      return { ok: false, status: res.status, error: body?.message || body?.error || "无权查看", kind: "forbidden" };
    }
    if (!res.ok) {
      const error = (json as { error?: string } | null)?.error || text || res.statusText || "读取失败";
      return { ok: false, status: res.status, error, kind: "failed" };
    }
    return { ok: true, status: res.status, json: (json ?? ({} as T)), text, kind: "ok" };
  } catch (err) {
    if (signal?.aborted) return { ok: false, status: 0, error: "", kind: "aborted" };
    return { ok: false, status: 0, error: err instanceof Error ? err.message : "读取失败", kind: "failed" };
  }
}

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
  /** 系统固定在任务启动时加载（常开核），不受用户偏好影响。 */
  startupForced: boolean;
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
  knowledgeEmbedding: KnowledgeEmbeddingView;
  version: string;
};

export type KnowledgeScopeParam = { engagementId?: string | null; taskId?: string | null };

/** 命中片段的原文与上下文响应：整章原文、同章相邻片段、面包屑。 */
export type KnowledgeSectionResponse = {
  material: KnowledgeMaterialListItem;
  version: KnowledgeImportResult["version"];
  section: KnowledgeImportResult["sections"][number];
  context: {
    headingPath: string[];
    parentLocator: string;
    parentText: string;
    previous: { locator: string; text: string } | null;
    next: { locator: string; text: string } | null;
  };
};

/** 任务锚定优先：只传 taskId，由服务端解析委托，避免与声明冲突触发 409。 */
function knowledgeQuery(scope: KnowledgeScopeParam, extra?: Record<string, string>): string {
  const params = new URLSearchParams(extra);
  if (scope.taskId) params.set("taskId", scope.taskId);
  else if (scope.engagementId) params.set("engagementId", scope.engagementId);
  const qs = params.toString();
  return qs ? `?${qs}` : "";
}

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

/** 业务核算配置：界面填的就是这一份，服务端据此派生核算条件。 */
export type BusinessReconcileConfig = {
  name: string;
  keyField: string;
  compareFields?: string[];
  requiredKeys?: string[];
  maxUnknown: number;
  maxAmbiguous: number;
  baseline: { path: string; format?: "csv" | "json"; keyField?: string };
  current: { path: string; format?: "csv" | "json"; keyField?: string };
};

/** 一次核算的版本身份：对应目标、两侧材料哈希、采用的核算口径。 */
export type ReconcileRevision = {
  id: string;
  taskId: string;
  goalIds: string[];
  config: BusinessReconcileConfig;
  configDigest: string;
  inputDigest: string;
  baseline: { path: string; format: "csv" | "json" | null; present: boolean; sha256: string | null; rows: number };
  current: { path: string; format: "csv" | "json" | null; present: boolean; sha256: string | null; rows: number };
  createdAt: string;
};

export type ArchivedReconcile = {
  revision: ReconcileRevision;
  evidencePath: string;
  evidenceSha256: string;
  counts: ReconcileResultPayload["result"]["counts"];
};

export type ReconcileStateReport = {
  state: "passed" | "no-result" | "missing-material" | "stale" | "unsatisfied" | "ready";
  reason: string | null;
  latestRevisionId: string | null;
  /** 最近一版核算里的冲突重复键：键、原因、全部来源行（材料 + 物理行号）。 */
  ambiguous?: Array<{
    key: string;
    reason: string;
    lines: Array<{ material: "baseline" | "current"; line: number; endLine: number }>;
  }>;
  readyRevisionId: string | null;
  materials: { baseline: { path: string; present: boolean }; current: { path: string; present: boolean } } | null;
  drift: {
    ok: boolean;
    state: string;
    reason: string | null;
  } | null;
};

export type CreateTaskBody = {
  name: string;
  mock?: boolean;
  auth: {
    authorizationNote?: string;
    targets: string[];
    outOfScope?: string[];
  };
  goals: Array<{
    id: string;
    title: string;
    description: string;
    /** 普通材料留存目标必须给 evidencePatterns；业务核算目标可省略（系统派生）。 */
    evidencePatterns?: string[];
    kind?: "file" | "business-reconcile";
    business?: BusinessReconcileConfig;
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
  chatModels: () => request<ChatCatalog>("/chat/models"),
  saveChatProfile: (profile: ChatProfile, makeDefault: boolean) => request<ChatCatalog>("/settings/chat-models", {
    method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ profile, makeDefault }),
  }),
  queryChatModels: (connection: ChatConnection) => request<{ models: string[] }>("/settings/chat-models/query", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(connection),
  }),
  approval: () => request<ChatApproval>("/settings/approval"),
  saveApproval: (policy: ChatApproval) => request<ChatApproval>("/settings/approval", {
    method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(policy),
  }),
  /** 会话内处理一次待确认命令；重复点击由服务端幂等处理，只回读结果。 */
  commandReview: (id: string, action: "approve" | "reject" | "retry") =>
    request<{ task: TaskRecord }>(`/tasks/${encodeURIComponent(id)}/command-review/${action}`, { method: "POST" }),
  overview: () => request<Overview>("/overview"),
  tasks: (signal?: AbortSignal) => request<{ tasks: TaskRecord[] }>("/tasks", { signal }),
  task: (id: string, signal?: AbortSignal) => request<{ task: TaskRecord }>(`/tasks/${encodeURIComponent(id)}`, { signal }),
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
  taskArchives: () => request<{ tasks: TaskArchiveState[] }>("/tasks/archives", { cache: "no-store" }),
  setTaskArchives: (taskIds: string[], archived: boolean) =>
    request<{ tasks: TaskArchiveState[] }>("/tasks/archives", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ taskIds, archived }),
    }),
  history: (id: string, signal?: AbortSignal) => request<HistoryPayload>(`/tasks/${encodeURIComponent(id)}/history`, { signal }),
  /** P14 只读能力投影；凭据只返回脱敏后的 secretRef。 */
  getTaskP14: (id: string, signal?: AbortSignal) =>
    request<TaskP14Payload>(`/tasks/${encodeURIComponent(id)}/p14`, { signal }),
  /** 跨任务历史接触（只读线索）；address 可为 host 或 URL。 */
  /** P15 read-only engagement audit (observations + scorecard). */
  getAudit: (id: string, signal?: AbortSignal) =>
    request<EngagementAudit>(`/tasks/${encodeURIComponent(id)}/audit`, { signal }),
  getValidations: (id: string, findingId?: string, signal?: AbortSignal) =>
    request<{ validations: FindingValidation[] }>(
      `/tasks/${encodeURIComponent(id)}/validations${findingId ? `?findingId=${encodeURIComponent(findingId)}` : ""}`,
      { signal },
    ),
  getAssetHistory: (id: string, address: string, signal?: AbortSignal) =>
    request<AssetHistoryPayload>(
      `/tasks/${encodeURIComponent(id)}/asset-history?address=${encodeURIComponent(address)}`,
      { signal },
    ),
  assets: (id: string) => request<{ assets: AssetRecord[] }>(`/tasks/${id}/assets`),
  hints: (id: string) => request<{ hints: HintRecord[] }>(`/tasks/${id}/hints`),
  createHint: (id: string, body: { text: string; source?: string; tags?: string[] }) =>
    request<{ hint: HintRecord }>(`/tasks/${id}/hints`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  runtime: (id: string, signal?: AbortSignal) => request<RuntimePayload>(`/tasks/${encodeURIComponent(id)}/runtime`, { signal }),
  executionTrace: (id: string, before: number) =>
    request<ExecutionTracePage>(`/tasks/${id}/trace?before=${before}`),
  executionStepCalls: (id: string, stepId: string, signal: AbortSignal) =>
    request<{ calls: ShellTraceCall[] }>(`/tasks/${id}/trace/${encodeURIComponent(stepId)}`, { signal }),
  evidence: (id: string) => request<EvidenceList>(`/tasks/${id}/evidence`),
  saveEvidence: (id: string, body: { path: string; content: string }) =>
    request<{ path: string }>(`/tasks/${id}/evidence`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  /** 导入或替换一份原始材料（同一路径即替换）。 */
  writeEvidence: (id: string, body: { path: string; content: string }) =>
    request<{ path: string; sha256: string; replaced: boolean }>(`/tasks/${id}/evidence`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  /** 撤回一份材料：文件移出 evidence/，撤回前的哈希记进事件台账。 */
  removeEvidence: (id: string, path: string) =>
    request<{ removed: string; sha256: string }>(
      `/tasks/${id}/evidence?path=${encodeURIComponent(path)}`,
      { method: "DELETE" },
    ),
  /** 按当前证据触发一次目标判定（与 worker 同一条实现）。 */
  assertGoal: (id: string, goalId: string) =>
    request<{
      ok: boolean;
      goal: TaskRecord["goals"][number];
      reason?: string;
      reconcileState?: ReconcileStateReport | null;
    }>(`/tasks/${id}/goals/assert`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ goalId }),
    }),
  /** 按目标建档时持久化的配置核算（不用手抄路径）。 */
  reconcileGoal: (id: string, goalId: string) =>
    request<ReconcileResultPayload>(`/tasks/${id}/reconcile`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ goalId }),
    }),
  evidenceFile: (id: string, path: string, signal?: AbortSignal) =>
    request<string>(`/tasks/${id}/evidence/file?path=${encodeURIComponent(path)}`, { signal }),
  corrections: (id: string) => request<{ corrections: Array<Record<string, unknown>> }>(`/tasks/${id}/corrections`),
  snapshot: (id: string) => request<Record<string, unknown>>(`/tasks/${id}/snapshot`),
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
    goalIds?: string[];
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
  saveKnowledgeEmbedding: (patch: KnowledgeEmbeddingPatch) =>
    request<PublicSettings>("/settings/knowledge-embedding", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(patch),
    }),
  testKnowledgeEmbedding: (input: KnowledgeEmbeddingTestInput) =>
    probe<KnowledgeEmbeddingTestResult>("/settings/knowledge-embedding/test", undefined, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    }),
  knowledgeIndex: (scope: KnowledgeScopeParam, signal?: AbortSignal) =>
    probe<{ scope: KnowledgeReaderScope; index: KnowledgeIndexStatus }>(`/knowledge/index${knowledgeQuery(scope)}`, signal),
  knowledgeMaterials: (scope: KnowledgeScopeParam, signal?: AbortSignal) =>
    probe<{ scope: KnowledgeReaderScope; materials: KnowledgeMaterialListItem[] }>(`/knowledge/materials${knowledgeQuery(scope)}`, signal),
  knowledgeSummary: (scope: KnowledgeScopeParam, signal?: AbortSignal) =>
    probe<KnowledgeSummary>(`/knowledge/summary${knowledgeQuery(scope)}`, signal),
  /** 导入一份本地文档。200 = 复用已有版本，201 = 新建；probe.ok 两者都算成功。 */
  knowledgeImport: (body: KnowledgeImportInput) =>
    probe<KnowledgeImportResult>("/knowledge/materials", undefined, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
  /** 命中片段的原文与上下文（整章、同章相邻片段）。 */
  knowledgeSection: (materialId: string, versionId: string, locator: string, scope: KnowledgeScopeParam, signal?: AbortSignal) =>
    probe<KnowledgeSectionResponse>(`/knowledge/materials/${encodeURIComponent(materialId)}/versions/${encodeURIComponent(versionId)}/section`
      + `${knowledgeQuery(scope, { locator })}`, signal),
  knowledgeSearch: (scope: KnowledgeScopeParam, q: string, mode: KnowledgeSearchMode, signal?: AbortSignal) =>
    probe<KnowledgeSearchResult>(`/knowledge/search${knowledgeQuery(scope, { q, mode })}`, signal),
  knowledgeRebuild: (scope: KnowledgeScopeParam, body: { materialId?: string; versionId?: string; versionIds?: string[] } = {}) =>
    probe<{ scope: KnowledgeReaderScope; versions: string[]; status: KnowledgeIndexStatus }>(
      `/knowledge/index/rebuild${knowledgeQuery(scope)}`, undefined,
      { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
  knowledgeRetry: (scope: KnowledgeScopeParam, body: { materialId?: string; versionId?: string; versionIds?: string[] } = {}) =>
    probe<{ scope: KnowledgeReaderScope; queued: string[]; status: KnowledgeIndexStatus }>(
      `/knowledge/index/retry${knowledgeQuery(scope)}`, undefined,
      { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
};

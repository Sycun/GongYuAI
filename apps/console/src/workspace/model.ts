/** 会话当前任务、图请求和进展消息的纯规则。不发请求。 */

export type FocusMode = "follow" | "pinned";
export type StoredFocus = { mode: FocusMode; taskId: string };
export type ViewName = "assets" | "surface" | "execution" | "memory";

const FOCUS_KEY = "gongyuai.chat.focus.v1";

export function readFocusMap(): Record<string, StoredFocus> {
  try {
    const parsed = JSON.parse(localStorage.getItem(FOCUS_KEY) || "{}") as unknown;
    if (!parsed || typeof parsed !== "object") return {};
    return parsed as Record<string, StoredFocus>;
  } catch {
    return {};
  }
}

export function writeFocusMap(map: Record<string, StoredFocus>) {
  localStorage.setItem(FOCUS_KEY, JSON.stringify(map));
}

export function latestReceipt(turns: ReadonlyArray<{ taskId?: string }>): string | null {
  for (let i = turns.length - 1; i >= 0; i -= 1) {
    const id = turns[i]?.taskId;
    if (id) return id;
  }
  return null;
}

export function resolveViewedTask(input: {
  stored?: StoredFocus | null;
  turns: ReadonlyArray<{ taskId?: string }>;
  linkedTaskId?: string | null;
}): { taskId: string | null; mode: FocusMode | "waiting" } {
  if (input.stored?.mode === "pinned" && input.stored.taskId) {
    return { taskId: input.stored.taskId, mode: "pinned" };
  }
  const latest = latestReceipt(input.turns);
  if (latest) return { taskId: latest, mode: "follow" };
  if (input.linkedTaskId) return { taskId: input.linkedTaskId, mode: "follow" };
  return { taskId: null, mode: "waiting" };
}

/** 计划卡只使用与当前任务同一轮的原始问题。手动关联且没有轮次时返回空。 */
export function questionForTask(
  turns: ReadonlyArray<{ id: string; taskId?: string; question: string }>,
  taskId: string | null,
): { turnId: string; taskId: string; question: string } | null {
  if (!taskId) return null;
  for (let i = turns.length - 1; i >= 0; i -= 1) {
    const turn = turns[i];
    if (turn?.taskId === taskId) return { turnId: turn.id, taskId, question: turn.question };
  }
  return null;
}

/** 迟到响应只能写回它自己的任务。 */
export function acceptPayload<T>(requestedTaskId: string, viewingTaskId: string, payload: T): T | null {
  return requestedTaskId === viewingTaskId ? payload : null;
}

export function graphPath(taskId: string, view: "assets" | "execution" | "memory"): string {
  return `/tasks/${encodeURIComponent(taskId)}/graphs/${view}`;
}

/** 攻击面只读覆盖矩阵。独立 /graphs/surface 在证据撤回后可能仍显示旧覆盖。 */
export function surfacePath(taskId: string): string {
  return `/tasks/${encodeURIComponent(taskId)}/coverage-matrix`;
}

export function railRequests(taskId: string): string[] {
  return [graphPath(taskId, "assets"), surfacePath(taskId), graphPath(taskId, "execution")];
}

export function classifyStatus(status: number): "ok" | "unregistered" | "forbidden" | "failed" {
  if (status >= 200 && status < 300) return "ok";
  if (status === 404) return "unregistered";
  if (status === 401 || status === 403) return "forbidden";
  return "failed";
}

export function classifyCapability(taskStatus: number, routeStatus: number): "ok" | "missing-task" | "unregistered" | "forbidden" | "failed" {
  if (taskStatus === 404) return "missing-task";
  if (taskStatus === 401 || taskStatus === 403) return "forbidden";
  if (taskStatus < 200 || taskStatus >= 300) return "failed";
  return classifyStatus(routeStatus);
}

export type GNode = {
  id: string;
  kind: string;
  label: string;
  badge: string | null;
  data: Record<string, unknown>;
};
export type GEdge = {
  id: string;
  from: string;
  to: string;
  kind: string;
  label: string;
  broken: boolean;
};
export type GView = {
  taskId: string;
  view: ViewName;
  nodes: GNode[];
  edges: GEdge[];
  notes: string[];
  empty: boolean;
  generatedAt?: string;
};

export type CoverageCell = {
  asset: string;
  technique: string;
  state: string;
  notes?: string[];
  findingIds?: string[];
};

export type GraphState =
  | { kind: "waiting" }
  | { kind: "loading" }
  | { kind: "empty"; source: string; cells?: CoverageCell[]; graph?: GView }
  | { kind: "unregistered"; path: string }
  | { kind: "forbidden"; path: string }
  | { kind: "failed"; path: string; message: string }
  | { kind: "withheld"; message: string }
  | { kind: "unavailable"; message: string }
  | { kind: "ready"; source: string; graph: GView; cells?: CoverageCell[] };

export function memoryDisplay(
  graph: { taskId?: string; nodes: Array<{ data?: Record<string, unknown> }> },
  taskId: string,
  granted = false,
): "show" | "withheld" | "unavailable" {
  if (!granted) return "unavailable";
  if (graph.taskId !== taskId) return "withheld";
  for (const node of graph.nodes) {
    const foreign = node.data?.taskId;
    if (typeof foreign === "string" && foreign !== taskId) return "withheld";
    const tasks = node.data?.taskIds;
    if (Array.isArray(tasks) && tasks.some((id) => id !== taskId)) return "withheld";
  }
  return "show";
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

export function readGraph(json: unknown, view: ViewName): GView | null {
  const root = asRecord(json);
  const graph = asRecord(root?.graph) ?? root;
  if (!graph || !Array.isArray(graph.nodes) || !Array.isArray(graph.edges)) return null;
  if (graph.view && graph.view !== view) return null;
  const nodes: GNode[] = [];
  for (const item of graph.nodes) {
    const node = asRecord(item);
    if (!node || typeof node.id !== "string" || typeof node.label !== "string") return null;
    nodes.push({
      id: node.id,
      kind: typeof node.kind === "string" ? node.kind : "unknown",
      label: node.label,
      badge: typeof node.badge === "string" ? node.badge : null,
      data: asRecord(node.data) ?? {},
    });
  }
  const edges: GEdge[] = [];
  for (const item of graph.edges) {
    const edge = asRecord(item);
    if (!edge || typeof edge.id !== "string" || typeof edge.from !== "string" || typeof edge.to !== "string") return null;
    edges.push({
      id: edge.id,
      from: edge.from,
      to: edge.to,
      kind: typeof edge.kind === "string" ? edge.kind : "unknown",
      label: typeof edge.label === "string" ? edge.label : "",
      broken: edge.broken === true || edge.kind === "broken",
    });
  }
  return {
    taskId: typeof graph.taskId === "string" ? graph.taskId : "",
    view,
    nodes,
    edges,
    notes: Array.isArray(graph.notes) ? graph.notes.filter((note): note is string => typeof note === "string") : [],
    empty: graph.empty === true || nodes.length === 0,
    generatedAt: typeof graph.generatedAt === "string" ? graph.generatedAt : undefined,
  };
}

export function readCells(json: unknown): CoverageCell[] | null {
  const root = asRecord(json);
  const list = root?.cells;
  if (!Array.isArray(list)) return null;
  const cells: CoverageCell[] = [];
  for (const item of list) {
    const cell = asRecord(item);
    if (!cell || typeof cell.asset !== "string" || typeof cell.technique !== "string" || typeof cell.state !== "string") return null;
    cells.push({
      asset: cell.asset,
      technique: cell.technique,
      state: cell.state,
      notes: Array.isArray(cell.notes) ? cell.notes.filter((note): note is string => typeof note === "string") : [],
      findingIds: Array.isArray(cell.findingIds) ? cell.findingIds.filter((id): id is string => typeof id === "string") : [],
    });
  }
  return cells;
}

export function graphFromCells(taskId: string, cells: CoverageCell[]): GView {
  const assets = new Map<string, GNode>();
  const techniques = new Map<string, GNode>();
  const edges: GEdge[] = [];
  for (const cell of cells) {
    const assetId = `asset:${cell.asset}`;
    const techniqueId = `technique:${cell.technique}`;
    if (!assets.has(assetId)) assets.set(assetId, { id: assetId, kind: "asset", label: cell.asset, badge: null, data: { address: cell.asset } });
    if (!techniques.has(techniqueId)) techniques.set(techniqueId, { id: techniqueId, kind: "technique", label: cell.technique, badge: null, data: {} });
    const unknown = cell.state === "unknown";
    const broken = cell.state === "retracted" || unknown;
    edges.push({
      id: `${assetId}->${techniqueId}:${cell.state}`,
      from: assetId,
      to: techniqueId,
      kind: unknown ? "unknown" : cell.state,
      label: unknown ? "未知" : cell.state,
      broken,
    });
  }
  const nodes = [...assets.values(), ...techniques.values()];
  return {
    taskId,
    view: "surface",
    nodes,
    edges,
    notes: ["覆盖图由本次矩阵响应的 cells 生成，未读取 /graphs/surface。"],
    empty: cells.length === 0,
  };
}

type AssetLike = { address: string; kind?: string; factId?: string; intentId?: string | null; source?: string };
type IntentLike = { id: string; title: string; status?: string; claimedBy?: string | null; sourceFactIds?: string[] };

export function projectAssetGraph(taskId: string, assets: AssetLike[], intents: IntentLike[]): GView {
  const nodes: GNode[] = assets.map((asset) => ({
    id: `asset:${asset.address}`,
    kind: "asset",
    label: asset.address,
    badge: asset.kind ?? null,
    data: { address: asset.address, factId: asset.factId ?? null, source: asset.source ?? null },
  }));
  const edges: GEdge[] = [];
  const byFact = new Map(assets.filter((asset) => asset.factId).map((asset) => [asset.factId as string, asset.address]));
  for (const asset of assets) {
    const target = `asset:${asset.address}`;
    if (!asset.intentId) continue;
    const intent = intents.find((item) => item.id === asset.intentId);
    const intentNode = `intent:${asset.intentId}`;
    if (!nodes.some((node) => node.id === intentNode)) {
      nodes.push({
        id: intentNode,
        kind: "intent",
        label: intent?.title ?? asset.intentId,
        badge: intent?.status ?? "unknown",
        data: intent ? { intentId: intent.id } : { intentId: asset.intentId, missing: true },
      });
    }
    if (!intent) {
      edges.push({ id: `${intentNode}->${target}:missing`, from: intentNode, to: target, kind: "broken", label: "发现意图缺失", broken: true });
      continue;
    }
    edges.push({ id: `${intentNode}->${target}:discovered`, from: intentNode, to: target, kind: "discovered", label: "发现", broken: false });
    for (const factId of intent.sourceFactIds ?? []) {
      const source = byFact.get(factId);
      if (!source) {
        edges.push({ id: `${intentNode}->${target}:lineage:${factId}`, from: intentNode, to: target, kind: "broken", label: "缺少前驱事实", broken: true });
      } else if (source !== asset.address) {
        edges.push({ id: `asset:${source}->${target}:lineage`, from: `asset:${source}`, to: target, kind: "lineage", label: "前驱资产", broken: false });
      }
    }
  }
  return {
    taskId,
    view: "assets",
    nodes,
    edges,
    notes: [`由已注册的资产与历史投影。资产 ${assets.length} 个。`],
    empty: assets.length === 0,
  };
}

type StepLike = { id: string; number: number; tools?: string[]; at?: string };
type JobLike = { id: string; label?: string; status?: string; kind?: string };

export function projectExecutionGraph(taskId: string, steps: StepLike[], jobs: JobLike[]): GView {
  const ordered = [...steps].sort((a, b) => a.number - b.number);
  const nodes: GNode[] = ordered.map((step) => ({
    id: `step:${step.id}`,
    kind: "step",
    label: `步骤 ${step.number}`,
    badge: step.tools?.join(", ") || null,
    data: { stepId: step.id, at: step.at ?? null },
  }));
  const edges: GEdge[] = [];
  for (let i = 1; i < ordered.length; i += 1) {
    edges.push({
      id: `step:${ordered[i - 1]!.id}->step:${ordered[i]!.id}`,
      from: `step:${ordered[i - 1]!.id}`,
      to: `step:${ordered[i]!.id}`,
      kind: "sequence",
      label: "随后",
      broken: false,
    });
  }
  for (const job of jobs) {
    nodes.push({
      id: `job:${job.id}`,
      kind: "job",
      label: job.label || job.id,
      badge: job.status ?? null,
      data: { jobId: job.id, status: job.status ?? null },
    });
  }
  const notes = ["执行步骤来自已注册的 trace。步骤与意图没有对应字段时不绘制这条边。"];
  if (!jobs.length) notes.push("作业节点只在作业接口返回记录后出现。");
  return { taskId, view: "execution", nodes, edges, notes, empty: nodes.length === 0 };
}

export function jobOutcomeLabel(status: string | undefined): string {
  if (status === "succeeded") return "作业执行成功";
  if (status === "failed") return "作业执行失败";
  if (status === "unknown") return "作业状态未知";
  if (status === "running" || status === "draining") return "作业执行中";
  if (status === "queued") return "作业等待中";
  if (status === "paused") return "作业已暂停";
  if (status === "canceled") return "作业已取消";
  return status ? `作业 ${status}` : "作业状态未记录";
}

export function goalOutcomeLabel(passes: boolean): string {
  return passes ? "业务目标通过" : "业务目标未通过";
}

export function lateResultLabel(late: boolean | undefined): string | null {
  return late ? "范围已变化，待复核" : null;
}

export function consultLabel(consult: { status?: string }): string {
  if (consult.status === "open") return "待答";
  if (consult.status === "answered") return "已答";
  if (consult.status === "superseded") return "已替代";
  return consult.status || "未知";
}

export function providerDisposition(action: string, egressAllowed?: boolean): { label: string; raw: { action: string; egressAllowed?: boolean } } {
  const raw = { action, egressAllowed };
  if (action === "retry") return { label: "计划重试", raw };
  if (action === "switch") return { label: "计划切换", raw };
  if (action === "blocked") return { label: "已阻塞", raw };
  return { label: action || "未记录", raw };
}

export type WorkSignal = {
  plan: string;
  result: string;
  block: string;
  decision: string;
  planText: string;
  resultText: string;
  blockText: string;
  decisionText: string;
};
export type NoticeItem = { id: string; at: number; text: string };

export function diffNotices(previous: WorkSignal | null, next: WorkSignal): string[] {
  if (!previous) return [];
  const messages: string[] = [];
  if (previous.plan !== next.plan && next.planText) messages.push(`计划已调整。${next.planText}`);
  if (previous.result !== next.result && next.resultText) messages.push(`收到结果。${next.resultText}`);
  if (previous.block !== next.block && next.blockText) messages.push(`出现阻塞。${next.blockText}`);
  if (previous.decision !== next.decision && next.decisionText) messages.push(`需要你决定。${next.decisionText}`);
  return messages;
}

const NOTICE_PREFIX = "gongyuai.chat.notice.v1.";

function noticeKey(conversationId: string, taskId?: string | null) {
  return NOTICE_PREFIX + conversationId + (taskId ? "." + taskId : "");
}

export function readNotices(conversationId: string | undefined, taskId?: string | null): { signal: WorkSignal | null; items: NoticeItem[] } {
  if (!conversationId) return { signal: null, items: [] };
  try {
    const parsed = JSON.parse(localStorage.getItem(noticeKey(conversationId, taskId)) || "null") as { signal?: WorkSignal; items?: NoticeItem[] } | null;
    if (!parsed) return { signal: null, items: [] };
    return { signal: parsed.signal ?? null, items: Array.isArray(parsed.items) ? parsed.items : [] };
  } catch {
    return { signal: null, items: [] };
  }
}

export function writeNotices(conversationId: string, taskId: string, bundle: { signal: WorkSignal | null; items: NoticeItem[] }) {
  localStorage.setItem(noticeKey(conversationId, taskId), JSON.stringify(bundle));
}

export type AdoptedView = {
  recorded: boolean;
  path?: string;
  sha256?: string;
  revisionId?: string;
  baselinePath?: string;
  baselineSha?: string;
  currentPath?: string;
  currentSha?: string;
  missing: string[];
  conflicts: string[];
  pending: boolean;
  inputNote: string;
};

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

export function readAdopted(payload: Record<string, unknown> | undefined): AdoptedView {
  const adopted = asRecord(payload?.adoptedReconcile);
  const baseline = asRecord(adopted?.baseline);
  const current = asRecord(adopted?.current);
  const missing = strings(adopted?.missingMaterials ?? payload?.missingMaterials);
  const conflicts = strings(adopted?.conflicts ?? payload?.conflicts);
  const recorded = Boolean(adopted);
  return {
    recorded,
    path: typeof adopted?.path === "string" ? adopted.path : undefined,
    sha256: typeof adopted?.sha256 === "string" ? adopted.sha256 : undefined,
    revisionId: typeof adopted?.revisionId === "string" ? adopted.revisionId : undefined,
    baselinePath: typeof baseline?.path === "string" ? baseline.path : undefined,
    baselineSha: typeof baseline?.sha256 === "string" ? baseline.sha256 : undefined,
    currentPath: typeof current?.path === "string" ? current.path : undefined,
    currentSha: typeof current?.sha256 === "string" ? current.sha256 : undefined,
    missing,
    conflicts,
    pending: payload?.pendingRecalc === true,
    inputNote: recorded && !adopted?.revisionId && !baseline && !current
      ? "本版本首次通过事件记录了结果文件和哈希，没有单独的输入版本与两侧材料哈希。"
      : "",
  };
}

export function nodeNavigation(node: GNode, taskId: string):
  | { kind: "link"; href: string; label: string }
  | { kind: "broken"; text: string }
  | { kind: "unknown"; text: string } {
  const data = node.data;
  if (node.kind === "unknown" || node.badge === "unknown" || data.missing === true) {
    return { kind: "unknown", text: "未知：这条记录没有可回链的来源。" };
  }
  if (data.broken === true || node.badge === "broken") {
    return { kind: "broken", text: typeof data.reason === "string" ? data.reason : "关系已断开。" };
  }
  const enc = encodeURIComponent(taskId);
  if (node.kind === "asset" || node.kind === "scope") {
    const address = typeof data.address === "string" ? data.address : node.label;
    return { kind: "link", href: `#/assets/${enc}?asset=${encodeURIComponent(address)}`, label: "打开资产记录" };
  }
  if (node.kind === "intent") {
    const id = typeof data.intentId === "string" ? data.intentId : node.id.replace(/^intent:/, "");
    return { kind: "link", href: `#/history/${enc}?intent=${encodeURIComponent(id)}`, label: "打开意图记录" };
  }
  if (node.kind === "job") {
    const id = typeof data.jobId === "string" ? data.jobId : node.id.replace(/^job:/, "");
    return { kind: "link", href: `#/live/${enc}?job=${encodeURIComponent(id)}`, label: "打开作业" };
  }
  if (node.kind === "consult" || node.kind === "question") {
    const id = typeof data.consultId === "string" ? data.consultId : node.id.replace(/^consult:/, "");
    return { kind: "link", href: `#/live/${enc}?consult=${encodeURIComponent(id)}`, label: "打开待答问题" };
  }
  if (node.kind === "finding") {
    const id = typeof data.findingId === "string" ? data.findingId : node.id.replace(/^finding:/, "");
    return { kind: "link", href: `#/findings/${enc}?finding=${encodeURIComponent(id)}`, label: "打开漏洞记录" };
  }
  if (node.kind === "step") {
    const id = typeof data.stepId === "string" ? data.stepId : node.id.replace(/^step:/, "");
    return { kind: "link", href: `#/live/${enc}?step=${encodeURIComponent(id)}`, label: "打开执行步骤" };
  }
  if (node.kind === "fact") {
    const id = typeof data.factId === "string" ? data.factId : node.id.replace(/^fact:/, "");
    return { kind: "link", href: `#/history/${enc}?fact=${encodeURIComponent(id)}`, label: "打开历史记录" };
  }
  if (node.kind === "technique") {
    return { kind: "link", href: `#/live/${enc}?section=coverage`, label: "打开覆盖表" };
  }
  if (node.kind === "memory") {
    return { kind: "unknown", text: "记忆节点只在内部图谱中心核对，客户会话不打开跨客户记录。" };
  }
  return { kind: "unknown", text: "未知：节点没有可核对的来源记录。" };
}

export function edgeStatement(edge: GEdge): { kind: "broken" | "unknown" | "plain"; text: string } {
  if (edge.kind === "unknown") return { kind: "unknown", text: `未知：${edge.label || "关系没有判定依据。"}` };
  if (edge.broken) return { kind: "broken", text: `断点：${edge.label || "关系已断开。"}` };
  return { kind: "plain", text: edge.label || edge.kind };
}

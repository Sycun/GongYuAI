/**
 * 四图只读投影（第九轮 P2）：资产图 / 攻击面图 / 执行图 / 记忆图 + 因果下钻。
 *
 * 纪律：不建第二状态；所有节点与边都能回链到 History / 证据 / 记忆库的稳定 ID；
 * 缺依据的边标 broken 并写清缺什么，不编造。
 */
import {
  assetRootKey,
  deriveCoverageMatrix,
  graphNodeId,
  isIpv4Cidr,
  normalizeEndpointAddress,
  normalizeHost,
  normalizeServiceAddress,
  targetAllows,
  type AssetRecord,
  type BackgroundJob,
  type CoverageCell,
  type EvidenceImport,
  type Fact,
  type Finding,
  type GraphEdge,
  type GraphNode,
  type GraphView,
  type Intent,
  type MemoryInjection,
  type MemoryNode,
} from "@gongyuai/contracts";

export type AssetGraphInput = {
  taskId: string;
  engagementId: string;
  generatedAt: string;
  targets: readonly string[];
  outOfScope: readonly string[];
  assets: readonly AssetRecord[];
  facts: readonly Fact[];
  intents: readonly Intent[];
};

function isEndpointLike(address: string, assetType?: string | null): boolean {
  const trimmed = address.trim();
  return assetType === "endpoint" || (!isIpv4Cidr(trimmed) && trimmed.includes("/"));
}

function assetAddressIdentity(address: string, assetType?: string | null): string {
  const trimmed = address.trim();
  if (isEndpointLike(trimmed, assetType)) {
    return normalizeEndpointAddress(trimmed);
  }
  if (assetType === "service") {
    return normalizeServiceAddress(trimmed);
  }
  return isIpv4Cidr(trimmed) ? trimmed.toLowerCase() : normalizeHost(trimmed);
}

function assetNodeId(engagementId: string, address: string, assetType?: string | null): string {
  return graphNodeId("asset", `${engagementId}::${assetAddressIdentity(address, assetType)}`);
}

function findingNodeId(id: string): string {
  return graphNodeId("finding", id);
}

function intentNodeId(id: string): string {
  return graphNodeId("intent", id);
}

function edge(from: string, to: string, kind: string, label = "", broken = false): GraphEdge {
  return { id: `${from}->${to}:${kind}`, from, to, kind, label, broken };
}

export function buildAssetGraph(input: AssetGraphInput): GraphView {
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  const seenNodeIds = new Set<string>();
  const seenEdgeIds = new Set<string>();
  const pushNode = (node: GraphNode) => {
    if (seenNodeIds.has(node.id)) return;
    seenNodeIds.add(node.id);
    nodes.push(node);
  };
  const pushEdge = (item: GraphEdge) => {
    if (seenEdgeIds.has(item.id)) return;
    seenEdgeIds.add(item.id);
    edges.push(item);
  };
  const factById = new Map(input.facts.map((fact) => [fact.id, fact]));
  const intentById = new Map(input.intents.map((intent) => [intent.id, intent]));
  const assetByFact = new Map<string, AssetRecord>();

  for (const asset of input.assets) {
    const id = assetNodeId(input.engagementId, asset.address, asset.assetType);
    pushNode({
      id,
      kind: "asset",
      label: asset.address,
      badge: asset.kind,
      data: { factId: asset.factId, source: asset.source, createdAt: asset.createdAt },
    });
    assetByFact.set(asset.factId, asset);
  }

  for (const pattern of input.targets) {
    const id = graphNodeId("scope", pattern);
    pushNode({ id, kind: "scope", label: pattern, badge: "authorized", data: {} });
    for (const asset of input.assets) {
      if (!targetAllows([pattern], asset.address)) continue;
      pushEdge(edge(id, assetNodeId(input.engagementId, asset.address, asset.assetType), "authorizes", "范围内"));
    }
  }
  for (const pattern of input.outOfScope) {
    const id = graphNodeId("scope", `oos:${pattern}`);
    pushNode({ id, kind: "scope", label: pattern, badge: "out-of-scope", data: { outOfScope: true } });
  }

  // 发现血缘：asset_record Fact 的 intentId + 该 Intent 的 sourceFactIds。
  for (const asset of input.assets) {
    if (!asset.intentId) {
      pushEdge(edge(graphNodeId("scope", "seed"), assetNodeId(input.engagementId, asset.address, asset.assetType), "seeded", "初始目标/发现"));
      continue;
    }
    const intent = intentById.get(asset.intentId);
    const target = assetNodeId(input.engagementId, asset.address, asset.assetType);
    if (!intent) {
      pushEdge(edge(target, intentNodeId(asset.intentId), "discovered-by", "发现意图缺失", true));
      continue;
    }
    const iNode = intentNodeId(intent.id);
    pushNode({ id: iNode, kind: "intent", label: intent.title, badge: intent.status, data: { technique: intent.technique } });
    pushEdge(edge(iNode, target, "discovered", "发现"));
    for (const factId of intent.sourceFactIds) {
      const sourceAsset = assetByFact.get(factId);
      const sourceFact = factById.get(factId);
      if (sourceAsset) {
        const sourceId = assetNodeId(input.engagementId, sourceAsset.address, sourceAsset.assetType);
        if (sourceId !== target) {
          pushEdge(edge(sourceId, target, "lineage", "前驱资产"));
        }
      } else if (!sourceFact) {
        pushEdge(edge(iNode, target, "lineage", "缺少前驱事实", true));
      }
    }
  }

  // 同族：assetRootKey 相同（虚线语义，由前端渲染 kind=same-family）。
  const byRoot = new Map<string, string[]>();
  for (const asset of input.assets) {
    const root = assetRootKey(asset.address);
    const id = assetNodeId(input.engagementId, asset.address, asset.assetType);
    const list = byRoot.get(root) ?? [];
    if (!list.includes(id)) list.push(id);
    byRoot.set(root, list);
  }
  for (const [root, ids] of byRoot) {
    for (let i = 1; i < ids.length; i += 1) {
      pushEdge(edge(ids[0]!, ids[i]!, "same-family", root));
    }
  }

  const isolated = input.assets.filter(
    (asset) => !input.intents.some((intent) => intent.assetRoot && normalizeHost(intent.assetRoot) === normalizeHost(asset.address)),
  );
  const notes = [
    `资产 ${input.assets.length} 个，发现意图 ${input.intents.length} 个；无 Intent 触碰的资产 ${isolated.length} 个。`,
    "oos 资产灰显且不得作为利用唯一前驱（与硬闸同语义）。",
  ];
  return {
    taskId: input.taskId,
    engagementId: input.engagementId,
    view: "assets",
    generatedAt: input.generatedAt,
    empty: input.assets.length === 0,
    emptyReason: input.assets.length === 0 ? "no-assets-recorded" : null,
    nodes,
    edges,
    notes,
  };
}

export type SurfaceGraphInput = {
  taskId: string;
  engagementId: string;
  generatedAt: string;
  assets: readonly AssetRecord[];
  facts: readonly Fact[];
  findings: readonly Finding[];
  intents: readonly Intent[];
  materials: readonly EvidenceImport[];
  manual: ReadonlyArray<{ asset: string; technique: string; state: "manual" | "verified"; evidenceRefs: readonly string[] }>;
  retractedEvidence: readonly string[];
};

export function buildSurfaceGraph(input: SurfaceGraphInput): GraphView {
  const endpointAssets = [
    ...new Set(
      input.assets
        .filter((asset) => isEndpointLike(asset.address, asset.assetType))
        .map((asset) => normalizeEndpointAddress(asset.address))
        .filter(Boolean),
    ),
  ];
  const hostAssets = [
    ...new Set(
      input.assets
        .filter((asset) => !isEndpointLike(asset.address, asset.assetType))
        .map((asset) => normalizeHost(asset.address))
        .filter(Boolean),
    ),
  ];
  const techniques = new Set<string>();
  for (const finding of input.findings) techniques.add(finding.vulnClass);
  for (const intent of input.intents) if (intent.technique) techniques.add(intent.technique);
  for (const entry of input.manual) techniques.add(entry.technique);
  for (const material of input.materials) {
    const locator = material.locator.match(/technique[:=]([A-Za-z0-9._-]+)/);
    if (locator?.[1]) techniques.add(locator[1]);
  }
  const cells: CoverageCell[] = deriveCoverageMatrix({
    assets: hostAssets,
    endpoints: endpointAssets,
    techniques: [...techniques],
    materials: input.materials.map((material) => ({
      asset: material.asset,
      kind: material.kind,
      status: material.status,
      materialPath: material.materialPath,
      sha256: material.sha256,
    })),
    findings: input.findings.map((finding) => ({
      id: finding.id,
      asset: finding.asset,
      vulnClass: finding.vulnClass,
      status: finding.status,
      evidence: finding.evidence,
      endpoint: finding.endpoint,
    })),
    intents: input.intents.map((intent) => ({ technique: intent.technique, asset: intent.assetRoot, status: intent.status })),
    manual: input.manual,
    retractedEvidence: input.retractedEvidence,
  });

  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  const seenNodeIds = new Set<string>();
  const seenEdgeIds = new Set<string>();
  const pushNode = (node: GraphNode) => {
    if (seenNodeIds.has(node.id)) return;
    seenNodeIds.add(node.id);
    nodes.push(node);
  };
  const pushEdge = (item: GraphEdge) => {
    if (seenEdgeIds.has(item.id)) return;
    seenEdgeIds.add(item.id);
    edges.push(item);
  };

  const endpointNodeSet = new Set<string>();
  const hostNodeIdByHost = new Map<string, string>();
  for (const asset of input.assets) {
    const id = assetNodeId(input.engagementId, asset.address, asset.assetType);
    if (isEndpointLike(asset.address, asset.assetType)) {
      endpointNodeSet.add(normalizeEndpointAddress(asset.address));
    } else {
      const hostKey = normalizeHost(asset.address);
      if (hostKey && (!hostNodeIdByHost.has(hostKey) || asset.address.trim().toLowerCase() === hostKey)) {
        hostNodeIdByHost.set(hostKey, id);
      }
    }
    pushNode({
      id,
      kind: "asset",
      label: asset.address,
      badge: asset.kind,
      data: { factId: asset.factId },
    });
  }
  const resolveHostAssetNodeId = (address: string): string => {
    if (isEndpointLike(address) && endpointNodeSet.has(normalizeEndpointAddress(address))) {
      return assetNodeId(input.engagementId, address, "endpoint");
    }
    return hostNodeIdByHost.get(normalizeHost(address)) ?? assetNodeId(input.engagementId, address);
  };
  for (const technique of techniques) {
    pushNode({ id: graphNodeId("technique", technique), kind: "technique", label: technique, badge: null, data: {} });
  }
  for (const material of input.materials) {
    const id = graphNodeId("material", material.sha256);
    pushNode({
      id,
      kind: "material",
      label: material.materialPath,
      badge: `${material.kind ?? "unknown"}:${material.status}`,
      data: { sha256: material.sha256, locator: material.locator, parser: material.parser, reason: material.reason },
    });
    if (material.asset) {
      pushEdge(edge(resolveHostAssetNodeId(material.asset), id, "material", material.kind ?? "unknown"));
    }
  }
  for (const finding of input.findings) {
    pushNode({
      id: findingNodeId(finding.id),
      kind: "finding",
      label: finding.title,
      badge: `${finding.severity}:${finding.status}`,
      data: { asset: finding.asset, vulnClass: finding.vulnClass, evidence: finding.evidence },
    });
    pushEdge(edge(findingNodeId(finding.id), graphNodeId("technique", finding.vulnClass), "classified-as", finding.vulnClass));
    const hasEndpointNode = Boolean(finding.endpoint && endpointNodeSet.has(normalizeEndpointAddress(finding.endpoint)));
    const sourceAssetId = hasEndpointNode && finding.endpoint
      ? assetNodeId(input.engagementId, finding.endpoint, "endpoint")
      : resolveHostAssetNodeId(finding.asset);
    pushEdge(edge(sourceAssetId, findingNodeId(finding.id), "found-on", finding.status));
  }
  for (const cell of cells) {
    const cellIsEndpoint = endpointNodeSet.has(cell.asset) || isEndpointLike(cell.asset);
    const assetId = cellIsEndpoint
      ? assetNodeId(input.engagementId, cell.asset, "endpoint")
      : resolveHostAssetNodeId(cell.asset);
    const techniqueId = graphNodeId("technique", cell.technique);
    pushEdge(
      edge(assetId, techniqueId, "coverage", `${cell.state}${cell.retractedOnly ? "（依据已撤回）" : ""}`, cell.retractedOnly),
    );
  }

  const retracted = cells.filter((cell) => cell.state === "retracted");
  const notes = [
    `覆盖单元 ${cells.length} 个：verified ${cells.filter((cell) => cell.state === "verified").length}、manual ${cells.filter((cell) => cell.state === "manual").length}、attempted ${cells.filter((cell) => cell.state === "attempted").length}、material ${cells.filter((cell) => cell.state === "material").length}、retracted ${retracted.length}、unknown ${cells.filter((cell) => cell.state === "unknown").length}。`,
    "材料存在（material）≠ 已尝试（attempted）≠ 已人工覆盖（manual）≠ 已证实（verified）。",
  ];
  if (retracted.length > 0) notes.push("有覆盖单元只剩被撤回证据支撑，结论须复核。");
  return {
    taskId: input.taskId,
    engagementId: input.engagementId,
    view: "surface",
    generatedAt: input.generatedAt,
    empty: input.assets.length === 0,
    emptyReason: input.assets.length === 0 ? "no-assets-recorded" : null,
    nodes,
    edges,
    notes,
  };
}

export type ExecutionGraphInput = {
  taskId: string;
  engagementId: string;
  generatedAt: string;
  steps: ReadonlyArray<{ id: string; at: string; number: number; workerSlot: number; tools: string[]; tokens: number; shellCallCount: number }>;
  events: ReadonlyArray<{ id: string; kind: string; payload: Record<string, unknown>; createdAt: string }>;
  intents: readonly Intent[];
  jobs: readonly BackgroundJob[];
};

export function buildExecutionGraph(input: ExecutionGraphInput): GraphView {
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  const slots = new Set(input.steps.map((step) => step.workerSlot));
  for (const slot of slots) {
    nodes.push({ id: graphNodeId("slot", String(slot)), kind: "slot", label: `slot ${slot}`, badge: "worker", data: {} });
  }
  const sorted = [...input.steps].sort((a, b) => a.at.localeCompare(b.at) || a.number - b.number);
  let previousBySlot = new Map<number, string>();
  for (const step of sorted) {
    const id = graphNodeId("step", step.id);
    nodes.push({
      id,
      kind: "step",
      label: `#${step.number} ${step.tools.join(",") || "no-tool"}`,
      badge: `slot ${step.workerSlot}`,
      data: { at: step.at, tokens: step.tokens, shellCallCount: step.shellCallCount, tools: step.tools },
    });
    edges.push(edge(graphNodeId("slot", String(step.workerSlot)), id, "lane", `slot ${step.workerSlot}`));
    const previous = previousBySlot.get(step.workerSlot);
    if (previous) edges.push(edge(previous, id, "sequence", "下一步"));
    previousBySlot.set(step.workerSlot, id);
  }

  const deny = input.events.filter((event) => event.kind === "tool_gate" && event.payload.ok === false);
  for (const event of deny) {
    const id = graphNodeId("gate", event.id);
    nodes.push({
      id,
      kind: "tool_gate",
      label: String(event.payload.tool ?? "denied"),
      badge: "denied",
      data: { reason: event.payload.reason ?? null, at: event.createdAt },
    });
    const slot = Number(event.payload.workerSlot ?? 0);
    const lane = graphNodeId("slot", String(Number.isFinite(slot) ? slot : 0));
    if (nodes.some((node) => node.id === lane)) edges.push(edge(lane, id, "audit", "拒绝记录"));
    else edges.push(edge(id, graphNodeId("slot", "unknown"), "audit", "缺少槽位归属", true));
  }
  for (const event of input.events.filter((entry) => entry.kind === "explore_timeout_conclude")) {
    const id = graphNodeId("timeout", event.id);
    nodes.push({ id, kind: "timeout", label: "explore 超时收卷", badge: "partial", data: { at: event.createdAt } });
    edges.push(edge(graphNodeId("slot", "0"), id, "audit", "超时 partial Fact", true));
  }
  for (const event of input.events.filter((entry) => entry.kind === "relay_written")) {
    const id = graphNodeId("relay", event.id);
    nodes.push({ id, kind: "relay", label: `π${String(event.payload.generation ?? "?")}`, badge: "handoff", data: { at: event.createdAt } });
  }
  for (const intent of input.intents) {
    const id = intentNodeId(intent.id);
    nodes.push({ id, kind: "intent", label: intent.title, badge: intent.status, data: { technique: intent.technique } });
    for (const factId of intent.sourceFactIds) {
      const fact = graphNodeId("fact", factId);
      edges.push(edge(id, fact, "depends-on", "前驱事实"));
    }
  }
  for (const job of input.jobs) {
    nodes.push({
      id: graphNodeId("job", job.id),
      kind: "job",
      label: job.label,
      badge: `${job.kind}:${job.status}`,
      data: { progress: job.progress, lateResult: job.lateResult },
    });
  }

  const notes = [
    `执行步 ${sorted.length} 个（${slots.size} 个槽位），工具闸拒绝 ${deny.length} 条，relay ${input.events.filter((event) => event.kind === "relay_written").length} 次。`,
    "执行图只投影 trace/events，不产生新状态；成本归因以 token/工具计数为准。",
  ];
  return {
    taskId: input.taskId,
    engagementId: input.engagementId,
    view: "execution",
    generatedAt: input.generatedAt,
    empty: sorted.length === 0 && input.jobs.length === 0,
    emptyReason: sorted.length === 0 && input.jobs.length === 0 ? "no-execution-steps" : null,
    nodes,
    edges,
    notes,
  };
}

export type MemoryGraphInput = {
  taskId: string;
  engagementId: string;
  generatedAt: string;
  nodes: readonly MemoryNode[];
  injections: readonly MemoryInjection[];
  /** 记忆库尚未建立时显式返回空状态，而不是伪装“没有经验”。 */
  available: boolean;
};

export function buildMemoryGraph(input: MemoryGraphInput): GraphView {
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  for (const node of input.nodes) {
    nodes.push({
      id: graphNodeId("memory", node.id),
      kind: node.kind,
      label: node.title,
      badge: node.status,
      data: {
        matchKeys: node.matchKeys,
        reuseCount: node.reuseCount,
        supportRetracted: node.supportRetracted,
        reviewer: node.reviewer,
      },
    });
    if (node.contradicts) edges.push(edge(graphNodeId("memory", node.id), graphNodeId("memory", node.contradicts), "contradicts", "反例"));
    if (node.supersedes) edges.push(edge(graphNodeId("memory", node.id), graphNodeId("memory", node.supersedes), "supersedes", "取代"));
    for (const provenance of node.provenance) {
      const source = graphNodeId("source", `${provenance.taskId}:${provenance.refId}`);
      if (!nodes.some((entry) => entry.id === source)) {
        nodes.push({
          id: source,
          kind: "source",
          label: `${provenance.refKind} ${provenance.refId}`,
          badge: provenance.taskId === input.taskId ? "same-task" : "cross-task",
          data: { taskId: provenance.taskId, path: provenance.path, sha256: provenance.sha256 },
        });
      }
      edges.push(edge(graphNodeId("memory", node.id), source, "derived-from", provenance.refKind));
    }
  }
  for (const injection of input.injections) {
    const memory = graphNodeId("memory", injection.memoryId);
    const task = graphNodeId("task", injection.taskId);
    if (!nodes.some((node) => node.id === task)) {
      nodes.push({ id: task, kind: "task", label: injection.taskId, badge: injection.engagementId, data: {} });
    }
    if (nodes.some((node) => node.id === memory)) {
      edges.push(edge(memory, task, "injected-as", `${injection.layer}${injection.matchedKeys.length ? ` · ${injection.matchedKeys.join(",")}` : ""}`));
    }
  }
  return {
    taskId: input.taskId,
    engagementId: input.engagementId,
    view: "memory",
    generatedAt: input.generatedAt,
    empty: nodes.length === 0,
    emptyReason: input.available ? (nodes.length === 0 ? "no-memory-nodes" : null) : "memory-not-established",
    nodes,
    edges,
    notes: input.available
      ? ["记忆节点只读；注入走 Hint 建议层，不成为任务事实。"]
      : ["全局记忆库尚未建立（P8 后续阶段接入），本图为明确空状态。"],
  };
}

export type CausalityTrace = {
  taskId: string;
  engagementId: string;
  findingId: string;
  generatedAt: string;
  nodes: GraphNode[];
  edges: GraphEdge[];
  broken: Array<{ from: string; to: string; reason: string }>;
  upstream: string[];
  downstream: string[];
};

/** 沿 finding → Fact → Intent → 前驱 Fact → 其他 finding 回查因果链。 */
export function causalityTrace(input: {
  taskId: string;
  engagementId: string;
  generatedAt: string;
  finding: Finding;
  findings: readonly Finding[];
  facts: readonly Fact[];
  intents: readonly Intent[];
}): CausalityTrace {
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  const broken: CausalityTrace["broken"] = [];
  const factById = new Map(input.facts.map((fact) => [fact.id, fact]));
  const findingById = new Map(input.findings.map((finding) => [finding.id, finding]));
  const upstream = new Set<string>();
  const downstream = new Set<string>();

  const root = findingNodeId(input.finding.id);
  nodes.push({
    id: root,
    kind: "finding",
    label: input.finding.title,
    badge: `${input.finding.severity}:${input.finding.status}`,
    data: { asset: input.finding.asset, vulnClass: input.finding.vulnClass },
  });

  for (const factId of input.finding.factIds) {
    const fact = factById.get(factId);
    const factNode = graphNodeId("fact", factId);
    if (!fact) {
      nodes.push({ id: factNode, kind: "fact", label: "缺失事实", badge: "missing", data: { factId } });
      edges.push(edge(root, factNode, "supported-by", "缺少事实", true));
      broken.push({ from: root, to: factNode, reason: `finding 引用了不存在的事实 ${factId}` });
      continue;
    }
    upstream.add(factId);
    nodes.push({ id: factNode, kind: "fact", label: fact.title, badge: fact.layer, data: { tags: fact.tags } });
    edges.push(edge(root, factNode, "supported-by", "依据"));
    if (fact.intentId) {
      const intent = input.intents.find((entry) => entry.id === fact.intentId);
      const intentId = intentNodeId(fact.intentId);
      if (!intent) {
        edges.push(edge(factNode, intentId, "produced-by", "缺少产生该事实的 Intent", true));
        broken.push({ from: factNode, to: intentId, reason: `事实 ${factId} 的 intentId 不存在` });
        continue;
      }
      nodes.push({ id: intentId, kind: "intent", label: intent.title, badge: intent.status, data: { technique: intent.technique } });
      edges.push(edge(factNode, intentId, "produced-by", "产生意图"));
      for (const sourceId of intent.sourceFactIds) {
        const source = factById.get(sourceId);
        const sourceNode = graphNodeId("fact", sourceId);
        if (!source) {
          edges.push(edge(intentId, sourceNode, "preceded-by", "缺少前驱事实", true));
          broken.push({ from: intentId, to: sourceNode, reason: `Intent ${intent.id} 的前驱事实 ${sourceId} 不存在` });
          continue;
        }
        upstream.add(sourceId);
        nodes.push({ id: sourceNode, kind: "fact", label: source.title, badge: source.layer, data: { tags: source.tags } });
        edges.push(edge(intentId, sourceNode, "preceded-by", "前驱"));
      }
    }
  }

  for (const factId of upstream) {
    for (const finding of input.findings) {
      if (finding.id === input.finding.id) continue;
      if (!finding.factIds.includes(factId)) continue;
      if (!findingById.has(finding.id)) continue;
      downstream.add(finding.id);
      const node = findingNodeId(finding.id);
      nodes.push({ id: node, kind: "finding", label: finding.title, badge: `${finding.severity}:${finding.status}`, data: { asset: finding.asset } });
      edges.push(edge(graphNodeId("fact", factId), node, "supports", "同一依据"));
    }
  }

  return {
    taskId: input.taskId,
    engagementId: input.engagementId,
    findingId: input.finding.id,
    generatedAt: input.generatedAt,
    nodes,
    edges,
    broken,
    upstream: [...upstream],
    downstream: [...downstream],
  };
}

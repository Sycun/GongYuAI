/**
 * DAG 导出接口（只读投影）：把 History 里的 Fact / Intent / Finding / 资产投影成
 * 前端可直接渲染的因果图，并对每条因果边跑确定性校验（见 `edge-verifier.ts`）。
 *
 * 纪律：
 * - 不建第二状态。本文件是纯函数，输入是 History 的读取结果，输出是可丢弃的 DTO；
 * - 资产 → 事实 → 意图 → 漏洞 全链路可连线（资产边是结构边，因果边带 verification）；
 * - findings 稳定暴露 `intentId / factIds / trafficIds / qualification / evidence /
 *   validation`，前端不需要二次拼表；
 * - 缺依据就标 `proposed` + `abstentionReason`，不编造父节点、不补时间。
 */
import {
  ORIGIN_FACT_ID,
  graphNodeId,
  isIpv4Cidr,
  normalizeHost,
  type AssetRecord,
  type Credential,
  type Fact,
  type Finding,
  type FindingConfidence,
  type FindingQualification,
  type FindingSeverity,
  type FindingStatus,
  type FindingValidation,
  type GraphEdge,
  type GraphNode,
  type Intent,
} from "@gongyuai/contracts";
import {
  applyCausalVerdict,
  artifact,
  artifactKey,
  artifactsFromTags,
  evidenceArtifacts,
  summarizeCausalEdges,
  verifyCausalEdge,
  type CausalArtifact,
  type CausalEdgeKind,
  type CausalNodeRef,
} from "./edge-verifier.js";

/** 官方 Finding 证据形状（contracts 只导出 schema，未导出独立 type）。 */
type FindingEvidence = Finding["evidence"][number];

/** 图谱里 Fact 的稳定投影（不回写、不含 summary 正文以外的业务字段）。 */
export type DagFactRef = {
  id: string;
  layer: Fact["layer"];
  title: string;
  intentId: string | null;
  evidencePath: string | null;
  tags: string[];
  createdAt: string;
};

export type DagIntentRef = {
  id: string;
  title: string;
  status: Intent["status"];
  technique: string | null;
  assetRoot: string | null;
  sourceFactIds: string[];
  claimedBy: string | null;
  createdAt: string;
  concludedAt: string | null;
};

/** Finding 的稳定投影：前端图谱与漏洞表共用一份字段口径。 */
export type DagFindingRef = {
  id: string;
  title: string;
  asset: string;
  vulnClass: string;
  severity: FindingSeverity;
  status: FindingStatus;
  confidence: FindingConfidence;
  intentId: string | null;
  factIds: string[];
  trafficIds: string[];
  qualification: FindingQualification | null;
  evidence: FindingEvidence[];
  createdAt: string;
  verifiedAt: string | null;
  verifiedBy: string | null;
  /** 独立复核汇总（只读；不改 Finding 本身）。 */
  validations: {
    total: number;
    confirmed: number;
    refuted: number;
    inconclusive: number;
    outOfScope: number;
    independentConfirmed: boolean;
  };
};

export type DagExport = {
  taskId: string;
  generatedAt: string;
  facts: DagFactRef[];
  intents: DagIntentRef[];
  findings: DagFindingRef[];
  assets: Array<
    Pick<AssetRecord, "address" | "kind" | "assetType" | "parentAddress" | "factId" | "intentId" | "createdAt">
  >;
  nodes: GraphNode[];
  edges: GraphEdge[];
  notes: string[];
};

export type BuildDagExportInput = {
  taskId: string;
  generatedAt: string;
  facts: readonly Fact[];
  intents: readonly Intent[];
  findings: readonly Finding[];
  assets: readonly AssetRecord[];
  /** 仅用于把凭据指纹带进图谱说明；不暴露 secretRef。 */
  credentials?: readonly Credential[];
  validations?: readonly FindingValidation[];
  /** 派生的 Finding → Finding 边上限（防组合爆炸；确定性截断）。 */
  maxFindingEdges?: number;
};

const MAX_FINDING_EDGES_DEFAULT = 200;

const LEGACY_LIFECYCLE_TITLES = new Set([
  "执行节点已启动",
  "任务已初始化",
  "已加载任务坐标",
]);

/** 系统生命周期/运行记账类 Fact：非攻防因果节点，未挂靠任何意图或引用时不入因果图，避免形成伪孤立节点。 */
function isSystemLifecycleFact(fact: Pick<Fact, "title" | "tags" | "evidencePath">): boolean {
  if (fact.evidencePath) return false;
  if (fact.tags.includes("asset") || fact.tags.some((t) => t.startsWith("asset.addr:"))) return false;
  if (fact.tags.includes("system") || fact.tags.includes("lifecycle")) return true;
  if (fact.tags.includes("scope-brief")) return true;
  if (fact.tags.includes("scope") && fact.tags.some((t) => t.startsWith("scopeVersion:"))) return true;
  if (LEGACY_LIFECYCLE_TITLES.has(fact.title)) return true;
  if (/^加载 Skill\s+/.test(fact.title)) return true;
  if (/^(?:解锁|关闭) MCP\s+/.test(fact.title)) return true;
  if (/^授权范围更新至 v\d+/.test(fact.title)) return true;
  return false;
}

const assetNodeId = (address: string): string => graphNodeId("asset", address);
const factNodeId = (id: string): string => graphNodeId("fact", id);
const intentNodeId = (id: string): string => graphNodeId("intent", id);
const findingNodeId = (id: string): string => graphNodeId("finding", id);

function byCreatedAt<T extends { createdAt: string; id: string }>(rows: readonly T[]): T[] {
  return [...rows].sort(
    (a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id),
  );
}

function factArtifacts(fact: Fact): CausalArtifact[] {
  return [
    ...artifactsFromTags(fact.tags),
    ...evidenceArtifacts(fact.evidencePath ? [{ path: fact.evidencePath }] : []),
  ];
}

function intentArtifacts(intent: Intent): CausalArtifact[] {
  const asset = artifact("asset", intent.assetRoot);
  return asset ? [asset] : [];
}

function findingArtifacts(finding: Finding): CausalArtifact[] {
  const out: CausalArtifact[] = [];
  const asset = artifact("asset", finding.asset);
  if (asset) out.push(asset);
  const endpoint = artifact("endpoint", finding.endpoint);
  if (endpoint) out.push(endpoint);
  out.push(...evidenceArtifacts(finding.evidence));
  for (const trafficId of finding.trafficIds ?? []) {
    const traffic = artifact("traffic", trafficId);
    if (traffic) out.push(traffic);
  }
  return out;
}

function uniqueArtifacts(entries: readonly CausalArtifact[]): CausalArtifact[] {
  const seen = new Set<string>();
  const out: CausalArtifact[] = [];
  for (const entry of entries) {
    const key = artifactKey(entry);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(entry);
  }
  return out;
}

function validationSummary(
  validations: readonly FindingValidation[],
  findingId: string,
): DagFindingRef["validations"] {
  const rows = validations.filter((row) => row.findingId === findingId);
  const latestIndependent = rows.filter((row) => row.independent).at(-1);
  return {
    total: rows.length,
    confirmed: rows.filter((row) => row.verdict === "confirmed").length,
    refuted: rows.filter((row) => row.verdict === "refuted").length,
    inconclusive: rows.filter((row) => row.verdict === "inconclusive").length,
    outOfScope: rows.filter((row) => row.verdict === "out-of-scope").length,
    independentConfirmed: latestIndependent?.verdict === "confirmed",
  };
}

/**
 * 纯函数构建 DAG 导出。`HistoryStore.dagExport()` 只负责取数后调用这里。
 */
export function buildDagExport(input: BuildDagExportInput): DagExport {
  const allFacts = byCreatedAt(input.facts);
  const intents = byCreatedAt(input.intents);
  const findings = byCreatedAt(input.findings);
  const validations = [...(input.validations ?? [])].sort(
    (a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id),
  );

  const intentById = new Map(intents.map((intent) => [intent.id, intent]));
  const referencedFactIds = new Set<string>();
  for (const asset of input.assets) referencedFactIds.add(asset.factId);
  for (const intent of intents) {
    for (const sourceId of intent.sourceFactIds) referencedFactIds.add(sourceId);
  }
  for (const finding of findings) {
    for (const factId of finding.factIds) referencedFactIds.add(factId);
  }
  const facts = allFacts.filter(
    (fact) =>
      !isSystemLifecycleFact(fact) ||
      Boolean(fact.intentId && intentById.has(fact.intentId)) ||
      referencedFactIds.has(fact.id),
  );

  const factById = new Map(facts.map((fact) => [fact.id, fact]));

  // 资产索引：精确地址优先，主机回退优先匹配根主机资产（避免把同主机子端点误作其他节点的根）。
  const isConcreteHostAsset = (addr: string): boolean =>
    addr !== "*" && !addr.startsWith("*.") && !isIpv4Cidr(addr);
  const assetsByAddress = new Map<string, AssetRecord>();
  const assetsByExact = new Map<string, AssetRecord>();
  const rootAssetsByHost = new Map<string, AssetRecord>();
  const assetsByHost = new Map<string, AssetRecord>();
  for (const asset of input.assets) {
    assetsByAddress.set(asset.address, asset);
    const exact = artifact("asset", asset.address)?.value;
    if (exact && !assetsByExact.has(exact)) assetsByExact.set(exact, asset);
    if (isConcreteHostAsset(asset.address) && !asset.parentAddress && asset.assetType !== "endpoint" && !asset.address.includes("/")) {
      const host = normalizeHost(asset.address);
      if (host && !rootAssetsByHost.has(host)) rootAssetsByHost.set(host, asset);
      if (host && !assetsByHost.has(host)) assetsByHost.set(host, asset);
    }
  }
  for (const asset of input.assets) {
    if (!isConcreteHostAsset(asset.address)) continue;
    const host = normalizeHost(asset.address);
    if (host && !assetsByHost.has(host)) assetsByHost.set(host, asset);
  }
  const resolveAsset = (raw: string | null | undefined): AssetRecord | undefined => {
    if (!raw?.trim()) return undefined;
    const trimmed = raw.trim();
    const exact = artifact("asset", trimmed)?.value;
    const host = isConcreteHostAsset(trimmed) ? normalizeHost(trimmed) : "";
    return (
      assetsByAddress.get(trimmed) ??
      (exact ? assetsByExact.get(exact) : undefined) ??
      (host ? assetsByHost.get(host) : undefined)
    );
  };

  // 若 Intent 仅挂在伪起点 origin 但显式声明了已入库 assetRoot，优先挂到该资产早于 Intent 的资产 Fact，避免目标资产与意图脱节。
  const effectiveSourcesByIntent = new Map<string, string[]>();
  for (const intent of intents) {
    let sources = [...intent.sourceFactIds];
    if (sources.length > 0 && sources.every((id) => id === ORIGIN_FACT_ID) && intent.assetRoot) {
      const rootAsset = resolveAsset(intent.assetRoot);
      if (rootAsset) {
        const intentMs = Date.parse(intent.createdAt);
        const assetFacts = facts.filter(
          (f) =>
            f.id === rootAsset.factId ||
            (f.tags.includes("asset") &&
              f.tags.some((t) => t === `asset.addr:${rootAsset.address}`)),
        );
        const timely = Number.isFinite(intentMs)
          ? assetFacts.filter((f) => {
              const ms = Date.parse(f.createdAt);
              return Number.isFinite(ms) && ms <= intentMs;
            })
          : [];
        const anchorFact = timely.at(-1) ?? (factById.has(rootAsset.factId) ? factById.get(rootAsset.factId) : undefined);
        if (anchorFact) {
          sources = [anchorFact.id];
        }
      }
    }
    effectiveSourcesByIntent.set(intent.id, sources);
  }

  const nodes: GraphNode[] = [];
  const nodeIds = new Set<string>();
  const pushNode = (node: GraphNode) => {
    if (nodeIds.has(node.id)) return;
    nodeIds.add(node.id);
    nodes.push(node);
  };

  /** 因果端点投影：Fact / Intent / Finding 各自的引用与指纹。 */
  const factRefs = new Map<string, CausalNodeRef>();
  for (const fact of facts) {
    factRefs.set(fact.id, {
      id: fact.id,
      createdAt: fact.createdAt,
      references: fact.intentId ? [fact.intentId] : [],
      artifacts: uniqueArtifacts(factArtifacts(fact)),
    });
  }
  const intentRefs = new Map<string, CausalNodeRef>();
  for (const intent of intents) {
    intentRefs.set(intent.id, {
      id: intent.id,
      createdAt: intent.createdAt,
      references: intent.sourceFactIds,
      artifacts: uniqueArtifacts(intentArtifacts(intent)),
    });
  }
  const findingRefs = new Map<string, CausalNodeRef>();
  for (const finding of findings) {
    const refs = [
      ...(finding.intentId ? [finding.intentId] : []),
      ...finding.factIds,
    ];
    findingRefs.set(finding.id, {
      id: finding.id,
      createdAt: finding.createdAt,
      references: refs,
      artifacts: uniqueArtifacts(findingArtifacts(finding)),
    });
  }

  // ---- 节点 -------------------------------------------------------------
  for (const asset of input.assets) {
    const address = asset.address;
    pushNode({
      id: assetNodeId(address),
      kind: "asset",
      label: address,
      badge: asset.kind,
      data: {
        factId: asset.factId,
        assetType: asset.assetType,
        parentAddress: asset.parentAddress ?? null,
        source: asset.source,
        intentId: asset.intentId,
        createdAt: asset.createdAt,
      },
    });
  }
  for (const fact of facts) {
    pushNode({
      id: factNodeId(fact.id),
      kind: "fact",
      label: fact.title,
      badge: fact.layer,
      data: {
        intentId: fact.intentId,
        evidencePath: fact.evidencePath,
        createdAt: fact.createdAt,
        tags: fact.tags,
      },
    });
  }
  const usesOrigin = intents.some((intent) =>
    (effectiveSourcesByIntent.get(intent.id) ?? intent.sourceFactIds).includes(ORIGIN_FACT_ID),
  );
  if (usesOrigin) {
    pushNode({
      id: factNodeId(ORIGIN_FACT_ID),
      kind: "fact",
      label: ORIGIN_FACT_ID,
      badge: "origin",
      data: { synthetic: true, note: "伪 Fact：Intent 挂靠起点，不参与因果校验" },
    });
  }
  for (const intent of intents) {
    pushNode({
      id: intentNodeId(intent.id),
      kind: "intent",
      label: intent.title,
      badge: intent.status,
      data: {
        technique: intent.technique,
        assetRoot: intent.assetRoot,
        sourceFactIds: intent.sourceFactIds,
        claimedBy: intent.claimedBy,
        createdAt: intent.createdAt,
        concludedAt: intent.concludedAt,
      },
    });
  }
  for (const finding of findings) {
    const validations_ = validationSummary(validations, finding.id);
    pushNode({
      id: findingNodeId(finding.id),
      kind: "finding",
      label: finding.title,
      badge: `${finding.severity}/${finding.status}`,
      data: {
        asset: finding.asset,
        vulnClass: finding.vulnClass,
        endpoint: finding.endpoint,
        confidence: finding.confidence,
        intentId: finding.intentId,
        factIds: finding.factIds,
        trafficIds: finding.trafficIds ?? [],
        qualification: finding.qualification ?? null,
        evidenceCount: finding.evidence.length,
        validations: validations_,
        createdAt: finding.createdAt,
        verifiedAt: finding.verifiedAt,
      },
    });
  }

  // ---- 边 ---------------------------------------------------------------
  const edges: GraphEdge[] = [];
  const edgeIds = new Set<string>();
  const pushEdge = (edge: GraphEdge) => {
    if (edgeIds.has(edge.id)) return;
    edgeIds.add(edge.id);
    edges.push(edge);
  };

  /** 因果边：两端可解析才跑校验；缺端点 → proposed + ungrounded_reference。 */
  const pushCausal = (opts: {
    causal: CausalEdgeKind;
    fromRef: CausalNodeRef | null;
    toRef: CausalNodeRef | null;
    from: string;
    to: string;
    kind: string;
    label: string;
  }) => {
    const verdict = verifyCausalEdge({
      kind: opts.causal,
      from: opts.fromRef,
      to: opts.toRef,
    });
    pushEdge(
      applyCausalVerdict(
        {
          id: `${opts.from}->${opts.to}:${opts.kind}`,
          from: opts.from,
          to: opts.to,
          kind: opts.kind,
          label: opts.label,
          broken: opts.fromRef === null || opts.toRef === null,
        },
        verdict,
      ),
    );
  };

  // 资产 → 子资产（主机 → 端口服务 / HTTP 端点），保持攻击面层级连通。
  for (const asset of input.assets) {
    if (!isConcreteHostAsset(asset.address)) continue;
    let parent: AssetRecord | undefined;
    if (asset.parentAddress) {
      const rawParent = asset.parentAddress.trim();
      const exactParent = artifact("asset", rawParent)?.value;
      const hostParent = isConcreteHostAsset(rawParent) ? normalizeHost(rawParent) : "";
      const candidate =
        assetsByAddress.get(rawParent) ??
        (exactParent ? assetsByExact.get(exactParent) : undefined) ??
        (hostParent ? rootAssetsByHost.get(hostParent) : undefined);
      if (candidate && candidate.address !== asset.address) parent = candidate;
    }
    if (!parent && (asset.address.includes("/") || /:\d+$/.test(asset.address))) {
      const host = normalizeHost(asset.address);
      const candidate = host ? (assetsByAddress.get(host) ?? rootAssetsByHost.get(host)) : undefined;
      if (candidate && candidate.address !== asset.address) parent = candidate;
    }
    if (parent) {
      pushEdge({
        id: `${assetNodeId(parent.address)}->${assetNodeId(asset.address)}:contains`,
        from: assetNodeId(parent.address),
        to: assetNodeId(asset.address),
        kind: "contains",
        label: "下属资产",
        broken: false,
      });
    }
  }

  // 资产 → 事实：资产清单凭据 + 无活跃 Intent 父节点的资产关联事实（委托简报 / 实例切换 / 凭据等）。
  const credentialById = new Map(
    (input.credentials ?? []).map((cred) => [cred.id.toLowerCase(), cred]),
  );
  for (const asset of input.assets) {
    if (!factById.has(asset.factId)) continue;
    pushEdge({
      id: `${assetNodeId(asset.address)}->${factNodeId(asset.factId)}:asserted-by`,
      from: assetNodeId(asset.address),
      to: factNodeId(asset.factId),
      kind: "asserted-by",
      label: "资产清单凭据",
      broken: false,
    });
  }
  for (const fact of facts) {
    const isAssetFact = fact.tags.includes("asset");
    const hasIntentParent = Boolean(fact.intentId && intentById.has(fact.intentId));
    if (!isAssetFact && hasIntentParent) continue;
    const candidateAddrs: string[] = [];
    for (const tag of fact.tags) {
      if (tag.startsWith("asset.addr:")) {
        candidateAddrs.push(tag.slice("asset.addr:".length));
      } else if (tag.startsWith("credential.id:")) {
        const cred = credentialById.get(tag.slice("credential.id:".length).toLowerCase());
        if (cred?.asset) candidateAddrs.push(cred.asset);
      }
    }
    for (const rawAddr of candidateAddrs) {
      const matched = isAssetFact
        ? (assetsByAddress.get(rawAddr) ?? resolveAsset(rawAddr))
        : resolveAsset(rawAddr);
      if (!matched) continue;
      pushEdge({
        id: `${assetNodeId(matched.address)}->${factNodeId(fact.id)}:asserted-by`,
        from: assetNodeId(matched.address),
        to: factNodeId(fact.id),
        kind: "asserted-by",
        label: isAssetFact ? "资产清单凭据" : "资产关联事实",
        broken: false,
      });
    }
  }

  // 事实 → 意图：sourceFactIds（origin 为伪 Fact，不参与校验）。
  for (const intent of intents) {
    const sources = effectiveSourcesByIntent.get(intent.id) ?? intent.sourceFactIds;
    for (const sourceId of sources) {
      if (sourceId === ORIGIN_FACT_ID) {
        pushEdge({
          id: `${factNodeId(ORIGIN_FACT_ID)}->${intentNodeId(intent.id)}:anchors`,
          from: factNodeId(ORIGIN_FACT_ID),
          to: intentNodeId(intent.id),
          kind: "anchors",
          label: "origin 挂靠",
          broken: false,
        });
        continue;
      }
      pushCausal({
        causal: "fact->intent",
        fromRef: factRefs.get(sourceId) ?? null,
        toRef: intentRefs.get(intent.id) ?? null,
        from: factNodeId(sourceId),
        to: intentNodeId(intent.id),
        kind: "anchors",
        label: "前驱事实",
      });
    }
  }

  // 意图 → 事实：Explore 回写（Fact.intentId）。
  for (const fact of facts) {
    if (!fact.intentId) continue;
    pushCausal({
      causal: "intent->fact",
      fromRef: intentRefs.get(fact.intentId) ?? null,
      toRef: factRefs.get(fact.id) ?? null,
      from: intentNodeId(fact.intentId),
      to: factNodeId(fact.id),
      kind: "produces",
      label: "Explore 回写",
    });
  }

  // 事实 → 发现：finding.factIds。
  for (const finding of findings) {
    for (const factId of finding.factIds) {
      pushCausal({
        causal: "fact->finding",
        fromRef: factRefs.get(factId) ?? null,
        toRef: findingRefs.get(finding.id) ?? null,
        from: factNodeId(factId),
        to: findingNodeId(finding.id),
        kind: "evidences",
        label: "支撑发现",
      });
    }
  }

  // 意图 → 发现：finding.intentId。
  for (const finding of findings) {
    if (!finding.intentId) continue;
    pushCausal({
      causal: "intent->finding",
      fromRef: intentRefs.get(finding.intentId) ?? null,
      toRef: findingRefs.get(finding.id) ?? null,
      from: intentNodeId(finding.intentId),
      to: findingNodeId(finding.id),
      kind: "yields",
      label: "意图产出漏洞",
    });
  }

  // 兜底链路（兼容历史/未显式传 intentId 与 factIds 的漏洞）：
  // 1) 若共享同一证据文件路径，连到对应 Fact（走确定性因果校验）；
  // 2) 若仍无任何入边，挂一条结构边到对应资产节点，避免漏洞悬浮成孤立节点。
  const normEv = (p: string) => p.replace(/\\/g, "/").replace(/^(\.\/)+/, "").replace(/^evidence\//, "");
  const factsByEvidence = new Map<string, Fact[]>();
  for (const fact of facts) {
    if (!fact.evidencePath) continue;
    const key = normEv(fact.evidencePath);
    if (!key) continue;
    const list = factsByEvidence.get(key) ?? [];
    list.push(fact);
    factsByEvidence.set(key, list);
  }
  for (const finding of findings) {
    if (finding.intentId || finding.factIds.length > 0) continue;
    let linked = false;
    for (const ev of finding.evidence) {
      const key = normEv(ev.path);
      for (const fact of factsByEvidence.get(key) ?? []) {
        pushCausal({
          causal: "fact->finding",
          fromRef: factRefs.get(fact.id) ?? null,
          toRef: findingRefs.get(finding.id) ?? null,
          from: factNodeId(fact.id),
          to: findingNodeId(finding.id),
          kind: "evidences",
          label: "同证据支撑",
        });
        linked = true;
      }
    }
    if (!linked) {
      const matchedAsset = resolveAsset(finding.asset);
      if (matchedAsset) {
        pushEdge({
          id: `${assetNodeId(matchedAsset.address)}->${findingNodeId(finding.id)}:affects`,
          from: assetNodeId(matchedAsset.address),
          to: findingNodeId(finding.id),
          kind: "affects",
          label: "所属资产",
          broken: false,
        });
      }
    }
  }

  // 发现 → 发现：同资产且共享端点 / 证据 SHA-256 / 事务 id，按时间推进。
  const maxFindingEdges = Math.max(0, input.maxFindingEdges ?? MAX_FINDING_EDGES_DEFAULT);
  const findingPairs: Array<{ from: Finding; to: Finding }> = [];
  for (const earlier of findings) {
    for (const later of findings) {
      if (earlier.id === later.id) continue;
      if (earlier.asset !== later.asset) continue;
      const earlierAt = Date.parse(earlier.createdAt);
      const laterAt = Date.parse(later.createdAt);
      if (!Number.isFinite(earlierAt) || !Number.isFinite(laterAt) || earlierAt >= laterAt) continue;
      const endpointMatch =
        (earlier.endpoint ?? null) !== null &&
        (earlier.endpoint ?? null) === (later.endpoint ?? null);
      const earlierEvidence = new Set(
        evidenceArtifacts(earlier.evidence).map((entry) => `${entry.kind}:${entry.value}`),
      );
      const trafficMatch = (earlier.trafficIds ?? []).some((id) => (later.trafficIds ?? []).includes(id));
      const shaMatch = evidenceArtifacts(later.evidence).some((entry) =>
        earlierEvidence.has(`${entry.kind}:${entry.value}`),
      );
      if (!endpointMatch && !trafficMatch && !shaMatch) continue;
      findingPairs.push({ from: earlier, to: later });
    }
  }
  findingPairs.sort(
    (a, b) =>
      a.from.id.localeCompare(b.from.id) || a.to.id.localeCompare(b.to.id),
  );
  for (const pair of findingPairs.slice(0, maxFindingEdges)) {
    pushCausal({
      causal: "finding->finding",
      fromRef: findingRefs.get(pair.from.id) ?? null,
      toRef: findingRefs.get(pair.to.id) ?? null,
      from: findingNodeId(pair.from.id),
      to: findingNodeId(pair.to.id),
      kind: "escalates",
      label: "同证据推进",
    });
  }

  // ---- 稳定排序 ----------------------------------------------------------
  nodes.sort((a, b) => a.id.localeCompare(b.id));
  edges.sort(
    (a, b) =>
      a.from.localeCompare(b.from) ||
      a.to.localeCompare(b.to) ||
      a.kind.localeCompare(b.kind) ||
      a.id.localeCompare(b.id),
  );

  // ---- 导出 findings（前端图谱/漏洞表同一口径） -------------------------
  const dagFindings: DagFindingRef[] = findings.map((finding) => ({
    id: finding.id,
    title: finding.title,
    asset: finding.asset,
    vulnClass: finding.vulnClass,
    severity: finding.severity,
    status: finding.status,
    confidence: finding.confidence,
    intentId: finding.intentId ?? null,
    factIds: [...finding.factIds],
    trafficIds: [...(finding.trafficIds ?? [])],
    qualification: finding.qualification ?? null,
    evidence: [...finding.evidence],
    createdAt: finding.createdAt,
    verifiedAt: finding.verifiedAt,
    verifiedBy: finding.verifiedBy,
    validations: validationSummary(validations, finding.id),
  }));

  const dagFacts: DagFactRef[] = facts.map((fact) => ({
    id: fact.id,
    layer: fact.layer,
    title: fact.title,
    intentId: fact.intentId ?? null,
    evidencePath: fact.evidencePath ?? null,
    tags: [...fact.tags],
    createdAt: fact.createdAt,
  }));

  const dagIntents: DagIntentRef[] = intents.map((intent) => ({
    id: intent.id,
    title: intent.title,
    status: intent.status,
    technique: intent.technique ?? null,
    assetRoot: intent.assetRoot ?? null,
    sourceFactIds: [...intent.sourceFactIds],
    claimedBy: intent.claimedBy ?? null,
    createdAt: intent.createdAt,
    concludedAt: intent.concludedAt ?? null,
  }));

  const causal = summarizeCausalEdges(edges);
  const connectedNodeIds = new Set<string>();
  for (const edge of edges) {
    connectedNodeIds.add(edge.from);
    connectedNodeIds.add(edge.to);
  }
  const orphanFacts = dagFacts.filter((fact) => !connectedNodeIds.has(factNodeId(fact.id))).length;
  const orphanFindings = dagFindings.filter(
    (finding) => !connectedNodeIds.has(findingNodeId(finding.id)),
  ).length;
  const unverifiedFindings = dagFindings.filter(
    (finding) => finding.status === "tentative",
  ).length;

  const notes = [
    `事实 ${dagFacts.length}、意图 ${dagIntents.length}、发现 ${dagFindings.length}、资产 ${input.assets.length}（凭据 ${input.credentials?.length ?? 0}）。`,
    `因果边 ${causal.total} 条：proven ${causal.proven} / proposed ${causal.proposed}` +
      `（timestamp_inversion ${causal.byReason.timestamp_inversion}、` +
      `missing_shared_artifact ${causal.byReason.missing_shared_artifact}、` +
      `ungrounded_reference ${causal.byReason.ungrounded_reference}、` +
      `missing_timestamp ${causal.byReason.missing_timestamp}）。`,
    "边校验为确定性符号规则（无 LLM）：时序单调 + 显式引用/对象指纹交集（asset/endpoint/credential/sha256/http:<id>/证据文件）；" +
      "不满足即 proposed 并给出 abstentionReason，不编造因果。",
    "origin 是伪 Fact：origin → Intent 边为结构挂靠，不参与因果校验。",
  ];
  if (orphanFacts > 0) {
    notes.push(`孤立事实 ${orphanFacts} 条（无 intentId）：不编造父节点，等后续 Intent 引用或标 proposed。`);
  }
  if (orphanFindings > 0) {
    notes.push(`孤立发现 ${orphanFindings} 条（无 intentId 且无 factIds）：图谱中无支撑边。`);
  }
  if (unverifiedFindings > 0) {
    notes.push(`tentative 发现 ${unverifiedFindings} 条：只作线索，不进交付。`);
  }

  return {
    taskId: input.taskId,
    generatedAt: input.generatedAt,
    facts: dagFacts,
    intents: dagIntents,
    findings: dagFindings,
    assets: input.assets.map((asset) => ({
      address: asset.address,
      kind: asset.kind,
      assetType: asset.assetType,
      parentAddress: asset.parentAddress ?? null,
      factId: asset.factId,
      intentId: asset.intentId,
      createdAt: asset.createdAt,
    })),
    nodes,
    edges,
    notes,
  };
}

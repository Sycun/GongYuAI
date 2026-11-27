import { Graph, layout, type Point } from "@dagrejs/dagre";

/** 与 contracts normalizeHost 同规则：去 scheme/path/port、小写、去尾点。本地镜像避免把 barrel 的 node:crypto 带进浏览器构建。 */
function normalizeHost(input: string): string {
  let s = input.trim().toLowerCase();
  if (!s) return "";
  s = s.replace(/^https?:\/\//, "");
  s = s.split("/")[0] ?? s;
  s = s.split("?")[0] ?? s;
  s = s.replace(/^\[|\]$/g, "");
  if (!/^\d{1,3}(?:\.\d{1,3}){3}$/.test(s) && s.includes(":")) {
    const idx = s.lastIndexOf(":");
    const maybePort = s.slice(idx + 1);
    if (/^\d+$/.test(maybePort)) s = s.slice(0, idx);
  }
  return s.replace(/\.$/, "");
}

export type DagFact = {
  id: string;
  taskId?: string;
  layer: string;
  title: string;
  summary?: string;
  intentId?: string | null;
  evidencePath?: string | null;
  tags?: string[];
  createdAt?: string;
};

export type DagIntent = {
  id: string;
  taskId?: string;
  title: string;
  status: string;
  summary?: string;
  sourceFactIds?: string[];
  assetRoot?: string | null;
  technique?: string | null;
  claimedBy?: string | null;
  createdAt?: string;
  updatedAt?: string;
  concludedAt?: string | null;
  conclusion?: string | null;
};

export type DagFinding = {
  id: string;
  taskId?: string;
  title: string;
  asset: string;
  vulnClass: string;
  severity: string;
  status: string;
  summary?: string;
  cvss?: string | null;
  confidence?: string;
  dedupKey?: string;
  intentId?: string | null;
  factIds?: string[];
  trafficIds?: string[];
  endpoint?: string | null;
  evidence?: Array<{ path: string; sha256: string; role?: string; note?: string }>;
  repro?: string;
  impact?: string;
  fix?: string;
  rootCause?: string;
  pocCurl?: string;
  qualification?: string | null;
  verifiedAt?: string | null;
  verifiedBy?: string | null;
  createdAt?: string;
};

export type DagAsset = {
  id?: string;
  taskId?: string;
  address: string;
  kind: string;
  factId: string;
  intentId?: string | null;
  source?: string;
  assetType?: string | null;
  weight?: number;
  createdAt?: string;
};

export type ServerDagEdge = {
  id: string;
  from: string;
  to: string;
  kind: string;
  label?: string;
  broken?: boolean;
  verification?: DagVerification;
  abstentionReason?: string;
};

export type ServerDagExport = {
  edges: ServerDagEdge[];
  notes?: string[];
};

function unwrapServerNodeId(id: string): string {
  if (id.startsWith("asset:")) return id;
  if (id.startsWith("fact:")) return id.slice("fact:".length);
  if (id.startsWith("intent:")) return id.slice("intent:".length);
  if (id.startsWith("finding:")) return id.slice("finding:".length);
  return id;
}

export type DagNodeKind = "asset" | "fact" | "intent" | "finding";

export type DagRecord = {
  kind: DagNodeKind;
  title: string;
  meta?: string;
  summary?: string;
  conclusion?: string | null;
  sources?: string[];
  createdAt?: string;
  updatedAt?: string;
  concludedAt?: string | null;
  data?: Record<string, unknown>;
  raw?: Record<string, unknown>;
};

export type DagVerification = "proven" | "proposed";

export type DagLink = {
  source: string;
  target: string;
  kind: string;
  /** 结构边（资产凭据 / origin 挂靠）不做因果校验。 */
  structural?: boolean;
  verification?: DagVerification;
  abstentionReason?: string;
  broken?: boolean;
};

export type DagCollection = {
  records: Map<string, DagRecord>;
  links: DagLink[];
  orphanIds: Set<string>;
  topologyKey: string;
};

export const CARD_SIZE = { width: 244, height: 108 };
export const ORIGIN_ID = "origin";
export const assetNodeId = (address: string) => `asset:${address}`;

/* ---- 确定性因果校验（与后端 edge-verifier 同规则：时序单调 + 引用/指纹交集） ---- */

type Artifact = { kind: string; value: string };
type NodeRef = { id: string; createdAt?: string; references: string[]; artifacts: Artifact[] };

const SHA256 = /^[0-9a-f]{64}$/;

function normAsset(raw: string): string {
  const value = raw.trim().toLowerCase();
  if (!value) return "";
  if (value.includes("://")) return normalizeHost(value);
  return value.replace(/\/+$/, "");
}

function normEndpoint(raw: string): string {
  const value = raw.trim();
  if (!value) return "";
  if (!value.includes("://")) return value.replace(/\/+$/, "") || "/";
  try {
    const url = new URL(value);
    return `${url.pathname}${url.search}`.replace(/\/+$/, "") || "/";
  } catch {
    return value;
  }
}

function artifact(kind: string, raw: string | null | undefined): Artifact | null {
  if (raw == null) return null;
  let value = raw.trim();
  if (!value) return null;
  if (kind === "asset") value = normAsset(value);
  else if (kind === "endpoint") value = normEndpoint(value);
  else if (kind === "sha256") {
    value = value.toLowerCase();
    if (!SHA256.test(value)) return null;
  } else if (kind === "traffic") value = value.toLowerCase().replace(/^http:/, "");
  else if (kind === "evidence") value = value.replace(/\\/g, "/").replace(/^(\.\/)+/, "");
  else value = value.toLowerCase();
  return value ? { kind, value } : null;
}

function pushArtifact(out: Artifact[], kind: string, raw: string | null | undefined) {
  const entry = artifact(kind, raw);
  if (entry) out.push(entry);
}

function factArtifacts(fact: DagFact): Artifact[] {
  const out: Artifact[] = [];
  for (const tag of fact.tags ?? []) {
    if (tag.startsWith("asset.addr:")) {
      const address = tag.slice("asset.addr:".length);
      pushArtifact(out, "asset", address);
      if (address.includes("://")) pushArtifact(out, "endpoint", address);
    } else if (tag.startsWith("credential.id:")) {
      pushArtifact(out, "credential", tag.slice("credential.id:".length));
    }
  }
  pushArtifact(out, "evidence", fact.evidencePath);
  return out;
}

function findingArtifacts(finding: DagFinding): Artifact[] {
  const out: Artifact[] = [];
  pushArtifact(out, "asset", finding.asset);
  pushArtifact(out, "endpoint", finding.endpoint);
  for (const entry of finding.evidence ?? []) {
    const path = entry.path?.trim();
    if (path) pushArtifact(out, path.startsWith("http:") ? "traffic" : "evidence", path);
    pushArtifact(out, "sha256", entry.sha256);
  }
  for (const id of finding.trafficIds ?? []) pushArtifact(out, "traffic", id);
  return out;
}

function artifactKey(entry: Artifact): string {
  return `${entry.kind}:${entry.value}`;
}

function sharedKeys(left: Artifact[], right: Artifact[]): string[] {
  const rightKeys = new Set(right.map(artifactKey));
  const shared = new Set<string>();
  for (const entry of left) {
    const key = artifactKey(entry);
    if (rightKeys.has(key)) shared.add(key);
  }
  return [...shared].sort();
}

function parseMs(value?: string): number | null {
  if (!value?.trim()) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

/** 缺依据宁可诚实弃证（proposed），也不编造因果。 */
function verifyEdge(from: NodeRef | null, to: NodeRef | null): { verification: DagVerification; abstentionReason?: string; broken?: boolean } {
  if (!from || !to || from.id === to.id) return { verification: "proposed", abstentionReason: "ungrounded_reference", broken: true };
  const fromMs = parseMs(from.createdAt);
  const toMs = parseMs(to.createdAt);
  if (fromMs === null || toMs === null) return { verification: "proposed", abstentionReason: "missing_timestamp" };
  if (fromMs > toMs) return { verification: "proposed", abstentionReason: "timestamp_inversion" };
  if (to.references.includes(from.id)) return { verification: "proven" };
  if (sharedKeys(from.artifacts, to.artifacts).length > 0) return { verification: "proven" };
  return { verification: "proposed", abstentionReason: "missing_shared_artifact" };
}

const MAX_FINDING_EDGES = 200;

const LEGACY_LIFECYCLE_TITLES = new Set([
  "执行节点已启动",
  "任务已初始化",
  "已加载任务坐标",
]);

/** 系统生命周期/运行记账类 Fact：非攻防因果节点，未挂靠任何意图或引用时不入因果图。 */
function isSystemLifecycleFact(fact: Pick<DagFact, "title" | "tags" | "evidencePath">): boolean {
  if (fact.evidencePath) return false;
  const tags = fact.tags ?? [];
  if (tags.includes("asset") || tags.some((t) => t.startsWith("asset.addr:"))) return false;
  if (tags.includes("system") || tags.includes("lifecycle")) return true;
  if (tags.includes("scope") && tags.some((t) => t.startsWith("scopeVersion:"))) return true;
  if (LEGACY_LIFECYCLE_TITLES.has(fact.title)) return true;
  if (/^加载 Skill\s+/.test(fact.title)) return true;
  if (/^(?:解锁|关闭) MCP\s+/.test(fact.title)) return true;
  if (/^授权范围更新至 v\d+/.test(fact.title)) return true;
  return false;
}

/**
 * 资产 → 事实 → 意图 → 漏洞 四层因果图。结构边不做校验；因果边带 proven/proposed。
 * 孤立节点（无任何连线）默认折叠，由 showOrphans 开关释放。
 */
export function collectDag(
  facts: DagFact[],
  intents: DagIntent[],
  findings: DagFinding[] = [],
  assets: DagAsset[] = [],
  serverDag?: ServerDagExport | null,
): DagCollection {
  const records = new Map<string, DagRecord>();
  const links: DagLink[] = [];
  const intentIds = new Set(intents.map((intent) => intent.id));
  const referencedFactIds = new Set<string>();
  for (const asset of assets) referencedFactIds.add(asset.factId);
  for (const intent of intents) {
    for (const sourceId of intent.sourceFactIds ?? []) referencedFactIds.add(sourceId);
  }
  for (const finding of findings) {
    for (const factId of finding.factIds ?? []) referencedFactIds.add(factId);
  }
  for (const edge of serverDag?.edges ?? []) {
    if (edge.from.startsWith("fact:")) referencedFactIds.add(unwrapServerNodeId(edge.from));
    if (edge.to.startsWith("fact:")) referencedFactIds.add(unwrapServerNodeId(edge.to));
  }
  const visibleFacts = facts.filter(
    (fact) =>
      !isSystemLifecycleFact(fact) ||
      Boolean(fact.intentId && intentIds.has(fact.intentId)) ||
      referencedFactIds.has(fact.id),
  );

  const factRefs = new Map<string, NodeRef>();
  const intentRefs = new Map<string, NodeRef>();
  const findingRefs = new Map<string, NodeRef>();

  for (const asset of assets) {
    records.set(assetNodeId(asset.address), {
      kind: "asset",
      title: asset.address,
      meta: asset.kind,
      createdAt: asset.createdAt,
      data: {
        address: asset.address,
        factId: asset.factId,
        intentId: asset.intentId ?? null,
        source: asset.source ?? null,
        assetType: asset.assetType ?? null,
        weight: asset.weight ?? null,
      },
      raw: { ...asset },
    });
  }

  for (const fact of visibleFacts) {
    records.set(fact.id, {
      kind: "fact",
      title: fact.title,
      meta: fact.layer,
      summary: fact.summary,
      createdAt: fact.createdAt,
      data: {
        layer: fact.layer,
        intentId: fact.intentId ?? null,
        evidencePath: fact.evidencePath ?? null,
        tags: fact.tags ?? [],
      },
      raw: { ...fact },
    });
    factRefs.set(fact.id, {
      id: fact.id, createdAt: fact.createdAt,
      references: fact.intentId ? [fact.intentId] : [],
      artifacts: factArtifacts(fact),
    });
  }

  const usesOrigin = intents.some((intent) => (intent.sourceFactIds ?? []).includes(ORIGIN_ID))
    || (serverDag?.edges ?? []).some((e) => unwrapServerNodeId(e.from) === ORIGIN_ID);
  if (usesOrigin) {
    records.set(ORIGIN_ID, {
      kind: "fact",
      title: "任务起点",
      meta: "origin",
      summary: "任务初始化起点（初始授权目标与任务契约）",
      data: { synthetic: true },
      raw: { id: ORIGIN_ID, type: "begin", state: "origin", title: "任务起点" },
    });
  }

  for (const intent of intents) {
    const sources = [...new Set(intent.sourceFactIds?.length ? intent.sourceFactIds : [ORIGIN_ID])];
    records.set(intent.id, {
      kind: "intent",
      title: intent.title,
      meta: intent.status,
      summary: intent.summary,
      conclusion: intent.conclusion ?? null,
      sources,
      createdAt: intent.createdAt,
      updatedAt: intent.updatedAt,
      concludedAt: intent.concludedAt ?? null,
      data: {
        technique: intent.technique ?? null,
        assetRoot: intent.assetRoot ?? null,
        claimedBy: intent.claimedBy ?? null,
      },
      raw: { ...intent },
    });
    const intentArtifacts: Artifact[] = [];
    pushArtifact(intentArtifacts, "asset", intent.assetRoot);
    intentRefs.set(intent.id, {
      id: intent.id, createdAt: intent.createdAt, references: sources,
      artifacts: intentArtifacts,
    });
  }

  for (const finding of findings) {
    records.set(finding.id, {
      kind: "finding",
      title: finding.title,
      meta: `${finding.severity}/${finding.status}`,
      summary: finding.summary || finding.repro || finding.impact || undefined,
      createdAt: finding.createdAt,
      data: {
        asset: finding.asset,
        endpoint: finding.endpoint ?? null,
        vulnClass: finding.vulnClass,
        severity: finding.severity,
        status: finding.status,
        qualification: finding.qualification ?? null,
        cvss: finding.cvss ?? null,
        verifiedBy: finding.verifiedBy ?? null,
        verifiedAt: finding.verifiedAt ?? null,
        repro: finding.repro ?? "",
        impact: finding.impact ?? "",
        pocCurl: finding.pocCurl ?? "",
      },
      raw: { ...finding },
    });
    findingRefs.set(finding.id, {
      id: finding.id, createdAt: finding.createdAt,
      references: [...(finding.intentId ? [finding.intentId] : []), ...(finding.factIds ?? [])],
      artifacts: findingArtifacts(finding),
    });
  }

  if (serverDag?.edges) {
    // 优先消费后端 edge-verifier 产出的权威边，避免前后端校验口径漂移。
    for (const edge of serverDag.edges) {
      const source = unwrapServerNodeId(edge.from);
      const target = unwrapServerNodeId(edge.to);
      if (!records.has(source)) {
        const kind: DagNodeKind = edge.from.startsWith("asset:") ? "asset"
          : edge.from.startsWith("intent:") ? "intent"
          : edge.from.startsWith("finding:") ? "finding"
          : "fact";
        records.set(source, { kind, title: source, meta: "记录缺失" });
      }
      if (!records.has(target)) {
        const kind: DagNodeKind = edge.to.startsWith("asset:") ? "asset"
          : edge.to.startsWith("intent:") ? "intent"
          : edge.to.startsWith("finding:") ? "finding"
          : "fact";
        records.set(target, { kind, title: target, meta: "记录缺失" });
      }
      links.push({
        source,
        target,
        kind: edge.kind,
        ...(edge.verification ? { verification: edge.verification } : { structural: true }),
        ...(edge.abstentionReason ? { abstentionReason: edge.abstentionReason } : {}),
        ...(edge.broken ? { broken: true } : {}),
      });
    }
  } else {
    for (const intent of intents) {
      const sources = [...new Set(intent.sourceFactIds?.length ? intent.sourceFactIds : [ORIGIN_ID])];
      for (const source of sources) {
        if (source === ORIGIN_ID) {
          links.push({ source: ORIGIN_ID, target: intent.id, kind: "anchors", structural: true });
          continue;
        }
        if (!records.has(source)) records.set(source, { kind: "fact", title: source, meta: "记录缺失" });
        const verdict = verifyEdge(factRefs.get(source) ?? null, intentRefs.get(intent.id) ?? null);
        links.push({ source, target: intent.id, kind: "anchors", ...verdict });
      }
    }

    // 意图 → 事实（Explore 回写）
    for (const fact of visibleFacts) {
      if (!fact.intentId || !intentIds.has(fact.intentId)) continue;
      const verdict = verifyEdge(intentRefs.get(fact.intentId) ?? null, factRefs.get(fact.id) ?? null);
      links.push({ source: fact.intentId, target: fact.id, kind: "produces", ...verdict });
    }

    for (const finding of findings) {
      for (const factId of finding.factIds ?? []) {
        if (!records.has(factId)) records.set(factId, { kind: "fact", title: factId, meta: "记录缺失" });
        const verdict = verifyEdge(factRefs.get(factId) ?? null, findingRefs.get(finding.id) ?? null);
        links.push({ source: factId, target: finding.id, kind: "evidences", ...verdict });
      }
      if (finding.intentId && intentIds.has(finding.intentId)) {
        const verdict = verifyEdge(intentRefs.get(finding.intentId) ?? null, findingRefs.get(finding.id) ?? null);
        links.push({ source: finding.intentId, target: finding.id, kind: "yields", ...verdict });
      }
    }

    // 资产 → 事实（结构凭据边，含同资产升级后的历史资产事实）
    const assetAddresses = new Set(assets.map((asset) => asset.address));
    const assertedPairs = new Set<string>();
    for (const asset of assets) {
      if (!records.has(asset.factId)) continue;
      const key = `${asset.address}\0${asset.factId}`;
      assertedPairs.add(key);
      links.push({ source: assetNodeId(asset.address), target: asset.factId, kind: "asserted-by", structural: true });
    }
    for (const fact of visibleFacts) {
      if (!fact.tags?.includes("asset")) continue;
      const addrTag = fact.tags.find((tag) => tag.startsWith("asset.addr:"));
      if (!addrTag) continue;
      const address = addrTag.slice("asset.addr:".length);
      if (!assetAddresses.has(address)) continue;
      const key = `${address}\0${fact.id}`;
      if (assertedPairs.has(key)) continue;
      assertedPairs.add(key);
      links.push({ source: assetNodeId(address), target: fact.id, kind: "asserted-by", structural: true });
    }

    // 兜底链路：缺少 intentId 与 factIds 的漏洞按共享证据文件连 Fact，否则挂所属资产节点。
    const normEv = (p: string) => p.replace(/\\/g, "/").replace(/^(\.\/)+/, "").replace(/^evidence\//, "");
    const factsByEvidence = new Map<string, DagFact[]>();
    for (const fact of visibleFacts) {
      if (!fact.evidencePath) continue;
      const key = normEv(fact.evidencePath);
      if (!key) continue;
      const list = factsByEvidence.get(key) ?? [];
      list.push(fact);
      factsByEvidence.set(key, list);
    }
    const assetsByExact = new Map<string, DagAsset>();
    const assetsByHost = new Map<string, DagAsset>();
    for (const asset of assets) {
      const exact = normAsset(asset.address);
      if (exact && !assetsByExact.has(exact)) assetsByExact.set(exact, asset);
      const host = exact.replace(/:\d+$/, "");
      if (host && !assetsByHost.has(host)) assetsByHost.set(host, asset);
    }
    for (const finding of findings) {
      const hasExplicit = Boolean(finding.intentId && intentIds.has(finding.intentId)) || (finding.factIds?.length ?? 0) > 0;
      if (hasExplicit) continue;
      let linked = false;
      for (const ev of finding.evidence ?? []) {
        const key = normEv(ev.path ?? "");
        for (const fact of factsByEvidence.get(key) ?? []) {
          const verdict = verifyEdge(factRefs.get(fact.id) ?? null, findingRefs.get(finding.id) ?? null);
          links.push({ source: fact.id, target: finding.id, kind: "evidences", ...verdict });
          linked = true;
        }
      }
      if (!linked) {
        const targetAsset = normAsset(finding.asset);
        const matched = targetAsset
          ? (assetsByExact.get(targetAsset) ?? assetsByHost.get(targetAsset.replace(/:\d+$/, "")))
          : undefined;
        if (matched) {
          links.push({ source: assetNodeId(matched.address), target: finding.id, kind: "affects", structural: true });
        }
      }
    }

    // 漏洞 → 漏洞（同资产 + 共享端点/证据/事务，按时间推进）
    const pairs: Array<{ from: DagFinding; to: DagFinding }> = [];
    for (const earlier of findings) {
      for (const later of findings) {
        if (earlier.id === later.id || earlier.asset !== later.asset) continue;
        const a = parseMs(earlier.createdAt);
        const b = parseMs(later.createdAt);
        if (a === null || b === null || a >= b) continue;
        const endpointMatch = earlier.endpoint != null && earlier.endpoint === later.endpoint;
        const earlierKeys = new Set(findingArtifacts(earlier).map(artifactKey));
        const shared = findingArtifacts(later).some((entry) => earlierKeys.has(artifactKey(entry)));
        if (endpointMatch || shared) pairs.push({ from: earlier, to: later });
      }
    }
    pairs.sort((x, y) => x.from.id.localeCompare(y.from.id) || x.to.id.localeCompare(y.to.id));
    for (const pair of pairs.slice(0, MAX_FINDING_EDGES)) {
      const verdict = verifyEdge(findingRefs.get(pair.from.id) ?? null, findingRefs.get(pair.to.id) ?? null);
      links.push({ source: pair.from.id, target: pair.to.id, kind: "escalates", ...verdict });
    }
  }

  // 只保留两端都存在的边，避免悬空连线。
  const validLinks = links.filter((link) => records.has(link.source) && records.has(link.target));
  const degree = new Map<string, number>();
  for (const link of validLinks) {
    degree.set(link.source, (degree.get(link.source) ?? 0) + 1);
    degree.set(link.target, (degree.get(link.target) ?? 0) + 1);
  }
  const orphanIds = new Set<string>();
  for (const id of records.keys()) {
    if (id !== ORIGIN_ID && (degree.get(id) ?? 0) === 0) orphanIds.add(id);
  }

  const sortedLinks = [...validLinks].sort((a, b) =>
    a.source.localeCompare(b.source) || a.target.localeCompare(b.target) || a.kind.localeCompare(b.kind));
  const topologyKey = JSON.stringify({ ids: [...records.keys()].sort(), links: sortedLinks.map((l) => [l.source, l.target, l.kind]) });
  return { records, links: validLinks, orphanIds, topologyKey };
}

export type DagGeometryEdge = DagLink & { id: string; path: string };

function routeSmoothDagEdge(
  fromPos: { x: number; y: number } | undefined,
  toPos: { x: number; y: number } | undefined,
  dagrePoints: Point[],
  vertical: boolean,
): string {
  const start: Point = fromPos
    ? vertical
      ? { x: Math.round(fromPos.x + CARD_SIZE.width / 2), y: Math.round(fromPos.y + CARD_SIZE.height) }
      : { x: Math.round(fromPos.x + CARD_SIZE.width), y: Math.round(fromPos.y + CARD_SIZE.height / 2) }
    : (dagrePoints[0] ?? { x: 0, y: 0 });
  const end: Point = toPos
    ? vertical
      ? { x: Math.round(toPos.x + CARD_SIZE.width / 2), y: Math.round(toPos.y) }
      : { x: Math.round(toPos.x), y: Math.round(toPos.y + CARD_SIZE.height / 2) }
    : (dagrePoints[dagrePoints.length - 1] ?? start);

  if (dagrePoints.length <= 3) {
    if (vertical) {
      const dy = Math.max(36, Math.round(Math.abs(end.y - start.y) * 0.45));
      return `M${start.x} ${start.y} C${start.x} ${start.y + dy}, ${end.x} ${end.y - dy}, ${end.x} ${end.y}`;
    }
    if (end.x >= start.x - 12) {
      const dx = Math.max(42, Math.round((end.x - start.x) * 0.46));
      return `M${start.x} ${start.y} C${start.x + dx} ${start.y}, ${end.x - dx} ${end.y}, ${end.x} ${end.y}`;
    }
    const midY = Math.round((start.y + end.y) / 2 + (start.y <= end.y ? CARD_SIZE.height * 0.65 : -CARD_SIZE.height * 0.65));
    const pad = 32;
    return `M${start.x} ${start.y} C${start.x + pad} ${start.y}, ${start.x + pad} ${midY}, ${Math.round((start.x + end.x) / 2)} ${midY} S${end.x - pad} ${end.y}, ${end.x} ${end.y}`;
  }

  const waypoints: Point[] = [
    start,
    ...dagrePoints.slice(1, -1).map((p) => ({ x: Math.round(p.x), y: Math.round(p.y) })),
    end,
  ];
  let d = `M${waypoints[0]!.x} ${waypoints[0]!.y}`;
  for (let i = 1; i < waypoints.length - 1; i += 1) {
    const curr = waypoints[i]!;
    const next = waypoints[i + 1]!;
    const mx = Math.round((curr.x + next.x) / 2);
    const my = Math.round((curr.y + next.y) / 2);
    d += ` Q${curr.x} ${curr.y} ${mx} ${my}`;
  }
  const last = waypoints[waypoints.length - 1]!;
  d += ` L${last.x} ${last.y}`;
  return d;
}

export function buildDagLayout(dag: DagCollection, vertical: boolean, showOrphans: boolean) {
  const visible = new Set([...dag.records.keys()].filter((id) => showOrphans || !dag.orphanIds.has(id)));
  const links = dag.links.filter((link) => visible.has(link.source) && visible.has(link.target));

  const graph = new Graph({ multigraph: true });
  graph.setGraph({
    rankdir: vertical ? "TB" : "LR",
    ranksep: vertical ? 76 : 104,
    nodesep: vertical ? 28 : 30,
    marginx: 24,
    marginy: 24,
  });
  for (const id of visible) graph.setNode(id, { ...CARD_SIZE });
  for (const link of links) graph.setEdge(link.source, link.target, {}, link.kind);
  if (visible.size) layout(graph);

  const posMap = new Map<string, { x: number; y: number }>();
  const positions = [...visible].map((id) => {
    const node = graph.node(id);
    const position = {
      x: Math.round(node.x - CARD_SIZE.width / 2),
      y: Math.round(node.y - CARD_SIZE.height / 2),
    };
    posMap.set(id, position);
    return { id, position };
  }).sort((a, b) => vertical
    ? a.position.y - b.position.y || a.position.x - b.position.x
    : a.position.x - b.position.x || a.position.y - b.position.y);

  const edges: DagGeometryEdge[] = links.map((link) => {
    const points: Point[] = graph.edge(link.source, link.target, link.kind)?.points ?? [];
    const path = routeSmoothDagEdge(posMap.get(link.source), posMap.get(link.target), points, vertical);
    return { ...link, id: JSON.stringify([link.source, link.target, link.kind]), path };
  });
  return { positions, edges };
}
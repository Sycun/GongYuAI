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
  title: string;
  status: string;
  summary?: string;
  sourceFactIds?: string[];
  assetRoot?: string | null;
  technique?: string | null;
  createdAt?: string;
};

export type DagFinding = {
  id: string;
  title: string;
  asset: string;
  vulnClass: string;
  severity: string;
  status: string;
  summary?: string;
  intentId?: string | null;
  factIds?: string[];
  trafficIds?: string[];
  endpoint?: string | null;
  evidence?: Array<{ path: string; sha256: string }>;
  createdAt?: string;
};

export type DagAsset = {
  address: string;
  kind: string;
  factId: string;
  intentId?: string | null;
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
  sources?: string[];
  data?: Record<string, unknown>;
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

export const CARD_SIZE = { width: 184, height: 64 };
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

  const factRefs = new Map<string, NodeRef>();
  const intentRefs = new Map<string, NodeRef>();
  const findingRefs = new Map<string, NodeRef>();

  for (const asset of assets) {
    records.set(assetNodeId(asset.address), {
      kind: "asset", title: asset.address, meta: asset.kind,
      data: { factId: asset.factId, intentId: asset.intentId ?? null },
    });
  }

  for (const fact of facts) {
    records.set(fact.id, { kind: "fact", title: fact.title, meta: fact.layer, summary: fact.summary });
    factRefs.set(fact.id, {
      id: fact.id, createdAt: fact.createdAt,
      references: fact.intentId ? [fact.intentId] : [],
      artifacts: factArtifacts(fact),
    });
  }

  const usesOrigin = intents.some((intent) => (intent.sourceFactIds ?? []).includes(ORIGIN_ID))
    || (serverDag?.edges ?? []).some((e) => unwrapServerNodeId(e.from) === ORIGIN_ID);
  if (usesOrigin) {
    records.set(ORIGIN_ID, { kind: "fact", title: "任务起点", meta: "origin", data: { synthetic: true } });
  }

  for (const intent of intents) {
    const sources = [...new Set(intent.sourceFactIds?.length ? intent.sourceFactIds : [ORIGIN_ID])];
    records.set(intent.id, {
      kind: "intent", title: intent.title, meta: intent.status, summary: intent.summary, sources,
      data: { technique: intent.technique ?? null, assetRoot: intent.assetRoot ?? null },
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
      kind: "finding", title: finding.title, meta: `${finding.severity}/${finding.status}`,
      summary: finding.summary,
      data: { asset: finding.asset, vulnClass: finding.vulnClass, severity: finding.severity, status: finding.status },
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
    for (const fact of facts) {
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

    // 资产 → 事实（结构凭据边）
    for (const asset of assets) {
      if (!records.has(asset.factId)) continue;
      links.push({ source: assetNodeId(asset.address), target: asset.factId, kind: "asserted-by", structural: true });
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

export function buildDagLayout(dag: DagCollection, vertical: boolean, showOrphans: boolean) {
  const visible = new Set([...dag.records.keys()].filter((id) => showOrphans || !dag.orphanIds.has(id)));
  const links = dag.links.filter((link) => visible.has(link.source) && visible.has(link.target));

  const graph = new Graph({ multigraph: true });
  graph.setGraph({ rankdir: vertical ? "TB" : "LR", ranksep: 64, nodesep: 26 });
  for (const id of visible) graph.setNode(id, { ...CARD_SIZE });
  for (const link of links) graph.setEdge(link.source, link.target, {}, link.kind);
  if (visible.size) layout(graph);

  const positions = [...visible].map((id) => {
    const node = graph.node(id);
    return { id, position: { x: node.x - CARD_SIZE.width / 2, y: node.y - CARD_SIZE.height / 2 } };
  }).sort((a, b) => vertical
    ? a.position.y - b.position.y || a.position.x - b.position.x
    : a.position.x - b.position.x || a.position.y - b.position.y);

  const edges: DagGeometryEdge[] = links.map((link) => {
    const points: Point[] = graph.edge(link.source, link.target, link.kind).points;
    const path = points.map(({ x, y }, i) => `${i ? "L" : "M"}${x} ${y}`).join(" ");
    return { ...link, id: JSON.stringify([link.source, link.target, link.kind]), path };
  });
  return { positions, edges };
}
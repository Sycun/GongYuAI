import { Graph, layout, type Point } from "@dagrejs/dagre";

export type DagFact = {
  id: string;
  layer: string;
  title: string;
  summary?: string;
  intentId?: string | null;
};

export type DagIntent = {
  id: string;
  title: string;
  status: string;
  summary?: string;
  sourceFactIds?: string[];
};

export type DagRecord = {
  kind: "origin" | "fact" | "intent";
  title: string;
  meta?: string;
  summary?: string;
  sources?: string[];
};

type Link = { source: string; target: string; kind: "trigger" | "produce" };
type Topology = { ids: string[]; links: Link[] };

export const CARD_SIZE = { width: 184, height: 64 };

export function collectDag(facts: DagFact[], intents: DagIntent[]) {
  const records = new Map<string, DagRecord>();
  const links: Link[] = [];
  const intentIds = new Set(intents.map((intent) => intent.id));
  const referenced = new Set(intents.flatMap((intent) => intent.sourceFactIds ?? []));

  for (const fact of facts) {
    if (fact.layer !== "title" && !fact.intentId && !referenced.has(fact.id)) continue;
    records.set(fact.id, { kind: "fact", title: fact.title, meta: fact.layer, summary: fact.summary });
    if (fact.intentId && intentIds.has(fact.intentId)) {
      links.push({ source: fact.intentId, target: fact.id, kind: "produce" });
    }
  }
  for (const intent of intents) {
    const sources = [...new Set(intent.sourceFactIds?.length ? intent.sourceFactIds : ["origin"])];
    records.set(intent.id, {
      kind: "intent", title: intent.title, meta: intent.status, summary: intent.summary, sources,
    });
    for (const source of sources) {
      if (!records.has(source)) {
        records.set(source, { kind: "fact", title: source, meta: "记录缺失" });
      }
      links.push({ source, target: intent.id, kind: "trigger" });
    }
  }

  if (records.has("origin")) records.set("origin", { kind: "origin", title: "任务起点" });

  // Polls can update titles and statuses without changing any coordinates.
  links.sort((a, b) =>
    a.source.localeCompare(b.source) || a.target.localeCompare(b.target) || a.kind.localeCompare(b.kind));
  const topology: Topology = { ids: [...records.keys()].sort(), links };
  return { records, topologyKey: JSON.stringify(topology) };
}

export function buildDagLayout(topologyKey: string, vertical: boolean) {
  const { ids, links }: Topology = JSON.parse(topologyKey);
  const graph = new Graph({ multigraph: true });
  graph.setGraph({ rankdir: vertical ? "TB" : "LR", ranksep: 52, nodesep: 24 });
  for (const id of ids) graph.setNode(id, { ...CARD_SIZE });
  for (const link of links) graph.setEdge(link.source, link.target, {}, link.kind);
  if (ids.length) layout(graph);

  const positions = ids.map((id) => {
    const { x, y } = graph.node(id);
    return { id, position: { x: x - CARD_SIZE.width / 2, y: y - CARD_SIZE.height / 2 } };
  }).sort((a, b) => vertical
    ? a.position.y - b.position.y || a.position.x - b.position.x
    : a.position.x - b.position.x || a.position.y - b.position.y);

  const edges = links.map(({ source, target, kind }) => {
    const points: Point[] = graph.edge(source, target, kind).points;
    const path = points.map(({ x, y }, i) => `${i ? "L" : "M"}${x} ${y}`).join(" ");
    return { id: JSON.stringify([source, target, kind]), source, target, kind, path };
  });
  return { positions, edges };
}

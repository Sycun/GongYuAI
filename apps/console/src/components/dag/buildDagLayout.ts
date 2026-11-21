/** Build a layered Fact–Intent DAG layout for SVG rendering. */

export type DagFact = {
  id: string;
  layer: string;
  title: string;
  summary?: string;
  intentId?: string | null;
  createdAt?: string;
};

export type DagIntent = {
  id: string;
  title: string;
  status: string;
  summary?: string;
  sourceFactIds?: string[];
};

export type DagNodeKind = "origin" | "fact" | "intent";

export type DagNode = {
  id: string;
  kind: DagNodeKind;
  label: string;
  sub?: string;
  status?: string;
  layer?: string;
  rank: number;
  indexInRank: number;
  x: number;
  y: number;
};

export type DagEdge = {
  id: string;
  from: string;
  to: string;
  kind: "trigger" | "produce";
};

export type DagLayout = {
  nodes: DagNode[];
  edges: DagEdge[];
  width: number;
  height: number;
};

const ORIGIN_ID = "origin";
const NODE_W = 168;
const NODE_H = 52;
const RANK_GAP = 96;
const ROW_GAP = 28;
const PAD_X = 28;
const PAD_Y = 24;

export const DAG_NODE_SIZE = { w: NODE_W, h: NODE_H } as const;

function truncate(s: string, n: number): string {
  const t = s.trim();
  if (t.length <= n) return t;
  return `${t.slice(0, n - 1)}…`;
}

/** Prefer title-layer facts; keep any fact that participates in an edge. */
function selectFacts(facts: DagFact[], intents: DagIntent[]): DagFact[] {
  const keep = new Set<string>();
  for (const f of facts) {
    if (f.layer === "title") keep.add(f.id);
    if (f.intentId) keep.add(f.id);
  }
  for (const i of intents) {
    for (const sid of i.sourceFactIds ?? []) {
      if (sid !== ORIGIN_ID) keep.add(sid);
    }
  }
  return facts.filter((f) => keep.has(f.id));
}

export function buildDagLayout(facts: DagFact[], intents: DagIntent[]): DagLayout {
  const selected = selectFacts(facts, intents);
  const factById = new Map(selected.map((f) => [f.id, f]));
  const intentById = new Map(intents.map((i) => [i.id, i]));

  const nodeIds = new Set<string>();
  const edges: DagEdge[] = [];

  const needsOrigin = intents.some((i) => (i.sourceFactIds ?? []).includes(ORIGIN_ID));
  if (needsOrigin) nodeIds.add(ORIGIN_ID);

  for (const f of selected) nodeIds.add(f.id);
  for (const i of intents) nodeIds.add(i.id);

  for (const intent of intents) {
    const sources = intent.sourceFactIds?.length ? intent.sourceFactIds : [ORIGIN_ID];
    for (const sid of sources) {
      if (sid === ORIGIN_ID) nodeIds.add(ORIGIN_ID);
      else if (!factById.has(sid) && !nodeIds.has(sid)) {
        /* dangling source — still show stub if missing from selected */
        nodeIds.add(sid);
      }
      if (!nodeIds.has(sid)) continue;
      edges.push({
        id: `t:${sid}->${intent.id}`,
        from: sid,
        to: intent.id,
        kind: "trigger",
      });
    }
  }

  for (const fact of selected) {
    if (!fact.intentId || !intentById.has(fact.intentId)) continue;
    edges.push({
      id: `p:${fact.intentId}->${fact.id}`,
      from: fact.intentId,
      to: fact.id,
      kind: "produce",
    });
  }

  if (nodeIds.size === 0) {
    return { nodes: [], edges: [], width: PAD_X * 2, height: 120 };
  }

  // Kahn layers
  const preds = new Map<string, Set<string>>();
  const succs = new Map<string, Set<string>>();
  for (const id of nodeIds) {
    preds.set(id, new Set());
    succs.set(id, new Set());
  }
  for (const e of edges) {
    if (!nodeIds.has(e.from) || !nodeIds.has(e.to)) continue;
    preds.get(e.to)!.add(e.from);
    succs.get(e.from)!.add(e.to);
  }

  const rank = new Map<string, number>();
  const ready = [...nodeIds].filter((id) => preds.get(id)!.size === 0);
  const remaining = new Set(nodeIds);
  for (const id of ready) {
    rank.set(id, 0);
    remaining.delete(id);
  }
  let guard = nodeIds.size + 2;
  while (remaining.size && guard-- > 0) {
    let progressed = false;
    for (const id of [...remaining]) {
      const ps = [...preds.get(id)!];
      if (ps.some((p) => !rank.has(p))) continue;
      const r = Math.max(0, ...ps.map((p) => rank.get(p)!)) + 1;
      rank.set(id, r);
      remaining.delete(id);
      progressed = true;
    }
    if (!progressed) {
      // cycle / orphan — park leftovers at end
      const maxR = Math.max(0, ...[...rank.values()]);
      for (const id of remaining) rank.set(id, maxR + 1);
      remaining.clear();
    }
  }

  const byRank = new Map<number, string[]>();
  for (const id of nodeIds) {
    const r = rank.get(id) ?? 0;
    const list = byRank.get(r) ?? [];
    list.push(id);
    byRank.set(r, list);
  }

  // Stable-ish order: origin first, then intents, then facts by createdAt/title
  for (const [r, ids] of byRank) {
    ids.sort((a, b) => {
      const ka = kindKey(a, factById, intentById);
      const kb = kindKey(b, factById, intentById);
      if (ka !== kb) return ka - kb;
      return labelOf(a, factById, intentById).localeCompare(labelOf(b, factById, intentById));
    });
    byRank.set(r, ids);
  }

  const maxRank = Math.max(0, ...byRank.keys());
  const maxRows = Math.max(1, ...[...byRank.values()].map((xs) => xs.length));

  const nodes: DagNode[] = [];
  for (let r = 0; r <= maxRank; r++) {
    const ids = byRank.get(r) ?? [];
    ids.forEach((id, indexInRank) => {
      const kind = nodeKind(id, factById, intentById);
      const fact = factById.get(id);
      const intent = intentById.get(id);
      nodes.push({
        id,
        kind,
        label: truncate(labelOf(id, factById, intentById), 22),
        sub:
          kind === "fact"
            ? fact?.layer
            : kind === "intent"
              ? intent?.status
              : "起点",
        status: intent?.status,
        layer: fact?.layer,
        rank: r,
        indexInRank,
        x: PAD_X + r * (NODE_W + RANK_GAP),
        y: PAD_Y + indexInRank * (NODE_H + ROW_GAP),
      });
    });
  }

  const width = PAD_X * 2 + (maxRank + 1) * NODE_W + maxRank * RANK_GAP;
  const height = PAD_Y * 2 + maxRows * NODE_H + (maxRows - 1) * ROW_GAP;

  return { nodes, edges: edges.filter((e) => nodeIds.has(e.from) && nodeIds.has(e.to)), width, height };
}

function nodeKind(
  id: string,
  facts: Map<string, DagFact>,
  intents: Map<string, DagIntent>,
): DagNodeKind {
  if (id === ORIGIN_ID) return "origin";
  if (intents.has(id)) return "intent";
  if (facts.has(id)) return "fact";
  return "fact";
}

function kindKey(
  id: string,
  facts: Map<string, DagFact>,
  intents: Map<string, DagIntent>,
): number {
  const k = nodeKind(id, facts, intents);
  if (k === "origin") return 0;
  if (k === "intent") return 1;
  return 2;
}

function labelOf(
  id: string,
  facts: Map<string, DagFact>,
  intents: Map<string, DagIntent>,
): string {
  if (id === ORIGIN_ID) return "origin";
  return intents.get(id)?.title ?? facts.get(id)?.title ?? id.slice(0, 8);
}

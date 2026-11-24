/**
 * P17 — AD / cloud attack graph as a Fact projection.
 *
 * No second asset store and no second truth source: nodes and edges are Facts
 * tagged `attack.node` / `attack.edge`. The graph is derived on read, and every
 * path can be traced back to the Fact ids that produced it.
 *
 * Sources:
 * - `parseBloodHound()` imports SharpHound/BloodHound JSON (users/groups/
 *   computers/domains + Aces/Members/Sessions/LocalAdmins);
 * - `cloudNode()` / `cloudEdge()` are written by the `cloud_record` tool;
 * - the model can also record nodes/edges directly via `attack_graph_record`.
 */

export type AttackNodeKind =
  | "ad-domain"
  | "ad-user"
  | "ad-group"
  | "ad-computer"
  | "ad-ou"
  | "ad-gpo"
  | "cloud-account"
  | "cloud-resource"
  | "cloud-role"
  | "cloud-policy";

export type AttackEdgeKind =
  | "member-of"
  | "admin-to"
  | "generic-all"
  | "write-dacl"
  | "force-change-password"
  | "has-session"
  | "can-rdp"
  | "trust"
  | "contains"
  | "assume-role"
  | "attached-policy"
  | "can-access";

export type AttackNode = {
  /** Stable external id: SID / ARN / resource id. */
  id: string;
  kind: AttackNodeKind;
  name: string;
  domain?: string;
  provider?: string;
  account?: string;
  /** BloodHound `owned` or operator-marked foothold identity. */
  owned?: boolean;
  factId?: string;
};

export type AttackEdge = {
  from: string;
  to: string;
  kind: AttackEdgeKind;
  /** Fact that supports this edge. */
  factId?: string;
};

export type AttackGraph = {
  nodes: AttackNode[];
  edges: AttackEdge[];
};

export type AttackPath = {
  /** External node ids from source to target. */
  nodes: string[];
  edges: AttackEdgeKind[];
  target: string;
  depth: number;
};

const NODE_KINDS = new Set<AttackNodeKind>([
  "ad-domain", "ad-user", "ad-group", "ad-computer", "ad-ou", "ad-gpo",
  "cloud-account", "cloud-resource", "cloud-role", "cloud-policy",
]);

const EDGE_KINDS = new Set<AttackEdgeKind>([
  "member-of", "admin-to", "generic-all", "write-dacl", "force-change-password",
  "has-session", "can-rdp", "trust", "contains",
  "assume-role", "attached-policy", "can-access",
]);

export const ATTACK_NODE_TAG = "attack.node";
export const ATTACK_EDGE_TAG = "attack.edge";

const enc = (value: string): string => encodeURIComponent(value.trim());
const dec = (value: string): string => {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
};

export function attackNodeTags(node: AttackNode): string[] {
  return [
    ATTACK_NODE_TAG,
    `attack.node.kind:${node.kind}`,
    `attack.node.id:${enc(node.id)}`,
    `attack.node.name:${enc(node.name)}`,
    ...(node.domain ? [`attack.node.domain:${enc(node.domain)}`] : []),
    ...(node.provider ? [`attack.node.provider:${enc(node.provider)}`] : []),
    ...(node.account ? [`attack.node.account:${enc(node.account)}`] : []),
    ...(node.owned ? ["attack.node.owned:true"] : []),
  ];
}

export function attackEdgeTags(edge: AttackEdge): string[] {
  return [
    ATTACK_EDGE_TAG,
    `attack.edge.kind:${edge.kind}`,
    `attack.edge.from:${enc(edge.from)}`,
    `attack.edge.to:${enc(edge.to)}`,
  ];
}

type TaggedFact = { id: string; tags: readonly string[]; title?: string; summary?: string };

function tagValue(tags: readonly string[], prefix: string): string | null {
  const tag = tags.find((entry) => entry.startsWith(prefix));
  return tag ? dec(tag.slice(prefix.length)) : null;
}

/** Derive the graph from Fact tags; unknown tags are ignored, never guessed. */
export function buildAttackGraph(facts: readonly TaggedFact[]): AttackGraph {
  const nodes: AttackNode[] = [];
  const edges: AttackEdge[] = [];
  const byKey = new Map<string, AttackNode>();
  const byId = new Map<string, AttackNode>();

  for (const fact of facts) {
    if (!fact.tags.includes(ATTACK_NODE_TAG)) continue;
    const kind = tagValue(fact.tags, "attack.node.kind:") as AttackNodeKind | null;
    const id = tagValue(fact.tags, "attack.node.id:");
    const name = tagValue(fact.tags, "attack.node.name:");
    if (!kind || !NODE_KINDS.has(kind) || !id) continue;
    const node: AttackNode = {
      id,
      kind,
      name: name ?? id,
      ...(tagValue(fact.tags, "attack.node.domain:") ? { domain: tagValue(fact.tags, "attack.node.domain:")! } : {}),
      ...(tagValue(fact.tags, "attack.node.provider:") ? { provider: tagValue(fact.tags, "attack.node.provider:")! } : {}),
      ...(tagValue(fact.tags, "attack.node.account:") ? { account: tagValue(fact.tags, "attack.node.account:")! } : {}),
      ...(fact.tags.includes("attack.node.owned:true") ? { owned: true } : {}),
      factId: fact.id,
    };
    const key = `${kind}:${id}`;
    if (byKey.has(key)) continue;
    byKey.set(key, node);
    byId.set(id, node);
    nodes.push(node);
  }

  for (const fact of facts) {
    if (!fact.tags.includes(ATTACK_EDGE_TAG)) continue;
    const kind = tagValue(fact.tags, "attack.edge.kind:") as AttackEdgeKind | null;
    const from = tagValue(fact.tags, "attack.edge.from:");
    const to = tagValue(fact.tags, "attack.edge.to:");
    if (!kind || !EDGE_KINDS.has(kind) || !from || !to) continue;
    if (!byId.has(from) || !byId.has(to)) continue;
    edges.push({ from, to, kind, factId: fact.id });
  }

  // Deterministic order for reproducible graphs/CLI output.
  nodes.sort((a, b) => a.kind.localeCompare(b.kind) || a.id.localeCompare(b.id));
  edges.sort((a, b) => a.from.localeCompare(b.from) || a.to.localeCompare(b.to) || a.kind.localeCompare(b.kind));
  return { nodes, edges };
}

const DA_NAME = /(domain admins|enterprise admins|schema admins)/i;

export function isDomainAdminNode(node: AttackNode): boolean {
  return node.kind === "ad-group" && DA_NAME.test(node.name);
}

/**
 * BFS over directed edges. Sources default to `owned` nodes (or an explicit
 * `from` list). Targets default to Domain/Enterprise/Schema Admins. Cycles are
 * bounded by `maxDepth` and a visited set per source.
 */
export function findAttackPaths(
  graph: AttackGraph,
  opts: {
    from?: readonly string[];
    /** Explicit target ids; defaults to Domain/Enterprise/Schema Admins. */
    targets?: readonly string[];
    maxDepth?: number;
    maxPaths?: number;
  } = {},
): AttackPath[] {
  const maxDepth = Math.min(Math.max(opts.maxDepth ?? 6, 1), 12);
  const maxPaths = Math.min(Math.max(opts.maxPaths ?? 20, 1), 100);
  const byId = new Map(graph.nodes.map((node) => [node.id, node]));
  const adjacency = new Map<string, AttackEdge[]>();
  for (const edge of graph.edges) {
    const list = adjacency.get(edge.from) ?? [];
    list.push(edge);
    adjacency.set(edge.from, list);
  }
  const targets = new Set(
    opts.targets?.length
      ? opts.targets.filter((id) => byId.has(id))
      : graph.nodes.filter(isDomainAdminNode).map((node) => node.id),
  );
  const sources = opts.from?.length
    ? [...opts.from]
    : graph.nodes.filter((node) => node.owned).map((node) => node.id);
  const paths: AttackPath[] = [];
  for (const source of sources) {
    if (!byId.has(source)) continue;
    const queue: Array<{ id: string; nodes: string[]; edges: AttackEdgeKind[] }> = [
      { id: source, nodes: [source], edges: [] },
    ];
    const seen = new Set<string>([source]);
    while (queue.length && paths.length < maxPaths) {
      const current = queue.shift()!;
      if (current.edges.length >= maxDepth) continue;
      for (const edge of adjacency.get(current.id) ?? []) {
        if (seen.has(edge.to)) continue;
        const next = {
          id: edge.to,
          nodes: [...current.nodes, edge.to],
          edges: [...current.edges, edge.kind],
        };
        if (targets.has(edge.to)) {
          paths.push({
            nodes: next.nodes,
            edges: next.edges,
            target: edge.to,
            depth: next.edges.length,
          });
          if (paths.length >= maxPaths) break;
          continue;
        }
        seen.add(edge.to);
        queue.push(next);
      }
    }
  }
  paths.sort((a, b) => a.depth - b.depth || a.nodes.join(">").localeCompare(b.nodes.join(">")));
  return paths.slice(0, maxPaths);
}

// ---------------------------------------------------------------------------
// BloodHound / SharpHound JSON import
// ---------------------------------------------------------------------------

export type BloodHoundImport = {
  nodes: AttackNode[];
  edges: AttackEdge[];
  skipped: boolean;
  reason?: string;
};

type AnyRecord = Record<string, unknown>;

const asArray = (value: unknown): AnyRecord[] =>
  Array.isArray(value) ? value.filter((entry): entry is AnyRecord => Boolean(entry) && typeof entry === "object") : [];

const str = (value: unknown): string => (typeof value === "string" ? value : "");

const RIGHT_TO_EDGE: Record<string, AttackEdgeKind> = {
  GenericAll: "generic-all",
  GenericWrite: "write-dacl",
  WriteDacl: "write-dacl",
  WriteOwner: "write-dacl",
  ForceChangePassword: "force-change-password",
  AddMember: "member-of",
  AdminTo: "admin-to",
  CanRDP: "can-rdp",
  MemberOf: "member-of",
};

function nodeKindFromHint(hint?: string): AttackNodeKind | null {
  switch (hint) {
    case "users":
      return "ad-user";
    case "groups":
      return "ad-group";
    case "computers":
      return "ad-computer";
    case "domains":
      return "ad-domain";
    case "ous":
      return "ad-ou";
    case "gpos":
      return "ad-gpo";
    default:
      return null;
  }
}

function nodeKindFor(entry: AnyRecord): AttackNodeKind | null {
  const props = (entry.Properties ?? {}) as AnyRecord;
  const objectType = str(entry.ObjectType).toLowerCase();
  const labels = Array.isArray(entry.label) ? entry.label.map(String) : [];
  const kind = (str(props.kind) || objectType || labels[0] || "").toLowerCase();
  if (kind.includes("user")) return "ad-user";
  if (kind.includes("group")) return "ad-group";
  if (kind.includes("computer")) return "ad-computer";
  if (kind.includes("domain")) return "ad-domain";
  if (kind.includes("ou")) return "ad-ou";
  if (kind.includes("gpo")) return "ad-gpo";
  return null;
}

function bloodHoundNode(entry: AnyRecord, hint?: string): AttackNode | null {
  const props = (entry.Properties ?? {}) as AnyRecord;
  const kind = nodeKindFor(entry) ?? nodeKindFromHint(hint);
  const id = str(entry.ObjectIdentifier);
  if (!kind || !id) return null;
  const name = str(props.name) || id;
  const domain = str(props.domain);
  return {
    id,
    kind,
    name,
    ...(domain ? { domain } : {}),
    ...(props.owned === true ? { owned: true } : {}),
  };
}

/**
 * Accept a single BloodHound JSON object with `users/groups/computers/domains`
 * arrays, an array of such objects, or a flat array of BloodHound entries.
 */
export function parseBloodHound(data: unknown): BloodHoundImport {
  const nodes: AttackNode[] = [];
  const edges: AttackEdge[] = [];
  const seenNodes = new Set<string>();
  const seenEdges = new Set<string>();
  const pushNode = (node: AttackNode | null) => {
    if (!node) return;
    const key = `${node.kind}:${node.id}`;
    if (seenNodes.has(key)) return;
    seenNodes.add(key);
    nodes.push(node);
  };
  const pushEdge = (from: string, to: string, kind: AttackEdgeKind) => {
    if (!from || !to) return;
    const key = `${from}->${to}:${kind}`;
    if (seenEdges.has(key)) return;
    seenEdges.add(key);
    edges.push({ from, to, kind });
  };

  const files: Array<{ entry: AnyRecord; hint?: string }> = [];
  const visit = (value: unknown, hint?: string) => {
    if (Array.isArray(value)) {
      for (const entry of value) {
        if (entry && typeof entry === "object" && !Array.isArray(entry)) {
          const record = entry as AnyRecord;
          if (record.ObjectIdentifier) files.push({ entry: record, ...(hint ? { hint } : {}) });
          else visit(record);
        }
      }
      return;
    }
    if (!value || typeof value !== "object") return;
    const record = value as AnyRecord;
    for (const key of ["users", "groups", "computers", "domains", "ous", "gpos"]) {
      const list = record[key];
      if (Array.isArray(list)) {
        for (const entry of list) {
          if (entry && typeof entry === "object") {
            files.push({ entry: entry as AnyRecord, hint: key });
          }
        }
      }
    }
  };
  visit(data);

  if (files.length === 0) {
    return { nodes: [], edges: [], skipped: true, reason: "no BloodHound objects found" };
  }

  for (const { entry, hint } of files) {
    const node = bloodHoundNode(entry, hint);
    if (!node) continue;
    pushNode(node);
    const props = (entry.Properties ?? {}) as AnyRecord;
    const members = asArray(entry.Members);
    for (const member of members) {
      const memberId = str(member.ObjectIdentifier);
      pushEdge(memberId, node.id, "member-of");
    }
    const sessions = asArray(entry.Sessions);
    for (const session of sessions) {
      const userId = str(session.UserSID);
      pushEdge(userId, node.id, "has-session");
    }
    const localAdmins = asArray(entry.LocalAdmins);
    for (const admin of localAdmins) {
      pushEdge(str(admin.ObjectIdentifier), node.id, "admin-to");
    }
    const aces = asArray(entry.Aces);
    for (const ace of aces) {
      const principal = str(ace.PrincipalSID);
      const right = str(ace.RightName);
      const kind = RIGHT_TO_EDGE[right];
      if (principal && kind) pushEdge(principal, node.id, kind);
    }
    if (props.enabled === false) {
      // Keep the node; the graph is descriptive, not a live authorization.
    }
  }

  // Resolve member/session/ACL edges against imported nodes when possible.
  const present = new Set(nodes.map((node) => node.id));
  return {
    nodes,
    edges: edges.filter((edge) => present.has(edge.from) && present.has(edge.to)),
    skipped: false,
  };
}

/** Cloud node/edge helpers used by the `cloud_record` tool. */
export function cloudNode(input: {
  id: string;
  kind: Extract<AttackNodeKind, `cloud-${string}`>;
  name: string;
  provider: string;
  account?: string;
}): AttackNode {
  return {
    id: input.id,
    kind: input.kind,
    name: input.name,
    provider: input.provider,
    ...(input.account ? { account: input.account } : {}),
  };
}

export function cloudEdge(input: {
  from: string;
  to: string;
  kind: Extract<AttackEdgeKind, "assume-role" | "attached-policy" | "can-access" | "member-of">;
}): AttackEdge {
  return input;
}

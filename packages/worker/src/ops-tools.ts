import { createHash } from "node:crypto";
import type { WorkerManifest } from "@gongyuai/contracts";
import {
  parseHostEnumeration,
  parseBloodHound,
  cloudNode,
  cloudEdge,
  findAttackPaths,
} from "@gongyuai/contracts";
import type {
  AttackNode,
  AttackEdge,
  AttackNodeKind,
  AttackEdgeKind,
} from "@gongyuai/contracts";
import { admitAddress, redactSecretRef } from "@gongyuai/contracts";
import { readEvidenceBytes, type HistoryStore } from "@gongyuai/history";
import { capabilityAtLeast } from "./tools.js";
import type { SkillHub } from "./skills/runtime.js";

/**
 * P14-B0 — operations the prompt already promised the model but the tool
 * surface never exposed: consult / change ledger / credentials / skill enable.
 * All of them are bookkeeping writes; execution keeps going through gateTool.
 */
export type OpsToolContext = {
  manifest: WorkerManifest;
  history: HistoryStore;
  workerId: string;
  activeIntentId?: string | null;
};

function opsScope(manifest: WorkerManifest) {
  return {
    taskId: manifest.taskId,
    engagementId: manifest.engagementId || manifest.taskId,
    scopeVersion: manifest.scopeVersion ?? 1,
  };
}

function requireCapability(manifest: WorkerManifest, need: "scan" | "active-lab"): void {
  const cap = manifest.auth.capability ?? "full";
  if (!capabilityAtLeast(cap, need)) {
    throw new Error(`denied: this tool requires auth.capability≥${need} (have ${cap})`);
  }
}

/** Split "a, b / c" into a clean string list. */
export function splitList(raw: string | undefined, max = 12): string[] {
  if (!raw) return [];
  return raw
    .split(/[\n,;]+/)
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, max);
}

export function consultTool(ctx: OpsToolContext, args: {
  question?: string;
  context?: string;
  options?: string;
  blocking?: string;
  relatedIntentId?: string;
}): string {
  const question = (args.question ?? "").trim();
  if (question.length < 4) throw new Error("operator_consult requires a clear question");
  const consult = ctx.history.ops.createConsult(
    opsScope(ctx.manifest),
    {
      question,
      context: (args.context ?? "").trim(),
      options: splitList(args.options),
      blocking: args.blocking !== "false" && args.blocking !== "0",
      askedBy: ctx.workerId,
      ...(args.relatedIntentId
        ? { relatedIntentId: args.relatedIntentId }
        : ctx.activeIntentId
          ? { relatedIntentId: ctx.activeIntentId }
          : {}),
    },
    Date.now(),
  );
  return JSON.stringify({
    ok: true,
    consultId: consult.id,
    dueAt: consult.dueAt,
    blocking: consult.blocking,
    note: "问题已登记；24h 无回复自动转非阻塞。回复以 human Hint 唤醒。",
  });
}

export function changeRecordTool(ctx: OpsToolContext, args: {
  kind?: string;
  asset?: string;
  location?: string;
  rollbackCmd?: string;
  beforePath?: string;
  note?: string;
  credentialId?: string;
  intentId?: string;
}): string {
  requireCapability(ctx.manifest, "scan");
  const allowed = new Set(["webshell", "account", "config", "persistence", "db", "network", "file"]);
  const kind = (args.kind ?? "").trim();
  if (!allowed.has(kind)) {
    throw new Error(`change_record kind must be one of ${[...allowed].join("|")}`);
  }
  const asset = (args.asset ?? "").trim();
  if (!asset) throw new Error("change_record requires asset");
  const location = (args.location ?? "").trim();
  if (!location) throw new Error("change_record requires location");
  const rollbackCmd = (args.rollbackCmd ?? "").trim();
  if (!rollbackCmd) throw new Error("change_record requires rollbackCmd (回滚命令)");

  // Pre-change backup: if the caller sealed one under evidence/, record its hash.
  let beforeSha256: string | null = null;
  const materials: Array<{ path: string; sha256: string }> = [];
  if (args.beforePath?.trim()) {
    const before = readEvidenceBytes(ctx.manifest.evidenceDir, args.beforePath.trim());
    beforeSha256 = createHash("sha256").update(before).digest("hex");
    materials.push({ path: args.beforePath.trim(), sha256: beforeSha256 });
  }

  const change = ctx.history.ops.recordChange(
    opsScope(ctx.manifest),
    {
      kind: kind as "webshell" | "account" | "config" | "persistence" | "db" | "network" | "file",
      asset,
      location,
      rollbackCmd,
      registeredBy: ctx.workerId,
      note: args.note ?? "",
      ...(args.credentialId ? { credentialId: args.credentialId } : {}),
      ...(args.intentId ?? ctx.activeIntentId
        ? { intentId: args.intentId ?? ctx.activeIntentId ?? undefined }
        : {}),
    },
    beforeSha256,
    new Date().toISOString(),
    materials,
  );
  return JSON.stringify({ ok: true, change });
}

export function changeListTool(ctx: OpsToolContext): string {
  const changes = ctx.history.ops.listChanges(ctx.manifest.taskId);
  return JSON.stringify({
    ok: true,
    count: changes.length,
    changes: changes.map((c) => ({
      id: c.id,
      kind: c.kind,
      asset: c.asset,
      location: c.location,
      appliedAt: c.appliedAt,
      rollbackCmd: c.rollbackCmd,
      beforeSha256: c.beforeSha256,
      confirmedBy: c.confirmedBy,
    })),
  });
}

export function credentialRecordTool(ctx: OpsToolContext, args: {
  kind?: string;
  asset?: string;
  username?: string;
  secretRef?: string;
  secretHmac?: string;
  sourceFindingId?: string;
  verified?: string;
  expiresAt?: string;
}): string {
  requireCapability(ctx.manifest, "scan");
  const kind = (args.kind ?? "").trim();
  if (!kind) throw new Error("credential_record requires kind");
  const asset = (args.asset ?? "").trim();
  if (!asset) throw new Error("credential_record requires asset");
  const secretRef = (args.secretRef ?? "").trim();
  if (!secretRef) throw new Error("credential_record requires secretRef (evidence path or env var name)");
  // Never accept the secret itself: pointers are paths or env var names.
  if (/\s/.test(secretRef) || secretRef.length > 512) {
    throw new Error("credential_record secretRef must be a pointer (evidence path / env var), not the secret");
  }
  const admission = admitAddress(ctx.manifest.auth, asset);
  if (admission.kind === "oos") {
    throw new Error(`denied: credential asset ${asset} is out of scope`);
  }
  const { credential, created } = ctx.history.recordCredential({
    taskId: ctx.manifest.taskId,
    kind: kind as "password" | "hash" | "ticket" | "token" | "key" | "session" | "cookie" | "foothold-shell",
    asset,
    username: args.username,
    secretRef,
    secretHmac: args.secretHmac,
    sourceFindingId: args.sourceFindingId,
    verified: args.verified === "true" || args.verified === "1",
    expiresAt: args.expiresAt,
  });
  return JSON.stringify({
    ok: true,
    created,
    credential: { ...credential, secretRef: redactSecretRef(credential.secretRef) },
  });
}

export function credentialListTool(ctx: OpsToolContext): string {
  const credentials = ctx.history.listCredentials(ctx.manifest.taskId);
  return JSON.stringify({
    ok: true,
    count: credentials.length,
    credentials: credentials.map((c) => ({
      id: c.id,
      kind: c.kind,
      asset: c.asset,
      username: c.username,
      secretRef: redactSecretRef(c.secretRef),
      verifiedAt: c.verifiedAt,
      lastUsedAt: c.lastUsedAt,
      reuseCount: c.reuseCount,
    })),
    note: "明文永不回显；需要值请按 secretRef 读证据文件。",
  });
}

export function skillEnableTool(skillHub: SkillHub, args: { id?: string; reason?: string }): string {
  return skillHub.load(args.id ?? "", args.reason || "enabled for current phase");
}

export function skillDisableTool(args: { id?: string }): string {
  return `skill ${args.id ?? ""} 无需 disable：路由表常驻，正文只在 load_skill 时进入对话。`;
}

/** P14-B4 — record one foothold host profile (structured, evidence-backed). */
export function hostProfileRecordTool(ctx: OpsToolContext, args: {
  asset?: string;
  hostname?: string;
  os?: string;
  domain?: string;
  users?: string;
  privileges?: string;
  services?: string;
  shares?: string;
  av?: string;
  evidencePath?: string;
  source?: string;
}): string {
  requireCapability(ctx.manifest, "scan");
  const asset = (args.asset ?? "").trim();
  if (!asset) throw new Error("host_profile_record requires asset");
  const admission = admitAddress(ctx.manifest.auth, asset);
  if (admission.kind === "oos") {
    throw new Error(`denied: host profile asset ${asset} is out of scope`);
  }
  const profile = ctx.history.recordHostProfile(ctx.manifest.taskId, {
    asset,
    ...(args.hostname ? { hostname: args.hostname } : {}),
    ...(args.os ? { os: args.os } : {}),
    ...(args.domain ? { domain: args.domain } : {}),
    users: splitList(args.users, 200),
    privileges: splitList(args.privileges, 200),
    services: splitList(args.services, 200),
    shares: splitList(args.shares, 200),
    av: splitList(args.av, 50),
    ...(args.evidencePath ? { evidencePath: args.evidencePath } : {}),
    source: args.source?.trim() || "worker",
  });
  return JSON.stringify({ ok: true, profile });
}

/** P17: parse read-only enumeration output into a HostProfile; skip means no profile write. */
export function hostProfileParseTool(ctx: OpsToolContext, args: {
  asset?: string;
  text?: string;
  evidencePath?: string;
}): string {
  requireCapability(ctx.manifest, "scan");
  const asset = (args.asset ?? "").trim();
  if (!asset) throw new Error("host_profile_parse requires asset");
  const admission = admitAddress(ctx.manifest.auth, asset);
  if (admission.kind === "oos") {
    throw new Error(`denied: host profile asset ${asset} is out of scope`);
  }
  const parsed = parseHostEnumeration(args.text ?? "");
  if (parsed.matched.length === 0) {
    return JSON.stringify({
      ok: false,
      skipped: true,
      reason: "no supported enumeration format matched; use host_profile_record manually",
      matched: [],
    });
  }
  const profile = ctx.history.recordHostProfile(ctx.manifest.taskId, {
    asset,
    ...parsed.draft,
    ...(args.evidencePath ? { evidencePath: args.evidencePath } : {}),
    source: "enum-parser",
  });
  return JSON.stringify({ ok: true, matched: parsed.matched, profile });
}

export function hostProfileListTool(ctx: OpsToolContext): string {
  const profiles = ctx.history.listHostProfiles(ctx.manifest.taskId);
  return JSON.stringify({ ok: true, count: profiles.length, profiles });
}

const ATTACK_NODE_KINDS = new Set<AttackNodeKind>([
  "ad-domain", "ad-user", "ad-group", "ad-computer", "ad-ou", "ad-gpo",
  "cloud-account", "cloud-resource", "cloud-role", "cloud-policy",
]);
const ATTACK_EDGE_KINDS = new Set<AttackEdgeKind>([
  "member-of", "admin-to", "generic-all", "write-dacl", "force-change-password",
  "has-session", "can-rdp", "trust", "contains",
  "assume-role", "attached-policy", "can-access",
]);

function parseAttackNode(raw: unknown): AttackNode {
  const value = (raw ?? {}) as Record<string, unknown>;
  const id = String(value.id ?? "").trim();
  const kind = String(value.kind ?? "").trim() as AttackNodeKind;
  const name = String(value.name ?? "").trim();
  if (!id || !ATTACK_NODE_KINDS.has(kind) || !name) {
    throw new Error("attack node requires id/kind/name (kind must be ad-* or cloud-*)");
  }
  return {
    id,
    kind,
    name,
    ...(value.domain ? { domain: String(value.domain) } : {}),
    ...(value.provider ? { provider: String(value.provider) } : {}),
    ...(value.account ? { account: String(value.account) } : {}),
    ...(value.owned === true ? { owned: true } : {}),
  };
}

function parseAttackEdge(raw: unknown): AttackEdge {
  const value = (raw ?? {}) as Record<string, unknown>;
  const from = String(value.from ?? "").trim();
  const to = String(value.to ?? "").trim();
  const kind = String(value.kind ?? "").trim() as AttackEdgeKind;
  if (!from || !to || !ATTACK_EDGE_KINDS.has(kind)) {
    throw new Error("attack edge requires from/to/kind");
  }
  return { from, to, kind };
}

/** P17 — record one typed AD/cloud node or edge as a Fact. */
export function attackGraphRecordTool(ctx: OpsToolContext, args: {
  type?: string;
  json?: string;
}): string {
  requireCapability(ctx.manifest, "scan");
  const type = (args.type ?? "node").trim().toLowerCase();
  let raw: unknown;
  try {
    raw = JSON.parse(args.json ?? "{}");
  } catch {
    throw new Error("attack_graph_record requires valid JSON in json");
  }
  if (type === "node") {
    const node = parseAttackNode(raw);
    const fact = ctx.history.recordAttackNode(ctx.manifest.taskId, node);
    return JSON.stringify({ ok: true, type, node, factId: fact.id });
  }
  if (type === "edge") {
    const edge = parseAttackEdge(raw);
    const fact = ctx.history.recordAttackEdge(ctx.manifest.taskId, edge);
    return JSON.stringify({ ok: true, type, edge, factId: fact.id });
  }
  throw new Error("attack_graph_record type must be node|edge");
}

/** P17 — import BloodHound/SharpHound JSON; counts and shortest paths. */
export function bloodhoundImportTool(ctx: OpsToolContext, args: { text?: string }): string {
  requireCapability(ctx.manifest, "scan");
  let parsed: unknown;
  try {
    parsed = JSON.parse(args.text ?? "");
  } catch {
    throw new Error("bloodhound_import requires valid JSON");
  }
  const imported = parseBloodHound(parsed);
  if (imported.skipped) {
    return JSON.stringify({ ok: false, skipped: true, reason: imported.reason ?? "no objects" });
  }
  for (const node of imported.nodes) ctx.history.recordAttackNode(ctx.manifest.taskId, node);
  for (const edge of imported.edges) ctx.history.recordAttackEdge(ctx.manifest.taskId, edge);
  const graph = ctx.history.attackGraph(ctx.manifest.taskId);
  const paths = findAttackPaths(graph, { maxDepth: 8, maxPaths: 10 });
  return JSON.stringify({
    ok: true,
    nodes: imported.nodes.length,
    edges: imported.edges.length,
    graph: { nodes: graph.nodes.length, edges: graph.edges.length },
    paths,
  });
}

/** P17 — cloud node/edge recorder (provider-scoped). */
export function cloudRecordTool(ctx: OpsToolContext, args: {
  provider?: string;
  kind?: string;
  id?: string;
  name?: string;
  account?: string;
  edgeFrom?: string;
  edgeTo?: string;
  edgeKind?: string;
}): string {
  requireCapability(ctx.manifest, "scan");
  const provider = (args.provider ?? "").trim().toLowerCase();
  if (!provider) throw new Error("cloud_record requires provider");
  const id = (args.id ?? "").trim();
  const kind = (args.kind ?? "cloud-resource").trim() as AttackNodeKind;
  if (!id || !kind.startsWith("cloud-") || !ATTACK_NODE_KINDS.has(kind)) {
    throw new Error("cloud_record requires id and cloud-* kind");
  }
  const node = cloudNode({
    id,
    kind: kind as Extract<AttackNodeKind, `cloud-${string}`>,
    name: (args.name ?? id).trim(),
    provider,
    ...(args.account ? { account: args.account } : {}),
  });
  const fact = ctx.history.recordAttackNode(ctx.manifest.taskId, node);
  let edgeFactId: string | null = null;
  if (args.edgeFrom && args.edgeTo && args.edgeKind) {
    const edge = cloudEdge({
      from: args.edgeFrom,
      to: args.edgeTo,
      kind: args.edgeKind as Extract<AttackEdgeKind, "assume-role" | "attached-policy" | "can-access" | "member-of">,
    });
    if (!ATTACK_EDGE_KINDS.has(edge.kind)) throw new Error("invalid cloud edge kind");
    edgeFactId = ctx.history.recordAttackEdge(ctx.manifest.taskId, edge).id;
  }
  return JSON.stringify({ ok: true, node, factId: fact.id, edgeFactId });
}

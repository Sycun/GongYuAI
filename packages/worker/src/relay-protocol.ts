import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  RelayProtocolSchema,
  type RelayProtocol,
  type WorkerManifest,
} from "@gongyuai/contracts";
import type { HistoryStore } from "@gongyuai/history";

export type RelayWriteInput = {
  trigger: "auto" | "agent";
  reason?: string;
  current_position?: string;
  network_map?: string;
  tried?: string;
  active_sessions?: string;
  foothold?: string;
  unexplored_surface?: string;
  /** Structured engineering slots (optional; old π files parse with ""). */
  confirmed_architecture_and_decoys?: string;
  falsified_hypotheses?: string;
  workspace_artifacts?: string;
  live_footholds?: string;
  next_falsifiable_experiment?: string;
  tokens: number;
  toolCalls: number;
  wallMs?: number;
  /** Next generation index (0-based file π{n}). */
  generation: number;
};

export function relayDir(workspaceDir: string, workerSlot = 0): string {
  return join(workspaceDir, workerSlot > 0 ? `relay-w${workerSlot}` : "relay");
}

export function relayPath(workspaceDir: string, generation: number, workerSlot = 0): string {
  return join(relayDir(workspaceDir, workerSlot), `π${generation}.json`);
}

export function listRelayProtocols(workspaceDir: string, workerSlot = 0): RelayProtocol[] {
  const dir = relayDir(workspaceDir, workerSlot);
  if (!existsSync(dir)) return [];
  const files = readdirSync(dir)
    .filter((f) => /^π\d+\.json$/u.test(f) || /^pi\d+\.json$/i.test(f))
    .sort((a, b) => {
      const na = Number(a.replace(/^[^\d]+/u, "").replace(/\.json$/i, ""));
      const nb = Number(b.replace(/^[^\d]+/u, "").replace(/\.json$/i, ""));
      return na - nb;
    });
  const out: RelayProtocol[] = [];
  for (const f of files) {
    try {
      const raw = JSON.parse(readFileSync(join(dir, f), "utf8"));
      out.push(RelayProtocolSchema.parse(raw));
    } catch {
      /* skip corrupt */
    }
  }
  return out;
}

const MAX_FULL_RELAYS = 3;

export function formatRelayInjection(protocols: RelayProtocol[]): string {
  if (!protocols.length) {
    return "## Session Relay\n（尚无 π；本会话为冷启动。）\n";
  }
  const lines: string[] = ["## Session Relay（累积 π；冲突以 History 为准）"];
  const splitIdx = Math.max(0, protocols.length - MAX_FULL_RELAYS);
  const older = protocols.slice(0, splitIdx);
  const recent = protocols.slice(splitIdx);
  if (older.length > 0) {
    lines.push(`### 早期交接摘要（π0..π${older[older.length - 1]!.generation}，共 ${older.length} 代已折叠）`);
    for (const p of older.slice(-10)) {
      const fh = p.foothold ? ` · foothold=${p.foothold.slice(0, 120)}` : "";
      const pos = p.current_position ? ` · pos=${p.current_position.slice(0, 80)}` : "";
      lines.push(`- π${p.generation} (${p.trigger}${p.reason ? `: ${p.reason.slice(0, 60)}` : ""})${pos}${fh}`);
    }
    if (older.length > 10) {
      lines.push(`- … 更早 ${older.length - 10} 代 π 已归档于 workspace/relay/，权威状态以 History 图为准。`);
    }
  }
  for (const p of recent) {
    lines.push(`### π${p.generation} · ${p.trigger}${p.reason ? ` · ${p.reason}` : ""}`);
    lines.push(`- current_position: ${p.current_position || "—"}`);
    lines.push(`- network_map: ${p.network_map || "—"}`);
    lines.push(`- tried: ${p.tried || "—"}`);
    lines.push(`- active_sessions: ${p.active_sessions || "—"}`);
    lines.push(`- foothold: ${p.foothold || "—"}`);
    lines.push(`- unexplored_surface: ${p.unexplored_surface || "—"}`);
    if (p.confirmed_architecture_and_decoys) {
      lines.push(`- confirmed_architecture_and_decoys: ${p.confirmed_architecture_and_decoys}`);
    }
    if (p.falsified_hypotheses) {
      lines.push(`- falsified_hypotheses: ${p.falsified_hypotheses}`);
    }
    if (p.workspace_artifacts) {
      lines.push(`- workspace_artifacts: ${p.workspace_artifacts}`);
    }
    if (p.live_footholds) {
      lines.push(`- live_footholds: ${p.live_footholds}`);
    }
    if (p.next_falsifiable_experiment) {
      lines.push(`- next_falsifiable_experiment: ${p.next_falsifiable_experiment}`);
    }
    lines.push(`- open_intents: ${p.open_intents.join(", ") || "—"}`);
    lines.push(
      `- budget_spent: tokens=${p.budget_spent.tokens} toolCalls=${p.budget_spent.toolCalls} wallMs=${p.budget_spent.wallMs}`,
    );
  }
  return lines.join("\n");
}

export function writeRelayProtocol(
  manifest: WorkerManifest,
  history: HistoryStore,
  input: RelayWriteInput,
): RelayProtocol {
  const open = history
    .listIntents(manifest.taskId)
    .filter((i) => ["proposed", "claimed", "running"].includes(i.status))
    .map((i) => i.id);

  const protocol = RelayProtocolSchema.parse({
    generation: input.generation,
    createdAt: new Date().toISOString(),
    trigger: input.trigger,
    reason: input.reason ?? "",
    current_position: input.current_position ?? "",
    network_map: input.network_map ?? "",
    tried: input.tried ?? "",
    active_sessions: input.active_sessions ?? "",
    foothold: input.foothold ?? "",
    unexplored_surface: input.unexplored_surface ?? "",
    confirmed_architecture_and_decoys: input.confirmed_architecture_and_decoys ?? "",
    falsified_hypotheses: input.falsified_hypotheses ?? "",
    workspace_artifacts: input.workspace_artifacts ?? "",
    live_footholds: input.live_footholds ?? "",
    next_falsifiable_experiment: input.next_falsifiable_experiment ?? "",
    open_intents: open,
    budget_spent: {
      tokens: input.tokens,
      toolCalls: input.toolCalls,
      wallMs: input.wallMs ?? 0,
    },
  });

  const slot = manifest.workerSlot ?? 0;
  const dir = relayDir(manifest.workspaceDir, slot);
  mkdirSync(dir, { recursive: true });
  const path = relayPath(manifest.workspaceDir, protocol.generation, slot);
  writeFileSync(path, JSON.stringify(protocol, null, 2));
  return protocol;
}

export function relayTokenThreshold(manifest: WorkerManifest): number {
  const raw = process.env.GY_RELAY_TOKEN_THRESHOLD;
  if (raw != null && raw !== "") {
    const env = Number(raw);
    if (Number.isFinite(env) && env > 0) return env;
  }
  return manifest.budget.relayTokenThreshold ?? 30_000;
}

export function relayMinToolCalls(manifest: WorkerManifest): number {
  const raw = process.env.GY_RELAY_MIN_TOOL_CALLS;
  if (raw != null && raw !== "") {
    const env = Number(raw);
    if (Number.isFinite(env) && env >= 0) return env;
  }
  return manifest.budget.relayMinToolCalls ?? 2;
}

/**
 * Guarded relay eligibility. Watchdog must never call this — crash ≠ relay.
 */
export function canRelay(opts: {
  manifest: WorkerManifest;
  tokensSinceRelay: number;
  toolCallsSinceRelay: number;
  forceAgent: boolean;
}): { ok: true; trigger: "auto" | "agent" } | { ok: false; reason: string } {
  if (process.env.GY_DIFF_NO_RELAY === "1") return { ok: false, reason: "Relay disabled for differential control" };
  const minTools = relayMinToolCalls(opts.manifest);
  if (opts.toolCallsSinceRelay < minTools) {
    return {
      ok: false,
      reason: `relay guard: need ≥${minTools} tool calls since last π (have ${opts.toolCallsSinceRelay})`,
    };
  }
  if (opts.forceAgent) return { ok: true, trigger: "agent" };
  const threshold = relayTokenThreshold(opts.manifest);
  if (opts.tokensSinceRelay >= threshold) return { ok: true, trigger: "auto" };
  return {
    ok: false,
    reason: `below token threshold (${opts.tokensSinceRelay}/${threshold})`,
  };
}

/** Synthesize a grounded Relay summary from History when auto-relay triggers without an explicit agent summary. */
export function synthesizeGroundedRelayFields(
  history: HistoryStore,
  taskId: string,
  activeIntentId: string | null,
): {
  current_position: string;
  network_map: string;
  tried: string;
  foothold: string;
  unexplored_surface: string;
  confirmed_architecture_and_decoys: string;
  falsified_hypotheses: string;
  workspace_artifacts: string;
  live_footholds: string;
  next_falsifiable_experiment: string;
} {
  const assets = history.listAssets(taskId);
  const liveOrAdmitted = assets.filter((a) => a.kind === "live" || a.kind === "admitted");
  const allFacts = history.listFacts(taskId);
  const recentFacts = allFacts.slice(-8);
  const intents = history.listIntents(taskId);
  const recentDone = intents
    .filter((i) => i.status === "succeeded" || i.status === "failed")
    .slice(-5);
  const open = intents.filter((i) => ["proposed", "claimed", "running"].includes(i.status));
  const profiles = history.listHostProfiles(taskId);
  const creds = history.listCredentials(taskId);
  const activeIntent = activeIntentId ? history.getIntent(taskId, activeIntentId) : null;

  const current_position = activeIntentId
    ? `activeIntent=${activeIntentId}`
    : open.length > 0
      ? `openIntents=${open.length}`
      : "awaiting Reason";
  const network_map = liveOrAdmitted
    .slice(0, 10)
    .map((a) => `${a.address}(${a.kind})`)
    .join(", ") || "see History asset_list";
  const tried = recentDone
    .map((i) => `${i.title}:${i.status}`)
    .join("; ") || recentFacts.map((f) => f.title).slice(-4).join("; ") || "—";
  const footholdParts: string[] = [];
  if (profiles.length > 0) {
    footholdParts.push(
      ...profiles.slice(0, 3).map((p) => `${p.asset}(${p.privileges.join("/") || p.os || "host"})`),
    );
  }
  if (creds.length > 0) {
    footholdParts.push(`creds=${creds.length}(see credential_list)`);
  }
  const foothold = footholdParts.join("; ") || "see History transferable/findings";
  const unexplored_surface = open
    .slice(0, 6)
    .map((i) => i.title)
    .join("; ") || "unfinished goals in History observe";

  const lessons = activeIntent?.assetRoot
    ? history.recallTacticalLessons(taskId, {
        assetRoot: activeIntent.assetRoot,
        techTags: activeIntent.technique ? [activeIntent.technique] : [],
      })
    : { exactAssetLessons: [], siblingFamilyLessons: [] };

  const architecture = profiles
    .slice(0, 4)
    .map(
      (p) =>
        `${p.asset}: os=${p.os ?? "?"} domain=${p.domain ?? "?"} svc=${p.services.length} share=${p.shares.length}`,
    )
    .join("; ");
  const decoyJudgements = recentDone
    .filter((i) =>
      /(诱饵|decoy|死分支|dead\s*end|伪分支|不参与校验)/i.test(i.conclusion ?? ""),
    )
    .map((i) => `${i.title}: ${(i.conclusion ?? "").slice(0, 120)}`);
  const confirmed_architecture_and_decoys =
    [architecture, decoyJudgements.length ? `死分支/诱饵: ${decoyJudgements.join("; ")}` : ""]
      .filter(Boolean)
      .join(" | ");

  const falsifiedParts: string[] = [];
  for (const lesson of lessons.exactAssetLessons.slice(0, 3)) {
    for (const falsified of lesson.falsifiedHypotheses.slice(0, 2)) {
      falsifiedParts.push(
        `${falsified.hypothesis.slice(0, 100)} → ${falsified.resultSummary.slice(0, 120)}（证据: ${falsified.commandEvidence.slice(0, 100)}）`,
      );
    }
  }
  if (falsifiedParts.length === 0) {
    for (const intent of recentDone.filter((i) => i.status === "failed").slice(-3)) {
      falsifiedParts.push(`${intent.title} → ${(intent.conclusion ?? "").slice(0, 140)}`);
    }
  }
  const falsified_hypotheses = falsifiedParts.join("; ");

  const workspace_artifacts = allFacts
    .filter((f) => Boolean(f.evidencePath))
    .slice(-6)
    .map((f) => `${f.evidencePath} (${f.title.slice(0, 60)})`)
    .join("; ");

  const liveParts: string[] = [];
  for (const profile of profiles.slice(0, 3)) {
    liveParts.push(
      `${profile.asset} users=${profile.users.length} priv=${profile.privileges.join("/") || "-"}`,
    );
  }
  if (creds.length > 0) {
    liveParts.push(`creds=${creds.slice(0, 6).map((c) => `${c.id}@${c.asset}`).join(",")}`);
  }
  liveParts.push("转发端口: tunnel_list");
  const live_footholds = liveParts.join("; ");

  const pivotLesson = lessons.exactAssetLessons.find((lesson) => Boolean(lesson.nextPivotAdvice));
  const next_falsifiable_experiment = open.length
    ? `验证「${open[0]!.title.slice(0, 120)}」`
    : pivotLesson?.nextPivotAdvice.slice(0, 160) ?? "";

  return {
    current_position,
    network_map,
    tried,
    foothold,
    unexplored_surface,
    confirmed_architecture_and_decoys,
    falsified_hypotheses,
    workspace_artifacts,
    live_footholds,
    next_falsifiable_experiment,
  };
}

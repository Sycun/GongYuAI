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
  tokens: number;
  toolCalls: number;
  wallMs?: number;
  /** Next generation index (0-based file π{n}). */
  generation: number;
};

export function relayDir(workspaceDir: string): string {
  return join(workspaceDir, "relay");
}

export function relayPath(workspaceDir: string, generation: number): string {
  return join(relayDir(workspaceDir), `π${generation}.json`);
}

export function listRelayProtocols(workspaceDir: string): RelayProtocol[] {
  const dir = relayDir(workspaceDir);
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
    open_intents: open,
    budget_spent: {
      tokens: input.tokens,
      toolCalls: input.toolCalls,
      wallMs: input.wallMs ?? 0,
    },
  });

  const dir = relayDir(manifest.workspaceDir);
  mkdirSync(dir, { recursive: true });
  const path = relayPath(manifest.workspaceDir, protocol.generation);
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

/**
 * Hard mid-submission relay reset is OPT-IN and OFF by default. The live Pi session is never
 * reset (long context is handled by pi-durable native compaction); forcing the model to stop
 * every 2 tool calls to write a handoff was the 2026-11-25 token-cost regression root cause.
 */
export function relayHardResetEnabled(): boolean {
  return process.env.GY_RELAY_HARD_RESET === "1";
}

/**
 * beforeTool gate for the mid-submission relay interruption. Returns a block ONLY in explicit
 * hard-reset mode; in the default live-session mode it never interrupts tool calls.
 */
export function midSubmissionRelayGate(opts: {
  hardReset: boolean;
  relayPending: boolean;
  toolName: string;
}): { block: string } | undefined {
  if (!opts.hardReset) return undefined;
  if (opts.relayPending && opts.toolName !== "relay" && opts.toolName !== "intent_conclude") {
    return {
      block:
        "Session Relay 阈值已触发（硬重置模式）：请停止调用新工具并输出简短交接摘要，系统将落盘 π。",
    };
  }
  return undefined;
}

/** Default step interval between silent background π audit snapshots (not a handoff, never resets). */
export const DEFAULT_RELAY_SNAPSHOT_STEP_INTERVAL = 250;

export function relaySnapshotStepInterval(): number {
  const raw = process.env.GY_RELAY_SNAPSHOT_STEP_INTERVAL;
  if (raw != null && raw !== "") {
    const n = Number(raw);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return DEFAULT_RELAY_SNAPSHOT_STEP_INTERVAL;
}

/**
 * Step-paced silent background π snapshot eligibility. Decoupled from the 30k prompt-token
 * cadence so a 6h run writes a handful of audit artifacts instead of 600+ redundant π files.
 * Never interrupts the current submission; the live session is kept.
 */
export function shouldSnapshotRelay(opts: {
  manifest: WorkerManifest;
  step: number;
  lastSnapshotStep: number;
  toolCallsSinceRelay: number;
}): boolean {
  if (process.env.GY_DIFF_NO_RELAY === "1") return false;
  if (opts.step - opts.lastSnapshotStep < relaySnapshotStepInterval()) return false;
  if (opts.toolCallsSinceRelay < relayMinToolCalls(opts.manifest)) return false;
  return true;
}

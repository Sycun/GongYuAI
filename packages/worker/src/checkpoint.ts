import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { WorkerPhase } from "@gongyuai/contracts";

export type CheckpointState = {
  phase: WorkerPhase;
  step: number;
  /** Persisted Pi continue-round counter; survives restart so requestId never replays a committed round. */
  round: number;
  /** Monotonic worker boot epoch (bumped once per process); keeps requestId unique across pause/resume. */
  bootEpoch: number;
  toolCalls: number;
  installs: number;
  tokens: number;
  /** Session Relay generation; next π index to write. */
  relayGeneration: number;
  /** step index when the last background π audit snapshot was written (step-paced, not token-paced). */
  lastRelaySnapshotStep: number;
  /** Tokens accumulated since last successful relay (auto trigger). */
  tokensSinceRelay: number;
  /** Tool calls since last successful relay (min-interval guard). */
  toolCallsSinceRelay: number;
  /** Currently claimed Explore intent (at most one). */
  activeIntentId: string | null;
  /** ISO time when activeIntentId was claimed (Explore wall timeout). */
  activeIntentClaimedAt: string | null;
  /** Soft pace: last tool-call milestone advised (never stops the run). */
  lastSoftToolMilestone: number;
  /** Soft pace: last wall-index advised (never stops the run). */
  lastSoftWallMilestone: number;
  /** toolCalls snapshot when active Intent was claimed (surface rotation). */
  toolsAtIntentClaim: number | null;
  /** Soft pace: last tools-since-claim milestone advised for current Intent. */
  lastSoftSurfaceMilestone: number;
  /** Advisory text waiting to inject on next model turn (Pi afterTools). */
  pendingSoftPaceMessage: string | null;
  /** Fingerprint of the last Observe entities injected into the live session; enables incremental resume deltas. */
  observeFingerprint: Record<string, string>;
  /** Active Intent currently inside the post-stall Soft Drain grace window. */
  drainIntentId?: string | null;
  /** Remaining tool turns in Soft Drain before hard force-conclude. */
  drainStepsRemaining?: number | null;
  /** Overwritable scratch draft (`fact_draft`), auto-rescued on timeout or conclude. */
  factDraft?: {
    title: string;
    summary: string;
    evidencePath?: string;
    updatedAt: string;
  } | null;
  lastError: string | null;
  updatedAt: string;
};

const DEFAULT: CheckpointState = {
  phase: "init",
  step: 0,
  round: 0,
  bootEpoch: 0,
  toolCalls: 0,
  installs: 0,
  tokens: 0,
  relayGeneration: 0,
  lastRelaySnapshotStep: 0,
  tokensSinceRelay: 0,
  toolCallsSinceRelay: 0,
  activeIntentId: null,
  activeIntentClaimedAt: null,
  lastSoftToolMilestone: 0,
  lastSoftWallMilestone: 0,
  toolsAtIntentClaim: null,
  lastSoftSurfaceMilestone: 0,
  pendingSoftPaceMessage: null,
  observeFingerprint: {},
  drainIntentId: null,
  drainStepsRemaining: null,
  factDraft: null,
  lastError: null,
  updatedAt: new Date().toISOString(),
};

/** Process-local durable checkpoint (survives worker restart). */
export class CheckpointStore {
  private readonly db: DatabaseSync;

  constructor(dbPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    // WAL so control-plane can read usage while the worker holds the writer.
    this.db.exec(`PRAGMA journal_mode = WAL;`);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS checkpoint (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        json TEXT NOT NULL
      );
    `);
  }

  load(): CheckpointState {
    const row = this.db.prepare(`SELECT json FROM checkpoint WHERE id = 1`).get() as
      | { json: string }
      | undefined;
    if (!row) return { ...DEFAULT, updatedAt: new Date().toISOString() };
    const parsed = JSON.parse(row.json) as Partial<CheckpointState>;
    // Map legacy "loop" into explore for graph-driven scheduling.
    let phase = parsed.phase ?? DEFAULT.phase;
    if (phase === "loop") phase = "explore";
    return {
      ...DEFAULT,
      ...parsed,
      phase,
      round: parsed.round ?? 0,
      bootEpoch: parsed.bootEpoch ?? 0,
      relayGeneration: parsed.relayGeneration ?? 0,
      lastRelaySnapshotStep: parsed.lastRelaySnapshotStep ?? 0,
      tokensSinceRelay: parsed.tokensSinceRelay ?? parsed.tokens ?? 0,
      toolCallsSinceRelay: parsed.toolCallsSinceRelay ?? 0,
      activeIntentId: parsed.activeIntentId ?? null,
      activeIntentClaimedAt: parsed.activeIntentClaimedAt ?? null,
      lastSoftToolMilestone: parsed.lastSoftToolMilestone ?? 0,
      lastSoftWallMilestone: parsed.lastSoftWallMilestone ?? 0,
      toolsAtIntentClaim: parsed.toolsAtIntentClaim ?? null,
      lastSoftSurfaceMilestone: parsed.lastSoftSurfaceMilestone ?? 0,
      pendingSoftPaceMessage: parsed.pendingSoftPaceMessage ?? null,
      observeFingerprint: parsed.observeFingerprint ?? {},
      drainIntentId: parsed.drainIntentId ?? null,
      drainStepsRemaining: parsed.drainStepsRemaining ?? null,
      factDraft: parsed.factDraft ?? null,
    };
  }

  save(state: CheckpointState): void {
    state.updatedAt = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO checkpoint (id, json) VALUES (1, ?)
         ON CONFLICT(id) DO UPDATE SET json = excluded.json`,
      )
      .run(JSON.stringify(state));
  }

  close(): void {
    this.db.close();
  }
}

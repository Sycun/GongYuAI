import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { WorkerPhase } from "@gongyuai/contracts";

export type CheckpointState = {
  phase: WorkerPhase;
  step: number;
  toolCalls: number;
  installs: number;
  tokens: number;
  /** Session Relay generation; next π index to write. */
  relayGeneration: number;
  /** Tokens accumulated since last successful relay (auto trigger). */
  tokensSinceRelay: number;
  /** Tool calls since last successful relay (min-interval guard). */
  toolCallsSinceRelay: number;
  /** Currently claimed Explore intent (at most one). */
  activeIntentId: string | null;
  /** Soft pace: last tool-call milestone advised (never stops the run). */
  lastSoftToolMilestone: number;
  /** Soft pace: last wall-index advised (never stops the run). */
  lastSoftWallMilestone: number;
  lastError: string | null;
  updatedAt: string;
};

const DEFAULT: CheckpointState = {
  phase: "init",
  step: 0,
  toolCalls: 0,
  installs: 0,
  tokens: 0,
  relayGeneration: 0,
  tokensSinceRelay: 0,
  toolCallsSinceRelay: 0,
  activeIntentId: null,
  lastSoftToolMilestone: 0,
  lastSoftWallMilestone: 0,
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
      relayGeneration: parsed.relayGeneration ?? 0,
      tokensSinceRelay: parsed.tokensSinceRelay ?? parsed.tokens ?? 0,
      toolCallsSinceRelay: parsed.toolCallsSinceRelay ?? 0,
      activeIntentId: parsed.activeIntentId ?? null,
      lastSoftToolMilestone: parsed.lastSoftToolMilestone ?? 0,
      lastSoftWallMilestone: parsed.lastSoftWallMilestone ?? 0,
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

import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

export type CheckpointState = {
  phase: "init" | "loop" | "report" | "done";
  step: number;
  toolCalls: number;
  installs: number;
  tokens: number;
  lastError: string | null;
  updatedAt: string;
};

const DEFAULT: CheckpointState = {
  phase: "init",
  step: 0,
  toolCalls: 0,
  installs: 0,
  tokens: 0,
  lastError: null,
  updatedAt: new Date().toISOString(),
};

/** Process-local durable checkpoint (survives worker restart). */
export class CheckpointStore {
  private readonly db: DatabaseSync;

  constructor(dbPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
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
    return { ...DEFAULT, ...(JSON.parse(row.json) as CheckpointState) };
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

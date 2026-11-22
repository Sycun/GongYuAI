import { existsSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { ExecutionStep, ExecutionTracePage, ShellTraceCall } from "@gongyuai/contracts";

const PAGE_SIZE = 40;

function tracePath(dataDir: string): string {
  return join(dataDir, "execution-trace.sqlite");
}

export function saveExecutionStep(
  dataDir: string,
  step: Omit<ExecutionStep, "shellCallCount">,
  calls: ShellTraceCall[],
): { inserted: boolean; number: number } {
  const db = new DatabaseSync(tracePath(dataDir));
  try {
    db.exec(`
      PRAGMA busy_timeout = 5000;
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS steps (
        seq INTEGER PRIMARY KEY,
        id TEXT UNIQUE NOT NULL,
        summary TEXT NOT NULL,
        shell_calls TEXT NOT NULL
      );
    `);
    const summary: ExecutionStep = { ...step, shellCallCount: calls.length };
    const { changes } = db
      .prepare(`INSERT INTO steps (id, summary, shell_calls) VALUES (?, ?, ?)
                ON CONFLICT(id) DO NOTHING`)
      .run(step.id, JSON.stringify(summary), JSON.stringify(calls));
    if (changes !== 0) return { inserted: true, number: step.number };
    const row = db.prepare("SELECT summary FROM steps WHERE id = ?").get(step.id)!;
    return { inserted: false, number: (JSON.parse(row.summary as string) as ExecutionStep).number };
  } finally {
    db.close();
  }
}

function readTrace<T>(dataDir: string, empty: T, read: (db: DatabaseSync) => T): T {
  const path = tracePath(dataDir);
  if (!existsSync(path)) return empty;
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    db.exec("PRAGMA busy_timeout = 2000;");
    // A worker may have created the file but not committed its schema yet.
    if (!db.prepare("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'steps'").get()) {
      return empty;
    }
    return read(db);
  } finally {
    db.close();
  }
}

export function listExecutionSteps(dataDir: string, before?: number): ExecutionTracePage {
  return readTrace<ExecutionTracePage>(dataDir, { steps: [], nextBefore: null }, (db) => {
    const limit = PAGE_SIZE + 1;
    const rows = (before === undefined
      ? db.prepare("SELECT seq, summary FROM steps ORDER BY seq DESC LIMIT ?").all(limit)
      : db.prepare("SELECT seq, summary FROM steps WHERE seq < ? ORDER BY seq DESC LIMIT ?").all(before, limit)
    ) as { seq: number; summary: string }[];
    const page = rows.slice(0, PAGE_SIZE);
    return {
      steps: page.map((row) => JSON.parse(row.summary) as ExecutionStep),
      nextBefore: rows.length > PAGE_SIZE ? page[page.length - 1]!.seq : null,
    };
  });
}

export function readExecutionStepCalls(dataDir: string, stepId: string): ShellTraceCall[] | null {
  return readTrace<ShellTraceCall[] | null>(dataDir, null, (db) => {
    const row = db.prepare("SELECT shell_calls FROM steps WHERE id = ?").get(stepId);
    return row ? JSON.parse(row.shell_calls as string) as ShellTraceCall[] : null;
  });
}

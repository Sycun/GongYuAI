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

export type ExecutionTraceHit = {
  seq: number;
  stepId: string;
  callId: string;
  workerSlot: number;
  stepNumber: number;
  at: string;
  exitCode: number | null;
  durationMs: number | null;
  commandPreview: string | null;
  resultPreview: string | null;
  totalCommandChars: number;
  totalResultChars: number;
};

export type ExecutionTraceSearchPage = {
  hits: ExecutionTraceHit[];
  nextBeforeSeq: number | null;
  hasMore: boolean;
};

export type ExecutionTraceCallContent = {
  stepId: string;
  callId: string;
  part: "command" | "result";
  offset: number;
  nextOffset: number;
  totalChars: number;
  hasMore: boolean;
  exitCode: number | null;
  text: string;
};

function extractMatchSnippet(text: string | null | undefined, needleLower: string, radius = 1_600): string | null {
  if (!text) return null;
  const idx = text.toLowerCase().indexOf(needleLower);
  if (idx < 0) return null;
  const start = Math.max(0, idx - Math.floor(radius / 2));
  const end = Math.min(text.length, idx + needleLower.length + Math.ceil(radius / 2));
  const prefix = start > 0 ? "…" : "";
  const suffix = end < text.length ? "…" : "";
  return `${prefix}${text.slice(start, end)}${suffix}`;
}

/**
 * Search persisted shell commands and raw outputs across all worker slots in this task
 * (inspired by nectar `execution_trace_search`). Newest steps first.
 */
export function searchExecutionTrace(
  dataDir: string,
  opts: {
    query: string;
    limit?: number;
    beforeSeq?: number;
    excludeStepId?: string;
  },
): ExecutionTraceSearchPage {
  const query = (opts.query ?? "").trim();
  if (!query) return { hits: [], nextBeforeSeq: null, hasMore: false };
  const needle = query.toLowerCase();
  const limit = Math.max(1, Math.min(20, Math.floor(opts.limit ?? 10) || 10));

  return readTrace<ExecutionTraceSearchPage>(
    dataDir,
    { hits: [], nextBeforeSeq: null, hasMore: false },
    (db) => {
      const hits: ExecutionTraceHit[] = [];
      let cursorSeq = opts.beforeSeq;
      const batchSize = 100;

      for (;;) {
        const rows = (
          cursorSeq === undefined
            ? db
                .prepare("SELECT seq, id, summary, shell_calls FROM steps ORDER BY seq DESC LIMIT ?")
                .all(batchSize)
            : db
                .prepare("SELECT seq, id, summary, shell_calls FROM steps WHERE seq < ? ORDER BY seq DESC LIMIT ?")
                .all(cursorSeq, batchSize)
        ) as Array<{ seq: number; id: string; summary: string; shell_calls: string }>;

        if (rows.length === 0) {
          return { hits, nextBeforeSeq: null, hasMore: false };
        }

        for (const row of rows) {
          cursorSeq = row.seq;
          if (opts.excludeStepId && row.id === opts.excludeStepId) continue;
          let stepMeta: ExecutionStep;
          let calls: ShellTraceCall[];
          try {
            stepMeta = JSON.parse(row.summary) as ExecutionStep;
            calls = JSON.parse(row.shell_calls) as ShellTraceCall[];
          } catch {
            continue;
          }
          if (!Array.isArray(calls) || calls.length === 0) continue;
          for (const call of calls) {
            const cmdPreview = extractMatchSnippet(call.command, needle);
            const resPreview = extractMatchSnippet(call.result, needle);
            if (!cmdPreview && !resPreview) continue;
            if (hits.length >= limit) {
              return {
                hits,
                nextBeforeSeq: hits[hits.length - 1]!.seq,
                hasMore: true,
              };
            }
            hits.push({
              seq: row.seq,
              stepId: row.id,
              callId: call.id,
              workerSlot: stepMeta.workerSlot ?? 0,
              stepNumber: stepMeta.number,
              at: stepMeta.at,
              exitCode: call.exitCode ?? null,
              durationMs: call.durationMs ?? null,
              commandPreview: cmdPreview ?? (call.command ? call.command.slice(0, 240) : null),
              resultPreview: resPreview,
              totalCommandChars: Array.from(call.command ?? "").length,
              totalResultChars: Array.from(call.result ?? "").length,
            });
          }
        }

        if (rows.length < batchSize) {
          return { hits, nextBeforeSeq: null, hasMore: false };
        }
      }
    },
  );
}

/**
 * Read paged Unicode character slices of a specific shell trace call's command or output
 * (inspired by nectar `execution_trace_content`).
 */
export function readExecutionTraceCallContent(
  dataDir: string,
  opts: {
    stepId: string;
    callId?: string;
    part?: "command" | "result";
    offset?: number;
    limit?: number;
  },
): ExecutionTraceCallContent | null {
  const stepId = (opts.stepId ?? "").trim();
  if (!stepId) return null;
  const part: "command" | "result" = opts.part === "command" ? "command" : "result";
  const offset = Math.max(0, Math.floor(opts.offset ?? 0) || 0);
  const limit = Math.max(1, Math.min(32_000, Math.floor(opts.limit ?? 8_000) || 8_000));

  return readTrace<ExecutionTraceCallContent | null>(dataDir, null, (db) => {
    const row = db.prepare("SELECT shell_calls FROM steps WHERE id = ?").get(stepId) as
      | { shell_calls: string }
      | undefined;
    if (!row) return null;
    let calls: ShellTraceCall[];
    try {
      calls = JSON.parse(row.shell_calls) as ShellTraceCall[];
    } catch {
      return null;
    }
    if (!Array.isArray(calls) || calls.length === 0) return null;
    const call = opts.callId
      ? calls.find((c) => c.id === opts.callId)
      : calls[0];
    if (!call) return null;
    const raw = part === "command" ? (call.command ?? "") : (call.result ?? "");
    const chars = Array.from(raw);
    const totalChars = chars.length;
    const clampedOffset = Math.min(offset, totalChars);
    const slice = chars.slice(clampedOffset, clampedOffset + limit).join("");
    const nextOffset = clampedOffset + Array.from(slice).length;
    return {
      stepId,
      callId: call.id,
      part,
      offset: clampedOffset,
      nextOffset,
      totalChars,
      hasMore: nextOffset < totalChars,
      exitCode: call.exitCode ?? null,
      text: slice,
    };
  });
}

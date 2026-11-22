import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { TaskRecord } from "@gongyuai/contracts";
import { taskPaths } from "./paths.js";

export type UsageCounters = {
  tokens: number;
  toolCalls: number;
  installs: number;
};

type UsageSlice = Partial<UsageCounters>;

const emptyUsage: UsageCounters = { tokens: 0, toolCalls: 0, installs: 0 };

function counter(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

function maxUsage(a: UsageCounters, b: UsageSlice | null | undefined): UsageCounters {
  return {
    tokens: Math.max(counter(a.tokens), counter(b?.tokens)),
    toolCalls: Math.max(counter(a.toolCalls), counter(b?.toolCalls)),
    installs: Math.max(counter(a.installs), counter(b?.installs)),
  };
}

function readWorkerStatusUsage(path: string): UsageSlice | null {
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as { usage?: UsageSlice };
    return raw?.usage ?? null;
  } catch {
    return null;
  }
}

function readCheckpointJson(ckptPath: string): Record<string, unknown> | null {
  if (!existsSync(ckptPath)) return null;
  try {
    const db = new DatabaseSync(ckptPath, { readOnly: true });
    try {
      const row = db
        .prepare(`SELECT json FROM checkpoint WHERE id = 1`)
        .get() as { json: string } | undefined;
      if (!row) return null;
      return JSON.parse(row.json) as Record<string, unknown>;
    } finally {
      db.close();
    }
  } catch {
    // Writer may hold a brief exclusive lock (non-WAL). Best-effort.
    return null;
  }
}

/** Graph phase + active Intent from Durable checkpoint (Mission Control Live). */
export function readCheckpointGraph(dataDir: string): {
  phase: string | null;
  activeIntentId: string | null;
} {
  const raw = readCheckpointJson(`${taskPaths(dataDir).durableDb}.ckpt.sqlite`);
  if (!raw) return { phase: null, activeIntentId: null };
  return {
    phase: typeof raw.phase === "string" ? raw.phase : null,
    activeIntentId:
      typeof raw.activeIntentId === "string" ? raw.activeIntentId : null,
  };
}

/** Merge each slot's two snapshots, then add the independent slot totals. */
export function mergeUsageFromDisk(
  dataDir: string,
  current: UsageCounters,
): UsageCounters {
  let files: string[];
  try {
    files = readdirSync(dataDir);
  } catch {
    return current;
  }
  const slots = new Map<number, UsageCounters>();
  for (const name of files) {
    const status = /^worker-status(?:-w(\d+))?\.json$/.exec(name);
    const checkpoint = /^durable(?:-w(\d+))?\.sqlite\.ckpt\.sqlite$/.exec(name);
    const match = status ?? checkpoint;
    if (!match) continue;
    const slot = Number(match[1] ?? 0);
    const path = join(dataDir, name);
    const usage = status ? readWorkerStatusUsage(path) : readCheckpointJson(path);
    slots.set(slot, maxUsage(slots.get(slot) ?? emptyUsage, usage));
  }

  const total = { ...emptyUsage };
  for (const slot of slots.values()) {
    total.tokens += slot.tokens;
    total.toolCalls += slot.toolCalls;
    total.installs += slot.installs;
  }
  return maxUsage(current, total);
}

/** Refresh and persist usage on a task record when counters advanced. */
export function refreshTaskUsage(task: TaskRecord): UsageCounters {
  const merged = mergeUsageFromDisk(task.dataDir, task.usage);
  task.usage = merged;
  return merged;
}

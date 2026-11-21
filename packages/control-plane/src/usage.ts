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

type UsageSlice = {
  tokens?: number;
  toolCalls?: number;
  installs?: number;
};

function maxUsage(a: UsageCounters, b: UsageSlice | null | undefined): UsageCounters {
  return {
    tokens: Math.max(a.tokens, b?.tokens ?? 0),
    toolCalls: Math.max(a.toolCalls, b?.toolCalls ?? 0),
    installs: Math.max(a.installs, b?.installs ?? 0),
  };
}

function readWorkerStatusUsage(dataDir: string): UsageSlice | null {
  const files: string[] = [];
  try {
    for (const name of readdirSync(dataDir)) {
      if (/^worker-status(-w\d+)?\.json$/.test(name)) {
        files.push(join(dataDir, name));
      }
    }
  } catch {
    /* empty */
  }
  const legacy = join(dataDir, "worker-status.json");
  if (!files.length && existsSync(legacy)) files.push(legacy);
  if (!files.length) return null;

  let out: UsageCounters = { tokens: 0, toolCalls: 0, installs: 0 };
  for (const path of files) {
    try {
      const raw = JSON.parse(readFileSync(path, "utf8")) as { usage?: UsageSlice };
      out = maxUsage(out, raw.usage);
    } catch {
      /* ignore corrupt */
    }
  }
  return out;
}

function readCheckpointJson(dataDir: string): Record<string, unknown> | null {
  const paths = taskPaths(dataDir);
  const ckptPath = `${paths.durableDb}.ckpt.sqlite`;
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

function readCheckpointUsage(dataDir: string): UsageSlice | null {
  return readCheckpointJson(dataDir) as UsageSlice | null;
}

/** Graph phase + active Intent from Durable checkpoint (Mission Control Live). */
export function readCheckpointGraph(dataDir: string): {
  phase: string | null;
  activeIntentId: string | null;
} {
  const raw = readCheckpointJson(dataDir);
  if (!raw) return { phase: null, activeIntentId: null };
  return {
    phase: typeof raw.phase === "string" ? raw.phase : null,
    activeIntentId:
      typeof raw.activeIntentId === "string" ? raw.activeIntentId : null,
  };
}

/** Merge task.usage with on-disk worker-status + durable checkpoint. */
export function mergeUsageFromDisk(
  dataDir: string,
  current: UsageCounters,
): UsageCounters {
  let merged = { ...current };
  merged = maxUsage(merged, readWorkerStatusUsage(dataDir));
  merged = maxUsage(merged, readCheckpointUsage(dataDir));
  return merged;
}

/** Refresh and persist usage on a task record when counters advanced. */
export function refreshTaskUsage(task: TaskRecord): UsageCounters {
  const merged = mergeUsageFromDisk(task.dataDir, task.usage);
  task.usage = merged;
  return merged;
}

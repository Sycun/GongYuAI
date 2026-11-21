import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export type WorkerStatusFile = {
  status: "running" | "completed" | "failed" | "budget_exhausted" | "incomplete";
  error?: string;
  usage: { tokens: number; toolCalls: number; installs: number };
  workerSlot?: number;
  workerId?: string;
  /** Graph phase for Mission Control Live. */
  phase?: string;
  activeIntentId?: string | null;
  updatedAt?: string;
};

export function workerStatusPath(dataDir: string, slot = 0): string {
  if (slot <= 0) return join(dataDir, "worker-status.json");
  return join(dataDir, `worker-status-w${slot}.json`);
}

export function writeWorkerStatus(
  dataDir: string,
  status: WorkerStatusFile,
  slot = 0,
): void {
  const payload = {
    ...status,
    workerSlot: status.workerSlot ?? slot,
    updatedAt: new Date().toISOString(),
  };
  writeFileSync(workerStatusPath(dataDir, slot), JSON.stringify(payload, null, 2));
  // Leader also owns the legacy aggregate path used by Watchdog / console.
  if (slot === 0) {
    writeFileSync(join(dataDir, "worker-status.json"), JSON.stringify(payload, null, 2));
  }
}

/** Sum usage across slot status files; prefer terminal status from leader / any failure. */
export function readAggregatedWorkerStatus(
  dataDir: string,
): WorkerStatusFile | null {
  const files: string[] = [];
  try {
    for (const name of readdirSync(dataDir)) {
      if (/^worker-status(-w\d+)?\.json$/.test(name)) {
        files.push(join(dataDir, name));
      }
    }
  } catch {
    return null;
  }
  if (!files.length) {
    const legacy = join(dataDir, "worker-status.json");
    if (existsSync(legacy)) files.push(legacy);
  }
  if (!files.length) return null;

  let tokens = 0;
  let toolCalls = 0;
  let installs = 0;
  let status: WorkerStatusFile["status"] = "running";
  let error: string | undefined;
  let sawTerminal = false;

  for (const path of files) {
    try {
      const raw = JSON.parse(readFileSync(path, "utf8")) as WorkerStatusFile;
      tokens = Math.max(tokens, raw.usage?.tokens ?? 0);
      toolCalls += raw.usage?.toolCalls ?? 0;
      installs += raw.usage?.installs ?? 0;
      if (raw.status === "failed") {
        status = "failed";
        error = raw.error ?? error;
        sawTerminal = true;
      } else if (raw.status === "budget_exhausted" && status !== "failed") {
        status = "budget_exhausted";
        error = raw.error ?? error;
        sawTerminal = true;
      } else if (raw.status === "incomplete" && !sawTerminal) {
        status = "incomplete";
        error = raw.error ?? error;
        sawTerminal = true;
      } else if (raw.status === "completed" && !sawTerminal) {
        status = "completed";
        sawTerminal = true;
      }
    } catch {
      /* ignore corrupt */
    }
  }

  return {
    status,
    error,
    usage: { tokens, toolCalls, installs },
  };
}

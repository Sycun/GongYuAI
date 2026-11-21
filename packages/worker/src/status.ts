import { writeFileSync } from "node:fs";
import { join } from "node:path";

export type WorkerStatusFile = {
  status: "running" | "completed" | "failed" | "budget_exhausted";
  error?: string;
  usage: { tokens: number; toolCalls: number; installs: number };
  updatedAt?: string;
};

export function writeWorkerStatus(dataDir: string, status: WorkerStatusFile): void {
  writeFileSync(
    join(dataDir, "worker-status.json"),
    JSON.stringify({ ...status, updatedAt: new Date().toISOString() }, null, 2),
  );
}

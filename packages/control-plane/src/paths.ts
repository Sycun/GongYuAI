import { join } from "node:path";

export function taskDataDir(root: string, taskId: string): string {
  return join(root, "tasks", taskId);
}

/** Per-Explore-slot Durable DB; slot 0 keeps legacy `durable.sqlite` path. */
export function durableDbForSlot(dataDir: string, slot: number): string {
  if (slot <= 0) return join(dataDir, "durable.sqlite");
  return join(dataDir, `durable-w${slot}.sqlite`);
}

export function manifestPathForSlot(dataDir: string, slot: number): string {
  if (slot <= 0) return join(dataDir, "manifest.json");
  return join(dataDir, `manifest-w${slot}.json`);
}

export function taskPaths(dataDir: string) {
  return {
    dataDir,
    historyDb: join(dataDir, "history.sqlite"),
    durableDb: join(dataDir, "durable.sqlite"),
    evidenceDir: join(dataDir, "evidence"),
    workspaceDir: join(dataDir, "workspace"),
    manifestPath: join(dataDir, "manifest.json"),
    reportPath: join(dataDir, "report.md"),
    progressPath: join(dataDir, "workspace", "PROGRESS.md"),
    metaDb: join(dataDir, "..", "..", "control.sqlite"),
  };
}

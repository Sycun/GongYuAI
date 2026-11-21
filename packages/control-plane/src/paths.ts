import { join } from "node:path";

export function taskDataDir(root: string, taskId: string): string {
  return join(root, "tasks", taskId);
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

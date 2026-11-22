import { existsSync } from "node:fs";
import type { IntegrationRow, ProjectIntegrationUsage, TaskRecord } from "@gongyuai/contracts";
import { openHistory } from "@gongyuai/history";
import { taskPaths } from "./paths.js";

export function projectIntegrationUsage(tasks: TaskRecord[]): ProjectIntegrationUsage {
  const combined = new Map<string, IntegrationRow>();
  let tracked = 0;
  let unreadable = 0;
  for (const task of tasks) {
    const paths = taskPaths(task.dataDir);
    if (!existsSync(paths.historyDb)) continue;
    try {
      const history = openHistory({ dbPath: paths.historyDb, evidenceDir: paths.evidenceDir, readOnly: true });
      try {
        const usage = history.integrationUsage(task.id);
        if (usage.since === null) continue;
        tracked++;
        for (const row of usage.rows) {
          const key = JSON.stringify([row.kind, row.name, row.method]);
          const entry = combined.get(key);
          if (entry) {
            entry.calls += row.calls;
            entry.succeeded += row.succeeded;
            entry.failed += row.failed;
          } else {
            combined.set(key, row);
          }
        }
      } finally {
        history.close();
      }
    } catch {
      unreadable++;
    }
  }
  return { tracked, tasks: tasks.length, unreadable, rows: [...combined.values()] };
}

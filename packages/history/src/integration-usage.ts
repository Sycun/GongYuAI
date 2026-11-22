import type { DatabaseSync } from "node:sqlite";
import type { IntegrationKind, IntegrationRow, TaskIntegrationUsage } from "@gongyuai/contracts";

type StartCall = (kind: IntegrationKind, name: string, method?: string) => (success: boolean) => void;
const skipResult = () => {};

// Keep operational telemetry separate from the facts and events read by the agent.
export function trackIntegrationCalls(db: DatabaseSync, taskId: string): StartCall {
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS integration_tracking (task_id TEXT PRIMARY KEY, since TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS integration_calls (
        id INTEGER PRIMARY KEY, task_id TEXT NOT NULL, kind TEXT NOT NULL,
        name TEXT NOT NULL, method TEXT NOT NULL, success INTEGER
      );
      CREATE INDEX IF NOT EXISTS integration_calls_task ON integration_calls(task_id,kind,name,method);
    `);
    db.prepare("INSERT OR IGNORE INTO integration_tracking VALUES (?, ?)").run(taskId, new Date().toISOString());
    const start = db.prepare("INSERT INTO integration_calls (task_id,kind,name,method) VALUES (?,?,?,?)");
    const end = db.prepare("UPDATE integration_calls SET success=? WHERE id=? AND success IS NULL");
    return (kind, name, method = "") => {
      try {
        const { lastInsertRowid } = start.run(taskId, kind, name, method);
        return (success) => {
          try { end.run(Number(success), lastInsertRowid); }
          catch { console.warn("[usage] Could not record integration result"); }
        };
      } catch {
        console.warn("[usage] Could not record integration attempt");
        return skipResult;
      }
    };
  } catch {
    console.warn("[usage] Integration telemetry is unavailable");
    return () => skipResult;
  }
}

export function readIntegrationUsage(db: DatabaseSync, taskId: string): TaskIntegrationUsage {
  if (!db.prepare("SELECT 1 FROM sqlite_schema WHERE name='integration_tracking' AND type='table'").get()) {
    return { since: null, rows: [] };
  }
  const marker = db.prepare("SELECT since FROM integration_tracking WHERE task_id=?").get(taskId);
  if (!marker) return { since: null, rows: [] };
  const rows = db.prepare(`
    SELECT kind, name, method, count(*) AS calls, count(*) FILTER (WHERE success=1) AS succeeded,
           count(*) FILTER (WHERE success=0) AS failed
    FROM integration_calls WHERE task_id=? GROUP BY kind,name,method ORDER BY kind,name,method
  `).all(taskId) as IntegrationRow[];
  return { since: String(marker.since), rows: rows.map((row) => ({ ...row })) };
}

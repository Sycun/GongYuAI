import { copyFileSync, cpSync, existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { TaskRecord } from "@gongyuai/contracts";

/**
 * One install → one data root: `<installRoot>/.gongyuai`.
 * Never default to cwd-relative `.gongyuai` (that created ~/.gongyuai vs repo/.gongyuai splits).
 */
export function resolveCanonicalDataRoot(opts: {
  installRoot: string;
  explicit?: string | null;
  envValue?: string | null;
}): string {
  const picked = opts.explicit?.trim() || opts.envValue?.trim();
  if (picked) return resolve(picked);
  return resolve(opts.installRoot, ".gongyuai");
}

function taskCount(dbPath: string): number {
  if (!existsSync(dbPath)) return 0;
  try {
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      const row = db.prepare(`SELECT COUNT(*) AS n FROM tasks`).get() as { n: number } | undefined;
      return Number(row?.n ?? 0);
    } finally {
      db.close();
    }
  } catch {
    return 0;
  }
}

/** Copy missing tasks from an older data root into the canonical one. */
export function migrateDataRoot(fromRoot: string, toRoot: string): { migrated: number } {
  const from = resolve(fromRoot);
  const to = resolve(toRoot);
  if (from === to) return { migrated: 0 };

  const fromDb = join(from, "control.sqlite");
  if (!existsSync(fromDb) || taskCount(fromDb) === 0) return { migrated: 0 };

  mkdirSync(to, { recursive: true });
  mkdirSync(join(to, "tasks"), { recursive: true });
  const destDbPath = join(to, "control.sqlite");

  const src = new DatabaseSync(fromDb, { readOnly: true });
  const dst = new DatabaseSync(destDbPath);
  try {
    dst.exec(`
      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        json TEXT NOT NULL
      );
    `);
    const existing = new Set(
      (dst.prepare(`SELECT id FROM tasks`).all() as Array<{ id: string }>).map((r) => r.id),
    );
    const rows = src.prepare(`SELECT id, json FROM tasks`).all() as Array<{
      id: string;
      json: string;
    }>;
    let migrated = 0;
    const insert = dst.prepare(
      `INSERT INTO tasks (id, json) VALUES (?, ?)
       ON CONFLICT(id) DO UPDATE SET json = excluded.json`,
    );
    for (const row of rows) {
      if (existing.has(row.id)) continue;
      let rec: TaskRecord;
      try {
        rec = JSON.parse(row.json) as TaskRecord;
      } catch {
        continue;
      }
      const taskDir = join(to, "tasks", row.id);
      const legacyTaskDir = join(from, "tasks", row.id);
      if (!existsSync(taskDir) && existsSync(legacyTaskDir)) {
        cpSync(legacyTaskDir, taskDir, { recursive: true });
      }
      rec.dataDir = taskDir;
      rec.workerPid = null;
      rec.leaseOwner = null;
      rec.leaseUntil = null;
      insert.run(row.id, JSON.stringify(rec));
      migrated += 1;
    }

    const legacySettings = join(from, "settings.json");
    const destSettings = join(to, "settings.json");
    if (!existsSync(destSettings) && existsSync(legacySettings)) {
      copyFileSync(legacySettings, destSettings);
    }

    return { migrated };
  } finally {
    src.close();
    dst.close();
  }
}

/**
 * Older serves sometimes wrote into `~/.gongyuai` while Kali/systemd use
 * `<repo>/.gongyuai`. Import any missing tasks so the console never goes blank.
 */
export function migrateLegacyHomeDataRoot(canonicalRoot: string): {
  migrated: number;
  from: string | null;
} {
  const legacy = resolve(homedir(), ".gongyuai");
  const result = migrateDataRoot(legacy, canonicalRoot);
  return { migrated: result.migrated, from: result.migrated > 0 ? legacy : null };
}

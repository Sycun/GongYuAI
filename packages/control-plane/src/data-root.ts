import { copyFileSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
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

/** 一次目录归属改写：旧备份里的绝对路径 → 本次指定的数据根。 */
export type RehomeRecord = { taskId: string; from: string; to: string };

export type ConfineOptions = {
  /** 只在本副本里改写 JSON 内的绝对路径（默认开启）。 */
  rewriteJsonFiles?: boolean;
};

/**
 * 恢复副本的目录归属（第七轮）。
 *
 * 旧备份/旧任务记录里的 `dataDir` 是**制作备份那台机器**的绝对路径。直接用
 * 它启动服务，任务加载、History、证据、报告、快照、记分卡都会去读正式实例
 * 的目录——这正是上一轮复核的反例。这里把归属改成“本次指定的数据根”：
 *
 * - 只改交给本函数的那份记录（恢复副本），正式实例的记录不受影响；
 * - 改写前先验证任务 ID 与目录边界（旧路径末级必须等于任务 ID），不猜布局；
 * - 目标目录不在本数据根内或不存在时直接拒绝，宁可报错也不跨根读取；
 * - 顺带把副本任务目录里 JSON 的旧绝对路径（manifest 的 dataDir/evidenceDir 等）
 *   改写成副本路径，worker 重启时不会再指回正式目录。
 */
export function confineTaskDataDir(
  dataRoot: string,
  record: Pick<TaskRecord, "id" | "dataDir">,
  opts: ConfineOptions = {},
): { dataDir: string; rehomed: RehomeRecord | null } {
  const root = resolve(dataRoot);
  const canonical = resolve(join(root, "tasks", record.id));
  const current = record.dataDir ? resolve(record.dataDir) : "";
  if (current === canonical) return { dataDir: canonical, rehomed: null };

  if (current && basename(current) !== record.id) {
    throw new Error(
      `任务 ${record.id} 的数据目录与任务 ID 不符（${current}），拒绝猜测归属`,
    );
  }
  if (!existsSync(canonical)) {
    throw new Error(
      `任务 ${record.id} 在本次数据根内没有对应目录（期望 ${canonical}），拒绝跨根读取 ${current || "（空）"}`,
    );
  }
  if (opts.rewriteJsonFiles !== false && current) {
    rewriteAbsolutePaths(canonical, current, canonical);
  }
  return { dataDir: canonical, rehomed: { taskId: record.id, from: current, to: canonical } };
}

/**
 * 把任务目录里 JSON/文本引用到的旧绝对路径改成副本路径。只动这个任务目录，
 * 不动数据根之外的任何文件；二进制数据库不在改写范围（由 runner 重写 manifest）。
 */
export function rewriteAbsolutePaths(taskDir: string, from: string, to: string): string[] {
  if (!from || from === to || !existsSync(taskDir)) return [];
  const touched: string[] = [];
  for (const name of readdirSync(taskDir)) {
    if (!/\.(json|txt|md)$/i.test(name)) continue;
    const path = join(taskDir, name);
    try {
      const text = readFileSync(path, "utf8");
      if (!text.includes(from)) continue;
      writeFileSync(path, text.split(from).join(to));
      touched.push(name);
    } catch {
      /* 单个文件读不了不影响归属改写 */
    }
  }
  return touched;
}

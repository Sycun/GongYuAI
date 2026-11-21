import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { migrateDataRoot, resolveCanonicalDataRoot } from "./data-root.js";

test("resolveCanonicalDataRoot prefers explicit then env then installRoot/.gongyuai", () => {
  const install = "/opt/GongYuAI";
  assert.equal(
    resolveCanonicalDataRoot({ installRoot: install, explicit: "/var/gy", envValue: "/env" }),
    "/var/gy",
  );
  assert.equal(
    resolveCanonicalDataRoot({ installRoot: install, explicit: null, envValue: "/env/gy" }),
    "/env/gy",
  );
  assert.equal(
    resolveCanonicalDataRoot({ installRoot: install, explicit: "  ", envValue: "" }),
    join(install, ".gongyuai"),
  );
});

test("migrateDataRoot copies missing tasks and rewrites dataDir", () => {
  const dest = mkdtempSync(join(tmpdir(), "gy-dest-"));
  const legacy = mkdtempSync(join(tmpdir(), "gy-legacy-"));
  try {
    mkdirSync(join(legacy, "tasks", "t1"), { recursive: true });
    writeFileSync(join(legacy, "tasks", "t1", "report.md"), "ok");
    const ldb = new DatabaseSync(join(legacy, "control.sqlite"));
    ldb.exec(`CREATE TABLE tasks (id TEXT PRIMARY KEY, json TEXT NOT NULL)`);
    ldb
      .prepare(`INSERT INTO tasks (id, json) VALUES (?, ?)`)
      .run(
        "t1",
        JSON.stringify({
          id: "t1",
          name: "demo",
          dataDir: join(legacy, "tasks", "t1"),
          status: "completed",
        }),
      );
    ldb.close();

    const first = migrateDataRoot(legacy, dest);
    assert.equal(first.migrated, 1);
    assert.equal(readFileSync(join(dest, "tasks", "t1", "report.md"), "utf8"), "ok");

    const ddb = new DatabaseSync(join(dest, "control.sqlite"), { readOnly: true });
    const row = ddb.prepare(`SELECT json FROM tasks WHERE id = ?`).get("t1") as { json: string };
    ddb.close();
    const rec = JSON.parse(row.json) as { dataDir: string };
    assert.equal(rec.dataDir, join(dest, "tasks", "t1"));

    const second = migrateDataRoot(legacy, dest);
    assert.equal(second.migrated, 0);
  } finally {
    rmSync(dest, { recursive: true, force: true });
    rmSync(legacy, { recursive: true, force: true });
  }
});

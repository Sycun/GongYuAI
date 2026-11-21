import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import { openHistory } from "./index.js";

test("evidence gate blocks pass without files", () => {
  const root = mkdtempSync(join(tmpdir(), "gy-hist-"));
  const evidenceDir = join(root, "evidence");
  mkdirSync(evidenceDir, { recursive: true });
  const store = openHistory({
    dbPath: join(root, "history.sqlite"),
    evidenceDir,
  });
  const taskId = "11111111-1111-4111-8111-111111111111";
  store.seedGoals(taskId, [
    {
      id: "recon",
      title: "Recon",
      description: "Collect banner",
      evidencePatterns: ["recon/*.txt"],
      passes: false,
      evidencePaths: [],
      assertedAt: null,
    },
  ]);

  const blocked = store.assertGoal(taskId, "recon", ["recon/banner.txt"]);
  assert.equal(blocked.ok, false);

  mkdirSync(join(evidenceDir, "recon"), { recursive: true });
  writeFileSync(join(evidenceDir, "recon", "banner.txt"), "nginx/1.0\n");

  const ok = store.assertGoal(taskId, "recon", ["recon/banner.txt"]);
  assert.equal(ok.ok, true);
  if (ok.ok) assert.equal(ok.goal.passes, true);
  assert.equal(store.allGoalsPass(taskId), true);

  store.close();
  rmSync(root, { recursive: true, force: true });
});

test("ALL_COMPLETE.json requires every is_completed=true", () => {
  const root = mkdtempSync(join(tmpdir(), "gy-hist-ac-"));
  const evidenceDir = join(root, "evidence");
  mkdirSync(join(evidenceDir, "tsec"), { recursive: true });
  const store = openHistory({
    dbPath: join(root, "history.sqlite"),
    evidenceDir,
  });
  const taskId = "22222222-2222-4222-8222-222222222222";
  store.seedGoals(taskId, [
    {
      id: "clear-board",
      title: "Clear board",
      description: "all done",
      evidencePatterns: ["tsec/ALL_COMPLETE.json"],
      passes: false,
      evidencePaths: [],
      assertedAt: null,
    },
  ]);

  writeFileSync(
    join(evidenceDir, "tsec", "ALL_COMPLETE.json"),
    JSON.stringify([
      { unique_code: "e1-01", is_completed: true },
      { unique_code: "e1-02", is_completed: false },
    ]),
  );
  const blocked = store.assertGoal(taskId, "clear-board", ["tsec/ALL_COMPLETE.json"]);
  assert.equal(blocked.ok, false);

  writeFileSync(
    join(evidenceDir, "tsec", "ALL_COMPLETE.json"),
    JSON.stringify([
      { unique_code: "e1-01", is_completed: true },
      { unique_code: "e1-02", is_completed: true },
    ]),
  );
  const ok = store.assertGoal(taskId, "clear-board", ["tsec/ALL_COMPLETE.json"]);
  assert.equal(ok.ok, true);

  store.close();
  rmSync(root, { recursive: true, force: true });
});

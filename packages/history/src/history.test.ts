import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import { ORIGIN_FACT_ID } from "@gongyuai/contracts";
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

test("proposeIntent rejects empty sourceFactIds; origin allowed", () => {
  const root = mkdtempSync(join(tmpdir(), "gy-hist-src-"));
  const evidenceDir = join(root, "evidence");
  mkdirSync(evidenceDir, { recursive: true });
  const store = openHistory({
    dbPath: join(root, "history.sqlite"),
    evidenceDir,
  });
  const taskId = "33333333-3333-4333-8333-333333333333";

  assert.throws(
    () =>
      store.proposeIntent({
        taskId,
        title: "causeless",
        sourceFactIds: [],
      }),
    /sourceFactIds required/,
  );

  assert.throws(
    () =>
      store.proposeIntent({
        taskId,
        title: "unknown pred",
        sourceFactIds: ["00000000-0000-4000-8000-000000000000"],
      }),
    /unknown source fact/,
  );

  const proposed = store.proposeIntent({
    taskId,
    title: "from origin",
    sourceFactIds: [ORIGIN_FACT_ID],
  });
  assert.deepEqual(proposed.sourceFactIds, [ORIGIN_FACT_ID]);
  assert.equal(proposed.status, "proposed");

  store.close();
  rmSync(root, { recursive: true, force: true });
});

test("claimIntent is CAS on proposed; succeed conclude requires Fact writeback", () => {
  const root = mkdtempSync(join(tmpdir(), "gy-hist-cas-"));
  const evidenceDir = join(root, "evidence");
  mkdirSync(evidenceDir, { recursive: true });
  const store = openHistory({
    dbPath: join(root, "history.sqlite"),
    evidenceDir,
  });
  const taskId = "44444444-4444-4444-8444-444444444444";

  const intent = store.proposeIntent({
    taskId,
    title: "probe",
    sourceFactIds: [ORIGIN_FACT_ID],
  });

  const claimed = store.claimIntent(taskId, intent.id, "worker-a");
  assert.ok(claimed);
  assert.equal(claimed!.status, "claimed");
  assert.equal(claimed!.claimedBy, "worker-a");

  const lost = store.claimIntent(taskId, intent.id, "worker-b");
  assert.equal(lost, null);

  assert.throws(
    () => store.concludeIntent(taskId, intent.id, "succeeded", "ok"),
    /requires ≥1 Fact/,
  );

  const done = store.concludeIntent(taskId, intent.id, "succeeded", "ok", {
    facts: [{ layer: "title", title: "probe result", summary: "found X" }],
  });
  assert.ok(done);
  assert.equal(done!.status, "succeeded");

  const facts = store.listFacts(taskId);
  assert.equal(facts.length, 1);
  assert.equal(facts[0]!.intentId, intent.id);
  assert.equal(facts[0]!.title, "probe result");

  store.close();
  rmSync(root, { recursive: true, force: true });
});

import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { openHistory } from "./index.js";

const TASK_ID = "99999999-9999-4999-8999-999999999999";

function setup(prefix: string) {
  const root = mkdtempSync(join(tmpdir(), prefix));
  const evidenceDir = join(root, "evidence");
  mkdirSync(evidenceDir, { recursive: true });
  const store = openHistory({ dbPath: join(root, "history.sqlite"), evidenceDir });
  return { root, store };
}

test("plan steps derive ready from facts and dispatch only the ready one", () => {
  const { root, store } = setup("gy-plan-");
  try {
    const seed = store.recordAsset({
      taskId: TASK_ID,
      address: "lab.example.com",
      auth: { targets: ["*.example.com"], outOfScope: [] },
      live: true,
    }).fact;
    // Step 1 depends on the seed fact; step 2 depends on an intent from step 1.
    const plan = store.setPlan(TASK_ID, [
      { title: "enumerate login", needsFactIds: [seed.id] },
      { title: "exploit SQLi", needsIntentIds: [] },
    ]);
    assert.equal(plan.length, 2);
    assert.equal(plan[0]!.status, "ready");
    assert.equal(plan[1]!.status, "ready"); // no deps → also ready
    assert.equal(store.nextPlanStep(TASK_ID)!.ord, 0);

    // Ad-hoc intent is refused while a ready step exists.
    assert.throws(
      () =>
        store.proposeIntent({
          taskId: TASK_ID,
          title: "unrelated",
          sourceFactIds: [seed.id],
        }),
      /ready plan step/,
    );

    const intent = store.proposeIntent({
      taskId: TASK_ID,
      title: "enumerate login",
      sourceFactIds: [seed.id],
      planStepId: plan[0]!.id,
    });
    assert.equal(store.listPlan(TASK_ID)[0]!.status, "dispatched");
    assert.equal(store.listPlan(TASK_ID)[0]!.intentId, intent.id);

    store.concludeIntent(TASK_ID, intent.id, "succeeded", "done", {
      facts: [{ layer: "title", title: "login form found" }],
    });
    assert.equal(store.listPlan(TASK_ID)[0]!.status, "done");
    // Step 2 becomes the next ready step.
    assert.equal(store.nextPlanStep(TASK_ID)!.ord, 1);

    // Model cannot self-report completion: update only touches labels.
    const updated = store.updatePlanStep(TASK_ID, plan[1]!.id, { title: "exploit SQLi (bool)", summary: "" });
    assert.equal(updated.status, "ready");
    assert.equal(updated.title, "exploit SQLi (bool)");
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("plan rejects unknown deps and non-ready dispatch", () => {
  const { root, store } = setup("gy-plan-reject-");
  try {
    assert.throws(
      () => store.setPlan(TASK_ID, [{ title: "x", needsFactIds: ["00000000-0000-4000-8000-000000000000"] }]),
      /unknown fact/,
    );
    const seed = store.recordAsset({
      taskId: TASK_ID,
      address: "lab.example.com",
      auth: { targets: ["*.example.com"], outOfScope: [] },
    }).fact;
    // A known but non-terminal intent keeps the step pending (deps unmet).
    const openIntent = store.proposeIntent({
      taskId: TASK_ID,
      title: "still open",
      sourceFactIds: [seed.id],
    });
    const plan = store.setPlan(TASK_ID, [
      { title: "blocked step", needsIntentIds: [openIntent.id] },
    ]);
    assert.equal(plan[0]!.status, "pending");
    assert.equal(store.nextPlanStep(TASK_ID), null);
    assert.throws(
      () =>
        store.proposeIntent({
          taskId: TASK_ID,
          title: "dispatch pending",
          sourceFactIds: [seed.id],
          planStepId: plan[0]!.id,
        }),
      /not ready/,
    );
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

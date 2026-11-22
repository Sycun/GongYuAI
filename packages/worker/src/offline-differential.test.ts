import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { runOfflineDifferential } from "./offline-differential.js";

test("offline comparison keeps the same stub calls and scores what survives the session boundary", (t) => {
  const root = mkdtempSync(join(tmpdir(), "gy-offline-diff-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const network = t.mock.method(globalThis, "fetch", () => assert.fail("offline fixture called fetch"));
  const result = runOfflineDifferential(root);

  assert.deepEqual(result.rows.map(({ mode, status, goalsPassed, relayHandoffs }) => [
    mode, status, goalsPassed, relayHandoffs,
  ]), [
    ["bare", "incomplete", 0, 0],
    ["history", "incomplete", 1, 0],
    ["relay", "completed", 2, 1],
  ]);
  const expectedVisible = [{}, { reference: "CATALOG-042" }, {
    reference: "CATALOG-042",
    reviewReceipt: "REVIEW-BLUE",
  }];
  for (const [i, row] of result.rows.entries()) {
    assert.equal(row.modelTurns, 3);
    assert.equal(row.toolAttempts, 2);
    assert.equal(row.toolCalls, 2);
    const events = readFileSync(join(root, row.traceFile), "utf8").trim().split("\n")
      .map((line) => JSON.parse(line));
    const model = events.filter((event) => event.type === "model");
    assert.deepEqual(model.slice(0, 2).map((event) => event.decision.name), result.allowedTools);
    assert.equal(model[2]?.session, 2);
    assert.deepEqual(model[2]?.visible, expectedVisible[i]);
    assert.equal(events.filter((event) => event.type === "tool" && event.allowed).length, 2);
    assert.equal(events.at(-1)?.type, "terminal");
    assert.equal(existsSync(join(root, row.mode, "relay.json")), row.mode === "relay");
  }
  assert.equal(network.mock.callCount(), 0);
});

test("offline tool and model budgets stop all arms at the same boundary", (t) => {
  const root = mkdtempSync(join(tmpdir(), "gy-offline-budget-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const toolLimited = runOfflineDifferential(join(root, "tool-limit"), { maxModelTurns: 3, maxToolCalls: 1 });
  const modelLimited = runOfflineDifferential(join(root, "model-limit"), { maxModelTurns: 2, maxToolCalls: 2 });

  for (const row of toolLimited.rows) {
    assert.equal(row.status, "budget_exhausted");
    assert.equal(row.budgetLimit, "maxToolCalls");
    assert.equal(row.modelTurns, 2);
    assert.equal(row.toolAttempts, 2);
    assert.equal(row.toolCalls, 1);
    assert.equal(row.goalsPassed, 0);
    assert.equal(existsSync(join(root, "tool-limit", row.mode, "evidence", "answer.json")), false);
  }
  for (const row of modelLimited.rows) {
    assert.equal(row.status, "budget_exhausted");
    assert.equal(row.budgetLimit, "maxModelTurns");
    assert.equal(row.modelTurns, 2);
    assert.equal(row.toolCalls, 2);
    assert.equal(row.goalsPassed, 0);
  }
});

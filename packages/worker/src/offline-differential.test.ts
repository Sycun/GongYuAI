import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { runOfflineDifferential } from "./offline-differential.js";

test("offline scenarios isolate session timing and missing handoffs under identical controls", (t) => {
  const root = mkdtempSync(join(tmpdir(), "gy-offline-diff-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const network = t.mock.method(globalThis, "fetch", () => assert.fail("offline fixture called fetch"));
  const result = runOfflineDifferential(root);

  const reference = { reference: "CATALOG-042" };
  const receipt = { reviewReceipt: "REVIEW-BLUE" };
  const both = { ...reference, ...receipt };
  const expected = [
    { id: "short", scores: [2, 2, 2], visible: [both, both, both], session: 1, gain: [0, 0] },
    { id: "after-reference", scores: [1, 2, 2], visible: [receipt, both, both], session: 2, gain: [1, 0] },
    { id: "after-receipt", scores: [0, 1, 2], visible: [{}, reference, both], session: 2, gain: [1, 1] },
    { id: "handoff-lost", scores: [0, 1, 1], visible: [{}, reference, reference], session: 2, gain: [1, 0] },
  ];
  assert.deepEqual(result.scenarios.map(({ id }) => id), expected.map(({ id }) => id));
  for (const [i, scenario] of result.scenarios.entries()) {
    const expectation = expected[i]!;
    assert.deepEqual([scenario.historyGain, scenario.relayGain], expectation.gain, scenario.id);
    assert.deepEqual(scenario.rows.map((row) => row.goalsPassed), expectation.scores, scenario.id);
    assert.deepEqual(scenario.rows.map((row) => row.mode), ["bare", "history", "relay"]);
    for (const [j, row] of scenario.rows.entries()) {
      const name = `${scenario.id}/${row.mode}`;
      assert.equal(row.modelTurns, 3, name);
      assert.equal(row.toolAttempts, 2, name);
      assert.equal(row.toolCalls, 2, name);
      assert.equal(row.status, row.goalsPassed === 2 ? "completed" : "incomplete", name);
      const events = readFileSync(join(root, row.traceFile), "utf8").trim().split("\n")
        .map((line) => JSON.parse(line));
      assert.deepEqual(events[0]?.budget, result.budget, name);
      assert.deepEqual(events[0]?.allowedTools, result.allowedTools, name);
      const model = events.filter((event) => event.type === "model");
      assert.deepEqual(model.slice(0, 2).map((event) => event.decision.name), result.allowedTools, name);
      assert.equal(model[2]?.session, expectation.session, name);
      assert.deepEqual(model[2]?.visible, expectation.visible[j], name);
      const cuts = events.filter((event) => event.type === "session_boundary");
      assert.deepEqual(cuts.map((event) => event.turn), scenario.cutAfterTool === null ? [] : [scenario.cutAfterTool], name);
      assert.equal(events.filter((event) => event.type === "tool" && event.allowed).length, 2, name);
      assert.equal(events.at(-1)?.type, "terminal", name);

      const relayEvents = events.map((event) => event.type).filter((type) => type.startsWith("relay_"));
      const restored = row.mode === "relay" && scenario.id === "after-receipt";
      const missing = row.mode === "relay" && scenario.id === "handoff-lost";
      const expectedRelayEvents = restored ? ["relay_written", "relay_restored"]
        : missing ? ["relay_written", "relay_lost", "relay_missing"] : [];
      assert.deepEqual(relayEvents, expectedRelayEvents, name);
      assert.deepEqual(
        [row.relayHandoffs, row.relayRestores, row.relayMisses],
        [Number(restored || missing), Number(restored), Number(missing)],
        name,
      );
      assert.equal(existsSync(join(root, dirname(row.traceFile), "relay.json")), restored, name);
    }
  }
  assert.equal(network.mock.callCount(), 0);
});

test("offline tool and model budgets stop all arms at the same boundary", (t) => {
  const root = mkdtempSync(join(tmpdir(), "gy-offline-budget-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const toolLimited = runOfflineDifferential(join(root, "tool-limit"), { maxModelTurns: 3, maxToolCalls: 1 });
  const modelLimited = runOfflineDifferential(join(root, "model-limit"), { maxModelTurns: 2, maxToolCalls: 2 });

  for (const row of toolLimited.scenarios.flatMap((scenario) => scenario.rows)) {
    assert.equal(row.status, "budget_exhausted");
    assert.equal(row.budgetLimit, "maxToolCalls");
    assert.equal(row.modelTurns, 2);
    assert.equal(row.toolAttempts, 2);
    assert.equal(row.toolCalls, 1);
    assert.equal(row.goalsPassed, 0);
    assert.equal(existsSync(join(root, "tool-limit", dirname(row.traceFile), "evidence", "answer.json")), false);
  }
  for (const row of modelLimited.scenarios.flatMap((scenario) => scenario.rows)) {
    assert.equal(row.status, "budget_exhausted");
    assert.equal(row.budgetLimit, "maxModelTurns");
    assert.equal(row.modelTurns, 2);
    assert.equal(row.toolCalls, 2);
    assert.equal(row.goalsPassed, 0);
    assert.equal(row.relayRestores, 0);
    assert.equal(row.relayMisses, 0);
  }
});

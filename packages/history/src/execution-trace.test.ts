import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { listExecutionSteps, readExecutionStepCalls, saveExecutionStep } from "./execution-trace.js";

test("execution trace keeps same-time and same-number steps scoped to their IDs", (t) => {
  const dataDir = mkdtempSync(join(tmpdir(), "gy-execution-trace-"));
  t.after(() => rmSync(dataDir, { recursive: true, force: true }));
  assert.deepEqual(listExecutionSteps(dataDir), { steps: [], nextBefore: null });
  assert.equal(readExecutionStepCalls(dataDir, "missing"), null);

  const step = {
    id: "worker-0-round-1",
    at: "2026-11-22T02:40:06.125Z",
    number: 1,
    workerSlot: 0,
    tools: ["shell"],
    tokens: 10,
  };
  const calls = [
    { id: "call-1", command: "printf one", result: "exit=0\nstdout:\none" },
    { id: "call-2", command: "exit 7", result: "exit=7" },
  ];
  const otherCalls = [{ id: "call-1", command: "printf two", result: "exit=0\nstdout:\ntwo" }];
  const otherStep = { ...step, id: "worker-1-round-1", workerSlot: 1 };
  saveExecutionStep(dataDir, step, calls);
  saveExecutionStep(dataDir, otherStep, otherCalls);
  assert.deepEqual(saveExecutionStep(dataDir, { ...step, number: 2 }, []), { inserted: false, number: 1 });
  assert.deepEqual(readExecutionStepCalls(dataDir, step.id), calls);
  assert.deepEqual(readExecutionStepCalls(dataDir, otherStep.id), otherCalls);

  for (let number = 2; number <= 41; number += 1) {
    saveExecutionStep(dataDir, { ...step, id: `worker-0-round-${number}`, number }, []);
  }
  const first = listExecutionSteps(dataDir);
  assert.equal(first.steps.length, 40);
  assert.ok(first.nextBefore);
  assert.deepEqual(listExecutionSteps(dataDir, first.nextBefore), {
    steps: [
      { ...otherStep, shellCallCount: 1 },
      { ...step, shellCallCount: 2 },
    ],
    nextBefore: null,
  });
});

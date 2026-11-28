import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  listExecutionSteps,
  readExecutionStepCalls,
  readExecutionTraceCallContent,
  saveExecutionStep,
  searchExecutionTrace,
} from "./execution-trace.js";
import { openHistory } from "./index.js";

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

test("searchExecutionTrace and readExecutionTraceCallContent search across slots and page Unicode slices", (t) => {
  const dataDir = mkdtempSync(join(tmpdir(), "gy-trace-search-"));
  t.after(() => rmSync(dataDir, { recursive: true, force: true }));

  saveExecutionStep(
    dataDir,
    {
      id: "pi-w1-step-1",
      at: "2026-11-28T10:00:00.000Z",
      number: 1,
      workerSlot: 1,
      tools: ["shell"],
      tokens: 120,
    },
    [
      {
        id: "c1",
        command: "nmap -sV 10.0.1.5",
        result: "exit=0\nstdout:\n8080/tcp open http Spring Boot Actuator /env exposed 中文标记ABC",
        exitCode: 0,
        durationMs: 450,
      },
    ],
  );
  saveExecutionStep(
    dataDir,
    {
      id: "pi-w2-step-2",
      at: "2026-11-28T10:01:00.000Z",
      number: 2,
      workerSlot: 2,
      tools: ["shell"],
      tokens: 240,
    },
    [
      {
        id: "c2",
        command: "curl -s http://10.0.1.5:8080/actuator/env",
        result: "exit=0\nstdout:\n{\"DB_PASS\":\"S3cr3t_7788\"}",
        exitCode: 0,
        durationMs: 35,
      },
    ],
  );

  const searchActuator = searchExecutionTrace(dataDir, { query: "actuator" });
  assert.equal(searchActuator.hits.length, 2);
  assert.equal(searchActuator.hits[0]!.stepId, "pi-w2-step-2");
  assert.equal(searchActuator.hits[0]!.workerSlot, 2);
  assert.equal(searchActuator.hits[1]!.stepId, "pi-w1-step-1");
  assert.equal(searchActuator.hits[1]!.workerSlot, 1);

  const page1 = readExecutionTraceCallContent(dataDir, {
    stepId: "pi-w1-step-1",
    callId: "c1",
    part: "result",
    offset: 0,
    limit: 30,
  });
  assert.ok(page1);
  assert.equal(page1.hasMore, true);
  const page2 = readExecutionTraceCallContent(dataDir, {
    stepId: "pi-w1-step-1",
    callId: "c1",
    part: "result",
    offset: page1.nextOffset,
    limit: 200,
  });
  assert.ok(page2);
  assert.equal(page2.hasMore, false);
  assert.match(page1.text + page2.text, /中文标记ABC/);
});

test("HistoryStore resolves task-scoped short aliases F<n>, I<n>/W<n>, and V<n> alongside UUIDs", (t) => {
  const root = mkdtempSync(join(tmpdir(), "gy-short-id-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const store = openHistory({
    dbPath: join(root, "history.sqlite"),
    evidenceDir: join(root, "evidence"),
  });
  const taskId = "99999999-9999-4999-8999-999999999999";
  try {
    const f1 = store.appendFact({
      taskId,
      layer: "title",
      title: "Port 8080 open on 10.0.1.5",
      summary: "Spring Boot web service",
      tags: ["asset", "asset.kind:live", "asset.addr:10.0.1.5"],
    });
    assert.equal(store.getFact(taskId, "F1")?.id, f1.id);

    // Propose Intent referencing short alias F1 -> stored sourceFactIds normalizes to canonical UUID!
    const i1 = store.proposeIntent({
      taskId,
      title: "Test actuator on 10.0.1.5",
      sourceFactIds: ["F1"],
      assetRoot: "10.0.1.5",
    });
    assert.deepEqual(i1.sourceFactIds, [f1.id]);
    assert.equal(store.getIntent(taskId, "I1")?.id, i1.id);
    assert.equal(store.getIntent(taskId, "W1")?.id, i1.id);

    // Claim and conclude using short alias I1
    const claimed = store.claimIntent(taskId, "I1", "w1");
    assert.equal(claimed?.status, "claimed");

    const { finding } = store.recordFinding({
      taskId,
      title: "Actuator env leak",
      asset: "10.0.1.5",
      vulnClass: "CWE-200",
      severity: "high",
      factIds: [f1.id],
    });
    assert.equal(store.getFinding(taskId, "V1")?.id, finding.id);

    const obs = store.observe(taskId);
    assert.match(obs, /\[F1\]/);
    assert.match(obs, /\[I1\]/);
    assert.match(obs, /\[V1\]/);
  } finally {
    store.close();
  }
});

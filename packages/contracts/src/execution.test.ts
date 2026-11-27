import assert from "node:assert/strict";
import { test } from "node:test";
import {
  CreateTaskRequestSchema,
  DEFAULT_MAX_CONCURRENT_EXPLORES,
  ExecutionStepSchema,
  MAX_CONCURRENT_EXPLORES,
  resolveExploreWorkerCount,
  resolveWorkerSlotCount,
} from "./index.js";

test("execution step grouping metadata is optional for existing summaries", () => {
  const step = {
    id: "worker-0-round-1",
    at: "2026-11-24T01:00:00.000Z",
    number: 1,
    workerSlot: 0,
    tools: [],
    tokens: 12,
    shellCallCount: 0,
  };
  assert.deepEqual(ExecutionStepSchema.parse(step), step);
  const grouped = { ...step, intentId: "7158aeb3-76a0-4d8f-85f6-e54840646a3e", durationMs: 0 };
  assert.deepEqual(ExecutionStepSchema.parse(grouped), grouped);
  assert.equal(ExecutionStepSchema.safeParse({ ...step, durationMs: -1 }).success, false);
});

test("resolveExploreWorkerCount caps by targets and configured max", () => {
  assert.equal(
    resolveExploreWorkerCount({ maxConcurrentExplores: 1, targetCount: 5 }),
    1,
  );
  assert.equal(
    resolveExploreWorkerCount({ maxConcurrentExplores: 4, targetCount: 2 }),
    2,
  );
  assert.equal(
    resolveExploreWorkerCount({ maxConcurrentExplores: 8, targetCount: 8 }),
    8,
  );
  assert.equal(
    resolveExploreWorkerCount({
      maxConcurrentExplores: MAX_CONCURRENT_EXPLORES + 10,
      targetCount: 100,
    }),
    MAX_CONCURRENT_EXPLORES,
  );
  assert.equal(
    resolveExploreWorkerCount({ maxConcurrentExplores: 0, targetCount: 3 }),
    1,
  );
});

test("resolveExploreWorkerCount scales with admitted/live assets beyond seed targets", () => {
  // Single CIDR target, many discovered assets.
  assert.equal(
    resolveExploreWorkerCount({ maxConcurrentExplores: 8, targetCount: 1, assetCount: 50 }),
    8,
  );
  assert.equal(
    resolveExploreWorkerCount({ maxConcurrentExplores: 10, targetCount: 1, assetCount: 4 }),
    4,
  );
  // Targets still win when larger than asset count.
  assert.equal(
    resolveExploreWorkerCount({ maxConcurrentExplores: 10, targetCount: 6, assetCount: 2 }),
    6,
  );
  // User cap and hard ceiling are never exceeded.
  assert.equal(
    resolveExploreWorkerCount({ maxConcurrentExplores: 3, targetCount: 1, assetCount: 100 }),
    3,
  );
  assert.equal(
    resolveExploreWorkerCount({
      maxConcurrentExplores: MAX_CONCURRENT_EXPLORES + 10,
      targetCount: 1,
      assetCount: 1000,
    }),
    MAX_CONCURRENT_EXPLORES,
  );
  // Zero / missing assets keep legacy behavior.
  assert.equal(
    resolveExploreWorkerCount({ maxConcurrentExplores: 4, targetCount: 2, assetCount: 0 }),
    2,
  );
  assert.equal(
    resolveExploreWorkerCount({ maxConcurrentExplores: 4, targetCount: 2 }),
    2,
  );
});

test("CreateTaskRequest defaults execution.maxConcurrentExplores to 3 and maps slots as 1 leader + N explores", () => {
  const parsed = CreateTaskRequestSchema.parse({
    auth: {
      authorizationNote: "written authorization note",
      targets: ["https://a.example", "https://b.example"],
    },
    goals: [
      {
        id: "main",
        title: "main",
        description: "desc",
        evidencePatterns: ["**/*"],
      },
    ],
  });
  assert.equal(DEFAULT_MAX_CONCURRENT_EXPLORES, 3);
  assert.equal(parsed.execution.maxConcurrentExplores, 3);
  assert.equal(parsed.execution.maxIntentsPerReason, 4);
  assert.equal(parsed.execution.maxIntentsPerAssetRoot, 3);
  assert.equal(parsed.execution.exploreTimeoutMs, 900_000);
  assert.equal(parsed.execution.reasonLeaseMs, 120_000);
  assert.equal(resolveWorkerSlotCount(1), 1);
  assert.equal(resolveWorkerSlotCount(3), 4);
  assert.equal(resolveWorkerSlotCount(MAX_CONCURRENT_EXPLORES), MAX_CONCURRENT_EXPLORES + 1);
});

test("CreateTaskRequest accepts user concurrency", () => {
  const parsed = CreateTaskRequestSchema.parse({
    auth: {
      authorizationNote: "written authorization note",
      targets: ["a.example", "b.example", "c.example"],
    },
    goals: [
      {
        id: "main",
        title: "main",
        description: "desc",
        evidencePatterns: ["**/*"],
      },
    ],
    execution: { maxConcurrentExplores: 3 },
  });
  assert.equal(parsed.execution.maxConcurrentExplores, 3);
  assert.equal(parsed.execution.maxIntentsPerReason, 4);
  assert.equal(
    resolveExploreWorkerCount({
      maxConcurrentExplores: parsed.execution.maxConcurrentExplores,
      targetCount: parsed.auth.targets.length,
    }),
    3,
  );
});

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  CreateTaskRequestSchema,
  MAX_CONCURRENT_EXPLORES,
  resolveExploreWorkerCount,
} from "./index.js";

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

test("CreateTaskRequest defaults execution.maxConcurrentExplores to 1", () => {
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
  assert.equal(parsed.execution.maxConcurrentExplores, 1);
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
  assert.equal(
    resolveExploreWorkerCount({
      maxConcurrentExplores: parsed.execution.maxConcurrentExplores,
      targetCount: parsed.auth.targets.length,
    }),
    3,
  );
});

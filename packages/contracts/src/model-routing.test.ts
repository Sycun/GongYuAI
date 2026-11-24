import assert from "node:assert/strict";
import { test } from "node:test";
import { selectModelRoute, type ModelRef } from "./model-routing.js";

const base: ModelRef = { provider: "openai", modelId: "base-model" };
const reason: ModelRef = { provider: "openai", modelId: "reason-model", apiKeyEnv: "REASON_KEY" };
const explore: ModelRef = { provider: "deepseek", modelId: "explore-model", apiKeyEnv: "EXPLORE_KEY" };
const pool: ModelRef = { provider: "openrouter", modelId: "pool-model", apiKeyEnv: "POOL_KEY" };

test("slot 0 prefers reason; execution slots prefer explore", () => {
  const keyPresent = () => true;
  const leader = selectModelRoute({ base, tiers: { reason, explore }, slot: 0, keyPresent });
  assert.equal(leader.ref.modelId, "reason-model");
  assert.equal(leader.tier, "reason");
  const worker = selectModelRoute({ base, tiers: { reason, explore }, slot: 2, keyPresent });
  assert.equal(worker.ref.modelId, "explore-model");
  assert.equal(worker.tier, "explore");
});

test("missing tier key falls back to the other tier, then provider pool", () => {
  const worker = selectModelRoute({
    base,
    tiers: { reason, explore },
    providers: [pool],
    slot: 2,
    keyPresent: (ref) => ref.modelId !== "explore-model",
  });
  assert.equal(worker.ref.modelId, "reason-model");
  const noTierKeys = selectModelRoute({
    base,
    tiers: { reason, explore },
    providers: [pool],
    slot: 0,
    keyPresent: (ref) => ref.modelId === "pool-model",
  });
  assert.equal(noTierKeys.ref.modelId, "pool-model");
});

test("no configured key still yields a deterministic last candidate, not an invented model", () => {
  const route = selectModelRoute({
    base,
    tiers: { reason, explore },
    providers: [pool],
    slot: 0,
    keyPresent: () => false,
  });
  assert.equal(route.ref.modelId, "base-model");
  assert.ok(route.fallbacks.length >= 1);
});

test("base-only configuration routes to base", () => {
  const route = selectModelRoute({ base, slot: 0, keyPresent: () => true });
  assert.equal(route.ref.modelId, "base-model");
  assert.equal(route.tier, "base");
  assert.deepEqual(route.fallbacks, []);
});

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  BUDGET_UNLIMITED,
  BudgetSchema,
  isBudgetHit,
  isBudgetUnlimited,
  isWallHit,
} from "./index.js";

describe("budget unlimited (0)", () => {
  it("defaults to unlimited gates", () => {
    const b = BudgetSchema.parse({});
    assert.equal(b.maxTokens, BUDGET_UNLIMITED);
    assert.equal(b.maxWallMs, BUDGET_UNLIMITED);
    assert.equal(b.maxToolCalls, BUDGET_UNLIMITED);
    assert.equal(b.maxInstalls, BUDGET_UNLIMITED);
  });

  it("never hits when max is 0", () => {
    assert.equal(isBudgetUnlimited(0), true);
    assert.equal(isBudgetHit(1_000_000, 0), false);
    assert.equal(isWallHit(0, 0, 1e15), false);
  });

  it("hits finite gates", () => {
    assert.equal(isBudgetHit(10, 10), true);
    assert.equal(isBudgetHit(9, 10), false);
    assert.equal(isWallHit(0, 1000, 1000), true);
    assert.equal(isWallHit(0, 1000, 999), false);
  });
});

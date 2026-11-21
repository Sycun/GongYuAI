import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { boardClearPolicyBlock } from "./board-policy.js";
import type { WorkerManifest } from "@gongyuai/contracts";

function withGoals(
  goals: Array<{ id: string; title: string; description: string; evidencePatterns: string[] }>,
): WorkerManifest {
  return {
    goals: goals.map((g) => ({
      ...g,
      passes: false,
      evidencePaths: [],
      assertedAt: null,
    })),
  } as unknown as WorkerManifest;
}

describe("boardClearPolicyBlock", () => {
  it("injects for clear-board goals", () => {
    const text = boardClearPolicyBlock(
      withGoals([
        {
          id: "clear-board",
          title: "Clear entire TSecBench board",
          description: "x",
          evidencePatterns: ["tsec/ALL_COMPLETE.json"],
        },
      ]),
    );
    assert.match(text, /清板调度纪律/);
    assert.match(text, /intent_propose/);
    assert.match(text, /25/);
  });

  it("stays empty for unrelated goals", () => {
    const text = boardClearPolicyBlock(
      withGoals([
        {
          id: "smoke",
          title: "DVWA smoke",
          description: "x",
          evidencePatterns: ["x"],
        },
      ]),
    );
    assert.equal(text, "");
  });
});

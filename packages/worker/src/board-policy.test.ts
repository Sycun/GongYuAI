import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { boardClearPolicyBlock, isBoardClearMission } from "./board-policy.js";
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
  it("injects pentest engagement discipline for clear-board", () => {
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
    assert.match(text, /渗透测试/);
    assert.match(text, /intent_propose/);
    assert.match(text, /25/);
    assert.match(text, /asset_record|建图/);
    assert.match(text, /engagement\/report/);
  });

  it("treats engagement-report goal as board mission", () => {
    assert.equal(
      isBoardClearMission(
        withGoals([
          {
            id: "engagement-report",
            title: "Client-style engagement report",
            description: "x",
            evidencePatterns: ["engagement/report.md"],
          },
        ]),
      ),
      true,
    );
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

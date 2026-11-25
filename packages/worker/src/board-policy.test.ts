import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  boardClearPolicyBlock,
  collectEvidenceGaps,
  evidenceDeliverableSpecs,
  isBoardClearMission,
} from "./board-policy.js";
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
    assert.match(text, /autonomous-progress/);
    assert.match(text, /不阻断攻击链/);
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

  it("tracks ledger and report files without inventing them for other goals", () => {
    const goals = [
      {
        id: "clear-board",
        title: "Clear entire TSecBench board",
        description: "clear",
        evidencePatterns: ["tsec/ALL_COMPLETE.json"],
      },
      {
        id: "progress-log",
        title: "Engagement ledger",
        description: "Maintain evidence/goals/autonomous-progress.md",
        evidencePatterns: ["goals/autonomous-progress.md"],
      },
      {
        id: "engagement-report",
        title: "Client-style engagement report",
        description: "report",
        evidencePatterns: ["engagement/report.md"],
      },
    ];
    assert.deepEqual(
      evidenceDeliverableSpecs([goals[0]!]).map((spec) => spec.relativePath),
      [],
    );
    const specs = evidenceDeliverableSpecs(goals);
    assert.deepEqual(specs.map((spec) => spec.relativePath), [
      "goals/autonomous-progress.md",
      "engagement/report.md",
    ]);

    const root = mkdtempSync(join(tmpdir(), "gy-evidence-gap-"));
    const evidenceDir = join(root, "evidence");
    mkdirSync(join(evidenceDir, "goals"), { recursive: true });
    const ledger = join(evidenceDir, "goals", "autonomous-progress.md");
    writeFileSync(ledger, "# ledger\n");
    const written = 1_700_000_000;
    utimesSync(ledger, written, written);
    try {
      const gaps = collectEvidenceGaps({
        evidenceDir,
        goals,
        nowMs: (written + 120) * 1000,
        staleAfterMs: 60_000,
      });
      assert.equal(gaps.find((gap) => gap.kind === "ledger")?.reason, "stale");
      assert.equal(gaps.find((gap) => gap.kind === "report")?.reason, "missing");
      assert.equal(gaps.find((gap) => gap.kind === "report")?.evidencePath, "evidence/engagement/report.md");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
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

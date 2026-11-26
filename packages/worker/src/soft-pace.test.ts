import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bindEvidencePaceManifest, resetEvidencePaceBinding } from "./board-policy.js";
import { resetEvidencePaceRuntime, takeSoftPaceAdvice, type EvidencePaceState } from "./soft-pace.js";

describe("takeSoftPaceAdvice", () => {
  const cfg = { toolStep: 50, wallStepMs: 3_600_000, surfaceStep: 25 };

  it("stays quiet before first milestone", () => {
    assert.equal(
      takeSoftPaceAdvice(
        {
          toolCalls: 49,
          wallMs: 3_599_000,
          lastSoftToolMilestone: 0,
          lastSoftWallMilestone: 0,
        },
        cfg,
      ),
      null,
    );
  });

  it("advises on tool milestone with pentest framing", () => {
    const hit = takeSoftPaceAdvice(
      {
        toolCalls: 50,
        wallMs: 0,
        lastSoftToolMilestone: 0,
        lastSoftWallMilestone: 0,
      },
      cfg,
    );
    assert.ok(hit);
    assert.match(hit.message, /节奏提示/);
    assert.match(hit.message, /渗透/);
    assert.match(hit.message, /禁止自称预算耗尽/);
    assert.doesNotMatch(hit.message, /结束循环|停止任务|budget_exhausted/);
    assert.equal(hit.next.lastSoftToolMilestone, 50);
  });

  it("does not repeat the same tool milestone", () => {
    assert.equal(
      takeSoftPaceAdvice(
        {
          toolCalls: 75,
          wallMs: 0,
          lastSoftToolMilestone: 50,
          lastSoftWallMilestone: 0,
        },
        cfg,
      ),
      null,
    );
  });

  it("advises on wall milestone", () => {
    const hit = takeSoftPaceAdvice(
      {
        toolCalls: 0,
        wallMs: 3_600_000,
        lastSoftToolMilestone: 0,
        lastSoftWallMilestone: 0,
      },
      cfg,
    );
    assert.ok(hit);
    assert.match(hit.message, /连续跑/);
    assert.equal(hit.next.lastSoftWallMilestone, 1);
  });

  it("advises surface rotation while Intent claimed", () => {
    const hit = takeSoftPaceAdvice(
      {
        toolCalls: 130,
        wallMs: 0,
        lastSoftToolMilestone: 100,
        lastSoftWallMilestone: 0,
        toolsAtIntentClaim: 100,
        lastSoftSurfaceMilestone: 0,
      },
      cfg,
    );
    assert.ok(hit);
    assert.match(hit.message, /换面|Intent/);
    assert.equal(hit.next.lastSoftSurfaceMilestone, 25);
  });

  const ledgerGoals = [
    {
      id: "progress-log",
      title: "Engagement ledger",
      description: "台账",
      evidencePatterns: ["goals/autonomous-progress.md"],
    },
    {
      id: "engagement-report",
      title: "Client report",
      description: "报告",
      evidencePatterns: ["engagement/report.md"],
    },
  ];

  function paceCfg() {
    return {
      toolStep: 50,
      wallStepMs: 3_600_000,
      surfaceStep: 25,
      evidenceStep: 40,
      evidenceWallMs: 1_800_000,
      evidenceGoalStep: 1,
      evidenceStaleMs: 60_000,
    };
  }

  it("names missing ledger and report paths without stopping the chain", () => {
    const root = mkdtempSync(join(tmpdir(), "gy-pace-miss-"));
    const evidenceDir = join(root, "evidence");
    mkdirSync(evidenceDir, { recursive: true });
    const state: EvidencePaceState = { lastToolMilestone: 0, lastWallIndex: 0, lastGoalsPassed: 0 };
    try {
      const hit = takeSoftPaceAdvice(
        {
          toolCalls: 40,
          wallMs: 0,
          lastSoftToolMilestone: 0,
          lastSoftWallMilestone: 0,
          evidence: { evidenceDir, goals: ledgerGoals, goalsPassed: 0, state, nowMs: 1_700_000_000_000 },
        },
        paceCfg(),
      );
      assert.ok(hit);
      assert.match(hit.message, /证据落盘/);
      assert.match(hit.message, /不中断利用链/);
      assert.match(hit.message, /evidence\/goals\/autonomous-progress\.md/);
      assert.match(hit.message, /evidence\/engagement\/report\.md/);
      assert.match(hit.message, /尚未落盘/);
      assert.doesNotMatch(hit.message, /结束循环|停止任务|budget_exhausted/);
      assert.equal(
        takeSoftPaceAdvice(
          {
            toolCalls: 40,
            wallMs: 0,
            lastSoftToolMilestone: 0,
            lastSoftWallMilestone: 0,
            evidence: { evidenceDir, goals: ledgerGoals, goalsPassed: 0, state, nowMs: 1_700_000_000_000 },
          },
          paceCfg(),
        ),
        null,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("stays quiet once the ledger and report are fresh", () => {
    const root = mkdtempSync(join(tmpdir(), "gy-pace-fresh-"));
    const evidenceDir = join(root, "evidence");
    mkdirSync(join(evidenceDir, "goals"), { recursive: true });
    mkdirSync(join(evidenceDir, "engagement"), { recursive: true });
    const now = Date.now();
    writeFileSync(join(evidenceDir, "goals", "autonomous-progress.md"), "# ledger\n");
    writeFileSync(join(evidenceDir, "engagement", "report.md"), "# report\n");
    utimesSync(join(evidenceDir, "goals", "autonomous-progress.md"), now / 1000, now / 1000);
    utimesSync(join(evidenceDir, "engagement", "report.md"), now / 1000, now / 1000);
    try {
      const hit = takeSoftPaceAdvice(
        {
          toolCalls: 50,
          wallMs: 0,
          lastSoftToolMilestone: 0,
          lastSoftWallMilestone: 0,
          evidence: {
            evidenceDir,
            goals: ledgerGoals,
            nowMs: now,
            staleAfterMs: 3_600_000,
            state: { lastToolMilestone: 0, lastWallIndex: 0, lastGoalsPassed: 0 },
          },
        },
        { ...paceCfg(), evidenceStaleMs: 3_600_000 },
      );
      assert.ok(hit);
      assert.match(hit.message, /节奏提示/);
      assert.doesNotMatch(hit.message, /尚未落盘|未更新/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("calls out a stale ledger and a newly passed goal", () => {
    const root = mkdtempSync(join(tmpdir(), "gy-pace-stale-"));
    const evidenceDir = join(root, "evidence");
    mkdirSync(join(evidenceDir, "goals"), { recursive: true });
    const file = join(evidenceDir, "goals", "autonomous-progress.md");
    writeFileSync(file, "# ledger\n");
    const written = 1_700_000_000;
    utimesSync(file, written, written);
    const state: EvidencePaceState = { lastToolMilestone: 0, lastWallIndex: 0, lastGoalsPassed: 0 };
    try {
      const hit = takeSoftPaceAdvice(
        {
          toolCalls: 0,
          wallMs: 0,
          lastSoftToolMilestone: 0,
          lastSoftWallMilestone: 0,
          evidence: {
            evidenceDir,
            goals: [ledgerGoals[0]!],
            goalsPassed: 1,
            nowMs: (written + 120) * 1000,
            state,
          },
        },
        { ...paceCfg(), evidenceStep: 10_000, evidenceWallMs: 86_400_000, evidenceStaleMs: 60_000 },
      );
      assert.ok(hit);
      assert.match(hit.message, /未更新/);
      assert.match(hit.message, /evidence\/goals\/autonomous-progress\.md/);
      assert.doesNotMatch(hit.message, /结束循环|停止任务/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("reads a manifest binding from the worker entry and exempts multi-worker followers", () => {
    const root = mkdtempSync(join(tmpdir(), "gy-pace-bind-"));
    const evidenceDir = join(root, "evidence");
    mkdirSync(evidenceDir, { recursive: true });
    bindEvidencePaceManifest({ evidenceDir, goals: ledgerGoals });
    try {
      const hit = takeSoftPaceAdvice(
        { toolCalls: 40, wallMs: 0, lastSoftToolMilestone: 0, lastSoftWallMilestone: 0 },
        paceCfg(),
      );
      assert.ok(hit);
      assert.match(hit.message, /evidence\/engagement\/report\.md/);

      // Multi-worker follower (slot 1 / pool 4) must NOT receive shared report overwrite nags.
      resetEvidencePaceRuntime();
      bindEvidencePaceManifest({ evidenceDir, goals: ledgerGoals, workerSlot: 1, workerCount: 4 });
      const followerHit = takeSoftPaceAdvice(
        { toolCalls: 40, wallMs: 0, lastSoftToolMilestone: 0, lastSoftWallMilestone: 0 },
        paceCfg(),
      );
      assert.equal(followerHit, null);
    } finally {
      resetEvidencePaceBinding();
      resetEvidencePaceRuntime();
      rmSync(root, { recursive: true, force: true });
    }
  });
});

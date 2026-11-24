import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import { ORIGIN_FACT_ID } from "@gongyuai/contracts";
import { openHistory, writeEvidenceFile } from "@gongyuai/history";
import {
  allowedToolNames,
  asGraphPhase,
  handleGraphTool,
  syncGraphPhase,
} from "./graph-phase.js";
import type { CheckpointState } from "./checkpoint.js";

function tmpState(phase: CheckpointState["phase"] = "bootstrap"): CheckpointState {
  return {
    phase,
    step: 0,
    toolCalls: 0,
    installs: 0,
    tokens: 0,
    relayGeneration: 0,
    tokensSinceRelay: 0,
    toolCallsSinceRelay: 0,
    activeIntentId: null,
    activeIntentClaimedAt: null,
    lastSoftToolMilestone: 0,
    lastSoftWallMilestone: 0,
    toolsAtIntentClaim: null,
    lastSoftSurfaceMilestone: 0,
    pendingSoftPaceMessage: null,
    lastError: null,
    updatedAt: new Date().toISOString(),
  };
}

test("syncGraphPhase enforces Reason mutex when open Intents exist", () => {
  const root = mkdtempSync(join(tmpdir(), "gy-phase-"));
  const history = openHistory({
    dbPath: join(root, "h.sqlite"),
    evidenceDir: join(root, "evidence"),
  });
  try {
    const taskId = "t1";
    history.seedGoals(taskId, [
      {
        id: "g1",
        title: "g",
        description: "d",
        evidencePatterns: ["x.txt"],
        passes: false,
        evidencePaths: [],
        assertedAt: null,
      },
    ]);
    history.proposeIntent({
      taskId,
      title: "probe",
      sourceFactIds: [ORIGIN_FACT_ID],
    });
    assert.equal(syncGraphPhase(history, taskId, "reason"), "explore");
    assert.equal(syncGraphPhase(history, taskId, "bootstrap"), "explore");
    assert.equal(asGraphPhase("loop"), "bootstrap");
  } finally {
    history.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("bootstrap tool allowlist excludes shell; explore includes it", () => {
  assert.equal(allowedToolNames("bootstrap").has("shell"), false);
  assert.equal(allowedToolNames("bootstrap").has("intent_propose"), true);
  assert.equal(allowedToolNames("bootstrap").has("asset_record"), true);
  assert.equal(allowedToolNames("bootstrap").has("asset_search"), true);
  assert.equal(allowedToolNames("explore").has("asset_list"), true);
  assert.equal(allowedToolNames("explore").has("asset_search"), true);
  assert.equal(allowedToolNames("explore").has("shell"), true);
  assert.equal(allowedToolNames("reason").has("shell"), false);
  assert.equal(allowedToolNames("reason").has("asset_search"), false);
  assert.equal(allowedToolNames("reason").has("assert_goal"), true);
});

test("intent_claim then conclude advances to reason when no open Intents", () => {
  const root = mkdtempSync(join(tmpdir(), "gy-phase-"));
  const history = openHistory({
    dbPath: join(root, "h.sqlite"),
    evidenceDir: join(root, "evidence"),
  });
  const state = tmpState("explore");
  try {
    const taskId = "t2";
    history.seedGoals(taskId, [
      {
        id: "g1",
        title: "g",
        description: "d",
        evidencePatterns: ["x.txt"],
        passes: false,
        evidencePaths: [],
        assertedAt: null,
      },
    ]);
    const intent = history.proposeIntent({
      taskId,
      title: "one",
      sourceFactIds: [ORIGIN_FACT_ID],
    });
    const ctx = {
      history,
      taskId,
      workspaceDir: root,
      state,
      save: () => {},
    };
    const claimed = handleGraphTool("intent_claim", { intentId: intent.id }, ctx);
    assert.ok(claimed && !claimed.startsWith("denied"));
    assert.equal(state.activeIntentId, intent.id);

    const deniedReason = handleGraphTool(
      "phase_set",
      { phase: "reason" },
      { ...ctx, state },
    );
    assert.match(deniedReason ?? "", /Reason 互斥/);

    const done = handleGraphTool(
      "intent_conclude",
      {
        intentId: intent.id,
        status: "succeeded",
        conclusion: "ok",
        factsJson: JSON.stringify([{ layer: "title", title: "found" }]),
      },
      ctx,
    );
    assert.ok(done && !done.startsWith("错误"));
    assert.equal(state.activeIntentId, null);
    assert.equal(state.phase, "reason");
  } finally {
    history.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("finding tools are phase-gated: explore/reason write, bootstrap read-only", () => {
  const explore = allowedToolNames("explore");
  const reason = allowedToolNames("reason");
  const bootstrap = allowedToolNames("bootstrap");
  for (const name of ["finding_record", "finding_verify", "finding_retract"]) {
    assert.ok(explore.has(name), `explore should allow ${name}`);
    assert.ok(reason.has(name), `reason should allow ${name}`);
    assert.ok(!bootstrap.has(name), `bootstrap must deny ${name}`);
  }
  assert.ok(bootstrap.has("finding_list"));
  assert.ok(allowedToolNames("report").has("finding_list"));
});

test("finding_record → verify → retract through handleGraphTool", () => {
  const root = mkdtempSync(join(tmpdir(), "gy-phase-find-"));
  const history = openHistory({
    dbPath: join(root, "h.sqlite"),
    evidenceDir: join(root, "evidence"),
  });
  const state = tmpState("explore");
  try {
    const taskId = "t-find";
    const ctx = { history, taskId, workspaceDir: root, state, save: () => {} };

    const bad = handleGraphTool(
      "finding_record",
      { title: "x", asset: "a.com", vulnClass: "CWE-89", severity: "urgent" },
      ctx,
    );
    assert.match(bad ?? "", /invalid severity/);

    const recorded = JSON.parse(
      handleGraphTool(
        "finding_record",
        {
          title: "SQLi",
          asset: "https://a.com/login",
          vulnClass: "CWE-89",
          severity: "high",
          endpoint: "/login",
        },
        ctx,
      )!,
    ) as { finding: { id: string; status: string; asset: string }; created: boolean };
    assert.equal(recorded.created, true);
    assert.equal(recorded.finding.status, "tentative");
    assert.equal(recorded.finding.asset, "a.com");

    const dup = JSON.parse(
      handleGraphTool(
        "finding_record",
        { title: "SQLi again", asset: "a.com", vulnClass: "CWE-89", severity: "high", endpoint: "/login" },
        ctx,
      )!,
    ) as { created: boolean; finding: { id: string } };
    assert.equal(dup.created, false);
    assert.equal(dup.finding.id, recorded.finding.id);

    const noEvidence = handleGraphTool(
      "finding_verify",
      { findingId: recorded.finding.id, evidencePaths: "", repro: "steps" },
      ctx,
    );
    assert.match(noEvidence ?? "", /≥1 evidence/);

    writeEvidenceFile(join(root, "evidence"), "findings/sqli.txt", "proof\n");
    const verified = JSON.parse(
      handleGraphTool(
        "finding_verify",
        {
          findingId: recorded.finding.id,
          evidencePaths: "findings/sqli.txt",
          repro: "curl -d \"user='\" https://a.com/login",
        },
        ctx,
      )!,
    ) as { status: string; evidence: Array<{ sha256: string }> };
    assert.equal(verified.status, "verified");
    assert.equal(verified.evidence.length, 1);

    const listed = JSON.parse(handleGraphTool("finding_list", {}, ctx)!) as {
      count: number;
      findings: Array<{ status: string }>;
    };
    assert.equal(listed.count, 1);
    assert.equal(listed.findings[0]!.status, "verified");

    const retracted = JSON.parse(
      handleGraphTool(
        "finding_retract",
        { findingId: recorded.finding.id, reason: "误报" },
        ctx,
      )!,
    ) as { status: string };
    assert.equal(retracted.status, "retracted");
  } finally {
    history.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("engagement_audit is read-only and visible in every phase", () => {
  const root = mkdtempSync(join(tmpdir(), "gy-audit-tool-"));
  const history = openHistory({
    dbPath: join(root, "h.sqlite"),
    evidenceDir: join(root, "evidence"),
  });
  try {
    const taskId = "t-audit";
    const seed = history.recordAsset({
      taskId,
      address: "lab.example.com",
      auth: { targets: ["*.example.com"], outOfScope: [] },
      live: true,
    }).fact;
    for (let i = 0; i < 3; i += 1) {
      const proposed = history.proposeIntent({
        taskId,
        title: `sqli-${i}`,
        sourceFactIds: [seed.id],
        technique: "CWE-89",
        assetRoot: "lab.example.com",
      });
      history.claimIntent(taskId, proposed.id, "worker-test");
      history.concludeIntent(taskId, proposed.id, "failed", "no injection point");
    }

    const before = history.listIntents(taskId).length;
    const factsBefore = history.listFacts(taskId).length;
    const text = handleGraphTool("engagement_audit", {}, {
      history,
      taskId,
      workspaceDir: root,
      state: tmpState("reason"),
      save: () => {},
    });
    assert.ok(text);
    const audit = JSON.parse(text) as {
      observations: Array<{ code: string }>;
      scorecard: { intents: { failed: number }; findings: { gaps: string[] } };
    };
    assert.equal(audit.scorecard.intents.failed, 3);
    assert.ok(audit.observations.some((item) => item.code === "repeat-failure"));
    assert.ok(audit.scorecard.findings.gaps.length > 0);
    // No writes: the audit is a projection, not a Fact / Intent.
    assert.equal(history.listIntents(taskId).length, before);
    assert.equal(history.listFacts(taskId).length, factsBefore);
    assert.equal(allowedToolNames("bootstrap").has("engagement_audit"), true);
    assert.equal(allowedToolNames("explore").has("engagement_audit"), true);
    assert.equal(allowedToolNames("reason").has("engagement_audit"), true);
  } finally {
    history.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("finding_validate refuses self-validation and accepts an independent worker", () => {
  const root = mkdtempSync(join(tmpdir(), "gy-validation-tool-"));
  const history = openHistory({
    dbPath: join(root, "h.sqlite"),
    evidenceDir: join(root, "evidence"),
  });
  try {
    const taskId = "t-validation";
    writeEvidenceFile(join(root, "evidence"), "proof.txt", "proof\n");
    const { finding } = history.recordFinding({
      taskId,
      title: "sqli",
      asset: "lab.example.com",
      vulnClass: "CWE-89",
      severity: "high",
    });
    history.verifyFinding(taskId, finding.id, {
      evidencePaths: ["proof.txt"],
      repro: "curl …",
      verifiedBy: "worker-test",
    });

    const self = handleGraphTool("finding_validate", {
      findingId: finding.id,
      verdict: "confirmed",
      method: "replay",
      evidencePaths: "proof.txt",
    }, {
      history,
      taskId,
      workspaceDir: root,
      state: tmpState("reason"),
      workerId: "worker-test",
      save: () => {},
    });
    assert.match(self ?? "", /self-validation refused/);

    const other = handleGraphTool("finding_validate", {
      findingId: finding.id,
      verdict: "confirmed",
      method: "replay",
      evidencePaths: "proof.txt",
    }, {
      history,
      taskId,
      workspaceDir: root,
      state: tmpState("reason"),
      workerId: "worker-b",
      save: () => {},
    });
    const parsed = JSON.parse(other ?? "{}") as {
      validation: { verdict: string; independent: boolean };
    };
    assert.equal(parsed.validation.verdict, "confirmed");
    assert.equal(parsed.validation.independent, true);
    assert.equal(history.listFindingValidations(taskId, finding.id).length, 1);
  } finally {
    history.close();
    rmSync(root, { recursive: true, force: true });
  }
});

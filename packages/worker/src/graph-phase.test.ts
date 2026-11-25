import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import { ORIGIN_FACT_ID } from "@gongyuai/contracts";
import { openHistory, writeEvidenceFile } from "@gongyuai/history";
import {
  activeFindingWindows,
  clearTrafficRing,
  closeTrafficDb,
  countTrafficExchanges,
  getTraffic,
  pushTrafficRing,
} from "@gongyuai/exec";
import {
  allowedToolNames,
  asGraphPhase,
  executionIntentDenial,
  executionRequiresActiveIntent,
  handleGraphTool,
  syncGraphPhase,
} from "./graph-phase.js";
import type { CheckpointState } from "./checkpoint.js";

function tmpState(phase: CheckpointState["phase"] = "bootstrap"): CheckpointState {
  return {
    phase,
    step: 0,
    round: 0,
    bootEpoch: 0,
    toolCalls: 0,
    installs: 0,
    tokens: 0,
    relayGeneration: 0,
    lastRelaySnapshotStep: 0,
    tokensSinceRelay: 0,
    toolCallsSinceRelay: 0,
    activeIntentId: null,
    activeIntentClaimedAt: null,
    lastSoftToolMilestone: 0,
    lastSoftWallMilestone: 0,
    toolsAtIntentClaim: null,
    lastSoftSurfaceMilestone: 0,
    pendingSoftPaceMessage: null,
    observeFingerprint: {},
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
      history.concludeIntent(taskId, proposed.id, "failed", "no injection point", { workerId: "worker-test" });
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

test("execution tools require an active claimed Intent; read-only polls are exempt", () => {
  const root = mkdtempSync(join(tmpdir(), "gy-exec-intent-"));
  const history = openHistory({
    dbPath: join(root, "h.sqlite"),
    evidenceDir: join(root, "evidence"),
  });
  const state = tmpState("explore");
  try {
    const taskId = "t-exec";
    const intent = history.proposeIntent({
      taskId,
      title: "probe",
      sourceFactIds: [ORIGIN_FACT_ID],
    });
    history.claimIntent(taskId, intent.id, "worker-a");

    assert.equal(executionRequiresActiveIntent("shell"), true);
    assert.equal(executionRequiresActiveIntent("mcp__nmap__scan"), true);
    assert.equal(executionRequiresActiveIntent("shell_job", { action: "poll" }), false);
    assert.equal(executionRequiresActiveIntent("shell_job", { action: "start" }), true);
    assert.equal(executionRequiresActiveIntent("c2", { action: "sessions" }), false);
    assert.equal(executionRequiresActiveIntent("c2", { action: "task" }), true);
    assert.equal(executionRequiresActiveIntent("finding_record"), false);

    const base = { history, taskId, workerId: "worker-a", state, name: "shell" };
    assert.match(executionIntentDenial(base) ?? "", /active claimed Intent/);

    state.activeIntentId = intent.id;
    assert.equal(executionIntentDenial(base), undefined);
    assert.match(
      executionIntentDenial({ ...base, workerId: "worker-b" }) ?? "",
      /claimed by worker-a/,
    );
  } finally {
    history.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("phase_set(explore) refuses zero open Intent; conclude enforces active + owner", () => {
  const root = mkdtempSync(join(tmpdir(), "gy-phase-hard-"));
  const history = openHistory({
    dbPath: join(root, "h.sqlite"),
    evidenceDir: join(root, "evidence"),
  });
  const state = tmpState("bootstrap");
  try {
    const taskId = "t-hard";
    const ctx = {
      history,
      taskId,
      workspaceDir: root,
      state,
      workerId: "worker-a",
      leader: true,
      workerCount: 1,
      save: () => {},
    };

    assert.match(
      handleGraphTool("phase_set", { phase: "explore" }, ctx) ?? "",
      /requires ≥1 open Intent/,
    );

    const intent = history.proposeIntent({
      taskId,
      title: "one",
      sourceFactIds: [ORIGIN_FACT_ID],
    });
    assert.ok(handleGraphTool("phase_set", { phase: "explore" }, ctx));

    history.claimIntent(taskId, intent.id, "worker-a");
    assert.throws(
      () => history.concludeIntent(taskId, intent.id, "failed", "no", { workerId: "worker-b" }),
      /conclude denied/,
    );

    assert.match(
      handleGraphTool("intent_conclude", { intentId: intent.id, status: "failed", conclusion: "no" }, ctx) ?? "",
      /conclude only active Intent/,
    );

    state.activeIntentId = intent.id;
    const done = handleGraphTool(
      "intent_conclude",
      { intentId: intent.id, status: "failed", conclusion: "no" },
      ctx,
    );
    assert.ok(done && !done.startsWith("denied"));
    assert.equal(state.activeIntentId, null);
  } finally {
    history.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("multi-worker leader delegates execution; follower cannot enter Reason", () => {
  const root = mkdtempSync(join(tmpdir(), "gy-role-hard-"));
  const history = openHistory({
    dbPath: join(root, "h.sqlite"),
    evidenceDir: join(root, "evidence"),
  });
  const state = tmpState("explore");
  try {
    const taskId = "t-role";
    const intent = history.proposeIntent({
      taskId,
      title: "one",
      sourceFactIds: [ORIGIN_FACT_ID],
    });
    const leaderCtx = {
      history,
      taskId,
      workspaceDir: root,
      state,
      workerId: "leader",
      leader: true,
      workerCount: 2,
      save: () => {},
    };
    assert.match(
      handleGraphTool("intent_claim", { intentId: intent.id }, leaderCtx) ?? "",
      /leader delegates Explore/,
    );

    const followerCtx = { ...leaderCtx, workerId: "follower", leader: false };
    assert.match(
      handleGraphTool("phase_set", { phase: "reason" }, followerCtx) ?? "",
      /follower only Explore/,
    );

    // Follower claims and concludes the last open Intent: must remain in explore and NOT grab Reason lease.
    const followerState = tmpState("explore");
    const activeFollowerCtx = {
      ...followerCtx,
      state: followerState,
      execution: { reasonLeaseMs: 60_000 },
    };
    const claimed = handleGraphTool("intent_claim", { intentId: intent.id }, activeFollowerCtx);
    assert.ok(claimed && !claimed.startsWith("denied"));
    const concluded = handleGraphTool(
      "intent_conclude",
      { intentId: intent.id, status: "failed", conclusion: "checked" },
      activeFollowerCtx,
    );
    assert.ok(concluded && !concluded.startsWith("denied"));
    assert.equal(followerState.phase, "explore", "follower must stay in explore after concluding last intent");
    assert.equal(history.getReasonLease(taskId), null, "follower must not acquire Reason lease");

    // Once open Intents drain, multi-worker leader wakes from explore into reason; follower stays explore.
    assert.equal(syncGraphPhase(history, taskId, "explore", { leader: true, workerCount: 2 }), "reason");
    assert.equal(syncGraphPhase(history, taskId, "reason", { leader: false, workerCount: 2 }), "explore");

    // tsecbench is accessible across bootstrap / explore / reason; single-worker claim='true' enters Explore in one step.
    assert.equal(allowedToolNames("bootstrap").has("tsecbench"), true);
    assert.equal(allowedToolNames("explore").has("tsecbench"), true);
    assert.equal(allowedToolNames("reason").has("tsecbench"), true);

    const soloState = tmpState("bootstrap");
    const soloOut = JSON.parse(
      handleGraphTool(
        "intent_propose",
        { title: "fast probe", sourceFactIds: ORIGIN_FACT_ID, claim: "true" },
        { history, taskId, workspaceDir: root, state: soloState, workerId: "solo", leader: true, workerCount: 1, save: () => {} },
      ) ?? "{}",
    ) as { id: string; status: string; autoClaimed?: boolean };
    assert.equal(soloOut.autoClaimed, true);
    assert.equal(soloOut.status, "claimed");
    assert.equal(soloState.phase, "explore");
    assert.equal(soloState.activeIntentId, soloOut.id);
  } finally {
    history.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("finding_record/verify/retract persist ring traffic around the finding and drive the post-window", () => {
  const root = mkdtempSync(join(tmpdir(), "gy-phase-traffic-"));
  const history = openHistory({ dbPath: join(root, "h.sqlite"), evidenceDir: join(root, "evidence") });
  const state = tmpState("explore");
  const taskId = "6460e5ec-1a8c-4b95-b4e3-d77a02c79680";
  const ringId = (n: number) => `99999999-9999-4999-8999-${String(n).padStart(12, "0")}`;
  const push = (n: number, host: string) => pushTrafficRing(root, {
    id: ringId(n),
    write: {
      taskId,
      method: "POST",
      url: `https://${host}/login`,
      host,
      path: "/login",
      status: 200,
      durationMs: 3,
      startedAt: new Date().toISOString(),
      reqHeaders: { "content-type": "application/x-www-form-urlencoded" },
      resHeaders: { "content-type": "text/html" },
    },
    reqBody: { head: Buffer.from(`user=probe-${n}`), size: 12, sha256: "1".repeat(64) },
  });
  try {
    push(1, "a.com");
    push(2, "other.com");
    push(3, "a.com");
    const ctx = { history, taskId, workspaceDir: root, state, save: () => {}, trafficDir: root };
    const recorded = JSON.parse(handleGraphTool("finding_record", {
      title: "SQLi",
      asset: "https://a.com/login",
      vulnClass: "CWE-89",
      severity: "high",
      endpoint: "/login",
      trafficIds: `http:${ringId(2)}`,
    }, ctx)!) as {
      finding: { id: string; trafficIds?: string[] };
      traffic: { trafficIds: string[]; promoted: number; window: { host?: string; remaining: number } | null };
    };
    // Same host (1, 3) plus the explicitly named exchange on another host (2).
    assert.deepEqual(new Set(recorded.traffic.trafficIds), new Set([ringId(1), ringId(2), ringId(3)]));
    assert.equal(recorded.traffic.promoted, 3);
    assert.equal(recorded.traffic.window?.host, "a.com");
    assert.equal(recorded.traffic.window?.remaining, 30);
    assert.deepEqual(new Set(recorded.finding.trafficIds), new Set([ringId(1), ringId(2), ringId(3)]));
    assert.deepEqual(getTraffic(root, ringId(1))?.findingIds, [recorded.finding.id]);
    assert.equal(countTrafficExchanges(root), 3);

    writeEvidenceFile(join(root, "evidence"), "findings/sqli.txt", "proof\n");
    push(4, "a.com");
    const verified = JSON.parse(handleGraphTool("finding_verify", {
      findingId: recorded.finding.id,
      evidencePaths: "findings/sqli.txt",
      repro: "replay login",
    }, ctx)!) as { status: string; trafficIds?: string[]; traffic: { window: { remaining: number } | null } };
    assert.equal(verified.status, "verified");
    assert.ok(verified.trafficIds?.includes(ringId(4)));
    assert.equal(verified.traffic.window?.remaining, 5);

    handleGraphTool("finding_retract", { findingId: recorded.finding.id, reason: "误报" }, ctx);
    assert.deepEqual(activeFindingWindows(root), []);

    // No trafficDir: finding tools behave exactly as before (no traffic key).
    const plain = JSON.parse(handleGraphTool("finding_record", {
      title: "XSS",
      asset: "a.com",
      vulnClass: "CWE-79",
      severity: "low",
    }, { history, taskId, workspaceDir: root, state, save: () => {} })!) as Record<string, unknown>;
    assert.equal("traffic" in plain, false);
  } finally {
    clearTrafficRing(root);
    closeTrafficDb(root);
    history.close();
    rmSync(root, { recursive: true, force: true });
  }
});

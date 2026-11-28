import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { ORIGIN_FACT_ID } from "@gongyuai/contracts";
import { openHistory, writeEvidenceFile } from "@gongyuai/history";
import type { CheckpointState } from "./checkpoint.js";
import {
  BREAKTHROUGH_RENEWAL_MS,
  TIERED_STALL_MS,
  lastVerifiedEvidenceAt,
  latestInstanceBoundaryAt,
  maybeForceEvidenceStall,
  resolveAdaptiveStallMs,
} from "./evidence-rotation.js";
import { handleGraphTool } from "./graph-phase.js";
import { consultTool } from "./ops-tools.js";

function state(partial: Partial<CheckpointState> = {}): CheckpointState {
  return {
    phase: "explore",
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
    ...partial,
  };
}

const AUTH = {
  targets: ["10.0.0.0/8"],
  outOfScope: [] as string[],
  pivotPolicy: { mode: "off" as const, cidrs: [] as string[] },
};

function setup() {
  const root = mkdtempSync(join(tmpdir(), "gy-ev-"));
  const dbPath = join(root, "h.sqlite");
  const history = openHistory({ dbPath, evidenceDir: join(root, "evidence") });
  return { root, dbPath, history };
}

test("evidence stall force-concludes a stale surface (relay-safe: no checkpoint claim)", () => {
  const { root, history } = setup();
  try {
    const taskId = "t-stall";
    const intent = history.proposeIntent({ taskId, title: "grind", sourceFactIds: [ORIGIN_FACT_ID] });
    history.claimIntent(taskId, intent.id, "w0");
    // Simulate post-relay checkpoint: activeIntentId kept, claim timestamp lost.
    const ckpt = state({ activeIntentId: intent.id, activeIntentClaimedAt: null, toolsAtIntentClaim: null });
    const result = maybeForceEvidenceStall({
      history, taskId, workerId: "w0", workspaceDir: root, state: ckpt,
      stallMs: 1000, save: () => {}, nowMs: Date.now() + 5000,
    });
    assert.equal(result.concluded, true);
    assert.equal(ckpt.activeIntentId, null);
    assert.equal(ckpt.phase, "reason");
  } finally {
    history.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("within stall window does not rotate (grace)", () => {
  const { root, history } = setup();
  try {
    const taskId = "t-grace";
    const intent = history.proposeIntent({ taskId, title: "fresh", sourceFactIds: [ORIGIN_FACT_ID] });
    history.claimIntent(taskId, intent.id, "w0");
    const ckpt = state({ activeIntentId: intent.id });
    const result = maybeForceEvidenceStall({
      history, taskId, workerId: "w0", workspaceDir: root, state: ckpt,
      stallMs: 1000, save: () => {}, nowMs: Date.now() + 200,
    });
    assert.equal(result.concluded, false);
    assert.equal(ckpt.activeIntentId, intent.id);
  } finally {
    history.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("no active intent is a no-op", () => {
  const { root, history } = setup();
  try {
    const ckpt = state({ activeIntentId: null });
    const result = maybeForceEvidenceStall({
      history, taskId: "t-none", workerId: "w0", workspaceDir: root, state: ckpt,
      stallMs: 1000, save: () => {}, nowMs: Date.now() + 99999,
    });
    assert.equal(result.concluded, false);
  } finally {
    history.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("fresh verified foothold persists an OLD intent (production: keep traction)", () => {
  const { root, dbPath, history } = setup();
  try {
    const taskId = "t-traction";
    const intent = history.proposeIntent({ taskId, title: "old-surface", sourceFactIds: [ORIGIN_FACT_ID] });
    history.claimIntent(taskId, intent.id, "w0");
    // Backdate the intent so it is "old" relative to fresh evidence.
    const old = new Date(Date.now() - 60_000).toISOString();
    const db = new DatabaseSync(dbPath);
    db.prepare("UPDATE intents SET created_at = ? WHERE id = ?").run(old, intent.id);
    db.close();
    // Fresh verified progress: a newly confirmed live foothold.
    history.recordAsset({ taskId, address: "10.0.0.9", auth: AUTH, live: true, summary: "foothold" });
    const ckpt = state({ activeIntentId: intent.id });
    const result = maybeForceEvidenceStall({
      history, taskId, workerId: "w0", workspaceDir: root, state: ckpt,
      stallMs: 1000, save: () => {}, nowMs: Date.now() + 200,
    });
    assert.equal(result.concluded, false); // fresh evidence anchors recency → persist
    assert.equal(ckpt.activeIntentId, intent.id);
  } finally {
    history.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("lastVerifiedEvidenceAt counts live foothold, ignores out-of-scope", () => {
  const { root, history } = setup();
  try {
    const taskId = "t-signal";
    assert.equal(lastVerifiedEvidenceAt(history, taskId), 0);
    history.recordAsset({ taskId, address: "10.0.0.9", auth: AUTH, live: true });
    const liveAt = lastVerifiedEvidenceAt(history, taskId);
    assert.ok(liveAt > 0);
    // Out-of-scope asset must not count as verified progress.
    history.recordAsset({ taskId, address: "192.0.2.7", auth: AUTH, live: true });
    assert.equal(lastVerifiedEvidenceAt(history, taskId), liveAt);
  } finally {
    history.close();
    rmSync(root, { recursive: true, force: true });
  }
});
/* ------------------------------------------------------------------ *
 * 边界用例：同面无新证据 vs 跨面新证据（lane D 补充）
 *
 * 当前实现（packages/worker/src/evidence-rotation.ts）的牵引信号是**任务级**的
 * 「最新 verified 证据」，不是按资产面（asset root）锚定。这三条用例把边界钉死：
 * - 同一面没有新的 verified 证据 → 必须换面；
 * - 同面只有 tentative 线索（未验证）→ 不算 traction，仍换面；
 * - 跨面出现新的 verified 证据 → 按当前任务级锚点会延续本面 Intent（已知边界，
 *   按面锚定需要改 evidence-rotation.ts，不在本轮写入范围，见 docs 台账「待联调验证」）。
 * ------------------------------------------------------------------ */

/** 把 Intent 的 created_at 提前，制造“这一面已经磨了很久”的时间锚点。 */
function backdateIntent(dbPath: string, intentId: string, msAgo: number): void {
  const db = new DatabaseSync(dbPath);
  db.prepare("UPDATE intents SET created_at = ? WHERE id = ?").run(
    new Date(Date.now() - msAgo).toISOString(),
    intentId,
  );
  db.close();
}

test("边界：同一资产面没有新 verified 证据 → 强制换面", () => {
  const { root, dbPath, history } = setup();
  try {
    const taskId = "t-same-surface-stall";
    const intent = history.proposeIntent({
      taskId,
      title: "同一面磨到底",
      sourceFactIds: [ORIGIN_FACT_ID],
      assetRoot: "10.0.0.0/8",
    });
    history.claimIntent(taskId, intent.id, "w0");
    backdateIntent(dbPath, intent.id, 120_000);
    const ckpt = state({ activeIntentId: intent.id });
    const result = maybeForceEvidenceStall({
      history, taskId, workerId: "w0", workspaceDir: root, state: ckpt,
      stallMs: 1000, save: () => {}, nowMs: Date.now(),
    });
    assert.equal(result.concluded, true);
    assert.equal(result.intentId, intent.id);
    assert.equal(ckpt.activeIntentId, null);
    assert.equal(ckpt.phase, "reason");
  } finally {
    history.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("边界：同面只有 tentative 线索不算 traction，仍换面", () => {
  const { root, dbPath, history } = setup();
  try {
    const taskId = "t-tentative-only";
    const intent = history.proposeIntent({
      taskId,
      title: "只有线索",
      sourceFactIds: [ORIGIN_FACT_ID],
      assetRoot: "10.0.0.0/8",
    });
    history.claimIntent(taskId, intent.id, "w0");
    backdateIntent(dbPath, intent.id, 120_000);
    // tentative 线索：写入时间是新的，但没有 verified 结论。
    const lead = history.recordFinding({
      taskId,
      title: "可能是 SQLi",
      asset: "10.0.0.9",
      vulnClass: "CWE-89",
      severity: "medium",
    });
    assert.equal(lead.finding.status, "tentative");
    const ckpt = state({ activeIntentId: intent.id });
    const result = maybeForceEvidenceStall({
      history, taskId, workerId: "w0", workspaceDir: root, state: ckpt,
      stallMs: 1000, save: () => {}, nowMs: Date.now(),
    });
    assert.equal(result.concluded, true);
    assert.equal(ckpt.activeIntentId, null);
  } finally {
    history.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("边界：跨面新 verified 证据不续命本面耗尽 Intent；同面 verified 证据正常续命", () => {
  const { root, dbPath, history } = setup();
  try {
    const taskId = "11111111-1111-4111-8111-111111111111";
    const intent = history.proposeIntent({
      taskId,
      title: "本面 exhausted",
      sourceFactIds: [ORIGIN_FACT_ID],
      assetRoot: "10.0.170.144",
    });
    history.claimIntent(taskId, intent.id, "w0");
    backdateIntent(dbPath, intent.id, 120_000);
    assert.equal(lastVerifiedEvidenceAt(history, taskId), 0);

    // 另一个资产面（不同靶机 10.0.171.200）产生了新的 verified 证据。
    const lead = history.recordFinding({
      taskId,
      title: "跨面 XSS",
      asset: "10.0.171.200",
      vulnClass: "CWE-79",
      severity: "high",
      endpoint: "/search",
    });
    writeEvidenceFile(join(root, "evidence"), "findings/xss.txt", "alert(1) reflected\n");
    const verified = history.verifyFinding(taskId, lead.finding.id, {
      evidencePaths: ["findings/xss.txt"],
      repro: "curl 'http://10.0.171.200/search?q=<script>'",
      verifiedBy: "w0",
    });
    assert.equal(verified.status, "verified");
    assert.ok(lastVerifiedEvidenceAt(history, taskId) > 0);
    assert.equal(lastVerifiedEvidenceAt(history, taskId, { assetRoot: "10.0.170.144" }), 0);

    const ckpt = state({ activeIntentId: intent.id });
    const result = maybeForceEvidenceStall({
      history, taskId, workerId: "w0", workspaceDir: root, state: ckpt,
      stallMs: 1000, save: () => {}, nowMs: Date.now(),
    });
    // 按资产面锚定：跨面 verified 证据不再阻止已耗尽的旧面 Intent 轮换。
    assert.equal(result.concluded, true);
    assert.equal(ckpt.activeIntentId, null);
    assert.equal(ckpt.phase, "reason");

    // 同一长 turn 内：force-conclude 后可立即 propose+claim 切入新攻击面，且 operator_consult 正常落库。
    const nextRaw = handleGraphTool(
      "intent_propose",
      {
        title: "切入新面 10.0.171.200",
        sourceFactIds: ORIGIN_FACT_ID,
        claim: "true",
      },
      {
        history,
        taskId,
        workspaceDir: root,
        state: ckpt,
        workerId: "w0",
        leader: true,
        workerCount: 1,
        save: () => {},
      },
    );
    const nextIntent = JSON.parse(nextRaw ?? "{}") as { id: string; autoClaimed?: boolean };
    assert.equal(nextIntent.autoClaimed, true);
    assert.equal(ckpt.phase, "explore");
    assert.equal(ckpt.activeIntentId, nextIntent.id);

    const consultOut = JSON.parse(
      consultTool(
        {
          manifest: {
            taskId,
            dataDir: root,
            historyDb: dbPath,
            durableDb: join(root, "d.sqlite"),
            evidenceDir: join(root, "evidence"),
            workspaceDir: root,
            auth: { authorizationNote: "", targets: ["10.0.0.0/8"], outOfScope: [], capability: "full" },
            scopeVersion: 1,
            goals: [],
            budget: { maxTokens: 0, maxWallMs: 0, maxToolCalls: 0, maxInstalls: 0, relayTokenThreshold: 30_000, relayMinToolCalls: 2 },
            execution: { maxConcurrentExplores: 3, maxIntentsPerReason: 4, maxIntentsPerAssetRoot: 2, exploreTimeoutMs: 900_000, reasonLeaseMs: 120_000 },
            workerId: "w0",
            workerSlot: 0,
            workerCount: 1,
            commandConfirmation: "auto",
            mock: true,
            mcpServers: [],
            mcpPool: [],
            mcpCatalog: [],
            skillPacks: [],
            skillPool: [],
            skillCatalog: [],
            assetCollectors: [],
          },
          history,
          workerId: "w0",
          activeIntentId: ckpt.activeIntentId,
        },
        { question: "需要确认目标测试账号范围", context: "post-rotation check" },
      ),
    ) as { ok: boolean; consultId: string };
    assert.equal(consultOut.ok, true);
    assert.equal(history.ops.listConsults(taskId).length, 1);
  } finally {
    history.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("graded stall extends grace window when active intent has recent substantive progress", () => {
  const { root, dbPath, history } = setup();
  try {
    const taskId = "t-graded-stall";
    const intent = history.proposeIntent({ taskId, title: "deep-analysis", sourceFactIds: [ORIGIN_FACT_ID] });
    history.claimIntent(taskId, intent.id, "w0");
    // Backdate intent creation by 20 minutes (past 15min stallMs).
    const now = Date.now();
    const db = new DatabaseSync(dbPath);
    db.prepare("UPDATE intents SET created_at = ? WHERE id = ?").run(
      new Date(now - 20 * 60_000).toISOString(),
      intent.id,
    );
    db.close();

    // Append a fresh Fact tied to the active Intent 1 minute ago (substantive progress).
    const fact = history.appendFact({
      taskId,
      layer: "summary",
      title: "Discovered internal admin endpoint",
      summary: "New lead under investigation",
      intentId: intent.id,
    });
    const db2 = new DatabaseSync(dbPath);
    db2.prepare("UPDATE facts SET created_at = ? WHERE id = ?").run(
      new Date(now - 60_000).toISOString(),
      fact.id,
    );
    db2.close();

    const ckpt = state({ activeIntentId: intent.id });
    const extended = maybeForceEvidenceStall({
      history, taskId, workerId: "w0", workspaceDir: root, state: ckpt,
      stallMs: 15 * 60_000, progressGraceMs: 5 * 60_000, save: () => {}, nowMs: now,
    });
    assert.equal(extended.concluded, false);
    assert.equal(extended.extended, true);
    assert.equal(ckpt.activeIntentId, intent.id);

    // Once past hardStallMs (2x stallMs = 30min), it still force-concludes so nothing hangs forever.
    const forced = maybeForceEvidenceStall({
      history, taskId, workerId: "w0", workspaceDir: root, state: ckpt,
      stallMs: 15 * 60_000, progressGraceMs: 5 * 60_000, save: () => {}, nowMs: now + 15 * 60_000,
    });
    assert.equal(forced.concluded, true);
    assert.equal(ckpt.activeIntentId, null);
  } finally {
    history.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("tiered stall escalates 12m → 30m → 45m across attempts, renews 20m on breakthrough, and grants 3-step Soft Drain rescuing factDraft", () => {
  const { root, dbPath, history } = setup();
  const prevEnv = process.env.GY_EVIDENCE_STALL_MS;
  delete process.env.GY_EVIDENCE_STALL_MS;
  try {
    const taskId = "t-tiered-drain";
    history.recordAsset({ taskId, address: "10.0.160.241", auth: AUTH, live: true });

    // Round 1 on 10.0.160.241 -> 12 min
    const i1 = history.proposeIntent({
      taskId,
      title: "round 1 sweep",
      sourceFactIds: [ORIGIN_FACT_ID],
      assetRoot: "10.0.160.241",
    });
    assert.equal(resolveAdaptiveStallMs(history, taskId, i1), TIERED_STALL_MS[0]);
    history.claimIntent(taskId, i1.id, "w1");
    history.forceConcludeExploreTimeout({ taskId, intentId: i1.id, workerId: "w1", reason: "r1 timeout" });

    // Round 2 on 10.0.160.241 -> 30 min
    const i2 = history.proposeIntent({
      taskId,
      title: "round 2 deep",
      sourceFactIds: [ORIGIN_FACT_ID],
      assetRoot: "10.0.160.241",
    });
    assert.equal(resolveAdaptiveStallMs(history, taskId, i2), TIERED_STALL_MS[1]);
    history.claimIntent(taskId, i2.id, "w1");
    history.forceConcludeExploreTimeout({ taskId, intentId: i2.id, workerId: "w1", reason: "r2 timeout" });

    // Round 3 on 10.0.160.241 -> 45 min
    const i3 = history.proposeIntent({
      taskId,
      title: "round 3 final",
      sourceFactIds: [ORIGIN_FACT_ID],
      assetRoot: "10.0.160.241",
    });
    assert.equal(resolveAdaptiveStallMs(history, taskId, i3), TIERED_STALL_MS[2]);

    // Breakthrough renewal: Round 1 (12m) gets +20m renewal when verified evidence lands mid-Intent
    const r1HostB = history.proposeIntent({
      taskId,
      title: "b-02 multi-stage",
      sourceFactIds: [ORIGIN_FACT_ID],
      assetRoot: "10.0.160.242",
    });
    history.claimIntent(taskId, r1HostB.id, "w2");
    const now = Date.now();
    backdateIntent(dbPath, r1HostB.id, 15 * 60_000);
    // Verified breakthrough landed 14 minutes ago (> 12m base R1 stall, < 20m BREAKTHROUGH_RENEWAL_MS!)
    const fLead = history.recordFinding({
      taskId,
      title: "Boundary SSRF",
      asset: "10.0.160.242",
      vulnClass: "CWE-918",
      severity: "high",
    });
    writeEvidenceFile(join(root, "evidence"), "findings/ssrf.txt", "file:///etc/passwd\n");
    history.verifyFinding(taskId, fLead.finding.id, {
      evidencePaths: ["findings/ssrf.txt"],
      repro: "curl http://10.0.160.242/proxy",
      verifiedBy: "w2",
    });
    const db = new DatabaseSync(dbPath);
    db.prepare("UPDATE findings SET verified_at = ? WHERE id = ?").run(
      new Date(now - 14 * 60_000).toISOString(),
      fLead.finding.id,
    );
    db.close();

    const ckptB = state({
      activeIntentId: r1HostB.id,
      factDraft: {
        title: "已拿 internal_admin_token",
        summary: "正通过跳板探测 172.19.0.4:8080，详见 workspace/scan.log",
        updatedAt: new Date(now).toISOString(),
      },
    });
    const renewed = maybeForceEvidenceStall({
      history, taskId, workerId: "w2", workspaceDir: root, state: ckptB,
      drainSteps: 3, save: () => {}, nowMs: now,
    });
    assert.equal(BREAKTHROUGH_RENEWAL_MS, 20 * 60_000);
    assert.equal(renewed.concluded, false);
    assert.equal(renewed.draining, undefined);
    assert.equal(ckptB.activeIntentId, r1HostB.id);

    // Advance past 20m renewal -> Soft Drain 3/3 -> 2/3 -> 1/3 -> Hard Conclude + rescue factDraft!
    const future = now + 7 * 60_000;
    const d1 = maybeForceEvidenceStall({
      history, taskId, workerId: "w2", workspaceDir: root, state: ckptB,
      drainSteps: 3, save: () => {}, nowMs: future,
    });
    assert.equal(d1.concluded, false);
    assert.equal(d1.draining, true);
    assert.equal(d1.drainStepsRemaining, 3);
    assert.equal(ckptB.activeIntentId, r1HostB.id);

    const d2 = maybeForceEvidenceStall({
      history, taskId, workerId: "w2", workspaceDir: root, state: ckptB,
      drainSteps: 3, save: () => {}, nowMs: future + 1000,
    });
    assert.equal(d2.concluded, false);
    assert.equal(d2.drainStepsRemaining, 2);

    const d3 = maybeForceEvidenceStall({
      history, taskId, workerId: "w2", workspaceDir: root, state: ckptB,
      drainSteps: 3, save: () => {}, nowMs: future + 2000,
    });
    assert.equal(d3.concluded, false);
    assert.equal(d3.drainStepsRemaining, 1);

    const finalConclude = maybeForceEvidenceStall({
      history, taskId, workerId: "w2", workspaceDir: root, state: ckptB,
      drainSteps: 3, save: () => {}, nowMs: future + 3000,
    });
    assert.equal(finalConclude.concluded, true);
    assert.equal(ckptB.activeIntentId, null);
    assert.equal(ckptB.factDraft, null);
    const rescued = history.listFacts(taskId).find((f) => f.tags.includes("draft-rescued"));
    assert.ok(rescued, "factDraft must be auto-rescued into History before reset");
    assert.equal(rescued.layer, "title");
    assert.match(rescued.title, /internal_admin_token/);
    assert.match(rescued.summary, /172\.19\.0\.4/);
    const observed = history.observe(taskId);
    assert.match(observed, new RegExp(rescued.id));
    assert.match(observed, /internal_admin_token/);
  } finally {
    if (prevEnv === undefined) delete process.env.GY_EVIDENCE_STALL_MS;
    else process.env.GY_EVIDENCE_STALL_MS = prevEnv;
    history.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("intent_conclude(failed) writes factDraft onto the Observe title layer", () => {
  const { root, history } = setup();
  try {
    const taskId = "t-draft-conclude";
    const intent = history.proposeIntent({
      taskId,
      title: "probe login",
      sourceFactIds: [ORIGIN_FACT_ID],
      assetRoot: "10.1.2.3",
      technique: "authn",
    });
    history.claimIntent(taskId, intent.id, "w1");
    const ckpt = state({
      activeIntentId: intent.id,
      phase: "explore",
      factDraft: {
        title: "测过 /login",
        summary: "POST /login 401 evidence/login.txt session=sh-9",
        evidencePath: "evidence/login.txt",
        updatedAt: new Date().toISOString(),
      },
    });
    const out = handleGraphTool(
      "intent_conclude",
      { intentId: intent.id, status: "failed", conclusion: "POST /login 401，产物 evidence/login.txt，会话 sh-9" },
      {
        history,
        taskId,
        workspaceDir: root,
        state: ckpt,
        workerId: "w1",
        leader: false,
        workerCount: 2,
        save: () => {},
      },
    );
    assert.ok(out && !out.startsWith("错误") && !out.startsWith("denied"), out ?? "");
    const fact = history.listFacts(taskId).find((item) => item.tags.includes("draft-rescued"));
    assert.ok(fact);
    assert.equal(fact.layer, "title");
    assert.equal(fact.evidencePath, "evidence/login.txt");
    const observed = history.observe(taskId);
    assert.match(observed, new RegExp(fact.id));
    assert.match(observed, /测过 \/login/);
    assert.match(observed, /POST \/login 401/);
    assert.match(observed, /authn @10\.1\.2\.3/);
  } finally {
    history.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("instance-boundary resets the tiered timebox to 12m and drops pre-boundary evidence", () => {
  const { root, dbPath, history } = setup();
  const prevEnv = process.env.GY_EVIDENCE_STALL_MS;
  delete process.env.GY_EVIDENCE_STALL_MS;
  try {
    const taskId = "t-boundary";
    const host = "10.0.160.241";
    const seeded = history.recordAsset({ taskId, address: host, auth: AUTH, live: true });
    const old = history.proposeIntent({
      taskId,
      title: "previous generation",
      sourceFactIds: [ORIGIN_FACT_ID],
      assetRoot: host,
    });
    history.claimIntent(taskId, old.id, "w1");
    history.forceConcludeExploreTimeout({ taskId, intentId: old.id, workerId: "w1", reason: "old box" });
    const lead = history.recordFinding({
      taskId,
      title: "old foothold",
      asset: host,
      vulnClass: "CWE-200",
      severity: "low",
    });
    writeEvidenceFile(join(root, "evidence"), "findings/old.txt", "old\n");
    history.verifyFinding(taskId, lead.finding.id, {
      evidencePaths: ["findings/old.txt"],
      repro: "curl",
      verifiedBy: "w1",
    });
    const db = new DatabaseSync(dbPath);
    const staleAt = new Date(Date.now() - 3_600_000).toISOString();
    db.prepare("UPDATE findings SET verified_at = ? WHERE id = ?").run(staleAt, lead.finding.id);
    db.prepare("UPDATE facts SET created_at = ? WHERE id = ?").run(staleAt, seeded.fact.id);
    db.close();
    history.appendFact({
      taskId,
      layer: "title",
      title: `容器实例代际切换：${host}`,
      summary: "recycled",
      tags: ["instance-boundary", `asset.addr:${host}`],
    });
    const boundary = latestInstanceBoundaryAt(history, taskId, host);
    assert.ok(boundary > Date.now() - 60_000);
    assert.equal(lastVerifiedEvidenceAt(history, taskId, { assetRoot: host }), 0);
    assert.ok(lastVerifiedEvidenceAt(history, taskId) > 0);
    const next = history.proposeIntent({
      taskId,
      title: "new generation",
      sourceFactIds: [ORIGIN_FACT_ID],
      assetRoot: host,
    });
    assert.equal(resolveAdaptiveStallMs(history, taskId, next), TIERED_STALL_MS[0]);
    const fresh = history.recordFinding({
      taskId,
      title: "new generation foothold",
      asset: host,
      vulnClass: "CWE-918",
      severity: "high",
    });
    writeEvidenceFile(join(root, "evidence"), "findings/new.txt", "new\n");
    history.verifyFinding(taskId, fresh.finding.id, {
      evidencePaths: ["findings/new.txt"],
      repro: "curl",
      verifiedBy: "w1",
    });
    assert.ok(lastVerifiedEvidenceAt(history, taskId, { assetRoot: host }) >= boundary);
  } finally {
    if (prevEnv === undefined) delete process.env.GY_EVIDENCE_STALL_MS;
    else process.env.GY_EVIDENCE_STALL_MS = prevEnv;
    history.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("evidence stall 超时强制结项自动写入保底 tactical_lesson（不白跑）", () => {
  const { root, history } = setup();
  try {
    const taskId = "t-stall-lesson";
    const intent = history.proposeIntent({
      taskId,
      title: "grind nginx admin",
      sourceFactIds: [ORIGIN_FACT_ID],
      assetRoot: "10.0.0.10",
      technique: "dirb",
    });
    history.claimIntent(taskId, intent.id, "w0");
    const ckpt = state({
      activeIntentId: intent.id,
      factDraft: {
        title: "partial admin sweep",
        summary: "只拿到 404 与登录页，无有效路径",
        evidencePath: "exec/step-1.md",
        updatedAt: new Date().toISOString(),
      },
    });
    const result = maybeForceEvidenceStall({
      history,
      taskId,
      workerId: "w0",
      workspaceDir: root,
      state: ckpt,
      stallMs: 1000,
      save: () => {},
      nowMs: Date.now() + 5000,
    });
    assert.equal(result.concluded, true);
    assert.equal(history.hasTacticalLessonForIntent(taskId, intent.id), true);
    const lessons = history.recallTacticalLessons(taskId, { assetRoot: "10.0.0.10" })
      .exactAssetLessons;
    assert.equal(lessons.length, 1);
    assert.equal(lessons[0]!.intentId, intent.id);
    assert.match(lessons[0]!.falsifiedHypotheses[0]!.commandEvidence, /exec\/step-1\.md/);
    assert.match(lessons[0]!.nextPivotAdvice, /正交 technique/);
  } finally {
    history.close();
    rmSync(root, { recursive: true, force: true });
  }
});

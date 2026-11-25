import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ORIGIN_FACT_ID, type WorkerManifest } from "@gongyuai/contracts";
import { openHistory } from "@gongyuai/history";
import { CheckpointStore } from "./checkpoint.js";
import {
  buildObserveSnapshot,
  buildTurnObserveBlock,
  OBSERVE_FACT_LIMIT,
  renderObserveDelta,
  sessionBootstrapText,
} from "./pi-loop.js";
import { writeRelayProtocol } from "./relay.js";

function manifest(workspaceDir: string): WorkerManifest {
  return {
    taskId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    dataDir: workspaceDir,
    historyDb: join(workspaceDir, "h.sqlite"),
    durableDb: join(workspaceDir, "d.sqlite"),
    evidenceDir: join(workspaceDir, "evidence"),
    workspaceDir,
    auth: {
      authorizationNote: "observe unit test auth note",
      targets: ["10.0.0.0/8"],
      outOfScope: [],
      capability: "full",
    },
    scopeVersion: 1,
    goals: [],
    budget: { maxTokens: 0, maxWallMs: 0, maxToolCalls: 0, maxInstalls: 0, relayTokenThreshold: 30_000, relayMinToolCalls: 2 },
    execution: { maxConcurrentExplores: 1, maxIntentsPerReason: 4, maxIntentsPerAssetRoot: 2, exploreTimeoutMs: 900_000, reasonLeaseMs: 120_000 },
    workerId: "w0",
    workerSlot: 0,
    commandConfirmation: "auto",
    workerCount: 1,
    mock: true,
    mcpServers: [],
    mcpPool: [],
    mcpCatalog: [],
    skillPacks: [],
    skillPool: [],
    skillCatalog: [],
    assetCollectors: [],
  };
}

const AUTH = { targets: ["10.0.0.0/8"], outOfScope: [] as string[], pivotPolicy: { mode: "off" as const, cidrs: [] as string[] } };

test("renderObserveDelta：无变更只给一句提示，不全量重注", () => {
  const snap = { "goal:g1": "[未通过] g", "asset:10.0.0.5": "[admitted] 10.0.0.5" };
  const block = renderObserveDelta(snap, { ...snap });
  assert.match(block, /无新增\/变更/);
  assert.doesNotMatch(block, /10\.0\.0\.5/);
  assert.doesNotMatch(block, /## Session Relay/);
});

test("renderObserveDelta：只列新增/变更实体，按类分组并封顶", () => {
  const prev = { "goal:g1": "[未通过] g", "intent:i1": "(proposed) probe", "asset:10.0.0.5": "[admitted] 10.0.0.5" };
  const cur = {
    "goal:g1": "[通过] g", // changed
    "intent:i1": "(running) probe", // changed
    "asset:10.0.0.5": "[admitted] 10.0.0.5", // unchanged → omitted
    "asset:10.0.0.6": "[admitted] 10.0.0.6", // new
    "finding:f1": "(tentative/high) IDOR", // new
  };
  const block = renderObserveDelta(cur, prev);
  assert.match(block, /\[g1\] \[通过\] g/);
  assert.match(block, /\[i1\] \(running\) probe/);
  assert.match(block, /\[10\.0\.0\.6\]/);
  assert.match(block, /\[f1\] \(tentative\/high\) IDOR/);
  assert.doesNotMatch(block, /10\.0\.0\.5/); // unchanged asset not re-injected
  assert.doesNotMatch(block, /## Session Relay/);

  // Cap: more than 50 changed entities → bounded with a drill-down note.
  const big: Record<string, string> = {};
  for (let i = 0; i < 80; i++) big[`asset:10.1.0.${i}`] = `[admitted] 10.1.0.${i}`;
  const capped = renderObserveDelta(big, {});
  assert.match(capped, /另有 30 项变更未展开/);
});

test("sessionBootstrapText：活会话续跑不注入 π 交接块；冷启动默认注入", () => {
  const root = mkdtempSync(join(tmpdir(), "gy-obs-"));
  const m = manifest(root);
  const history = openHistory({ dbPath: m.historyDb, evidenceDir: m.evidenceDir });
  try {
    writeRelayProtocol(m, history, { trigger: "auto", reason: "x", foothold: "ssh 10.0.0.5", tokens: 1, toolCalls: 2, generation: 0 });
    const observe = history.observe(m.taskId);
    const cold = sessionBootstrapText(m, observe);
    assert.match(cold, /## Session Relay/);
    const live = sessionBootstrapText(m, observe, { includeRelays: false });
    assert.doesNotMatch(live, /## Session Relay/);
    assert.equal(live, observe);
  } finally {
    history.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("buildTurnObserveBlock：round>1 续跑增量去重，不含 Session Relay，重复状态不全量重注", () => {
  const root = mkdtempSync(join(tmpdir(), "gy-obs-"));
  const m = manifest(root);
  const history = openHistory({ dbPath: m.historyDb, evidenceDir: m.evidenceDir });
  const ckpt = new CheckpointStore(join(root, "c.sqlite"));
  const state = ckpt.load();
  try {
    history.seedGoals(m.taskId, [
      { id: "g1", title: "g", description: "d", evidencePatterns: ["x.txt"], passes: false, evidencePaths: [], assertedAt: null },
    ]);
    history.recordAsset({ taskId: m.taskId, address: "10.0.0.5", auth: AUTH });
    history.proposeIntent({ taskId: m.taskId, title: "probe", sourceFactIds: [ORIGIN_FACT_ID] });
    writeRelayProtocol(m, history, { trigger: "auto", reason: "cold", foothold: "ssh 10.0.0.5", tokens: 1, toolCalls: 2, generation: 0 });

    // Round 1 (cold start): full Observe + π handoff block.
    const round1 = buildTurnObserveBlock(m, history, state, undefined, { incremental: false });
    assert.match(round1, /## Session Relay/);
    assert.match(round1, /## 目标/);
    assert.match(round1, /10\.0\.0\.5/);
    assert.ok(Object.keys(state.observeFingerprint).length > 0);

    // Round 2 (resume, no graph change): incremental dedup note, no handoff, much smaller.
    const round2 = buildTurnObserveBlock(m, history, state, undefined, { incremental: true });
    assert.doesNotMatch(round2, /## Session Relay/);
    assert.match(round2, /无新增\/变更/);
    assert.doesNotMatch(round2, /## 资产清单/);
    assert.ok(round2.length < round1.length);

    // Round 3 (resume, new asset): only the delta entity, still no handoff / full Observe.
    history.recordAsset({ taskId: m.taskId, address: "10.0.0.6", auth: AUTH });
    const round3 = buildTurnObserveBlock(m, history, state, undefined, { incremental: true });
    assert.doesNotMatch(round3, /## Session Relay/);
    assert.doesNotMatch(round3, /## 资产清单/);
    assert.match(round3, /10\.0\.0\.6/);
    assert.doesNotMatch(round3, /10\.0\.0\.5/); // unchanged asset not re-injected

    // Snapshot tracks the mutable entities for the next delta.
    const snap = buildObserveSnapshot(history, m.taskId);
    assert.equal(snap["asset:10.0.0.6"], "[admitted] 10.0.0.6");
    assert.ok(snap["goal:g1"]);
  } finally {
    ckpt.close();
    history.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("buildObserveSnapshot：纳入最近 30 条 title 层 / transferable Fact，队友新增 Fact 出现在续跑增量", () => {
  const root = mkdtempSync(join(tmpdir(), "gy-obs-fact-"));
  const m = manifest(root);
  const history = openHistory({ dbPath: m.historyDb, evidenceDir: m.evidenceDir });
  const ckpt = new CheckpointStore(join(root, "c.sqlite"));
  const state = ckpt.load();
  try {
    history.seedGoals(m.taskId, [
      { id: "g1", title: "g", description: "d", evidencePatterns: ["x.txt"], passes: false, evidencePaths: [], assertedAt: null },
    ]);
    buildTurnObserveBlock(m, history, state, undefined, { incremental: false });

    // A teammate (other worker, same History) adds a key title Fact and a transferable summary Fact.
    const mate = history.appendFact({ taskId: m.taskId, layer: "title", title: "teammate: admin panel at /mgmt", intentId: null });
    const xfer = history.appendFact({
      taskId: m.taskId,
      layer: "summary",
      title: "reusable session token",
      tags: ["transferable"],
      intentId: null,
    });
    const noise = history.appendFact({ taskId: m.taskId, layer: "evidence", title: "raw scan output", intentId: null });

    const delta = buildTurnObserveBlock(m, history, state, undefined, { incremental: true });
    assert.match(delta, /### 关键 Fact/);
    assert.match(delta, /teammate: admin panel at \/mgmt/);
    assert.match(delta, /\[transferable\] reusable session token/);
    assert.doesNotMatch(delta, /raw scan output/);

    const snap = buildObserveSnapshot(history, m.taskId);
    assert.ok(snap[`fact:${mate.id}`]);
    assert.ok(snap[`fact:${xfer.id}`]);
    assert.equal(snap[`fact:${noise.id}`], undefined);

    // Bounded: only the most recent OBSERVE_FACT_LIMIT key Facts are fingerprinted.
    for (let i = 0; i < OBSERVE_FACT_LIMIT + 10; i += 1) {
      history.appendFact({ taskId: m.taskId, layer: "title", title: `bulk fact ${i}`, intentId: null });
    }
    const bounded = buildObserveSnapshot(history, m.taskId);
    assert.equal(Object.keys(bounded).filter((k) => k.startsWith("fact:")).length, OBSERVE_FACT_LIMIT);
    assert.ok(bounded[`fact:${mate.id}`] === undefined);
  } finally {
    ckpt.close();
    history.close();
    rmSync(root, { recursive: true, force: true });
  }
});

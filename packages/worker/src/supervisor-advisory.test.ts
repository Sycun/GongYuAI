import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ORIGIN_FACT_ID, type WorkerManifest } from "@gongyuai/contracts";
import { openHistory } from "@gongyuai/history";
import { CheckpointStore, type CheckpointState } from "./checkpoint.js";
import { handleGraphTool } from "./graph-phase.js";
import type { McpHub } from "./mcp/client.js";
import type { SkillHub } from "./skills/runtime.js";
import {
  broadcastTunnelAdvisory,
  formatSupervisorAdvisoryGate,
} from "./supervisor-advisory.js";
import { buildWorkerToolCatalog } from "./tool-catalog.js";

const TASK = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

const stubMcpHub = {
  openaiTools: [],
  promptLines: [],
  catalogLines: () => [],
  enable: async () => "enabled",
  disable: async () => "disabled",
  call: async () => "mcp-ok",
  invokeWithRaw: async () => ({ text: "mcp-ok", raw: "mcp-ok" }),
  close: async () => {},
} as unknown as McpHub;

const stubSkillHub = {
  load: () => "skill-body",
  routingTable: () => [],
  suggestForGoals: () => [],
  autoInjectForFacts: () => "",
} as unknown as SkillHub;

function makeManifest(root: string): WorkerManifest {
  return {
    taskId: TASK,
    dataDir: root,
    historyDb: join(root, "h.sqlite"),
    durableDb: join(root, "d.sqlite"),
    evidenceDir: join(root, "evidence"),
    workspaceDir: root,
    auth: {
      authorizationNote: "supervisor-advisory unit test",
      targets: ["10.0.0.0/24", "192.168.1.0/24"],
      outOfScope: [],
      capability: "full",
    },
    scopeVersion: 1,
    goals: [],
    budget: {
      maxTokens: 0,
      maxWallMs: 0,
      maxToolCalls: 0,
      maxInstalls: 0,
      relayTokenThreshold: 30_000,
      relayMinToolCalls: 2,
    },
    execution: {
      maxConcurrentExplores: 3,
      maxIntentsPerReason: 4,
      maxIntentsPerAssetRoot: 2,
      exploreTimeoutMs: 900_000,
      reasonLeaseMs: 120_000,
    },
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
  };
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "gy-supervisor-"));
  mkdirSync(join(root, "evidence"), { recursive: true });
  const manifest = makeManifest(root);
  const history = openHistory({ dbPath: manifest.historyDb, evidenceDir: manifest.evidenceDir });
  const ckpt = new CheckpointStore(join(root, "ckpt.sqlite"));
  const state = ckpt.load();
  state.phase = "explore";
  return { root, manifest, history, ckpt, state };
}

test("intent_advise：调度角色写入督导收件箱，目标结项后拒绝", () => {
  const { root, manifest, history, ckpt, state } = fixture();
  try {
    const intent = history.proposeIntent({
      taskId: TASK,
      title: "含沙射影的管理面",
      sourceFactIds: [ORIGIN_FACT_ID],
      assetRoot: "10.0.0.10",
    });
    const ctx = {
      history,
      taskId: TASK,
      workspaceDir: root,
      state,
      save: () => {},
    };
    const out = handleGraphTool(
      "intent_advise",
      {
        target_intent_id: intent.id,
        priority: "urgent",
        kind: "surface_redirect",
        summary: "停止 /admin 爆破，改测 /api/v2 双账号差分",
      },
      ctx,
    );
    assert.ok(out && !out.startsWith("错误"));
    const parsed = JSON.parse(out) as { ok: boolean; advisory: { id: string; targetIntentId: string } };
    assert.equal(parsed.ok, true);
    assert.equal(parsed.advisory.targetIntentId, intent.id);

    const drained = history.consumePendingAdvisories(TASK, {
      activeIntentId: intent.id,
      workerSlot: 0,
      assetRoot: "10.0.0.10",
    });
    assert.equal(drained.length, 1);
    assert.match(drained[0]!.summary, /双账号差分/);
    const gate = formatSupervisorAdvisoryGate(drained);
    assert.match(gate, /\[SUPERVISOR_ADVISORY_GATE\]/);
    assert.match(gate, /urgent\/surface_redirect/);

    history.claimIntent(TASK, intent.id, "w0");
    history.concludeIntent(TASK, intent.id, "failed", "已测输入留档", { workerId: "w0" });
    const denied = handleGraphTool(
      "intent_advise",
      { target_intent_id: intent.id, summary: "晚到的建议" },
      ctx,
    );
    assert.match(denied ?? "", /已结项/);
    void ckpt;
    void manifest;
  } finally {
    history.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("credential_record：同资产/同私网段在跑 Intent 收到脱敏 resource_broadcast（排除自身）", async () => {
  const { root, manifest, history, ckpt, state } = fixture();
  try {
    const active = history.proposeIntent({
      taskId: TASK,
      title: "主动槽",
      sourceFactIds: [ORIGIN_FACT_ID],
      assetRoot: "10.0.0.10",
    });
    const peerSame = history.proposeIntent({
      taskId: TASK,
      title: "同主机友邻",
      sourceFactIds: [ORIGIN_FACT_ID],
      assetRoot: "10.0.0.11",
    });
    const peer24 = history.proposeIntent({
      taskId: TASK,
      title: "同 /24 友邻",
      sourceFactIds: [ORIGIN_FACT_ID],
      assetRoot: "10.0.0.12",
    });
    const unrelated = history.proposeIntent({
      taskId: TASK,
      title: "无关资产",
      sourceFactIds: [ORIGIN_FACT_ID],
      assetRoot: "192.168.1.50",
    });
    history.claimIntent(TASK, active.id, "w0");
    history.claimIntent(TASK, peerSame.id, "w1");
    history.claimIntent(TASK, peer24.id, "w1");
    history.claimIntent(TASK, unrelated.id, "w2");
    state.activeIntentId = active.id;
    state.activeIntentClaimedAt = new Date().toISOString();

    const catalog = buildWorkerToolCatalog({
      manifest,
      ctx: { manifest, history, usage: { toolCalls: 0, installs: 0 } },
      state,
      ckpt,
      mcpHub: stubMcpHub,
      skillHub: stubSkillHub,
      readPoolSize: () => 1,
      flushUsage: () => {},
      renderHistoryOverview: () => "overview",
      onRelay: () => ({ text: "relay-ok" }),
    });
    const credentialSpec = catalog.find((spec) => spec.name === "credential_record");
    assert.ok(credentialSpec);
    const out = await credentialSpec!.execute({
      kind: "password",
      asset: "10.0.0.11",
      username: "admin",
      secretRef: "evidence/creds/10.0.0.11-admin.txt",
      verified: "true",
    });
    assert.doesNotMatch(out.text, /^错误/);

    const advisories = history.listRecentAdvisories(TASK, 20);
    assert.equal(advisories.length, 2, "one peer exact + one peer same /24, never the active slot");
    assert.ok(advisories.every((a) => a.kind === "resource_broadcast"));
    assert.ok(advisories.every((a) => a.targetIntentId !== active.id));
    assert.deepEqual(
      advisories.map((a) => a.targetIntentId).sort(),
      [peerSame.id, peer24.id].sort(),
    );
    for (const advisory of advisories) {
      assert.match(advisory.summary, /新凭据入库/);
      assert.match(advisory.summary, /asset=10\.0\.0\.11/);
      assert.match(advisory.summary, /username=admin/);
      assert.match(advisory.summary, /kind=password/);
      assert.doesNotMatch(advisory.summary, /creds\/10\.0\.0\.11-admin\.txt/);
      assert.doesNotMatch(advisory.summary, /S3cretPassw0rd/);
    }

    // Sender (`active` on 10.0.0.10) must NOT hijack advisories addressed to its /24 peers.
    const senderDrained = history.consumePendingAdvisories(TASK, {
      activeIntentId: active.id,
      workerSlot: 0,
      assetRoot: "10.0.0.10",
      workerId: "w0",
    });
    assert.equal(senderDrained.length, 0);

    // Each peer drains ONLY its own targeted broadcast without stealing the sibling's copy.
    const drainedSame = history.consumePendingAdvisories(TASK, {
      activeIntentId: peerSame.id,
      workerSlot: 1,
      assetRoot: "10.0.0.11",
      workerId: "w1",
    });
    assert.equal(drainedSame.length, 1);
    assert.equal(drainedSame[0]!.targetIntentId, peerSame.id);
    assert.match(formatSupervisorAdvisoryGate(drainedSame), /resource_broadcast/);

    const drained24 = history.consumePendingAdvisories(TASK, {
      activeIntentId: peer24.id,
      workerSlot: 2,
      assetRoot: "10.0.0.12",
      workerId: "w2",
    });
    assert.equal(drained24.length, 1);
    assert.equal(drained24[0]!.targetIntentId, peer24.id);
  } finally {
    history.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("tunnel_open 资源广播：仅转发端口与目标，同资产友邻收到", () => {
  const { root, history } = fixture();
  try {
    const active = history.proposeIntent({
      taskId: TASK,
      title: "隧道建立方",
      sourceFactIds: [ORIGIN_FACT_ID],
      assetRoot: "192.168.1.50",
    });
    const peer = history.proposeIntent({
      taskId: TASK,
      title: "隧道复用方",
      sourceFactIds: [ORIGIN_FACT_ID],
      assetRoot: "192.168.1.50",
    });
    history.claimIntent(TASK, active.id, "w0");
    history.claimIntent(TASK, peer.id, "w1");

    const ids = broadcastTunnelAdvisory({
      history,
      taskId: TASK,
      createdBy: "w1",
      excludeIntentId: active.id,
      tunnel: {
        id: "tn-22022",
        kind: "socat",
        localPort: 22022,
        targetHost: "192.168.1.50",
      },
    });
    assert.equal(ids.length, 1);
    const advisories = history.listRecentAdvisories(TASK, 5);
    assert.equal(advisories[0]!.targetIntentId, peer.id);
    assert.match(advisories[0]!.summary, /127\.0\.0\.1:22022/);
    assert.match(advisories[0]!.summary, /tunnel_list/);
    assert.doesNotMatch(advisories[0]!.summary, /password|secret/i);
  } finally {
    history.close();
    rmSync(root, { recursive: true, force: true });
  }
});
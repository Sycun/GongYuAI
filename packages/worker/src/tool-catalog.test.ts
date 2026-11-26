import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ORIGIN_FACT_ID, type WorkerManifest } from "@gongyuai/contracts";
import { openHistory } from "@gongyuai/history";
import { CheckpointStore } from "./checkpoint.js";
import {
  FOLLOWER_ONLY_EXEC_TOOLS,
  resolveWorkerRole,
  roleAllowedToolNames,
} from "./graph-phase.js";
import type { McpHub } from "./mcp/client.js";
import { shouldResetFollowerSession } from "./pi-loop.js";
import type { SkillHub } from "./skills/runtime.js";
import {
  buildOpenAiToolsFromCatalog,
  buildPiToolsFromCatalog,
  buildWorkerToolCatalog,
  evaluateWorkerToolGate,
} from "./tool-catalog.js";

function makeManifest(
  workspaceDir: string,
  opts: { slot?: number; workerCount?: number } = {},
): WorkerManifest {
  const slot = opts.slot ?? 0;
  const workerCount = opts.workerCount ?? 1;
  return {
    taskId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    dataDir: workspaceDir,
    historyDb: join(workspaceDir, "h.sqlite"),
    durableDb: join(workspaceDir, `d-${slot}.sqlite`),
    evidenceDir: join(workspaceDir, "evidence"),
    workspaceDir,
    auth: {
      authorizationNote: "tool-catalog unit test",
      targets: ["10.0.0.0/8"],
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
    workerId: `w${slot}`,
    workerSlot: slot,
    workerCount,
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

const stubMcpHub = {
  openaiTools: [
    {
      type: "function",
      function: {
        name: "mcp__nmap__scan",
        description: "nmap scan",
        parameters: { type: "object", properties: { target: { type: "string" } } },
      },
    },
  ],
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

test("一主两辅角色收敛：resolveWorkerRole 与 roleAllowedToolNames 严格物理隔离脑手工具面", () => {
  assert.equal(resolveWorkerRole({ leader: true, workerCount: 1 }), "solo");
  assert.equal(resolveWorkerRole({ leader: true, workerCount: 4 }), "leader");
  assert.equal(resolveWorkerRole({ leader: false, workerCount: 4 }), "follower");

  const leaderExplore = roleAllowedToolNames("explore", "leader", ["mcp__nmap__scan"]);
  for (const execTool of FOLLOWER_ONLY_EXEC_TOOLS) {
    assert.equal(leaderExplore.has(execTool), false, `leader must never expose ${execTool}`);
  }
  assert.equal(leaderExplore.has("mcp__nmap__scan"), false);
  assert.equal(leaderExplore.has("intent_propose"), true);
  assert.equal(leaderExplore.has("assert_goal"), true);

  const followerExplore = roleAllowedToolNames("explore", "follower", ["mcp__nmap__scan"]);
  assert.equal(followerExplore.has("shell"), true);
  assert.equal(followerExplore.has("mcp__nmap__scan"), true);
  assert.equal(followerExplore.has("assert_goal"), false, "follower must never assert_goal");
});

test("统一工具目录：Pi 可选参数使用 opt()，Follower 结项触发单 Intent 终止与会话隔离重置", async () => {
  const root = mkdtempSync(join(tmpdir(), "gy-cat-"));
  const history = openHistory({
    dbPath: join(root, "h.sqlite"),
    evidenceDir: join(root, "evidence"),
  });
  const ckpt = new CheckpointStore(join(root, "ckpt.sqlite"));
  const state = ckpt.load();
  state.phase = "explore";

  try {
    const followerManifest = makeManifest(root, { slot: 1, workerCount: 4 });
    let finishedIntentId: string | null = null;
    const catalog = buildWorkerToolCatalog({
      manifest: followerManifest,
      ctx: { manifest: followerManifest, history, usage: { toolCalls: 0, installs: 0 } },
      state,
      ckpt,
      mcpHub: stubMcpHub,
      skillHub: stubSkillHub,
      readPoolSize: () => 4,
      flushUsage: () => {},
      renderHistoryOverview: () => "overview",
      onRelay: () => ({ text: "relay-ok" }),
      onFollowerIntentFinished: (id) => {
        finishedIntentId = id;
      },
    });

    // Verify Pi Durable parameter builder marks optional fields with opt() and required fields bare.
    const recordedSchemas = new Map<string, Record<string, unknown>>();
    const piTools = buildPiToolsFromCatalog({
      catalog,
      role: "follower",
      piSchema: {
        obj: (props) => props,
        str: () => ({ kind: "str", required: true }),
        num: () => ({ kind: "num", required: true }),
        opt: (inner) => ({ ...(inner as object), required: false }),
      },
      definePiTool: (spec: { name: string; parameters: Record<string, unknown> }) => {
        recordedSchemas.set(spec.name, spec.parameters);
        return spec;
      },
      wrapExecute: (_name, out) => out,
    });
    assert.equal(
      piTools.some((t) => (t as { name: string }).name === "assert_goal"),
      false,
    );
    const proposeSchema = recordedSchemas.get("intent_propose") as Record<
      string,
      { required: boolean }
    >;
    assert.equal(proposeSchema.title?.required, true);
    assert.equal(proposeSchema.sourceFactIds?.required, true);
    assert.equal(proposeSchema.assetRoot?.required, false);
    assert.equal(proposeSchema.claim?.required, false);

    // Verify OpenAI schema filtering strips FOLLOWER_ONLY_EXEC_TOOLS on multi-worker Leader.
    const leaderManifest = makeManifest(root, { slot: 0, workerCount: 4 });
    const leaderState = ckpt.load();
    leaderState.phase = "reason";
    const leaderOpenAi = buildOpenAiToolsFromCatalog({
      catalog,
      history,
      manifest: leaderManifest,
      state: leaderState,
      mcpHub: stubMcpHub,
      workerCount: 4,
    });
    assert.equal(
      leaderOpenAi.some((t) => t.function.name === "shell"),
      false,
    );
    assert.equal(
      leaderOpenAi.some((t) => t.function.name === "intent_propose"),
      true,
    );

    // Verify Follower intent_conclude returns control.terminate=true and arms clean session reset.
    const intent = history.proposeIntent({
      taskId: followerManifest.taskId,
      title: "verify target A",
      sourceFactIds: [ORIGIN_FACT_ID],
    });
    const claimSpec = catalog.find((s) => s.name === "intent_claim")!;
    const concludeSpec = catalog.find((s) => s.name === "intent_conclude")!;

    await claimSpec.execute({ intentId: intent.id });
    assert.equal(state.activeIntentId, intent.id);

    const concludeOut = await concludeSpec.execute({
      intentId: intent.id,
      status: "failed",
      conclusion: "surface exhausted",
    });
    assert.equal(state.activeIntentId, null);
    assert.equal(finishedIntentId, intent.id);
    assert.deepEqual(concludeOut.control, { terminate: true });

    assert.equal(
      shouldResetFollowerSession({
        role: "follower",
        round: 2,
        pendingIntentReset: true,
        activeIntentId: state.activeIntentId,
      }),
      true,
    );
    assert.equal(
      shouldResetFollowerSession({
        role: "leader",
        round: 2,
        pendingIntentReset: true,
        activeIntentId: null,
      }),
      false,
    );
  } finally {
    ckpt.close();
    history.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("统一门禁 evaluateWorkerToolGate：三条硬规则无死锁且求助永不拦截", () => {
  const root = mkdtempSync(join(tmpdir(), "gy-gate-"));
  const history = openHistory({
    dbPath: join(root, "h.sqlite"),
    evidenceDir: join(root, "evidence"),
  });
  const ckpt = new CheckpointStore(join(root, "ckpt.sqlite"));
  const state = ckpt.load();
  state.phase = "explore";

  try {
    const followerManifest = makeManifest(root, { slot: 1, workerCount: 4 });
    const ctx = { manifest: followerManifest, history, usage: { toolCalls: 0, installs: 0 } };

    // Rule 1: operator_consult never blocked even without activeIntentId.
    assert.equal(
      evaluateWorkerToolGate({
        ctx,
        state,
        name: "operator_consult",
        mcpHub: stubMcpHub,
        poolSizeOverride: 4,
      }),
      undefined,
    );

    // Rule 2: Follower denied assert_goal; Leader denied shell.
    assert.match(
      evaluateWorkerToolGate({
        ctx,
        state,
        name: "assert_goal",
        mcpHub: stubMcpHub,
        poolSizeOverride: 4,
      }) ?? "",
      /leader-only/,
    );
    const leaderManifest = makeManifest(root, { slot: 0, workerCount: 4 });
    const leaderState = ckpt.load();
    leaderState.phase = "reason";
    assert.match(
      evaluateWorkerToolGate({
        ctx: { manifest: leaderManifest, history, usage: { toolCalls: 0, installs: 0 } },
        state: leaderState,
        name: "shell",
        mcpHub: stubMcpHub,
        poolSizeOverride: 4,
      }) ?? "",
      /leader does not execute shell/,
    );

    // Rule 3: Follower shell requires active claimed Intent, then passes once claimed.
    assert.match(
      evaluateWorkerToolGate({
        ctx,
        state,
        name: "shell",
        mcpHub: stubMcpHub,
        poolSizeOverride: 4,
      }) ?? "",
      /requires an active claimed Intent/,
    );
    const intent = history.proposeIntent({
      taskId: followerManifest.taskId,
      title: "probe",
      sourceFactIds: [ORIGIN_FACT_ID],
    });
    history.claimIntent(followerManifest.taskId, intent.id, "w1");
    state.activeIntentId = intent.id;
    assert.equal(
      evaluateWorkerToolGate({
        ctx,
        state,
        name: "shell",
        mcpHub: stubMcpHub,
        poolSizeOverride: 4,
      }),
      undefined,
    );
  } finally {
    ckpt.close();
    history.close();
    rmSync(root, { recursive: true, force: true });
  }
});

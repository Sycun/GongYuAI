import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { WorkerManifest } from "@gongyuai/contracts";
import { openHistory } from "@gongyuai/history";
import {
  canRelay,
  formatRelayInjection,
  listRelayProtocols,
  writeRelayProtocol,
} from "./relay.js";

function manifest(workspaceDir: string): WorkerManifest {
  return {
    taskId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    dataDir: workspaceDir,
    historyDb: join(workspaceDir, "h.sqlite"),
    durableDb: join(workspaceDir, "d.sqlite"),
    evidenceDir: join(workspaceDir, "evidence"),
    workspaceDir,
    auth: {
      authorizationNote: "relay unit test auth note",
      targets: ["127.0.0.1"],
      outOfScope: [],
      capability: "full",
    },
    scopeVersion: 1,
    goals: [],
    budget: {
      maxTokens: 1000,
      maxWallMs: 60_000,
      maxToolCalls: 10,
      maxInstalls: 2,
      relayTokenThreshold: 100,
      relayMinToolCalls: 2,
    },
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

test("canRelay enforces min tool calls then auto threshold", () => {
  const prevMin = process.env.GY_RELAY_MIN_TOOL_CALLS;
  const prevThr = process.env.GY_RELAY_TOKEN_THRESHOLD;
  delete process.env.GY_RELAY_MIN_TOOL_CALLS;
  delete process.env.GY_RELAY_TOKEN_THRESHOLD;
  const m = manifest("/tmp");
  assert.equal(
    canRelay({
      manifest: m,
      tokensSinceRelay: 999,
      toolCallsSinceRelay: 0,
      forceAgent: true,
    }).ok,
    false,
  );
  assert.equal(
    canRelay({
      manifest: m,
      tokensSinceRelay: 50,
      toolCallsSinceRelay: 2,
      forceAgent: false,
    }).ok,
    false,
  );
  const auto = canRelay({
    manifest: m,
    tokensSinceRelay: 100,
    toolCallsSinceRelay: 2,
    forceAgent: false,
  });
  assert.equal(auto.ok, true);
  if (auto.ok) assert.equal(auto.trigger, "auto");
  const agent = canRelay({
    manifest: m,
    tokensSinceRelay: 1,
    toolCallsSinceRelay: 2,
    forceAgent: true,
  });
  assert.equal(agent.ok, true);
  if (agent.ok) assert.equal(agent.trigger, "agent");
  if (prevMin !== undefined) process.env.GY_RELAY_MIN_TOOL_CALLS = prevMin;
  else delete process.env.GY_RELAY_MIN_TOOL_CALLS;
  if (prevThr !== undefined) process.env.GY_RELAY_TOKEN_THRESHOLD = prevThr;
  else delete process.env.GY_RELAY_TOKEN_THRESHOLD;
});

test("writeRelayProtocol appends πn.json and injection lists foothold", () => {
  const root = mkdtempSync(join(tmpdir(), "gy-relay-"));
  const m = manifest(root);
  const history = openHistory({
    dbPath: m.historyDb,
    evidenceDir: m.evidenceDir,
  });
  try {
    const p0 = writeRelayProtocol(m, history, {
      trigger: "agent",
      reason: "foothold",
      foothold: "ssh user@10.0.0.5",
      unexplored_surface: "10.0.0.6:445",
      tokens: 10,
      toolCalls: 3,
      generation: 0,
    });
    assert.equal(p0.generation, 0);
    assert.equal(p0.foothold, "ssh user@10.0.0.5");
    const listed = listRelayProtocols(root);
    assert.equal(listed.length, 1);
    const text = formatRelayInjection(listed);
    assert.match(text, /foothold: ssh user@10\.0\.0\.5/);
    assert.match(text, /unexplored_surface: 10\.0\.0\.6:445/);

    for (let g = 1; g <= 5; g++) {
      writeRelayProtocol(m, history, {
        trigger: "auto",
        reason: `gen-${g}`,
        foothold: `host-${g}`,
        unexplored_surface: `port-${g}`,
        tokens: g * 100,
        toolCalls: g * 3,
        generation: g,
      });
    }
    const bounded = formatRelayInjection(listRelayProtocols(root));
    assert.match(bounded, /早期交接摘要（π0\.\.π2，共 3 代已折叠）/);
    assert.match(bounded, /### π5 · auto · gen-5/);
    assert.doesNotMatch(bounded, /### π0 · agent/);
  } finally {
    history.close();
    rmSync(root, { recursive: true, force: true });
  }
});

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
    goals: [],
    budget: {
      maxTokens: 1000,
      maxWallMs: 60_000,
      maxToolCalls: 10,
      maxInstalls: 2,
      relayTokenThreshold: 100,
      relayMinToolCalls: 2,
    },
    mock: true,
    mcpServers: [],
    mcpPool: [],
    mcpCatalog: [],
    skillPacks: [],
    skillPool: [],
    skillCatalog: [],
  };
}

test("canRelay enforces min tool calls then auto threshold", () => {
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
  } finally {
    history.close();
    rmSync(root, { recursive: true, force: true });
  }
});

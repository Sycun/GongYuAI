import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { openHistory } from "@gongyuai/history";
import type { WorkerManifest } from "@gongyuai/contracts";
import type { ToolContext } from "./tools.js";
import { resetTunnelManagersForTest, tunnelListTool, tunnelOpenTool } from "./tunnel-tools.js";

const TASK_ID = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";

function setup(capability: WorkerManifest["auth"]["capability"]) {
  const root = mkdtempSync(join(tmpdir(), "gy-tunnel-tool-"));
  const evidenceDir = join(root, "evidence");
  mkdirSync(evidenceDir, { recursive: true });
  const history = openHistory({ dbPath: join(root, "history.sqlite"), evidenceDir });
  const manifest: WorkerManifest = {
    taskId: TASK_ID,
    engagementId: "eng-tunnel",
    dataDir: root,
    historyDb: join(root, "history.sqlite"),
    durableDb: join(root, "durable.sqlite"),
    evidenceDir,
    workspaceDir: join(root, "workspace"),
    auth: {
      authorizationNote: "P14 tunnel fixture",
      targets: ["10.0.0.0/24"],
      outOfScope: [],
      capability,
    },
    scopeVersion: 1,
    goals: [],
    budget: { maxTokens: 0, maxWallMs: 0, maxToolCalls: 0, maxInstalls: 0, relayTokenThreshold: 30_000, relayMinToolCalls: 2 },
    execution: { maxConcurrentExplores: 1, maxIntentsPerReason: 4, maxIntentsPerAssetRoot: 2, exploreTimeoutMs: 900_000, reasonLeaseMs: 120_000 },
    commandConfirmation: "auto",
    workerId: "w0-tunnel",
    workerSlot: 0,
    workerCount: 1,
    mock: false,
    mcpServers: [],
    mcpPool: [],
    mcpCatalog: [],
    skillPacks: [],
    skillPool: [],
    skillCatalog: [],
    assetCollectors: [],
  };
  const ctx: ToolContext = { manifest, history, usage: { toolCalls: 0, installs: 0 } };
  return { root, history, ctx };
}

test("tunnel_open requires active-lab and rejects out-of-scope targets", async () => {
  resetTunnelManagersForTest();
  const scan = setup("scan");
  try {
    await assert.rejects(
      () => tunnelOpenTool(scan.ctx, { kind: "socat", targetHost: "10.0.0.5", targetPort: "445" }),
      /active-lab/,
    );
    assert.equal(JSON.parse(tunnelListTool(scan.ctx)).count, 0);
  } finally {
    scan.history.close();
    rmSync(scan.root, { recursive: true, force: true });
  }

  resetTunnelManagersForTest();
  const active = setup("active-lab");
  try {
    await assert.rejects(
      () => tunnelOpenTool(active.ctx, { kind: "socat", targetHost: "198.51.100.7", targetPort: "445" }),
      /授权|not in scope|out of scope|denied/i,
    );
    assert.equal(JSON.parse(tunnelListTool(active.ctx)).count, 0);
  } finally {
    active.history.close();
    rmSync(active.root, { recursive: true, force: true });
  }
});

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { WorkerManifest } from "@gongyuai/contracts";
import { ORIGIN_FACT_ID } from "@gongyuai/contracts";
import { openHistory } from "@gongyuai/history";
import {
  buildModelCandidateChain,
  buildWorkerRefusalPrompt,
  createPoolSizeReader,
  isModelRefusalText,
  isRetryableHttpStatus,
  shouldFailoverHttpStatus,
  synthesizeGroundedRelayFields,
} from "./model-resilience.js";

function makeManifest(dir: string): WorkerManifest {
  return {
    taskId: "11111111-1111-4111-8111-111111111111",
    dataDir: dir,
    historyDb: join(dir, "history.sqlite"),
    durableDb: join(dir, "durable.sqlite"),
    evidenceDir: join(dir, "evidence"),
    workspaceDir: join(dir, "workspace"),
    auth: {
      authorizationNote: "",
      targets: ["10.0.0.5"],
      outOfScope: [],
      capability: "active-lab",
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
      maxConcurrentExplores: 1,
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

test("isModelRefusalText catches AI policy refusals without flagging technical errors", () => {
  assert.equal(isModelRefusalText("抱歉，我无法协助执行针对外部目标的渗透测试。"), true);
  assert.equal(isModelRefusalText("I'm sorry, as an AI language model I cannot assist with exploitation."), true);
  assert.equal(isModelRefusalText("对不起，不能对该系统进行未授权攻击。"), true);

  // Technical network / command outputs must NOT be misclassified as model refusal.
  assert.equal(isModelRefusalText("curl: (7) Failed to connect to 10.0.0.5 port 80: Connection refused"), false);
  assert.equal(isModelRefusalText("ssh: connect to host 10.0.0.5 port 22: Operation timed out"), false);
  assert.equal(isModelRefusalText("DONE"), false);

  assert.match(buildWorkerRefusalPrompt(1, ["10.0.0.5"]), /10\.0\.0\.5/);
  assert.match(buildWorkerRefusalPrompt(2, ["10.0.0.5"]), /结构化单步纠偏/);
});

test("HTTP retry & failover classifiers + candidate chain deduplication", () => {
  assert.equal(isRetryableHttpStatus(429), true);
  assert.equal(isRetryableHttpStatus(503), true);
  assert.equal(isRetryableHttpStatus(400), false);
  assert.equal(shouldFailoverHttpStatus(402, "insufficient_balance"), true);
  assert.equal(shouldFailoverHttpStatus(429, "rate limit"), true);

  const prevKey = process.env.GY_BACKUP_KEY;
  process.env.GY_BACKUP_KEY = "sk-backup";
  try {
    const dir = mkdtempSync(join(tmpdir(), "gy-resilience-"));
    const m = makeManifest(dir);
    const chain = buildModelCandidateChain(
      {
        provider: "deepseek",
        modelId: "deepseek-chat",
        baseUrl: "https://api.deepseek.com/v1",
        apiKeyEnv: "OPENAI_API_KEY",
      },
      [
        { provider: "deepseek", modelId: "deepseek-chat", baseUrl: "https://api.deepseek.com/v1" },
        { provider: "openai", modelId: "gpt-4.1", baseUrl: "https://openrouter.ai/api/v1", apiKeyEnv: "GY_BACKUP_KEY" },
        { provider: "openai", modelId: "missing-key-model", apiKeyEnv: "NON_EXISTENT_ENV_999" },
      ],
      m,
    );
    assert.equal(chain.length, 2);
    assert.equal(chain[1]!.provider, "openrouter");
    assert.equal(chain[1]!.modelId, "gpt-4.1");
    rmSync(dir, { recursive: true, force: true });
  } finally {
    if (prevKey !== undefined) process.env.GY_BACKUP_KEY = prevKey;
    else delete process.env.GY_BACKUP_KEY;
  }
});

test("createPoolSizeReader picks up dynamic manifest workerCount scale-up and grounded relay summarizes History", () => {
  const dir = mkdtempSync(join(tmpdir(), "gy-pool-reader-"));
  const m = makeManifest(dir);
  const history = openHistory({ dbPath: m.historyDb, evidenceDir: m.evidenceDir });
  try {
    writeFileSync(join(dir, "manifest.json"), JSON.stringify({ workerCount: 4 }));
    const readPool = createPoolSizeReader(m, 0);
    assert.equal(readPool(), 4);
    assert.equal(m.workerCount, 4);

    history.recordAsset({ taskId: m.taskId, address: "10.0.0.5", auth: m.auth, live: true });
    const intent = history.proposeIntent({
      taskId: m.taskId,
      title: "check smb",
      sourceFactIds: [ORIGIN_FACT_ID],
    });
    const grounded = synthesizeGroundedRelayFields(history, m.taskId, intent.id);
    assert.match(grounded.current_position, new RegExp(intent.id));
    assert.match(grounded.network_map, /10\.0\.0\.5\(live\)/);
    assert.match(grounded.unexplored_surface, /check smb/);
  } finally {
    history.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

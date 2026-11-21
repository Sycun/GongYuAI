import assert from "node:assert/strict";
import { test } from "node:test";
import type { WorkerManifest } from "@gongyuai/contracts";
import { resolvePiModelRef } from "./pi-loop.js";

function baseManifest(
  model: NonNullable<WorkerManifest["model"]>,
): WorkerManifest {
  return {
    taskId: "t1",
    dataDir: "/tmp",
    historyDb: "/tmp/h.sqlite",
    durableDb: "/tmp/d.sqlite",
    evidenceDir: "/tmp/e",
    workspaceDir: "/tmp/w",
    auth: {
      authorizationNote: "test auth note",
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
      relayTokenThreshold: 30_000,
      relayMinToolCalls: 2,
    },
    execution: { maxConcurrentExplores: 1, maxIntentsPerReason: 4, maxIntentsPerAssetRoot: 2, exploreTimeoutMs: 900_000, reasonLeaseMs: 120_000 },
    workerId: "w0",
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
    model,
  };
}

test("infers deepseek from baseUrl when provider left as openai", () => {
  const ref = resolvePiModelRef(
    baseManifest({
      provider: "openai",
      modelId: "deepseek-flash",
      baseUrl: "https://api.deepseek.com/v1",
      apiKeyEnv: "OPENAI_API_KEY",
      visionEnabled: false,
    }),
  );
  assert.equal(ref.provider, "deepseek");
  assert.equal(ref.modelId, "deepseek-flash");
  assert.equal(ref.baseUrl, "https://api.deepseek.com/v1");
});

test("keeps explicit provider", () => {
  const ref = resolvePiModelRef(
    baseManifest({
      provider: "deepseek",
      modelId: "deepseek-v4-pro",
      baseUrl: "https://api.deepseek.com",
      apiKeyEnv: "OPENAI_API_KEY",
      visionEnabled: true,
      visionModelId: "deepseek-flash",
    }),
  );
  assert.equal(ref.provider, "deepseek");
  assert.equal(ref.visionModelId, "deepseek-flash");
});

test("maps custom proxy to openai-compatible", () => {
  const ref = resolvePiModelRef(
    baseManifest({
      provider: "openai",
      modelId: "gpt-4.1-mini",
      baseUrl: "https://api.x5m5x.com/v1",
      apiKeyEnv: "OPENAI_API_KEY",
      visionEnabled: true,
    }),
  );
  assert.equal(ref.provider, "openai-compatible");
});

import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { openHistory } from "@gongyuai/history";
import type { WorkerManifest } from "@gongyuai/contracts";
import { extractBriefingSeeds, renderBriefingSeedsBlock } from "./briefing-seeds.js";
import { CheckpointStore } from "./checkpoint.js";
import { buildTurnObserveBlock } from "./prompt-builder.js";

const TASK_ID = "88888888-8888-4888-8888-888888888888";

function manifestWith(briefing: {
  roe?: string;
  authorizationNote?: string;
  goals?: WorkerManifest["goals"];
}): WorkerManifest {
  return {
    taskId: TASK_ID,
    engagementId: "eng-brief",
    dataDir: "/tmp/gy-brief-unused",
    historyDb: "/tmp/gy-brief-unused.sqlite",
    durableDb: "/tmp/gy-brief-unused-durable.sqlite",
    evidenceDir: "/tmp/gy-brief-unused-evidence",
    workspaceDir: "/tmp/gy-brief-unused-workspace",
    auth: {
      authorizationNote: briefing.authorizationNote ?? "",
      ...(briefing.roe ? { roe: briefing.roe } : {}),
      targets: ["lab.example.com"],
      outOfScope: [],
      capability: "active-lab",
    },
    scopeVersion: 1,
    goals: briefing.goals ?? [],
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
    commandConfirmation: "auto",
    workerId: "w0-brief",
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
}

test("extractBriefingSeeds recognizes Chinese/English account hints and business endpoints", () => {
  const manifest = manifestWith({
    roe: "灰盒委托：测试账号：zhangsan，密码：P@ss123；工号 A10086 密码 8d0f2a；只做只读验证。",
    authorizationNote:
      "user: admin pass: admin@123; Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.payload.sig 入口 /api/v1/orders",
    goals: [
      {
        id: "g1",
        title: "门户越权",
        description: "从 https://portal.example.com/login 登录后核对 /console/user/list 的角色边界",
        evidencePatterns: ["*"],
        passes: false,
        evidencePaths: [],
        assertedAt: null,
      },
    ],
  });

  const seeds = extractBriefingSeeds(manifest);
  const hints = seeds.accounts.map((account) => `${account.label}:${account.hint}`).join("\n");
  assert.match(hints, /zhangsan/);
  assert.match(hints, /P@ss123/);
  assert.match(hints, /A10086/);
  assert.match(hints, /8d0f2a/);
  assert.match(hints, /admin \/ admin@123/);
  const bearer = seeds.accounts.find((account) => account.label === "Bearer");
  assert.ok(bearer);
  assert.ok(!bearer!.hint.includes("eyJhbGciOiJIUzI1NiJ9.payload.sig"), "Token 全文不得进入提示块");
  assert.ok(seeds.endpoints.includes("/api/v1/orders"));
  assert.ok(seeds.endpoints.includes("https://portal.example.com/login"));
  assert.ok(seeds.endpoints.includes("/console/user/list"));
});

test("renderBriefingSeedsBlock enforces the named-session baseline discipline only when identities exist", () => {
  const withIdentities = renderBriefingSeedsBlock(
    manifestWith({ authorizationNote: "账号：apply_test 密码：Apply#2026" }),
  );
  assert.match(withIdentities, /\[灰盒委托预置身份与多角色基线纪律\]/);
  assert.match(withIdentities, /apply_test/);
  assert.match(withIdentities, /session="role_user"/);
  assert.match(withIdentities, /session="anon"/);

  const withoutIdentities = renderBriefingSeedsBlock(
    manifestWith({ roe: "仅黑盒，无预置账号。入口 /login" }),
  );
  assert.equal(withoutIdentities, "");
});

test("buildTurnObserveBlock renders the grey-box briefing block inside the Observe guidance", () => {
  const root = mkdtempSync(join(tmpdir(), "gy-brief-observe-"));
  const evidenceDir = join(root, "evidence");
  mkdirSync(evidenceDir, { recursive: true });
  const history = openHistory({ dbPath: join(root, "history.sqlite"), evidenceDir });
  const store = new CheckpointStore(join(root, "durable.sqlite"));
  try {
    const manifest = manifestWith({
      authorizationNote: "测试账号：demo_user，密码：Demo#9，入口 /api/login",
    });
    manifest.dataDir = root;
    manifest.evidenceDir = evidenceDir;
    manifest.historyDb = join(root, "history.sqlite");
    const state = store.load();
    const block = buildTurnObserveBlock(manifest, history, state);
    assert.match(block, /\[灰盒委托预置身份与多角色基线纪律\]/);
    assert.match(block, /demo_user/);
    assert.match(block, /http_request\(session=/);
  } finally {
    store.close();
    history.close();
    rmSync(root, { recursive: true, force: true });
  }
});
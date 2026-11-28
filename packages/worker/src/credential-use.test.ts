import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { openHistory } from "@gongyuai/history";
import type { WorkerManifest } from "@gongyuai/contracts";
import { credentialUseTool, type OpsToolContext } from "./ops-tools.js";

const TASK_ID = "77777777-7777-4777-8777-777777777777";

function setup(prefix: string) {
  const root = mkdtempSync(join(tmpdir(), prefix));
  const evidenceDir = join(root, "evidence");
  const workspaceDir = join(root, "workspace");
  mkdirSync(evidenceDir, { recursive: true });
  mkdirSync(workspaceDir, { recursive: true });
  const history = openHistory({ dbPath: join(root, "history.sqlite"), evidenceDir });
  const manifest: WorkerManifest = {
    taskId: TASK_ID,
    engagementId: "eng-cred-use",
    dataDir: root,
    historyDb: join(root, "history.sqlite"),
    durableDb: join(root, "durable.sqlite"),
    evidenceDir,
    workspaceDir,
    auth: {
      authorizationNote: "P18 credential-use local fixture",
      targets: ["lab.example.com", "10.0.0.0/24"],
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
    commandConfirmation: "auto",
    workerId: "w1-cred",
    workerSlot: 1,
    workerCount: 2,
    mock: false,
    mcpServers: [],
    mcpPool: [],
    mcpCatalog: [],
    skillPacks: [],
    skillPool: [],
    skillCatalog: [],
    assetCollectors: [],
  };
  const ctx: OpsToolContext = {
    manifest,
    history,
    workerId: "w1-cred",
    activeIntentId: null,
  };
  return { root, evidenceDir, history, ctx };
}

test("credential_use resolve returns the evidence path + 512-byte untrusted preview and consumes the pointer", () => {
  const { root, evidenceDir, history, ctx } = setup("gy-cred-resolve-");
  try {
    const secret = `svc_password=hunter2\n${"X".repeat(800)}`;
    writeFileSync(join(evidenceDir, "admin.txt"), secret);
    const { credential } = history.recordCredential({
      taskId: TASK_ID,
      kind: "password",
      asset: "lab.example.com",
      username: "svc_admin",
      secretRef: "admin.txt",
      verified: true,
    });

    const out = JSON.parse(
      credentialUseTool(ctx, {
        action: "resolve",
        credentialId: credential.id,
        targetAsset: "10.0.0.11",
      }),
    ) as {
      ok: boolean;
      secret: { type: string; path: string; preview: string; previewBytes: number; truncated: boolean };
      reuseCount: number;
    };
    assert.equal(out.ok, true);
    assert.equal(out.secret.type, "evidence");
    assert.equal(out.secret.path, "admin.txt");
    assert.equal(out.secret.previewBytes, 512);
    assert.equal(out.secret.truncated, true);
    assert.match(out.secret.preview, /^\[untrusted source=tool:credential_use/);
    assert.ok(out.secret.preview.includes("svc_password=hunter2"));
    assert.ok(!out.secret.preview.includes("X".repeat(600)));
    assert.equal(out.reuseCount, 1, "resolve 必须记一次消费");
    assert.ok(history.getCredential(TASK_ID, credential.id)?.lastUsedAt);
  } finally {
    history.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("credential_use resolve blocks .. traversal / absolute paths / outside files without consuming", () => {
  const { root, evidenceDir, history, ctx } = setup("gy-cred-traversal-");
  try {
    writeFileSync(join(root, "outside-secret.txt"), "host-only-data");
    const cases = ["../outside-secret.txt", "/etc/passwd", "nested/../../outside-secret.txt"];
    for (const secretRef of cases) {
      const { credential } = history.recordCredential({
        taskId: TASK_ID,
        kind: "password",
        asset: "lab.example.com",
        username: `svc-${cases.indexOf(secretRef)}`,
        secretRef,
        verified: false,
      });
      assert.throws(
        () =>
          credentialUseTool(ctx, {
            action: "resolve",
            credentialId: credential.id,
            targetAsset: "10.0.0.11",
          }),
        /合法证据文件|invalid relative evidence path|evidence/,
        `secretRef ${secretRef} 必须被拒绝`,
      );
      assert.equal(
        history.getCredential(TASK_ID, credential.id)?.reuseCount,
        0,
        "越界解析失败不得计消费",
      );
    }
    assert.equal(history.listCredentialChecks(TASK_ID).length, 0);
    assert.equal(evidenceDir.endsWith("evidence"), true);
  } finally {
    history.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("credential_use verify closes the matrix loop and records cross-host reuse", () => {
  const { root, evidenceDir, history, ctx } = setup("gy-cred-verify-");
  try {
    writeFileSync(join(evidenceDir, "admin.txt"), "svc_password=hunter2\n");
    const { credential } = history.recordCredential({
      taskId: TASK_ID,
      kind: "password",
      asset: "lab.example.com",
      username: "svc_admin",
      secretRef: "admin.txt",
      verified: true,
    });

    const valid = JSON.parse(
      credentialUseTool(ctx, {
        action: "verify",
        credentialId: credential.id,
        targetAsset: "10.0.0.21",
        service: "ssh",
        verdict: "valid",
        evidencePath: "admin.txt",
        note: "ssh banner + auth ok",
      }),
    ) as { ok: boolean; check: { verdict: string; service: string }; crossHostFact: boolean; reuseCount: number };
    assert.equal(valid.ok, true);
    assert.equal(valid.check.verdict, "valid");
    assert.equal(valid.check.service, "ssh");
    assert.equal(valid.crossHostFact, true);
    assert.equal(valid.reuseCount, 1);

    let checks = history.listCredentialChecks(TASK_ID);
    assert.equal(checks.length, 1);
    assert.equal(checks[0]!.targetAsset, "10.0.0.21");
    const authFacts = history.listFacts(TASK_ID, "auth");
    assert.equal(authFacts.length, 1);

    // 同一单元格重复验证幂等更新，reuse 继续累加。
    const again = JSON.parse(
      credentialUseTool(ctx, {
        action: "verify",
        credentialId: credential.id,
        targetAsset: "10.0.0.21",
        service: "ssh",
        verdict: "invalid",
        note: "lockout after rotation",
      }),
    ) as { check: { verdict: string }; crossHostFact: boolean; reuseCount: number };
    assert.equal(again.check.verdict, "invalid");
    assert.equal(again.crossHostFact, false);
    assert.equal(again.reuseCount, 2);
    checks = history.listCredentialChecks(TASK_ID);
    assert.equal(checks.length, 1);
    assert.equal(checks[0]!.verdict, "invalid");

    // 越界目标在写库前被拒。
    assert.throws(
      () =>
        credentialUseTool(ctx, {
          action: "verify",
          credentialId: credential.id,
          targetAsset: "203.0.113.9",
          service: "ssh",
          verdict: "valid",
        }),
      /out of scope/,
    );
    assert.throws(
      () =>
        credentialUseTool(ctx, {
          action: "verify",
          credentialId: credential.id,
          targetAsset: "10.0.0.22",
          service: "ssh",
          verdict: "maybe",
        }),
      /valid\|invalid\|error/,
    );
  } finally {
    history.close();
    rmSync(root, { recursive: true, force: true });
  }
});
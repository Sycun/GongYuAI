import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { openHistory } from "@gongyuai/history";
import type { WorkerManifest } from "@gongyuai/contracts";
import {
  changeListTool,
  changeRecordTool,
  consultTool,
  credentialListTool,
  credentialRecordTool,
  hostProfileListTool,
  hostProfileRecordTool,
  type OpsToolContext,
} from "./ops-tools.js";

const TASK_ID = "22222222-2222-4222-8222-222222222222";

function setup(prefix: string) {
  const root = mkdtempSync(join(tmpdir(), prefix));
  const evidenceDir = join(root, "evidence");
  const workspaceDir = join(root, "workspace");
  mkdirSync(evidenceDir, { recursive: true });
  mkdirSync(workspaceDir, { recursive: true });
  const history = openHistory({ dbPath: join(root, "history.sqlite"), evidenceDir });
  const manifest: WorkerManifest = {
    taskId: TASK_ID,
    engagementId: "eng-b0",
    dataDir: root,
    historyDb: join(root, "history.sqlite"),
    durableDb: join(root, "durable.sqlite"),
    evidenceDir,
    workspaceDir,
    auth: {
      authorizationNote: "P14 B0 local fixture",
      targets: ["lab.example.com"],
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
    workerId: "w0-test",
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
  const ctx: OpsToolContext = {
    manifest,
    history,
    workerId: "w0-test",
    activeIntentId: null,
  };
  return { root, history, ctx, evidenceDir };
}

test("operator_consult creates a blocking consultation due in 24h", () => {
  const { root, history, ctx } = setup("gy-ops-consult-");
  try {
    const out = JSON.parse(
      consultTool(ctx, { question: "是否允许对 10.0.0.5 做只读枚举？", options: "允许, 拒绝" }),
    ) as { ok: boolean; consultId: string; dueAt: string; blocking: boolean };
    assert.equal(out.ok, true);
    assert.equal(out.blocking, true);
    const consult = history.ops.listConsults(TASK_ID)[0]!;
    assert.equal(consult.id, out.consultId);
    assert.equal(consult.engagementId, "eng-b0");
    assert.deepEqual(consult.options, ["允许", "拒绝"]);
    assert.ok(Date.parse(consult.dueAt) - Date.now() > 23 * 3600_000);
  } finally {
    history.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("change_record seals the pre-change backup hash and is listable", () => {
  const { root, history, ctx, evidenceDir } = setup("gy-ops-change-");
  try {
    writeFileSync(join(evidenceDir, "before.conf"), "old=1\n");
    const out = JSON.parse(
      changeRecordTool(ctx, {
        kind: "config",
        asset: "lab.example.com",
        location: "/etc/app.conf",
        rollbackCmd: "cp /evidence/before.conf /etc/app.conf",
        beforePath: "before.conf",
        note: "added debug flag",
      }),
    ) as { ok: boolean; change: { id: string; beforeSha256: string; kind: string } };
    assert.equal(out.ok, true);
    assert.equal(out.change.kind, "config");
    assert.match(out.change.beforeSha256, /^[a-f0-9]{64}$/);
    const listed = JSON.parse(changeListTool(ctx)) as { count: number; changes: Array<{ rollbackCmd: string }> };
    assert.equal(listed.count, 1);
    assert.match(listed.changes[0]!.rollbackCmd, /before\.conf/);
    // Worker path never executes the rollback command.
    assert.equal(history.ops.listChanges(TASK_ID).length, 1);
  } finally {
    history.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("credential_record keeps pointers only and refuses plaintext-looking refs", () => {
  const { root, history, ctx } = setup("gy-ops-cred-");
  try {
    const out = JSON.parse(
      credentialRecordTool(ctx, {
        kind: "password",
        asset: "https://lab.example.com/admin",
        username: "admin",
        secretRef: "evidence/credentials/admin.txt",
        verified: "true",
      }),
    ) as { ok: boolean; credential: { id: string; asset: string; secretRef: string } };
    assert.equal(out.ok, true);
    assert.equal(out.credential.asset, "lab.example.com");
    assert.equal(out.credential.secretRef, "evidence/credentials/***");
    const listed = JSON.parse(credentialListTool(ctx)) as { count: number };
    assert.equal(listed.count, 1);

    assert.throws(
      () =>
        credentialRecordTool(ctx, {
          kind: "password",
          asset: "lab.example.com",
          secretRef: "hunter2 plaintext",
        }),
      /pointer/,
    );
    assert.throws(
      () =>
        credentialRecordTool(ctx, {
          kind: "password",
          asset: "evil.example.net",
          secretRef: "evidence/credentials/x.txt",
        }),
      /out of scope/,
    );
  } finally {
    history.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("host_profile_record stores foothold fields and rejects out-of-scope asset", () => {
  const { root, history, ctx } = setup("gy-ops-profile-");
  try {
    const out = JSON.parse(
      hostProfileRecordTool(ctx, {
        asset: "lab.example.com",
        hostname: "web01",
        os: "Ubuntu 22.04",
        users: "www-data,root",
        privileges: "www-data,docker",
        services: "ssh:22,http:80",
        shares: "",
        av: "none",
        evidencePath: "profiles/web01.txt",
      }),
    ) as { ok: boolean; profile: { asset: string; users: string[]; privileges: string[] } };
    assert.equal(out.ok, true);
    assert.deepEqual(out.profile.users, ["www-data", "root"]);
    assert.deepEqual(out.profile.privileges, ["www-data", "docker"]);
    const listed = JSON.parse(hostProfileListTool(ctx)) as { count: number };
    assert.equal(listed.count, 1);
    assert.throws(
      () => hostProfileRecordTool(ctx, { asset: "evil.example.net" }),
      /out of scope/,
    );
  } finally {
    history.close();
    rmSync(root, { recursive: true, force: true });
  }
});

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
  hostProfileParseTool,
  hostProfileRecordTool,
  attackGraphRecordTool,
  bloodhoundImportTool,
  cloudRecordTool,
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

test("host_profile_parse structures Linux enumeration and skips unknown text", () => {
  const { root, history, ctx } = setup("gy-host-parse-");
  try {
    const parsed = JSON.parse(hostProfileParseTool(ctx, {
      asset: "lab.example.com",
      text: `uid=0(root) gid=0(root) groups=0(root),27(sudo)
Linux web01 6.8.0-45-generic aarch64 GNU/Linux
PRETTY_NAME="Ubuntu 24.04.1 LTS"
LISTEN 0 128 0.0.0.0:22 0.0.0.0:* users:(("sshd",pid=1,fd=3))`,
    })) as { ok: boolean; matched: string[]; profile: { users: string[]; privileges: string[]; services: string[]; os: string | null } };
    assert.equal(parsed.ok, true);
    assert.deepEqual(parsed.profile.users, ["root"]);
    assert.ok(parsed.profile.privileges.includes("group:sudo"));
    assert.ok(parsed.profile.services.includes("sshd/22"));
    assert.match(parsed.profile.os ?? "", /Ubuntu 24\.04/);
    assert.equal(history.listHostProfiles(TASK_ID).length, 1);

    const skipped = JSON.parse(hostProfileParseTool(ctx, {
      asset: "lab.example.com",
      text: "nothing useful",
    })) as { ok: boolean; skipped: boolean };
    assert.equal(skipped.ok, false);
    assert.equal(skipped.skipped, true);
  } finally {
    history.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("BloodHound import writes an AD graph and finds a Domain Admin path", () => {
  const { root, history, ctx } = setup("gy-bloodhound-");
  try {
    const data = JSON.stringify({
      users: [{ ObjectIdentifier: "U1", Properties: { name: "alice@CORP.LOCAL", domain: "CORP.LOCAL", owned: true } }],
      groups: [
        { ObjectIdentifier: "G1", Properties: { name: "HELPDESK@CORP.LOCAL" }, Members: [{ ObjectIdentifier: "U1" }] },
        { ObjectIdentifier: "G2", Properties: { name: "DOMAIN ADMINS@CORP.LOCAL" }, Members: [{ ObjectIdentifier: "G1" }] },
      ],
    });
    const result = JSON.parse(bloodhoundImportTool(ctx, { text: data })) as {
      ok: boolean; nodes: number; edges: number; paths: Array<{ nodes: string[]; depth: number }>;
    };
    assert.equal(result.ok, true);
    assert.equal(result.nodes, 3);
    assert.equal(result.edges, 2);
    assert.equal(result.paths[0]!.depth, 2);
    assert.deepEqual(result.paths[0]!.nodes, ["U1", "G1", "G2"]);
    const graph = history.attackGraph(TASK_ID);
    assert.equal(graph.nodes.length, 3);
    assert.equal(graph.edges.length, 2);
  } finally {
    history.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("cloud_record and attack_graph_record write typed cloud nodes/edges", () => {
  const { root, history, ctx } = setup("gy-cloud-graph-");
  try {
    const a = JSON.parse(cloudRecordTool(ctx, {
      provider: "aws", kind: "cloud-role", id: "arn:aws:iam::1:role/alice", name: "alice", account: "1",
    })) as { ok: boolean; factId: string };
    assert.equal(a.ok, true);
    const b = JSON.parse(cloudRecordTool(ctx, {
      provider: "aws", kind: "cloud-resource", id: "arn:aws:s3:::secret", name: "secret", account: "1",
      edgeFrom: "arn:aws:iam::1:role/alice", edgeTo: "arn:aws:s3:::secret", edgeKind: "can-access",
    })) as { ok: boolean; edgeFactId: string };
    assert.ok(b.edgeFactId);
    const graph = history.attackGraph(TASK_ID);
    assert.equal(graph.nodes.length, 2);
    assert.equal(graph.edges[0]!.kind, "can-access");

    const node = JSON.parse(attackGraphRecordTool(ctx, {
      type: "node",
      json: JSON.stringify({ id: "S-1-5-21-512", kind: "ad-group", name: "Domain Admins" }),
    })) as { ok: boolean };
    assert.equal(node.ok, true);
  } finally {
    history.close();
    rmSync(root, { recursive: true, force: true });
  }
});

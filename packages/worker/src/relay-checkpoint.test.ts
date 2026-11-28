import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ORIGIN_FACT_ID, type WorkerManifest } from "@gongyuai/contracts";
import { openHistory } from "@gongyuai/history";
import {
  formatRelayInjection,
  listRelayProtocols,
  synthesizeGroundedRelayFields,
  writeRelayProtocol,
} from "./relay-protocol.js";

const TASK = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";

function makeManifest(root: string): WorkerManifest {
  return {
    taskId: TASK,
    dataDir: root,
    historyDb: join(root, "h.sqlite"),
    durableDb: join(root, "d.sqlite"),
    evidenceDir: join(root, "evidence"),
    workspaceDir: root,
    auth: { authorizationNote: "relay checkpoint test", targets: ["10.0.0.0/24"], outOfScope: [], capability: "full" },
    scopeVersion: 1,
    goals: [],
    budget: { maxTokens: 0, maxWallMs: 0, maxToolCalls: 0, maxInstalls: 0, relayTokenThreshold: 30_000, relayMinToolCalls: 2 },
    execution: { maxConcurrentExplores: 1, maxIntentsPerReason: 4, maxIntentsPerAssetRoot: 2, exploreTimeoutMs: 900_000, reasonLeaseMs: 120_000 },
    workerId: "w0",
    workerSlot: 0,
    workerCount: 1,
    commandConfirmation: "auto",
    mock: true,
    mcpServers: [], mcpPool: [], mcpCatalog: [], skillPacks: [], skillPool: [], skillCatalog: [], assetCollectors: [],
  };
}

test("RelayProtocol 五槽位：新旧 π 双向兼容（旧 π0.json 缺字段解析为默认空串）", () => {
  const root = mkdtempSync(join(tmpdir(), "gy-relay-cp-"));
  const manifest = makeManifest(root);
  const history = openHistory({ dbPath: manifest.historyDb, evidenceDir: manifest.evidenceDir });
  try {
    mkdirSync(join(root, "relay"), { recursive: true });
    writeFileSync(
      join(root, "relay", "π0.json"),
      JSON.stringify({
        generation: 0,
        createdAt: "2026-11-01T00:00:00.000Z",
        trigger: "agent",
        reason: "legacy",
        current_position: "old",
        network_map: "10.0.0.0/24",
        tried: "nmap",
        active_sessions: "",
        foothold: "ssh",
        unexplored_surface: "/api",
        open_intents: [],
        budget_spent: { tokens: 10, toolCalls: 2, wallMs: 1000 },
      }),
    );
    const legacy = listRelayProtocols(root);
    assert.equal(legacy.length, 1);
    assert.equal(legacy[0]!.confirmed_architecture_and_decoys, "");
    assert.equal(legacy[0]!.falsified_hypotheses, "");
    assert.equal(legacy[0]!.workspace_artifacts, "");
    assert.equal(legacy[0]!.live_footholds, "");
    assert.equal(legacy[0]!.next_falsifiable_experiment, "");

    const modern = writeRelayProtocol(manifest, history, {
      trigger: "agent",
      reason: "structured",
      foothold: "ssh user@10.0.0.5",
      confirmed_architecture_and_decoys: "nginx→php-fpm; /old 是诱饵死分支",
      falsified_hypotheses: "SQLi on /login → WAF 404 拦截（证据 curl -w %{http_code}）",
      workspace_artifacts: "workspace/extract/dump.bin",
      live_footholds: "cred c1@10.0.0.5; 127.0.0.1:22022 → 10.0.0.5:22",
      next_falsifiable_experiment: "验证 /api/v2 的 IDOR",
      tokens: 42,
      toolCalls: 5,
      generation: 1,
    });
    assert.equal(modern.generation, 1);
    assert.equal(modern.confirmed_architecture_and_decoys, "nginx→php-fpm; /old 是诱饵死分支");
    assert.equal(modern.next_falsifiable_experiment, "验证 /api/v2 的 IDOR");

    const listed = listRelayProtocols(root);
    const parsedModern = listed.find((p) => p.generation === 1)!;
    assert.equal(parsedModern.falsified_hypotheses, "SQLi on /login → WAF 404 拦截（证据 curl -w %{http_code}）");
    assert.equal(parsedModern.workspace_artifacts, "workspace/extract/dump.bin");

    const text = formatRelayInjection(listed);
    assert.match(text, /confirmed_architecture_and_decoys: nginx→php-fpm/);
    assert.match(text, /falsified_hypotheses: SQLi on \/login/);
    assert.match(text, /workspace_artifacts: workspace\/extract\/dump\.bin/);
    assert.match(text, /live_footholds: cred c1@10\.0\.0\.5/);
    assert.match(text, /next_falsifiable_experiment: 验证 \/api\/v2 的 IDOR/);
  } finally {
    history.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("synthesizeGroundedRelayFields：从 History 合成五槽位客观占位", () => {
  const root = mkdtempSync(join(tmpdir(), "gy-relay-synth-"));
  const manifest = makeManifest(root);
  const history = openHistory({ dbPath: manifest.historyDb, evidenceDir: manifest.evidenceDir });
  try {
    const active = history.proposeIntent({
      taskId: TASK,
      title: "管理面 SQLi",
      sourceFactIds: [ORIGIN_FACT_ID],
      assetRoot: "10.0.0.10",
      technique: "sqli",
    });
    history.claimIntent(TASK, active.id, "w0");
    history.appendFact({
      taskId: TASK,
      layer: "title",
      title: "dump segment",
      evidencePath: "workspace/extract/dump.bin",
      tags: [],
    });
    history.recordCredential({
      taskId: TASK,
      kind: "password",
      asset: "10.0.0.10",
      username: "admin",
      secretRef: "evidence/creds/admin.txt",
    });
    history.recordHostProfile(TASK, {
      asset: "10.0.0.10",
      os: "linux",
      users: ["www-data"],
      privileges: ["www-data"],
      services: ["nginx", "php-fpm"],
    });
    history.recordTacticalLesson({
      taskId: TASK,
      intentId: active.id,
      assetRoot: "10.0.0.10",
      familyKey: "nginx",
      techTags: ["sqli"],
      falsifiedHypotheses: [
        {
          hypothesis: "/login 参数可注入",
          commandEvidence: "sqlmap -u http://10.0.0.10/login",
          resultSummary: "WAF 404 拦截",
        },
      ],
      nextPivotAdvice: "转 /api/v2 IDOR",
    });

    const grounded = synthesizeGroundedRelayFields(history, TASK, active.id);
    assert.match(grounded.current_position, new RegExp(active.id));
    assert.match(grounded.workspace_artifacts, /workspace\/extract\/dump\.bin/);
    assert.match(grounded.falsified_hypotheses, /\/login 参数可注入/);
    assert.match(grounded.live_footholds, /creds=.*10\.0\.0\.10/);
    assert.match(grounded.live_footholds, /tunnel_list/);
    assert.match(grounded.confirmed_architecture_and_decoys, /10\.0\.0\.10: os=linux/);
    assert.match(grounded.next_falsifiable_experiment, /管理面 SQLi/);
  } finally {
    history.close();
    rmSync(root, { recursive: true, force: true });
  }
});
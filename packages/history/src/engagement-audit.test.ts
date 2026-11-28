import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { openHistory, CommandLedger } from "./index.js";

const TASK_ID = "55555555-5555-4555-8555-555555555555";

function setup(prefix: string) {
  const root = mkdtempSync(join(tmpdir(), prefix));
  const evidenceDir = join(root, "evidence");
  mkdirSync(evidenceDir, { recursive: true });
  const store = openHistory({ dbPath: join(root, "history.sqlite"), evidenceDir });
  return { root, store };
}

test("engagementAudit derives repeat failures, untouched assets and tentative backlog", () => {
  const { root, store } = setup("gy-audit-");
  try {
    const auth = { targets: ["*.example.com"], outOfScope: [] };
    const lab = store.recordAsset({
      taskId: TASK_ID,
      address: "lab.example.com",
      auth,
      live: true,
    }).fact;
    store.recordAsset({
      taskId: TASK_ID,
      address: "api.example.com",
      auth,
      live: true,
      weight: 4,
    });
    store.recordAsset({
      taskId: TASK_ID,
      address: "core.example.com",
      auth,
      live: true,
      weight: 5,
    });

    for (const title of ["inject-1", "inject-2", "inject-3"]) {
      const proposed = store.proposeIntent({
        taskId: TASK_ID,
        title,
        sourceFactIds: [lab.id],
        technique: "CWE-89",
        assetRoot: "api.example.com",
      });
      store.claimIntent(TASK_ID, proposed.id, "worker-test");
      store.concludeIntent(TASK_ID, proposed.id, "failed", "no injection point", { workerId: "worker-test" });
    }

    for (const [vulnClass, endpoint] of [
      ["CWE-89", "/login"],
      ["CWE-79", "/search"],
      ["CWE-22", "/download"],
    ] as const) {
      store.recordFinding({
        taskId: TASK_ID,
        title: `${vulnClass} candidate`,
        asset: "api.example.com",
        vulnClass,
        severity: "high",
        endpoint: `https://api.example.com${endpoint}`,
      });
    }

    const audit = store.engagementAudit(TASK_ID);
    const codes = audit.observations.map((item) => item.code);
    assert.ok(codes.includes("repeat-failure"), JSON.stringify(codes));
    assert.ok(codes.includes("unexplored-asset"), JSON.stringify(codes));
    assert.ok(codes.includes("tentative-backlog"), JSON.stringify(codes));
    assert.equal(audit.scorecard.intents.failed, 3);
    assert.equal(audit.scorecard.findings.tentative, 3);
    assert.equal(audit.scorecard.findings.confirmed, 0);
    assert.equal(audit.scorecard.assets.untouched, 2);
    assert.equal(
      audit.observations.find((item) => item.code === "unexplored-asset")!.refs[0],
      "core.example.com",
    );

    const observe = store.observe(TASK_ID);
    assert.match(observe, /## 观察员（只读自动派生）/);
    assert.match(observe, /## 作业记分卡/);
    assert.match(observe, /确认率 0%/);
    assert.match(observe, /空台账|待确认|未测/);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("Observe projects credential spray ledger and unclosed single-attempt scope-brief debt; CommandLedger expires stale epoch tickets", () => {
  const { root, store } = setup("gy-observe-debt-");
  try {
    const auth = { targets: ["10.0.160.0/24"], outOfScope: [] };
    store.recordAsset({ taskId: TASK_ID, address: "10.0.160.129", auth, live: true });
    const briefE304 = store.appendFact({
      taskId: TASK_ID,
      layer: "title",
      title: "委托简报 [e3-04] 终端检测规避",
      summary: "目标标识：e3-04",
      tags: ["scope-brief", "transferable", "challenge:e3-04", "asset.addr:10.0.160.129"],
    });
    const briefE103 = store.appendFact({
      taskId: TASK_ID,
      layer: "title",
      title: "委托简报 [e1-03] WAF 诊断绕过",
      summary: "目标标识：e1-03",
      tags: ["scope-brief", "transferable", "challenge:e1-03", "asset.addr:10.0.160.129"],
    });

    const i1 = store.proposeIntent({
      taskId: TASK_ID,
      title: "e3-04 首探",
      sourceFactIds: [briefE304.id],
      technique: "contract-probe",
      assetRoot: "10.0.160.129",
    });
    store.claimIntent(TASK_ID, i1.id, "w1");
    store.concludeIntent(TASK_ID, i1.id, "failed", "POST /check returned HTTP 500 without Win32 API symbols", { workerId: "w1" });

    for (const n of [1, 2]) {
      const ix = store.proposeIntent({
        taskId: TASK_ID,
        title: `e1-03 探索 #${n}`,
        sourceFactIds: [briefE103.id],
        technique: `waf-${n}`,
        assetRoot: "10.0.160.129",
      });
      store.claimIntent(TASK_ID, ix.id, "w2");
      store.concludeIntent(TASK_ID, ix.id, "succeeded", "bypassed WAF", {
        workerId: "w2",
        facts: [{ layer: "title", title: `e1-03 verified #${n}` }],
      });
    }

    store.recordCredential({
      taskId: TASK_ID,
      kind: "password",
      asset: "10.0.160.128",
      username: "zhangwei",
      secretRef: "evidence/b-02/init-sql.txt",
      verified: true,
      tier: "L2",
    });

    const observe = store.observe(TASK_ID);
    assert.match(observe, /## 委托范围受挫待回补项/);
    assert.match(observe, /e3-04（失败 1 次，0 成功/);
    assert.doesNotMatch(observe, /e1-03（失败/);
    assert.match(observe, /## 凭据台账/);
    assert.match(observe, /user=zhangwei .* ref=evidence\/b-02\/init-sql\.txt/);

    const ledger = new CommandLedger(root);
    try {
      ledger.activate(TASK_ID, 1);
      const orphan = ledger.request(TASK_ID, 1, { tool: "shell", summary: "id", digest: "d1", command: "id" });
      assert.equal(ledger.state(orphan.id), "pending");
      // Advancing to fence 2 expires orphan pending tickets from fence 1
      ledger.activate(TASK_ID, 2);
      assert.equal(ledger.state(orphan.id), "expired");
      assert.equal(ledger.get(orphan.id)?.receipt?.decision, "expired");

      const activeTicket = ledger.request(TASK_ID, 2, { tool: "shell", summary: "whoami", digest: "d2", command: "whoami" });
      ledger.deactivate(TASK_ID, 2);
      assert.equal(ledger.state(activeTicket.id), "expired");
    } finally {
      ledger.close();
    }
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

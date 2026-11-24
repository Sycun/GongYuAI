import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { openHistory } from "./index.js";

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
      store.concludeIntent(TASK_ID, proposed.id, "failed", "no injection point");
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

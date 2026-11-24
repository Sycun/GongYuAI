import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import { ORIGIN_FACT_ID } from "@gongyuai/contracts";
import { openHistory } from "./index.js";

const TASK = "66666666-6666-4666-8666-666666666666";

const AUTH = {
  targets: ["*.example.com"],
  outOfScope: [] as string[],
  pivotPolicy: { mode: "off" as const, cidrs: [] as string[] },
};

function setup(prefix: string) {
  const root = mkdtempSync(join(tmpdir(), prefix));
  const evidenceDir = join(root, "evidence");
  mkdirSync(evidenceDir, { recursive: true });
  const dbPath = join(root, "history.sqlite");
  const store = openHistory({ dbPath, evidenceDir });
  return { root, dbPath, evidenceDir, store };
}

function claimUmbrella(
  store: ReturnType<typeof openHistory>,
  taskId = TASK,
  workerId = "w0",
) {
  const intent = store.proposeIntent({
    taskId,
    title: "伞形 Intent",
    sourceFactIds: [ORIGIN_FACT_ID],
  });
  store.claimIntent(taskId, intent.id, workerId);
  return intent;
}

test("不传 intentId：Fact / 资产 / 凭据 / Finding 全部继承活跃 Intent", () => {
  const { root, store } = setup("gy-active-inherit-");
  try {
    const intent = claimUmbrella(store);

    const fact = store.appendFact({
      taskId: TASK,
      layer: "title",
      title: "nmap 开放 22/80",
      summary: "",
    });
    assert.equal(fact.intentId, intent.id);

    const asset = store.recordAsset({
      taskId: TASK,
      address: "app.example.com",
      auth: AUTH,
      live: true,
    });
    assert.equal(asset.fact.intentId, intent.id);
    assert.equal(asset.asset.intentId, intent.id);

    const credential = store.recordCredential({
      taskId: TASK,
      kind: "password",
      asset: "app.example.com",
      username: "admin",
      secretRef: "evidence/creds.txt",
    });
    assert.ok(credential.credential.factId);
    assert.equal(store.getFact(TASK, credential.credential.factId!)!.intentId, intent.id);

    const finding = store.recordFinding({
      taskId: TASK,
      title: "SQLi",
      asset: "app.example.com",
      vulnClass: "CWE-89",
      severity: "high",
      factIds: [fact.id],
    });
    assert.equal(finding.finding.intentId, intent.id);

    // 图谱层面：Explore 事实有父节点，不再孤立。
    const dag = store.dagExport(TASK, "2026-11-24T00:00:00.000Z");
    assert.equal(dag.facts.filter((entry) => entry.intentId === null).length, 0);
    assert.equal(
      dag.edges.find(
        (edge) => edge.kind === "produces" && edge.from === `intent:${intent.id}` && edge.to === `fact:${fact.id}`,
      )?.verification,
      "proven",
    );
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("显式 intentId 优先：显式别的 Intent 或显式 null 都不被继承覆盖", () => {
  const { root, store } = setup("gy-active-explicit-");
  try {
    const active = claimUmbrella(store);
    const other = store.proposeIntent({
      taskId: TASK,
      title: "另一个 Intent",
      sourceFactIds: [ORIGIN_FACT_ID],
    });

    const explicitOther = store.appendFact({
      taskId: TASK,
      layer: "title",
      title: "挂到别的 Intent",
      intentId: other.id,
    });
    assert.equal(explicitOther.intentId, other.id);

    const explicitNull = store.appendFact({
      taskId: TASK,
      layer: "summary",
      title: "任务级事实，明确不挂父节点",
      intentId: null,
    });
    assert.equal(explicitNull.intentId, null);

    const assetNull = store.recordAsset({
      taskId: TASK,
      address: "seed.example.com",
      auth: AUTH,
      intentId: null,
    });
    assert.equal(assetNull.fact.intentId, null);

    const findingOther = store.recordFinding({
      taskId: TASK,
      title: "XSS",
      asset: "app.example.com",
      vulnClass: "CWE-79",
      severity: "medium",
      intentId: other.id,
    });
    assert.equal(findingOther.finding.intentId, other.id);
    assert.notEqual(findingOther.finding.intentId, active.id);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("没有活跃 Intent：写入保持孤立（不编造父节点）", () => {
  const { root, store } = setup("gy-active-none-");
  try {
    const fact = store.appendFact({ taskId: TASK, layer: "title", title: "bootstrap 事实" });
    assert.equal(fact.intentId, null);
    const finding = store.recordFinding({
      taskId: TASK,
      title: "线索",
      asset: "app.example.com",
      vulnClass: "CWE-89",
      severity: "low",
    });
    assert.equal(finding.finding.intentId, null);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("收卷即解绑：conclude 之后的事实不再继承（宁可不挂，不乱挂）", () => {
  const { root, store } = setup("gy-active-conclude-");
  try {
    const intent = claimUmbrella(store);
    store.concludeIntent(TASK, intent.id, "failed", "换面", {
      workerId: "w0",
      facts: [{ layer: "title", title: "partial" }],
    });
    assert.equal(store.resolveActiveIntentId(TASK), null);
    const after = store.appendFact({ taskId: TASK, layer: "title", title: "conclude 后" });
    assert.equal(after.intentId, null);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("relay 重启恢复：新 store 无绑定，heartbeat 成功即重新绑定；非认领人 heartbeat 不绑", () => {
  const { root, dbPath, evidenceDir, store } = setup("gy-active-restart-");
  const second = openHistory({ dbPath, evidenceDir });
  try {
    const intent = claimUmbrella(store);

    // 模拟 relay 重启：新进程打开同一个库，内存绑定为空。
    const beforeRestart = second.appendFact({
      taskId: TASK,
      layer: "title",
      title: "重启后第一轮（尚未 heartbeat）",
    });
    assert.equal(beforeRestart.intentId, null);

    // 认领人 heartbeat 成功 → 恢复绑定。
    assert.equal(second.heartbeatIntent(TASK, intent.id, "w0"), true);
    const afterHeartbeat = second.appendFact({
      taskId: TASK,
      layer: "title",
      title: "重启 + heartbeat 之后",
    });
    assert.equal(afterHeartbeat.intentId, intent.id);

    // 非认领人 heartbeat 失败 → 不绑定，写入仍孤立。
    second.bindActiveIntent(TASK, null);
    assert.equal(second.heartbeatIntent(TASK, intent.id, "w-other"), false);
    const afterForeign = second.appendFact({
      taskId: TASK,
      layer: "title",
      title: "别人的 heartbeat",
    });
    assert.equal(afterForeign.intentId, null);
  } finally {
    second.close();
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("绑定与过期：未知 Intent 拒绝绑定；过期 Intent 自动解绑", () => {
  const { root, store } = setup("gy-active-expire-");
  try {
    assert.throws(() => store.bindActiveIntent(TASK, "unknown-intent"), /unknown active intent/);
    const intent = claimUmbrella(store);
    assert.equal(store.resolveActiveIntentId(TASK), intent.id);

    const swept = store.expireStaleIntents(TASK, 0);
    assert.equal(swept.length, 1);
    assert.equal(store.resolveActiveIntentId(TASK), null);
    const after = store.appendFact({ taskId: TASK, layer: "title", title: "过期后" });
    assert.equal(after.intentId, null);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

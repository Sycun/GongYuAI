import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { ORIGIN_FACT_ID } from "@gongyuai/contracts";
import { openHistory } from "./index.js";
import { renderSurfaceMutexDeclaration } from "./observe-view.js";

const TASK = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

function freshStore(prefix: string) {
  const root = mkdtempSync(join(tmpdir(), prefix));
  const evidenceDir = join(root, "evidence");
  mkdirSync(evidenceDir, { recursive: true });
  const store = openHistory({ dbPath: join(root, "history.sqlite"), evidenceDir });
  return { root, evidenceDir, store };
}

test("worker_advisories：入队、定向/槽位/私网段匹配、单次原子消费", () => {
  const { root, store } = freshStore("gy-adv-");
  try {
    const intentA = store.proposeIntent({
      taskId: TASK,
      title: "A",
      sourceFactIds: [ORIGIN_FACT_ID],
      assetRoot: "10.0.0.10",
    });
    const intentB = store.proposeIntent({
      taskId: TASK,
      title: "B",
      sourceFactIds: [ORIGIN_FACT_ID],
      assetRoot: "192.168.5.20",
    });
    store.claimIntent(TASK, intentA.id, "w0");
    store.claimIntent(TASK, intentB.id, "w1");

    const forA = store.enqueueAdvisory({
      taskId: TASK,
      kind: "tactical_advisory",
      priority: "urgent",
      targetIntentId: intentA.id,
      assetScope: "10.0.0.10",
      summary: "停止重复探测 /admin，换 /api/v2",
      createdBy: "leader",
    });
    const forSlot = store.enqueueAdvisory({
      taskId: TASK,
      kind: "surface_redirect",
      targetWorkerSlot: 2,
      summary: "slot 2 接管内网段",
      createdBy: "leader",
    });
    const forPeer = store.enqueueAdvisory({
      taskId: TASK,
      kind: "resource_broadcast",
      targetIntentId: intentB.id,
      assetScope: "192.168.5.20",
      summary: "新凭据 id=c1",
      createdBy: "w0",
    });
    const forSubnet = store.enqueueAdvisory({
      taskId: TASK,
      kind: "resource_broadcast",
      assetScope: "192.168.5.20",
      summary: "子网级广播 id=c2",
      createdBy: "w0",
    });

    const first = store.consumePendingAdvisories(TASK, {
      activeIntentId: intentA.id,
      workerSlot: 0,
      assetRoot: "10.0.0.10",
    });
    assert.deepEqual(first.map((a) => a.id), [forA.id]);
    assert.ok(first[0]!.consumedAt);
    assert.equal(first[0]!.consumedBySlot, 0);

    // Single atomic consumption: a second drain must return nothing.
    const second = store.consumePendingAdvisories(TASK, {
      activeIntentId: intentA.id,
      workerSlot: 0,
      assetRoot: "10.0.0.10",
    });
    assert.deepEqual(second, []);

    const slotOnly = store.consumePendingAdvisories(TASK, {
      activeIntentId: null,
      workerSlot: 2,
      assetRoot: null,
    });
    assert.deepEqual(slotOnly.map((a) => a.id), [forSlot.id]);

    // Scope-only broadcast matches same RFC1918 /24, while `forPeer` (explicit targetIntentId=intentB)
    // is NOT hijacked by an unrelated worker on 192.168.5.99.
    const crossSlot = store.consumePendingAdvisories(TASK, {
      activeIntentId: null,
      workerSlot: 7,
      assetRoot: "192.168.5.99",
      workerId: "w7",
    });
    assert.deepEqual(crossSlot.map((a) => a.id), [forSubnet.id]);

    // `intentB` itself still receives its dedicated `forPeer` advisory intact.
    const peerExact = store.consumePendingAdvisories(TASK, {
      activeIntentId: intentB.id,
      workerSlot: 1,
      assetRoot: "192.168.5.20",
      workerId: "w1",
    });
    assert.deepEqual(peerExact.map((a) => a.id), [forPeer.id]);

    const again = store.consumePendingAdvisories(TASK, {
      activeIntentId: intentB.id,
      workerSlot: 1,
      assetRoot: "192.168.5.20",
    });
    assert.deepEqual(again, []);

    const recent = store.listRecentAdvisories(TASK, 10);
    assert.equal(recent.length, 4);
    assert.ok(recent.every((a) => a.consumedAt !== null));
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("tactical_lessons：非空证据硬约束、同资产死路召回与同族经验召回", () => {
  const { root, store } = freshStore("gy-lesson-");
  try {
    let rejectedEmptyEvidence = false;
    try {
      store.recordTacticalLesson({
        taskId: TASK,
        assetRoot: "10.0.0.10",
        falsifiedHypotheses: [
          { hypothesis: "旧路由可直达后台", commandEvidence: "", resultSummary: "404" },
        ],
      });
    } catch {
      rejectedEmptyEvidence = true;
    }
    assert.equal(rejectedEmptyEvidence, true, "empty commandEvidence must be rejected");

    const exact = store.recordTacticalLesson({
      taskId: TASK,
      assetRoot: "http://10.0.0.10:8080",
      familyKey: "Nginx",
      techTags: ["cve-2021-23017"],
      falsifiedHypotheses: [
        {
          hypothesis: "/old 路由可直达管理端",
          commandEvidence: "curl -sS http://10.0.0.10/old -w '%{http_code}'",
          resultSummary: "HTTP 404，路由不存在",
        },
      ],
      antipatterns: ["继续枚举 /old 前缀"],
      effectivePattern: "优先 /api/v2 越权参数",
      nextPivotAdvice: "转 /api/v2 对比双账号响应",
    });
    assert.equal(exact.assetRoot, "10.0.0.10");
    assert.equal(exact.familyKey, "nginx");

    const sibling = store.recordTacticalLesson({
      taskId: TASK,
      assetRoot: "10.0.0.11",
      familyKey: "nginx",
      techTags: ["tls-config"],
      effectivePattern: "/api/v2 双账号差分有效",
    });
    const taggedOnly = store.recordTacticalLesson({
      taskId: TASK,
      assetRoot: "10.0.0.99",
      familyKey: "apache",
      techTags: ["cve-2021-23017"],
      nextPivotAdvice: "按同 CVE 复核模块版本",
    });

    const recall = store.recallTacticalLessons(TASK, {
      assetRoot: "10.0.0.10",
      familyKey: "nginx",
      techTags: ["cve-2021-23017"],
    });
    assert.deepEqual(recall.exactAssetLessons.map((l) => l.id), [exact.id]);
    const siblingIds = recall.siblingFamilyLessons.map((l) => l.id).sort();
    assert.deepEqual(siblingIds, [sibling.id, taggedOnly.id].sort());

    const tagRecall = store.recallTacticalLessons(TASK, { techTags: ["cve-2021-23017"] });
    assert.deepEqual(tagRecall.exactAssetLessons, []);
    assert.deepEqual(tagRecall.siblingFamilyLessons.map((l) => l.id).sort(), [
      taggedOnly.id,
      exact.id,
    ].sort());

    const intent = store.proposeIntent({
      taskId: TASK,
      title: "lesson owner",
      sourceFactIds: [ORIGIN_FACT_ID],
      assetRoot: "10.0.0.42",
    });
    assert.equal(store.hasTacticalLessonForIntent(TASK, intent.id), false);
    store.recordTacticalLesson({
      taskId: TASK,
      intentId: intent.id,
      assetRoot: "10.0.0.42",
      nextPivotAdvice: "换面",
    });
    assert.equal(store.hasTacticalLessonForIntent(TASK, intent.id), true);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("intents：assigned_surfaces_json / mutex_note 幂等加列并读写映射", () => {
  const root = mkdtempSync(join(tmpdir(), "gy-intent-cols-"));
  const evidenceDir = join(root, "evidence");
  mkdirSync(evidenceDir, { recursive: true });
  const dbPath = join(root, "legacy.sqlite");
  const legacy = new DatabaseSync(dbPath);
  legacy.exec(`
    CREATE TABLE intents (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      title TEXT NOT NULL,
      summary TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL,
      claimed_by TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      concluded_at TEXT,
      conclusion TEXT
    );
    INSERT INTO intents (id, task_id, title, summary, status, claimed_by, created_at, updated_at)
    VALUES ('legacy-intent', '${TASK}', 'legacy row', '', 'proposed', NULL,
            '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
  `);
  legacy.close();
  try {
    let store = openHistory({ dbPath, evidenceDir });
    const legacyRow = store.getIntent(TASK, "legacy-intent");
    assert.ok(legacyRow);
    assert.deepEqual(legacyRow!.assignedSurfaces, []);
    assert.equal(legacyRow!.mutexNote, "");
    const created = store.proposeIntent({
      taskId: TASK,
      title: "partitioned",
      sourceFactIds: [ORIGIN_FACT_ID],
      assetRoot: "10.0.0.10",
      assignedSurfaces: ["/admin", "/api", "/admin"],
      mutexNote: "只测 /admin，不碰 /api",
    });
    assert.deepEqual(created.assignedSurfaces, ["/admin", "/api"]);
    assert.equal(created.mutexNote, "只测 /admin，不碰 /api");
    const fetched = store.getIntent(TASK, created.id)!;
    assert.deepEqual(fetched.assignedSurfaces, ["/admin", "/api"]);
    assert.equal(fetched.mutexNote, "只测 /admin，不碰 /api");
    store.close();

    // Re-open runs the same migration again: idempotent, values retained.
    store = openHistory({ dbPath, evidenceDir });
    const listed = store.listIntents(TASK).find((i) => i.id === created.id)!;
    assert.deepEqual(listed.assignedSurfaces, ["/admin", "/api"]);
    assert.equal(listed.mutexNote, "只测 /admin，不碰 /api");
    const cols = new DatabaseSync(dbPath).prepare(`PRAGMA table_info(intents)`).all() as Array<{
      name: string;
    }>;
    const names = cols.map((c) => c.name);
    assert.ok(names.includes("assigned_surfaces_json"));
    assert.ok(names.includes("mutex_note"));
    assert.equal(names.filter((n) => n === "assigned_surfaces_json").length, 1);
    store.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("observe-view：并发友邻互斥声明与运行脉搏渲染", () => {
  const { root, store } = freshStore("gy-mutex-");
  try {
    const active = store.proposeIntent({
      taskId: TASK,
      title: "管理面攻坚",
      sourceFactIds: [ORIGIN_FACT_ID],
      assetRoot: "10.0.0.10",
      assignedSurfaces: ["/admin", "/login"],
      mutexNote: "只做认证面，不碰 /api",
    });
    const peer = store.proposeIntent({
      taskId: TASK,
      title: "API 面并行",
      sourceFactIds: [ORIGIN_FACT_ID],
      assetRoot: "10.0.0.11",
      assignedSurfaces: ["/api/v2"],
      mutexNote: "只做 API 差分",
    });
    const far = store.proposeIntent({
      taskId: TASK,
      title: "公网独立资产",
      sourceFactIds: [ORIGIN_FACT_ID],
      assetRoot: "app.example.com",
      assignedSurfaces: ["/"],
    });
    store.claimIntent(TASK, active.id, "w0");
    store.claimIntent(TASK, peer.id, "w1");
    store.claimIntent(TASK, far.id, "w2");
    store.appendFact({
      taskId: TASK,
      layer: "title",
      title: "pulse fact on admin",
      intentId: active.id,
    });

    const intents = store.listIntents(TASK);
    const activeRow = intents.find((i) => i.id === active.id)!;
    const block = renderSurfaceMutexDeclaration(activeRow, intents);
    assert.ok(block);
    assert.match(block!, /并发槽位子表面互斥声明/);
    assert.match(block!, /API 面并行/);
    assert.match(block!, /\/api\/v2/);
    assert.match(block!, /只做 API 差分/);
    assert.doesNotMatch(block!, /公网独立资产/);

    const obs = store.observe(TASK);
    assert.match(obs, /surfaces=\/admin,\/login/);
    assert.match(obs, /mutex=只做认证面/);
    assert.match(obs, /claimed_by=w0/);
    assert.match(obs, /已运行/);
    assert.match(obs, /最新事实: pulse fact on admin/);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});
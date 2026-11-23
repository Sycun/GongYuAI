/**
 * 委托隔离双向验收（隔离数据目录 + 真实 HTTP 入口）。
 *
 * 委托 A、B 各有专属资料，另有一份两边可见的共享资料。检索、计数、摘要、
 * 详情、历史版本、段落、引用写入与解析、报告导出都必须按服务端范围放行。
 *
 * 本运行环境是单操作者、无认证层：这里验收的是**委托边界**，
 * 用户级权限（谁能声明哪个委托）不在本轮验证范围内。
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { CreateTaskRequestSchema } from "@gongyuai/contracts";
import { openHistory } from "@gongyuai/history";
import { bootControlPlane, taskPaths } from "./index.js";

const ENG_A = "eng-iso-alpha";
const ENG_B = "eng-iso-beta";
const KEY_A = "阿尔法专属关键词";
const KEY_B = "贝塔专属关键词";
const KEY_SHARED = "伽马共享关键词";

async function call(method: string, url: string, body?: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(url, {
    method,
    headers: { ...(body === undefined ? {} : { "content-type": "application/json" }), ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch { /* markdown */ }
  return { status: res.status, text, json };
}

async function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), "gy-knowledge-iso-"));
  const plane = await bootControlPlane({
    dataRoot: root, host: "127.0.0.1", port: 0, runtime: "local", isolated: true, watchdogMs: 60_000,
    knowledgeEmbedding: { enabled: false },
  });
  t.after(async () => { await plane.close(); rmSync(root, { recursive: true, force: true }); });

  const makeTask = (engagementId: string, name: string) => {
    const task = plane.store.createTask(CreateTaskRequestSchema.parse({
      name, engagementId,
      auth: { targets: [`${engagementId}.invalid`], authorizationNote: "虚构材料，仅用于隔离验收" },
      goals: [{ id: "g1", title: "隔离验收", description: "跨委托不得泄露", evidencePatterns: ["knowledge/*.json"] }],
      mock: true,
    }));
    const paths = taskPaths(task.dataDir);
    const history = openHistory({ dbPath: paths.historyDb, evidenceDir: paths.evidenceDir });
    history.seedGoals(task.id, task.goals);
    history.close();
    plane.store.finishTask(task, "completed", null);
    return task;
  };
  const taskA = makeTask(ENG_A, "委托 A");
  const taskB = makeTask(ENG_B, "委托 B");

  const importMaterial = async (scope: unknown, title: string, keyword: string) => {
    const res = await call("POST", `${plane.url}/knowledge/materials`, {
      title, publisher: "隔离验收", sourceKind: "original", format: "markdown",
      sourceUrl: `https://example.invalid/${encodeURIComponent(title)}`,
      content: `## ${title}\n\n本段包含 ${keyword}，用于验证委托边界。`,
      tags: [keyword], scope,
    });
    assert.equal(res.status, 201, res.text);
    return { materialId: res.json.material.id as string, versionId: res.json.version.id as string, locator: res.json.sections[0].locator as string };
  };
  const onlyA = await importMaterial({ kind: "engagement", engagementId: ENG_A }, "委托A专属材料", KEY_A);
  const onlyB = await importMaterial({ kind: "engagement", engagementId: ENG_B }, "委托B专属材料", KEY_B);
  const shared = await importMaterial({ kind: "shared" }, "团队共享材料", KEY_SHARED);

  return {
    plane, taskA, taskB, onlyA, onlyB, shared,
    baseA: `${plane.url}/tasks/${taskA.id}`,
    baseB: `${plane.url}/tasks/${taskB.id}`,
    search: (q: string, engagementId?: string) =>
      call("GET", `${plane.url}/knowledge/search?q=${encodeURIComponent(q)}${engagementId ? `&engagementId=${engagementId}` : ""}`),
  };
}

test("检索与计数双向不泄露：各自只看到本委托与共享资料", async (t) => {
  const { search, plane } = await fixture(t);
  for (const [reader, own, other] of [[ENG_A, KEY_A, KEY_B], [ENG_B, KEY_B, KEY_A]] as const) {
    const ownHit = await search(own, reader);
    assert.equal(ownHit.json.total, 1, `${reader} 应命中自己的材料`);
    const otherHit = await search(other, reader);
    assert.equal(otherHit.json.total, 0, `${reader} 不得命中另一委托的材料`);
    assert.equal(otherHit.json.materials, 0);
    const sharedHit = await search(KEY_SHARED, reader);
    assert.equal(sharedHit.json.total, 1, `${reader} 应命中共享材料`);
    const summary = await call("GET", `${plane.url}/knowledge/summary?engagementId=${reader}`);
    assert.equal(summary.json.materials, 2);
    assert.equal(summary.json.byScope.engagement, 1);
    assert.equal(summary.json.byScope.shared, 1);
    assert.equal(summary.json.scope.engagementId, reader);
    assert.equal(summary.json.scope.resolvedFrom, "declared");
  }
  // 未声明委托的读者只看到共享资料
  const anonymous = await search(KEY_SHARED);
  assert.equal(anonymous.json.total, 1);
  assert.equal(anonymous.json.scope.resolvedFrom, "shared-only");
  assert.equal((await search(KEY_A)).json.total, 0);
  assert.equal((await search(KEY_B)).json.total, 0);
  const anonSummary = await call("GET", `${plane.url}/knowledge/summary`);
  assert.equal(anonSummary.json.materials, 1);
  assert.equal(anonSummary.json.byScope.engagement, 0);
});

test("已知 ID 直接读取资料、版本、段落与停用都按范围拒绝，且不泄露存在性", async (t) => {
  const { plane, onlyA, onlyB, shared } = await fixture(t);
  const attempts: Array<[string, string, string]> = [
    [ENG_B, onlyA.materialId, onlyA.versionId],
    [ENG_A, onlyB.materialId, onlyB.versionId],
  ];
  for (const [reader, materialId, versionId] of attempts) {
    const detail = await call("GET", `${plane.url}/knowledge/materials/${materialId}?engagementId=${reader}`);
    assert.equal(detail.status, 404);
    assert.ok(!detail.text.includes("专属材料"), "错误信息不得带出另一委托的标题");
    const versions = await call("GET", `${plane.url}/knowledge/materials/${materialId}/versions?engagementId=${reader}`);
    assert.equal(versions.status, 404);
    const version = await call("GET", `${plane.url}/knowledge/materials/${materialId}/versions/${versionId}?engagementId=${reader}`);
    assert.equal(version.status, 404);
    const section = await call("GET",
      `${plane.url}/knowledge/materials/${materialId}/versions/${versionId}/section?locator=${encodeURIComponent("§委托A专属材料")}&engagementId=${reader}`);
    assert.equal(section.status, 404);
    const deprecate = await call("POST",
      `${plane.url}/knowledge/materials/${materialId}/versions/${versionId}/deprecate?engagementId=${reader}`, { reason: "越界停用" });
    assert.equal(deprecate.status, 404);
    const list = await call("GET", `${plane.url}/knowledge/materials?engagementId=${reader}`);
    assert.ok(!list.json.materials.some((m: any) => m.id === materialId));
  }
  // 共享资料两边都能按 ID 直接读
  for (const reader of [ENG_A, ENG_B]) {
    const detail = await call("GET", `${plane.url}/knowledge/materials/${shared.materialId}?engagementId=${reader}`);
    assert.equal(detail.status, 200);
    assert.equal(detail.json.material.scope.kind, "shared");
  }
  // 归属委托自己读得到
  const own = await call("GET", `${plane.url}/knowledge/materials/${onlyA.materialId}?engagementId=${ENG_A}`);
  assert.equal(own.status, 200);
});

test("跨委托创建引用被拒；本委托与共享资料可引用；解析同样按范围", async (t) => {
  const { baseA, baseB, onlyA, onlyB, shared } = await fixture(t);
  const crossAB = await call("POST", `${baseB}/citations`, {
    materialId: onlyA.materialId, versionId: onlyA.versionId, locator: onlyA.locator, claim: "B 试图引用 A 的材料",
  });
  assert.equal(crossAB.status, 404, crossAB.text);
  const crossBA = await call("POST", `${baseA}/citations`, {
    materialId: onlyB.materialId, versionId: onlyB.versionId, locator: onlyB.locator, claim: "A 试图引用 B 的材料",
  });
  assert.equal(crossBA.status, 404, crossBA.text);

  const ownA = await call("POST", `${baseA}/citations`, {
    materialId: onlyA.materialId, versionId: onlyA.versionId, locator: onlyA.locator, claim: "A 引用自己的材料",
  });
  assert.equal(ownA.status, 201, ownA.text);
  const sharedB = await call("POST", `${baseB}/citations`, {
    materialId: shared.materialId, versionId: shared.versionId, locator: shared.locator, claim: "B 引用共享材料",
  });
  assert.equal(sharedB.status, 201, sharedB.text);

  const resolvedA = await call("GET", `${baseA}/citations/${ownA.json.citation.id}/resolve`);
  assert.equal(resolvedA.json.verification.status, "verified");
  assert.ok(resolvedA.json.paragraph.text.includes(KEY_A));
  // 用另一委托的任务去解析同一条引用：引用属于任务，任务不存在于该委托即拒绝
  const wrongTask = await call("GET", `${baseB}/citations/${ownA.json.citation.id}/resolve`);
  assert.equal(wrongTask.status, 404);
  const listB = await call("GET", `${baseB}/citations`);
  assert.equal(listB.json.citations.length, 1);
  assert.ok(!JSON.stringify(listB.json).includes(KEY_A));
});

test("客户端 engagementId 只能定位：与服务端任务归属冲突时拒绝", async (t) => {
  const { plane, baseA, taskA, onlyA } = await fixture(t);
  const conflict = await call("GET", `${baseA}/citations?engagementId=${ENG_B}`);
  assert.equal(conflict.status, 409);
  assert.ok(conflict.json.error.includes("服务端任务归属"));

  const bodyConflict = await call("POST", `${baseA}/citations`, {
    materialId: onlyA.materialId, versionId: onlyA.versionId, locator: onlyA.locator,
    claim: "声明成另一委托", engagementId: ENG_B,
  });
  assert.equal(bodyConflict.status, 409);

  // 库级路由给了 taskId 时以服务端归属为准
  const anchored = await call("GET", `${plane.url}/knowledge/summary?taskId=${taskA.id}`);
  assert.equal(anchored.json.scope.resolvedFrom, "task");
  assert.equal(anchored.json.scope.engagementId, ENG_A);
  assert.equal(anchored.json.materials, 2);
  const anchorConflict = await call("GET", `${plane.url}/knowledge/summary?taskId=${taskA.id}&engagementId=${ENG_B}`);
  assert.equal(anchorConflict.status, 409);
  // 声明 A 但用 B 的任务定位，同样拒绝
  const headerConflict = await call("GET", `${plane.url}/knowledge/materials?taskId=${taskA.id}`, undefined, { "x-gy-engagement": ENG_B });
  assert.equal(headerConflict.status, 409);
});

test("报告导出双向不泄露：只打包本委托与共享资料的快照", async (t) => {
  const { baseA, baseB, onlyA, onlyB, shared } = await fixture(t);
  await call("POST", `${baseA}/citations`, {
    materialId: onlyA.materialId, versionId: onlyA.versionId, locator: onlyA.locator, claim: "A 的表述",
  });
  await call("POST", `${baseA}/citations`, {
    materialId: shared.materialId, versionId: shared.versionId, locator: shared.locator, claim: "A 引用共享",
  });
  await call("POST", `${baseB}/citations`, {
    materialId: onlyB.materialId, versionId: onlyB.versionId, locator: onlyB.locator, claim: "B 的表述",
  });
  await call("POST", `${baseB}/citations`, {
    materialId: shared.materialId, versionId: shared.versionId, locator: shared.locator, claim: "B 引用共享",
  });

  const exportA = await call("GET", `${baseA}/report-export`);
  assert.equal(exportA.status, 200, exportA.text);
  assert.equal(exportA.json.engagementId, ENG_A);
  assert.equal(exportA.json.citations.length, 2);
  assert.ok(!exportA.text.includes(KEY_B), "A 的导出不得出现 B 的关键词");
  assert.ok(!exportA.text.includes(onlyB.materialId));
  assert.ok(exportA.text.includes(KEY_A));
  assert.ok(exportA.text.includes(KEY_SHARED));
  assert.ok(exportA.json.citations.every((c: any) => c.verification.status === "verified"));
  assert.ok(exportA.json.citations.every((c: any) => c.snapshot.bytesBase64.length > 0));

  const exportB = await call("GET", `${baseB}/report-export`);
  assert.equal(exportB.json.engagementId, ENG_B);
  assert.equal(exportB.json.citations.length, 2);
  assert.ok(!exportB.text.includes(KEY_A), "B 的导出不得出现 A 的关键词");
  assert.ok(!exportB.text.includes(onlyA.materialId));
  assert.ok(exportB.text.includes(KEY_B));

  // 报告正文渲染引用元数据与定版快照链接（段落正文在导出的 snapshot 里），
  // 同样双向不泄露另一委托的资料标题与表述。
  const reportA = await call("GET", `${baseA}/report`);
  const reportB = await call("GET", `${baseB}/report`);
  assert.ok(reportA.text.includes("委托A专属材料") && !reportA.text.includes("委托B专属材料"));
  assert.ok(reportB.text.includes("委托B专属材料") && !reportB.text.includes("委托A专属材料"));
  assert.ok(reportA.text.includes("A 的表述") && !reportA.text.includes("B 的表述"));
  assert.ok(reportB.text.includes("B 的表述") && !reportB.text.includes("A 的表述"));
  assert.ok(reportA.text.includes("团队共享材料") && reportB.text.includes("团队共享材料"));
  assert.ok(reportA.text.includes("## 参考资料引用（定版）"));

  // 导出路由也拒绝与服务端归属冲突的声明
  const conflict = await call("GET", `${baseA}/report-export?engagementId=${ENG_B}`);
  assert.equal(conflict.status, 409);
});

test("同一来源在不同委托各自成库，互不覆盖", async (t) => {
  const { plane, onlyA } = await fixture(t);
  const sameSourceOtherScope = await call("POST", `${plane.url}/knowledge/materials`, {
    title: "委托A专属材料", publisher: "隔离验收", sourceKind: "original", format: "markdown",
    sourceUrl: "https://example.invalid/委托A专属材料",
    content: "## 委托A专属材料\n\n本段包含 阿尔法专属关键词，用于验证委托边界。",
    tags: [KEY_A], scope: { kind: "engagement", engagementId: ENG_B },
  });
  assert.equal(sameSourceOtherScope.status, 201, sameSourceOtherScope.text);
  assert.notEqual(sameSourceOtherScope.json.material.id, onlyA.materialId);
  assert.equal(sameSourceOtherScope.json.material.scope.engagementId, ENG_B);
  // B 现在能看到自己那份，仍看不到 A 那份
  const listB = await call("GET", `${plane.url}/knowledge/materials?engagementId=${ENG_B}`);
  assert.equal(listB.json.materials.length, 3);
  assert.ok(!listB.json.materials.some((m: any) => m.id === onlyA.materialId));
  const listA = await call("GET", `${plane.url}/knowledge/materials?engagementId=${ENG_A}`);
  assert.equal(listA.json.materials.length, 2);
});
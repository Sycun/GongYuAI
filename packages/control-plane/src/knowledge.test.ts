/**
 * 知识库首版后端回归（隔离数据目录 + 真实 HTTP 入口）：
 * 导入定版与幂等、修订新版本、中文检索与命中字段、定版引用与旧报告回读、
 * 快照缺失/损坏的无法复验状态、PDF 正文提取与待补正文。
 */
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { deflateSync } from "node:zlib";
import { CreateTaskRequestSchema } from "@gongyuai/contracts";
import { openHistory } from "@gongyuai/history";
import { bootControlPlane, taskPaths } from "./index.js";

const SAPPER_V1 = [
  "### 6.4 状态与连续性",
  "",
  "| 机制 | 实现 | 观测证据 |",
  "|---|---|---|",
  "| Commander 交接 | commander-state.md | 2 任 commander，06:14 换任，靠 STATE 续接 |",
  "",
  "换任通过读 STATE 文件继续。",
  "",
  "```text",
  "## Allocation",
  "| a-03 | w1 GENERAL |",
  "```",
  "",
  "### 6.5 自我修复",
  "",
  "agent 改了自己的工具。",
].join("\n");

const SAPPER_V2 = SAPPER_V1.replace("换任通过读 STATE 文件继续。", "换任通过读 STATE 文件继续。（验收修订：补充继任者读取顺序）");

async function fixture(t: TestContext, engagementId = "eng-knowledge") {
  const root = mkdtempSync(join(tmpdir(), "gy-knowledge-"));
  const plane = await bootControlPlane({
    dataRoot: root, host: "127.0.0.1", port: 0, runtime: "local", isolated: true, watchdogMs: 60_000,
    knowledgeEmbedding: { enabled: false },
  });
  let closed = false;
  const shutdown = async () => {
    if (closed) return;
    closed = true;
    await plane.close();
  };
  t.after(async () => { await shutdown(); rmSync(root, { recursive: true, force: true }); });
  const task = plane.store.createTask(CreateTaskRequestSchema.parse({
    name: "知识库验收", engagementId,
    auth: { targets: ["knowledge.invalid"], authorizationNote: "虚构材料，仅用于工程验收" },
    goals: [{ id: "g1", title: "资料引用", description: "定版引用可回读", evidencePatterns: ["knowledge/*.json"] }],
    mock: true,
  }));
  const paths = taskPaths(task.dataDir);
  const history = openHistory({ dbPath: paths.historyDb, evidenceDir: paths.evidenceDir });
  history.seedGoals(task.id, task.goals);
  history.close();
  return { root, plane, task, shutdown, base: `${plane.url}/tasks/${task.id}` };
}

async function call(method: string, url: string, body?: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(url, {
    method,
    headers: { ...(body === undefined ? {} : { "content-type": "application/json" }), ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch { /* markdown endpoints */ }
  return { status: res.status, text, json };
}

function importBody(overrides: Record<string, unknown> = {}) {
  return {
    title: "SapperLens §6.4 状态与连续性",
    publisher: "inwpu（独立运行分析）",
    sourceKind: "excerpt",
    format: "markdown",
    sourceUrl: "https://github.com/inwpu/SapperLens#64-状态与连续性",
    content: SAPPER_V1,
    tags: ["负责人换班", "状态与连续性"],
    upstreamCommit: "eebd7ce31c5d6620f1e760b80de774484568c94b",
    scope: { kind: "engagement", engagementId: "eng-knowledge" },
    ...overrides,
  };
}

/** 最小可解析 PDF：单页、Flate 内容流、Type1 字体。 */
function tinyPdf(lines: string[]): Buffer {
  const parts: Buffer[] = [];
  const push = (value: string | Buffer) => parts.push(Buffer.isBuffer(value) ? value : Buffer.from(value, "latin1"));
  push("%PDF-1.4\n");
  push("1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n");
  push("2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n");
  push("3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>\nendobj\n");
  const stream = deflateSync(Buffer.from(lines.map((line) => `BT /F1 12 Tf 72 720 Td (${line}) Tj ET`).join("\n"), "latin1"));
  push(`4 0 obj\n<< /Length ${stream.length} /Filter /FlateDecode >>\nstream\n`);
  push(stream);
  push("\nendstream\nendobj\n");
  push("5 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n");
  push("trailer\n<< /Size 6 /Root 1 0 R >>\n%%EOF\n");
  return Buffer.concat(parts);
}

test("预览返回可确认的元数据与章节定位；围栏代码块里的 ## 不被当成标题", async (t) => {
  const { plane } = await fixture(t);
  const preview = await call("POST", `${plane.url}/knowledge/preview`, importBody());
  assert.equal(preview.status, 200, preview.text);
  assert.equal(preview.json.bodyStatus, "ready");
  assert.equal(preview.json.sourceKind, "excerpt");
  assert.match(preview.json.contentSha256, /^[a-f0-9]{64}$/);
  const locators = preview.json.sections.map((s: any) => s.locator);
  assert.deepEqual(locators, ["§6.4", "§6.5"]);
  const section = preview.json.sections[0];
  assert.equal(section.heading, "6.4 状态与连续性");
  assert.ok(section.text.includes("## Allocation"), "代码块原文应保留在段落里");
  assert.ok(section.charEnd > section.charStart);
  // 预览不写盘
  const list = await call("GET", `${plane.url}/knowledge/materials?engagementId=eng-knowledge`);
  assert.equal(list.json.materials.length, 0);
});

test("仅登记链接或正文提取为空时标记待补正文，且不产生全文命中", async (t) => {
  const { plane } = await fixture(t);
  const linkOnly = await call("POST", `${plane.url}/knowledge/materials`, importBody({
    title: "仅有链接的条目", content: undefined, sourceUrl: "https://example.invalid/only-link", tags: [],
  }));
  assert.equal(linkOnly.status, 201, linkOnly.text);
  assert.equal(linkOnly.json.version.bodyStatus, "pending_body");
  assert.equal(linkOnly.json.sections.length, 0);
  const search = await call("GET", `${plane.url}/knowledge/search?q=${encodeURIComponent("状态与连续性")}&engagementId=eng-knowledge`);
  assert.equal(search.json.hits.filter((h: any) => h.materialId === linkOnly.json.material.id).length, 0);

  // 待补正文的条目即使标签命中，也只能是标签命中，并带上待补标记
  const tagged = await call("POST", `${plane.url}/knowledge/materials`, importBody({
    title: "待补正文但带主题标签", content: undefined, sourceUrl: "https://example.invalid/tagged",
    tags: ["负责人换班"],
  }));
  const tagSearch = await call("GET", `${plane.url}/knowledge/search?q=${encodeURIComponent("负责人换班")}&engagementId=eng-knowledge`);
  const hit = tagSearch.json.hits.find((h: any) => h.materialId === tagged.json.material.id);
  assert.ok(hit, "标签命中应可见");
  assert.equal(hit.tagOnly, true);
  assert.equal(hit.bodyStatus, "pending_body");
  assert.equal(hit.matchedFields.includes("body"), false);

  const summary = await call("GET", `${plane.url}/knowledge/summary?engagementId=eng-knowledge`);
  assert.equal(summary.json.pendingBody, 2);
});

test("重放相同导入不新增版本；正文修订新增版本并保留旧快照", async (t) => {
  const { root, plane } = await fixture(t);
  const first = await call("POST", `${plane.url}/knowledge/materials`, importBody());
  assert.equal(first.status, 201, first.text);
  const materialId = first.json.material.id;
  const v1 = first.json.version;
  assert.equal(v1.versionNo, 1);
  assert.equal(first.json.reused, false);

  const replay = await call("POST", `${plane.url}/knowledge/materials`, importBody());
  assert.equal(replay.status, 200, replay.text);
  assert.equal(replay.json.reused, true);
  assert.equal(replay.json.version.id, v1.id);
  assert.equal(replay.json.material.versionCount, 1);

  // 并发重放：唯一索引 + BEGIN IMMEDIATE 收敛，不产生重复版本
  const concurrent = await Promise.all(Array.from({ length: 6 }, () =>
    call("POST", `${plane.url}/knowledge/materials`, importBody())));
  assert.ok(concurrent.every((r) => r.status === 200 || r.status === 201));
  assert.ok(concurrent.every((r) => r.json.version.id === v1.id));

  const revision = await call("POST", `${plane.url}/knowledge/materials`, importBody({
    content: SAPPER_V2, upstreamVersion: "验收修订 v2",
  }));
  assert.equal(revision.status, 201, revision.text);
  const v2 = revision.json.version;
  assert.equal(v2.versionNo, 2);
  assert.notEqual(v2.contentSha256, v1.contentSha256);
  assert.equal(revision.json.material.versionCount, 2);
  assert.equal(revision.json.material.currentVersionId, v2.id);
  assert.equal(revision.json.material.effectiveVersionId, v2.id);

  // 旧快照仍在盘上，且内容哈希可复算
  const oldSnapshot = join(root, v1.snapshotPath);
  assert.ok(existsSync(oldSnapshot));
  const { createHash } = await import("node:crypto");
  assert.equal(createHash("sha256").update(readFileSync(oldSnapshot)).digest("hex"), v1.contentSha256);
  assert.equal(readFileSync(oldSnapshot, "utf8"), SAPPER_V1);
});

test("并发导入不同正文各自成版，版本号不冲突", async (t) => {
  const { plane } = await fixture(t);
  const results = await Promise.all([0, 1, 2, 3].map((i) =>
    call("POST", `${plane.url}/knowledge/materials`, importBody({ content: `${SAPPER_V1}\n\n并发修订 ${i}` }))));
  assert.ok(results.every((r) => r.status === 201), JSON.stringify(results.map((r) => r.status)));
  const nos = results.map((r) => r.json.version.versionNo).sort((a: number, b: number) => a - b);
  assert.deepEqual(nos, [1, 2, 3, 4]);
  assert.equal(new Set(results.map((r) => r.json.version.id)).size, 4);
});

test("中文检索：正文命中与纯标签命中分别标识，计数只统计可见范围", async (t) => {
  const { plane } = await fixture(t);
  await call("POST", `${plane.url}/knowledge/materials`, importBody());
  await call("POST", `${plane.url}/knowledge/materials`, importBody({
    title: "本项目六批交接实验", publisher: "GongYuAI",
    sourceKind: "original", sourceUrl: "https://example.invalid/ledger-relay#六批五次交接",
    content: "## 六批、五次交接\n\nRelay 每个边界换班，累计读回已保存的各代交接。\n\nRelay 组答对 54/60 个字段。",
    tags: ["负责人换班"],
  }));

  const bodyHit = await call("GET", `${plane.url}/knowledge/search?q=${encodeURIComponent("换任")}&engagementId=eng-knowledge`);
  assert.equal(bodyHit.status, 200, bodyHit.text);
  assert.equal(bodyHit.json.total, 1);
  assert.equal(bodyHit.json.hits[0].matchedFields.includes("body"), true);
  assert.equal(bodyHit.json.hits[0].tagOnly, false);
  assert.equal(bodyHit.json.hits[0].locator, "§6.4");
  assert.ok(bodyHit.json.hits[0].context.includes("换任"));

  // 三份真实材料正文都不含「负责人换班」整词，因此只能如实标为标签命中
  const tagHit = await call("GET", `${plane.url}/knowledge/search?q=${encodeURIComponent("负责人换班")}&engagementId=eng-knowledge`);
  assert.equal(tagHit.json.total, 2);
  assert.equal(tagHit.json.materials, 2);
  assert.ok(tagHit.json.hits.every((h: any) => h.tagOnly === true));
  assert.ok(tagHit.json.hits.every((h: any) => h.matchedFields.join() === "tags"));
  assert.ok(tagHit.json.hits.every((h: any) => h.context.includes("仅标签命中")));

  const multi = await call("GET", `${plane.url}/knowledge/search?q=${encodeURIComponent("换班 54/60")}&engagementId=eng-knowledge`);
  assert.equal(multi.json.total, 1);
  assert.equal(multi.json.hits[0].title, "本项目六批交接实验");

  const none = await call("GET", `${plane.url}/knowledge/search?q=${encodeURIComponent("不存在的词")}&engagementId=eng-knowledge`);
  assert.equal(none.json.total, 0);
  assert.equal(none.json.scope.userLevelPermissionVerified, false);
});

test("定版引用：报告渲染、重启后回读、复算原 SHA-256；停用旧版后检索给新版", async (t) => {
  const { root, plane, task, base, shutdown } = await fixture(t);
  const imported = await call("POST", `${plane.url}/knowledge/materials`, importBody());
  const materialId = imported.json.material.id;
  const v1 = imported.json.version;

  plane.store.finishTask(task, "completed", null);
  const cited = await call("POST", `${base}/citations`, {
    materialId, versionId: v1.id, locator: "§6.4",
    claim: "独立分析观察到一次负责人换班",
  });
  assert.equal(cited.status, 201, cited.text);
  const citation = cited.json.citation;
  assert.equal(citation.snapshotSha256, v1.contentSha256);
  assert.equal(citation.versionLabel, "本地 v1");
  assert.equal(citation.sourceKind, "excerpt");

  // 重复提交同一引用不追加
  const again = await call("POST", `${base}/citations`, {
    materialId, versionId: v1.id, locator: "§6.4", claim: "独立分析观察到一次负责人换班",
  });
  assert.equal(again.json.citation.id, citation.id);
  const listed = await call("GET", `${base}/citations`);
  assert.equal(listed.json.citations.length, 1);

  const report = await call("GET", `${base}/report`);
  assert.ok(report.text.includes("## 参考资料引用（定版）"));
  assert.ok(report.text.includes("独立分析观察到一次负责人换班"));
  assert.ok(report.text.includes(v1.contentSha256));
  assert.ok(existsSync(join(task.dataDir, "report-evidence", v1.contentSha256)));

  const revision = await call("POST", `${plane.url}/knowledge/materials`, importBody({ content: SAPPER_V2 }));
  const v2 = revision.json.version;
  const deprecated = await call("POST",
    `${plane.url}/knowledge/materials/${materialId}/versions/${v1.id}/deprecate?engagementId=eng-knowledge`,
    { reason: "验收修订后停用 v1" });
  assert.equal(deprecated.status, 200, deprecated.text);
  assert.equal(deprecated.json.version.status, "deprecated");

  const search = await call("GET", `${plane.url}/knowledge/search?q=${encodeURIComponent("换任")}&engagementId=eng-knowledge`);
  assert.equal(search.json.hits[0].versionId, v2.id, "默认检索应给有效版 v2");
  assert.equal(search.json.hits[0].versionNo, 2);

  // 关闭服务、断开上游后重启：旧报告仍按 v1 定版回读
  const url = plane.url;
  await shutdown();
  const restarted = await bootControlPlane({
    dataRoot: root, host: "127.0.0.1", port: 0, runtime: "local", isolated: true, watchdogMs: 60_000,
    knowledgeEmbedding: { enabled: false },
  });
  t.after(async () => { await restarted.close(); });
  const resolve = await call("GET", `${restarted.url}/tasks/${task.id}/citations/${citation.id}/resolve`);
  assert.equal(resolve.status, 200, resolve.text);
  assert.equal(resolve.json.verification.status, "verified");
  assert.equal(resolve.json.verification.recomputedSha256, v1.contentSha256);
  assert.equal(resolve.json.verification.source, "task-seal");
  assert.equal(resolve.json.paragraph.locator, "§6.4");
  assert.ok(resolve.json.paragraph.text.includes("换任通过读 STATE 文件继续。"));
  assert.ok(!resolve.json.paragraph.text.includes("验收修订"), "旧引用不得读到新版正文");
  assert.equal(resolve.json.versionStatus, "deprecated");

  const oldReport = await call("GET", `${restarted.url}/tasks/${task.id}/report`);
  assert.ok(oldReport.text.includes(v1.contentSha256));
  assert.ok(oldReport.text.includes("该版本已停用"));

  const exported = await call("GET", `${restarted.url}/tasks/${task.id}/report-export`);
  assert.equal(exported.status, 200, exported.text);
  assert.equal(exported.json.kind, "knowledge-report-export");
  assert.equal(exported.json.citations.length, 1);
  assert.equal(exported.json.citations[0].verification.status, "verified");
  const packed = exported.json.citations[0].snapshot;
  assert.equal(packed.sha256, v1.contentSha256);
  assert.equal(Buffer.from(packed.bytesBase64, "base64").toString("utf8"), SAPPER_V1);
  assert.equal(exported.json.report.sha256.length, 64);
  assert.equal(url === restarted.url, false);
});

test("快照缺失或损坏时给出明确的无法复验状态，报告仍能出得来", async (t) => {
  const { root, plane, task, base } = await fixture(t);
  const imported = await call("POST", `${plane.url}/knowledge/materials`, importBody());
  const v1 = imported.json.version;
  plane.store.finishTask(task, "completed", null);
  const cited = await call("POST", `${base}/citations`, {
    materialId: imported.json.material.id, versionId: v1.id, locator: "§6.4", claim: "换班观察",
  });
  const citationId = cited.json.citation.id;

  // 损坏知识库侧快照：任务侧密封件独立，仍可复验
  rmSync(join(root, v1.snapshotPath));
  const afterLibraryLoss = await call("GET", `${base}/citations/${citationId}/resolve`);
  assert.equal(afterLibraryLoss.json.verification.status, "verified");
  assert.equal(afterLibraryLoss.json.librarySnapshotAvailable, false);

  // 损坏任务侧密封件：必须明确无法复验
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(taskPaths(task.dataDir).historyDb);
  db.prepare("UPDATE evidence_versions SET content = ? WHERE sha256 = ?").run(Buffer.from("tampered"), v1.contentSha256);
  db.close();
  const broken = await call("GET", `${base}/citations/${citationId}/resolve`);
  assert.equal(broken.json.verification.status, "unverifiable");
  assert.equal(broken.json.verification.reason, "sha256_mismatch");
  assert.equal(broken.json.verification.expectedSha256, v1.contentSha256);
  assert.notEqual(broken.json.verification.recomputedSha256, v1.contentSha256);
  assert.equal(broken.json.paragraph, undefined);

  const brokenExport = await call("GET", `${base}/report-export`);
  assert.equal(brokenExport.json.citations[0].verification.reason, "sha256_mismatch");

  // 删除密封件 → snapshot_missing（测试内关掉外键，模拟存储丢失）
  const db2 = new DatabaseSync(taskPaths(task.dataDir).historyDb);
  db2.exec("PRAGMA foreign_keys = OFF");
  db2.prepare("DELETE FROM evidence_versions WHERE sha256 = ?").run(v1.contentSha256);
  db2.close();
  const missing = await call("GET", `${base}/citations/${citationId}/resolve`);
  assert.equal(missing.json.verification.reason, "snapshot_missing");

  // 触发终态报告重渲染：不得因快照损坏而失败，且要标注无法复验
  const coverage = await call("POST", `${base}/coverage`, {
    goalId: "g1", status: "untested", reviewer: "验收", reason: "快照损坏后仍须出报告",
  });
  assert.equal(coverage.status, 201, coverage.text);
  const text = readFileSync(join(task.dataDir, "report.md"), "utf8");
  assert.ok(text.includes("## 参考资料引用（定版）"));
  assert.ok(text.includes("无法复验"), "报告必须明确标注无法复验，而不是静默跳过");
  assert.ok(text.includes(v1.contentSha256));
});

test("PDF 可提取正文时按页定位；不可提取时标记待补正文", async (t) => {
  const { plane } = await fixture(t);
  const pdf = tinyPdf(["Structured State for Long-Horizon Agents", "Second line of the page"]);
  const good = await call("POST", `${plane.url}/knowledge/materials`, importBody({
    title: "可提取正文的 PDF", format: "pdf", sourceKind: "original",
    sourceUrl: "https://example.invalid/paper.pdf", content: undefined,
    contentBase64: pdf.toString("base64"), tags: [],
  }));
  assert.equal(good.status, 201, good.text);
  assert.equal(good.json.version.bodyStatus, "ready");
  assert.equal(good.json.version.format, "pdf");
  assert.equal(good.json.sections[0].locator, "p.1");
  assert.equal(good.json.sections[0].page, 1);
  assert.ok(good.json.sections[0].text.includes("Structured State"));

  const bad = await call("POST", `${plane.url}/knowledge/materials`, importBody({
    title: "不可提取正文的 PDF", format: "pdf", sourceUrl: "https://example.invalid/scanned.pdf",
    content: undefined, contentBase64: Buffer.from("%PDF-1.4\nnot a real page tree").toString("base64"), tags: [],
  }));
  assert.equal(bad.status, 201, bad.text);
  assert.equal(bad.json.version.bodyStatus, "pending_body");
  assert.ok(bad.json.version.bodyStatusReason.length > 0);
});

test("原文、摘录、编辑导读三类来源可区分，摘要按类计数", async (t) => {
  const { plane } = await fixture(t);
  for (const [index, kind] of ["original", "excerpt", "editorial"].entries()) {
    const res = await call("POST", `${plane.url}/knowledge/materials`, importBody({
      title: `来源类型 ${kind}`, sourceKind: kind, sourceUrl: `https://example.invalid/${kind}`,
      content: `## 段落\n\n这是 ${kind} 的正文。`, tags: [],
    }));
    assert.equal(res.status, 201, res.text);
    assert.equal(res.json.material.sourceKind, kind);
    assert.equal(index >= 0, true);
  }
  const summary = await call("GET", `${plane.url}/knowledge/summary?engagementId=eng-knowledge`);
  assert.deepEqual(summary.json.bySourceKind, { original: 1, excerpt: 1, editorial: 1 });
  assert.equal(summary.json.materials, 3);
});

test("按固定版本读取历史段落；未知定位与未知版本返回 404", async (t) => {
  const { plane } = await fixture(t);
  const first = await call("POST", `${plane.url}/knowledge/materials`, importBody());
  const materialId = first.json.material.id;
  const v1 = first.json.version;
  await call("POST", `${plane.url}/knowledge/materials`, importBody({ content: SAPPER_V2 }));

  const historical = await call("GET",
    `${plane.url}/knowledge/materials/${materialId}/versions/${v1.id}/section?locator=${encodeURIComponent("§6.4")}&engagementId=eng-knowledge`);
  assert.equal(historical.status, 200, historical.text);
  assert.equal(historical.json.version.versionNo, 1);
  assert.ok(historical.json.section.text.includes("换任通过读 STATE 文件继续。"));
  assert.ok(!historical.json.section.text.includes("验收修订"));

  const badLocator = await call("GET",
    `${plane.url}/knowledge/materials/${materialId}/versions/${v1.id}/section?locator=${encodeURIComponent("§9.9")}&engagementId=eng-knowledge`);
  assert.equal(badLocator.status, 404);
  const badVersion = await call("GET",
    `${plane.url}/knowledge/materials/${materialId}/versions/does-not-exist?engagementId=eng-knowledge`);
  assert.equal(badVersion.status, 404);
});

test("任务尚无 History 时，引用读取与导出返回空而不是创建库", async (t) => {
  const { plane } = await fixture(t);
  const bare = plane.store.createTask(CreateTaskRequestSchema.parse({
    name: "无历史任务", engagementId: "eng-knowledge",
    auth: { targets: ["bare.invalid"], authorizationNote: "虚构材料，仅用于工程验收" },
    goals: [{ id: "g1", title: "空", description: "无历史", evidencePatterns: ["knowledge/*.json"] }],
    mock: true,
  }));
  const historyPath = taskPaths(bare.dataDir).historyDb;
  assert.equal(existsSync(historyPath), false);
  const base = `${plane.url}/tasks/${bare.id}`;
  const listed = await call("GET", `${base}/citations`);
  assert.equal(listed.status, 200, listed.text);
  assert.deepEqual(listed.json.citations, []);
  const exported = await call("GET", `${base}/report-export`);
  assert.equal(exported.status, 200, exported.text);
  assert.deepEqual(exported.json.citations, []);
  assert.equal(exported.json.withheld.outOfScopeCitations, 0);
  const resolved = await call("GET", `${base}/citations/anything/resolve`);
  assert.equal(resolved.status, 404);
  assert.equal(existsSync(historyPath), false, "读取路径不得创建 history.sqlite");
});

test("导入失败不留半写入状态：非法输入被拒，资料与版本数不变", async (t) => {
  const { root, plane } = await fixture(t);
  const before = await call("GET", `${plane.url}/knowledge/summary?engagementId=eng-knowledge`);
  const bad = await call("POST", `${plane.url}/knowledge/materials`, { title: "缺字段" });
  assert.equal(bad.status, 400);
  const noBody = await call("POST", `${plane.url}/knowledge/materials`, importBody({
    content: undefined, sourceUrl: undefined,
  }));
  assert.equal(noBody.status, 400);
  const after = await call("GET", `${plane.url}/knowledge/summary?engagementId=eng-knowledge`);
  assert.equal(after.json.materials, before.json.materials);
  assert.equal(after.json.versions, before.json.versions);
  const snapshots = join(root, "knowledge", "snapshots");
  const stray = existsSync(snapshots) ? readdirSync(snapshots).filter((name) => name.endsWith(".tmp")) : [];
  assert.deepEqual(stray, [], "失败不得留下半写入的临时快照");
});
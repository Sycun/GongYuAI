/**
 * 整篇 Markdown 入库 + 关键词/向量混合检索的回归（隔离数据目录 + 真实 HTTP 入口）。
 *
 * 向量化走**真实 HTTP**：测试内起一个本机 OpenAI 兼容 /v1/embeddings 服务，
 * 用确定性的概念向量代替真实模型，从而让融合、降级、隔离、重建的逻辑可重复验收。
 * 真实中英模型的召回质量由 `pnpm knowledge:acceptance` 用本机 bge-m3 验收。
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { deflateSync } from "node:zlib";
import { CreateTaskRequestSchema } from "@gongyuai/contracts";
import { openHistory } from "@gongyuai/history";
import { bootControlPlane, taskPaths } from "./index.js";

const sha256 = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");

/** 概念维度：交接 / 续接 / 更正 / 分配。中英同义词落到同一维，模拟跨语言召回。 */
const CONCEPTS: Array<{ dim: number; words: string[] }> = [
  { dim: 0, words: ["换班", "换任", "交接", "handover", "commander", "负责人"] },
  { dim: 1, words: ["续上", "继续", "续接", "state", "resume", "progress", "进度"] },
  { dim: 2, words: ["更正", "回函", "correction", "凭据"] },
  { dim: 3, words: ["allocation", "分配", "w1", "general"] },
];

function conceptVector(text: string): number[] {
  const lower = text.toLowerCase();
  const vector: number[] = new Array(8).fill(0);
  for (const concept of CONCEPTS) {
    const hits = concept.words.filter((word) => lower.includes(word)).length;
    if (hits) vector[concept.dim] = hits;
  }
  // 没有任何概念命中时给一个与其他向量近乎正交的方向，避免全零向量。
  let sum = 0;
  for (const value of vector) sum += value * value;
  if (sum === 0) {
    vector[7] = 1;
    sum = 1;
  }
  const norm = Math.sqrt(sum);
  return vector.map((value) => value / norm);
}

type StubOptions = { fail?: boolean; status?: number };

async function startEmbeddingStub(t: TestContext): Promise<{ url: string; options: StubOptions; calls: () => number }> {
  const options: StubOptions = {};
  let calls = 0;
  const server: Server = createServer((req, res) => {
    if (req.method !== "POST" || !req.url?.endsWith("/embeddings")) {
      res.writeHead(404).end("{}");
      return;
    }
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      calls += 1;
      if (options.fail) {
        res.writeHead(options.status ?? 503, { "content-type": "application/json" })
          .end(JSON.stringify({ error: { message: "stub embedding service unavailable" } }));
        return;
      }
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { input?: string[] };
      const input = body.input ?? [];
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({
        data: input.map((text, index) => ({ index, embedding: conceptVector(text) })),
        usage: { prompt_tokens: input.length, total_tokens: input.length },
      }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  return { url: `http://127.0.0.1:${port}/v1`, options, calls: () => calls };
}

/** 整篇文章：前言 + 多级标题 + 表格 + 围栏代码块 + 一个需要继续切分的长章节。 */
const ARTICLE = [
  "# 运行分析",
  "",
  "本文记录一次独立运行分析。",
  "",
  "## 0. 摘要",
  "",
  "SapperLens 观察了一个长程 agent 的运行记录。",
  "",
  "## 6. 架构设计",
  "",
  "架构分为三层。",
  "",
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
  "",
  "## 7. 长章节",
  "",
  ...Array.from({ length: 48 }, (_, i) => `第 ${i + 1} 段：这里描述运行过程中的一个观察，用于把章节撑到需要再次切分的长度。\n`),
].join("\n");

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

async function fixture(t: TestContext, opts: { embeddingBaseUrl?: string; model?: string; enabled?: boolean } = {}) {
  const root = mkdtempSync(join(tmpdir(), "gy-knowledge-hybrid-"));
  const plane = await bootControlPlane({
    dataRoot: root, host: "127.0.0.1", port: 0, runtime: "local", isolated: true, watchdogMs: 60_000,
    knowledgeEmbedding: {
      enabled: opts.enabled ?? true,
      provider: "local",
      local: {
        baseUrl: opts.embeddingBaseUrl ?? "",
        model: opts.model ?? "stub-multilingual",
        apiKeyEnv: "",
        batchSize: 8,
        timeoutMs: 5_000,
      },
    },
  });
  let closed = false;
  const shutdown = async () => {
    if (closed) return;
    closed = true;
    await plane.close();
  };
  t.after(async () => { await shutdown(); rmSync(root, { recursive: true, force: true }); });
  const task = plane.store.createTask(CreateTaskRequestSchema.parse({
    name: "混合检索验收", engagementId: "eng-hybrid",
    auth: { targets: ["hybrid.invalid"], authorizationNote: "虚构材料，仅用于工程验收" },
    goals: [{ id: "g1", title: "混合检索", description: "语义与关键词并存", evidencePatterns: ["knowledge/*.json"] }],
    mock: true,
  }));
  const paths = taskPaths(task.dataDir);
  const history = openHistory({ dbPath: paths.historyDb, evidenceDir: paths.evidenceDir });
  history.seedGoals(task.id, task.goals);
  history.close();
  plane.store.finishTask(task, "completed", null);
  return { root, plane, task, shutdown, base: `${plane.url}/tasks/${task.id}` };
}

function articleImport(overrides: Record<string, unknown> = {}) {
  return {
    title: "运行分析整篇", publisher: "验收合成材料", sourceKind: "original", format: "markdown",
    sourceUrl: "https://example.invalid/article", content: ARTICLE,
    // 故意不挂与查询同词的标签：语义召回必须靠正文，而不是人工标签。
    tags: [], scope: { kind: "engagement", engagementId: "eng-hybrid" },
    ...overrides,
  };
}

async function importArticle(plane: { url: string }, overrides: Record<string, unknown> = {}) {
  const res = await call("POST", `${plane.url}/knowledge/materials`, articleImport(overrides));
  assert.equal(res.status, 201, res.text);
  return res.json;
}

test("整篇 Markdown 按标题层级切片：标题路径、原文范围精确、表格与代码块整块保留", async (t) => {
  const stub = await startEmbeddingStub(t);
  const { plane } = await fixture(t, { embeddingBaseUrl: stub.url });
  const imported = await importArticle(plane);
  const sections = imported.sections as any[];

  // 每个片段的 text 必须是版本正文的精确切片
  for (const section of sections) {
    assert.equal(ARTICLE.slice(section.charStart, section.charEnd), section.text, `${section.locator} 原文范围必须精确`);
    assert.equal(section.chunkSha256, sha256(section.text));
    assert.ok(section.lineEnd >= section.lineStart);
  }
  const s64 = sections.find((s) => s.locator === "§6.4");
  assert.ok(s64, "§6.4 应存在");
  assert.deepEqual(s64.headingPath, ["运行分析", "6. 架构设计", "6.4 状态与连续性"]);
  assert.ok(s64.text.includes("| Commander 交接 |"), "表格应整块留在片段里");
  assert.ok(s64.text.includes("```text") && s64.text.includes("## Allocation"), "围栏代码块应整块保留且不被当成标题");
  assert.equal(s64.parentLocator, "§6.4");

  // 长章节继续切分，且子片段共享父章节定位与标题路径
  const long = sections.filter((s) => s.parentLocator === "§7");
  assert.ok(long.length > 1, "长章节应被切成多片");
  assert.deepEqual(long.map((s) => s.locator), ["§7", ...long.slice(1).map((_, i) => `§7~${i + 2}`)]);
  assert.ok(long.every((s) => s.chunkCount === long.length));
  assert.ok(long.every((s) => s.headingPath.join(">") === "运行分析>7. 长章节"));
  // 围栏代码块里的 ## Allocation 没有产生独立章节
  assert.equal(sections.some((s) => s.locator === "§Allocation"), false);

  // 命中后可回读原文与上下文
  const context = await call("GET",
    `${plane.url}/knowledge/materials/${imported.material.id}/versions/${imported.version.id}/section?locator=${encodeURIComponent("§6.4")}&engagementId=eng-hybrid`);
  assert.equal(context.status, 200, context.text);
  assert.equal(context.json.section.text, s64.text);
  assert.equal(context.json.context.parentLocator, "§6.4");
  assert.deepEqual(context.json.context.headingPath, s64.headingPath);
  assert.ok(context.json.context.parentText.includes("换任通过读 STATE 文件继续。"));
});

test("混合检索：语义命中补上同义表达，且绝不标成正文字面命中", async (t) => {
  const stub = await startEmbeddingStub(t);
  const { plane } = await fixture(t, { embeddingBaseUrl: stub.url });
  const imported = await importArticle(plane);
  await plane.knowledge.index.idle();

  const status = await call("GET", `${plane.url}/knowledge/index?engagementId=eng-hybrid`);
  assert.equal(status.status, 200, status.text);
  assert.equal(status.json.index.state, "ready");
  assert.equal(status.json.index.degraded, false);
  assert.equal(status.json.index.indexedChunks, imported.sections.length);
  assert.equal(status.json.index.model, "stub-multilingual");

  // 「负责人换班」整词不在正文里：关键词 0 条，混合必须靠语义召回 §6.4
  const keyword = await call("GET", `${plane.url}/knowledge/search?q=${encodeURIComponent("负责人换班")}&mode=keyword&engagementId=eng-hybrid`);
  assert.equal(keyword.json.total, 0, "关键词不应命中不存在的整词");
  assert.equal(keyword.json.index.degraded, true);
  assert.equal(keyword.json.mode, "keyword");

  const hybrid = await call("GET", `${plane.url}/knowledge/search?q=${encodeURIComponent("负责人换班")}&engagementId=eng-hybrid`);
  assert.equal(hybrid.status, 200, hybrid.text);
  assert.ok(hybrid.json.total > 0, "混合检索应召回语义相关片段");
  const top = hybrid.json.hits[0];
  assert.equal(top.locator, "§6.4", `语义首条应是 §6.4，实际 ${top.locator}`);
  assert.ok(top.matchedFields.includes("semantic"));
  assert.equal(top.matchedFields.includes("body"), false, "语义命中不得标成正文字面命中");
  assert.equal(top.tagOnly, false);
  assert.equal(top.retrieval, "semantic");
  assert.ok(top.semanticScore > 0);
  assert.equal(hybrid.json.recall.keyword, 0);
  assert.ok(hybrid.json.recall.semantic > 0);
  // 命中带完整原文定位，可直接拿去建引用
  assert.equal(top.chunkSha256, sha256(top.charStart === undefined ? "" : ARTICLE.slice(top.charStart, top.charEnd)));

  // 语义查询「接任指挥后怎样续上进度」同样落到 §6.4
  const resume = await call("GET", `${plane.url}/knowledge/search?q=${encodeURIComponent("接任指挥后怎样续上进度")}&engagementId=eng-hybrid`);
  assert.equal(resume.json.hits[0].locator, "§6.4");
});

test("精确值检索保持关键词精度：R-017 / 54/60 / §6.4 字面命中排第一", async (t) => {
  const stub = await startEmbeddingStub(t);
  const { plane } = await fixture(t, { embeddingBaseUrl: stub.url });
  await importArticle(plane);
  await call("POST", `${plane.url}/knowledge/materials`, articleImport({
    title: "六批交接实验", sourceUrl: "https://example.invalid/ledger",
    content: "## 六批、五次交接\n\nRelay 每个边界换班。Relay 组答对 54/60 个字段。",
  }));
  await call("POST", `${plane.url}/knowledge/materials`, articleImport({
    title: "R-017 补证用例", sourceUrl: "https://example.invalid/r017",
    content: "## 报告交付后收到更正凭据\n\nR-017 要求把更正回函并入既有证据链。",
  }));
  await plane.knowledge.index.idle();

  for (const [query, expected, field] of [
    ["R-017", "R-017 补证用例", "body"],
    ["54/60", "六批交接实验", "body"],
    ["§6.4", "运行分析整篇", "locator"],
    ["6.4", "运行分析整篇", "locator"],
  ] as const) {
    const res = await call("GET", `${plane.url}/knowledge/search?q=${encodeURIComponent(query)}&engagementId=eng-hybrid`);
    assert.equal(res.status, 200, res.text);
    const top = res.json.hits[0];
    assert.ok(top, `${query} 应有命中`);
    assert.ok(top.matchedFields.includes(field), `${query} 首条应含 ${field} 命中，实际 ${top.matchedFields}`);
    assert.equal(top.title, expected, `${query} 首条应来自 ${expected}，实际 ${top.title}`);
    assert.ok(top.keywordScore >= 1);
    assert.equal(top.tagOnly, false);
  }
  // 章节地址命中不是正文字面命中：原文里没有「§6.4」这个字面
  const address = await call("GET", `${plane.url}/knowledge/search?q=${encodeURIComponent("§6.4")}&engagementId=eng-hybrid`);
  assert.equal(address.json.hits[0].matchedFields.includes("body"), false);
  assert.equal(address.json.hits[0].locator, "§6.4");
});

test("向量服务不可用时降级为关键词，并给出状态、重试与重建", async (t) => {
  const stub = await startEmbeddingStub(t);
  const { plane } = await fixture(t, { embeddingBaseUrl: stub.url });
  stub.options.fail = true;
  const imported = await importArticle(plane);
  await plane.knowledge.index.idle();

  const degraded = await call("GET", `${plane.url}/knowledge/search?q=${encodeURIComponent("换任")}&engagementId=eng-hybrid`);
  assert.equal(degraded.status, 200, degraded.text);
  assert.equal(degraded.json.index.degraded, true);
  assert.ok(degraded.json.index.degradedReason.length > 0);
  assert.equal(degraded.json.hits[0].locator, "§6.4", "降级后关键词仍能命中");
  assert.equal(degraded.json.recall.semantic, 0);
  // 精确检索不受影响
  const exact = await call("GET", `${plane.url}/knowledge/search?q=${encodeURIComponent("STATE")}&engagementId=eng-hybrid`);
  assert.ok(exact.json.hits.some((h: any) => h.matchedFields.includes("body")));

  const failedStatus = await call("GET", `${plane.url}/knowledge/index?engagementId=eng-hybrid`);
  assert.ok(failedStatus.json.index.failedChunks > 0);
  assert.ok(["unavailable", "error"].includes(failedStatus.json.index.state), failedStatus.json.index.state);

  // 服务恢复后重试
  stub.options.fail = false;
  const retry = await call("POST", `${plane.url}/knowledge/index/retry?engagementId=eng-hybrid`, {});
  assert.equal(retry.status, 202, retry.text);
  assert.ok(retry.json.queued.includes(imported.version.id));
  await plane.knowledge.index.idle();
  const recovered = await call("GET", `${plane.url}/knowledge/index?engagementId=eng-hybrid`);
  assert.equal(recovered.json.index.state, "ready");
  assert.equal(recovered.json.index.indexedChunks, imported.sections.length);

  // 重建：向量清零后重新灌满，资料版本与内容 SHA-256 不变
  const before = await call("GET", `${plane.url}/knowledge/materials/${imported.material.id}?engagementId=eng-hybrid`);
  const rebuild = await call("POST", `${plane.url}/knowledge/index/rebuild?engagementId=eng-hybrid`, {});
  assert.equal(rebuild.status, 202, rebuild.text);
  await plane.knowledge.index.idle();
  const after = await call("GET", `${plane.url}/knowledge/materials/${imported.material.id}?engagementId=eng-hybrid`);
  assert.equal(after.json.material.versionCount, before.json.material.versionCount);
  assert.equal(after.json.versions[0].contentSha256, imported.version.contentSha256);
  assert.equal(after.json.versions[0].id, imported.version.id);
  const rebuiltStatus = await call("GET", `${plane.url}/knowledge/index?engagementId=eng-hybrid`);
  assert.equal(rebuiltStatus.json.index.state, "ready");
});

test("停用向量化后检索仍可用，索引状态如实标 disabled", async (t) => {
  const { plane } = await fixture(t, { enabled: false });
  await importArticle(plane);
  const status = await call("GET", `${plane.url}/knowledge/index?engagementId=eng-hybrid`);
  assert.equal(status.json.index.state, "disabled");
  assert.equal(status.json.index.degraded, true);
  assert.equal(status.json.index.model, null);
  const search = await call("GET", `${plane.url}/knowledge/search?q=${encodeURIComponent("换任")}&engagementId=eng-hybrid`);
  assert.equal(search.json.hits[0].locator, "§6.4");
  assert.equal(search.json.index.degraded, true);
});

test("定版引用固定原文范围：重切分、换模型、重建索引、重启后都回读同一段", async (t) => {
  const stub = await startEmbeddingStub(t);
  const { root, plane, task, base, shutdown } = await fixture(t, { embeddingBaseUrl: stub.url });
  const imported = await importArticle(plane);
  await plane.knowledge.index.idle();

  const hit = (await call("GET", `${plane.url}/knowledge/search?q=${encodeURIComponent("负责人换班")}&engagementId=eng-hybrid`)).json.hits[0];
  assert.equal(hit.locator, "§6.4");
  const cited = await call("POST", `${base}/citations`, {
    materialId: hit.materialId, versionId: hit.versionId, locator: hit.locator,
    charStart: hit.charStart, charEnd: hit.charEnd, chunkSha256: hit.chunkSha256,
    claim: "独立分析观察到一次负责人换班",
  });
  assert.equal(cited.status, 201, cited.text);
  const citation = cited.json.citation;
  assert.equal(citation.pinKind, "range");
  assert.equal(citation.charStart, hit.charStart);
  assert.equal(citation.charEnd, hit.charEnd);
  assert.equal(citation.chunkSha256, hit.chunkSha256);
  assert.equal(citation.snapshotSha256, imported.version.contentSha256);
  const expectedText = ARTICLE.slice(hit.charStart, hit.charEnd);

  const readBack = async (url: string) => {
    const res = await call("GET", `${url}/tasks/${task.id}/citations/${citation.id}/resolve`);
    assert.equal(res.status, 200, res.text);
    assert.equal(res.json.verification.status, "verified");
    assert.equal(res.json.verification.recomputedSha256, imported.version.contentSha256);
    assert.equal(res.json.paragraph.text, expectedText);
    assert.equal(res.json.paragraph.charStart, hit.charStart);
    assert.equal(res.json.paragraph.charEnd, hit.charEnd);
    assert.equal(res.json.paragraph.chunkSha256, hit.chunkSha256);
    return res.json;
  };
  await readBack(plane.url);

  // 重建索引 + 重切分
  await call("POST", `${plane.url}/knowledge/index/rebuild?engagementId=eng-hybrid`, {});
  await plane.knowledge.index.idle();
  await readBack(plane.url);

  // 换 embedding 模型（换索引指纹）后重启
  await shutdown();
  const restarted = await bootControlPlane({
    dataRoot: root, host: "127.0.0.1", port: 0, runtime: "local", isolated: true, watchdogMs: 60_000,
    knowledgeEmbedding: {
      enabled: true,
      provider: "local",
      local: { baseUrl: stub.url, model: "stub-other-model", apiKeyEnv: "", batchSize: 8, timeoutMs: 5_000 },
    },
  });
  t.after(async () => { await restarted.close(); });
  await restarted.knowledge.index.idle();
  const afterModelSwap = await readBack(restarted.url);
  assert.equal(afterModelSwap.citation.versionId, imported.version.id);
  const indexAfter = await call("GET", `${restarted.url}/knowledge/index?engagementId=eng-hybrid`);
  assert.equal(indexAfter.json.index.model, "stub-other-model");
  assert.notEqual(indexAfter.json.index.indexKey, "c2:stub-multilingual");

  // 只打包引用片段的离线导出
  const paragraphExport = await call("GET", `${restarted.url}/tasks/${task.id}/report-export?snapshot=paragraph`);
  assert.equal(paragraphExport.json.snapshotScope, "paragraph");
  const packed = paragraphExport.json.citations[0].snapshot;
  assert.equal(Buffer.from(packed.bytesBase64, "base64").toString("utf8"), expectedText);
  assert.equal(packed.sha256, hit.chunkSha256);
  // 默认仍打包整份版本快照
  const fullExport = await call("GET", `${restarted.url}/tasks/${task.id}/report-export`);
  assert.equal(fullExport.json.snapshotScope, "full-version");
  assert.equal(Buffer.from(fullExport.json.citations[0].snapshot.bytesBase64, "base64").toString("utf8"), ARTICLE);
  const noneExport = await call("GET", `${restarted.url}/tasks/${task.id}/report-export?snapshot=none`);
  assert.equal(noneExport.json.citations[0].snapshot, undefined);
  assert.ok(noneExport.json.citations[0].paragraph.text.length > 0);
});

test("原文范围或片段校验值与定位不一致时拒绝建引用", async (t) => {
  const stub = await startEmbeddingStub(t);
  const { plane, base } = await fixture(t, { embeddingBaseUrl: stub.url });
  const imported = await importArticle(plane);
  const section = imported.sections.find((s: any) => s.locator === "§6.4");
  const mismatchedRange = await call("POST", `${base}/citations`, {
    materialId: imported.material.id, versionId: imported.version.id, locator: "§6.4",
    charStart: section.charStart, charEnd: section.charEnd + 5, claim: "范围错配",
  });
  assert.equal(mismatchedRange.status, 409, mismatchedRange.text);
  assert.ok(mismatchedRange.json.error.includes("不一致"));
  const mismatchedSha = await call("POST", `${base}/citations`, {
    materialId: imported.material.id, versionId: imported.version.id, locator: "§6.4",
    chunkSha256: "0".repeat(64), claim: "校验值错配",
  });
  assert.equal(mismatchedSha.status, 409, mismatchedSha.text);
  const badRange = await call("POST", `${base}/citations`, {
    materialId: imported.material.id, versionId: imported.version.id, locator: "§6.4",
    charStart: 10, claim: "只给一半范围",
  });
  assert.equal(badRange.status, 400, badRange.text);
});

test("语义一路同样执行委托隔离：跨委托查询、计数与索引计数都不泄露", async (t) => {
  const stub = await startEmbeddingStub(t);
  const { plane } = await fixture(t, { embeddingBaseUrl: stub.url });
  const secret = await call("POST", `${plane.url}/knowledge/materials`, articleImport({
    title: "委托B专属运行分析", sourceUrl: "https://example.invalid/b-secret",
    content: "## 交接记录\n\n06:14 换任，继任者读 STATE 续接进度。",
    scope: { kind: "engagement", engagementId: "eng-other" },
  }));
  assert.equal(secret.status, 201, secret.text);
  const own = await importArticle(plane);
  await plane.knowledge.index.idle();

  // 语义查询在 A 侧不得召回 B 的正文
  const search = await call("GET", `${plane.url}/knowledge/search?q=${encodeURIComponent("负责人换班")}&engagementId=eng-hybrid`);
  assert.ok(search.json.hits.length > 0);
  assert.ok(search.json.hits.every((h: any) => h.materialId !== secret.json.material.id));
  assert.ok(!search.text.includes("委托B专属运行分析"));
  assert.equal(search.json.searchedVersions, 1);
  const indexA = await call("GET", `${plane.url}/knowledge/index?engagementId=eng-hybrid`);
  assert.equal(indexA.json.index.totalChunks, own.sections.length);
  const indexB = await call("GET", `${plane.url}/knowledge/index?engagementId=eng-other`);
  assert.equal(indexB.json.index.totalChunks, secret.json.sections.length);
  // 未声明委托的读者两路都看不到委托专属资料
  const anonymous = await call("GET", `${plane.url}/knowledge/search?q=${encodeURIComponent("负责人换班")}`);
  assert.equal(anonymous.json.total, 0);
  assert.equal(anonymous.json.searchedVersions, 0);
  // 越界重建被拒
  const rebuild = await call("POST", `${plane.url}/knowledge/index/rebuild?engagementId=eng-hybrid`,
    { materialId: secret.json.material.id });
  assert.equal(rebuild.status, 404);
});

/** 三页 PDF，页内含空行；页码必须按物理页而不是空行推算。 */
function threePagePdf(): Buffer {
  const parts: Buffer[] = [];
  const push = (value: string | Buffer) => parts.push(Buffer.isBuffer(value) ? value : Buffer.from(value, "latin1"));
  push("%PDF-1.4\n");
  push("1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n");
  push("2 0 obj\n<< /Type /Pages /Kids [3 0 R 6 0 R 9 0 R] /Count 3 >>\nendobj\n");
  const pages = [
    ["Page one heading", "line A", "", "line B after a blank line"],
    ["Page two heading", "only line"],
    ["Page three heading", "third page body", "", "tail"],
  ];
  pages.forEach((lines, index) => {
    const pageObj = 3 + index * 3;
    const contentObj = pageObj + 1;
    const fontObj = pageObj + 2;
    push(`${pageObj} 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${fontObj} 0 R >> >> /Contents ${contentObj} 0 R >>\nendobj\n`);
    const text = lines.map((line, i) => `BT /F1 12 Tf 72 ${720 - i * 20} Td (${line}) Tj ET`).join("\n");
    const stream = deflateSync(Buffer.from(text, "latin1"));
    push(`${contentObj} 0 obj\n<< /Length ${stream.length} /Filter /FlateDecode >>\nstream\n`);
    push(stream);
    push("\nendstream\nendobj\n");
    push(`${fontObj} 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n`);
  });
  push("trailer\n<< /Size 12 /Root 1 0 R >>\n%%EOF\n");
  return Buffer.concat(parts);
}

test("PDF 页码按物理页：页内空行不再被当成页边界", async (t) => {
  const stub = await startEmbeddingStub(t);
  const { plane } = await fixture(t, { embeddingBaseUrl: stub.url });
  const res = await call("POST", `${plane.url}/knowledge/materials`, articleImport({
    title: "三页 PDF", format: "pdf", content: undefined, contentBase64: threePagePdf().toString("base64"),
    sourceUrl: "https://example.invalid/three.pdf",
  }));
  assert.equal(res.status, 201, res.text);
  const sections = res.json.sections as any[];
  assert.deepEqual([...new Set(sections.map((s) => s.page))], [1, 2, 3]);
  assert.deepEqual(sections.map((s) => s.locator), ["p.1", "p.2", "p.3"]);
  assert.ok(sections.every((s) => s.pageBasis === "physical-page"));
  assert.ok(sections[0].text.includes("line A") && sections[0].text.includes("line B after a blank line"),
    "同一物理页内被空行分开的正文必须留在同一页");
  assert.ok(sections[2].text.includes("third page body"));
});

test("旧版 locator 引用（无原文范围）按旧切分回读，升级前后是同一段", async (t) => {
  const stub = await startEmbeddingStub(t);
  const { plane, task, base } = await fixture(t, { embeddingBaseUrl: stub.url });
  const imported = await importArticle(plane);
  const paths = taskPaths(task.dataDir);
  openHistory({ dbPath: paths.historyDb, evidenceDir: paths.evidenceDir }).close();
  // 直接写入升级前形状的引用行：只有 locator，没有 pin_kind / 范围 / section_json。
  const snapshot = Buffer.from(ARTICLE, "utf8");
  const snapshotSha = sha256(snapshot);
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(paths.historyDb);
  db.prepare("INSERT INTO evidence_versions (sha256, content) VALUES (?, ?)").run(snapshotSha, snapshot);
  db.prepare(
    `INSERT INTO material_citations (id, task_id, engagement_id, material_id, version_id, locator, claim,
       body_format, material_title, publisher, source_kind, version_no, version_label,
       section_heading, section_page, section_ordinal, sha256, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run("legacy-citation", task.id, task.engagementId, imported.material.id, imported.version.id, "§6.4",
    "升级前登记的引用", "markdown", "运行分析整篇", "验收合成材料", "original", 1, "本地 v1",
    "6.4 状态与连续性", null, 3, snapshotSha, new Date().toISOString());
  db.close();

  const resolved = await call("GET", `${base}/citations/legacy-citation/resolve`);
  assert.equal(resolved.status, 200, resolved.text);
  assert.equal(resolved.json.citation.pinKind, "locator");
  assert.equal(resolved.json.citation.charStart, null);
  assert.equal(resolved.json.verification.status, "verified");
  // 旧切分下 §6.4 是整章（含表格、正文与代码块），不是新切分的第一片
  const paragraph = resolved.json.paragraph;
  assert.ok(paragraph.text.startsWith("### 6.4 状态与连续性"));
  assert.ok(paragraph.text.includes("```text") && paragraph.text.includes("## Allocation"));
  assert.equal(paragraph.text, ARTICLE.slice(paragraph.charStart, paragraph.charEnd));
  const newChunk = imported.sections.find((s: any) => s.locator === "§6.4");
  assert.ok(paragraph.text.length >= newChunk.text.length, "旧引用回读的整章不应短于新切分的首片");
});

test("升级前的 material_citations 表结构（缺定版范围列）只读回读仍可用", async (t) => {
  const stub = await startEmbeddingStub(t);
  const { plane, task, base } = await fixture(t, { embeddingBaseUrl: stub.url });
  const imported = await importArticle(plane);
  const paths = taskPaths(task.dataDir);
  const snapshot = Buffer.from(ARTICLE, "utf8");
  const snapshotSha = sha256(snapshot);
  openHistory({ dbPath: paths.historyDb, evidenceDir: paths.evidenceDir }).close();

  // 把表还原成升级前的形状：没有 pin_kind / char_start / char_end / chunk_sha256 / section_json。
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(paths.historyDb);
  db.prepare("INSERT INTO evidence_versions (sha256, content) VALUES (?, ?)").run(snapshotSha, snapshot);
  db.exec("PRAGMA foreign_keys = OFF");
  db.exec(`
    CREATE TABLE material_citations_preupgrade (
      id TEXT PRIMARY KEY, task_id TEXT NOT NULL, engagement_id TEXT NOT NULL,
      material_id TEXT NOT NULL, version_id TEXT NOT NULL, locator TEXT NOT NULL, claim TEXT NOT NULL,
      body_format TEXT NOT NULL, material_title TEXT NOT NULL, publisher TEXT NOT NULL,
      source_kind TEXT NOT NULL, version_no INTEGER NOT NULL, version_label TEXT NOT NULL,
      section_heading TEXT, section_page INTEGER, section_ordinal INTEGER NOT NULL,
      sha256 TEXT NOT NULL, created_at TEXT NOT NULL
    );
    DROP TABLE material_citations;
    ALTER TABLE material_citations_preupgrade RENAME TO material_citations;
  `);
  db.prepare(
    `INSERT INTO material_citations (id, task_id, engagement_id, material_id, version_id, locator, claim,
       body_format, material_title, publisher, source_kind, version_no, version_label,
       section_heading, section_page, section_ordinal, sha256, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run("preupgrade-citation", task.id, task.engagementId, imported.material.id, imported.version.id, "§6.4",
    "升级前登记的引用", "markdown", "运行分析整篇", "验收合成材料", "original", 1, "本地 v1",
    "6.4 状态与连续性", null, 3, snapshotSha, new Date().toISOString());
  const columns = (db.prepare("PRAGMA table_info(material_citations)").all() as Array<{ name: string }>).map((c) => c.name);
  db.close();
  assert.equal(columns.includes("pin_kind"), false, "本用例前提是表里没有定版范围列");

  // resolve 走只读连接，不跑迁移：必须照样读得出来
  const resolved = await call("GET", `${base}/citations/preupgrade-citation/resolve`);
  assert.equal(resolved.status, 200, resolved.text);
  assert.equal(resolved.json.citation.pinKind, "locator");
  assert.equal(resolved.json.citation.charStart, null);
  assert.equal(resolved.json.citation.chunkSha256, null);
  assert.deepEqual(resolved.json.citation.headingPath, []);
  assert.equal(resolved.json.verification.status, "verified");
  assert.ok(resolved.json.paragraph.text.startsWith("### 6.4 状态与连续性"));
  assert.equal(resolved.json.paragraph.text,
    ARTICLE.slice(resolved.json.paragraph.charStart, resolved.json.paragraph.charEnd));

  const listed = await call("GET", `${base}/citations`);
  assert.equal(listed.status, 200, listed.text);
  assert.equal(listed.json.citations.length, 1);
  const exported = await call("GET", `${base}/report-export`);
  assert.equal(exported.status, 200, exported.text);
  assert.equal(exported.json.citations[0].verification.status, "verified");
});
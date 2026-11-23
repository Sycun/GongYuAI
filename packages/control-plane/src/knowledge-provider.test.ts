/**
 * 本地/云端两套向量化服务、索引归属与重试缺陷的回归。
 *
 * 全部走**真实 HTTP**：测试内起两个本机 OpenAI 兼容 /embeddings 服务，
 * 分别代表「本地服务」与「云端服务」，各自记录收到的 Authorization 与输入文本，
 * 从而能验收凭据不串用、未授权范围零次云端请求。
 * 真实模型的召回质量由 `pnpm knowledge:hybrid-acceptance` 用本机 bge-m3 验收。
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test, type TestContext } from "node:test";
import { CreateTaskRequestSchema, KNOWLEDGE_EMBEDDING_PROBE_TEXT, type KnowledgeSection } from "@gongyuai/contracts";
import { openHistory } from "@gongyuai/history";
import { bootControlPlane, EmbeddingClient, taskPaths } from "./index.js";
import { type EmbeddingRuntime } from "./knowledge-embed.js";
import { KnowledgeIndex } from "./knowledge-index.js";

const sha256 = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");

const CONCEPTS: Array<{ dim: number; words: string[] }> = [
  { dim: 0, words: ["换班", "换任", "交接", "handover", "commander", "负责人"] },
  { dim: 1, words: ["续上", "继续", "续接", "state", "resume", "progress", "进度"] },
  { dim: 2, words: ["更正", "回函", "correction", "凭据"] },
];

/** 两套服务用不同维度与不同基址，模拟「同名模型在不同服务上向量不可混用」。 */
function conceptVector(text: string, dim: number, offset: number): number[] {
  const lower = text.toLowerCase();
  const vector: number[] = new Array(dim).fill(0);
  for (const concept of CONCEPTS) {
    const hits = concept.words.filter((word) => lower.includes(word)).length;
    if (hits) vector[concept.dim + offset] = hits;
  }
  let sum = 0;
  for (const value of vector) sum += value * value;
  if (sum === 0) { vector[dim - 1] = 1; sum = 1; }
  const norm = Math.sqrt(sum);
  return vector.map((value) => value / norm);
}

type Stub = {
  url: string;
  options: { fail?: boolean; delayMs?: number; dims?: number[] };
  calls: () => number;
  keys: () => string[];
  inputs: () => string[];
  reset: () => void;
};

async function startStub(t: TestContext, spec: { dim: number; offset: number }): Promise<Stub> {
  const options: Stub["options"] = {};
  let calls = 0;
  const keys: string[] = [];
  const inputs: string[] = [];
  const server: Server = createServer((req, res) => {
    if (req.method !== "POST" || !req.url?.endsWith("/embeddings")) {
      res.writeHead(404).end("{}");
      return;
    }
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      calls += 1;
      keys.push(String(req.headers.authorization ?? ""));
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { input?: string[] };
      const batch = body.input ?? [];
      inputs.push(...batch);
      // dims 是逐请求维度序列：先按序取，取完后停在最后一个值，模拟「探测与正文维度不一致」的服务。
      const dim = options.dims?.length
        ? (options.dims.length > 1 ? options.dims.shift()! : options.dims[0]!)
        : spec.dim;
      const reply = () => {
        if (options.fail) {
          res.writeHead(503, { "content-type": "application/json" })
            .end(JSON.stringify({ error: { message: "stub embedding service unavailable" } }));
          return;
        }
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({
          data: batch.map((text, index) => ({ index, embedding: conceptVector(text, dim, spec.offset) })),
        }));
      };
      if (options.delayMs) setTimeout(reply, options.delayMs);
      else reply();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  t.after(() => new Promise<void>((resolve) => {
    server.closeAllConnections?.();
    server.close(() => resolve());
  }));
  return {
    url: `http://127.0.0.1:${port}/v1`,
    options,
    calls: () => calls,
    keys: () => [...keys],
    inputs: () => [...inputs],
    reset: () => { calls = 0; keys.length = 0; inputs.length = 0; },
  };
}

async function waitFor(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.ok(predicate(), "等待条件超时");
}

const ARTICLE = [
  "# 运行分析",
  "",
  "## 6. 架构设计",
  "",
  "### 6.4 状态与连续性",
  "",
  "| 机制 | 实现 |",
  "|---|---|",
  "| Commander 交接 | 2 任 commander，06:14 换任，靠 STATE 续接 |",
  "",
  "换任通过读 STATE 文件继续。",
  "",
  "### 6.5 自我修复",
  "",
  "agent 改了自己的工具。",
].join("\n");

async function call(method: string, url: string, body?: unknown) {
  const res = await fetch(url, {
    method,
    headers: body === undefined ? {} : { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: res.status, text, json };
}

const LOCAL_KEY_ENV = "GY_TEST_LOCAL_EMBED_KEY";
const LOCAL_KEY = "local-service-secret";
const CLOUD_KEY = "cloud-service-secret";

async function fixture(t: TestContext, opts: {
  local: Stub; cloud?: Stub; provider?: "local" | "cloud"; cloudEngagements?: string[]; enabled?: boolean;
  cloudBatchSize?: number;
}) {
  const root = mkdtempSync(join(tmpdir(), "gy-knowledge-provider-"));
  process.env[LOCAL_KEY_ENV] = LOCAL_KEY;
  const plane = await bootControlPlane({
    dataRoot: root, host: "127.0.0.1", port: 0, runtime: "local", isolated: true, watchdogMs: 60_000,
    knowledgeEmbedding: {
      enabled: opts.enabled ?? true,
      provider: opts.provider ?? "local",
      cloudEngagements: opts.cloudEngagements ?? [],
      // 本地密钥只从环境变量取；云端密钥直接登记。两边同名模型，靠服务地址区分指纹。
      local: { baseUrl: opts.local.url, model: "same-model-id", apiKeyEnv: LOCAL_KEY_ENV, batchSize: 8, timeoutMs: 5_000 },
      cloud: {
        baseUrl: opts.cloud?.url ?? "", model: opts.cloud ? "same-model-id" : "",
        apiKeyEnv: "GY_TEST_CLOUD_EMBED_KEY_UNSET", apiKey: opts.cloud ? CLOUD_KEY : "",
        batchSize: opts.cloudBatchSize ?? 8, timeoutMs: 5_000,
      },
    },
  });
  t.after(async () => { await plane.close(); rmSync(root, { recursive: true, force: true }); });
  const task = plane.store.createTask(CreateTaskRequestSchema.parse({
    name: "向量化服务验收", engagementId: "eng-a",
    auth: { targets: ["provider.invalid"], authorizationNote: "虚构材料，仅用于工程验收" },
    goals: [{ id: "g1", title: "服务切换", description: "本地与云端互切", evidencePatterns: ["knowledge/*.json"] }],
    mock: true,
  }));
  const paths = taskPaths(task.dataDir);
  const history = openHistory({ dbPath: paths.historyDb, evidenceDir: paths.evidenceDir });
  history.seedGoals(task.id, task.goals);
  history.close();
  plane.store.finishTask(task, "completed", null);
  return { root, plane, task, base: `${plane.url}/tasks/${task.id}` };
}

function importBody(overrides: Record<string, unknown> = {}) {
  return {
    title: "运行分析整篇", publisher: "验收合成材料", sourceKind: "original", format: "markdown",
    sourceUrl: "https://example.invalid/article", content: ARTICLE, tags: [],
    scope: { kind: "engagement", engagementId: "eng-a" },
    ...overrides,
  };
}

async function importMaterial(plane: { url: string }, overrides: Record<string, unknown> = {}) {
  const res = await call("POST", `${plane.url}/knowledge/materials`, importBody(overrides));
  assert.equal(res.status, 201, res.text);
  return res.json;
}

const putSettings = (plane: { url: string }, patch: unknown) =>
  call("PUT", `${plane.url}/settings/knowledge-embedding`, patch);
const indexOf = (plane: { url: string }, engagementId?: string) =>
  call("GET", `${plane.url}/knowledge/index${engagementId ? `?engagementId=${engagementId}` : ""}`);
const retryOf = (plane: { url: string }, engagementId?: string) =>
  call("POST", `${plane.url}/knowledge/index/retry${engagementId ? `?engagementId=${engagementId}` : ""}`, {});
const rebuildOf = (plane: { url: string }, engagementId?: string) =>
  call("POST", `${plane.url}/knowledge/index/rebuild${engagementId ? `?engagementId=${engagementId}` : ""}`, {});
const searchOf = (plane: { url: string }, q: string, engagementId?: string) =>
  call("GET", `${plane.url}/knowledge/search?q=${encodeURIComponent(q)}${engagementId ? `&engagementId=${engagementId}` : ""}`);

test("停用后重新启用同一模型：只点重试即恢复 ready，不再停在 pending 0/N", async (t) => {
  const local = await startStub(t, { dim: 8, offset: 0 });
  const { plane } = await fixture(t, { local });
  const imported = await importMaterial(plane);
  await plane.knowledge.index.idle();
  const ready = await indexOf(plane, "eng-a");
  assert.equal(ready.json.index.state, "ready");
  assert.equal(ready.json.index.modelDim, 8);

  // 页面停用并保存
  const disabled = await putSettings(plane, { enabled: false });
  assert.equal(disabled.status, 200, disabled.text);
  assert.equal((await indexOf(plane, "eng-a")).json.index.state, "disabled");

  // 重新启用同一模型：维度需重新探测，此时不能报 ready
  const enabled = await putSettings(plane, { enabled: true });
  assert.equal(enabled.status, 200, enabled.text);
  const afterEnable = await indexOf(plane, "eng-a");
  assert.equal(afterEnable.json.index.modelDim, null);
  assert.equal(afterEnable.json.index.indexedChunks, 0);
  assert.equal(afterEnable.json.index.state, "pending", "维度未探测时不得报 ready/indexing");

  // 只点重试，不做任何重建
  const retry = await retryOf(plane, "eng-a");
  assert.equal(retry.status, 202, retry.text);
  assert.deepEqual(retry.json.queued, [imported.version.id], "有待处理版本时必须真的入队");
  await plane.knowledge.index.idle();
  const recovered = await indexOf(plane, "eng-a");
  assert.equal(recovered.json.index.state, "ready");
  assert.equal(recovered.json.index.modelDim, 8);
  assert.equal(recovered.json.index.indexedChunks, imported.sections.length);

  // 确实无工作可做时如实返回空队列，页面据此显示「没有需要重试的资料」
  const noop = await retryOf(plane, "eng-a");
  assert.equal(noop.status, 202, noop.text);
  assert.deepEqual(noop.json.queued, []);
  assert.equal(noop.json.status.state, "ready");
});

test("服务暂时不可用：恢复后只靠重试补满索引，不需要重建", async (t) => {
  const local = await startStub(t, { dim: 8, offset: 0 });
  const { plane } = await fixture(t, { local });
  local.options.fail = true;
  const imported = await importMaterial(plane);
  await plane.knowledge.index.idle();
  const failed = await indexOf(plane, "eng-a");
  assert.ok(["unavailable", "error"].includes(failed.json.index.state), failed.json.index.state);
  assert.ok(failed.json.index.failedChunks > 0);

  local.options.fail = false;
  const retry = await retryOf(plane, "eng-a");
  assert.deepEqual(retry.json.queued, [imported.version.id]);
  await plane.knowledge.index.idle();
  const recovered = await indexOf(plane, "eng-a");
  assert.equal(recovered.json.index.state, "ready");
  assert.equal(recovered.json.index.indexedChunks, imported.sections.length);
  assert.equal(recovered.json.index.failedChunks, 0);
});

test("本地→云端→本地互切：配置各自留存、凭据不串用、指纹与维度按服务区分", async (t) => {
  const local = await startStub(t, { dim: 8, offset: 0 });
  const cloud = await startStub(t, { dim: 12, offset: 4 });
  const { plane } = await fixture(t, { local, cloud });
  const imported = await importMaterial(plane, { scope: { kind: "shared" } });
  await plane.knowledge.index.idle();

  const localIndex = (await indexOf(plane)).json.index;
  assert.equal(localIndex.state, "ready");
  assert.equal(localIndex.providerKind, "local");
  assert.equal(localIndex.modelDim, 8);
  const localKey = localIndex.indexKey;
  const localSearch = await searchOf(plane, "负责人换班");
  assert.ok(localSearch.json.recall.semantic > 0, "本地服务应能语义召回");
  assert.equal(localSearch.json.index.degraded, false);

  // 切云端：共享资料改由云端索引，需要重建
  const toCloud = await putSettings(plane, { provider: "cloud" });
  assert.equal(toCloud.status, 200, toCloud.text);
  assert.equal(toCloud.json.knowledgeEmbedding.local.baseUrl, local.url, "本地配置必须留存");
  assert.equal(toCloud.json.knowledgeEmbedding.local.apiKeyEnv, LOCAL_KEY_ENV);
  const pending = await indexOf(plane);
  assert.equal(pending.json.index.providerKind, "cloud");
  assert.ok(pending.json.index.pendingChunks > 0, "换服务后应提示需要重建");
  await rebuildOf(plane);
  await plane.knowledge.index.idle();
  const cloudIndex = (await indexOf(plane)).json.index;
  assert.equal(cloudIndex.state, "ready");
  assert.equal(cloudIndex.modelDim, 12);
  assert.notEqual(cloudIndex.indexKey, localKey, "同名模型在不同服务上指纹必须不同");
  assert.ok(cloudIndex.indexKey.includes("cloud"));
  const cloudSearch = await searchOf(plane, "负责人换班");
  assert.ok(cloudSearch.json.recall.semantic > 0, "云端服务应能语义召回");
  assert.equal(cloudSearch.json.index.modelDim, 12);

  // 切回本地：配置恢复，旧向量还在盘上，重试即可就绪
  const backLocal = await putSettings(plane, { provider: "local" });
  assert.equal(backLocal.json.knowledgeEmbedding.cloud.apiKeyConfigured, true, "云端密钥必须留存");
  assert.equal(backLocal.json.knowledgeEmbedding.cloud.model, "same-model-id");
  assert.equal(backLocal.json.knowledgeEmbedding.local.baseUrl, local.url);
  await retryOf(plane);
  await plane.knowledge.index.idle();
  const backIndex = (await indexOf(plane)).json.index;
  assert.equal(backIndex.state, "ready");
  assert.equal(backIndex.indexKey, localKey);
  assert.equal(backIndex.modelDim, 8);
  const backSearch = await searchOf(plane, "负责人换班");
  assert.ok(backSearch.json.recall.semantic > 0);

  // 凭据隔离：两个服务各自只收到自己的密钥，且都是非空
  assert.ok(local.keys().length > 0);
  assert.ok(cloud.keys().length > 0);
  assert.deepEqual([...new Set(local.keys())], [`Bearer ${LOCAL_KEY}`]);
  assert.deepEqual([...new Set(cloud.keys())], [`Bearer ${CLOUD_KEY}`]);

  // 公开视图只给掩码，绝不回传明文密钥
  const view = (await call("GET", `${plane.url}/settings`)).json.knowledgeEmbedding;
  assert.equal(view.local.apiKey, undefined);
  assert.equal(view.cloud.apiKey, undefined);
  assert.equal(view.cloud.apiKeyConfigured, true);
  assert.ok(!JSON.stringify(view).includes(CLOUD_KEY));
  assert.equal(imported.version.contentSha256, sha256(ARTICLE));
});

test("委托专属资料默认本地：未允许的委托查询零次云端请求，允许后才发往云端", async (t) => {
  const local = await startStub(t, { dim: 8, offset: 0 });
  const cloud = await startStub(t, { dim: 12, offset: 4 });
  const { plane } = await fixture(t, { local, cloud, provider: "cloud", cloudEngagements: ["eng-a"] });

  const shared = await importMaterial(plane, { title: "共享运行分析", scope: { kind: "shared" } });
  const own = await importMaterial(plane, {
    title: "委托A专属", sourceUrl: "https://example.invalid/a",
    scope: { kind: "engagement", engagementId: "eng-a" },
  });
  const secret = await importMaterial(plane, {
    title: "委托B专属", sourceUrl: "https://example.invalid/b",
    content: "## 交接记录\n\n06:14 换任，继任者读 STATE 续接进度。",
    scope: { kind: "engagement", engagementId: "eng-b" },
  });
  await plane.knowledge.index.idle();

  // 共享 + 已允许的 A 走云端；未允许的 B 走本地
  const cloudCallsAfterImport = cloud.calls();
  assert.ok(cloudCallsAfterImport > 0, "允许范围内的调用必须真的发生");
  const indexB = (await indexOf(plane, "eng-b")).json.index;
  const localServiceB = indexB.services.find((s: any) => s.provider === "local");
  const cloudServiceB = indexB.services.find((s: any) => s.provider === "cloud");
  assert.equal(localServiceB.indexedChunks, secret.sections.length, "B 的专属资料由本地索引");
  assert.equal(cloudServiceB.allowed, false, "B 未获云端授权");
  assert.equal(cloudServiceB.indexedChunks, shared.sections.length, "库里确实有云端索引的共享资料");
  assert.equal(indexB.blockedChunks, shared.sections.length);

  // B 的查询：正文与查询文本都不得发往云端
  cloud.reset();
  const searchB = await searchOf(plane, "负责人换班", "eng-b");
  assert.equal(searchB.status, 200, searchB.text);
  assert.equal(cloud.calls(), 0, "未允许云端处理的委托查询必须零次云端请求");
  assert.ok(searchB.json.hits.length > 0, "B 仍能靠本地向量召回自己的资料");
  assert.ok(searchB.json.hits.every((h: any) => h.materialId === secret.material.id),
    "云端索引的共享资料不得参与 B 的语义召回");
  assert.equal(searchB.json.index.blockedChunks, shared.sections.length);
  // 云端也没收到 B 的正文
  assert.ok(!cloud.inputs().some(text => text.includes("委托B")));

  // 本地这一路无命中时，如实说明有片段属于未获授权服务
  const blockedOnly = await searchOf(plane, "更正凭据回函", "eng-b");
  assert.equal(cloud.calls(), 0);
  assert.equal(blockedOnly.json.recall.semantic, 0);
  assert.equal(blockedOnly.json.index.degraded, true);
  assert.ok(blockedOnly.json.index.degradedReason.includes("未获授权"), blockedOnly.json.index.degradedReason);

  // A 的查询：允许范围内确实发往云端
  cloud.reset();
  const searchA = await searchOf(plane, "负责人换班", "eng-a");
  assert.ok(cloud.calls() > 0, "已允许的委托查询应发往云端");
  assert.ok(cloud.inputs().includes("负责人换班"));
  assert.ok(searchA.json.recall.semantic > 0);
  assert.equal(searchA.json.index.blockedChunks, 0);
  assert.ok(searchA.json.hits.every((h: any) => h.materialId !== secret.material.id));

  // 撤销 A 的授权后，A 的专属资料回到本地，查询也不再发往云端
  await putSettings(plane, { cloudEngagements: [] });
  await retryOf(plane, "eng-a");
  await plane.knowledge.index.idle();
  cloud.reset();
  const revoked = await searchOf(plane, "负责人换班", "eng-a");
  assert.equal(cloud.calls(), 0, "撤销授权后不得再发往云端");
  assert.ok(revoked.json.hits.length > 0);
  const indexA = (await indexOf(plane, "eng-a")).json.index;
  assert.equal(indexA.services.find((s: any) => s.provider === "local").indexedChunks, own.sections.length);
});

test("测试连接只发固定合成短句：报告实测维度，不写索引、不触发重建", async (t) => {
  const local = await startStub(t, { dim: 8, offset: 0 });
  const cloud = await startStub(t, { dim: 12, offset: 4 });
  const { plane } = await fixture(t, { local, cloud });
  const imported = await importMaterial(plane);
  await plane.knowledge.index.idle();
  const before = (await indexOf(plane, "eng-a")).json.index;
  local.reset(); cloud.reset();

  // 用未保存的草稿测试云端：地址、模型、密钥都由草稿给出
  const tested = await call("POST", `${plane.url}/settings/knowledge-embedding/test`, {
    provider: "cloud",
    service: { baseUrl: cloud.url, model: "draft-model", apiKey: CLOUD_KEY, batchSize: 8, timeoutMs: 5_000 },
  });
  assert.equal(tested.status, 200, tested.text);
  assert.equal(tested.json.ok, true, tested.text);
  assert.equal(tested.json.provider, "cloud");
  assert.equal(tested.json.model, "draft-model");
  assert.equal(tested.json.dim, 12);
  assert.equal(tested.json.probeText, KNOWLEDGE_EMBEDDING_PROBE_TEXT);
  assert.deepEqual(cloud.inputs(), [KNOWLEDGE_EMBEDDING_PROBE_TEXT], "只发这一句合成文本");
  assert.deepEqual(cloud.keys(), [`Bearer ${CLOUD_KEY}`]);
  assert.equal(local.calls(), 0, "测试云端不得动本地服务");

  // 索引与配置都没被测试改动
  const after = (await indexOf(plane, "eng-a")).json.index;
  assert.equal(after.indexKey, before.indexKey);
  assert.equal(after.indexedChunks, before.indexedChunks);
  assert.equal(after.state, "ready");
  const view = (await call("GET", `${plane.url}/settings`)).json.knowledgeEmbedding;
  assert.equal(view.provider, "local");
  assert.equal(view.cloud.baseUrl, cloud.url);
  assert.equal(view.cloud.model, "same-model-id", "草稿不得写进已存配置");

  // 服务不可用时如实报错，不谎报成功
  cloud.options.fail = true;
  const failed = await call("POST", `${plane.url}/settings/knowledge-embedding/test`, { provider: "cloud" });
  assert.equal(failed.status, 200, failed.text);
  assert.equal(failed.json.ok, false);
  assert.ok(failed.json.error.includes("503"));
  assert.equal(imported.version.contentSha256, sha256(ARTICLE));
});

test("切换服务与模型后旧报告仍回读原段落，原文与片段 SHA-256 不变", async (t) => {
  const local = await startStub(t, { dim: 8, offset: 0 });
  const cloud = await startStub(t, { dim: 12, offset: 4 });
  const { plane, task, base } = await fixture(t, { local, cloud });
  const imported = await importMaterial(plane);
  await plane.knowledge.index.idle();
  const hit = (await searchOf(plane, "负责人换班", "eng-a")).json.hits[0];
  assert.equal(hit.locator, "§6.4");
  const cited = await call("POST", `${base}/citations`, {
    materialId: hit.materialId, versionId: hit.versionId, locator: hit.locator,
    charStart: hit.charStart, charEnd: hit.charEnd, chunkSha256: hit.chunkSha256,
    claim: "独立分析观察到一次负责人换班",
  });
  assert.equal(cited.status, 201, cited.text);
  const citation = cited.json.citation;
  const expectedText = ARTICLE.slice(hit.charStart, hit.charEnd);

  const readBack = async () => {
    const res = await call("GET", `${base}/citations/${citation.id}/resolve`);
    assert.equal(res.status, 200, res.text);
    assert.equal(res.json.verification.status, "verified");
    assert.equal(res.json.verification.recomputedSha256, imported.version.contentSha256);
    assert.equal(res.json.paragraph.text, expectedText);
    assert.equal(res.json.paragraph.chunkSha256, hit.chunkSha256);
  };
  await readBack();

  // 委托 A 获授权后切云端并重建
  await putSettings(plane, { provider: "cloud", cloudEngagements: ["eng-a"] });
  await rebuildOf(plane, "eng-a");
  await plane.knowledge.index.idle();
  const cloudIndex = (await indexOf(plane, "eng-a")).json.index;
  assert.equal(cloudIndex.state, "ready");
  assert.equal(cloudIndex.modelDim, 12);
  await readBack();

  // 再切回本地并重建
  await putSettings(plane, { provider: "local" });
  await rebuildOf(plane, "eng-a");
  await plane.knowledge.index.idle();
  assert.equal((await indexOf(plane, "eng-a")).json.index.modelDim, 8);
  await readBack();

  const versions = (await call("GET", `${plane.url}/knowledge/materials/${imported.material.id}?engagementId=eng-a`)).json;
  assert.equal(versions.material.versionCount, 1);
  assert.equal(versions.versions[0].contentSha256, sha256(ARTICLE));
  const exported = await call("GET", `${base}/report-export?snapshot=paragraph`);
  assert.equal(Buffer.from(exported.json.citations[0].snapshot.bytesBase64, "base64").toString("utf8"), expectedText);
  assert.equal(exported.json.citations[0].snapshot.sha256, hit.chunkSha256);
  assert.equal(task.engagementId, "eng-a");
});

test("切换过程中迟到的响应不写入新指纹的索引", async (t) => {
  const local = await startStub(t, { dim: 8, offset: 0 });
  const { root, plane } = await fixture(t, { local });
  await importMaterial(plane, { scope: { kind: "shared" } });
  await plane.knowledge.index.idle();

  // 让本地服务慢响应，然后在途换模型：旧响应回来时指纹已经变了
  local.options.delayMs = 400;
  await putSettings(plane, { local: { model: "slow-model" } });
  await rebuildOf(plane);
  await new Promise((resolve) => setTimeout(resolve, 60));
  await putSettings(plane, { local: { model: "switched-model" } });
  await new Promise((resolve) => setTimeout(resolve, 700));

  const db = new DatabaseSync(join(root, "knowledge.sqlite"));
  const keys = (db.prepare(`SELECT DISTINCT index_key FROM chunk_embeddings`).all() as Array<{ index_key: string }>)
    .map((row) => row.index_key);
  db.close();
  assert.ok(keys.every((key) => !key.includes("switched-model")),
    `迟到响应不得写进新指纹，实际 ${JSON.stringify(keys)}`);
  assert.ok(keys.every((key) => !key.includes("slow-model")),
    `被打断的那一轮也不该留下半截向量，实际 ${JSON.stringify(keys)}`);
});

test("升级迁移：旧的扁平配置搬进本地服务，云端保持未配置", async (t) => {
  const local = await startStub(t, { dim: 8, offset: 0 });
  const root = mkdtempSync(join(tmpdir(), "gy-knowledge-legacy-"));
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, "settings.json"), JSON.stringify({
    knowledgeEmbedding: {
      enabled: true, baseUrl: `${local.url}/`, model: "legacy-model",
      apiKeyEnv: LOCAL_KEY_ENV, apiKey: "legacy-secret", batchSize: 4, timeoutMs: 9_000,
    },
  }), "utf8");
  process.env[LOCAL_KEY_ENV] = LOCAL_KEY;
  const plane = await bootControlPlane({
    dataRoot: root, host: "127.0.0.1", port: 0, runtime: "local", isolated: true, watchdogMs: 60_000,
  });
  t.after(async () => { await plane.close(); rmSync(root, { recursive: true, force: true }); });

  const view = (await call("GET", `${plane.url}/settings`)).json.knowledgeEmbedding;
  assert.equal(view.provider, "local");
  assert.equal(view.local.baseUrl, `${local.url}/`);
  assert.equal(view.local.model, "legacy-model");
  assert.equal(view.local.apiKeyEnv, LOCAL_KEY_ENV);
  assert.equal(view.local.batchSize, 4);
  assert.equal(view.local.timeoutMs, 9_000);
  assert.equal(view.local.apiKeyConfigured, true);
  assert.equal(view.cloud.baseUrl, "");
  assert.equal(view.cloud.model, "");
  assert.deepEqual(view.cloudEngagements, []);

  // 旧配置照常工作，指纹用规范化后的地址（尾斜杠不产生第二套索引）
  await importMaterial(plane);
  await plane.knowledge.index.idle();
  const status = (await indexOf(plane, "eng-a")).json.index;
  assert.equal(status.state, "ready");
  assert.equal(status.model, "legacy-model");
  assert.equal(status.provider, local.url);
  assert.deepEqual([...new Set(local.keys())], [`Bearer ${LOCAL_KEY}`]);
});
test("慢响应服务 + 页面轮询并发：只点一次重试即到 ready，探测结果不被轮询作废", async (t) => {
  const local = await startStub(t, { dim: 8, offset: 0 });
  local.options.delayMs = 400; // 探测与每个正文批次都慢
  const { plane } = await fixture(t, { local });
  const imported = await importMaterial(plane);
  await plane.knowledge.index.idle(30_000);
  assert.equal((await indexOf(plane, "eng-a")).json.index.state, "ready");

  // 页面停用并保存，再重新启用同一模型
  await putSettings(plane, { enabled: false });
  await putSettings(plane, { enabled: true });

  const retry = await retryOf(plane, "eng-a");
  assert.equal(retry.status, 202, retry.text);
  assert.deepEqual(retry.json.queued, [imported.version.id], "慢服务 + 轮询下重试必须真的入队");

  // 页面持续轮询进度，与在途的探测/正文请求并发
  const polls: Array<{ state: string; indexed: number; dim: number | null }> = [];
  const poller = (async () => {
    for (let i = 0; i < 10; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 80));
      const r = await indexOf(plane, "eng-a");
      polls.push({ state: r.json.index.state, indexed: r.json.index.indexedChunks, dim: r.json.index.modelDim });
    }
  })();
  await plane.knowledge.index.idle(30_000);
  await poller;
  assert.ok(polls.length >= 8, "轮询确实与向量化并发进行");
  assert.ok(polls.some((p) => p.state === "indexing" || p.state === "pending"), "轮询见过渡态");
  const final = (await indexOf(plane, "eng-a")).json.index;
  assert.equal(final.state, "ready", `一次重试即就绪，实际 ${JSON.stringify(polls)}`);
  assert.equal(final.modelDim, 8);
  assert.equal(final.indexedChunks, imported.sections.length);

  // 空队列重试：如实返回无事可做
  const noop = await retryOf(plane, "eng-a");
  assert.equal(noop.status, 202, noop.text);
  assert.deepEqual(noop.json.queued, []);
  assert.equal(noop.json.status.state, "ready");
});

test("首批在途时撤销委托云端授权：未发送批次零次外发、在途结果不落库，共享与仍授权委托继续", async (t) => {
  const local = await startStub(t, { dim: 8, offset: 0 });
  const cloud = await startStub(t, { dim: 12, offset: 4 });
  cloud.options.delayMs = 300;
  const { root, plane } = await fixture(t, {
    local, cloud, provider: "cloud", cloudEngagements: ["eng-a", "eng-b"], cloudBatchSize: 2,
  });

  // A 的多片段资料先进队列（多批，正文带专属标记），共享与 B 随后
  const own = await importMaterial(plane, {
    title: "委托A专属交接", sourceUrl: "https://example.invalid/a-marked",
    content: ["## 交接记录", "", "06:14 换任，继任者读 STATE 续接进度。", "", "## 值班表", "",
      "负责人换班按 STATE 交接，gy-a-marker-2。", "", "## 备注", "",
      "交接完成后更新进度，gy-a-marker-3。", "", "## 附注", "", "换任凭据登记在 STATE，gy-a-marker-4。"].join("\n"),
  });
  const shared = await importMaterial(plane, { title: "共享运行分析", scope: { kind: "shared" } });
  const engB = await importMaterial(plane, {
    title: "委托B专属交接", sourceUrl: "https://example.invalid/b",
    content: "## 交接记录\n\n06:14 换任，继任者读 STATE 续接进度。",
    scope: { kind: "engagement", engagementId: "eng-b" },
  });

  // 等云端收到「探测 + A 首批」两次调用后撤权：首批已在途，其余批次尚未发送
  await waitFor(() => cloud.calls() >= 2);
  const inFlightInputs = cloud.inputs().length;
  assert.ok(inFlightInputs >= 3, "探测短句 + A 的首批正文确实已发出");
  await putSettings(plane, { cloudEngagements: ["eng-b"] });
  cloud.reset();
  await plane.knowledge.index.idle(60_000);

  // 撤权后：A 未发送批次零次外发；共享与 B 的正文继续由云端处理
  assert.ok(!cloud.inputs().some((text) => text.includes("gy-a-marker")),
    "A 尚未发送的正文不得再发云端");
  assert.ok(cloud.calls() > 0, "共享与仍获授权的委托照常发云端");
  assert.ok(cloud.keys().every((k) => k === `Bearer ${CLOUD_KEY}`));
  // 在途批次返回的结果不得写入撤权后已非当前有效的云端索引
  const db = new DatabaseSync(join(root, "knowledge.sqlite"));
  const ownRows = (db.prepare(
    `SELECT COUNT(*) AS n FROM chunk_embeddings WHERE version_id = ?`,
  ).get(own.version.id) as { n: number }).n;
  db.close();
  assert.equal(ownRows, 0, "在途结果不得写入撤权后的索引");
  const idxShared = (await indexOf(plane)).json.index;
  assert.equal(idxShared.state, "ready", "共享资料照常由云端索引完成");
  const idxB = (await indexOf(plane, "eng-b")).json.index;
  assert.equal(idxB.services.find((s: any) => s.provider === "cloud").indexedChunks,
    shared.sections.length + engB.sections.length, "共享 + B 的片段都已在云端");

  // A 的资料回本地：重试后由本地补齐，云端不再收到任何 A 的正文或查询
  cloud.reset();
  const retryA = await retryOf(plane, "eng-a");
  assert.deepEqual(retryA.json.queued, [own.version.id]);
  await plane.knowledge.index.idle(30_000);
  assert.equal(cloud.calls(), 0, "重试补索引也不得发云端");
  const idxA = (await indexOf(plane, "eng-a")).json.index;
  assert.equal(idxA.state, "ready");
  assert.equal(idxA.providerKind, "local");
  assert.equal(idxA.modelDim, 8);
  const searchA = await searchOf(plane, "负责人换班", "eng-a");
  assert.ok(searchA.json.recall.semantic > 0, "A 靠本地向量召回");
  assert.equal(cloud.calls(), 0, "A 的查询文本也不得发云端");
});

test("探测维度与正文维度不一致：整批不落库不显示就绪，恢复后重试回到真实 ready", async (t) => {
  const local = await startStub(t, { dim: 12, offset: 0 });
  local.options.dims = [12, 3]; // 探测 12 维，正文实际 3 维
  const { root, plane } = await fixture(t, { local });
  const imported = await importMaterial(plane);
  await plane.knowledge.index.idle(20_000);

  const broken = (await indexOf(plane, "eng-a")).json.index;
  assert.ok(["unavailable", "error"].includes(broken.state), broken.state);
  assert.equal(broken.indexedChunks, 0, "维度不符的批次不得计为已索引");
  assert.equal(broken.modelDim, null, "缓存维度必须作废");
  assert.ok(broken.lastError.includes("维度"), broken.lastError);
  const db = new DatabaseSync(join(root, "knowledge.sqlite"));
  const rows = (db.prepare(
    `SELECT COUNT(*) AS n FROM chunk_embeddings WHERE version_id = ?`,
  ).get(imported.version.id) as { n: number }).n;
  db.close();
  assert.equal(rows, 0, "维度不符的批次不得落库");

  // 服务恢复为一致的 3 维后，页面点重试：重新探测并落库真实维度
  local.options.dims = [3];
  const retry = await retryOf(plane, "eng-a");
  assert.deepEqual(retry.json.queued, [imported.version.id]);
  await plane.knowledge.index.idle(20_000);
  const recovered = (await indexOf(plane, "eng-a")).json.index;
  assert.equal(recovered.state, "ready");
  assert.equal(recovered.modelDim, 3, "恢复后按实测维度报告");
  assert.equal(recovered.indexedChunks, imported.sections.length);
  const db2 = new DatabaseSync(join(root, "knowledge.sqlite"));
  const dims = (db2.prepare(
    `SELECT DISTINCT dim FROM chunk_embeddings WHERE version_id = ?`,
  ).all(imported.version.id) as Array<{ dim: number }>).map((r) => r.dim);
  db2.close();
  assert.deepEqual(dims, [3], "落库向量为实测 3 维");
  const search = await searchOf(plane, "负责人换班", "eng-a");
  assert.ok(search.json.recall.semantic > 0, "语义检索照常可用");
});

test("云端地址换来源不继承旧密钥与环境变量；同来源留空/掩码保号；切回不复活", async (t) => {
  const local = await startStub(t, { dim: 8, offset: 0 });
  const cloudA = await startStub(t, { dim: 12, offset: 4 });
  const cloudB = await startStub(t, { dim: 16, offset: 8 });
  const { plane } = await fixture(t, { local });
  const ENV_A = "GY_TEST_CLOUD_A_KEY";
  process.env[ENV_A] = "env-key-a";
  t.after(() => { delete process.env[ENV_A]; });

  const service = (baseUrl: string, apiKey: string, apiKeyEnv = "") =>
    ({ baseUrl, model: "same-model-id", apiKeyEnv, apiKey, batchSize: 8, timeoutMs: 5_000 });
  const testConn = (body?: unknown) =>
    call("POST", `${plane.url}/settings/knowledge-embedding/test`, body);

  // 1. 保存 A 并登记密钥
  await putSettings(plane, { cloud: service(cloudA.url, CLOUD_KEY) });

  // 2. 草稿「测试连接」直接指向 B（密钥留空）：B 不得带 A 的密钥
  const draftTest = await testConn({ provider: "cloud", service: service(cloudB.url, "") });
  assert.equal(draftTest.json.ok, true, draftTest.text);
  assert.deepEqual(cloudB.keys(), [""], "草稿测试不同来源不得继承旧密钥");
  assert.equal(cloudA.calls(), 0);

  // 3. 保存 B（密钥留空、环境变量也留空，与页面草稿一致）：直接保存也不继承
  const savedB = await putSettings(plane, { cloud: service(cloudB.url, "", "") });
  assert.equal(savedB.json.knowledgeEmbedding.cloud.apiKeyConfigured, false);
  assert.equal(savedB.json.knowledgeEmbedding.cloud.apiKeyEnv, "");

  // 4. 刷新后用已存配置测试连接：B 仍然空手
  const refreshed = (await call("GET", `${plane.url}/settings`)).json.knowledgeEmbedding;
  assert.equal(refreshed.cloud.apiKeyConfigured, false);
  const savedTest = await testConn({ provider: "cloud" });
  assert.equal(savedTest.json.ok, true, savedTest.text);
  assert.deepEqual(cloudB.keys().slice(-1), [""], "已存配置发不同来源也不得带旧凭据");

  // 5. 切回 A（留空）：B 的保存已清掉旧密钥，切回不会复活
  const backA = await putSettings(plane, { cloud: service(cloudA.url, "") });
  assert.equal(backA.json.knowledgeEmbedding.cloud.apiKeyConfigured, false, "切回不复活旧密钥");
  const testA = await testConn({ provider: "cloud" });
  assert.deepEqual(cloudA.keys().slice(-1), [""], "切回 A 也不得带 B/A 旧凭据");

  // 6. 同一来源：改路径留空保存沿用已存密钥，掩码回传同样保号
  await putSettings(plane, { cloud: service(`${cloudA.url}/v1`, CLOUD_KEY) });
  const keptBlank = await putSettings(plane, { cloud: service(`${cloudA.url}/v2`, "") });
  assert.equal(keptBlank.json.knowledgeEmbedding.cloud.apiKeyConfigured, true, "同来源留空保号");
  const keptMasked = await putSettings(plane, { cloud: service(`${cloudA.url}/v2`, "••••••••") });
  assert.equal(keptMasked.json.knowledgeEmbedding.cloud.apiKeyConfigured, true, "同来源掩码回传保号");
  cloudA.reset();
  const keepTest = await testConn({ provider: "cloud" });
  assert.equal(keepTest.json.ok, true, keepTest.text);
  assert.deepEqual(cloudA.keys(), [`Bearer ${CLOUD_KEY}`], "同来源继续沿用已存密钥");

  // 7. 环境变量密钥也不跨来源：A 用 ENV_A 保存后切 B（沿用该名），B 空手
  await putSettings(plane, { cloud: service(cloudA.url, "", ENV_A) });
  const envView = (await call("GET", `${plane.url}/settings`)).json.knowledgeEmbedding;
  assert.equal(envView.cloud.apiKeyEnv, ENV_A);
  const envTest = await testConn({ provider: "cloud" });
  assert.equal(envTest.json.ok, true, envTest.text);
  assert.ok(cloudA.keys().at(-1)?.startsWith("Bearer "), "A 用环境变量密钥正常");
  await putSettings(plane, { cloud: service(cloudB.url, "", ENV_A) });
  const envSwitched = await testConn({ provider: "cloud" });
  assert.equal(envSwitched.json.ok, true, envSwitched.text);
  assert.deepEqual(cloudB.keys().slice(-1), [""], "环境变量密钥不得带去不同来源");

  // 公开视图全程无明文密钥
  const finalView = (await call("GET", `${plane.url}/settings`)).json.knowledgeEmbedding;
  assert.ok(!JSON.stringify(finalView).includes(CLOUD_KEY));
  assert.ok(!JSON.stringify(finalView).includes("env-key-a"));
  assert.ok(!JSON.stringify(finalView).includes("••••"));
});

test("失败冷却结束后队列自动恢复：冷却停排不打死后续版本", async (t) => {
  const stub = await startStub(t, { dim: 8, offset: 0 });
  stub.options.fail = true;
  const db = new DatabaseSync(":memory:");
  const section = (ordinal: number): KnowledgeSection => ({
    ordinal, locator: `¶${ordinal}`, heading: null, page: null, text: `内容 ${ordinal}`,
    charStart: ordinal * 4, charEnd: ordinal * 4 + 4, headingPath: [], parentLocator: `¶${ordinal}`,
    chunkSha256: sha256(`内容 ${ordinal}`), chunkIndex: 0, chunkCount: 1,
    lineStart: 1, lineEnd: 1, pageBasis: null,
  });
  const mkRuntime = (): EmbeddingRuntime => ({
    provider: "local", enabled: true, baseUrl: stub.url, model: "m", apiKey: null, batchSize: 4, timeoutMs: 2_000,
  });
  const index = new KnowledgeIndex(
    { db, sectionsOf: (versionId) => (versionId === "v1" ? [section(0)] : [section(1)]) },
    new EmbeddingClient(mkRuntime()), 1, () => true, 250,
  );
  t.after(() => index.dispose());

  index.enqueue("v1");
  index.enqueue("v2");
  await new Promise((resolve) => setTimeout(resolve, 150));
  // v1 失败进入冷却：v2 不得在冷却期内被处理，但也不能永远停摆
  assert.equal(index.versionState("v1").state, "unavailable");
  assert.equal(index.versionState("v2").state, "pending", "冷却期内 v2 不应被执行");

  stub.options.fail = false;
  await index.idle(10_000);
  assert.equal(index.versionState("v2").state, "ready", "冷却结束后无需新触发，v2 自动完成");
  // 服务恢复后 v1 靠重试补齐（既有语义不变）
  const queued = index.retry(["v1", "v2"]);
  assert.deepEqual(queued, ["v1"]);
  await index.idle(10_000);
  assert.equal(index.versionState("v1").state, "ready");
  db.close();
});

test("部分补丁只覆盖给出的字段：只改超时或委托不清空地址与模型", async (t) => {
  const local = await startStub(t, { dim: 8, offset: 0 });
  const cloud = await startStub(t, { dim: 12, offset: 4 });
  const { plane } = await fixture(t, { local, cloud });
  await putSettings(plane, {
    cloud: { baseUrl: cloud.url, model: "same-model-id", apiKeyEnv: "", apiKey: CLOUD_KEY, batchSize: 2, timeoutMs: 5_000 },
  });
  // 只补丁超时：其余字段必须原样保留（zod 默认值不得覆盖已存配置）
  const timeoutOnly = await putSettings(plane, { cloud: { timeoutMs: 120_000 } });
  const c1 = timeoutOnly.json.knowledgeEmbedding.cloud;
  assert.equal(c1.baseUrl, cloud.url, "只改超时不得清空地址");
  assert.equal(c1.model, "same-model-id", "只改超时不得清空模型");
  assert.equal(c1.batchSize, 2);
  assert.equal(c1.timeoutMs, 120_000);
  assert.equal(c1.apiKeyConfigured, true, "只改超时不得清空密钥");
  // 只补丁委托授权：服务配置不动
  const engagementsOnly = await putSettings(plane, { cloudEngagements: ["eng-a"] });
  const c2 = engagementsOnly.json.knowledgeEmbedding.cloud;
  assert.equal(c2.baseUrl, cloud.url);
  assert.equal(c2.model, "same-model-id");
  assert.equal(c2.batchSize, 2);
  assert.equal(c2.timeoutMs, 120_000);
  assert.equal(c2.apiKeyConfigured, true);
});

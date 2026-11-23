/**
 * 「参考资料 → 向量化设置」的真实页面验收台。
 *
 * 起一个**真实控制面**（隔离数据根）+ 两个可观测的本机 OpenAI 兼容 embedding 服务，
 * 播种合成资料与 A/B 两个委托，然后保持运行，供浏览器操作真实控制台页面。
 * 每个 embedding 请求都写进 JSONL，用来核对「哪些范围真的发生了调用」。
 *
 * 用法：
 *   node --import tsx scripts/knowledge-provider-console.ts --local=stub
 *   OMLX_API_KEY=$(cat ~/.omlx/api-key) node --import tsx scripts/knowledge-provider-console.ts --local=omlx
 *
 * 数据根与证据都在 out/knowledge-provider-console-<runId>/，不触碰正式 .gongyuai。
 * 收到 SIGINT/SIGTERM 后落盘 session-summary.json 再退出。
 */
import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { CreateTaskRequestSchema } from "@gongyuai/contracts";
import { openHistory } from "@gongyuai/history";
import { bootControlPlane, taskPaths } from "../packages/control-plane/src/index.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sha256 = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const runId = String(Date.now());
const outDir = join(repoRoot, "out", `knowledge-provider-console-${runId}`);
const dataRoot = join(outDir, "data");
mkdirSync(dataRoot, { recursive: true });

const localMode = process.argv.find((a) => a.startsWith("--local="))?.slice(8) ?? "stub";
const PLANE_PORT = Number(process.env.GY_ACCEPT_PLANE_PORT ?? 8879);
const CONSOLE_PORT = Number(process.env.GY_ACCEPT_CONSOLE_PORT ?? 5174);
const LOCAL_STUB_PORT = 8898;
const CLOUD_STUB_PORT = 8899;

const CONCEPTS: Array<{ dim: number; words: string[] }> = [
  { dim: 0, words: ["换班", "换任", "交接", "handover", "commander", "负责人"] },
  { dim: 1, words: ["续上", "继续", "续接", "state", "resume", "progress", "进度"] },
  { dim: 2, words: ["更正", "回函", "correction", "凭据"] },
];

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

type StubHandle = { url: string; logPath: string; stop: () => Promise<void>; setFail: (fail: boolean) => void };

/** 可观测的本机兼容测试服务：逐请求记录模型、Authorization、输入文本与返回维度。 */
async function startStub(name: string, port: number, spec: { dim: number; offset: number }): Promise<StubHandle> {
  const logPath = join(outDir, `${name}-calls.jsonl`);
  writeFileSync(logPath, "", "utf8");
  let fail = false;
  let seq = 0;
  const server: Server = createServer((req, res) => {
    if (req.method !== "POST" || !req.url?.endsWith("/embeddings")) {
      res.writeHead(404).end("{}");
      return;
    }
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { model?: string; input?: string[] };
      const input = body.input ?? [];
      seq += 1;
      appendFileSync(logPath, `${JSON.stringify({
        seq, at: new Date().toISOString(), service: name, model: body.model,
        credentialPresent: Boolean(req.headers.authorization),
        credentialMatchesFixture: req.headers.authorization === `Bearer ${name}-stub-key`,
        inputs: input, fail,
      })}\n`, "utf8");
      if (fail) {
        res.writeHead(503, { "content-type": "application/json" })
          .end(JSON.stringify({ error: { message: `${name} stub temporarily unavailable` } }));
        return;
      }
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({
        model: body.model,
        data: input.map((text, index) => ({ index, embedding: conceptVector(text, spec.dim, spec.offset) })),
      }));
    });
  });
  await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
  return {
    url: `http://127.0.0.1:${port}/v1`,
    logPath,
    setFail: (value) => { fail = value; },
    stop: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

const SHARED_ARTICLE = [
  "# 团队共享运行分析",
  "",
  "## 6. 架构设计",
  "",
  "### 6.4 状态与连续性",
  "",
  "| 机制 | 实现 | 观测证据 |",
  "|---|---|---|",
  "| Commander 交接 | commander-state.md | 2 任 commander，06:14 换任，靠 STATE 续接 |",
  "",
  "换任通过读 STATE 文件继续。",
  "",
  "### 6.5 自我修复",
  "",
  "agent 改了自己的工具。",
].join("\n");

const ENG_A_ARTICLE = [
  "# 委托A专属交接记录",
  "",
  "## 现场交接",
  "",
  "06:14 换任，继任者读 STATE 文件续接进度。R-017 要求把更正回函并入既有证据链。",
].join("\n");

const ENG_B_ARTICLE = [
  "# 委托B专属交接记录",
  "",
  "## 现场交接",
  "",
  "07:20 换班，下一任读 STATE 继续未完成的进度核对。",
].join("\n");

async function main() {
  const localStub = localMode === "stub" ? await startStub("local", LOCAL_STUB_PORT, { dim: 8, offset: 0 }) : null;
  const cloudStub = await startStub("cloud", CLOUD_STUB_PORT, { dim: 12, offset: 4 });
  const omlxKey = process.env.OMLX_API_KEY?.trim() ?? "";
  const localUrl = localStub ? localStub.url : "http://127.0.0.1:8000/v1";
  const localModel = localStub ? "stub-local-8dim" : "bge-m3-mlx-4bit";

  const plane = await bootControlPlane({
    dataRoot, host: "127.0.0.1", port: PLANE_PORT, runtime: "local", isolated: true, watchdogMs: 60_000,
    knowledgeEmbedding: {
      enabled: true,
      provider: "local",
      cloudEngagements: [],
      local: {
        baseUrl: localUrl, model: localModel,
        apiKeyEnv: localStub ? "" : "OMLX_API_KEY",
        apiKey: localStub ? "local-stub-key" : "",
        batchSize: 16, timeoutMs: 120_000,
      },
      cloud: {
        baseUrl: cloudStub.url, model: "stub-cloud-12dim",
        apiKeyEnv: "", apiKey: "cloud-stub-key",
        batchSize: 16, timeoutMs: 30_000,
      },
    },
  });

  const makeTask = (engagementId: string, name: string) => {
    const task = plane.store.createTask(CreateTaskRequestSchema.parse({
      name, engagementId,
      auth: { targets: ["knowledge-console.invalid"], authorizationNote: "合成材料，仅用于页面验收" },
      goals: [{ id: "g1", title: "参考资料验收", description: "服务切换与重试", evidencePatterns: ["knowledge/*.json"] }],
      mock: true,
    }));
    const paths = taskPaths(task.dataDir);
    const history = openHistory({ dbPath: paths.historyDb, evidenceDir: paths.evidenceDir });
    history.seedGoals(task.id, task.goals);
    history.close();
    plane.store.finishTask(task, "completed", null);
    return task;
  };
  const taskA = makeTask("eng-a", "委托A 资料验收");
  const taskB = makeTask("eng-b", "委托B 资料验收");

  const importMaterial = async (body: Record<string, unknown>) => {
    const res = await fetch(`${plane.url}/knowledge/materials`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
    });
    const json = await res.json() as any;
    if (res.status !== 201) throw new Error(`导入失败 ${res.status}: ${JSON.stringify(json)}`);
    return json;
  };
  const shared = await importMaterial({
    title: "团队共享运行分析", publisher: "验收合成材料", sourceKind: "original", format: "markdown",
    sourceUrl: "https://example.invalid/shared", content: SHARED_ARTICLE, tags: [], scope: { kind: "shared" },
  });
  const own = await importMaterial({
    title: "委托A专属交接记录", publisher: "验收合成材料", sourceKind: "original", format: "markdown",
    sourceUrl: "https://example.invalid/eng-a", content: ENG_A_ARTICLE, tags: [],
    scope: { kind: "engagement", engagementId: "eng-a" },
  });
  const secret = await importMaterial({
    title: "委托B专属交接记录", publisher: "验收合成材料", sourceKind: "original", format: "markdown",
    sourceUrl: "https://example.invalid/eng-b", content: ENG_B_ARTICLE, tags: [],
    scope: { kind: "engagement", engagementId: "eng-b" },
  });
  // 新契约：导入只登记待向量化。这里显式「开始向量化」各委托范围内的版本再等队列空闲。
  for (const engagementId of ["eng-a", "eng-b"]) {
    await fetch(`${plane.url}/knowledge/index/retry?engagementId=${engagementId}`, {
      method: "POST", headers: { "content-type": "application/json" }, body: "{}",
    });
  }
  await plane.knowledge.index.idle(300_000);

  const session = {
    runId, outDir, dataRoot, localMode,
    planeUrl: plane.url,
    consoleUrl: `http://127.0.0.1:${CONSOLE_PORT}/#/knowledge`,
    localService: { baseUrl: localUrl, model: localModel, kind: localStub ? "本机兼容测试服务" : "真实本机模型（oMLX）" },
    cloudService: { baseUrl: cloudStub.url, model: "stub-cloud-12dim", kind: "本机兼容测试服务（云端替身）" },
    callLogs: { local: localStub?.logPath ?? null, cloud: cloudStub.logPath },
    engagements: { a: "eng-a", b: "eng-b" },
    tasks: { a: taskA.id, b: taskB.id },
    materials: {
      shared: { id: shared.material.id, versionId: shared.version.id, chunks: shared.sections.length, contentSha256: shared.version.contentSha256 },
      a: { id: own.material.id, versionId: own.version.id, chunks: own.sections.length, contentSha256: own.version.contentSha256 },
      b: { id: secret.material.id, versionId: secret.version.id, chunks: secret.sections.length, contentSha256: secret.version.contentSha256 },
    },
    articles: {
      shared: { sha256: sha256(SHARED_ARTICLE), text: SHARED_ARTICLE },
      a: { sha256: sha256(ENG_A_ARTICLE), text: ENG_A_ARTICLE },
      b: { sha256: sha256(ENG_B_ARTICLE), text: ENG_B_ARTICLE },
    },
    stubControl: { failCloudPath: join(outDir, "cloud-fail"), failLocalPath: join(outDir, "local-fail") },
  };
  writeFileSync(join(outDir, "session.json"), JSON.stringify(session, null, 2), "utf8");
  console.log(JSON.stringify(session, null, 2));
  console.log("\n验收台已就绪。控制面保持运行，浏览器打开 consoleUrl 操作真实页面。");
  console.log(`切换服务可用性：touch ${session.stubControl.failCloudPath} / rm 该文件恢复。\n`);

  // 用文件开关模拟服务暂时不可用，便于从页面复现「恢复后仅靠重试成功」
  const { existsSync } = await import("node:fs");
  const watcher = setInterval(() => {
    cloudStub.setFail(existsSync(session.stubControl.failCloudPath));
    localStub?.setFail(existsSync(session.stubControl.failLocalPath));
  }, 300);
  watcher.unref();

  const shutdown = async () => {
    clearInterval(watcher);
    const index = await fetch(`${plane.url}/knowledge/index`).then((r) => r.json()).catch(() => null);
    writeFileSync(join(outDir, "session-summary.json"), JSON.stringify({
      runId, closedAt: new Date().toISOString(), sharedScopeIndex: index,
    }, null, 2), "utf8");
    await plane.close();
    await cloudStub.stop();
    await localStub?.stop();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
  setInterval(() => {}, 1 << 30);
}

void main();
/**
 * 整篇 Markdown 导入 + 关键词/向量混合检索的后端验收。
 *
 * 用法：
 *   OMLX_API_KEY=$(cat ~/.omlx/api-key) pnpm knowledge:hybrid-acceptance
 *
 * 与首版验收的区别：
 *  - 导入**整篇**原文（女娲 README、SapperLens README、六批交接实验、R-017 所在全文），
 *    不再喂预先裁好的摘录；
 *  - **不挂与测试查询同词的人工标签**，语义召回必须靠正文；
 *  - 先标注每条查询的目标原文段落，再用同一批文档对比关键词与混合的 Top 5；
 *  - 向量化用**本机真实模型**（oMLX 上的中英多语 embedding），不可用时如实记为缺项；
 *  - 单独验收 PDF 物理页码回归，以及升级前旧引用的回读一致性。
 *
 * 数据根隔离在 out/knowledge-hybrid-<runId>/，不触碰正式 .gongyuai。
 * 证据写入 docs/evidence/knowledge-library/<runId>/。
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { CreateTaskRequestSchema } from "@gongyuai/contracts";
import { openHistory } from "@gongyuai/history";
import { bootControlPlane, taskPaths } from "../packages/control-plane/src/index.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sha256 = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");

type Step = { id: string; title: string; passed: boolean; detail: string; evidence?: unknown };
const steps: Step[] = [];
function record(id: string, title: string, passed: boolean, detail: string, evidence?: unknown) {
  steps.push({ id, title, passed, detail, ...(evidence === undefined ? {} : { evidence }) });
  console.log(`${passed ? "PASS" : "FAIL"}  ${id}  ${title}\n      ${detail}`);
}

async function call(base: string, method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(base + path, {
    method,
    headers: { ...(body === undefined ? {} : { "content-type": "application/json" }), ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch { /* markdown */ }
  return { status: res.status, text, json };
}

function gitHead(url: string, ref: string): string | null {
  const out = spawnSync("git", ["ls-remote", url, ref], { encoding: "utf8", timeout: 40_000 });
  const sha = out.stdout?.trim().split(/\s+/)[0];
  return sha && /^[a-f0-9]{40}$/.test(sha) ? sha : null;
}

async function fetchText(url: string): Promise<string | null> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(60_000) });
    return res.ok ? await res.text() : null;
  } catch {
    return null;
  }
}

/** 独立于被测代码的物理页数：直接数页面对象树里的 /Type /Page，并读根 /Count。 */
function independentPageCount(bytes: Buffer): { count: number | null; declared: number | null } {
  const latin = bytes.toString("latin1");
  const direct = (latin.match(/\/Type\s*\/Page\b(?!s)/g) ?? []).length;
  const counts = [...latin.matchAll(/\/Count\s+(\d+)/g)].map((m) => Number(m[1]));
  const declared = counts.length ? Math.max(...counts) : null;
  return { count: direct > 0 ? direct : null, declared };
}

// ---------------------------------------------------------------------------
// 查询与目标段落：先标注，再对比。target 是**父章节定位**，即原文里的段落归属。
// ---------------------------------------------------------------------------
type QuerySpec = {
  id: string;
  query: string;
  kind: "semantic" | "exact";
  /** 期望命中的资料键 → 父章节定位。 */
  targets: Record<string, string>;
  rationale: string;
};

const QUERIES: QuerySpec[] = [
  {
    id: "Q1", query: "负责人换班", kind: "semantic",
    targets: { sapperlens: "§6.4", nvwabase: "§2", ledger: "§六批、五次交接" },
    rationale: "三份原文都不含「负责人换班」整词：SapperLens 写「换任」「Commander 交接」，女娲 README 是英文 successor takes over mid-campaign，实验写「每个边界换班」。目标段落分别是 §6.4 状态与连续性、§2 The Three-Capability Foundation、§六批、五次交接。",
  },
  {
    id: "Q2", query: "接任指挥后怎样续上进度", kind: "semantic",
    targets: { sapperlens: "§6.4", nvwabase: "§2" },
    rationale: "SapperLens §6.4 明确写「下一任指挥官读取该文件，接着调度」「换任通过读 STATE 文件继续」；女娲 §2 写继任者读图接手。两处都是同义表达，不是字面命中。",
  },
  {
    id: "Q3", query: "R-017", kind: "exact",
    targets: { r017: "§报告交付后收到更正凭据" },
    rationale: "R-017 用例在 docs/absorb-super-agent.md 的「报告交付后收到更正凭据」一节，字面含 R-017。",
  },
  {
    id: "Q4", query: "54/60", kind: "exact",
    targets: { ledger: "§六批、五次交接" },
    rationale: "54/60 是六批实验的正确字段数，结果表在「六批、五次交接」一节。前言与「准确率差在哪里」也字面含该值，一并记录名次。",
  },
  {
    id: "Q5", query: "§6.4", kind: "exact",
    targets: { sapperlens: "§6.4" },
    rationale: "章节地址查询。SapperLens 原文正文并不写「§6.4」这个字面，因此按定位精确命中，如实标为 locator 命中而非正文字面命中。",
  },
  {
    id: "Q6", query: "换任", kind: "exact",
    targets: { sapperlens: "§6.4" },
    rationale: "上一轮的问题查询：字面「换任」在多处出现，首条却是 §0。目标段落是 §6.4 状态与连续性。",
  },
];

type RankedHit = {
  rank: number; title: string; locator: string; parentLocator: string;
  retrieval: string; matchedFields: string[]; score: number;
  keywordScore: number; semanticScore: number | null; headingPath: string[];
};

function topHits(json: any, n = 5): RankedHit[] {
  return (json?.hits ?? []).slice(0, n).map((h: any, i: number) => ({
    rank: i + 1, title: h.title, locator: h.locator, parentLocator: h.parentLocator,
    retrieval: h.retrieval, matchedFields: h.matchedFields, score: Number(h.score.toFixed(4)),
    keywordScore: Number(h.keywordScore.toFixed(4)),
    semanticScore: h.semanticScore === null ? null : Number(h.semanticScore.toFixed(4)),
    headingPath: h.headingPath,
  }));
}

/** 目标父章节在结果里的最好名次（未出现则 null）。 */
function rankOf(json: any, materialId: string | undefined, parentLocator: string): number | null {
  if (!materialId) return null;
  const index = (json?.hits ?? []).findIndex((h: any) =>
    h.materialId === materialId && h.parentLocator === parentLocator);
  return index === -1 ? null : index + 1;
}

// ---------------------------------------------------------------------------
// 断网 + 停用向量化的子进程：证明回读既不依赖上游，也不依赖 embedding 服务。
// ---------------------------------------------------------------------------
async function offlinePhase(dataRoot: string, statePath: string, outPath: string) {
  const { createRequire } = await import("node:module");
  for (const key of Object.keys(process.env)) {
    if (/proxy/i.test(key)) delete process.env[key];
  }
  process.env.NODE_USE_ENV_PROXY = "0";
  const loopback = (host: unknown) => {
    const value = String(host ?? "");
    return value === "127.0.0.1" || value === "localhost" || value === "::1" || value.startsWith("127.");
  };
  const offlineError = (kind: string, host: unknown) => new Error(`OFFLINE: 拒绝${kind} ${String(host)}`);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = ((input: unknown, init?: unknown) => {
    const raw = typeof input === "string" ? input : input instanceof URL ? input.href : (input as { url?: string })?.url;
    let host = "";
    try { host = new URL(String(raw)).hostname; } catch { /* 交给原实现报错 */ }
    if (!loopback(host)) return Promise.reject(offlineError("出站 fetch", host));
    return (originalFetch as (...a: unknown[]) => Promise<Response>)(input, init);
  }) as typeof fetch;
  const require = createRequire(import.meta.url);
  const tls = require("node:tls") as { connect: (...args: unknown[]) => unknown };
  const originalTlsConnect = tls.connect;
  tls.connect = function guardedTls(this: unknown, ...args: unknown[]) {
    const options = (typeof args[0] === "object" && args[0] !== null ? args[0] : {}) as { servername?: string; host?: string };
    if (!loopback(options.servername ?? options.host)) throw offlineError("出站 TLS", options.servername ?? options.host);
    return originalTlsConnect.apply(this, args);
  } as never;
  for (const name of ["node:http", "node:https"] as const) {
    const mod = require(name) as { request: (...args: unknown[]) => unknown; get: (...args: unknown[]) => unknown };
    for (const method of ["request", "get"] as const) {
      const original = mod[method];
      mod[method] = function guarded(this: unknown, ...args: unknown[]) {
        const options = (typeof args[0] === "object" && args[0] !== null ? args[0] : {}) as { host?: string; hostname?: string };
        const host = options.hostname ?? options.host;
        if (host !== undefined && !loopback(host)) throw offlineError("出站 HTTP", host);
        return original.apply(this, args);
      } as never;
    }
  }
  const dnsCjs = require("node:dns") as {
    lookup: (...args: unknown[]) => unknown; promises: { lookup: (...args: unknown[]) => unknown };
  };
  const originalLookup = dnsCjs.lookup;
  const originalPromiseLookup = dnsCjs.promises.lookup;
  dnsCjs.lookup = function guardedLookup(this: unknown, hostname: unknown, ...rest: unknown[]) {
    if (!loopback(hostname)) throw offlineError("DNS 解析", hostname);
    return originalLookup.call(this, hostname, ...rest);
  } as never;
  dnsCjs.promises.lookup = function guardedPromiseLookup(this: unknown, hostname: unknown, ...rest: unknown[]) {
    if (!loopback(hostname)) return Promise.reject(offlineError("DNS 解析", hostname));
    return originalPromiseLookup.call(this, hostname, ...rest);
  } as never;

  const state = JSON.parse(readFileSync(statePath, "utf8"));
  // 关掉向量化：证明定版回读连本地 embedding 服务都不需要。
  const plane = await bootControlPlane({
    dataRoot, host: "127.0.0.1", port: 0, runtime: "local", isolated: true, watchdogMs: 60_000,
    knowledgeEmbedding: { enabled: false },
  });
  const results: Step[] = [];
  const push = (id: string, title: string, passed: boolean, detail: string, evidence?: unknown) => {
    results.push({ id, title, passed, detail, ...(evidence === undefined ? {} : { evidence }) });
  };
  const evidenceDir = dirname(outPath);
  try {
    const base = plane.url;
    let outboundBlocked = false;
    let outboundError = "";
    try {
      await fetch("https://raw.githubusercontent.com/inwpu/SapperLens/main/README.md", { signal: AbortSignal.timeout(8_000) });
    } catch (err) {
      outboundBlocked = true;
      outboundError = err instanceof Error ? err.message : String(err);
    }
    push("8.0", "正对照：本阶段出站访问确实被拒，且向量化已停用", outboundBlocked,
      outboundBlocked ? `上游 fetch 失败：${outboundError.slice(0, 140)}` : "上游仍可访问，断网前提不成立");

    const resolved = await call(base, "GET", `/tasks/${state.taskId}/citations/${state.citationId}/resolve`);
    const v = resolved.json?.verification;
    const paragraph = resolved.json?.paragraph;
    const okResolve = resolved.status === 200 && v?.status === "verified"
      && v?.recomputedSha256 === state.v1Sha
      && paragraph?.text === state.pinnedText
      && paragraph?.chunkSha256 === state.pinnedChunkSha
      && paragraph?.charStart === state.charStart && paragraph?.charEnd === state.charEnd;
    push("8.1", "断网 + 无向量重启后，按原文范围回读同一段且校验值一致", okResolve,
      `verification=${v?.status} snapshotSha=${v?.recomputedSha256 === state.v1Sha ? "一致" : "不一致"} chunkSha=${paragraph?.chunkSha256 === state.pinnedChunkSha ? "一致" : "不一致"} range=[${paragraph?.charStart},${paragraph?.charEnd}) versionStatus=${resolved.json?.versionStatus}`,
      { expectedSha256: state.v1Sha, recomputedSha256: v?.recomputedSha256, chunkSha256: paragraph?.chunkSha256, charStart: paragraph?.charStart, charEnd: paragraph?.charEnd, paragraphHead: paragraph?.text?.slice(0, 160) });
    writeFileSync(join(evidenceDir, "response-resolve-after-restart.json"), JSON.stringify(resolved.json, null, 2));

    const keywordOnly = await call(base, "GET", `/knowledge/search?q=${encodeURIComponent("换任")}&engagementId=${state.engagementId}`);
    push("8.2", "无向量时关键词检索仍可用并如实标降级",
      keywordOnly.status === 200 && keywordOnly.json?.index?.degraded === true && keywordOnly.json?.hits?.length > 0,
      `total=${keywordOnly.json?.total} degraded=${keywordOnly.json?.index?.degraded} reason=${keywordOnly.json?.index?.degradedReason}`);

    const v2Search = await call(base, "GET", `/knowledge/search?q=${encodeURIComponent("§6.4")}&engagementId=${state.engagementId}`);
    const own = (v2Search.json?.hits ?? []).find((h: any) => h.materialId === state.materialId);
    push("8.3", "v1 停用后默认检索返回有效版 v2", own?.versionId === state.v2Id,
      `topVersionNo=${own?.versionNo} versionId=${own?.versionId} expectedV2=${state.v2Id}`);

    const report = await call(base, "GET", `/tasks/${state.taskId}/report`);
    push("8.4", "旧报告仍含 v1 快照校验值与停用提示",
      report.status === 200 && report.text.includes(state.v1Sha) && report.text.includes("该版本已停用"),
      `reportBytes=${report.text.length} containsV1Sha=${report.text.includes(state.v1Sha)}`);

    const exported = await call(base, "GET", `/tasks/${state.taskId}/report-export`);
    const packed = exported.json?.citations?.[0];
    const packedBytes = packed?.snapshot ? Buffer.from(packed.snapshot.bytesBase64, "base64") : null;
    push("8.5", "离线导出打包整份定版快照，校验值可复算",
      exported.status === 200 && exported.json?.snapshotScope === "full-version"
      && packed?.verification?.status === "verified" && packedBytes !== null && sha256(packedBytes) === state.v1Sha,
      `snapshotScope=${exported.json?.snapshotScope} bytes=${packedBytes?.length} recomputedMatches=${packedBytes ? sha256(packedBytes) === state.v1Sha : false}`);
    writeFileSync(join(evidenceDir, "offline-report-export.json"), JSON.stringify(exported.json, null, 2));

    const paragraphExport = await call(base, "GET", `/tasks/${state.taskId}/report-export?snapshot=paragraph`);
    const paraPacked = paragraphExport.json?.citations?.[0]?.snapshot;
    const paraBytes = paraPacked ? Buffer.from(paraPacked.bytesBase64, "base64") : null;
    push("8.6", "只打包引用片段的导出：字节等于被引用段落，校验值等于片段校验值",
      paragraphExport.json?.snapshotScope === "paragraph" && paraBytes !== null
      && paraBytes.toString("utf8") === state.pinnedText && sha256(paraBytes) === state.pinnedChunkSha,
      `bytes=${paraBytes?.length} chunkShaMatches=${paraBytes ? sha256(paraBytes) === state.pinnedChunkSha : false}`);
    if (paraBytes) writeFileSync(join(evidenceDir, "offline-export-paragraph.md"), paraBytes);

    rmSync(join(dataRoot, state.v1SnapshotPath), { force: true });
    const afterLibraryLoss = await call(base, "GET", `/tasks/${state.taskId}/citations/${state.citationId}/resolve`);
    push("8.7", "知识库快照缺失时旧引用仍可由任务侧密封件复验",
      afterLibraryLoss.json?.verification?.status === "verified" && afterLibraryLoss.json?.librarySnapshotAvailable === false,
      `verification=${afterLibraryLoss.json?.verification?.status} librarySnapshotAvailable=${afterLibraryLoss.json?.librarySnapshotAvailable}`);

    const dbPath = taskPaths(join(dataRoot, "tasks", state.taskId)).historyDb;
    const db = new DatabaseSync(dbPath);
    db.prepare("UPDATE evidence_versions SET content = ? WHERE sha256 = ?").run(Buffer.from("tampered-by-acceptance"), state.v1Sha);
    db.close();
    const broken = await call(base, "GET", `/tasks/${state.taskId}/citations/${state.citationId}/resolve`);
    push("8.8", "密封快照损坏时返回 sha256_mismatch 无法复验",
      broken.json?.verification?.reason === "sha256_mismatch",
      `reason=${broken.json?.verification?.reason}`);
    writeFileSync(join(evidenceDir, "response-resolve-unverifiable.json"), JSON.stringify(broken.json, null, 2));

    const db2 = new DatabaseSync(dbPath);
    db2.exec("PRAGMA foreign_keys = OFF");
    db2.prepare("DELETE FROM evidence_versions WHERE sha256 = ?").run(state.v1Sha);
    db2.close();
    const missing = await call(base, "GET", `/tasks/${state.taskId}/citations/${state.citationId}/resolve`);
    push("8.9", "密封快照缺失时返回 snapshot_missing 无法复验",
      missing.json?.verification?.reason === "snapshot_missing",
      `reason=${missing.json?.verification?.reason}`);
  } finally {
    await plane.close();
  }
  writeFileSync(outPath, JSON.stringify(results, null, 2));
  console.log(`offline phase wrote ${results.length} results to ${outPath}`);
}

// ---------------------------------------------------------------------------
// 升级一致性：把上一轮真实数据根复制一份，用新代码启动，验证旧引用回读同一段。
// ---------------------------------------------------------------------------
async function upgradePhase(runId: string, evidenceDir: string, embeddingBaseUrl: string) {
  const previous = join(repoRoot, "out", "knowledge-1795404972071");
  const citationId = "a49dd90e-550c-45aa-80aa-7af66e4a5c3b";
  const taskId = "3eb61eb1-5d30-47e3-a514-93c343272477";
  const v1Sha = "f8d78d0ffe8c0b8b2b2f4a5a8215d31550574e7ef7f049d8816c0ad12487cd59";
  if (!existsSync(previous)) {
    record("9.0", "升级前旧引用回读一致性", false, `缺少上一轮数据根 ${previous}，本条列为缺项`);
    return;
  }
  const copy = join(repoRoot, "out", `${runId}-upgrade`);
  cpSync(previous, copy, { recursive: true });
  const sealPath = join(copy, "tasks", taskId, "report-evidence", v1Sha);
  if (!existsSync(sealPath)) {
    record("9.0", "升级前旧引用回读一致性", false, "上一轮报告附件里没有 v1 字节，无法复原密封件，本条列为缺项");
    return;
  }
  const originalBytes = readFileSync(sealPath);
  record("9.1", "取到升级前 v1 原文字节（上一轮报告附件）", sha256(originalBytes) === v1Sha,
    `bytes=${originalBytes.length} sha256=${sha256(originalBytes)} 与引用登记值一致=${sha256(originalBytes) === v1Sha}`);

  // 升级前的回读结果：用旧切分独立算一遍，作为对照基准。
  const { sectionsFromSnapshot } = await import("../packages/control-plane/src/knowledge-parse.js");
  const beforeSections = sectionsFromSnapshot(originalBytes.toString("utf8"), "markdown", { legacy: true });
  const before = beforeSections.find((s) => s.locator === "§6.4");
  if (!before) {
    record("9.2", "升级前 §6.4 段落基准", false, "旧切分里找不到 §6.4");
    return;
  }
  record("9.2", "记录升级前 §6.4 回读基准（旧切分整章）", true,
    `chars=[${before.charStart},${before.charEnd}) length=${before.text.length} chunkSha=${before.chunkSha256}`,
    { charStart: before.charStart, charEnd: before.charEnd, chunkSha256: before.chunkSha256, head: before.text.slice(0, 120) });

  // 上一轮验收末段删除了任务侧密封件与库侧 v1 快照，这里用字节完全相同的报告附件复原两处。
  const librarySnapshot = join(copy, "knowledge", "snapshots", v1Sha);
  if (!existsSync(librarySnapshot)) {
    mkdirSync(dirname(librarySnapshot), { recursive: true });
    writeFileSync(librarySnapshot, originalBytes);
  }
  const historyPath = taskPaths(join(copy, "tasks", taskId)).historyDb;
  const db = new DatabaseSync(historyPath);
  const existing = db.prepare("SELECT sha256 FROM evidence_versions WHERE sha256 = ?").get(v1Sha);
  if (!existing) {
    db.prepare("INSERT INTO evidence_versions (sha256, content) VALUES (?, ?)")
      .run(v1Sha, originalBytes);
  }
  const legacyColumns = new Set((db.prepare("PRAGMA table_info(material_citations)").all() as Array<{ name: string }>)
    .map((c) => c.name));
  db.close();
  const preUpgradeShape = !legacyColumns.has("pin_kind") && !legacyColumns.has("char_start")
    && !legacyColumns.has("section_json");
  record("9.3", "确认这条引用来自升级前的库结构（没有原文范围与片段元数据列）", preUpgradeShape,
    `material_citations 列=${[...legacyColumns].join(",")}；含 pin_kind=${legacyColumns.has("pin_kind")} 含 char_start=${legacyColumns.has("char_start")}`);

  const plane = await bootControlPlane({
    dataRoot: copy, host: "127.0.0.1", port: 0, runtime: "local", isolated: true, watchdogMs: 60_000,
    knowledgeEmbedding: { enabled: true, provider: "local", local: { baseUrl: embeddingBaseUrl, model: "bge-m3-mlx-4bit", batchSize: 16, timeoutMs: 60_000 } },
  });
  try {
    await plane.knowledge.index.idle(180_000);
    const migrated = await call(plane.url, "GET", `/knowledge/materials/4a3bb9ea-08d8-4df7-800e-5599d1899f40?engagementId=eng-knowledge-1795404972071`);
    const versions = migrated.json?.versions ?? [];
    record("9.4", "新代码在旧数据根上原地迁移：版本号与内容 SHA-256 不变",
      migrated.status === 200 && versions.some((v: any) => v.contentSha256 === v1Sha)
      && versions.every((v: any) => v.chunkerVersion === 2),
      `versions=${versions.length} chunkerVersions=${versions.map((v: any) => v.chunkerVersion).join(",")} v1ShaStillPresent=${versions.some((v: any) => v.contentSha256 === v1Sha)}`);

    const resolved = await call(plane.url, "GET", `/tasks/${taskId}/citations/${citationId}/resolve`);
    const p = resolved.json?.paragraph;
    record("9.3b", "迁移后这条引用仍是 locator 定版（未被改写成范围定版）",
      resolved.json?.citation?.pinKind === "locator" && resolved.json?.citation?.charStart === null,
      `pinKind=${resolved.json?.citation?.pinKind} charStart=${resolved.json?.citation?.charStart} chunkSha256=${resolved.json?.citation?.chunkSha256}`);
    const same = resolved.status === 200 && resolved.json?.verification?.status === "verified"
      && p?.text === before.text && p?.charStart === before.charStart && p?.charEnd === before.charEnd
      && p?.chunkSha256 === before.chunkSha256
      && resolved.json?.verification?.recomputedSha256 === v1Sha;
    record("9.5", "升级后旧 locator 引用回读的是同一段，原文范围与校验值完全一致", same,
      `verification=${resolved.json?.verification?.status} pinKind=${resolved.json?.citation?.pinKind} chars=[${p?.charStart},${p?.charEnd}) length=${p?.text?.length} chunkSha一致=${p?.chunkSha256 === before.chunkSha256}`,
      { before: { charStart: before.charStart, charEnd: before.charEnd, chunkSha256: before.chunkSha256 },
        after: p ? { charStart: p.charStart, charEnd: p.charEnd, chunkSha256: p.chunkSha256 } : null });
    writeFileSync(join(evidenceDir, "response-legacy-upgrade-resolve.json"), JSON.stringify(resolved.json, null, 2));

    // 重建索引后再回读一次
    await call(plane.url, "POST", `/knowledge/index/rebuild?engagementId=eng-knowledge-1795404972071`, {});
    await plane.knowledge.index.idle(180_000);
    const afterRebuild = await call(plane.url, "GET", `/tasks/${taskId}/citations/${citationId}/resolve`);
    const q = afterRebuild.json?.paragraph;
    record("9.6", "重建索引后旧引用仍回读同一段",
      q?.text === before.text && q?.chunkSha256 === before.chunkSha256,
      `chunkSha一致=${q?.chunkSha256 === before.chunkSha256} length=${q?.text?.length}`);

    // 新切分下 §6.4 已是分片，与旧整章不同——证明兼容不是靠不切分
    const current = await call(plane.url, "GET",
      `/knowledge/materials/4a3bb9ea-08d8-4df7-800e-5599d1899f40/versions/7d2fd3ea-b2b7-4c14-bf8e-1f2fa7d05ca1/section?locator=${encodeURIComponent("§6.4")}&engagementId=eng-knowledge-1795404972071`);
    record("9.7", "新切分确实改变了库内片段，但旧引用不受影响",
      current.status === 200 && current.json?.section?.text?.length !== before.text.length,
      `新 §6.4 首片长度=${current.json?.section?.text?.length} 旧整章长度=${before.text.length} 旧引用仍读整章=${q?.text?.length === before.text.length}`);
  } finally {
    await plane.close();
  }
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------
async function main() {
  const runId = `knowledge-hybrid-${Date.now()}`;
  const evidenceDir = join(repoRoot, "docs", "evidence", "knowledge-library", runId);
  mkdirSync(evidenceDir, { recursive: true });
  const dataRoot = join(repoRoot, "out", runId);
  mkdirSync(dataRoot, { recursive: true });

  const embeddingBaseUrl = process.env.GY_EMBEDDING_BASE_URL ?? "http://127.0.0.1:8000/v1";
  const embeddingModel = process.env.GY_EMBEDDING_MODEL ?? "bge-m3-mlx-4bit";

  // --- 0. 真实 embedding 模型连通性 ---------------------------------------
  const probeKey = process.env.OMLX_API_KEY?.trim();
  let probeDim: number | null = null;
  let probeError = "";
  try {
    const res = await fetch(`${embeddingBaseUrl}/embeddings`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(probeKey ? { authorization: `Bearer ${probeKey}` } : {}) },
      body: JSON.stringify({ model: embeddingModel, input: ["负责人换班", "commander handover reads STATE to resume"] }),
      signal: AbortSignal.timeout(120_000),
    });
    if (!res.ok) probeError = `HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`;
    else {
      const payload = await res.json() as { data?: Array<{ embedding?: number[] }> };
      probeDim = payload.data?.[0]?.embedding?.length ?? null;
      if (!probeDim) probeError = "返回里没有向量";
    }
  } catch (err) {
    probeError = err instanceof Error ? err.message : String(err);
  }
  const embeddingReady = probeDim !== null;
  record("0.1", `本机真实 embedding 模型可用（${embeddingModel}）`, embeddingReady,
    embeddingReady
      ? `baseUrl=${embeddingBaseUrl} dim=${probeDim} 密钥来源=${probeKey ? "OMLX_API_KEY 环境变量" : "无（服务未要求）"}`
      : `不可用：${probeError}。混合检索相关条目将如实记为缺项，关键词条目仍照常验收。`,
    { baseUrl: embeddingBaseUrl, model: embeddingModel, dim: probeDim, error: probeError || undefined });

  const plane = await bootControlPlane({
    dataRoot, host: "127.0.0.1", port: 0, runtime: "local", isolated: true, watchdogMs: 60_000,
    knowledgeEmbedding: {
      enabled: true, provider: "local",
      local: {
        baseUrl: embeddingBaseUrl, model: embeddingModel,
        apiKeyEnv: "OMLX_API_KEY", batchSize: 16, timeoutMs: 120_000,
      },
    },
  });
  const base = plane.url;
  const ENG = `eng-${runId}`;
  console.log(`runId=${runId}\ndataRoot=${dataRoot}\nurl=${base}\nengagementId=${ENG}\n`);

  const makeTask = (engagementId: string, name: string) => {
    const task = plane.store.createTask(CreateTaskRequestSchema.parse({
      name, engagementId,
      auth: { targets: ["knowledge-acceptance.invalid"], authorizationNote: "知识库混合检索后端验收，靶标为虚构地址" },
      goals: [{ id: "g1", title: "整篇导入与混合检索", description: "语义与关键词并存且可定版回读", evidencePatterns: ["knowledge/*.json"] }],
      mock: true,
    }));
    const paths = taskPaths(task.dataDir);
    const history = openHistory({ dbPath: paths.historyDb, evidenceDir: paths.evidenceDir });
    history.seedGoals(task.id, task.goals);
    history.close();
    return task;
  };
  const task = makeTask(ENG, "整篇导入与混合检索验收");
  plane.store.finishTask(task, "completed", null);

  // --- 1. 取整篇原文 -------------------------------------------------------
  const upstream = [
    { key: "nvwabase", repo: "https://github.com/N1nEmAn/nvwabase", ref: "refs/heads/master",
      raw: "https://raw.githubusercontent.com/N1nEmAn/nvwabase/master/README.md" },
    { key: "sapperlens", repo: "https://github.com/inwpu/SapperLens", ref: "refs/heads/main",
      raw: "https://raw.githubusercontent.com/inwpu/SapperLens/main/README.md" },
  ];
  const docs: Record<string, { text: string; commit: string | null; url: string; title: string; publisher: string }> = {};
  for (const source of upstream) {
    const text = await fetchText(source.raw);
    const commit = gitHead(source.repo, source.ref);
    if (text) {
      docs[source.key] = {
        text, commit, url: source.raw,
        title: source.key === "nvwabase" ? "nvwabase — The Nüwa Foundation（整篇 README）" : "SapperLens 独立运行分析（整篇 README）",
        publisher: source.key === "nvwabase" ? "N1nEmAn · VarFusion Lab（上游作者）" : "inwpu（独立运行分析）",
      };
      writeFileSync(join(evidenceDir, `upstream-${source.key}.md`), text);
    }
    record(`1.${source.key}`, `取整篇上游原文 ${source.key}`, Boolean(text),
      text ? `bytes=${text.length} commit=${commit ?? "未取到"}` : "上游不可达，本条列为缺项，不用摘录或演示文本替代",
      { url: source.raw, commit, bytes: text?.length ?? 0 });
  }
  const localDocs = [
    { key: "ledger", path: "docs/experiments/2026-11-22-ledger-relay/README.md",
      title: "Relay 台账交接六批复核实验（整篇 README）", publisher: "GongYuAI（本项目实验）" },
    { key: "r017", path: "docs/absorb-super-agent.md",
      title: "GongYuAI Super-agent 设计与验收（含 R-017 用例全文）", publisher: "GongYuAI（本项目合成验收）" },
  ];
  const localCommit = gitHead("https://github.com/Sycun/GongYuAI", "refs/heads/main");
  for (const local of localDocs) {
    const abs = join(repoRoot, local.path);
    const text = existsSync(abs) ? readFileSync(abs, "utf8") : null;
    if (text) {
      docs[local.key] = { text, commit: localCommit, url: `https://github.com/Sycun/GongYuAI/blob/main/${local.path}`,
        title: local.title, publisher: local.publisher };
      writeFileSync(join(evidenceDir, `local-${local.key}.md`), text);
    }
    record(`1.${local.key}`, `取本项目整篇材料 ${local.key}`, Boolean(text),
      text ? `bytes=${text.length} path=${local.path}` : `仓库内缺少 ${local.path}`);
  }

  // --- 2. 整篇导入，且不挂与查询同词的人工标签 -----------------------------
  const scope = { kind: "engagement", engagementId: ENG };
  const imported: Record<string, any> = {};
  const queryWords = QUERIES.flatMap((q) => [q.query, ...q.query.split(/\s+/)]);
  for (const [key, doc] of Object.entries(docs)) {
    const res = await call(base, "POST", "/knowledge/materials", {
      title: doc.title, publisher: doc.publisher, sourceKind: "original", format: "markdown",
      sourceUrl: doc.url, content: doc.text, tags: [],
      upstreamCommit: doc.commit ?? undefined, scope,
      note: "整篇原文入库；不挂与测试查询同词的人工标签。",
    });
    if (res.status !== 201 && res.status !== 200) {
      record(`2.${key}`, `整篇导入 ${key}`, false, `导入失败 ${res.status}: ${res.text.slice(0, 200)}`);
      continue;
    }
    imported[key] = res.json;
    const sections = res.json.sections as any[];
    const sliceOk = sections.every((s) => doc.text.replace(/\r\n?/g, "\n").slice(s.charStart, s.charEnd) === s.text);
    const multi = sections.filter((s) => s.chunkCount > 1).length;
    record(`2.${key}`, `整篇导入 ${key} 并按标题层级切片`,
      res.json.version.bodyStatus === "ready" && sections.length > 1 && sliceOk,
      `chunks=${sections.length} byteSize=${res.json.version.byteSize} 原文范围精确=${sliceOk} 被继续切分的片段数=${multi} sha256=${res.json.version.contentSha256}`,
      { contentSha256: res.json.version.contentSha256, chunks: sections.length,
        locators: sections.map((s) => s.locator), upstreamCommit: doc.commit });
  }
  const noTagOverlap = Object.values(imported).every((value: any) =>
    (value.material.tags as string[]).every((tag) => !queryWords.some((word) => tag.includes(word) || word.includes(tag))));
  record("2.tags", "已移除与测试查询同词的人工标签", noTagOverlap,
    `各资料 tags=${Object.entries(imported).map(([k, v]) => `${k}:${JSON.stringify(v.material.tags)}`).join(" ")}`);
  record("2.summary", "四份整篇材料均已导入",
    ["nvwabase", "sapperlens", "ledger", "r017"].every((k) => imported[k]),
    `已导入 ${Object.keys(imported).length}/4：${Object.keys(imported).join(",")}`);

  // --- 3. 索引就绪 ---------------------------------------------------------
  // 新契约：导入只登记待向量化，这里显式「开始向量化」（勾选全部版本）再等灌满。
  await call(base, "POST", `/knowledge/index/retry?engagementId=${ENG}`, {});
  await plane.knowledge.index.idle(300_000);
  const indexStatus = await call(base, "GET", `/knowledge/index?engagementId=${ENG}`);
  writeFileSync(join(evidenceDir, "response-index-status.json"), JSON.stringify(indexStatus.json, null, 2));
  const idx = indexStatus.json?.index;
  record("3.1", "整篇材料的向量索引灌满（真实模型）",
    embeddingReady && idx?.state === "ready" && idx?.indexedChunks === idx?.totalChunks && idx?.totalChunks > 0,
    embeddingReady
      ? `state=${idx?.state} model=${idx?.model} dim=${idx?.modelDim} indexKey=${idx?.indexKey} chunks=${idx?.indexedChunks}/${idx?.totalChunks} lastIndexedAt=${idx?.lastIndexedAt}`
      : `缺项：真实 embedding 不可用（${probeError}）；state=${idx?.state} reason=${idx?.degradedReason}`,
    idx);

  // --- 4. 逐条查询：关键词 vs 混合 Top 5 ----------------------------------
  const comparison: unknown[] = [];
  for (const spec of QUERIES) {
    const q = encodeURIComponent(spec.query);
    const keyword = await call(base, "GET", `/knowledge/search?q=${q}&mode=keyword&limit=200&engagementId=${ENG}`);
    const hybrid = await call(base, "GET", `/knowledge/search?q=${q}&limit=200&engagementId=${ENG}`);
    const keywordTop = topHits(keyword.json);
    const hybridTop = topHits(hybrid.json);
    const rows: unknown[] = [];
    let allTargetsFound = true;
    const regressions: string[] = [];
    for (const [docKey, parentLocator] of Object.entries(spec.targets)) {
      const materialId = imported[docKey]?.material?.id;
      const kRank = rankOf(keyword.json, materialId, parentLocator);
      const hRank = rankOf(hybrid.json, materialId, parentLocator);
      const found = hRank !== null;
      if (!found) allTargetsFound = false;
      if (kRank !== null && (hRank === null || hRank > kRank)) regressions.push(`${docKey}:${kRank}→${hRank ?? "未命中"}`);
      rows.push({ docKey, parentLocator, keywordRank: kRank, hybridRank: hRank,
        inTop5: hRank !== null && hRank <= 5 });
    }
    const semanticNotBody = (hybrid.json?.hits ?? []).every((h: any) =>
      !h.matchedFields.includes("semantic") || !h.matchedFields.includes("body") || h.keywordScore > 0);
    // 目标资料内各片段的实测语义分：名次靠后时用它说明原因，而不是只给结论。
    const targetScores = Object.keys(spec.targets).map((docKey) => {
      const materialId = imported[docKey]?.material?.id;
      const own = (hybrid.json?.hits ?? [])
        .filter((h: any) => h.materialId === materialId && h.semanticScore !== null)
        .map((h: any) => ({ locator: h.locator, parentLocator: h.parentLocator, semanticScore: Number(h.semanticScore.toFixed(4)) }))
        .sort((a: any, b: any) => b.semanticScore - a.semanticScore);
      return { docKey, chunks: own };
    });
    const row = {
      id: spec.id, query: spec.query, kind: spec.kind, rationale: spec.rationale,
      keywordTotal: keyword.json?.total, hybridTotal: hybrid.json?.total,
      recall: hybrid.json?.recall, degraded: hybrid.json?.index?.degraded,
      targets: rows, regressions, targetScores, keywordTop5: keywordTop, hybridTop5: hybridTop,
    };
    comparison.push(row);
    writeFileSync(join(evidenceDir, `search-${spec.id}-keyword.json`), JSON.stringify(keyword.json, null, 2));
    writeFileSync(join(evidenceDir, `search-${spec.id}-hybrid.json`), JSON.stringify(hybrid.json, null, 2));

    const summary = rows.map((r: any) => `${r.docKey} ${r.parentLocator}: 关键词 ${r.keywordRank ?? "未命中"} → 混合 ${r.hybridRank ?? "未命中"}`).join("；");
    if (spec.kind === "semantic") {
      const primary = rows[0] as any;
      record(`4.${spec.id}`, `语义查询「${spec.query}」召回全部目标段落（无标签、无字面命中）`,
        embeddingReady && allTargetsFound && semanticNotBody && regressions.length === 0
        && primary.inTop5,
        embeddingReady
          ? `${summary}；关键词 total=${keyword.json?.total}，混合 total=${hybrid.json?.total}（语义召回 ${hybrid.json?.recall?.semantic}，余弦门槛 ${hybrid.json?.recall?.semanticCutoff?.toFixed?.(4)}）；主目标 ${primary.docKey} 名次 ${primary.hybridRank}；退步项=${regressions.length ? regressions.join(",") : "无"}`
          : `缺项：真实 embedding 不可用，语义一路未执行。关键词 total=${keyword.json?.total}；${summary}`,
        row);
      const missedTop5 = rows.filter((r: any) => !r.inTop5);
      record(`4.${spec.id}.top5`, `语义查询「${spec.query}」全部目标段落进 Top 5`,
        embeddingReady && missedTop5.length === 0,
        missedTop5.length === 0
          ? `全部 ${rows.length} 个目标段落都在 Top 5`
          : `未进 Top 5：${missedTop5.map((r: any) => `${r.docKey} ${r.parentLocator} 名次 ${r.hybridRank ?? "未命中"}`).join("；")}（已召回但名次靠后，逐条名次见 query-comparison.json）`,
        { missedTop5 });
    } else {
      record(`4.${spec.id}`, `精确查询「${spec.query}」目标段落名次`,
        allTargetsFound && rows.every((r: any) => r.inTop5),
        `${summary}；混合首条=${hybridTop[0]?.locator ?? "无"}（${hybridTop[0]?.matchedFields?.join("+") ?? ""}）；退步项=${regressions.length ? regressions.join(",") : "无"}`,
        row);
    }
  }
  writeFileSync(join(evidenceDir, "query-comparison.json"), JSON.stringify(comparison, null, 2));

  // §0 不再抢首条：上一轮的具体问题
  const huanren = await call(base, "GET", `/knowledge/search?q=${encodeURIComponent("换任")}&limit=200&engagementId=${ENG}`);
  const firstSapper = (huanren.json?.hits ?? []).find((h: any) => h.materialId === imported.sapperlens?.material?.id);
  record("4.regress", "「换任」不再以 §0 摘要为首条（上一轮问题）",
    Boolean(firstSapper) && firstSapper.parentLocator !== "§0",
    `SapperLens首个命中=${firstSapper?.locator}（父章节 ${firstSapper?.parentLocator}），命中字段=${firstSapper?.matchedFields?.join("+")}`,
    { locator: firstSapper?.locator, parentLocator: firstSapper?.parentLocator, score: firstSapper?.score });

  // --- 5. PDF 物理页码回归 -------------------------------------------------
  const pdfFiles = [
    { key: "memgpt", path: "docs/2310.08560v2.pdf", title: "MemGPT: Towards LLMs as Operating Systems", expectedPages: 13, marker: "MemGPT" },
    { key: "attackpath", path: "docs/Staying on the Attack Path.pdf", title: "Staying on the Attack Path", expectedPages: 17, marker: "Attack Path" },
  ];
  const pdfRows: unknown[] = [];
  for (const pdf of pdfFiles) {
    const abs = join(repoRoot, pdf.path);
    if (!existsSync(abs)) {
      record(`5.${pdf.key}`, `PDF 物理页码回归 ${pdf.key}`, false, `仓库内缺少 ${pdf.path}`);
      continue;
    }
    const bytes = readFileSync(abs);
    const independent = independentPageCount(bytes);
    const res = await call(base, "POST", "/knowledge/materials", {
      title: pdf.title, publisher: "上游作者（PDF 原文）", sourceKind: "original", format: "pdf",
      sourceUrl: `https://github.com/Sycun/GongYuAI/blob/main/${pdf.path}`,
      contentBase64: bytes.toString("base64"), tags: [], scope,
      note: `仓库内真实 PDF，文件 SHA-256 ${sha256(bytes)}。`,
    });
    const sections = (res.json?.sections ?? []) as any[];
    const pages = [...new Set(sections.map((s) => s.page))].sort((a, b) => a - b);
    const maxPage = pages.length ? Math.max(...pages) : 0;
    const physicalOk = maxPage === pdf.expectedPages && pages.length === pdf.expectedPages
      && sections.every((s) => s.pageBasis === "physical-page");
    // 抽查：首段与末段正文必须落在第 1 页与最后一页
    const first = sections[0];
    const last = sections[sections.length - 1];
    const spotOk = first?.page === 1 && last?.page === pdf.expectedPages;
    record(`5.${pdf.key}`, `PDF 物理页码回归 ${pdf.key}：应为 ${pdf.expectedPages} 页`,
      res.status === 201 && physicalOk && spotOk,
      `API 页数=${maxPage}（不同页号 ${pages.length} 个）期望=${pdf.expectedPages}；独立核对 /Type/Page=${independent.count ?? "压缩对象流，见 /Count"} /Count=${independent.declared ?? "无"}；首段 p.${first?.page} 末段 p.${last?.page}；chunks=${sections.length}`,
      { fileSha256: sha256(bytes), apiPages: maxPage, expectedPages: pdf.expectedPages,
        independentPageObjects: independent.count, independentCount: independent.declared,
        firstPageHead: first?.text?.slice(0, 100), lastPageHead: last?.text?.slice(0, 100) });
    pdfRows.push({ key: pdf.key, fileSha256: sha256(bytes), apiPages: maxPage, expectedPages: pdf.expectedPages,
      pageBasis: first?.pageBasis, chunks: sections.length,
      firstPageHead: first?.text?.slice(0, 160), lastPageHead: last?.text?.slice(0, 160) });
    if (res.status === 201) {
      const hit = await call(base, "GET", `/knowledge/search?q=${encodeURIComponent(pdf.marker)}&engagementId=${ENG}`);
      const own = (hit.json?.hits ?? []).find((h: any) => h.materialId === res.json.material.id);
      record(`5.${pdf.key}.search`, `PDF 正文可检索且页码不超过物理页数 ${pdf.key}`,
        Boolean(own) && own.page !== null && own.page <= pdf.expectedPages,
        `locator=${own?.locator} page=${own?.page} pageBasis=${own?.pageBasis} matchedFields=${own?.matchedFields?.join("+")}`);
    }
  }
  writeFileSync(join(evidenceDir, "pdf-page-regression.json"), JSON.stringify(pdfRows, null, 2));

  // --- 6. 从命中片段建定版引用 → v2 → 停用 v1 -----------------------------
  const sapper = imported.sapperlens;
  let state: Record<string, unknown> | null = null;
  if (!sapper) {
    record("6.0", "定版引用链路", false, "缺 SapperLens 整篇原文，跳过；不以演示文本替代");
  } else {
    const search = await call(base, "GET", `/knowledge/search?q=${encodeURIComponent("负责人换班")}&limit=200&engagementId=${ENG}`);
    const hit = (search.json?.hits ?? []).find((h: any) => h.materialId === sapper.material.id && h.parentLocator === "§6.4")
      ?? (search.json?.hits ?? []).find((h: any) => h.materialId === sapper.material.id);
    if (!hit) {
      record("6.0", "定版引用链路", false, "混合检索未在 SapperLens 命中任何片段");
    } else {
      const cited = await call(base, "POST", `/tasks/${task.id}/citations`, {
        materialId: hit.materialId, versionId: hit.versionId, locator: hit.locator,
        charStart: hit.charStart, charEnd: hit.charEnd, chunkSha256: hit.chunkSha256,
        claim: "独立分析从运行记录中追到了一次负责人换班（06:14 换任，靠 STATE 续接）",
      });
      const citation = cited.json?.citation;
      record("6.1", "前端可直接用命中片段的定位字段创建定版引用",
        cited.status === 201 && citation.pinKind === "range"
        && citation.charStart === hit.charStart && citation.charEnd === hit.charEnd
        && citation.chunkSha256 === hit.chunkSha256 && citation.snapshotSha256 === sapper.version.contentSha256,
        `citationId=${citation?.id} pinKind=${citation?.pinKind} range=[${citation?.charStart},${citation?.charEnd}) chunkSha=${citation?.chunkSha256} locator=${citation?.locator}`,
        citation);
      writeFileSync(join(evidenceDir, "response-citation-created.json"), JSON.stringify(cited.json, null, 2));

      const resolvedBefore = await call(base, "GET", `/tasks/${task.id}/citations/${citation.id}/resolve`);
      const pinnedText = resolvedBefore.json?.paragraph?.text ?? "";
      const expectedSlice = docs.sapperlens!.text.replace(/\r\n?/g, "\n").slice(hit.charStart, hit.charEnd);
      record("6.2", "定版引用立即回读命中段落原文",
        resolvedBefore.json?.verification?.status === "verified" && pinnedText.length > 0
        && pinnedText === expectedSlice
        && resolvedBefore.json.paragraph.chunkSha256 === hit.chunkSha256,
        `verification=${resolvedBefore.json?.verification?.status} chars=[${resolvedBefore.json?.paragraph?.charStart},${resolvedBefore.json?.paragraph?.charEnd}) length=${pinnedText.length} 与原文切片一致=${pinnedText === expectedSlice}`);

      // 重建索引后仍回读同一段
      await call(base, "POST", `/knowledge/index/rebuild?engagementId=${ENG}`, {});
      await plane.knowledge.index.idle(300_000);
      const afterRebuild = await call(base, "GET", `/tasks/${task.id}/citations/${citation.id}/resolve`);
      record("6.3", "重建索引后引用回读同一段、片段校验值一致",
        afterRebuild.json?.paragraph?.text === pinnedText
        && afterRebuild.json?.paragraph?.chunkSha256 === hit.chunkSha256
        && afterRebuild.json?.verification?.recomputedSha256 === sapper.version.contentSha256,
        `chunkSha一致=${afterRebuild.json?.paragraph?.chunkSha256 === hit.chunkSha256} length=${afterRebuild.json?.paragraph?.text?.length}`);

      // v2：整篇原文追加一处明确标记的验收修订
      const v2Text = `${docs.sapperlens!.text}\n\n> 验收修订 v2：本段为知识库验收追加的修订标记，不改动上游原文语义。\n`;
      const revised = await call(base, "POST", "/knowledge/materials", {
        title: docs.sapperlens!.title, publisher: docs.sapperlens!.publisher, sourceKind: "original", format: "markdown",
        sourceUrl: docs.sapperlens!.url, content: v2Text, tags: [], upstreamVersion: "验收修订 v2",
        upstreamCommit: docs.sapperlens!.commit ?? undefined, scope,
        note: "明确标记为验收修订的 v2，用于验证旧版停用后旧报告仍回读 v1。",
      });
      const v2 = revised.json?.version;
      record("6.4", "导入整篇 v2 并保留 v1 快照",
        revised.status === 201 && v2.versionNo === 2 && v2.contentSha256 !== sapper.version.contentSha256
        && existsSync(join(dataRoot, sapper.version.snapshotPath)),
        `v2Id=${v2?.id} v2Sha=${v2?.contentSha256} v1SnapshotStillPresent=${existsSync(join(dataRoot, sapper.version.snapshotPath))}`);
      // v2 也是导入后显式开始向量化
      await call(base, "POST", `/knowledge/index/retry?engagementId=${ENG}`, { versionIds: [v2.id] });
      await plane.knowledge.index.idle(300_000);

      const deprecated = await call(base, "POST",
        `/knowledge/materials/${sapper.material.id}/versions/${sapper.version.id}/deprecate?engagementId=${ENG}`,
        { reason: "验收修订 v2 已导入，停用 v1" });
      record("6.5", "停用 v1", deprecated.json?.version?.status === "deprecated",
        `status=${deprecated.json?.version?.status} deprecatedAt=${deprecated.json?.version?.deprecatedAt}`);

      const afterDeprecate = await call(base, "GET", `/knowledge/search?q=${encodeURIComponent("§6.4")}&limit=200&engagementId=${ENG}`);
      const ownHits = (afterDeprecate.json?.hits ?? []).filter((h: any) => h.materialId === sapper.material.id);
      record("6.6", "v1 停用后默认检索只返回有效版 v2",
        ownHits.length > 0 && ownHits.every((h: any) => h.versionId === v2.id),
        `命中 ${ownHits.length} 条，全部 versionNo=${[...new Set(ownHits.map((h: any) => h.versionNo))].join(",")}`);

      const stillV1 = await call(base, "GET", `/tasks/${task.id}/citations/${citation.id}/resolve`);
      record("6.7", "v2 生效后旧引用仍离线复验 v1 同一段",
        stillV1.json?.paragraph?.text === pinnedText && stillV1.json?.versionStatus === "deprecated"
        && stillV1.json?.verification?.recomputedSha256 === sapper.version.contentSha256,
        `versionStatus=${stillV1.json?.versionStatus} chunkSha一致=${stillV1.json?.paragraph?.chunkSha256 === hit.chunkSha256}`);

      state = {
        taskId: task.id, engagementId: ENG, materialId: sapper.material.id, citationId: citation.id,
        v1Id: sapper.version.id, v2Id: v2.id, v1Sha: sapper.version.contentSha256, v2Sha: v2.contentSha256,
        v1SnapshotPath: sapper.version.snapshotPath,
        pinnedText, pinnedChunkSha: hit.chunkSha256, charStart: hit.charStart, charEnd: hit.charEnd,
        locator: hit.locator,
      };
      writeFileSync(join(evidenceDir, "offline-state.json"), JSON.stringify(state, null, 2));
    }
  }

  // --- 7. 委托 A/B 隔离：关键词与语义两路双向 ------------------------------
  const ENG_A = `${ENG}-alpha`;
  const ENG_B = `${ENG}-beta`;
  const taskA = makeTask(ENG_A, "隔离验收 委托A");
  const taskB = makeTask(ENG_B, "隔离验收 委托B");
  plane.store.finishTask(taskA, "completed", null);
  plane.store.finishTask(taskB, "completed", null);
  const isoImport = async (isoScope: unknown, title: string, body: string) => {
    const res = await call(base, "POST", "/knowledge/materials", {
      title, publisher: "隔离验收", sourceKind: "original", format: "markdown",
      sourceUrl: `https://example.invalid/${encodeURIComponent(title)}`,
      content: body, tags: [], scope: isoScope,
    });
    return { materialId: res.json.material.id, versionId: res.json.version.id, locator: res.json.sections[0].locator };
  };
  const onlyA = await isoImport({ kind: "engagement", engagementId: ENG_A }, "委托A专属交接记录",
    "## 交接记录\n\n06:14 阿尔法专属关键词出现，指挥官换任，继任者读 STATE 续接进度。");
  const onlyB = await isoImport({ kind: "engagement", engagementId: ENG_B }, "委托B专属交接记录",
    "## 交接记录\n\n07:20 贝塔专属关键词出现，指挥官换任，继任者读 STATE 续接进度。");
  const shared = await isoImport({ kind: "shared" }, "团队共享交接记录",
    "## 交接记录\n\n伽马共享关键词出现，指挥官换任，继任者读 STATE 续接进度。");
  // 隔离样本同样显式开始向量化：A/B 各一次（共享资料包含在内）
  await call(base, "POST", `/knowledge/index/retry?engagementId=${ENG_A}`, {});
  await call(base, "POST", `/knowledge/index/retry?engagementId=${ENG_B}`, {});
  await plane.knowledge.index.idle(300_000);

  const isoRows: unknown[] = [];
  for (const [reader, ownKey, otherKey, ownId, otherId] of [
    [ENG_A, "阿尔法专属关键词", "贝塔专属关键词", onlyA.materialId, onlyB.materialId],
    [ENG_B, "贝塔专属关键词", "阿尔法专属关键词", onlyB.materialId, onlyA.materialId],
  ] as const) {
    const ownKeyword = await call(base, "GET", `/knowledge/search?q=${encodeURIComponent(ownKey)}&mode=keyword&engagementId=${reader}`);
    const otherKeyword = await call(base, "GET", `/knowledge/search?q=${encodeURIComponent(otherKey)}&mode=keyword&engagementId=${reader}`);
    // 语义查询：两份专属材料正文高度相似，只有范围能挡住越界召回
    const semantic = await call(base, "GET", `/knowledge/search?q=${encodeURIComponent("负责人换班后怎样续上进度")}&limit=200&engagementId=${reader}`);
    const sharedKeyword = await call(base, "GET", `/knowledge/search?q=${encodeURIComponent("伽马共享关键词")}&mode=keyword&engagementId=${reader}`);
    const sharedHybrid = await call(base, "GET", `/knowledge/search?q=${encodeURIComponent("伽马共享关键词")}&limit=200&engagementId=${reader}`);
    const summary = await call(base, "GET", `/knowledge/summary?engagementId=${reader}`);
    const indexScoped = await call(base, "GET", `/knowledge/index?engagementId=${reader}`);
    const leaked = (semantic.json?.hits ?? []).some((h: any) => h.materialId === otherId);
    const sharedHybridLeak = (sharedHybrid.json?.hits ?? []).some((h: any) => h.materialId === otherId);
    isoRows.push({
      reader, ownKeywordTotal: ownKeyword.json.total, otherKeywordTotal: otherKeyword.json.total,
      sharedKeywordTotal: sharedKeyword.json.total, sharedHybridTotal: sharedHybrid.json.total,
      sharedHybridLeak, materials: summary.json.materials,
      semanticTotal: semantic.json.total, semanticLeaked: leaked,
      semanticMaterials: [...new Set((semantic.json?.hits ?? []).map((h: any) => h.materialId))],
      searchedVersions: semantic.json.searchedVersions,
      indexTotalChunks: indexScoped.json.index.totalChunks,
      leakedOtherTitle: semantic.text.includes(reader === ENG_A ? "委托B专属交接记录" : "委托A专属交接记录"),
      ownId, otherId,
    });
  }
  record("7.1", "关键词与语义两路双向不泄露，共享资料两边可见，计数按范围",
    isoRows.every((r: any) => r.ownKeywordTotal === 1 && r.otherKeywordTotal === 0 && r.sharedKeywordTotal === 1
      && r.materials === 2 && !r.semanticLeaked && !r.leakedOtherTitle && !r.sharedHybridLeak
      && r.semanticMaterials.every((id: string) => id !== r.otherId)),
    JSON.stringify(isoRows.map((r: any) => ({ reader: r.reader, kwOwn: r.ownKeywordTotal, kwOther: r.otherKeywordTotal,
      sharedKw: r.sharedKeywordTotal, sharedHybrid: r.sharedHybridTotal, sharedLeak: r.sharedHybridLeak,
      materials: r.materials, semTotal: r.semanticTotal, semLeaked: r.semanticLeaked,
      searchedVersions: r.searchedVersions, indexChunks: r.indexTotalChunks }))), isoRows);
  writeFileSync(join(evidenceDir, "isolation-rows.json"), JSON.stringify(isoRows, null, 2));

  const directRows: unknown[] = [];
  for (const [reader, target] of [[ENG_B, onlyA], [ENG_A, onlyB]] as const) {
    const detail = await call(base, "GET", `/knowledge/materials/${target.materialId}?engagementId=${reader}`);
    const versions = await call(base, "GET", `/knowledge/materials/${target.materialId}/versions?engagementId=${reader}`);
    const version = await call(base, "GET", `/knowledge/materials/${target.materialId}/versions/${target.versionId}?engagementId=${reader}`);
    const section = await call(base, "GET", `/knowledge/materials/${target.materialId}/versions/${target.versionId}/section?locator=${encodeURIComponent(target.locator)}&engagementId=${reader}`);
    const rebuild = await call(base, "POST", `/knowledge/index/rebuild?engagementId=${reader}`, { materialId: target.materialId });
    directRows.push({ reader, detail: detail.status, versions: versions.status, version: version.status,
      section: section.status, rebuild: rebuild.status, leakedTitle: detail.text.includes("专属交接记录") });
  }
  record("7.2", "已知 ID 直读资料/版本/段落与越界重建一律 404，且不泄露标题",
    directRows.every((r: any) => r.detail === 404 && r.versions === 404 && r.version === 404
      && r.section === 404 && r.rebuild === 404 && !r.leakedTitle),
    JSON.stringify(directRows), directRows);

  const crossAB = await call(base, "POST", `/tasks/${taskB.id}/citations`, {
    materialId: onlyA.materialId, versionId: onlyA.versionId, locator: onlyA.locator, claim: "B 试图引用 A 的材料" });
  const crossBA = await call(base, "POST", `/tasks/${taskA.id}/citations`, {
    materialId: onlyB.materialId, versionId: onlyB.versionId, locator: onlyB.locator, claim: "A 试图引用 B 的材料" });
  record("7.3", "跨委托创建引用双向被拒", crossAB.status === 404 && crossBA.status === 404,
    `B→A=${crossAB.status} A→B=${crossBA.status}`);

  for (const [t, x, claim] of [[taskA, onlyA, "A 的表述"], [taskA, shared, "A 引用共享"], [taskB, onlyB, "B 的表述"], [taskB, shared, "B 引用共享"]] as const) {
    await call(base, "POST", `/tasks/${t.id}/citations`, { materialId: x.materialId, versionId: x.versionId, locator: x.locator, claim });
  }
  const exportA = await call(base, "GET", `/tasks/${taskA.id}/report-export`);
  const exportB = await call(base, "GET", `/tasks/${taskB.id}/report-export`);
  record("7.4", "报告导出双向不泄露另一委托的材料 ID 与关键词",
    exportA.json.citations.length === 2 && exportB.json.citations.length === 2
    && !exportA.text.includes("贝塔专属关键词") && !exportA.text.includes(onlyB.materialId)
    && !exportB.text.includes("阿尔法专属关键词") && !exportB.text.includes(onlyA.materialId),
    `A citations=${exportA.json.citations.length} B citations=${exportB.json.citations.length} snapshotScope=${exportA.json.snapshotScope}`);

  const conflict = await call(base, "GET", `/tasks/${taskA.id}/citations?engagementId=${ENG_B}`);
  const anchored = await call(base, "GET", `/knowledge/summary?taskId=${taskA.id}`);
  const anchorConflict = await call(base, "GET", `/knowledge/index?taskId=${taskA.id}&engagementId=${ENG_B}`);
  record("7.5", "客户端 engagementId 只能定位：冲突拒绝，任务归属以服务端为准",
    conflict.status === 409 && anchorConflict.status === 409
    && anchored.json.scope.resolvedFrom === "task" && anchored.json.scope.engagementId === ENG_A,
    `冲突=${conflict.status}/${anchorConflict.status}；taskId 锚定 resolvedFrom=${anchored.json.scope.resolvedFrom}`);
  record("7.6", "单操作者环境的权限验证边界已如实记录",
    anchored.json.scope.userLevelPermissionVerified === false && anchored.json.scope.operatorModel === "single-operator",
    "本运行环境无认证层：已验收委托边界（两路范围校验、越界 404、导出不泄露）；用户级权限（谁能声明哪个委托）未验证。",
    anchored.json.scope);

  // --- 8. 断网 + 无向量子进程重启回读 -------------------------------------
  if (state) {
    const offlineOut = join(evidenceDir, "offline-steps.json");
    const child = spawnSync(process.execPath, [
      "--import", "tsx", fileURLToPath(import.meta.url),
      "--offline", "--data-root", dataRoot, "--state", join(evidenceDir, "offline-state.json"), "--out", offlineOut,
    ], { cwd: repoRoot, encoding: "utf8", timeout: 300_000 });
    const offlineOk = child.status === 0 && existsSync(offlineOut);
    record("8.run", "断网且停用向量化的子进程重启服务", offlineOk,
      `exit=${child.status}${child.stderr ? ` stderr=${child.stderr.slice(-400)}` : ""}`);
    if (offlineOk) {
      const offlineSteps = JSON.parse(readFileSync(offlineOut, "utf8")) as Step[];
      steps.push(...offlineSteps);
      for (const step of offlineSteps) console.log(`${step.passed ? "PASS" : "FAIL"}  ${step.id}  ${step.title}\n      ${step.detail}`);
    }
  }

  await plane.close();

  // --- 9. 升级前旧引用回读一致性 -------------------------------------------
  await upgradePhase(runId, evidenceDir, embeddingBaseUrl);

  const passed = steps.filter((s) => s.passed).length;
  const summary = {
    runId, generatedAt: new Date().toISOString(), dataRoot, engagementId: ENG, taskId: task.id,
    embedding: { baseUrl: embeddingBaseUrl, model: embeddingModel, dim: probeDim, ready: embeddingReady, error: probeError || null },
    totals: { steps: steps.length, passed, failed: steps.length - passed },
    upstream: Object.fromEntries(Object.entries(docs).map(([k, v]) => [k, { url: v.url, commit: v.commit, bytes: v.text.length }])),
    queries: comparison, pdfPages: pdfRows, steps,
  };
  writeFileSync(join(evidenceDir, "acceptance-record.json"), JSON.stringify(summary, null, 2));

  const md = [
    "# 整篇导入 + 混合检索后端验收记录", "",
    `运行编号：${runId}　生成时间：${summary.generatedAt}`, "",
    `数据根（隔离）：\`${dataRoot}\`　服务：真实进程 + 回环 HTTP`, "",
    `结果：${passed}/${steps.length} 通过，${steps.length - passed} 未通过。`, "",
    "复现：`OMLX_API_KEY=$(cat ~/.omlx/api-key) pnpm knowledge:hybrid-acceptance`", "",
    "## 向量化模型", "",
    `- 服务：\`${embeddingBaseUrl}\`（本机 oMLX，OpenAI 兼容 \`/v1/embeddings\`）`,
    `- 模型：\`${embeddingModel}\`　维度：${probeDim ?? "未取到"}　可用：${embeddingReady ? "是" : `否（${probeError}）`}`,
    "- 委托专属资料一律在本地向量化，不发往云端。", "",
    "## 整篇导入的材料", "",
    "| 键 | 标题 | 字节 | 片段数 | 内容 SHA-256 | 上游 commit |", "| --- | --- | ---: | ---: | --- | --- |",
    ...Object.entries(imported).map(([key, value]) =>
      `| ${key} | ${value.material.title} | ${value.version.byteSize} | ${value.sections.length} | \`${value.version.contentSha256}\` | \`${docs[key]?.commit ?? "未取到"}\` |`),
    "", "全部材料 `tags: []`——**没有与测试查询同词的人工标签**。", "",
    "## 查询目标段落与名次对比", "",
    "| 编号 | 查询 | 类型 | 目标段落 | 关键词名次 | 混合名次 | 进 Top 5 |",
    "| --- | --- | --- | --- | ---: | ---: | --- |",
    ...comparison.flatMap((row: any) => row.targets.map((t: any) =>
      `| ${row.id} | ${row.query} | ${row.kind === "semantic" ? "语义" : "精确"} | ${t.docKey} \`${t.parentLocator}\` | ${t.keywordRank ?? "未命中"} | ${t.hybridRank ?? "未命中"} | ${t.inTop5 ? "是" : "否"} |`)),
    "", "### 目标段落的标注依据", "",
    ...QUERIES.map((q) => `- **${q.id}「${q.query}」**：${q.rationale}`),
    "", "### 退步项", "",
    ...(comparison.some((row: any) => row.regressions.length)
      ? comparison.filter((row: any) => row.regressions.length).map((row: any) => `- ${row.id}「${row.query}」：${row.regressions.join("、")}`)
      : ["无。所有目标段落在混合检索中的名次都不劣于关键词检索。"]),
    "", "### 已召回但未进 Top 5 的目标（实测语义分）", "",
    ...(comparison.some((row: any) => row.targets.some((t: any) => !t.inTop5))
      ? comparison.flatMap((row: any) => row.targets.filter((t: any) => !t.inTop5).map((t: any) => {
        const scores = row.targetScores.find((s: any) => s.docKey === t.docKey);
        const target = scores?.chunks?.find((c: any) => c.parentLocator === t.parentLocator);
        const best = scores?.chunks?.[0];
        return `- ${row.id}「${row.query}」→ ${t.docKey} \`${t.parentLocator}\`：名次 ${t.hybridRank ?? "未命中"}，`
          + `目标片段余弦 ${target?.semanticScore ?? "未参与语义召回"}；`
          + `同一资料内最高分片段是 \`${best?.locator ?? "无"}\`（${best?.semanticScore ?? "-"}）。`
          + `混合首条余弦 ${row.hybridTop5[0]?.semanticScore ?? "-"}。`;
      }))
      : ["无。全部目标段落都进了 Top 5。"]),
    "", "## PDF 物理页码回归", "",
    "| 样本 | 文件 SHA-256 | API 页数 | 物理页数 | 页码依据 |", "| --- | --- | ---: | ---: | --- |",
    ...pdfRows.map((r: any) => `| ${r.key} | \`${r.fileSha256}\` | ${r.apiPages} | ${r.expectedPages} | ${r.pageBasis} |`),
    "", "## 逐项结果", "",
    "| 编号 | 验收动作 | 结果 | 观察 |", "| --- | --- | --- | --- |",
    ...steps.map((s) => `| ${s.id} | ${s.title} | ${s.passed ? "通过" : "**未通过**"} | ${s.detail.replace(/\|/g, "\\|").replace(/\n/g, " ")} |`),
    "", "## 未通过或未执行的事项", "",
    ...(embeddingReady ? [] : [`- **真实 embedding 不可用**：${probeError}。语义召回相关条目未执行，已逐条标为缺项。`]),
    "- **控制台页面与交互**：本轮不实现，由控制台侧另行交付；接口契约见 [knowledge-library-api.md](../../../knowledge-library-api.md)。",
    "- **用户级权限**：单操作者、无认证层。已验收委托边界；`scope.userLevelPermissionVerified` 恒为 `false`。",
    "- **离线导出的收件范围**：按服务端任务归属过滤资料，`withheld.outOfScopeCitations` 只给数量。**不校验收件人身份**（无认证层），也不校验导出包离开本机后的流向。",
    "- **断网前提的实现方式**：子进程清除环境代理并按主机名拒绝非回环出站，且停用向量化。这是进程级阻断，不是物理断网。",
    "",
  ].join("\n");
  writeFileSync(join(evidenceDir, "acceptance-record.md"), md);
  console.log(`\n${passed}/${steps.length} 通过；证据写入 ${evidenceDir}`);
  if (passed !== steps.length) process.exitCode = 1;
}

const args = process.argv.slice(2);
if (args.includes("--offline")) {
  const get = (flag: string) => args[args.indexOf(flag) + 1]!;
  await offlinePhase(get("--data-root"), get("--state"), get("--out"));
} else {
  await main();
}
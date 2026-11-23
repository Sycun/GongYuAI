/**
 * 知识库首版后端验收（真实资料 + 真实服务进程 + HTTP API）。
 *
 * 本脚本是**关键词基线**：显式停用向量化，验收摘录导入、字面检索与定版回读。
 * 整篇导入 + 真实 embedding 的混合检索验收见 scripts/knowledge-hybrid-acceptance.ts。
 *
 * 用法：
 *   pnpm knowledge:acceptance
 *
 * 数据根隔离在 out/knowledge-acceptance-<runId>/，不触碰正式 .gongyuai。
 * 阶段二在**子进程**里装网络拒绝垫片后重启服务，证明旧报告回读不需要上游。
 * 证据写入 docs/evidence/knowledge-library/<runId>/。
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
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
    const res = await fetch(url, { signal: AbortSignal.timeout(40_000) });
    return res.ok ? await res.text() : null;
  } catch {
    return null;
  }
}

/** 从 Markdown 里按标题切出指定章节（含其子标题之前的正文）。 */
function sliceSection(markdown: string, headingPrefix: string): string | null {
  const lines = markdown.split("\n");
  const start = lines.findIndex((line) => line.startsWith(headingPrefix));
  if (start === -1) return null;
  const level = /^(#+)/.exec(lines[start]!)![1]!.length;
  let end = lines.length;
  let fence: string | null = null;
  for (let i = start + 1; i < lines.length; i += 1) {
    const line = lines[i]!;
    const f = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (f) {
      if (!fence) fence = f[1]!;
      else if (f[1]![0] === fence[0] && f[1]!.length >= fence.length) fence = null;
      continue;
    }
    if (fence) continue;
    const h = /^( {0,3})(#+)\s/.exec(line);
    if (h && h[2]!.length <= level) { end = i; break; }
  }
  return lines.slice(start, end).join("\n").replace(/\s+$/, "");
}

// ---------------------------------------------------------------------------
// 阶段二：断网子进程。任何出站连接都会抛错，因此回读若依赖上游必然失败。
// ---------------------------------------------------------------------------
async function offlinePhase(dataRoot: string, statePath: string, outPath: string) {
  const { createRequire } = await import("node:module");
  // 断网前提：清除环境代理（本机设了 NODE_USE_ENV_PROXY，出站会经本地转发，
  // 只按 socket 目标判断会把代理当成回环放行），再按**主机名**拒绝一切非回环出站。
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
    const host = options.servername ?? options.host;
    if (!loopback(host)) throw offlineError("出站 TLS", host);
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
  // ESM 命名空间不可写，改用可变的 CJS 内置模块对象；回环字面量放行。
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
  const plane = await bootControlPlane({
    dataRoot, host: "127.0.0.1", port: 0, runtime: "local", isolated: true, watchdogMs: 60_000,
    knowledgeEmbedding: { enabled: false },
  });
  const results: Step[] = [];
  const push = (id: string, title: string, passed: boolean, detail: string, evidence?: unknown) => {
    results.push({ id, title, passed, detail, ...(evidence === undefined ? {} : { evidence }) });
  };
  try {
    const base = plane.url;

    // 正对照：确认出站确实被拒，否则“断网回读通过”没有意义。
    let outboundBlocked = false;
    let outboundError = "";
    try {
      await fetch("https://raw.githubusercontent.com/inwpu/SapperLens/main/README.md", { signal: AbortSignal.timeout(8_000) });
    } catch (err) {
      outboundBlocked = true;
      outboundError = err instanceof Error ? err.message : String(err);
    }
    push("6.0a", "正对照：本阶段出站访问确实被拒", outboundBlocked,
      outboundBlocked ? `上游 fetch 失败：${outboundError.slice(0, 160)}` : "上游仍可访问，断网前提不成立");

    // 断网下回读旧引用
    const resolved = await call(base, "GET", `/tasks/${state.taskId}/citations/${state.citationId}/resolve`);
    const v = resolved.json?.verification;
    const paragraph = resolved.json?.paragraph?.text ?? "";
    const okResolve = resolved.status === 200 && v?.status === "verified"
      && v?.recomputedSha256 === state.v1Sha
      && paragraph === state.pinnedText
      && resolved.json?.paragraph?.chunkSha256 === state.chunkSha256
      && resolved.json?.paragraph?.charStart === state.charStart
      && resolved.json?.paragraph?.charEnd === state.charEnd
      && !paragraph.includes(state.v2Marker);
    push("6.1", "断网重启后按引用回读 v1 同一段并复算快照与片段 SHA-256", okResolve,
      `status=${resolved.status} verification=${v?.status} 快照SHA一致=${v?.recomputedSha256 === state.v1Sha} 片段SHA一致=${resolved.json?.paragraph?.chunkSha256 === state.chunkSha256} range=[${resolved.json?.paragraph?.charStart},${resolved.json?.paragraph?.charEnd}) versionStatus=${resolved.json?.versionStatus}`,
      { expectedSha256: state.v1Sha, recomputedSha256: v?.recomputedSha256, chunkSha256: resolved.json?.paragraph?.chunkSha256, locator: resolved.json?.paragraph?.locator, paragraphHead: paragraph.slice(0, 160) });
    writeFileSync(join(dirname(outPath), "response-resolve-verified.json"), JSON.stringify(resolved.json, null, 2));

    // 断网下当前检索默认给 v2
    const search = await call(base, "GET", `/knowledge/search?q=${encodeURIComponent("换任")}&limit=200&engagementId=${state.engagementId}`);
    // 「换任」也字面出现在编辑导读里，因此按 SapperLens 这份资料筛选后再判有效版。
    const own = (search.json?.hits ?? []).filter((h: any) => h.materialId === state.materialId);
    push("6.2", "断网下该资料的检索默认返回有效版 v2",
      search.status === 200 && own.length > 0 && own.every((h: any) => h.versionId === state.v2Id),
      `total=${search.json?.total} 该资料命中=${own.length} versionNo=${[...new Set(own.map((h: any) => h.versionNo))].join(",")}`);

    // 断网下旧报告仍带 v1 校验值与停用提示
    const report = await call(base, "GET", `/tasks/${state.taskId}/report`);
    push("6.3", "断网下旧报告仍含 v1 SHA-256 与停用提示",
      report.status === 200 && report.text.includes(state.v1Sha) && report.text.includes("该版本已停用"),
      `reportBytes=${report.text.length} containsV1Sha=${report.text.includes(state.v1Sha)}`);

    // 断网下离线导出
    const exported = await call(base, "GET", `/tasks/${state.taskId}/report-export`);
    const packed = exported.json?.citations?.[0];
    const packedBytes = packed?.snapshot ? Buffer.from(packed.snapshot.bytesBase64, "base64") : null;
    push("7.1", "离线导出打包定版快照与校验信息",
      exported.status === 200 && packed?.verification?.status === "verified"
      && packedBytes !== null && sha256(packedBytes) === state.v1Sha,
      `citations=${exported.json?.citations?.length} snapshotBytes=${packedBytes?.length} recomputed=${packedBytes ? sha256(packedBytes) : null}`,
      { reportSha256: exported.json?.report?.sha256, snapshotSha256: packed?.snapshot?.sha256 });
    if (packedBytes) writeFileSync(join(dirname(outPath), "offline-export-snapshot.md"), packedBytes);
    writeFileSync(join(dirname(outPath), "offline-report-export.json"), JSON.stringify(exported.json, null, 2));

    // 损坏知识库快照：任务侧密封件独立，仍可复验
    rmSync(join(dataRoot, state.v1SnapshotPath), { force: true });
    const afterLibraryLoss = await call(base, "GET", `/tasks/${state.taskId}/citations/${state.citationId}/resolve`);
    push("7.2", "知识库快照缺失时旧报告仍可由任务侧密封件复验",
      afterLibraryLoss.json?.verification?.status === "verified" && afterLibraryLoss.json?.librarySnapshotAvailable === false,
      `verification=${afterLibraryLoss.json?.verification?.status} librarySnapshotAvailable=${afterLibraryLoss.json?.librarySnapshotAvailable}`);

    // 损坏任务侧密封件：必须明确无法复验
    const { DatabaseSync } = await import("node:sqlite");
    const dbPath = taskPaths(join(dataRoot, "tasks", state.taskId)).historyDb;
    const db = new DatabaseSync(dbPath);
    db.prepare("UPDATE evidence_versions SET content = ? WHERE sha256 = ?").run(Buffer.from("tampered-by-acceptance"), state.v1Sha);
    db.close();
    const broken = await call(base, "GET", `/tasks/${state.taskId}/citations/${state.citationId}/resolve`);
    push("7.3", "密封快照损坏时返回 sha256_mismatch 无法复验",
      broken.json?.verification?.status === "unverifiable" && broken.json?.verification?.reason === "sha256_mismatch",
      `reason=${broken.json?.verification?.reason} expected=${broken.json?.verification?.expectedSha256} recomputed=${broken.json?.verification?.recomputedSha256}`,
      broken.json?.verification);
    writeFileSync(join(dirname(outPath), "response-resolve-unverifiable.json"), JSON.stringify(broken.json, null, 2));
    const brokenExport = await call(base, "GET", `/tasks/${state.taskId}/report-export`);
    push("7.4", "损坏快照的离线导出同样标记无法复验",
      brokenExport.json?.citations?.[0]?.verification?.reason === "sha256_mismatch",
      `exportReason=${brokenExport.json?.citations?.[0]?.verification?.reason}`);

    // 删除密封件：snapshot_missing
    const db2 = new DatabaseSync(dbPath);
    db2.exec("PRAGMA foreign_keys = OFF");
    db2.prepare("DELETE FROM evidence_versions WHERE sha256 = ?").run(state.v1Sha);
    db2.close();
    const missing = await call(base, "GET", `/tasks/${state.taskId}/citations/${state.citationId}/resolve`);
    push("7.5", "密封快照缺失时返回 snapshot_missing 无法复验",
      missing.json?.verification?.reason === "snapshot_missing",
      `reason=${missing.json?.verification?.reason}`);
  } finally {
    await plane.close();
  }
  writeFileSync(outPath, JSON.stringify(results, null, 2));
  console.log(`offline phase wrote ${results.length} results to ${outPath}`);
}

// ---------------------------------------------------------------------------
// 阶段一：真实资料导入、检索、定版、修订、停用
// ---------------------------------------------------------------------------
async function main() {
  const runId = `knowledge-${Date.now()}`;
  const evidenceDir = join(repoRoot, "docs", "evidence", "knowledge-library", runId);
  mkdirSync(evidenceDir, { recursive: true });
  const dataRoot = join(repoRoot, "out", runId);
  mkdirSync(dataRoot, { recursive: true });

  const plane = await bootControlPlane({
    dataRoot, host: "127.0.0.1", port: 0, runtime: "local", isolated: true, watchdogMs: 60_000,
    knowledgeEmbedding: { enabled: false },
  });
  const base = plane.url;
  const ENG = `eng-${runId}`;
  console.log(`runId=${runId}\ndataRoot=${dataRoot}\nurl=${base}\nengagementId=${ENG}\n`);

  const makeTask = (engagementId: string, name: string) => {
    const task = plane.store.createTask(CreateTaskRequestSchema.parse({
      name, engagementId,
      auth: { targets: ["knowledge-acceptance.invalid"], authorizationNote: "知识库首版后端验收，靶标为虚构地址" },
      goals: [{ id: "g1", title: "参考资料定版引用", description: "旧报告可按定版回读", evidencePatterns: ["knowledge/*.json"] }],
      mock: true,
    }));
    const paths = taskPaths(task.dataDir);
    const history = openHistory({ dbPath: paths.historyDb, evidenceDir: paths.evidenceDir });
    history.seedGoals(task.id, task.goals);
    history.close();
    return task;
  };
  const task = makeTask(ENG, "知识库首版验收");
  plane.store.finishTask(task, "completed", null);
  const taskBase = `${base}/tasks/${task.id}`;

  // --- 1. 取真实原文 -------------------------------------------------------
  const sources = [
    { key: "nvwabase", repo: "https://github.com/N1nEmAn/nvwabase", ref: "refs/heads/master",
      raw: "https://raw.githubusercontent.com/N1nEmAn/nvwabase/master/README.md", heading: "## 2. The Three-Capability Foundation" },
    { key: "sapperlens", repo: "https://github.com/inwpu/SapperLens", ref: "refs/heads/main",
      raw: "https://raw.githubusercontent.com/inwpu/SapperLens/main/README.md", heading: "### 6.4 状态与连续性" },
    { key: "dsh", repo: "https://github.com/deepseek-ai/dsh-superagent-prototype", ref: "refs/heads/main",
      raw: "https://raw.githubusercontent.com/deepseek-ai/dsh-superagent-prototype/main/docs/001-domain.md", heading: "## Concepts" },
  ];
  const fetched: Record<string, { text: string; commit: string | null; url: string }> = {};
  for (const source of sources) {
    const text = await fetchText(source.raw);
    const commit = gitHead(source.repo, source.ref);
    if (text) {
      fetched[source.key] = { text, commit, url: source.raw };
      writeFileSync(join(evidenceDir, `upstream-${source.key}.md`), text);
    }
    record(`1.${source.key}`, `取上游原文 ${source.key}`, Boolean(text),
      text ? `bytes=${text.length} commit=${commit ?? "未取到"}` : "上游不可达，本条列为缺项，不用演示文本替代",
      { url: source.raw, commit });
  }
  const ledgerPath = join(repoRoot, "docs/experiments/2026-11-22-ledger-relay/README.md");
  const r017Path = join(repoRoot, "docs/absorb-super-agent.md");
  const ledgerText = existsSync(ledgerPath) ? readFileSync(ledgerPath, "utf8") : null;
  const r017Text = existsSync(r017Path) ? readFileSync(r017Path, "utf8") : null;
  const ledgerCommit = gitHead("https://github.com/Sycun/GongYuAI", "refs/heads/main");
  record("1.local", "取本项目真实材料（六批交接实验 / R-017 用例）", Boolean(ledgerText && r017Text),
    `ledgerBytes=${ledgerText?.length ?? 0} r017Bytes=${r017Text?.length ?? 0} upstreamCommit=${ledgerCommit ?? "未取到"}`);

  const nvwaHistory = fetched.nvwabase ? sliceSection(fetched.nvwabase.text, sources[0]!.heading) : null;
  const sapper64 = fetched.sapperlens ? sliceSection(fetched.sapperlens.text, sources[1]!.heading) : null;
  const dshConcepts = fetched.dsh
    ? [sliceSection(fetched.dsh.text, "## Concepts"), sliceSection(fetched.dsh.text, "## Glossary")].filter(Boolean).join("\n\n")
    : null;
  const ledgerSix = ledgerText ? sliceSection(ledgerText, "## 六批、五次交接") : null;
  const r017Section = r017Text ? sliceSection(r017Text, "## 报告交付后收到更正凭据") : null;

  // --- 2. 通过真实 API 导入 -------------------------------------------------
  const importMaterial = async (payload: Record<string, unknown>) => {
    const res = await call(base, "POST", "/knowledge/materials", payload);
    if (res.status !== 201 && res.status !== 200) throw new Error(`导入失败 ${res.status}: ${res.text}`);
    return res;
  };
  const scope = { kind: "engagement", engagementId: ENG };
  const imported: Record<string, any> = {};
  const pinned: Record<string, any> = {};

  if (nvwaHistory) {
    const res = await importMaterial({
      title: "女娲底座 README · History 分层说明", publisher: "N1nEmAn · VarFusion Lab（上游作者）",
      sourceKind: "excerpt", format: "markdown",
      sourceUrl: "https://github.com/N1nEmAn/nvwabase#2-the-three-capability-foundation",
      content: nvwaHistory, tags: ["负责人换班", "分层历史", "History"],
      upstreamCommit: fetched.nvwabase!.commit ?? undefined, scope,
      note: "摘录上游 README 第 2 节，定位到三项能力中的 History。",
    });
    imported.nvwabase = res.json;
    record("2.nvwabase", "导入女娲底座 README 的 History 段", res.json.version.bodyStatus === "ready",
      `materialId=${res.json.material.id} versionId=${res.json.version.id} sha256=${res.json.version.contentSha256} sections=${res.json.sections.length}`,
      { sha256: res.json.version.contentSha256, locators: res.json.sections.map((s: any) => s.locator), upstreamCommit: fetched.nvwabase!.commit });
  }
  if (sapper64) {
    const res = await importMaterial({
      title: "SapperLens §6.4 状态与连续性", publisher: "inwpu（独立运行分析）",
      sourceKind: "excerpt", format: "markdown",
      sourceUrl: "https://github.com/inwpu/SapperLens#64-状态与连续性",
      content: sapper64, tags: ["负责人换班", "状态与连续性", "Commander 交接"],
      upstreamCommit: fetched.sapperlens!.commit ?? undefined, scope,
      note: "摘录独立分析第 6.4 节，含 06:14 换任的 STATE 文件示例。",
    });
    imported.sapperlens = res.json;
    record("2.sapperlens", "导入 SapperLens §6.4「状态与连续性」", res.json.version.bodyStatus === "ready",
      `materialId=${res.json.material.id} versionId=${res.json.version.id} sha256=${res.json.version.contentSha256} locators=${res.json.sections.map((s: any) => s.locator).join(",")}`,
      { sha256: res.json.version.contentSha256, upstreamCommit: fetched.sapperlens!.commit });
  }
  if (ledgerSix) {
    const res = await importMaterial({
      title: "本项目六批交接实验 · 六批、五次交接", publisher: "GongYuAI（本项目实验）",
      sourceKind: "excerpt", format: "markdown",
      sourceUrl: "https://github.com/Sycun/GongYuAI/blob/main/docs/experiments/2026-11-22-ledger-relay/README.md#六批五次交接",
      content: ledgerSix, tags: ["负责人换班", "Relay", "六批五次交接"],
      upstreamCommit: ledgerCommit ?? undefined, scope,
      note: "摘录本项目实验 README 的「六批、五次交接」一节；只覆盖六份合成台账。",
    });
    imported.ledger = res.json;
    record("2.ledger", "导入六批交接实验的「六批、五次交接」", res.json.version.bodyStatus === "ready",
      `materialId=${res.json.material.id} sha256=${res.json.version.contentSha256} 含54/60=${ledgerSix.includes("54/60")}`,
      { sha256: res.json.version.contentSha256 });
  }
  if (dshConcepts) {
    const res = await importMaterial({
      title: "DeepSeek Super-agent 原型 · 领域模型与术语表", publisher: "deepseek-ai（原型文档）",
      sourceKind: "excerpt", format: "markdown",
      sourceUrl: "https://github.com/deepseek-ai/dsh-superagent-prototype/blob/main/docs/001-domain.md",
      content: dshConcepts, tags: ["更正回函", "工作项", "工单", "派工", "授权"],
      upstreamCommit: fetched.dsh!.commit ?? undefined, scope,
      note: "摘录 Concepts 与 Glossary 两节；Ticket（工单）即设计文档所称工作项。",
    });
    imported.dsh = res.json;
    record("2.dsh", "导入 DeepSeek 原型领域模型（工作项/派工/授权）", res.json.version.bodyStatus === "ready",
      `materialId=${res.json.material.id} sha256=${res.json.version.contentSha256} 含Ticket=${dshConcepts.includes("Ticket")} 含派工=${dshConcepts.includes("派工")}`,
      { sha256: res.json.version.contentSha256, upstreamCommit: fetched.dsh!.commit });
  }
  if (r017Section) {
    const res = await importMaterial({
      title: "本项目 R-017 补证用例 · 报告交付后收到更正凭据", publisher: "GongYuAI（本项目合成验收）",
      sourceKind: "excerpt", format: "markdown",
      sourceUrl: "https://github.com/Sycun/GongYuAI/blob/main/docs/absorb-super-agent.md#报告交付后收到更正凭据",
      content: r017Section, tags: ["更正回函", "R-017", "归属与签收"],
      upstreamCommit: ledgerCommit ?? undefined, scope,
      note: "摘录本项目合成验收用例；属本项目材料，不是上游作者研究。",
    });
    imported.r017 = res.json;
    record("2.r017", "导入本项目 R-017 补证用例", res.json.version.bodyStatus === "ready",
      `materialId=${res.json.material.id} sha256=${res.json.version.contentSha256} 含更正回函=${r017Section.includes("更正回函")}`,
      { sha256: res.json.version.contentSha256 });
  }

  // 编辑导读：单独标明，不计入真实文章验收
  const editorial = await importMaterial({
    title: "编辑导读 · 三种来源怎样区分负责人换班", publisher: "GongYuAI 验收编辑（导读，非原文）",
    sourceKind: "editorial", format: "markdown",
    sourceUrl: "https://github.com/Sycun/GongYuAI/blob/main/docs/memory-layer.md#knowledge-library",
    content: "## 导读\n\n负责人换班在三份材料里含义不同：女娲底座是作者设计，SapperLens 是独立分析观察到的实际换任，本项目实验只覆盖六批合成台账。",
    tags: ["负责人换班"], scope,
    note: "本条为编辑导读，不是任何上游原文；真实文章验收只计 nvwabase / SapperLens / 本项目实验三条。",
  });
  record("2.editorial", "编辑导读单独成条并标明来源类型", editorial.json.material.sourceKind === "editorial",
    `sourceKind=${editorial.json.material.sourceKind}（不计入真实文章验收）`);

  const realCount = ["nvwabase", "sapperlens", "ledger"].filter((k) => imported[k]).length;
  record("2.summary", "三份必需真实资料均已导入", realCount === 3, `已导入 ${realCount}/3；缺项见各条 FAIL`);

  // --- 2b. 真实 PDF 正文提取 -------------------------------------------------
  const pdfFiles = [
    { key: "memgpt", path: "docs/2310.08560v2.pdf", title: "MemGPT: Towards LLMs as Operating Systems", marker: "MemGPT" },
    { key: "attackpath", path: "docs/Staying on the Attack Path.pdf", title: "Staying on the Attack Path", marker: "Attack Path" },
  ];
  for (const pdf of pdfFiles) {
    const abs = join(repoRoot, pdf.path);
    if (!existsSync(abs)) {
      record(`2.pdf.${pdf.key}`, `真实 PDF 正文提取 ${pdf.key}`, false, `仓库内缺少 ${pdf.path}，列为缺项`);
      continue;
    }
    const bytes = readFileSync(abs);
    const res = await call(base, "POST", "/knowledge/materials", {
      title: pdf.title, publisher: "上游作者（PDF 原文）", sourceKind: "original", format: "pdf",
      sourceUrl: `https://github.com/Sycun/GongYuAI/blob/main/${pdf.path}`,
      contentBase64: bytes.toString("base64"), tags: ["长程 Agent"], scope,
      note: `仓库内真实 PDF，文件 SHA-256 ${sha256(bytes)}。`,
    });
    const ok = res.status === 201 && res.json.version.bodyStatus === "ready"
      && res.json.sections.length > 0 && res.json.sections[0].page === 1
      && res.json.sections.some((s: any) => s.text.includes(pdf.marker));
    record(`2.pdf.${pdf.key}`, `真实 PDF 正文提取 ${pdf.key}`, ok,
      `status=${res.status} bodyStatus=${res.json?.version?.bodyStatus} pages=${res.json?.sections?.length} firstLocator=${res.json?.sections?.[0]?.locator} fileSha256=${sha256(bytes)}`,
      { fileSha256: sha256(bytes), contentSha256: res.json?.version?.contentSha256, pages: res.json?.sections?.length });
    if (ok) {
      const hit = await call(base, "GET", `/knowledge/search?q=${encodeURIComponent(pdf.marker)}&engagementId=${ENG}`);
      const own = (hit.json.hits as any[]).find((h) => h.materialId === res.json.material.id);
      record(`2.pdf.${pdf.key}.search`, `PDF 正文可检索并按页定位 ${pdf.key}`,
        Boolean(own) && own.matchedFields.includes("body") && own.page !== null,
        `total=${hit.json.total} matchedFields=${own?.matchedFields} locator=${own?.locator} page=${own?.page}`);
    }
  }

  // --- 3. 搜「负责人换班」并逐条打开命中段落 --------------------------------
  const q = encodeURIComponent("负责人换班");
  const search = await call(base, "GET", `/knowledge/search?q=${q}&engagementId=${ENG}`);
  writeFileSync(join(evidenceDir, "response-search-handover.json"), JSON.stringify(search.json, null, 2));
  const opened: unknown[] = [];
  for (const hit of search.json.hits as any[]) {
    const section = await call(base, "GET",
      `/knowledge/materials/${hit.materialId}/versions/${hit.versionId}/section?locator=${encodeURIComponent(hit.locator)}&engagementId=${ENG}`);
    opened.push({
      title: hit.title, sourceKind: hit.sourceKind, matchedFields: hit.matchedFields, tagOnly: hit.tagOnly,
      locator: hit.locator, sectionStatus: section.status,
      heading: section.json?.section?.heading, paragraphHead: section.json?.section?.text?.slice(0, 120),
    });
  }
  const realHits = (search.json.hits as any[]).filter((h) => h.sourceKind !== "editorial");
  record("3.1", "搜「负责人换班」命中三种真实来源并可逐条打开",
    realHits.length >= 3 && opened.every((o: any) => o.sectionStatus === 200),
    `total=${search.json.total} materials=${search.json.materials} 真实来源命中=${realHits.length}（另有编辑导读 ${search.json.hits.length - realHits.length} 条）`,
    opened);
  record("3.2", "命中字段如实标识：正文未出现该词时只标标签命中",
    realHits.every((h) => h.tagOnly === true && h.matchedFields.join() === "tags"),
    `三份真实原文正文均不含「负责人换班」整词（SapperLens 用「换任」、实验用「换班」），故全部为标签命中；编辑导读为正文字面命中`,
    realHits.map((h) => ({ title: h.title, matchedFields: h.matchedFields, tagOnly: h.tagOnly })));

  const bodySearch = await call(base, "GET", `/knowledge/search?q=${encodeURIComponent("换任")}&engagementId=${ENG}`);
  const ledgerSearch = await call(base, "GET", `/knowledge/search?q=${encodeURIComponent("换班 54/60")}&engagementId=${ENG}`);
  // 整篇切片后同一份资料会有多个片段命中，且编辑导读也字面含「换任」；
  // 因此按资料筛选后再看首条，而不是拿全局首条当该资料的代表。
  const sapperBodyHit = (bodySearch.json.hits as any[]).find((h) => h.title.includes("SapperLens"));
  record("3.3", "正文字面命中可验证：换任 → SapperLens，换班 54/60 → 本项目实验",
    Boolean(sapperBodyHit) && sapperBodyHit.matchedFields.includes("body")
    && ledgerSearch.json.hits[0]?.title?.includes("六批交接实验"),
    `换任 total=${bodySearch.json.total}；SapperLens 首个命中片段=${sapperBodyHit?.locator} fields=${sapperBodyHit?.matchedFields}；换班 54/60 total=${ledgerSearch.json.total} title=${ledgerSearch.json.hits[0]?.title}`,
    { sapperLocator: sapperBodyHit?.locator, sapperContext: sapperBodyHit?.context, ledgerContext: ledgerSearch.json.hits[0]?.context });

  // --- 4. 搜「更正回函」----------------------------------------------------
  const correctionSearch = await call(base, "GET", `/knowledge/search?q=${encodeURIComponent("更正回函")}&engagementId=${ENG}`);
  const titles = (correctionSearch.json.hits as any[]).map((h) => h.title);
  const r017Hit = (correctionSearch.json.hits as any[]).find((h) => h.title.includes("R-017"));
  const dshHit = (correctionSearch.json.hits as any[]).find((h) => h.title.includes("DeepSeek"));
  record("4.1", "搜「更正回函」：本项目用例定位到 R-017 验收，原型定位到工作项定义",
    Boolean(r017Hit && dshHit) && r017Hit.matchedFields.includes("body"),
    `total=${correctionSearch.json.total}；R-017 命中字段=${r017Hit?.matchedFields}（正文字面含「更正回函」），原型命中字段=${dshHit?.matchedFields}（标签命中，正文为英文 Ticket/工单）`,
    { titles, r017Locator: r017Hit?.locator, dshLocator: dshHit?.locator });
  if (dshHit) {
    const glossary = await call(base, "GET",
      `/knowledge/materials/${dshHit.materialId}/versions/${dshHit.versionId}/section?locator=${encodeURIComponent("§Glossary")}&engagementId=${ENG}`);
    // Glossary 现在会被切成多片，整章原文从 context.parentText 回读。
    const glossaryText = glossary.json?.context?.parentText ?? glossary.json?.section?.text ?? "";
    record("4.2", "原型可下钻到工作项（Ticket/工单）、派工、授权定义",
      glossary.status === 200 && glossaryText.includes("工单") && glossaryText.includes("派工") && glossaryText.includes("授权"),
      `locator=§Glossary status=${glossary.status} 整章字节=${glossaryText.length} 含工单=${glossaryText.includes("工单")} 含派工=${glossaryText.includes("派工")} 含授权=${glossaryText.includes("授权")}`);
  }

  // --- 5. 重放 v1、定版引用、导入 v2、停用 v1 -------------------------------
  if (!imported.sapperlens || !sapper64) {
    record("5.0", "SapperLens 定版链路", false, "缺上游原文，跳过；不以演示文本替代");
  } else {
    const materialId = imported.sapperlens.material.id;
    const v1 = imported.sapperlens.version;
    const replayPayload = {
      title: "SapperLens §6.4 状态与连续性", publisher: "inwpu（独立运行分析）",
      sourceKind: "excerpt", format: "markdown",
      sourceUrl: "https://github.com/inwpu/SapperLens#64-状态与连续性",
      content: sapper64, tags: ["负责人换班", "状态与连续性", "Commander 交接"],
      upstreamCommit: fetched.sapperlens!.commit ?? undefined, scope,
    };
    const replays = await Promise.all([0, 1, 2].map(() => call(base, "POST", "/knowledge/materials", replayPayload)));
    const detail = await call(base, "GET", `/knowledge/materials/${materialId}?engagementId=${ENG}`);
    writeFileSync(join(evidenceDir, "response-material-detail.json"), JSON.stringify(detail.json, null, 2));
    record("5.1", "重放相同导入（含 3 次并发）版本数不增加",
      replays.every((r) => r.json.reused === true && r.json.version.id === v1.id) && detail.json.material.versionCount === 1,
      `reused=${replays.map((r) => r.json.reused).join(",")} versionCount=${detail.json.material.versionCount}`);

    const cited = await call(base, "POST", `/tasks/${task.id}/citations`, {
      materialId, versionId: v1.id, locator: "§6.4",
      claim: "独立分析从运行记录中追到了一次负责人换班（06:14 换任，靠 STATE 续接）",
    });
    record("5.2", "通过报告引用 API 固定 §6.4 到 v1",
      cited.status === 201 && cited.json.citation.snapshotSha256 === v1.contentSha256,
      `citationId=${cited.json?.citation?.id} snapshotSha256=${cited.json?.citation?.snapshotSha256} versionLabel=${cited.json?.citation?.versionLabel}`,
      cited.json?.citation);

    const v2Content = `${sapper64}\n\n> 验收修订 v2：本段为知识库首版验收追加的修订标记，不改动上游原文语义。`;
    const revised = await call(base, "POST", "/knowledge/materials", {
      ...replayPayload, content: v2Content, upstreamVersion: "验收修订 v2",
      note: "明确标记为验收修订的 v2，用于验证旧版停用后旧报告仍回读 v1。",
    });
    const v2 = revised.json.version;
    record("5.3", "导入明确标记为验收修订的 v2 并保留 v1 快照",
      revised.status === 201 && v2.versionNo === 2 && v2.contentSha256 !== v1.contentSha256
      && existsSync(join(dataRoot, v1.snapshotPath)),
      `v2Id=${v2.id} v2Sha=${v2.contentSha256} v1Sha=${v1.contentSha256} v1SnapshotStillPresent=${existsSync(join(dataRoot, v1.snapshotPath))}`,
      { v1Sha256: v1.contentSha256, v2Sha256: v2.contentSha256, v1SnapshotPath: v1.snapshotPath });

    const deprecated = await call(base, "POST",
      `/knowledge/materials/${materialId}/versions/${v1.id}/deprecate?engagementId=${ENG}`,
      { reason: "验收修订 v2 已导入，停用 v1" });
    record("5.4", "停用 v1", deprecated.status === 200 && deprecated.json.version.status === "deprecated",
      `status=${deprecated.json?.version?.status} deprecatedAt=${deprecated.json?.version?.deprecatedAt}`);

    // 引用现在按原文范围定版，因此用「范围切出的字节」而不是某个标记子串来判定同一段。
    const state = {
      taskId: task.id, engagementId: ENG, materialId, citationId: cited.json.citation.id,
      v1Id: v1.id, v2Id: v2.id, v1Sha: v1.contentSha256, v2Sha: v2.contentSha256,
      v1SnapshotPath: v1.snapshotPath,
      charStart: cited.json.citation.charStart, charEnd: cited.json.citation.charEnd,
      pinnedText: sapper64.slice(cited.json.citation.charStart, cited.json.citation.charEnd),
      chunkSha256: cited.json.citation.chunkSha256,
      v2Marker: "验收修订 v2",
    };
    Object.assign(pinned, {
      materialId, citationId: cited.json.citation.id,
      v1Id: v1.id, v1Sha: v1.contentSha256, v2Id: v2.id, v2Sha: v2.contentSha256,
      v1SnapshotPath: v1.snapshotPath, locator: "§6.4",
    });
    const statePath = join(evidenceDir, "offline-state.json");
    writeFileSync(statePath, JSON.stringify(state, null, 2));

    // --- 6/7. 断网子进程重启回读 ---
    const offlineOut = join(evidenceDir, "offline-steps.json");
    const child = spawnSync(process.execPath, [
      "--import", "tsx", fileURLToPath(import.meta.url),
      "--offline", "--data-root", dataRoot, "--state", statePath, "--out", offlineOut,
    ], { cwd: repoRoot, encoding: "utf8", timeout: 180_000 });
    const offlineOk = child.status === 0 && existsSync(offlineOut);
    record("6.0", "断网子进程重启服务（出站连接一律抛错）", offlineOk,
      `exit=${child.status}${child.stderr ? ` stderr=${child.stderr.slice(-400)}` : ""}`);
    if (offlineOk) {
      const offlineSteps = JSON.parse(readFileSync(offlineOut, "utf8")) as Step[];
      steps.push(...offlineSteps);
      for (const step of offlineSteps) console.log(`${step.passed ? "PASS" : "FAIL"}  ${step.id}  ${step.title}\n      ${step.detail}`);
    }
  }

  // --- 8. 委托 A/B 隔离双向验证 --------------------------------------------
  const ENG_A = `${ENG}-alpha`;
  const ENG_B = `${ENG}-beta`;
  const taskA = makeTask(ENG_A, "隔离验收 委托A");
  const taskB = makeTask(ENG_B, "隔离验收 委托B");
  plane.store.finishTask(taskA, "completed", null);
  plane.store.finishTask(taskB, "completed", null);
  const isoImport = async (isoScope: unknown, title: string, keyword: string) => {
    const res = await call(base, "POST", "/knowledge/materials", {
      title, publisher: "隔离验收", sourceKind: "original", format: "markdown",
      sourceUrl: `https://example.invalid/${encodeURIComponent(title)}`,
      content: `## ${title}\n\n本段包含 ${keyword}，仅用于委托边界验收（合成材料，不计入真实文章验收）。`,
      tags: [keyword], scope: isoScope,
    });
    return { materialId: res.json.material.id, versionId: res.json.version.id, locator: res.json.sections[0].locator };
  };
  const onlyA = await isoImport({ kind: "engagement", engagementId: ENG_A }, "委托A专属材料", "阿尔法专属关键词");
  const onlyB = await isoImport({ kind: "engagement", engagementId: ENG_B }, "委托B专属材料", "贝塔专属关键词");
  const shared = await isoImport({ kind: "shared" }, "团队共享材料", "伽马共享关键词");

  const isoRows: unknown[] = [];
  for (const [reader, own, other] of [[ENG_A, "阿尔法专属关键词", "贝塔专属关键词"], [ENG_B, "贝塔专属关键词", "阿尔法专属关键词"]] as const) {
    const ownHit = await call(base, "GET", `/knowledge/search?q=${encodeURIComponent(own)}&engagementId=${reader}`);
    const otherHit = await call(base, "GET", `/knowledge/search?q=${encodeURIComponent(other)}&engagementId=${reader}`);
    const sharedHit = await call(base, "GET", `/knowledge/search?q=${encodeURIComponent("伽马共享关键词")}&engagementId=${reader}`);
    const summary = await call(base, "GET", `/knowledge/summary?engagementId=${reader}`);
    isoRows.push({ reader, ownTotal: ownHit.json.total, otherTotal: otherHit.json.total, sharedTotal: sharedHit.json.total, materials: summary.json.materials });
  }
  record("8.1", "检索与计数双向不泄露，共享资料两边可见",
    isoRows.every((r: any) => r.ownTotal === 1 && r.otherTotal === 0 && r.sharedTotal === 1 && r.materials === 2),
    JSON.stringify(isoRows), isoRows);

  const directRows: unknown[] = [];
  for (const [reader, target] of [[ENG_B, onlyA], [ENG_A, onlyB]] as const) {
    const detail = await call(base, "GET", `/knowledge/materials/${target.materialId}?engagementId=${reader}`);
    const versions = await call(base, "GET", `/knowledge/materials/${target.materialId}/versions?engagementId=${reader}`);
    const version = await call(base, "GET", `/knowledge/materials/${target.materialId}/versions/${target.versionId}?engagementId=${reader}`);
    const section = await call(base, "GET", `/knowledge/materials/${target.materialId}/versions/${target.versionId}/section?locator=${encodeURIComponent(target.locator)}&engagementId=${reader}`);
    directRows.push({ reader, detail: detail.status, versions: versions.status, version: version.status, section: section.status, leakedTitle: detail.text.includes("专属材料") });
  }
  record("8.2", "已知 ID 直接读取资料/版本/段落一律 404，且不泄露标题",
    directRows.every((r: any) => r.detail === 404 && r.versions === 404 && r.version === 404 && r.section === 404 && !r.leakedTitle),
    JSON.stringify(directRows), directRows);

  const crossAB = await call(base, "POST", `/tasks/${taskB.id}/citations`, {
    materialId: onlyA.materialId, versionId: onlyA.versionId, locator: onlyA.locator, claim: "B 试图引用 A 的材料" });
  const crossBA = await call(base, "POST", `/tasks/${taskA.id}/citations`, {
    materialId: onlyB.materialId, versionId: onlyB.versionId, locator: onlyB.locator, claim: "A 试图引用 B 的材料" });
  record("8.3", "跨委托创建引用双向被拒", crossAB.status === 404 && crossBA.status === 404,
    `B→A=${crossAB.status} A→B=${crossBA.status}`);

  for (const [t, x, claim] of [[taskA, onlyA, "A 的表述"], [taskA, shared, "A 引用共享"], [taskB, onlyB, "B 的表述"], [taskB, shared, "B 引用共享"]] as const) {
    await call(base, "POST", `/tasks/${t.id}/citations`, { materialId: x.materialId, versionId: x.versionId, locator: x.locator, claim });
  }
  const exportA = await call(base, "GET", `/tasks/${taskA.id}/report-export`);
  const exportB = await call(base, "GET", `/tasks/${taskB.id}/report-export`);
  record("8.4", "报告导出双向不泄露另一委托的材料 ID 与关键词",
    exportA.json.citations.length === 2 && exportB.json.citations.length === 2
    && !exportA.text.includes("贝塔专属关键词") && !exportA.text.includes(onlyB.materialId)
    && !exportB.text.includes("阿尔法专属关键词") && !exportB.text.includes(onlyA.materialId),
    `A citations=${exportA.json.citations.length} B citations=${exportB.json.citations.length}；A 含 B 关键词=${exportA.text.includes("贝塔专属关键词")}；B 含 A 关键词=${exportB.text.includes("阿尔法专属关键词")}`);

  const conflict = await call(base, "GET", `/tasks/${taskA.id}/citations?engagementId=${ENG_B}`);
  const anchored = await call(base, "GET", `/knowledge/summary?taskId=${taskA.id}`);
  const anchorConflict = await call(base, "GET", `/knowledge/summary?taskId=${taskA.id}&engagementId=${ENG_B}`);
  record("8.5", "客户端 engagementId 只能定位：冲突拒绝，任务归属以服务端为准",
    conflict.status === 409 && anchorConflict.status === 409 && anchored.json.scope.resolvedFrom === "task" && anchored.json.scope.engagementId === ENG_A,
    `冲突=${conflict.status}/${anchorConflict.status}；taskId 锚定 resolvedFrom=${anchored.json.scope.resolvedFrom} engagementId=${anchored.json.scope.engagementId}`);

  record("9.1", "单操作者环境的权限验证边界已如实记录",
    anchored.json.scope.userLevelPermissionVerified === false && anchored.json.scope.operatorModel === "single-operator",
    "本运行环境无认证层：委托边界按服务端任务归属与声明上下文验收；用户级权限（谁能声明哪个委托）未验证，已在契约与本记录中标明。",
    anchored.json.scope);

  await plane.close();

  const passed = steps.filter((s) => s.passed).length;
  const summary = {
    runId, generatedAt: new Date().toISOString(), dataRoot, engagementId: ENG,
    taskId: task.id, totals: { steps: steps.length, passed, failed: steps.length - passed },
    upstream: Object.fromEntries(Object.entries(fetched).map(([k, v]) => [k, { url: v.url, commit: v.commit, bytes: v.text.length }])),
    localCommit: ledgerCommit,
    steps,
  };
  writeFileSync(join(evidenceDir, "acceptance-record.json"), JSON.stringify(summary, null, 2));
  const sourceRows = Object.entries(imported).map(([key, value]) => {
    const upstream = fetched[key];
    return `| ${key} | ${value.material.title} | ${value.material.sourceKind} | \`${value.version.contentSha256}\` | ${upstream ? `\`${upstream.commit ?? "未取到"}\`` : "本项目材料"} |`;
  });
  const md = [
    "# 知识库首版后端验收记录", "",
    `运行编号：${runId}　生成时间：${summary.generatedAt}`, "",
    `数据根（隔离）：\`${dataRoot}\`　服务：真实进程 + 回环 HTTP`, "",
    `结果：${passed}/${steps.length} 通过，${steps.length - passed} 未通过。`, "",
    "复现：`pnpm knowledge:acceptance`（数据根隔离在 `out/`，不触碰正式 `.gongyuai`）。", "",
    "## 上游来源与 commit", "",
    "| 来源 | 原文地址 | commit | 字节 |", "| --- | --- | --- | ---: |",
    ...Object.entries(fetched).map(([k, v]) => `| ${k} | ${v.url} | \`${v.commit ?? "未取到"}\` | ${v.text.length} |`),
    "", `本项目材料上游 commit：\`${ledgerCommit ?? "未取到"}\`（六批交接实验 README、R-017 用例）。`, "",
    "## 实际导入的资料与内容 SHA-256", "",
    "| 键 | 标题 | 来源类型 | 内容 SHA-256 | 上游 commit |", "| --- | --- | --- | --- | --- |",
    ...sourceRows,
    "", "编辑导读单独成条（`sourceKind=editorial`），**不计入真实文章验收**。", "",
    "## 定版引用的 v1 / v2 校验值", "",
    pinned.v1Sha ? [
      `资料 ID：\`${pinned.materialId}\`　引用 ID：\`${pinned.citationId}\`　段落定位：\`${pinned.locator}\``, "",
      "| 版本 | 版本 ID | 内容 SHA-256 |", "| --- | --- | --- |",
      `| 本地 v1（已停用，旧报告仍按此回读） | \`${pinned.v1Id}\` | \`${pinned.v1Sha}\` |`,
      `| 本地 v2（验收修订，当前有效版） | \`${pinned.v2Id}\` | \`${pinned.v2Sha}\` |`, "",
      `v1 快照路径：\`${pinned.v1SnapshotPath}\`；断网重启后复算值与 v1 原值相等（见 6.1）。`,
    ].join("\n") : "缺 SapperLens 原文，未执行定版链路。",
    "",
    "## 隔离测试入口", "",
    "| 入口 | 覆盖 | 命令 |", "| --- | --- | --- |",
    "| `packages/control-plane/src/knowledge.test.ts` | 预览/待补正文/幂等重放/并发成版/中文检索与命中字段/定版回读/快照缺失损坏/PDF/三类来源/历史段落/失败不留半写入（11 项） | `node --import tsx --test packages/control-plane/src/knowledge.test.ts` |",
    "| `packages/control-plane/src/knowledge-isolation.test.ts` | 委托 A/B 双向：检索计数、已知 ID 直读、跨委托引用、engagementId 冲突、报告导出、同来源跨委托各自成库（6 项） | `node --import tsx --test packages/control-plane/src/knowledge-isolation.test.ts` |",
    "",
    "实际响应落盘：`response-search-handover.json`、`response-material-detail.json`、`response-resolve-verified.json`、`response-resolve-unverifiable.json`、`offline-report-export.json`、`offline-export-snapshot.md`。", "",
    "## 未通过或未执行的事项", "",
    "- **控制台导航、页面与交互**：本轮不实现，由控制台侧另行交付；接口契约见 [knowledge-library-api.md](../../../knowledge-library-api.md)。",
    "- **用户级权限**：当前运行环境单操作者、无认证层。已验收的是委托边界（范围校验、越界 404、导出不泄露）；“谁有权声明哪个委托”未验证，`scope.userLevelPermissionVerified` 恒为 `false`。",
    "- **项目经验图、向量/语义检索、自动蒸馏**：不在首版范围，未执行。",
    "- **「负责人换班」的正文命中**：三份真实原文正文均不含该整词（SapperLens 写「换任」、实验写「换班」、女娲 README 为英文），因此全部为**标签命中**并如实标识；正文字面命中另用「换任」「换班 54/60」验证（3.3）。编辑导读一条为正文命中，但不计入真实文章验收。",
    "- **PDF 页面定位**：按页面对象树顺序给出 `p.N`；扫描件、加密或字体无 ToUnicode 映射的 PDF 标记为待补正文，不编造内容。已用仓库内两份真实 PDF 验证可提取（57 页 / 70 页）。",
    "- **断网前提的实现方式**：子进程清除环境代理并按主机名拒绝非回环出站（fetch/TLS/HTTP/DNS），正对照确认上游 fetch 被拒（6.0a）。这是进程级阻断，不是物理断网。",
    "- **真实跨周交接与独立人员盲读**：沿用既有边界，本轮未执行。",
    "", "## 逐项结果", "",
    "| 编号 | 验收动作 | 结果 | 观察 |", "| --- | --- | --- | --- |",
    ...steps.map((s) => `| ${s.id} | ${s.title} | ${s.passed ? "通过" : "**未通过**"} | ${s.detail.replace(/\|/g, "\\|").replace(/\n/g, " ")} |`),
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
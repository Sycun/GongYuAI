/**
 * A3 双写入方并发验收（验收项 4）。
 *
 * 原 A3 用例在**一个** store 上顺序调用撤回与断言，只证明调用顺序语义。
 * 这里另起两个真正的写入方：
 * - 两个独立 SQLite 连接（同一进程内两次 openHistory）；
 * - 两个独立进程（各自 openHistory），通过标记文件精确控制提交先后。
 *
 * 断言的内容：目标状态、首次通过时冻结的 Finding ID、证据版本、事件数与
 * 归属行数——既不能重复记账，也不能半写入。
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { openHistory, type HistoryStore } from "./index.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..", "..", "..");
const WRITER = join(REPO_ROOT, "scripts", "a3-writer.ts");

function setup(prefix: string) {
  const root = mkdtempSync(join(tmpdir(), prefix));
  const evidenceDir = join(root, "evidence");
  const dbPath = join(root, "history.sqlite");
  mkdirSync(evidenceDir, { recursive: true });
  const store = openHistory({ dbPath, evidenceDir });
  return { root, evidenceDir, dbPath, store };
}

function writeEvidence(evidenceDir: string, path: string, body: string) {
  mkdirSync(join(evidenceDir, path, ".."), { recursive: true });
  writeFileSync(join(evidenceDir, path), body);
}

function verifiedFinding(
  store: HistoryStore,
  taskId: string,
  evidenceDir: string,
  asset: string,
  vulnClass = "CWE-89",
) {
  const proof = `findings/${randomUUID()}.txt`;
  writeEvidence(evidenceDir, proof, `request/response proof ${proof}\n`);
  const { finding } = store.recordFinding({
    taskId,
    title: `finding on ${asset}`,
    asset,
    vulnClass,
    severity: "high",
  });
  return store.verifyFinding(taskId, finding.id, { evidencePaths: [proof], repro: "curl …" });
}

function goal(id: string, pattern: string) {
  return {
    id,
    title: id,
    description: `${id} 至少一条本资产已验证发现`,
    assets: ["a.example.com"],
    evidencePatterns: [pattern],
    findingsGate: { minVerified: 1, scope: "goal" as const, assets: ["a.example.com"] },
    passes: false,
    evidencePaths: [],
    assertedAt: null,
  };
}

function spawnWriter(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", WRITER, ...args], {
      cwd: REPO_ROOT,
      env: { ...process.env },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    child.on("error", reject);
    child.on("close", (code) => resolvePromise({ code: code ?? -1, stdout, stderr }));
  });
}

function readWriterOut(path: string): { ok: boolean; reason?: string; passes?: boolean } {
  assert.ok(existsSync(path), `writer 没有写出结果：${path}`);
  return JSON.parse(readFileSync(path, "utf8")) as { ok: boolean; reason?: string; passes?: boolean };
}

function counts(store: HistoryStore, taskId: string, goalId: string) {
  const events = store.listEvents(taskId, 500);
  return {
    asserted: events.filter((event) => event.kind === "goal_asserted" &&
      String((event.payload as { goalId?: string }).goalId) === goalId).length,
    retracted: events.filter((event) => event.kind === "finding_retracted").length,
    supportRows: store.listGoalFindings(taskId).filter((row) => row.goalId === goalId).length,
    proofs: store.listGoalProofs(taskId).filter((row) => row.goalId === goalId).length,
  };
}

test("A3-并发 1：两个独立连接，撤回先提交则首次断言失败，且没有半写入", () => {
  const { root, evidenceDir, dbPath, store } = setup("gy-a3c1-");
  const taskId = randomUUID();
  const second = openHistory({ dbPath, evidenceDir });
  try {
    store.seedGoals(taskId, [goal("g", "goal/g.md")]);
    writeEvidence(evidenceDir, "goal/g.md", "g\n");
    const finding = verifiedFinding(store, taskId, evidenceDir, "a.example.com");

    // 写入方 B（第二个连接）先撤回并提交。
    second.retractFinding(taskId, finding.id, "独立连接：撤回先提交");

    // 写入方 A（第一个连接）随后断言：必须看不到这条已被撤回的发现。
    const result = store.assertGoal(taskId, "g", ["goal/g.md"]);
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.reason, /findings gate/);

    const state = store.listGoals(taskId).find((entry) => entry.id === "g")!;
    assert.equal(state.passes, false, "首次通过不得成立");
    const counters = counts(store, taskId, "g");
    assert.deepEqual(counters, { asserted: 0, retracted: 1, supportRows: 0, proofs: 0 },
      "失败断言不得写入归属行、证据版本或通过事件");
    assert.equal(store.scorecard(taskId).currentlySupported, 0);
  } finally {
    second.close();
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("A3-并发 2：两个进程，撤回进程提交后断言进程才动手 → 首次通过不成立", async () => {
  const { root, evidenceDir, dbPath, store } = setup("gy-a3c2-");
  const taskId = randomUUID();
  try {
    store.seedGoals(taskId, [goal("g", "goal/g.md")]);
    writeEvidence(evidenceDir, "goal/g.md", "g\n");
    const finding = verifiedFinding(store, taskId, evidenceDir, "a.example.com");

    const marker = join(root, "retract.committed");
    const retractOut = join(root, "retract.json");
    const assertOut = join(root, "assert.json");
    const common = ["--db", dbPath, "--evidence", evidenceDir, "--task", taskId];
    // 同步点：断言进程等撤回进程写出 marker 后才打开事务。
    const retractWriter = spawnWriter([...common, "--action", "retract", "--finding", finding.id,
      "--signal", marker, "--out", retractOut]);
    const assertWriter = spawnWriter([...common, "--action", "assert", "--goal", "g",
      "--pattern", "goal/g.md", "--wait-for", marker, "--out", assertOut]);

    const [retracted, asserted] = await Promise.all([retractWriter, assertWriter]);
    assert.equal(retracted.code, 0, retracted.stderr);
    assert.equal(asserted.code, 0, asserted.stderr);
    assert.equal(readWriterOut(retractOut).ok, true);
    const outcome = readWriterOut(assertOut);
    assert.equal(outcome.ok, false, "撤回已提交，跨进程首次断言不得成立");
    assert.match(outcome.reason ?? "", /findings gate/);

    const state = store.listGoals(taskId).find((entry) => entry.id === "g")!;
    assert.equal(state.passes, false);
    assert.deepEqual(counts(store, taskId, "g"), { asserted: 0, retracted: 1, supportRows: 0, proofs: 0 });
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("A3-并发 3：两个进程，首次通过先提交 → 依据完整保留，撤回后当前结论正确变化", async () => {
  const { root, evidenceDir, dbPath, store } = setup("gy-a3c3-");
  const taskId = randomUUID();
  try {
    store.seedGoals(taskId, [goal("g", "goal/g.md")]);
    writeEvidence(evidenceDir, "goal/g.md", "g\n");
    const finding = verifiedFinding(store, taskId, evidenceDir, "a.example.com");
    const findingProofPath = finding.evidence[0]!.path;
    const findingProofSha = createHash("sha256").update(readFileSync(join(evidenceDir, findingProofPath))).digest("hex");
    assert.equal(findingProofSha, finding.evidence[0]!.sha256, "落盘证据与记录里的哈希一致");
    const goalSha = createHash("sha256").update(readFileSync(join(evidenceDir, "goal/g.md"))).digest("hex");

    const marker = join(root, "assert.committed");
    const assertOut = join(root, "assert.json");
    const retractOut = join(root, "retract.json");
    const common = ["--db", dbPath, "--evidence", evidenceDir, "--task", taskId];
    // 同步点：撤回进程等首次通过提交后才动手。
    const assertWriter = spawnWriter([...common, "--action", "assert", "--goal", "g",
      "--pattern", "goal/g.md", "--signal", marker, "--out", assertOut]);
    const retractWriter = spawnWriter([...common, "--action", "retract", "--finding", finding.id,
      "--wait-for", marker, "--out", retractOut]);

    const [asserted, retracted] = await Promise.all([assertWriter, retractWriter]);
    assert.equal(asserted.code, 0, asserted.stderr);
    assert.equal(retracted.code, 0, retracted.stderr);
    assert.equal(readWriterOut(assertOut).ok, true);
    assert.equal(readWriterOut(retractOut).ok, true);

    // 历史通过保留，首次通过的依据（Finding ID + 证据版本）完整。
    const state = store.listGoals(taskId).find((entry) => entry.id === "g")!;
    assert.equal(state.passes, true, "首次通过记录保留");
    assert.deepEqual(state.evidencePaths, ["goal/g.md"]);
    const support = store.listGoalFindings(taskId).filter((row) => row.goalId === "g");
    assert.deepEqual(support.map((row) => [row.findingId, row.statusAtAssert]), [[finding.id, "verified"]]);
    assert.deepEqual(support[0]!.evidence, finding.evidence, "归属行冻结了当时的证据版本");
    const proofs = store.listGoalProofs(taskId).filter((row) => row.goalId === "g");
    assert.equal(proofs.length, 1);
    assert.equal(proofs[0]!.sha256, goalSha);
    assert.ok(store.readProofVersion(taskId, goalSha), "目标证据原文可按版本回读");
    assert.ok(store.readProofVersion(taskId, findingProofSha), "发现证据原文可按版本回读");

    // 当前交付结论：唯一依据已撤回。
    const card = store.scorecard(taskId);
    assert.equal(card.historicallyPassed, 1);
    assert.equal(card.currentlySupported, 0);
    assert.equal(card.retractedReferences, 1);
    const verdict = card.goals.find((entry) => entry.goalId === "g")!;
    assert.equal(verdict.verdict, "supported-by-retracted-only");
    assert.deepEqual(verdict.supportFindingIds, [finding.id]);
    assert.deepEqual(verdict.retractedSupportFindingIds, [finding.id]);

    // 事件与行数：一次通过、一次撤回，没有重复记账。
    assert.deepEqual(counts(store, taskId, "g"), { asserted: 1, retracted: 1, supportRows: 1, proofs: 1 });

    // 重复断言不产生第二条通过记录（幂等，不重复记账）。
    assert.equal(store.assertGoal(taskId, "g", ["goal/g.md"]).ok, true);
    assert.deepEqual(counts(store, taskId, "g"), { asserted: 1, retracted: 1, supportRows: 1, proofs: 1 });
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("A3-并发 4：首次通过时已有另一条独立有效依据 → 撤一条仍支持，再撤另一条才失守", () => {
  const { root, evidenceDir, dbPath, store } = setup("gy-a3c4-");
  const taskId = randomUUID();
  const other = openHistory({ dbPath, evidenceDir });
  try {
    store.seedGoals(taskId, [goal("g", "goal/g.md")]);
    writeEvidence(evidenceDir, "goal/g.md", "g\n");
    const first = verifiedFinding(store, taskId, evidenceDir, "a.example.com", "CWE-89");
    const second = verifiedFinding(store, taskId, evidenceDir, "a.example.com", "CWE-79");

    assert.equal(store.assertGoal(taskId, "g", ["goal/g.md"]).ok, true);
    assert.deepEqual(
      store.listGoalFindings(taskId).filter((row) => row.goalId === "g").map((row) => row.findingId).sort(),
      [first.id, second.id].sort(),
      "首次通过时冻结两条独立依据",
    );

    // 第二个连接撤回其中一条：当前仍支持。
    other.retractFinding(taskId, first.id, "独立连接：撤回一条");
    let card = store.scorecard(taskId);
    let verdict = card.goals.find((entry) => entry.goalId === "g")!;
    assert.equal(verdict.currentSupported, true);
    assert.deepEqual(verdict.retractedSupportFindingIds, [first.id]);
    assert.deepEqual(verdict.supportFindingIds, verdict.supportFindingIds);
    assert.equal(card.retractedReferences, 1);
    assert.deepEqual(counts(store, taskId, "g"), { asserted: 1, retracted: 1, supportRows: 2, proofs: 1 });

    // 再撤回另一条：当前不再支持，但历史通过仍在。
    other.retractFinding(taskId, second.id, "独立连接：撤回第二条");
    card = store.scorecard(taskId);
    verdict = card.goals.find((entry) => entry.goalId === "g")!;
    assert.equal(card.historicallyPassed, 1);
    assert.equal(verdict.currentSupported, false);
    assert.equal(verdict.verdict, "supported-by-retracted-only");
    assert.equal(card.retractedReferences, 2);
    assert.deepEqual(counts(store, taskId, "g"), { asserted: 1, retracted: 2, supportRows: 2, proofs: 1 });
  } finally {
    other.close();
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

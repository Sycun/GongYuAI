/**
 * 验收清单校验的反例测试（验收项 1）。
 *
 * 1. 两次各自自洽的运行必须各自通过校验；
 * 2. 把 A 的记录与 B 的快照交叉配对（两者单独都有效）→ 校验必须失败；
 * 3. 只改快照文件字节（内容封印不变）→ 只有字节哈希检查失败，证明两种哈希分开；
 * 4. 第七轮补强：全零 SHA、另一个存在但不匹配的提交、dirty=true、已测数改成 99、
 *    记录里出现失败步骤 —— 每例都必须非零退出并准确指出失败字段。
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { finalizeSnapshot, snapshotSha256, type DeliverySnapshot } from "@gongyuai/history";
import { verifyAcceptance } from "./acceptance-verify.js";
import { writeAcceptanceManifest } from "./acceptance-manifest.js";

/** 受验提交取本仓库真实存在的提交：校验器要核对它是不是真的 Git 对象。 */
function gitCommit(ref = "HEAD"): string {
  const env = { ...process.env } as Record<string, string | undefined>;
  delete env.GIT_CONFIG_COUNT;
  for (let i = 0; i < 32; i += 1) {
    delete env[`GIT_CONFIG_KEY_${i}`];
    delete env[`GIT_CONFIG_VALUE_${i}`];
  }
  return execFileSync("git", ["rev-parse", ref], { cwd: process.cwd(), env, encoding: "utf8" }).trim();
}

const HEAD = gitCommit("HEAD");
const PARENT = (() => {
  try {
    return gitCommit("HEAD~1");
  } catch {
    return HEAD;
  }
})();

function snapshotFor(taskId: string, capturedAt: string, passed = true): DeliverySnapshot {
  return finalizeSnapshot({
    version: 1,
    taskId,
    capturedAt,
    goals: [{
      id: "g1",
      title: "目标一",
      passes: passed,
      evidencePatterns: ["a.md"],
      evidencePaths: passed ? ["a.md"] : [],
      assertedAt: passed ? capturedAt : null,
    }],
    proofs: passed ? [{ goalId: "g1", path: "a.md", sha256: "a".repeat(64) }] : [],
    goalFindings: [],
    findings: [],
    coverage: [],
  });
}

type Step = { step: string; ok: boolean; detail: string; at: string };

function buildRun(
  root: string,
  options: {
    runId: string;
    taskId: string;
    capturedAt: string;
    commit: string;
    dirty?: boolean;
    dirtyPaths?: string[];
    steps?: Step[];
    coverage?: Record<string, number>;
  },
): string {
  const dir = join(root, options.runId);
  const snapshot = snapshotFor(options.taskId, options.capturedAt);
  const scorecard = {
    taskId: options.taskId,
    capturedAt: options.capturedAt,
    snapshotSha256: snapshot.sha256,
    denominator: 1,
    historicallyPassed: 1,
    currentlySupported: 1,
    unknownAttribution: 0,
    retractedReferences: 0,
    coverage: options.coverage ?? { tested: 0, partial: 0, blocked: 0, untested: 0, unregistered: 1 },
    findings: { verified: 0, tentative: 0, retracted: 0, other: 0 },
  };
  const steps: Step[] = options.steps ?? [
    { step: "建档", ok: true, detail: "POST /tasks → 201", at: options.capturedAt },
    { step: "复算", ok: true, detail: "seal valid", at: options.capturedAt },
  ];
  const recordJson = {
    runId: options.runId,
    taskId: options.taskId,
    dataRoot: `/tmp/acceptance/${options.runId}`,
    finishedAt: options.capturedAt,
    scopeVersion: 1,
    steps,
    scorecard,
    snapshotPath: join(dir, "delivery-snapshot.json"),
  };
  const recordMd = [
    "# 验收记录",
    "",
    `运行　${options.runId}`,
    `任务　${options.taskId}`,
    `数据目录　/tmp/acceptance/${options.runId}`,
    `代码提交　${options.commit}`,
    `快照内容封印　${snapshot.sha256}`,
    "校验清单　acceptance-manifest.json",
    "",
  ].join("\n");

  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "delivery-snapshot.json"), JSON.stringify(snapshot, null, 2) + "\n");
  writeFileSync(join(dir, "acceptance-record.json"), JSON.stringify(recordJson, null, 2) + "\n");
  writeFileSync(join(dir, "acceptance-record.md"), recordMd);
  writeAcceptanceManifest({
    dir,
    kind: "synthetic-test",
    runId: options.runId,
    taskId: options.taskId,
    dataRoot: recordJson.dataRoot,
    startedAt: options.capturedAt,
    finishedAt: options.capturedAt,
    steps,
    code: {
      commit: options.commit,
      branch: "main",
      dirty: options.dirty ?? false,
      dirtyPaths: options.dirtyPaths ?? [],
    },
  });
  return dir;
}

function failedIds(dir: string, options: Parameters<typeof verifyAcceptance>[1] = {}): string[] {
  const result = verifyAcceptance(dir, { expectCommit: HEAD, ...options });
  return result.checks.filter((check) => !check.ok).map((check) => check.id);
}

/** 改清单里的一个字段后重新算字节哈希无关项：这里只改 JSON 值，模拟篡改。 */
function patchManifest(dir: string, patch: (manifest: Record<string, any>) => void): void {
  const path = join(dir, "acceptance-manifest.json");
  const manifest = JSON.parse(readFileSync(path, "utf8")) as Record<string, any>;
  patch(manifest);
  writeFileSync(path, JSON.stringify(manifest, null, 2) + "\n");
}

test("两次各自有效的运行各自通过；交叉配对必须失败", () => {
  const root = mkdtempSync(join(tmpdir(), "gy-verify-"));
  try {
    const runA = buildRun(root, {
      runId: "engagement-A",
      taskId: "11111111-1111-4111-8111-111111111111",
      capturedAt: "2026-11-22T12:00:00.000Z",
      commit: HEAD,
    });
    const runB = buildRun(root, {
      runId: "engagement-B",
      taskId: "22222222-2222-4222-8222-222222222222",
      capturedAt: "2026-11-22T13:00:00.000Z",
      commit: HEAD,
    });

    const a = verifyAcceptance(runA, { expectCommit: HEAD });
    assert.equal(a.ok, true, a.checks.filter((check) => !check.ok).map((check) => check.id).join(","));
    const b = verifyAcceptance(runB, { expectCommit: HEAD });
    assert.equal(b.ok, true, b.checks.filter((check) => !check.ok).map((check) => check.id).join(","));

    // 反例：A 的清单与快照，配 B 的记录（两者都各自有效）。
    const crossed = verifyAcceptance(runA, { recordDir: runB, expectCommit: HEAD });
    assert.equal(crossed.ok, false, "交叉配对必须被拒绝");
    const failed = crossed.checks.filter((check) => !check.ok).map((check) => check.id);
    assert.ok(failed.includes("record.json.taskId"), `失败项应含任务不一致：${failed.join(",")}`);
    assert.ok(failed.includes("record.json.snapshotSha256"), `失败项应含快照不一致：${failed.join(",")}`);
    assert.ok(failed.includes("record.json.runId"), `失败项应含运行 ID 不一致：${failed.join(",")}`);
    assert.ok(failed.includes("record.md.bytes"), "字节哈希也不是同一份记录");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("只改快照文件字节：内容封印仍成立，字节哈希检查失败", () => {
  const root = mkdtempSync(join(tmpdir(), "gy-verify2-"));
  try {
    const run = buildRun(root, {
      runId: "engagement-C",
      taskId: "33333333-3333-4333-8333-333333333333",
      capturedAt: "2026-11-22T14:00:00.000Z",
      commit: HEAD,
    });
    assert.equal(verifyAcceptance(run, { expectCommit: HEAD }).ok, true);

    const snapshotPath = join(run, "delivery-snapshot.json");
    const before = readFileSync(snapshotPath, "utf8");
    // 只补一个换行：JSON 语义不变，内容封印不变，但文件字节变了。
    writeFileSync(snapshotPath, before + "\n");
    const after = verifyAcceptance(run, { expectCommit: HEAD });
    const failed = after.checks.filter((check) => !check.ok).map((check) => check.id);
    assert.deepEqual(failed, ["snapshot.file.bytes"], `只应失败字节哈希：${failed.join(",")}`);
    const sealCheck = after.checks.find((check) => check.id === "snapshot.seal");
    assert.equal(sealCheck?.ok, true, "内容封印不受文件字节影响");

    // 而记录引用的仍是内容封印，所以它的数值仍然对得上。
    const record = JSON.parse(readFileSync(join(run, "acceptance-record.json"), "utf8")) as {
      scorecard: { snapshotSha256: string };
    };
    assert.equal(record.scorecard.snapshotSha256, snapshotSha256(JSON.parse(before) as DeliverySnapshot));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── 第七轮补强：五个单点负例 ────────────────────────────────────────────────

test("负例一：全零 SHA —— 不是 Git 对象，也不等于受验提交", () => {
  const root = mkdtempSync(join(tmpdir(), "gy-neg1-"));
  try {
    const run = buildRun(root, {
      runId: "engagement-zero",
      taskId: "44444444-4444-4444-8444-444444444444",
      capturedAt: "2026-11-22T15:00:00.000Z",
      commit: "0".repeat(40),
    });
    // 未给受验提交时也不能靠“40 位十六进制”混过去。
    const noExpectation = verifyAcceptance(run, { releaseRecord: join(run, "absent-receipt.json") });
    assert.equal(noExpectation.ok, false, "全零 SHA 必须失败");
    const failed = noExpectation.checks.filter((check) => !check.ok).map((check) => check.id);
    assert.deepEqual(failed.sort(), ["code.commit.expected", "code.commit.object"]);
    const objectCheck = noExpectation.checks.find((check) => check.id === "code.commit.object")!;
    assert.match(objectCheck.detail, /不是本仓库里存在的提交对象/);

    // 显式给定受验提交时同样失败，并指出期望值。
    const withExpectation = verifyAcceptance(run, { expectCommit: HEAD });
    assert.equal(withExpectation.ok, false);
    const expectedCheck = withExpectation.checks.find((check) => check.id === "code.commit.expected")!;
    assert.equal(expectedCheck.ok, false);
    assert.match(expectedCheck.detail, new RegExp(HEAD));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("负例二：另一个存在但不匹配的提交 —— 对象存在，但与受验提交不符", () => {
  const root = mkdtempSync(join(tmpdir(), "gy-neg2-"));
  try {
    const run = buildRun(root, {
      runId: "engagement-other-commit",
      taskId: "55555555-5555-4555-8555-555555555555",
      capturedAt: "2026-11-22T16:00:00.000Z",
      commit: PARENT,
    });
    const result = verifyAcceptance(run, { expectCommit: HEAD });
    assert.equal(result.ok, false);
    const failed = result.checks.filter((check) => !check.ok).map((check) => check.id);
    assert.deepEqual(failed, ["code.commit.expected"], `只应失败提交不匹配：${failed.join(",")}`);
    const objectCheck = result.checks.find((check) => check.id === "code.commit.object")!;
    assert.equal(objectCheck.ok, true, "该提交确实存在于 Git 里");
    const expectedCheck = result.checks.find((check) => check.id === "code.commit.expected")!;
    assert.match(expectedCheck.detail, /期望/);
    assert.match(expectedCheck.detail, new RegExp(HEAD));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("负例三：dirty=true —— 不能签“干净发布版本已验证”", () => {
  const root = mkdtempSync(join(tmpdir(), "gy-neg3-"));
  try {
    const run = buildRun(root, {
      runId: "engagement-dirty",
      taskId: "66666666-6666-4666-8666-666666666666",
      capturedAt: "2026-11-22T17:00:00.000Z",
      commit: HEAD,
      dirty: true,
      dirtyPaths: ["packages/contracts/src/reconcile.ts"],
    });
    const result = verifyAcceptance(run, { expectCommit: HEAD });
    assert.equal(result.ok, false);
    const failed = result.checks.filter((check) => !check.ok).map((check) => check.id);
    assert.deepEqual(failed, ["code.clean"], `只应失败干净状态：${failed.join(",")}`);
    const cleanCheck = result.checks.find((check) => check.id === "code.clean")!;
    assert.match(cleanCheck.detail, /dirty=true/);
    assert.match(cleanCheck.detail, /reconcile\.ts/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("负例四：已测数改成 99 —— 覆盖数逐字段复算必须不一致", () => {
  const root = mkdtempSync(join(tmpdir(), "gy-neg4-"));
  try {
    const run = buildRun(root, {
      runId: "engagement-coverage",
      taskId: "77777777-7777-4777-8777-777777777777",
      capturedAt: "2026-11-22T18:00:00.000Z",
      commit: HEAD,
    });
    assert.equal(verifyAcceptance(run, { expectCommit: HEAD }).ok, true);

    patchManifest(run, (manifest) => {
      manifest.scorecard.coverage = { ...manifest.scorecard.coverage, tested: 99 };
    });
    const result = verifyAcceptance(run, { expectCommit: HEAD });
    assert.equal(result.ok, false);
    const failed = result.checks.filter((check) => !check.ok).map((check) => check.id);
    assert.deepEqual(failed, ["scorecard.coverage"], `只应失败覆盖数：${failed.join(",")}`);
    const coverageCheck = result.checks.find((check) => check.id === "scorecard.coverage")!;
    assert.match(coverageCheck.detail, /tested: 清单 99 ≠ 快照复算 0/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("负例五：记录中出现失败步骤 —— 自报失败的运行不能汇总成通过", () => {
  const root = mkdtempSync(join(tmpdir(), "gy-neg5-"));
  try {
    const capturedAt = "2026-11-22T19:00:00.000Z";
    const steps: Step[] = [
      { step: "建档", ok: true, detail: "POST /tasks → 201", at: capturedAt },
      { step: "差异核算", ok: false, detail: "缺基线材料 assets/baseline.csv", at: capturedAt },
    ];
    const run = buildRun(root, {
      runId: "engagement-failed-step",
      taskId: "88888888-8888-4888-8888-888888888888",
      capturedAt,
      commit: HEAD,
      steps,
    });
    const result = verifyAcceptance(run, { expectCommit: HEAD });
    assert.equal(result.ok, false);
    const failed = result.checks.filter((check) => !check.ok).map((check) => check.id);
    assert.deepEqual(
      failed.sort(),
      ["manifest.steps.failed", "manifest.steps.passed", "record.json.steps.failed"],
      `只应失败失败步骤相关项：${failed.join(",")}`,
    );
    const recordCheck = result.checks.find((check) => check.id === "record.json.steps.failed")!;
    assert.match(recordCheck.detail, /差异核算/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("未改动的原件与发布记录一起通过（提交来自冻结记录）", () => {
  const root = mkdtempSync(join(tmpdir(), "gy-release-"));
  try {
    const run = buildRun(root, {
      runId: "engagement-release",
      taskId: "99999999-9999-4999-8999-999999999999",
      capturedAt: "2026-11-22T20:00:00.000Z",
      commit: HEAD,
    });
    // 冻结发布记录：runId → codeCommit。
    const receipt = join(root, "release");
    mkdirSync(receipt, { recursive: true });
    writeFileSync(
      join(receipt, "receipt.json"),
      JSON.stringify({
        kind: "release-receipt",
        testedCode: { commit: HEAD },
        acceptanceRuns: [{ runId: "engagement-release", codeCommit: HEAD, dirty: false }],
      }, null, 2) + "\n",
    );
    // 不给 --expect-commit，靠发布记录核对提交。
    const result = verifyAcceptance(run);
    assert.equal(result.ok, true, result.checks.filter((check) => !check.ok).map((check) => `${check.id}:${check.detail}`).join(" | "));
    const expectedCheck = result.checks.find((check) => check.id === "code.commit.expected")!;
    assert.match(expectedCheck.detail, /发布记录/);

    // 反例：冻结记录指向另一个提交 → 必须失败。
    writeFileSync(
      join(receipt, "receipt.json"),
      JSON.stringify({ kind: "release-receipt", testedCode: { commit: PARENT }, acceptanceRuns: [] }, null, 2) + "\n",
    );
    const mismatch = verifyAcceptance(run, { releaseRecord: join(receipt, "receipt.json") });
    assert.deepEqual(
      mismatch.checks.filter((check) => !check.ok).map((check) => check.id),
      ["code.commit.expected"],
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

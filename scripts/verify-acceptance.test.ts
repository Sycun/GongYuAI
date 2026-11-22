/**
 * 验收清单校验的反例测试（验收项 1）。
 *
 * 1. 两次各自自洽的运行必须各自通过校验；
 * 2. 把 A 的记录与 B 的快照交叉配对（两者单独都有效）→ 校验必须失败；
 * 3. 只改快照文件字节（内容封印不变）→ 只有字节哈希检查失败，证明两种哈希分开。
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { finalizeSnapshot, snapshotSha256, type DeliverySnapshot } from "@gongyuai/history";
import { verifyAcceptance } from "./acceptance-verify.js";
import { writeAcceptanceManifest } from "./acceptance-manifest.js";

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

function buildRun(
  root: string,
  options: { runId: string; taskId: string; capturedAt: string; commit: string },
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
    coverage: { tested: 0, partial: 0, blocked: 0, untested: 0, unregistered: 1 },
    findings: { verified: 0, tentative: 0, retracted: 0, other: 0 },
  };
  const steps = [
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
    code: { commit: options.commit, branch: "main", dirty: false, dirtyPaths: [] },
  });
  return dir;
}

test("两次各自有效的运行各自通过；交叉配对必须失败", () => {
  const root = mkdtempSync(join(tmpdir(), "gy-verify-"));
  try {
    const runA = buildRun(root, {
      runId: "engagement-A",
      taskId: "11111111-1111-4111-8111-111111111111",
      capturedAt: "2026-11-22T12:00:00.000Z",
      commit: "a".repeat(40),
    });
    const runB = buildRun(root, {
      runId: "engagement-B",
      taskId: "22222222-2222-4222-8222-222222222222",
      capturedAt: "2026-11-22T13:00:00.000Z",
      commit: "b".repeat(40),
    });

    const a = verifyAcceptance(runA);
    assert.equal(a.ok, true, a.checks.filter((check) => !check.ok).map((check) => check.id).join(","));
    const b = verifyAcceptance(runB);
    assert.equal(b.ok, true, b.checks.filter((check) => !check.ok).map((check) => check.id).join(","));

    // 反例：A 的清单与快照，配 B 的记录（两者都各自有效）。
    const crossed = verifyAcceptance(runA, { recordDir: runB });
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
      commit: "c".repeat(40),
    });
    assert.equal(verifyAcceptance(run).ok, true);

    const snapshotPath = join(run, "delivery-snapshot.json");
    const before = readFileSync(snapshotPath, "utf8");
    // 只补一个换行：JSON 语义不变，内容封印不变，但文件字节变了。
    writeFileSync(snapshotPath, before + "\n");
    const after = verifyAcceptance(run);
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

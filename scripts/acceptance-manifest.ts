/**
 * 验收清单生成（验收项 1）。
 *
 * 把「运行 ID + 任务 ID + 代码提交 + 记录 + 快照 + 两种哈希」写进同一份
 * 可机器校验的 `acceptance-manifest.json`。记录与快照的字节哈希在这里
 * 计算一次；之后的校验只读这些文件，不重新生成任何东西。
 */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AcceptanceManifest } from "./acceptance-verify.js";

export type ManifestStep = { step: string; ok: boolean; detail?: string; at?: string };

export type ManifestInput = {
  dir: string;
  kind: string;
  runId: string;
  taskId: string;
  dataRoot: string;
  startedAt: string;
  finishedAt: string;
  steps: ManifestStep[];
  notes?: string[];
  /** 覆盖代码提交；省略时从当前仓库读取。 */
  code?: AcceptanceManifest["code"];
};

function sha256(data: Buffer | string): string {
  return createHash("sha256").update(data).digest("hex");
}

/** Git 信息用干净的环境变量读取，避免宿主注入的 GIT_CONFIG_* 破坏解析。 */
export function gitCodeInfo(cwd = process.cwd()): AcceptanceManifest["code"] {
  const env = { ...process.env } as Record<string, string | undefined>;
  delete env.GIT_CONFIG_COUNT;
  for (let i = 0; i < 32; i += 1) delete env[`GIT_CONFIG_KEY_${i}`];
  for (let i = 0; i < 32; i += 1) delete env[`GIT_CONFIG_VALUE_${i}`];
  const run = (args: string[]): string => {
    try {
      return execFileSync("git", args, { cwd, env, encoding: "utf8" }).trim();
    } catch {
      return "";
    }
  };
  const commit = run(["rev-parse", "HEAD"]) || null;
  const branch = run(["rev-parse", "--abbrev-ref", "HEAD"]) || null;
  const dirtyPaths = run(["status", "--porcelain"]).split("\n").map((line) => line.trim()).filter(Boolean);
  return { commit, branch, dirty: dirtyPaths.length > 0, dirtyPaths };
}

export function writeAcceptanceManifest(input: ManifestInput): AcceptanceManifest {
  const recordMdPath = join(input.dir, "acceptance-record.md");
  const recordJsonPath = join(input.dir, "acceptance-record.json");
  const snapshotPath = join(input.dir, "delivery-snapshot.json");

  const recordMd = readFileSync(recordMdPath);
  const recordJson = readFileSync(recordJsonPath);
  const snapshotBytes = readFileSync(snapshotPath);
  const snapshot = JSON.parse(snapshotBytes.toString("utf8")) as {
    taskId: string;
    capturedAt: string;
    sha256?: string;
  };
  const record = JSON.parse(recordJson.toString("utf8")) as {
    taskId: string;
    dataRoot: string;
    scorecard?: {
      snapshotSha256?: string;
      denominator?: number;
      totalGoals?: number;
      historicallyPassed?: number;
      currentlySupported?: number;
      unknownAttribution?: number;
      coverage?: Record<string, number>;
      capturedAt?: string;
    };
  };
  const scorecard = record.scorecard ?? {};

  const manifest: AcceptanceManifest = {
    version: 1,
    kind: input.kind,
    runId: input.runId,
    taskId: input.taskId,
    dataRoot: input.dataRoot,
    startedAt: input.startedAt,
    finishedAt: input.finishedAt,
    code: input.code ?? gitCodeInfo(),
    steps: {
      total: input.steps.length,
      passed: input.steps.filter((step) => step.ok).length,
      failed: input.steps.filter((step) => !step.ok).length,
    },
    record: { markdown: "acceptance-record.md", json: "acceptance-record.json" },
    files: {
      recordMd: { path: "acceptance-record.md", sha256: sha256(recordMd) },
      recordJson: { path: "acceptance-record.json", sha256: sha256(recordJson) },
      snapshot: {
        path: "delivery-snapshot.json",
        bytesSha256: sha256(snapshotBytes),
        sealSha256: String(snapshot.sha256 ?? ""),
        capturedAt: snapshot.capturedAt,
      },
    },
    scorecard: {
      snapshotSha256: String(scorecard.snapshotSha256 ?? ""),
      denominator: Number(scorecard.denominator ?? scorecard.totalGoals ?? 0),
      historicallyPassed: Number(scorecard.historicallyPassed ?? 0),
      currentlySupported: Number(scorecard.currentlySupported ?? 0),
      unknownAttribution: Number(scorecard.unknownAttribution ?? 0),
      coverage: scorecard.coverage ?? {},
      capturedAt: String(scorecard.capturedAt ?? snapshot.capturedAt ?? ""),
    },
    notes: [
      "内容封印 = 快照去掉 sha256 字段后对 canonical payload 计算的 sha256（可离线复算）。",
      "字节哈希 = 快照文件原始字节的 sha256（确认交付的就是那一份文件）。",
      "记分卡的 snapshotSha256 必须等于本清单 files.snapshot.sealSha256。",
      ...(input.notes ?? []),
    ],
  };
  writeFileSync(join(input.dir, "acceptance-manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
  return manifest;
}

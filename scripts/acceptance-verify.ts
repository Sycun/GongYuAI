/**
 * 验收清单校验器（验收项 1）。
 *
 * 只读随交付保存的文件，回答四个问题：
 * 1. 这次运行对应哪个代码提交、哪个任务、哪份记录、哪份快照？
 * 2. 快照自身的**内容封印**（对 canonical payload 的 sha256）是否成立？
 * 3. 记分卡引用的哈希是否就等于这份快照的内容封印？
 * 4. 记录里写的任务 ID / 运行 ID 是否与清单一致？
 *
 * 两种哈希必须分开看，不能混用：
 * - 内容封印：快照去掉 `sha256` 字段后重新规范化计算的哈希，可离线复算；
 * - 文件字节哈希：快照文件原始字节的 sha256，用于确认交付的就是那一份文件。
 *
 * 用法：
 *   pnpm verify:acceptance docs/evidence/acceptance/<run> [--out receipt.json]
 *   pnpm verify:acceptance <dirA> --record <dirB>   # 反例：交叉配对必须失败
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { scorecardFromSnapshot, snapshotSha256, type DeliverySnapshot } from "@gongyuai/history";

export type AcceptanceManifest = {
  version: 1;
  kind: string;
  runId: string;
  taskId: string;
  dataRoot: string;
  startedAt: string;
  finishedAt: string;
  code: {
    commit: string | null;
    branch: string | null;
    dirty: boolean;
    dirtyPaths: string[];
  };
  steps: { total: number; passed: number; failed: number };
  record: { markdown: string; json: string };
  files: {
    recordMd: { path: string; sha256: string };
    recordJson: { path: string; sha256: string };
    snapshot: { path: string; bytesSha256: string; sealSha256: string; capturedAt: string };
  };
  scorecard: {
    snapshotSha256: string;
    denominator: number;
    historicallyPassed: number;
    currentlySupported: number;
    unknownAttribution: number;
    coverage: Record<string, number>;
    capturedAt: string;
  };
  notes: string[];
};

export type CheckResult = { id: string; ok: boolean; detail: string };

export type VerifyResult = {
  ok: boolean;
  dir: string;
  checks: CheckResult[];
  manifest: AcceptanceManifest | null;
  summary: string[];
};

export function sha256Bytes(data: Buffer | string): string {
  return createHash("sha256").update(data).digest("hex");
}

function readJson(path: string): unknown | null {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

/**
 * @param dir 清单所在目录
 * @param recordDir 可选：把记录（md/json）从另一个目录读进来，用来复现
 *        “两次各自有效的记录与快照交叉配对”这一反例。
 */
export function verifyAcceptance(dir: string, options: { recordDir?: string } = {}): VerifyResult {
  const root = resolve(dir);
  const recordRoot = options.recordDir ? resolve(options.recordDir) : root;
  const checks: CheckResult[] = [];
  const summary: string[] = [];
  const push = (id: string, ok: boolean, detail: string) => checks.push({ id, ok, detail });

  const manifestPath = join(root, "acceptance-manifest.json");
  const manifest = readJson(manifestPath) as AcceptanceManifest | null;
  if (!manifest) {
    push("manifest.present", false, `缺少或无法解析 ${manifestPath}`);
    return { ok: false, dir: root, checks, manifest: null, summary };
  }
  push("manifest.present", true, `清单 ${manifestPath}`);
  push("manifest.version", manifest.version === 1, `version=${String(manifest.version)}`);
  push(
    "manifest.runId",
    typeof manifest.runId === "string" && manifest.runId.length > 0,
    `runId=${String(manifest.runId)}`,
  );
  push(
    "manifest.code.commit",
    typeof manifest.code?.commit === "string" && /^[0-9a-f]{40}$/.test(manifest.code.commit),
    `代码提交 ${manifest.code?.commit ?? "未记录"}`,
  );

  // 1) 随交付保存的记录与快照，字节哈希必须与清单一致。
  const recordMdPath = join(recordRoot, manifest.files.recordMd.path);
  const recordJsonPath = join(recordRoot, manifest.files.recordJson.path);
  const snapshotPath = join(root, manifest.files.snapshot.path);

  const recordMd = existsSync(recordMdPath) ? readFileSync(recordMdPath) : null;
  push(
    "record.md.bytes",
    Boolean(recordMd) && sha256Bytes(recordMd!) === manifest.files.recordMd.sha256,
    recordMd
      ? `${manifest.files.recordMd.path} 字节哈希 ${sha256Bytes(recordMd)}（期望 ${manifest.files.recordMd.sha256}）`
      : `缺少 ${recordMdPath}`,
  );
  const recordJson = existsSync(recordJsonPath) ? readFileSync(recordJsonPath) : null;
  push(
    "record.json.bytes",
    Boolean(recordJson) && sha256Bytes(recordJson!) === manifest.files.recordJson.sha256,
    recordJson
      ? `${manifest.files.recordJson.path} 字节哈希 ${sha256Bytes(recordJson)}（期望 ${manifest.files.recordJson.sha256}）`
      : `缺少 ${recordJsonPath}`,
  );
  const snapshotBytes = existsSync(snapshotPath) ? readFileSync(snapshotPath) : null;
  push(
    "snapshot.file.bytes",
    Boolean(snapshotBytes) && sha256Bytes(snapshotBytes!) === manifest.files.snapshot.bytesSha256,
    snapshotBytes
      ? `快照文件字节哈希 ${sha256Bytes(snapshotBytes)}（期望 ${manifest.files.snapshot.bytesSha256}）`
      : `缺少 ${snapshotPath}`,
  );

  // 2) 快照自身的内容封印：去掉 sha256 字段后重新规范化计算。
  let snapshot: DeliverySnapshot | null = null;
  if (snapshotBytes) {
    try {
      snapshot = JSON.parse(snapshotBytes.toString("utf8")) as DeliverySnapshot;
    } catch {
      snapshot = null;
    }
  }
  if (!snapshot) {
    push("snapshot.seal", false, "快照不是可解析的 JSON");
  } else {
    const seal = snapshotSha256(snapshot);
    push(
      "snapshot.seal",
      snapshot.sha256 === seal && manifest.files.snapshot.sealSha256 === seal,
      `内容封印 ${seal}；文件内 sha256=${String(snapshot.sha256)}；清单 sealSha256=${manifest.files.snapshot.sealSha256}`,
    );
    push(
      "snapshot.distinct-from-bytes",
      seal !== sha256Bytes(snapshotBytes!),
      `内容封印 ${seal.slice(0, 12)}… 与文件字节哈希 ${sha256Bytes(snapshotBytes!).slice(0, 12)}… ` +
        (seal === sha256Bytes(snapshotBytes!) ? "相同（不应相同）" : "是两回事"),
    );
    push(
      "snapshot.capturedAt",
      snapshot.capturedAt === manifest.files.snapshot.capturedAt,
      `快照 capturedAt=${snapshot.capturedAt}（清单 ${manifest.files.snapshot.capturedAt}）`,
    );
    push(
      "snapshot.taskId",
      snapshot.taskId === manifest.taskId,
      `快照 taskId=${snapshot.taskId}（清单 ${manifest.taskId}）`,
    );

    // 3) 记分卡必须由这一份快照算出：封印相等 + 纯函数复算一致。
    const recomputed = scorecardFromSnapshot(snapshot);
    push("scorecard.recompute", recomputed.ok, recomputed.ok ? "纯函数复算成功" : recomputed.reason);
    if (recomputed.ok) {
      const card = recomputed.scorecard;
      push(
        "scorecard.points-at-this-snapshot",
        card.snapshotSha256 === seal && manifest.scorecard.snapshotSha256 === seal,
        `记分卡引用 ${manifest.scorecard.snapshotSha256}；快照封印 ${seal}`,
      );
      push(
        "scorecard.numbers",
        card.historicallyPassed === manifest.scorecard.historicallyPassed &&
          card.currentlySupported === manifest.scorecard.currentlySupported &&
          card.denominator === manifest.scorecard.denominator &&
          card.unknownAttribution === manifest.scorecard.unknownAttribution,
        `复算 ${card.historicallyPassed}/${card.denominator} 历史 · ${card.currentlySupported}/${card.denominator} 当前 ` +
          `· 归属未知 ${card.unknownAttribution}（清单 ${manifest.scorecard.historicallyPassed}/${manifest.scorecard.denominator} · ` +
          `${manifest.scorecard.currentlySupported}/${manifest.scorecard.denominator} · ${manifest.scorecard.unknownAttribution}）`,
      );
      push(
        "scorecard.capturedAt",
        card.capturedAt === manifest.scorecard.capturedAt,
        `复算 capturedAt=${card.capturedAt}（清单 ${manifest.scorecard.capturedAt}）`,
      );
      summary.push(
        `记分卡：历史通过 ${card.historicallyPassed}/${card.denominator}；当前证据支持 ${card.currentlySupported}/${card.denominator}；` +
          `归属未知 ${card.unknownAttribution}；人工覆盖 ${Object.entries(card.coverage).map(([k, v]) => `${k}=${v}`).join(" ")}`,
      );
    }
  }

  // 4) 记录本身必须与清单描述同一次运行。
  const record = recordJson ? (JSON.parse(recordJson.toString("utf8")) as Record<string, unknown>) : null;
  if (!record) {
    push("record.json.taskId", false, "记录不是可解析的 JSON");
  } else {
    push(
      "record.json.taskId",
      record.taskId === manifest.taskId,
      `记录 taskId=${String(record.taskId)}（清单 ${manifest.taskId}）`,
    );
    const recordScorecard = record.scorecard as { snapshotSha256?: string } | undefined;
    push(
      "record.json.snapshotSha256",
      Boolean(recordScorecard?.snapshotSha256) &&
        recordScorecard!.snapshotSha256 === manifest.files.snapshot.sealSha256,
      `记录引用 ${String(recordScorecard?.snapshotSha256)}；快照封印 ${manifest.files.snapshot.sealSha256}`,
    );
    const steps = Array.isArray(record.steps) ? record.steps : [];
    const failed = steps.filter((step) => (step as { ok?: boolean }).ok === false).length;
    push(
      "record.json.steps",
      steps.length === manifest.steps.total && failed === manifest.steps.failed,
      `记录 ${steps.length} 步、失败 ${failed}（清单 ${manifest.steps.total} 步、失败 ${manifest.steps.failed}）`,
    );
    const recordRootPath = (record.dataRoot as string | undefined) ?? "";
    push(
      "record.json.runId",
      recordRootPath.endsWith(manifest.runId),
      `记录数据目录 ${recordRootPath}（清单 runId ${manifest.runId}）`,
    );
  }
  if (recordMd) {
    const text = recordMd.toString("utf8");
    push(
      "record.md.sealMention",
      text.includes(manifest.files.snapshot.sealSha256),
      "记录正文写出了这份快照的内容封印",
    );
    push(
      "record.md.runIdMention",
      text.includes(manifest.runId),
      "记录正文写出了本次运行 ID",
    );
    push(
      "record.md.manifestMention",
      text.includes("acceptance-manifest.json"),
      "记录正文指向同一份清单",
    );
  }

  const ok = checks.every((check) => check.ok);
  return { ok, dir: root, checks, manifest, summary };
}

function print(result: VerifyResult): void {
  console.log(`验收清单校验：${result.dir}`);
  for (const check of result.checks) {
    console.log(`${check.ok ? "PASS" : "FAIL"}  ${check.id}  ${check.detail}`);
  }
  for (const line of result.summary) console.log(`— ${line}`);
  console.log(result.ok ? "\n结论：全部通过" : "\n结论：存在失败项");
}

if (process.argv[1] && /acceptance-verify\.(ts|js)$/.test(process.argv[1])) {
  const args = process.argv.slice(2);
  const dir = args.find((arg) => !arg.startsWith("--"));
  const recordIndex = args.indexOf("--record");
  const recordDir = recordIndex >= 0 ? args[recordIndex + 1] : undefined;
  const outIndex = args.indexOf("--out");
  const out = outIndex >= 0 ? args[outIndex + 1] : undefined;
  if (!dir) {
    console.error("usage: acceptance-verify <dir> [--record <dir>] [--out receipt.json]");
    process.exit(2);
  }
  const result = verifyAcceptance(dir, recordDir ? { recordDir } : {});
  print(result);
  if (out) {
    writeFileSync(resolve(out), JSON.stringify({ ...result, verifiedAt: new Date().toISOString() }, null, 2) + "\n");
  }
  if (!result.ok) process.exitCode = 1;
}

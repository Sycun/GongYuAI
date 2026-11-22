/**
 * 验收清单校验器（验收项 1）。
 *
 * 只读随交付保存的文件，回答六个问题：
 * 1. 这次运行对应哪个代码提交、哪个任务、哪份记录、哪份快照？
 * 2. 该提交是否**真的存在于 Git 里**，并且等于调用方独立给定的受验提交
 *    （或冻结发布记录里写的那个提交）？
 * 3. 这次运行是不是在干净工作区上跑出来的（dirty 的运行不能签“干净发布版本已验证”）？
 * 4. 快照自身的**内容封印**（对 canonical payload 的 sha256）是否成立？
 * 5. 记分卡引用的哈希是否就等于这份快照的内容封印，且每类覆盖数、分母、历史通过、
 *    当前支持、归属未知都能从快照逐字段复算出来？
 * 6. 记录里写的任务 ID / 运行 ID 是否与清单一致，且没有任何自报失败的步骤？
 *
 * 两种哈希必须分开看，不能混用：
 * - 内容封印：快照去掉 `sha256` 字段后重新规范化计算的哈希，可离线复算；
 * - 文件字节哈希：快照文件原始字节的 sha256，用于确认交付的就是那一份文件。
 *
 * 用法：
 *   pnpm verify:acceptance docs/evidence/acceptance/<run> --expect-commit <sha40>
 *   pnpm verify:acceptance <dir> --release-record docs/evidence/release/receipt.json
 *   pnpm verify:acceptance <dirA> --record <dirB>   # 反例：交叉配对必须失败
 *
 * 未给 `--expect-commit` 时，会从运行目录向上查找冻结的发布记录
 * （`release/receipt.json`）。两者都没有就无法确认“这次运行对应哪个提交”，
 * 该检查判失败——只检查 40 位十六进制是不够的。
 */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
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

export type VerifyOptions = {
  /** 交叉配对反例：记录从另一个目录读进来。 */
  recordDir?: string;
  /** 调用方独立给定的受验提交（40 位十六进制）。 */
  expectCommit?: string;
  /** 冻结的发布记录（release receipt），用于核对提交与运行 ID。 */
  releaseRecord?: string;
  /** 验证 Git 对象的仓库路径（默认当前目录）。 */
  repo?: string;
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

/** 干净环境里跑 git：宿主注入的 GIT_CONFIG_* 会破坏解析。 */
function git(args: string[], cwd: string): { ok: boolean; out: string } {
  const env = { ...process.env } as Record<string, string | undefined>;
  delete env.GIT_CONFIG_COUNT;
  for (let i = 0; i < 32; i += 1) {
    delete env[`GIT_CONFIG_KEY_${i}`];
    delete env[`GIT_CONFIG_VALUE_${i}`];
  }
  try {
    const out = execFileSync("git", args, { cwd, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    return { ok: true, out: out.trim() };
  } catch {
    return { ok: false, out: "" };
  }
}

/** 提交是否作为真实 Git 对象存在（全零/自造字符串都会在这里被挡掉）。 */
export function commitObjectExists(commit: string, repo: string): { ok: boolean; detail: string } {
  if (!/^[0-9a-f]{40}$/.test(commit)) return { ok: false, detail: `${commit} 不是 40 位小写十六进制` };
  if (!existsSync(repo)) return { ok: false, detail: `仓库路径不存在：${repo}` };
  const inside = git(["rev-parse", "--git-dir"], repo);
  if (!inside.ok) return { ok: false, detail: `${repo} 不是 Git 仓库` };
  const cat = git(["cat-file", "-e", `${commit}^{commit}`], repo);
  if (!cat.ok) return { ok: false, detail: `${commit} 不是本仓库里存在的提交对象` };
  return { ok: true, detail: `${commit} 是 ${repo} 里的真实提交对象` };
}

type ReleaseRecord = {
  testedCode?: { commit?: string };
  acceptanceRuns?: Array<{ runId?: string; codeCommit?: string; dirty?: boolean }>;
};

/** 从运行目录向上找冻结的发布记录；最多找 4 层。 */
export function findReleaseRecord(dir: string): string | null {
  let current = resolve(dir);
  for (let depth = 0; depth < 4; depth += 1) {
    for (const name of ["release/receipt.json", "release-receipt.json", "acceptance/release/receipt.json"]) {
      const candidate = join(current, name);
      if (existsSync(candidate)) return candidate;
    }
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return null;
}

/** 发布记录里与本次运行对应的受验提交。 */
function expectedCommitFromRecord(record: ReleaseRecord, runId: string): { commit: string | null; source: string } {
  const run = (record.acceptanceRuns ?? []).find((entry) => entry?.runId === runId);
  if (run?.codeCommit) return { commit: run.codeCommit, source: `发布记录中 runId=${runId} 的 codeCommit` };
  if (record.testedCode?.commit) return { commit: record.testedCode.commit, source: "发布记录 testedCode.commit" };
  return { commit: null, source: "发布记录里没有可用提交" };
}

export function verifyAcceptance(dir: string, options: VerifyOptions = {}): VerifyResult {
  const root = resolve(dir);
  const recordRoot = options.recordDir ? resolve(options.recordDir) : root;
  const repo = resolve(options.repo ?? process.cwd());
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
  const commit = String(manifest.code?.commit ?? "");
  push(
    "manifest.code.commit",
    /^[0-9a-f]{40}$/.test(commit),
    `代码提交 ${commit || "未记录"}`,
  );

  // 1) 提交必须是真实 Git 对象，且等于调用方独立给定 / 冻结发布记录里的受验提交。
  const objectCheck = commitObjectExists(commit, repo);
  push("code.commit.object", objectCheck.ok, objectCheck.detail);

  let expected: { commit: string | null; source: string } = { commit: null, source: "未提供受验提交或发布记录" };
  if (options.expectCommit) {
    expected = { commit: options.expectCommit.trim(), source: "--expect-commit（调用方独立给定）" };
  } else {
    const recordPath = options.releaseRecord ?? findReleaseRecord(root);
    if (recordPath) {
      const release = readJson(recordPath) as ReleaseRecord | null;
      if (!release) {
        expected = { commit: null, source: `发布记录无法解析：${recordPath}` };
      } else {
        const picked = expectedCommitFromRecord(release, manifest.runId);
        expected = { commit: picked.commit, source: `${picked.source}（${recordPath}）` };
      }
    }
  }
  push(
    "code.commit.expected",
    Boolean(expected.commit) && expected.commit === commit,
    expected.commit
      ? `运行时提交 ${commit || "未记录"}；期望 ${expected.commit}（${expected.source}）`
      : `无法确认受验提交：${expected.source}`,
  );

  // 2) 发布验收核对运行时源码状态：标为 dirty 的运行不能签“干净发布版本已验证”。
  push(
    "code.clean",
    manifest.code?.dirty === false,
    manifest.code?.dirty === false
      ? "运行时代码状态干净（dirty=false）"
      : `运行时代码状态 dirty=${String(manifest.code?.dirty)}，不能作为干净发布版本已验证` +
        ((manifest.code?.dirtyPaths ?? []).length ? `：${(manifest.code!.dirtyPaths ?? []).slice(0, 5).join("、")}` : ""),
  );

  // 3) 随交付保存的记录与快照，字节哈希必须与清单一致。
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

  // 4) 快照自身的内容封印：去掉 sha256 字段后重新规范化计算。
  let snapshot: DeliverySnapshot | null = null;
  if (snapshotBytes) {
    try {
      snapshot = JSON.parse(snapshotBytes.toString("utf8")) as DeliverySnapshot;
    } catch {
      snapshot = null;
    }
  }
  let recomputedCard: ReturnType<typeof scorecardFromSnapshot> | null = null;
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

    // 5) 记分卡必须由这一份快照算出：封印相等 + 纯函数逐字段复算一致。
    const recomputed = scorecardFromSnapshot(snapshot);
    recomputedCard = recomputed;
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
      // 每类覆盖数逐字段比对：只核对总数会漏掉“已测改成 99”这种单点篡改。
      const coverageIds = ["tested", "partial", "blocked", "untested", "unregistered"] as const;
      const coverageProblems: string[] = [];
      for (const key of coverageIds) {
        const fromSnapshot = Number((card.coverage as Record<string, number>)[key] ?? 0);
        const fromManifest = Number((manifest.scorecard.coverage ?? {})[key]);
        if (!Number.isFinite(fromManifest)) {
          coverageProblems.push(`${key}: 清单缺该字段`);
        } else if (fromSnapshot !== fromManifest) {
          coverageProblems.push(`${key}: 清单 ${fromManifest} ≠ 快照复算 ${fromSnapshot}`);
        }
      }
      const extra = Object.keys(manifest.scorecard.coverage ?? {}).filter(
        (key) => !(coverageIds as readonly string[]).includes(key),
      );
      if (extra.length) coverageProblems.push(`清单出现未知覆盖类别：${extra.join("、")}`);
      const coverageSum = coverageIds.reduce((sum, key) => sum + Number(card.coverage[key] ?? 0), 0);
      if (coverageSum !== card.denominator) {
        coverageProblems.push(`覆盖合计 ${coverageSum} ≠ 分母 ${card.denominator}`);
      }
      push(
        "scorecard.coverage",
        coverageProblems.length === 0,
        coverageProblems.length
          ? coverageProblems.join("；")
          : coverageIds.map((key) => `${key}=${card.coverage[key]}`).join(" ") + `（合计 ${coverageSum}/${card.denominator}）`,
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

  // 6) 记录本身必须与清单描述同一次运行，且没有任何自报失败的步骤。
  const record = recordJson ? (JSON.parse(recordJson.toString("utf8")) as Record<string, unknown>) : null;
  if (!record) {
    push("record.json.taskId", false, "记录不是可解析的 JSON");
  } else {
    push(
      "record.json.taskId",
      record.taskId === manifest.taskId,
      `记录 taskId=${String(record.taskId)}（清单 ${manifest.taskId}）`,
    );
    const recordScorecard = record.scorecard as
      | { snapshotSha256?: string; coverage?: Record<string, number>; denominator?: number; historicallyPassed?: number; currentlySupported?: number; unknownAttribution?: number }
      | undefined;
    push(
      "record.json.snapshotSha256",
      Boolean(recordScorecard?.snapshotSha256) &&
        recordScorecard!.snapshotSha256 === manifest.files.snapshot.sealSha256,
      `记录引用 ${String(recordScorecard?.snapshotSha256)}；快照封印 ${manifest.files.snapshot.sealSha256}`,
    );
    // 记录的记分卡与快照复算三向一致（记录 / 清单 / 快照）。
    if (recomputedCard?.ok) {
      const card = recomputedCard.scorecard;
      const mismatches: string[] = [];
      for (const key of ["denominator", "historicallyPassed", "currentlySupported", "unknownAttribution"] as const) {
        const fromRecord = recordScorecard?.[key];
        if (fromRecord !== undefined && Number(fromRecord) !== Number(card[key])) {
          mismatches.push(`${key}: 记录 ${String(fromRecord)} ≠ 快照复算 ${card[key]}`);
        }
      }
      for (const key of ["tested", "partial", "blocked", "untested", "unregistered"] as const) {
        const fromRecord = recordScorecard?.coverage?.[key];
        if (fromRecord !== undefined && Number(fromRecord) !== Number(card.coverage[key])) {
          mismatches.push(`coverage.${key}: 记录 ${String(fromRecord)} ≠ 快照复算 ${card.coverage[key]}`);
        }
      }
      push(
        "record.json.scorecard",
        mismatches.length === 0,
        mismatches.length ? mismatches.join("；") : "记录中的记分卡与快照复算逐字段一致",
      );
    }
    const steps = Array.isArray(record.steps) ? record.steps : [];
    const failed = steps.filter((step) => (step as { ok?: boolean }).ok === false).length;
    push(
      "record.json.steps",
      steps.length === manifest.steps.total && failed === manifest.steps.failed,
      `记录 ${steps.length} 步、失败 ${failed}（清单 ${manifest.steps.total} 步、失败 ${manifest.steps.failed}）`,
    );
    // 任何自报失败的运行都不能汇总成通过：清单与记录都不能有失败步骤。
    push(
      "record.json.steps.failed",
      failed === 0,
      failed === 0 ? "记录中没有失败步骤" : `记录中有 ${failed} 个失败步骤：${steps
        .filter((step) => (step as { ok?: boolean }).ok === false)
        .slice(0, 5)
        .map((step) => String((step as { step?: unknown }).step))
        .join("、")}`,
    );
    const recordRootPath = (record.dataRoot as string | undefined) ?? "";
    push(
      "record.json.runId",
      recordRootPath.endsWith(manifest.runId),
      `记录数据目录 ${recordRootPath}（清单 runId ${manifest.runId}）`,
    );
  }
  push(
    "manifest.steps.failed",
    Number(manifest.steps?.failed) === 0,
    Number(manifest.steps?.failed) === 0
      ? `清单记录 ${Number(manifest.steps?.total)} 步全部通过`
      : `清单自报失败步骤 ${Number(manifest.steps?.failed)} 个（共 ${Number(manifest.steps?.total)} 步）`,
  );
  push(
    "manifest.steps.passed",
    Number(manifest.steps?.passed) === Number(manifest.steps?.total),
    `清单通过 ${Number(manifest.steps?.passed)} / 总数 ${Number(manifest.steps?.total)}`,
  );

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
  const value = (name: string): string | undefined => {
    const index = args.indexOf(name);
    if (index < 0) return undefined;
    const picked = args[index + 1];
    return picked && !picked.startsWith("--") ? picked : undefined;
  };
  const dir = args.find((arg, index) => {
    if (arg.startsWith("--")) return false;
    const previous = args[index - 1];
    return !["--record", "--out", "--expect-commit", "--release-record", "--repo"].includes(previous ?? "");
  });
  const recordDir = value("--record");
  const out = value("--out");
  const expectCommit = value("--expect-commit");
  const releaseRecord = value("--release-record");
  const repo = value("--repo");
  if (!dir) {
    console.error(
      "usage: acceptance-verify <dir> [--expect-commit <sha40> | --release-record <file>] [--repo <git dir>] [--record <dir>] [--out receipt.json]",
    );
    process.exit(2);
  }
  const result = verifyAcceptance(dir, { recordDir, expectCommit, releaseRecord, repo });
  print(result);
  if (out) {
    writeFileSync(resolve(out), JSON.stringify({ ...result, verifiedAt: new Date().toISOString() }, null, 2) + "\n");
  }
  if (!result.ok) process.exitCode = 1;
}

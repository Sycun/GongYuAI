import { createHash } from "node:crypto";
import type {
  BusinessReconcileConfig,
  GoalSpec,
  ReconcileCounts,
  ReconcileGate,
  ReconcileInputStamp,
  ReconcileResult,
  ReconcileRevision,
} from "@gongyuai/contracts";
import { readEvidenceBytes, resolveEvidenceFile } from "./evidence.js";
import { minimatch } from "./minimatch.js";

export type EvidenceSnapshot = { path: string; sha256: string; content: Buffer };

export function captureEvidence(dir: string, input: string): EvidenceSnapshot {
  const path = resolveEvidenceFile(dir, input).relativePath;
  const content = readEvidenceBytes(dir, path);
  if (content.length === 0) throw new Error(`empty evidence file: ${path}`);
  const sha256 = createHash("sha256").update(content).digest("hex");
  return { path, sha256, content };
}

export function collectGoalEvidence(
  dir: string,
  goal: Pick<GoalSpec, "evidencePatterns" | "evidenceChecks" | "boardGate">,
  paths: string[],
  options: { deferPatternsToReconcileGate?: boolean } = {},
) {
  const files = new Map<string, EvidenceSnapshot>();
  for (const path of paths) {
    try {
      const file = captureEvidence(dir, path);
      files.set(file.path, file);
    } catch {
      throw new Error(`missing or invalid evidence file: ${path}`);
    }
  }
  // 业务核算目标的验收依据由核算条件判定（并点名缺哪一侧材料），这里不再用
  // 文件是否存在来抢答“缺件”。
  if (!options.deferPatternsToReconcileGate) {
    for (const pattern of goal.evidencePatterns) {
      if (![...files.keys()].some((p) => minimatch(p, pattern))) {
        throw new Error(`missing evidence for pattern "${pattern}"`);
      }
    }
  }
  // Benchmark board semantics are opt-in per goal (`boardGate: "tsecbench"`).
  // An ordinary engagement may legitimately attach a business file named
  // ALL_COMPLETE.json; it is then judged by its declared patterns/checks only.
  if (goal.boardGate === "tsecbench") {
    for (const file of files.values()) {
      if (/(^|\/)ALL_COMPLETE\.json$/i.test(file.path)) {
        const reason = checkBoard(file.content.toString("utf8"));
        if (reason) throw new Error(reason);
      }
    }
  }
  for (const rule of goal.evidenceChecks ?? []) {
    const matches = [...files.values()].filter((f) => minimatch(f.path, rule.pattern));
    if (!matches.length) throw new Error(`no evidence for content check: ${rule.pattern}`);
    for (const file of matches) {
      let data: unknown;
      try { data = JSON.parse(file.content.toString("utf8")); }
      catch { throw new Error(`invalid JSON: ${file.path}`); }
      if (data === null || typeof data !== "object" || Array.isArray(data) ||
          !Object.hasOwn(data, rule.field) || (data as Record<string, unknown>)[rule.field] !== rule.equals) {
        throw new Error(`content check failed: ${file.path} field ${rule.field}`);
      }
    }
  }
  return [...files.values()];
}

function checkBoard(raw: string): string | null {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return "ALL_COMPLETE.json must be valid JSON";
  }
  if (!Array.isArray(data) || data.length === 0) {
    return "ALL_COMPLETE.json must be a non-empty challenge array";
  }
  const incomplete: string[] = [];
  for (const row of data) {
    if (!row || typeof row !== "object") {
      return "ALL_COMPLETE.json entries must be objects";
    }
    const rec = row as { unique_code?: unknown; is_completed?: unknown };
    const code = typeof rec.unique_code === "string" ? rec.unique_code : "?";
    if (rec.is_completed !== true) incomplete.push(code);
  }
  if (incomplete.length > 0) {
    return `ALL_COMPLETE.json still has incomplete challenges: ${incomplete.slice(0, 12).join(", ")}${incomplete.length > 12 ? "…" : ""}`;
  }
  return null;
}

/** 64 位小写十六进制：材料封存哈希的形状。 */
function isSha256(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
}

/** 数据库里的一条核算归档记录（首次判定的权威顺序来自它，不来自文件名）。 */
export type ArchivedReconcile = {
  revision: ReconcileRevision;
  evidencePath: string;
  evidenceSha256: string;
  counts: ReconcileCounts;
};

/** 一份材料在“现在”的样子。 */
export type CurrentMaterial = { path: string; present: boolean; sha256: string | null };

function currentMaterial(dir: string, path: string): CurrentMaterial {
  try {
    const bytes = readEvidenceBytes(dir, path);
    return { path, present: true, sha256: createHash("sha256").update(bytes).digest("hex") };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (/ENOENT|no such file/i.test(message)) return { path, present: false, sha256: null };
    throw err;
  }
}

export type InputVerification = {
  ok: boolean;
  /** ok=输入未变；missing-material=材料被撤走或在核算时就缺；replaced=内容变了。 */
  state: "ok" | "missing-material" | "replaced" | "unrecorded";
  reason: string | null;
  baseline: { recorded: ReconcileInputStamp; now: CurrentMaterial };
  current: { recorded: ReconcileInputStamp; now: CurrentMaterial };
};

function short(hash: string | null): string {
  return hash ? `${hash.slice(0, 12)}…` : "无";
}

/**
 * 核对“核算时读到的输入”与“现在仍然有效的输入”。
 *
 * 这是首次通过的核心约束：材料被撤走、被替换（内容哈希变了）或核算当时就
 * 没读到，那条核算结果都不能支撑**本次**首次通过——它保留下来供追溯，但不
 * 作为判定依据。只看内容哈希，不看文件路径、文件名排序或时间戳。
 */
export function verifyRevisionInputs(
  dir: string,
  revision: ReconcileRevision,
): InputVerification {
  const baselineNow = currentMaterial(dir, revision.baseline.path);
  const currentNow = currentMaterial(dir, revision.current.path);

  type Issue = {
    side: "基线" | "当前";
    kind: "absent-at-reconcile" | "unrecorded" | "withdrawn" | "replaced";
    stamp: ReconcileInputStamp;
    now: CurrentMaterial;
    text: string;
  };
  const issues: Issue[] = [];

  const inspect = (
    side: "基线" | "当前",
    recorded: ReconcileInputStamp,
    now: CurrentMaterial,
  ) => {
    if (!recorded.present) {
      issues.push({
        side,
        kind: "absent-at-reconcile",
        stamp: recorded,
        now,
        text: `${side} ${recorded.path}`,
      });
      return;
    }
    if (!isSha256(recorded.sha256)) {
      issues.push({
        side,
        kind: "unrecorded",
        stamp: recorded,
        now,
        text: `${side}材料 ${recorded.path} 没有内容哈希，无法证明比对真的读过它`,
      });
      return;
    }
    if (!now.present) {
      issues.push({
        side,
        kind: "withdrawn",
        stamp: recorded,
        now,
        text: `${side}材料已撤走：${recorded.path}（核算时哈希 ${short(recorded.sha256)}）`,
      });
      return;
    }
    if (now.sha256 !== recorded.sha256) {
      issues.push({
        side,
        kind: "replaced",
        stamp: recorded,
        now,
        text: `${side}材料已替换：${recorded.path}（核算时 ${short(recorded.sha256)}，现在 ${short(now.sha256)}）`,
      });
    }
  };

  inspect("基线", revision.baseline, baselineNow);
  inspect("当前", revision.current, currentNow);

  const problems: string[] = [];
  const bothAbsent = issues.filter((issue) => issue.kind === "absent-at-reconcile");
  if (bothAbsent.length === 2) {
    // 两侧都没读到：一句话点名两份材料，与验收口径一致。
    problems.push(
      `缺少两侧材料：基线 ${revision.baseline.path}、当前 ${revision.current.path}（该结果本身是缺件结论）`,
    );
  } else {
    for (const issue of issues) {
      if (issue.kind === "absent-at-reconcile") {
        problems.push(`核算时缺少${issue.side}材料 ${issue.stamp.path}（该结果本身是缺件结论）`);
      } else {
        problems.push(issue.text);
      }
    }
  }

  const state: InputVerification["state"] =
    issues.some((issue) => issue.kind === "absent-at-reconcile" || issue.kind === "withdrawn")
      ? "missing-material"
      : issues.some((issue) => issue.kind === "replaced")
        ? "replaced"
        : issues.some((issue) => issue.kind === "unrecorded")
          ? "unrecorded"
          : "ok";

  return {
    ok: problems.length === 0,
    state,
    reason: problems.length ? problems.join("；") : null,
    baseline: { recorded: revision.baseline, now: baselineNow },
    current: { recorded: revision.current, now: currentNow },
  };
}

/**
 * 目标级核算条件（第七轮）：读的是核算结果本身，不是提示文案：
 * 缺基线 / 缺当前 / 两侧都缺时点名缺哪一份；结论停在未知或歧义时拒绝通过。
 *
 * 约定检查项在两份清单中都不存在（有效核查结论）不在这里拦截。
 */
function describeReconcileFailure(result: ReconcileResult, gate: ReconcileGate): string[] {
  const problems: string[] = [];
  const missing = Array.isArray(result.missingMaterials) ? result.missingMaterials : [];
  const baselineMissing = missing.includes(result.baseline?.path ?? "");
  const currentMissing = missing.includes(result.current?.path ?? "");
  if (baselineMissing && currentMissing) {
    problems.push(`缺少两侧材料：基线 ${result.baseline?.path ?? "未声明"}、当前 ${result.current?.path ?? "未声明"}`);
  } else if (baselineMissing) {
    problems.push(`缺少基线材料 ${result.baseline?.path ?? "未声明"}`);
  } else if (currentMissing) {
    problems.push(`缺少当前材料 ${result.current?.path ?? "未声明"}`);
  }
  if (!baselineMissing && !isSha256(result.baseline?.sha256)) {
    problems.push(`基线材料 ${result.baseline?.path ?? "未声明"} 没有封存哈希，无法证明比对真的读过它`);
  }
  if (!currentMissing && !isSha256(result.current?.sha256)) {
    problems.push(`当前材料 ${result.current?.path ?? "未声明"} 没有封存哈希，无法证明比对真的读过它`);
  }
  const counts = result.counts ?? { unknown: 0, ambiguous: 0, totalKeys: 0 };
  if (!(Number(counts.totalKeys) > 0)) problems.push("核算结果没有任何主键项，不能算完成比对");
  if (Number(counts.unknown) > gate.maxUnknown) {
    problems.push(`未知项 ${counts.unknown} 项 > 允许 ${gate.maxUnknown} 项（本次核算没有得出结论）`);
  }
  if (Number(counts.ambiguous ?? 0) > gate.maxAmbiguous) {
    problems.push(`重复主键歧义 ${counts.ambiguous} 项 > 允许 ${gate.maxAmbiguous} 项`);
  }
  if (gate.names?.length && !gate.names.includes(result.name)) {
    problems.push(`核算名 ${result.name} 不在允许清单（${gate.names.join(" / ")}）`);
  }
  return problems;
}

/**
 * 一条归档能否为这个目标作证。
 *
 * 业务目标：必须记在它名下，且核算口径与目标声明一致。
 * 老形状目标（只声明 reconcileGate、没有 business）：仍按图案匹配，但**不能
 * 借用记在别的目标名下的结果**——只接受未绑定目标的归档（旧的手动核算），
 * 或包含本目标的归档。这样“另一笔业务目标的核算结果”不会被老目标捡走。
 */
function archiveBelongsToGoal(
  archive: ArchivedReconcile,
  goalId: string,
  expectedConfigDigest: string | undefined,
): boolean {
  const goalIds = archive.revision.goalIds ?? [];
  if (expectedConfigDigest) {
    return goalIds.includes(goalId) && archive.revision.configDigest === expectedConfigDigest;
  }
  return goalIds.length === 0 || goalIds.includes(goalId);
}

export type ReconcileGateOutcome =
  | {
      ok: true;
      adopted: EvidenceSnapshot;
      result: ReconcileResult;
      revision: ReconcileRevision;
      verification: InputVerification;
    }
  | {
      ok: false;
      reason: string;
      considered: string[];
      /** 与“为什么没过”对应的状态，控制台据此显示待补 / 待重算。 */
      state: ReconcileState;
    };

/** 目标核算态：缺材料、待重算、结论不合格、可判定、已通过。 */
export type ReconcileState =
  | "passed"
  | "no-result"
  | "missing-material"
  | "stale"
  | "unsatisfied"
  | "ready";

function newestFirst(archives: ArchivedReconcile[]): ArchivedReconcile[] {
  // 版本号是单调唯一 id（毫秒 + 序号），字典序倒序即时间倒序；不依赖文件路径
  // 或文件名排序，也不依赖秒级时间戳。
  return [...archives].sort((a, b) => (a.revision.id < b.revision.id ? 1 : a.revision.id > b.revision.id ? -1 : 0));
}

function parseArchivedResult(
  dir: string,
  archive: ArchivedReconcile,
): { ok: true; file: EvidenceSnapshot; result: ReconcileResult } | { ok: false; reason: string } {
  let content: Buffer;
  try {
    content = readEvidenceBytes(dir, archive.evidencePath);
  } catch {
    return { ok: false, reason: `${archive.evidencePath}：核算结果文件已丢失` };
  }
  const sha256 = createHash("sha256").update(content).digest("hex");
  if (sha256 !== archive.evidenceSha256) {
    return {
      ok: false,
      reason: `${archive.evidencePath}：文件内容与归档哈希不一致（归档 ${archive.evidenceSha256.slice(0, 12)}…，现在 ${sha256.slice(0, 12)}…）`,
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(content.toString("utf8"));
  } catch {
    return { ok: false, reason: `${archive.evidencePath}：不是可解析的 JSON` };
  }
  if (!parsed || typeof parsed !== "object" || (parsed as { version?: unknown }).version !== 1) {
    return { ok: false, reason: `${archive.evidencePath}：不是本平台的核算结果（version≠1）` };
  }
  const result = parsed as ReconcileResult;
  if (!result.counts || !Array.isArray(result.items)) {
    return { ok: false, reason: `${archive.evidencePath}：缺少 counts/items，不是核算结果` };
  }
  const revision = result.revision;
  if (!revision) {
    return {
      ok: false,
      reason: `${archive.evidencePath}：结果里没有输入版本信息，无法核对判定当时的输入（需要重新核算）`,
    };
  }
  if (revision.id !== archive.revision.id || revision.inputDigest !== archive.revision.inputDigest) {
    return { ok: false, reason: `${archive.evidencePath}：结果内的版本信息与归档记录不一致` };
  }
  if (revision.configDigest !== archive.revision.configDigest) {
    return { ok: false, reason: `${archive.evidencePath}：结果内的核算口径与归档记录不一致` };
  }
  return { ok: true, file: { path: archive.evidencePath, sha256, content }, result };
}


/** 逐项列出“目标声明”与“实际核算”的口径差异，供人直接照着改。 */
function describeConfigDifference(
  goal: BusinessReconcileConfig | undefined,
  actual: BusinessReconcileConfig,
): string {
  if (!goal) return "目标没有声明业务核算配置";
  const diffs: string[] = [];
  if (goal.name !== actual.name) diffs.push(`核算名 ${goal.name} ≠ ${actual.name}`);
  if (goal.keyField !== actual.keyField) diffs.push(`主键 ${goal.keyField} ≠ ${actual.keyField}`);
  const list = (value?: string[]) => [...(value ?? [])].sort().join(",") || "（空）";
  if (list(goal.compareFields) !== list(actual.compareFields)) {
    diffs.push(`比较字段 ${list(goal.compareFields)} ≠ ${list(actual.compareFields)}`);
  }
  if (list(goal.requiredKeys) !== list(actual.requiredKeys)) {
    diffs.push(`约定检查项 ${list(goal.requiredKeys)} ≠ ${list(actual.requiredKeys)}`);
  }
  if (goal.baseline.path !== actual.baseline.path) {
    diffs.push(`基线 ${goal.baseline.path} ≠ ${actual.baseline.path}`);
  }
  if (goal.current.path !== actual.current.path) {
    diffs.push(`当前 ${goal.current.path} ≠ ${actual.current.path}`);
  }
  return diffs.length ? diffs.join("；") : "口径摘要不同";
}

/**
 * 在**归档的核算版本**里选出可以支撑本次首次通过的那一条。
 *
 * 选法：目标绑定的版本里，按版本号倒序找第一条“输入仍是现在的输入、且结论
 * 满足目标条件”的结果。旧结果即便曾经合格，只要材料已撤走 / 已替换 / 口径
 * 不同，就不参与这次判定（`considered` 里会写明被否原因）。
 */
export function selectAdoptedReconcile(input: {
  evidenceDir: string;
  gate: ReconcileGate;
  goalId: string;
  /** 业务目标的核算口径摘要；legacy 文件型目标没有配置，传 undefined。 */
  expectedConfigDigest?: string;
  /** 目标声明的核算配置，仅在诊断口径差异时用来逐项列出不同。 */
  goalConfig?: BusinessReconcileConfig;
  archives: ArchivedReconcile[];
}): ReconcileGateOutcome {
  const { evidenceDir, gate, goalId, expectedConfigDigest, goalConfig, archives } = input;
  const candidates = newestFirst(archives).filter(
    (archive) =>
      minimatch(archive.evidencePath, gate.pattern) &&
      archiveBelongsToGoal(archive, goalId, expectedConfigDigest),
  );
  if (!candidates.length) {
    // 有归档但没一条属于这个目标/这个口径时，要说清是哪一层对不上：
    // 记在别目标名下、还是核算口径与目标声明不同（逐项列出差异）。
    const samePattern = newestFirst(archives).filter((archive) =>
      minimatch(archive.evidencePath, gate.pattern),
    );
    const otherGoal = samePattern.filter(
      (archive) => (archive.revision.goalIds ?? []).length > 0 && !archive.revision.goalIds.includes(goalId),
    );
    const sameGoalOtherScope = expectedConfigDigest
      ? samePattern.filter(
          (archive) =>
            archive.revision.goalIds.includes(goalId) && archive.revision.configDigest !== expectedConfigDigest,
        )
      : [];
    let scope: string;
    if (!samePattern.length) {
      const legacy = archives.filter((archive) => !archive.revision.goalIds?.length).length;
      scope = expectedConfigDigest
        ? `该目标还没有按目标配置核算过（${gate.pattern}）`
        : archives.length && legacy
          ? `该目标没有可用的核算归档（${gate.pattern}）：已有 ${legacy} 份未绑定目标的旧格式结果不参与首次判定，需按当前材料重新核算`
          : `evidence/ 下没有匹配 ${gate.pattern} 的核算结果`;
    } else if (sameGoalOtherScope.length) {
      scope =
        `核算口径与目标声明不一致（${sameGoalOtherScope[0]!.evidencePath}）：` +
        String(describeConfigDifference(goalConfig, sameGoalOtherScope[0]!.revision.config));
    } else if (otherGoal.length) {
      scope = `匹配 ${gate.pattern} 的核算结果记在别的目标名下（${otherGoal[0]!.revision.goalIds.join("、") || "未绑定目标"}），不能套用`;
    } else {
      scope = `该目标还没有按目标配置核算过（${gate.pattern}）`;
    }
    return {
      ok: false,
      state: "no-result",
      reason: `核算条件未满足：${scope}——先补交材料并运行核算`,
      considered: [],
    };
  }

  const rejected: string[] = [];
  /**
   * 结论优先取**最新一版**核算的处境：最新版输入仍有效但结论不合格 → 待修正；
   * 最新版输入已变 → 待重算。更早的版本只作为“能否支撑本次通过”的候选，不
   * 拿它们的处境混报最新状态。
   */
  let primary: ReconcileState | null = null;
  for (const archive of candidates) {
    const parsed = parseArchivedResult(evidenceDir, archive);
    if (!parsed.ok) {
      if (!primary) primary = "unsatisfied";
      rejected.push(parsed.reason);
      continue;
    }
    const verification = verifyRevisionInputs(evidenceDir, archive.revision);
    if (!verification.ok) {
      if (!primary) {
        primary = verification.state === "missing-material" ? "missing-material" : "stale";
      }
      rejected.push(
        `${archive.evidencePath}（版本 ${archive.revision.id}）：${verification.reason}`,
      );
      continue;
    }
    const problems = describeReconcileFailure(parsed.result, gate);
    if (problems.length) {
      if (!primary) primary = "unsatisfied";
      rejected.push(`${archive.evidencePath}（版本 ${archive.revision.id}）：${problems.join("；")}`);
      continue;
    }
    return {
      ok: true,
      adopted: parsed.file,
      result: parsed.result,
      revision: archive.revision,
      verification,
    };
  }

  const state: ReconcileState = primary ?? "no-result";
  return {
    ok: false,
    state,
    reason: `核算条件未满足：${rejected.join(" | ")}`,
    considered: candidates.map((archive) => `${archive.revision.id}:${archive.evidencePath}`),
  };
}

export type ReconcileStateReport = {
  state: ReconcileState;
  reason: string | null;
  /** 最近一次核算的版本号（不论合格与否）。 */
  latestRevisionId: string | null;
  /** 最近一次“输入仍是现在输入”的合格版本的版本号。 */
  readyRevisionId: string | null;
  /** 目标声明的两侧材料现在是否齐全。 */
  materials: {
    baseline: { path: string; present: boolean };
    current: { path: string; present: boolean };
  } | null;
  /** 当前材料若与最近一次核算不同，逐项说明差异。 */
  drift: InputVerification | null;
  /**
   * 最近一版核算里的歧义项（重复主键冲突）：键、原因与全部来源行。
   * 操作员要在界面上直接看到“哪个键、哪几行冲突”，而不是只看到一个计数。
   */
  ambiguous: ReconcileAmbiguity[];
};

/** 冲突项的可读出处：材料 + 物理行号（跨行字段记到 endLine）。 */
export type ReconcileAmbiguity = {
  key: string;
  reason: string;
  lines: Array<{ material: "baseline" | "current"; line: number; endLine: number }>;
};

/** 从一版核算结果里取出歧义项（最多 10 条，够人眼复核）。 */
function ambiguityOf(result: ReconcileResult | null): ReconcileAmbiguity[] {
  if (!result) return [];
  const out: ReconcileAmbiguity[] = [];
  for (const item of result.items) {
    if (item.status !== "ambiguous") continue;
    out.push({
      key: item.key,
      reason: item.reason ?? "duplicate-key-conflict",
      lines: (item.duplicates ?? []).map((dup) => ({
        material: dup.material,
        line: dup.line,
        endLine: dup.endLine,
      })),
    });
    if (out.length >= 10) break;
  }
  return out;
}

/**
 * 控制台与报告共用的目标核算态。输入一变（撤走 / 替换）就显示待补或待重算，
 * 不用等到下一次判定才知道目标已经不成立。
 */
export function describeReconcileState(input: {
  evidenceDir: string;
  gate: ReconcileGate;
  goalId: string;
  expectedConfigDigest?: string;
  archives: ArchivedReconcile[];
  /** 目标声明里已知的材料路径（未核算过也能提示缺哪一份）。 */
  declaredMaterials?: { baseline: string; current: string };
}): ReconcileStateReport {
  const { evidenceDir, gate, goalId, expectedConfigDigest, archives, declaredMaterials } = input;
  const candidates = newestFirst(archives).filter(
    (archive) =>
      minimatch(archive.evidencePath, gate.pattern) &&
      archiveBelongsToGoal(archive, goalId, expectedConfigDigest),
  );
  const latest = candidates[0]?.revision ?? null;
  const materials = latest
    ? {
        baseline: { path: latest.baseline.path, present: currentMaterial(evidenceDir, latest.baseline.path).present },
        current: { path: latest.current.path, present: currentMaterial(evidenceDir, latest.current.path).present },
      }
    : declaredMaterials
      ? {
          baseline: { path: declaredMaterials.baseline, present: currentMaterial(evidenceDir, declaredMaterials.baseline).present },
          current: { path: declaredMaterials.current, present: currentMaterial(evidenceDir, declaredMaterials.current).present },
        }
      : null;

  const drift = latest ? verifyRevisionInputs(evidenceDir, latest) : null;
  const latestArchive = candidates[0] ?? null;
  const latestParsed = latestArchive ? parseArchivedResult(evidenceDir, latestArchive) : null;
  const ambiguous = latestParsed && latestParsed.ok ? ambiguityOf(latestParsed.result) : [];
  const adopted = selectAdoptedReconcile({ evidenceDir, gate, goalId, ...(expectedConfigDigest ? { expectedConfigDigest } : {}), archives });

  if (adopted.ok) {
    return {
      state: "ready",
      reason: null,
      latestRevisionId: latest?.id ?? null,
      readyRevisionId: adopted.revision.id,
      materials,
      drift,
      ambiguous,
    };
  }
  if (materials) {
    const absent = [materials.baseline, materials.current].filter((side) => !side.present);
    if (absent.length && (adopted.state === "missing-material" || adopted.state === "no-result")) {
      return {
        state: "missing-material",
        reason: `待补材料：${absent.map((side) => side.path).join("、")}`,
        latestRevisionId: latest?.id ?? null,
        readyRevisionId: null,
        materials,
        drift,
        ambiguous,
      };
    }
    // 材料现在齐了，但最近一版核算仍按“缺件”算：这一步是待重算，不是待补材料。
    // 说清“已补齐、需要重新核算”，操作员才知道下一步点哪个按钮。
    if (!absent.length && adopted.state === "missing-material") {
      return {
        state: "stale",
        reason:
          `材料已补齐，需要重新核算：最近一版 ${latest?.id ?? "（无）"} 仍按缺件结论` +
          (latest ? `（${latest.baseline.path}、${latest.current.path}）` : ""),
        latestRevisionId: latest?.id ?? null,
        readyRevisionId: null,
        materials,
        drift,
        ambiguous,
      };
    }
  }
  return {
    state: adopted.state,
    reason: adopted.ok ? null : adopted.reason,
    latestRevisionId: latest?.id ?? null,
    readyRevisionId: null,
    materials,
    drift,
    ambiguous,
  };
}

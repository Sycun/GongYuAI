import { createHash } from "node:crypto";
import type { GoalSpec, ReconcileGate, ReconcileResult } from "@gongyuai/contracts";
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
  for (const pattern of goal.evidencePatterns) {
    if (![...files.keys()].some((p) => minimatch(p, pattern))) {
      throw new Error(`missing evidence for pattern "${pattern}"`);
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

/**
 * 目标级核算条件（第七轮）。读的是核算结果本身，不是提示文案：
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

export type ReconcileGateOutcome =
  | { ok: true; adopted: EvidenceSnapshot; result: ReconcileResult }
  | { ok: false; reason: string; considered: string[] };

/**
 * 在证据文件里挑出**实际满足业务条件**的核算结果。多个候选时按路径顺序取
 * 第一个满足条件的（确定性），并把被否候选的原因一并带回，便于复核。
 */
export function checkReconcileGate(files: EvidenceSnapshot[], gate: ReconcileGate): ReconcileGateOutcome {
  const candidates = files
    .filter((file) => minimatch(file.path, gate.pattern))
    .sort((a, b) => a.path.localeCompare(b.path));
  if (!candidates.length) {
    return {
      ok: false,
      reason: `核算条件未满足：evidence/ 下没有匹配 ${gate.pattern} 的核算结果文件`,
      considered: [],
    };
  }
  const rejected: string[] = [];
  for (const file of candidates) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(file.content.toString("utf8"));
    } catch {
      rejected.push(`${file.path}：不是可解析的 JSON`);
      continue;
    }
    if (!parsed || typeof parsed !== "object" || (parsed as { version?: unknown }).version !== 1) {
      rejected.push(`${file.path}：不是本平台的核算结果（version≠1）`);
      continue;
    }
    const result = parsed as ReconcileResult;
    if (!result.counts || !Array.isArray(result.items)) {
      rejected.push(`${file.path}：缺少 counts/items，不是核算结果`);
      continue;
    }
    const problems = describeReconcileFailure(result, gate);
    if (!problems.length) return { ok: true, adopted: file, result };
    rejected.push(`${file.path}：${problems.join("；")}`);
  }
  return {
    ok: false,
    reason: `核算条件未满足：${rejected.join(" | ")}`,
    considered: candidates.map((file) => file.path),
  };
}

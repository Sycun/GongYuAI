import { createHash } from "node:crypto";
import type { GoalSpec } from "@gongyuai/contracts";
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

export function validateAllCompleteEvidence(evidenceDir: string, path: string): string | null {
  try { return checkBoard(readEvidenceBytes(evidenceDir, path).toString("utf8")); }
  catch { return `cannot read ALL_COMPLETE evidence: ${path}`; }
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

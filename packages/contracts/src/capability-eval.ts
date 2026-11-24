/**
 * P17 — offline command/stage evaluation primitives.
 *
 * This does not call a model. It scores the commands a model (or prompt/harness
 * variant) produced against a fixture, so tool-selection and argument quality
 * can be regression-tested without treating a public benchmark score as truth.
 *
 * Metrics:
 * - exact: normalized command equals the expected command;
 * - partial: same binary (after alias mapping) and all expected flags present;
 * - wrong: different binary or missing flags.
 *
 * Stage coverage is separate from command quality: a command can be right while
 * the stage is still untested, and vice versa.
 */

export type CommandEvalCase = {
  id: string;
  stage: EvalStage;
  intent: string;
  /** Acceptable expected commands; any one matching counts as exact. */
  expected: string[];
  /** Canonical binary -> aliases (e.g. { httpx: ["http", "httpx"] }). */
  aliases?: Record<string, string[]>;
};

export type EvalStage = "recon" | "auth" | "web" | "verify" | "chain" | "report";

export const EVAL_STAGES: EvalStage[] = ["recon", "auth", "web", "verify", "chain", "report"];

export type CommandEvalResult = {
  id: string;
  stage: EvalStage;
  intent: string;
  actual: string;
  expected: string[];
  score: 0 | 0.5 | 1;
  reason: "exact" | "partial" | "binary-mismatch" | "missing-flags" | "empty";
};

const TOKEN_RE = /"([^"]*)"|'([^']*)'|(\S+)/g;

/** Deterministic shell-ish tokenizer; quotes group without being preserved. */
export function tokenizeCommand(command: string): string[] {
  const tokens: string[] = [];
  for (const match of command.matchAll(TOKEN_RE)) {
    tokens.push(match[1] ?? match[2] ?? match[3] ?? "");
  }
  return tokens.filter((token) => token.length > 0);
}

const aliasMap = (aliases?: Record<string, string[]>): Map<string, string> => {
  const out = new Map<string, string>();
  for (const [canonical, values] of Object.entries(aliases ?? {})) {
    out.set(canonical, canonical);
    for (const value of values) out.set(value, canonical);
  }
  return out;
};

export function normalizeCommand(command: string, aliases?: Record<string, string[]>): string[] {
  const tokens = tokenizeCommand(command);
  const map = aliasMap(aliases);
  if (tokens[0] && map.has(tokens[0]!)) tokens[0] = map.get(tokens[0]!)!;
  return tokens;
}

const flags = (tokens: string[]) => tokens.filter((token) => token.startsWith("-"));

export function scoreCommandSelection(
  actual: string,
  expected: string[],
  aliases?: Record<string, string[]>,
): { score: 0 | 0.5 | 1; reason: CommandEvalResult["reason"] } {
  if (!actual.trim()) return { score: 0, reason: "empty" };
  const actualTokens = normalizeCommand(actual, aliases);
  for (const candidate of expected) {
    const expectedTokens = normalizeCommand(candidate, aliases);
    if (actualTokens.join(" ") === expectedTokens.join(" ")) {
      return { score: 1, reason: "exact" };
    }
    if (actualTokens[0] !== expectedTokens[0]) continue;
    const need = flags(expectedTokens);
    const have = new Set(flags(actualTokens));
    if (need.every((flag) => have.has(flag))) return { score: 0.5, reason: "partial" };
    return { score: 0, reason: "missing-flags" };
  }
  return { score: 0, reason: "binary-mismatch" };
}

export function evaluateCommandSet(
  cases: readonly CommandEvalCase[],
  actualById: Record<string, string>,
): {
  results: CommandEvalResult[];
  exact: number;
  partial: number;
  wrong: number;
  totalScore: number;
  maxScore: number;
} {
  const results = cases.map((testCase) => {
    const actual = actualById[testCase.id] ?? "";
    const scored = scoreCommandSelection(actual, testCase.expected, testCase.aliases);
    return {
      id: testCase.id,
      stage: testCase.stage,
      intent: testCase.intent,
      actual,
      expected: testCase.expected,
      score: scored.score,
      reason: scored.reason,
    } satisfies CommandEvalResult;
  });
  return {
    results,
    exact: results.filter((result) => result.score === 1).length,
    partial: results.filter((result) => result.score === 0.5).length,
    wrong: results.filter((result) => result.score === 0).length,
    totalScore: results.reduce((sum, result) => sum + result.score, 0),
    maxScore: results.length,
  };
}

export type StageCoverage = {
  stage: EvalStage;
  required: number;
  covered: number;
  missing: string[];
};

export function evaluateStageCoverage(
  cases: ReadonlyArray<{ id: string; stage: EvalStage }>,
  coveredIds: readonly string[],
): { stages: StageCoverage[]; coverageRate: number | null } {
  const covered = new Set(coveredIds);
  const stages = EVAL_STAGES.map((stage) => {
    const scoped = cases.filter((testCase) => testCase.stage === stage);
    const missing = scoped.filter((testCase) => !covered.has(testCase.id)).map((testCase) => testCase.id);
    return {
      stage,
      required: scoped.length,
      covered: scoped.length - missing.length,
      missing,
    };
  }).filter((entry) => entry.required > 0);
  const required = stages.reduce((sum, entry) => sum + entry.required, 0);
  return {
    stages,
    coverageRate: required > 0 ? Math.round(((required - stages.reduce((sum, entry) => sum + entry.missing.length, 0)) / required) * 1000) / 1000 : null,
  };
}

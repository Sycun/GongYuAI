#!/usr/bin/env node
/**
 * P17 offline command/stage evaluator.
 *
 * Usage:
 *   pnpm eval:p17 -- --file examples/p17-eval/fixtures.json
 *   pnpm eval:p17 -- --self-test
 *
 * Fixture shape:
 *   { "cases": [{ "id", "stage", "intent", "expected": [], "aliases"? }],
 *     "actual": { "case-id": "command the model produced" },
 *     "covered": ["case-id"] }
 *
 * This never calls a model. It scores commands and stage coverage only.
 */
import { readFileSync } from "node:fs";
import {
  evaluateCommandSet,
  evaluateStageCoverage,
  type CommandEvalCase,
  type EvalStage,
} from "@gongyuai/contracts";

type Fixture = {
  cases: CommandEvalCase[];
  actual: Record<string, string>;
  covered?: string[];
};

const SELF_TEST: Fixture = {
  cases: [
    { id: "recon-1", stage: "recon", intent: "service discovery", expected: ["nmap -sV -p 80,443 host"] },
    { id: "web-1", stage: "web", intent: "probe endpoints", expected: ["httpx -json -u https://host"], aliases: { httpx: ["http"] } },
    { id: "verify-1", stage: "verify", intent: "control request", expected: ["curl -s -o /dev/null -w '%{http_code}' https://host"] },
  ],
  actual: {
    "recon-1": "nmap -sV -p 80,443 host",
    "web-1": "http -json -u https://host",
    "verify-1": "",
  },
  covered: ["recon-1", "web-1"],
};

function arg(name: string): string | null {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] ?? null : null;
}

const file = arg("--file");
const fixture: Fixture = process.argv.includes("--self-test") || !file
  ? SELF_TEST
  : (JSON.parse(readFileSync(file, "utf8")) as Fixture);

const set = evaluateCommandSet(fixture.cases, fixture.actual);
const coverage = evaluateStageCoverage(fixture.cases, fixture.covered ?? []);
const report = {
  generatedAt: new Date().toISOString(),
  source: file ?? "self-test",
  commands: {
    exact: set.exact,
    partial: set.partial,
    wrong: set.wrong,
    totalScore: set.totalScore,
    maxScore: set.maxScore,
    results: set.results,
  },
  stages: coverage,
};
console.log(JSON.stringify(report, null, 2));
if (set.wrong > 0) process.exitCode = 2;

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  evaluateCommandSet,
  evaluateStageCoverage,
  normalizeCommand,
  scoreCommandSelection,
  tokenizeCommand,
} from "./capability-eval.js";

const aliases = { httpx: ["http", "httpx"], nmap: ["nmap"] };

test("tokenizer keeps quoted arguments and alias normalization is deterministic", () => {
  assert.deepEqual(tokenizeCommand(`nmap -sV "10.0.0.0/8" -oX -`), ["nmap", "-sV", "10.0.0.0/8", "-oX", "-"]);
  assert.deepEqual(normalizeCommand("http -json -u https://x", aliases), ["httpx", "-json", "-u", "https://x"]);
});

test("exact / partial / wrong scoring", () => {
  assert.deepEqual(scoreCommandSelection("nmap -sV -p 80 host", ["nmap -sV -p 80 host"]), { score: 1, reason: "exact" });
  assert.deepEqual(scoreCommandSelection("nmap -p 80 -sV host", ["nmap -sV -p 80 host"]), { score: 0.5, reason: "partial" });
  assert.deepEqual(scoreCommandSelection("nmap -sV host", ["nmap -sV -p 80 host"]), { score: 0, reason: "missing-flags" });
  assert.deepEqual(scoreCommandSelection("http -json -u https://x", ["httpx -json -u https://x"], aliases), { score: 1, reason: "exact" });
  assert.deepEqual(scoreCommandSelection("curl https://x", ["nmap -sV x"]), { score: 0, reason: "binary-mismatch" });
  assert.deepEqual(scoreCommandSelection("", ["nmap x"]), { score: 0, reason: "empty" });
});

test("command set totals and stage coverage are separate metrics", () => {
  const cases = [
    { id: "c1", stage: "recon" as const, intent: "ports", expected: ["nmap -sV -p 80 host"] },
    { id: "c2", stage: "web" as const, intent: "probe", expected: ["httpx -json -u https://x"], aliases },
    { id: "c3", stage: "verify" as const, intent: "control", expected: ["curl -s https://x"] },
  ];
  const set = evaluateCommandSet(cases, {
    c1: "nmap -sV -p 80 host",
    c2: "httpx -json -u https://x",
    c3: "",
  });
  assert.equal(set.exact, 2);
  assert.equal(set.wrong, 1);
  assert.equal(set.totalScore, 2);
  const coverage = evaluateStageCoverage(cases, ["c1", "c2"]);
  assert.equal(coverage.coverageRate, 0.667);
  assert.deepEqual(coverage.stages.find((stage) => stage.stage === "verify")?.missing, ["c3"]);
});

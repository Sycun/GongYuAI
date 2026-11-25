import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { collectRunMetrics, renderDiffMarkdown } from "./diff-run-metrics.ts";

const T0 = Date.parse("2026-11-25T00:00:00.000Z");

function iso(offsetMin: number): string {
  return new Date(T0 + offsetMin * 60_000).toISOString();
}

function beijing(offsetMin: number): string {
  const t = new Date(T0 + offsetMin * 60_000 + 8 * 3600_000);
  return t.toISOString().slice(0, 23).replace("T", " ");
}

function seed(dir: string): void {
  mkdirSync(join(dir, "workspace", "relay"), { recursive: true });
  mkdirSync(join(dir, "evidence", "tsecbench"), { recursive: true });
  mkdirSync(join(dir, "evidence", "goals"), { recursive: true });
  mkdirSync(join(dir, "traffic"), { recursive: true });

  const progress = [
    `${beijing(0)} Pi Durable 使用模型`,
    `${beijing(10)} Pi 会话结束但目标未清 → 续跑 #2`,
    `${beijing(20)} evidence_stall force-conclude abc → failed+partial; 20min 无新 verified 证据; phase=reason`,
    `${beijing(80)} Pi 会话结束但目标未清 → 续跑 #3`,
  ].map((line) => `- ${line}`).join("\n");
  writeFileSync(join(dir, "workspace", "PROGRESS.md"), `# 执行进度\n\n${progress}\n`);
  writeFileSync(join(dir, "worker.log"), `[progress] ${beijing(20)} evidence_stall force-conclude abc → failed+partial; 20min 无新 verified 证据; phase=reason\n`);

  const trace = new DatabaseSync(join(dir, "execution-trace.sqlite"));
  trace.exec(`CREATE TABLE steps (seq INTEGER PRIMARY KEY, id TEXT, summary TEXT, shell_calls TEXT)`);
  const insert = trace.prepare("INSERT INTO steps (id, summary, shell_calls) VALUES (?, ?, '[]')");
  insert.run("s1", JSON.stringify({
    at: iso(10),
    number: 1,
    workerSlot: 0,
    tools: ["shell", "http_request"],
    tokens: 1000,
    shellCallCount: 2,
  }));
  insert.run("s2", JSON.stringify({
    at: iso(100),
    number: 2,
    workerSlot: 0,
    tools: ["shell"],
    tokens: 5000,
    shellCallCount: 1,
  }));
  trace.close();

  writeFileSync(join(dir, "evidence", "tsecbench", "a-submit.json"), JSON.stringify({
    code: "a",
    submittedAt: iso(12),
    response: JSON.stringify({ correct: true, unique_code: "a" }),
  }));
  writeFileSync(join(dir, "evidence", "tsecbench", "b-submit.json"), JSON.stringify({
    code: "b",
    submittedAt: iso(90),
    response: { correct: true },
  }));

  const ledger = join(dir, "evidence", "goals", "autonomous-progress.md");
  writeFileSync(ledger, "# ledger\n");
  const ledgerAt = (T0 + 12 * 60_000) / 1000;
  utimesSync(ledger, ledgerAt, ledgerAt);

  writeFileSync(join(dir, "workspace", "relay", "π0.json"), JSON.stringify({
    generation: 0,
    createdAt: iso(15),
    trigger: "auto",
  }));
  writeFileSync(join(dir, "workspace", "relay", "π1.json"), JSON.stringify({
    generation: 1,
    createdAt: iso(120),
    trigger: "auto",
  }));

  const traffic = new DatabaseSync(join(dir, "traffic", "index.sqlite"));
  traffic.exec("CREATE TABLE exchanges (id TEXT PRIMARY KEY, started_at TEXT NOT NULL)");
  traffic.prepare("INSERT INTO exchanges (id, started_at) VALUES (?, ?)").run("e1", iso(5));
  traffic.prepare("INSERT INTO exchanges (id, started_at) VALUES (?, ?)").run("e2", iso(80));
  traffic.close();

  const durable = new DatabaseSync(join(dir, "durable.sqlite"));
  durable.exec("CREATE TABLE entries (id INTEGER PRIMARY KEY, record TEXT NOT NULL)");
  durable.prepare("INSERT INTO entries (record) VALUES (?)").run(JSON.stringify({ kind: "pi.compaction" }));
  durable.close();
}

test("diff-run-metrics windows the first hour and renders a delta table", () => {
  const root = mkdtempSync(join(tmpdir(), "gy-diff-metrics-"));
  const baseline = join(root, "baseline");
  const candidate = join(root, "candidate");
  try {
    seed(baseline);
    mkdirSync(join(candidate, "evidence", "goals"), { recursive: true });
    mkdirSync(join(candidate, "evidence", "engagement"), { recursive: true });
    mkdirSync(join(candidate, "workspace"), { recursive: true });
    writeFileSync(join(candidate, "workspace", "PROGRESS.md"), `# 执行进度\n\n- ${beijing(0)} 启动\n`);
    writeFileSync(join(candidate, "evidence", "goals", "autonomous-progress.md"), "# ledger\n");
    writeFileSync(join(candidate, "evidence", "engagement", "report.md"), "# report\n");

    const full = collectRunMetrics(baseline);
    assert.equal(full.solved, 2);
    assert.equal(full.submitCorrect, 2);
    assert.equal(full.totalTokens, 5000);
    assert.equal(full.steps, 2);
    assert.equal(full.avgTokensPerStep, 2500);
    assert.equal(full.avgTokensPerSolve, 2500);
    assert.equal(full.rounds, 3);
    assert.equal(full.toolCalls, 4);
    assert.equal(full.evidenceStallForces, 1);
    assert.equal(full.compactions, 1);
    assert.equal(full.relayFiles, 2);
    assert.equal(full.trafficRows, 2);
    assert.ok(full.trafficBytes > 0);
    assert.equal(full.goals.status, "landed");
    assert.equal(full.engagement.status, "missing");

    const hour = collectRunMetrics(baseline, { windowMinutes: 60 });
    assert.equal(hour.solved, 1);
    assert.deepEqual(hour.solvedCodes, ["a"]);
    assert.equal(hour.submitCorrect, 1);
    assert.equal(hour.totalTokens, 1000);
    assert.equal(hour.steps, 1);
    assert.equal(hour.rounds, 2);
    assert.equal(hour.toolCalls, 3);
    assert.equal(hour.evidenceStallForces, 1);
    assert.equal(hour.compactions, 0);
    assert.equal(hour.compactionsInDb, 1);
    assert.match(hour.notes.join("\n"), /全量 1/);
    assert.equal(hour.relayFiles, 1);
    assert.equal(hour.trafficRows, 1);
    assert.equal(hour.goals.status, "landed");

    const other = collectRunMetrics(candidate, { windowMinutes: 60 });
    const markdown = renderDiffMarkdown(hour, other);
    assert.match(markdown, /跑批差分/);
    assert.match(markdown, /60 分钟/);
    assert.match(markdown, /submit correct:true/);
    assert.match(markdown, /traffic\/index\.sqlite 字节/);
    assert.match(markdown, /evidence\/goals/);
    assert.match(markdown, /evidence\/engagement/);
    assert.match(markdown, /未落盘/);
    assert.match(markdown, /已落盘/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

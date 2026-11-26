import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { flag, flags, has, parseGlobal, parseHeaderFlag, positional } from "./args.js";
import { coreCommandNames, handleCoreCommand } from "./commands-core.js";
import { frozenCommandNames } from "./commands-frozen.js";
import { reviewCommandNames } from "./commands-review.js";
import { renderHelp, renderHelpForCommand } from "./help.js";

const CORE = [
  "serve", "run", "status", "pause", "resume", "stop", "scope", "hint", "logs", "report", "archive", "unarchive",
  "handoff", "jobs", "job-submit", "job", "job-retry", "job-ack",
  "consults", "consult", "answer", "consult-sweep",
  "material", "materials", "matrix", "freshness", "changes", "change", "rollback",
  "graph", "causality", "today", "inspect",
];

const REVIEW = [
  "findings", "finding-verify", "finding-retract", "finding-validate", "validations", "accept",
  "audit", "chain", "command-reset",
  "review", "retest", "retest-request", "retest-requests", "peer-review", "peer-reviews",
  "reconcile", "scorecard", "coverage-snapshot", "coverage-compare", "coverage-cell",
  "evidence", "correct", "correction-notice", "corrections", "session",
];

const FROZEN = [
  "memory", "contact", "proposals", "proposal", "proposal-create", "proposal-decide",
  "proposal-promote", "proposal-rollback", "eval-run", "evals", "trend", "role", "provider-fault",
];

test("parseGlobal reads global flags from anywhere and keeps the command", () => {
  const parsed = parseGlobal(
    [
      "--host", "10.0.0.2",
      "run",
      "--target", "https://a.example",
      "--target", "https://b.example",
      "--port", "9000",
      "--data-dir", "/data",
      "--base-url", "http://127.0.0.1:9000",
      "--goals", "g.json",
    ],
    { GY_DATA_DIR: "/from-env", GY_HOST: "192.0.2.10", GY_PORT: "1" },
  );
  assert.equal(parsed.cmd, "run");
  assert.deepEqual(parsed.rest, ["--target", "https://a.example", "--target", "https://b.example", "--goals", "g.json"]);
  assert.deepEqual(parsed.opts, {
    dataDir: "/data",
    host: "10.0.0.2",
    port: 9000,
    baseUrl: "http://127.0.0.1:9000",
  });
  assert.deepEqual(flags(parsed.rest, "--target"), ["https://a.example", "https://b.example"]);
});

test("parseGlobal falls back to GY_* and treats a bare run as help", () => {
  const fromEnv = parseGlobal(["status", "task-1"], { GY_DATA_DIR: "/from-env", GY_HOST: "192.0.2.10", GY_PORT: "4242" });
  assert.equal(fromEnv.cmd, "status");
  assert.deepEqual(fromEnv.rest, ["task-1"]);
  assert.deepEqual(fromEnv.opts, { dataDir: "/from-env", host: "192.0.2.10", port: 4242 });

  const defaults = parseGlobal(["--"], {});
  assert.equal(defaults.cmd, "help");
  assert.deepEqual(defaults.rest, []);
  assert.deepEqual(defaults.opts, { dataDir: "", host: "127.0.0.1", port: 8877 });

  const skipped = parseGlobal(["--", "logs", "task-1"], {});
  assert.equal(skipped.cmd, "logs");
  assert.deepEqual(skipped.rest, ["task-1"]);
});

test("parseGlobal leaves help switches as the command", () => {
  assert.equal(parseGlobal(["--help"], {}).cmd, "--help");
  assert.equal(parseGlobal(["-h", "ignored"], {}).cmd, "-h");
  assert.equal(parseGlobal(["--port", "9", "--help-experimental"], {}).cmd, "--help-experimental");
  assert.equal(parseGlobal(["help-experimental"], {}).cmd, "help-experimental");
});

test("flags collects repeated values and ignores a trailing flag without a value", () => {
  const rest = ["--goals", "g.json", "--target", "https://a", "--name", "n", "--target", "https://b", "--target"];
  assert.deepEqual(flags(rest, "--target"), ["https://a", "https://b"]);
  assert.deepEqual(flags(["--header", "A: 1", "--cookie", "a=b", "--header", "B: 2"], "--header"), ["A: 1", "B: 2"]);
  assert.equal(flag(rest, "--name"), "n");
  assert.equal(flag(rest, "--missing"), undefined);
  assert.equal(flag(["--name"], "--name"), undefined);
  assert.equal(has(["--mock", "--wait"], "--mock"), true);
  assert.equal(has(["--mock"], "--isolated"), false);
});

test("positional keeps bare words and skips flag/value pairs", () => {
  assert.deepEqual(
    positional(["import", "task-1", "--name", "alpha", "--host", "app.example", "--header", "A: B", "--cookie", "a=b"]),
    ["import", "task-1"],
  );
  assert.deepEqual(positional(["task-1", "--out", "snap.json"]), ["task-1"]);
  assert.deepEqual(positional(["--out", "snap.json"]), []);
  assert.deepEqual(positional([]), []);
});

test("parseHeaderFlag accepts Name: Value and rejects incomplete headers", () => {
  assert.deepEqual(parseHeaderFlag("Authorization: Bearer x"), ["Authorization", "Bearer x"]);
  assert.deepEqual(parseHeaderFlag("X-Request-Id:  abc "), ["X-Request-Id", "abc"]);
  assert.deepEqual(parseHeaderFlag("Name: Value: more"), ["Name", "Value: more"]);
  assert.throws(() => parseHeaderFlag("nope"), /--header must be "Name: Value" \(got nope\)/);
  assert.throws(() => parseHeaderFlag(": missing-name"), /--header must be "Name: Value" \(got : missing-name\)/);
  assert.throws(() => parseHeaderFlag("Name:"), /--header must be "Name: Value" \(got Name:\)/);
  assert.throws(
    () => parseHeaderFlag("   : value"),
    (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.equal(err.message, '--header must be "Name: Value" (got    : value)');
      return true;
    },
  );
});

test("default help lists core and review commands and points at experimental help", () => {
  const standard = renderHelp("default");
  const experimental = renderHelp("experimental");
  for (const line of [
    "核心作战:",
    "复核交付:",
    "gy serve ",
    "gy run ",
    "gy status ",
    "gy pause ",
    "gy resume ",
    "gy stop ",
    "gy scope ",
    "gy hint ",
    "gy logs ",
    "gy report ",
    "gy archive ",
    "gy findings ",
    "gy finding-verify ",
    "gy finding-validate ",
    "gy finding-retract ",
    "gy reconcile ",
    "gy scorecard ",
    "gy coverage-snapshot ",
    "gy coverage-compare ",
    "gy coverage-cell ",
    "gy review ",
    "gy retest ",
    "gy retest-request ",
    "gy retest-requests ",
    "gy peer-review ",
    "gy peer-reviews ",
    "gy correct ",
    "gy correction-notice ",
    "gy corrections ",
    "gy evidence ",
    "gy session import ",
    "gy --help-experimental",
    "直接调用这些命令仍然可用",
  ]) {
    assert.equal(standard.includes(line), true, `default help missing ${line}`);
  }
  for (const name of FROZEN) {
    assert.equal(standard.includes(`gy ${name}`), false, `default help still lists gy ${name}`);
    assert.equal(experimental.includes(`gy ${name}`), true, `experimental help missing gy ${name}`);
  }
  assert.match(experimental, /冻结/);
  assert.match(experimental, /直接调用这些命令仍然可用/);
  assert.equal(renderHelpForCommand("--help"), standard);
  assert.equal(renderHelpForCommand("-h"), standard);
  assert.equal(renderHelpForCommand("help"), standard);
  assert.equal(renderHelpForCommand("--help-experimental"), experimental);
  assert.equal(renderHelpForCommand("help-experimental"), experimental);
  assert.equal(renderHelpForCommand("run"), undefined);
});

test("command modules stay disjoint and keep frozen commands registered", () => {
  assert.deepEqual([...coreCommandNames()].sort(), [...CORE].sort());
  assert.deepEqual([...reviewCommandNames()].sort(), [...REVIEW].sort());
  assert.deepEqual([...frozenCommandNames()].sort(), [...FROZEN].sort());
});

function runCli(args: string[]): { status: number | null; stdout: string; stderr: string } {
  const index = fileURLToPath(new URL("./index.ts", import.meta.url));
  const result = spawnSync(process.execPath, ["--import", "tsx", index, ...args], {
    cwd: fileURLToPath(new URL("..", import.meta.url)),
    encoding: "utf8",
    timeout: 20_000,
  });
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

test("gy --help and gy --help-experimental print the two catalogs", () => {
  const standard = runCli(["--help"]);
  const experimental = runCli(["--port", "9", "--help-experimental"]);
  const short = runCli(["-h"]);
  const empty = runCli([]);
  assert.equal(standard.status, 0);
  assert.equal(standard.stdout, `${renderHelp("default")}\n`);
  assert.equal(experimental.status, 0);
  assert.equal(experimental.stdout, `${renderHelp("experimental")}\n`);
  assert.equal(short.stdout, `${renderHelp("default")}\n`);
  assert.equal(empty.status, 0);
  assert.equal(empty.stdout, `${renderHelp("default")}\n`);

  const unknown = runCli(["not-a-command"]);
  assert.equal(unknown.status, 1);
  assert.equal(unknown.stdout, `${renderHelp("default")}\n`);
});

test("frozen commands remain directly invocable", () => {
  for (const [args, message] of [
    [["contact"], "gy contact --targets A,B"],
    [["role"], "gy role <taskId> --role planner|reviewer|assistant --kind plan|review|incident"],
    [["provider-fault"], "gy provider-fault <taskId> --provider NAME --fault rate-limit"],
    [["proposal-create"], "gy proposal-create --file F"],
    [["eval-run"], "gy eval-run --file F"],
  ] as const) {
    const result = runCli([...args]);
    assert.equal(result.status, 1, args.join(" "));
    assert.equal(result.stdout, "", args.join(" "));
    assert.match(result.stderr, new RegExp(message.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), args.join(" "));
  }
});

test("gy matrix routes to /tasks/:id/coverage-matrix endpoint", async () => {
  const hits: string[] = [];
  const srv = createServer((req, res) => {
    hits.push(req.url ?? "");
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ ok: true, cells: [] }));
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  try {
    const addr = srv.address();
    assert.ok(addr && typeof addr === "object");
    const opts = { dataDir: "", host: "127.0.0.1", port: addr.port, baseUrl: `http://127.0.0.1:${addr.port}` };
    const handled = await handleCoreCommand("matrix", ["task-abc"], opts);
    assert.equal(handled, true);
    assert.ok(hits.includes("/tasks/task-abc/coverage-matrix"), `expected coverage-matrix hit, got ${hits.join(",")}`);
  } finally {
    await new Promise<void>((r) => srv.close(() => r()));
  }
});

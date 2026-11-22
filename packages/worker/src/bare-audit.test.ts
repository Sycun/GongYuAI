import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { goalsFromSpecs, WorkerManifestSchema } from "@gongyuai/contracts";
import { openHistory } from "@gongyuai/history";
import { runBareLoop } from "./bare-loop.js";
import { workerStatusPath } from "./status.js";

test("bare audits a denied shell call and stops at the token budget with a local response stub", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "gy-bare-audit-"));
  const key = "GY_BARE_AUDIT_TEST_KEY";
  const previous = process.env[key];
  process.env[key] = "local-fixture";
  t.after(() => {
    if (previous === undefined) delete process.env[key];
    else process.env[key] = previous;
    rmSync(root, { recursive: true, force: true });
  });

  const manifest = WorkerManifestSchema.parse({
    taskId: "11111111-1111-4111-8111-111111111111",
    dataDir: root,
    workspaceDir: join(root, "workspace"),
    evidenceDir: join(root, "evidence"),
    historyDb: join(root, "history.sqlite"),
    durableDb: join(root, "durable.sqlite"),
    auth: { authorizationNote: "Local stub test only", targets: ["example.invalid"], capability: "full" },
    budget: { maxTokens: 2, maxToolCalls: 10 },
    goals: goalsFromSpecs([{
      id: "fixture",
      title: "Local fixture",
      description: "Expect the task to be stopped before this evidence is written",
      evidencePatterns: ["after-limit.txt"],
    }]),
    model: { provider: "openai", apiKeyEnv: key, modelId: "fixture", baseUrl: "http://127.0.0.1:9/v1" },
    mock: false,
  });
  const replies = [
    {
      id: "local-shell",
      function: { name: "shell", arguments: JSON.stringify({ command: "touch local-shell-canary" }) },
    },
    {
      id: "local-after-limit",
      function: {
        name: "write_evidence",
        arguments: JSON.stringify({ relativePath: "after-limit.txt", content: "must not be written" }),
      },
    },
  ];
  let requests = 0;
  t.mock.method(globalThis, "fetch", async () => {
    const call = replies[requests++];
    assert.ok(call, "unexpected request after the budget was exhausted");
    return Response.json({
      usage: { total_tokens: 1 },
      choices: [{ message: { role: "assistant", tool_calls: [call] } }],
    });
  });

  await runBareLoop(manifest);
  assert.equal(requests, 2);
  assert.equal(existsSync(join(manifest.workspaceDir, "local-shell-canary")), false);
  assert.equal(existsSync(join(manifest.evidenceDir, "after-limit.txt")), false);
  const status = JSON.parse(readFileSync(workerStatusPath(root), "utf8"));
  assert.equal(status.status, "budget_exhausted");
  assert.equal(status.error, "maxTokens exceeded");
  assert.deepEqual(status.usage, { tokens: 2, toolCalls: 1, installs: 0 });
  const report = readFileSync(join(root, "report.md"), "utf8");
  assert.match(report, /Status: budget_exhausted\nReason: maxTokens exceeded/);

  const history = openHistory({ dbPath: manifest.historyDb, evidenceDir: manifest.evidenceDir });
  try {
    const gates = history.listEvents(manifest.taskId).filter((event) => event.kind === "tool_gate");
    assert.deepEqual(gates.map((event) => event.payload), [{
      tool: "shell",
      ok: false,
      reason: "denied: shell execution is unavailable in the bare baseline",
      callId: "local-shell",
    }]);
  } finally {
    history.close();
  }
});

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { CreateTaskRequestSchema, type TaskRecord } from "@gongyuai/contracts";
import { openHistory, writeEvidenceFile } from "@gongyuai/history";
import { bootControlPlane, taskPaths } from "./index.js";

test("operator review publishes the original attachment, and terminal restart preserves explicit budgets", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "gy-review-api-"));
  const plane = await bootControlPlane({ dataRoot: root, host: "127.0.0.1", port: 0, runtime: "local", watchdogMs: 60_000 });
  t.after(async () => { await plane.close(); rmSync(root, { recursive: true, force: true }); });
  const req = CreateTaskRequestSchema.parse({
    mock: true, name: "offline review",
    auth: { targets: ["archive.invalid"], authorizationNote: "Offline inventory review only" },
    goals: [{ id: "g", title: "收件归属", description: "复核原始收件记录", evidencePatterns: ["note.txt"] }],
    budget: { maxTokens: 20, maxToolCalls: 10, maxInstalls: 1, maxWallMs: 10_000 },
  });
  const task = plane.store.createTask(req);
  const paths = taskPaths(task.dataDir);
  const history = openHistory({ dbPath: paths.historyDb, evidenceDir: paths.evidenceDir });
  let factId: string;
  try {
    history.seedGoals(task.id, task.goals);
    writeEvidenceFile(paths.evidenceDir, "note.txt", "original receipt");
    factId = history.appendFact({ taskId: task.id, layer: "title", title: "收件记录" }).id;
    assert.equal(history.assertGoal(task.id, "g", ["note.txt"]).ok, true);
  } finally {
    history.close();
  }
  plane.store.finishTask(task, "incomplete", null);
  const url = `${plane.url}/tasks/${task.id}`;
  const review = { factId, goalId: "g", reviewer: "账册员", decision: "confirmed", reason: "核对归属", evidencePath: "note.txt" };
  const sendReview = (body: unknown) => fetch(url + "/reviews", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  });
  assert.equal((await sendReview({ ...review, factId: task.id })).status, 400);
  const response = await sendReview(review);
  assert.equal(response.status, 201);
  const { review: { sha256 } } = await response.json() as { review: { sha256: string } };
  writeEvidenceFile(paths.evidenceDir, "note.txt", "new receipt");
  assert.match(await (await fetch(url + "/report")).text(), /已复核/);
  assert.equal(await (await fetch(url + "/report-evidence/" + sha256)).text(), "original receipt");
  assert.equal((await fetch(url + "/report-evidence/" + "0".repeat(64))).status, 404);

  // Stop at the process boundary; exercise the normal restart, lease and manifest writes.
  const dispatcher = plane.runner as unknown as { startLocal(task: TaskRecord, count: number): TaskRecord };
  const launch = t.mock.method(dispatcher, "startLocal", (record: TaskRecord) => record);
  writeFileSync(join(task.dataDir, "worker-status.json"), JSON.stringify({ usage: { tokens: 6, toolCalls: 2, installs: 0 } }));
  await plane.runner.start(task.id);
  const restarted = plane.store.get(task.id)!;
  const manifest = JSON.parse(readFileSync(paths.manifestPath, "utf8")) as { budget: typeof req.budget };
  assert.equal(manifest.budget.maxTokens, 14);
  assert.equal(manifest.budget.maxToolCalls, 8);
  assert.equal(manifest.budget.maxWallMs, 10_000);
  assert.deepEqual(restarted.budget, req.budget);
  assert.deepEqual(restarted.runStartUsage, { tokens: 6, toolCalls: 2, installs: 0 });
  const detail = await (await fetch(url)).json() as { task: { runUsage: { tokens: number } } };
  assert.equal(detail.task.runUsage.tokens, 0);
  writeFileSync(join(task.dataDir, "worker-status.json"), JSON.stringify({ usage: { tokens: 3, toolCalls: 1, installs: 0 } }));
  const progressed = await (await fetch(url)).json() as { task: { usage: { tokens: number }; runUsage: { tokens: number } } };
  assert.equal(progressed.task.runUsage.tokens, 3);
  assert.equal(progressed.task.usage.tokens, 9);
  restarted.usage.tokens = 20;
  plane.store.finishTask(restarted, "budget_exhausted", null);
  await assert.rejects(plane.runner.start(task.id), /maxTokens/);
  assert.equal(launch.mock.callCount(), 1);
});

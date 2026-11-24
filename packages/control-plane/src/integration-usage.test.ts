import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { CreateTaskRequestSchema, integrationSuccessRate, type ProjectIntegrationUsage, type TaskIntegrationUsage } from "@gongyuai/contracts";
import { openHistory, writeTaskReport } from "@gongyuai/history";
import { bootControlPlane, taskPaths } from "./index.js";

test("task, project and report retain repeated calls, interruptions and untracked history", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "gy-usage-api-"));
  const plane = await bootControlPlane({ dataRoot: root, host: "127.0.0.1", port: 0, runtime: "local", watchdogMs: 60_000, isolated: true });
  t.after(async () => { await plane.close(); rmSync(root, { recursive: true, force: true }); });
  const request = CreateTaskRequestSchema.parse({ name: "台账复核", mock: true,
    auth: { targets: ["archive.invalid"], authorizationNote: "仅限本地合成台账复核" },
    goals: [{ id: "receipt", title: "收件", description: "核对收件单", evidencePatterns: ["receipt.json"] }],
  });
  const old = plane.store.createTask(request);
  const oldRuntime = await (await fetch(`${plane.url}/tasks/${old.id}/runtime`)).json() as { integrations: TaskIntegrationUsage };
  assert.deepEqual(oldRuntime.integrations, { since: null, rows: [] });
  for (const successes of [1, 3]) {
    const task = plane.store.createTask(request);
    const paths = taskPaths(task.dataDir);
    const history = openHistory({ dbPath: paths.historyDb, evidenceDir: paths.evidenceDir });
    try {
      const start = history.trackIntegrationCalls(task.id);
      assert.ok(history.integrationUsage(task.id).since);
      assert.deepEqual(history.integrationUsage(task.id).rows, []);
      for (let i = 0; i < successes; i++) start("skill", "reporting")(true);
      const finish = start("skill", "reporting");
      finish(false);
      finish(true); // Duplicate completion of the same physical attempt.
      start("mcp", "archive", "read"); // Worker interrupted before its response.
      const report = writeTaskReport({ taskId: task.id, dataDir: task.dataDir, auth: task.auth }, history, { status: "stopped" });
      assert.match(readFileSync(report, "utf8"), /MCP \| archive \/ read \| 1 \| 0 \| 0 \| 1 \| —/);
    } finally {
      history.close();
    }
    const runtime = await (await fetch(`${plane.url}/tasks/${task.id}/runtime`)).json() as { integrations: TaskIntegrationUsage };
    assert.equal(runtime.integrations.rows.find((r) => r.kind === "skill")?.succeeded, successes);
  }
  const data = await (await fetch(plane.url + "/settings/usage?integrations=1")).json() as { integrations: ProjectIntegrationUsage };
  assert.equal(data.integrations.tracked, 2);
  assert.equal(data.integrations.tasks, 3);
  const skill = data.integrations.rows.find((r) => r.kind === "skill")!;
  assert.deepEqual([skill.calls, skill.succeeded, skill.failed, integrationSuccessRate(skill)], [6, 4, 2, "66.7%"]);
  const mcp = data.integrations.rows.find((r) => r.kind === "mcp")!;
  assert.deepEqual([mcp.calls, mcp.succeeded, mcp.failed, integrationSuccessRate(mcp)], [2, 0, 0, "—"]);
});

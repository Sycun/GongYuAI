import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test, type TestContext } from "node:test";
import { CreateTaskRequestSchema } from "@gongyuai/contracts";
import { openHistory, writeEvidenceFile } from "@gongyuai/history";
import { bootControlPlane, taskPaths } from "./index.js";

async function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), "gy-delivery-"));
  const plane = await bootControlPlane({ dataRoot: root, host: "127.0.0.1", port: 0, runtime: "local", watchdogMs: 60_000 });
  t.after(async () => { await plane.close(); rmSync(root, { recursive: true, force: true }); });
  const task = plane.store.createTask(CreateTaskRequestSchema.parse({
    auth: { targets: ["archive.invalid"], authorizationNote: "离线交付验收，使用虚构台账" },
    goals: [{ id: "receipt", title: "核对签收", description: "核对归档记录", evidencePatterns: ["receipt.txt"] }],
    budget: { maxTokens: 20 }, mock: true,
  }));
  const paths = taskPaths(task.dataDir);
  const history = openHistory({ dbPath: paths.historyDb, evidenceDir: paths.evidenceDir });
  history.seedGoals(task.id, task.goals);
  t.after(() => history.close());
  return { plane, task, paths, history, url: plane.url + "/tasks/" + task.id };
}

test("task creation rejects duplicate goal identifiers", () => {
  const goal = { id: "receipt", title: "收件", description: "离线验收", evidencePatterns: ["receipt.md"] };
  const result = CreateTaskRequestSchema.safeParse({
    auth: { targets: ["archive.invalid"], authorizationNote: "离线核对授权台账" },
    goals: [goal, { ...goal, title: "签收" }],
  });
  assert.equal(result.success, false);
});

test("an unverified completion is published as incomplete with the final usage and a report", async (t) => {
  const { plane, task, paths, url } = await fixture(t);
  task.status = "running";
  task.goals[0]!.passes = true;
  plane.store.save(task);
  writeFileSync(join(task.dataDir, "worker-status.json"), JSON.stringify({ status: "completed", usage: { tokens: 23 } }));
  await plane.watchdog.tick();
  const updated = plane.store.get(task.id)!;
  assert.equal(updated.status, "incomplete");
  assert.equal(updated.goals[0]!.passes, false);
  assert.equal(updated.usage.tokens, 23);
  const report = readFileSync(paths.reportPath, "utf8");
  assert.match(report, /Status: incomplete/);
  assert.match(report, /超额 3/);
  assert.match(report, /人工覆盖记录　未知/);
  assert.equal(await (await fetch(url + "/report")).text(), report);
});

for (const tokens of [20, 21]) {
  test(`a verified outcome accounts for the exact counter boundary (${tokens}/20)`, async (t) => {
    const { plane, task, paths, history } = await fixture(t);
    writeEvidenceFile(paths.evidenceDir, "receipt.txt", "收件已归档");
    assert.ok(history.assertGoal(task.id, "receipt", ["receipt.txt"]).ok);
    task.status = "running";
    plane.store.save(task);
    writeFileSync(join(task.dataDir, "worker-status.json"), JSON.stringify({ status: "completed", usage: { tokens } }));
    await plane.watchdog.tick();
    const expected = tokens === 20 ? "completed" : "budget_exhausted";
    assert.equal(plane.store.get(task.id)!.status, expected);
    assert.ok(readFileSync(paths.reportPath, "utf8").includes("Status: " + expected));
    assert.match(readFileSync(paths.reportPath, "utf8"), /仅文件判据/);
  });
}

test("a legacy task with contradictory states and no report can be reviewed without modifying the archive", async (t) => {
  const { plane, task, paths, url } = await fixture(t);
  const old = new DatabaseSync(paths.historyDb);
  old.exec("DROP TABLE coverage_reviews; DROP TABLE fact_reviews; DROP TABLE goal_checks; DROP TABLE goal_proofs;");
  old.close();
  task.goals[0]!.passes = true;
  plane.store.finishTask(task, "completed", null);
  writeEvidenceFile(paths.evidenceDir, "unlinked/progress.md", "交接时留下的记录");
  for (const endpoint of ["/report", "/delivery"]) {
    const response = await fetch(url + endpoint);
    assert.equal(response.status, 200);
    const text = endpoint === "/report" ? await response.text() : (await response.json() as { summary: string }).summary;
    for (const value of ["归档报告　未留存", "与控制面记录不一致", "终态冲突", "覆盖　未知", "unlinked/progress.md"]) {
      assert.ok(text.includes(value), value);
    }
  }
  assert.equal(existsSync(paths.reportPath), false);
  assert.equal(plane.store.get(task.id)!.goals[0]!.passes, true);
  const check = new DatabaseSync(paths.historyDb, { readOnly: true });
  assert.equal(check.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'coverage_reviews'").get()?.n, 0);
  check.close();
});

test("operator coverage survives interruption with versioned proof and does not grant a goal assertion", async (t) => {
  const { plane, task, paths, history, url } = await fixture(t);
  const post = (data: object) => fetch(url + "/coverage", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(data) });
  const entry = { goalId: "receipt", status: "tested", reviewer: "复核员", reason: "核对签收材料" };
  assert.equal((await post(entry)).status, 400);
  assert.equal((await post({ ...entry, evidencePath: "missing.txt" })).status, 400);
  assert.equal((await post({ ...entry, goalId: "other", status: "untested" })).status, 400);
  assert.equal((await post({ ...entry, status: "blocked", reason: "尚未取得材料" })).status, 201);
  writeEvidenceFile(paths.evidenceDir, "receipt.txt", "原始凭条");
  const material = { ...entry, evidencePath: "receipt.txt" };
  const response = await post(material);
  assert.equal(response.status, 201);
  const { coverage } = await response.json() as { coverage: { sha256: string; id: string } };
  assert.equal((await (await post(material)).json() as { coverage: { id: string } }).coverage.id, coverage.id);
  writeEvidenceFile(paths.evidenceDir, "receipt.txt", "已覆盖的工作副本");
  await plane.runner.stop(task.id);
  assert.equal(history.allGoalsPass(task.id), false);
  assert.equal(history.listCoverage(task.id).length, 2);
  assert.equal(await (await fetch(url + "/report-evidence/" + coverage.sha256)).text(), "原始凭条");
  assert.equal(history.readProofVersion("unrelated", coverage.sha256), undefined);
  const report = readFileSync(paths.reportPath, "utf8");
  assert.match(report, /Status: stopped/);
  assert.match(report, /历次覆盖　受阻/);
  assert.match(report, /当前覆盖　已测/);
  assert.equal(readFileSync(join(task.dataDir, "report-evidence", coverage.sha256), "utf8"), "原始凭条");
});

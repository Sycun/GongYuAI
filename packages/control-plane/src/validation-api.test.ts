/**
 * P15-C1 API 验收：独立确认从正常 HTTP 入口提交，自证被拒；
 * P15-C0 观察员投影可读。不直接改数据库。
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { CreateTaskRequestSchema } from "@gongyuai/contracts";
import { openHistory } from "@gongyuai/history";
import { bootControlPlane, taskPaths } from "./index.js";

async function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), "gy-validation-api-"));
  const plane = await bootControlPlane({
    dataRoot: root,
    host: "127.0.0.1",
    port: 0,
    runtime: "local",
    watchdogMs: 60_000,
  });
  t.after(async () => {
    await plane.close();
    rmSync(root, { recursive: true, force: true });
  });
  const task = plane.store.createTask(
    CreateTaskRequestSchema.parse({
      name: "P15 独立确认",
      auth: { targets: ["p15.lab.test"], authorizationNote: "P15 本地夹具，仅工程验收" },
      goals: [{ id: "g1", title: "覆盖", description: "P15", evidencePatterns: ["*"] }],
      mock: true,
    }),
  );
  const paths = taskPaths(task.dataDir);
  const history = openHistory({ dbPath: paths.historyDb, evidenceDir: paths.evidenceDir });
  history.seedGoals(task.id, task.goals);
  t.after(() => history.close());
  const { finding } = history.recordFinding({
    taskId: task.id,
    title: "IDOR",
    asset: "p15.lab.test",
    vulnClass: "AUTHZ-BOLA",
    severity: "high",
    endpoint: "https://p15.lab.test/api/users/1",
  });
  writeFileSync(join(paths.evidenceDir, "proof.txt"), "user A reads user B\n");
  history.verifyFinding(task.id, finding.id, {
    evidencePaths: ["proof.txt"],
    repro: "curl -H 'Cookie: A' .../users/1",
    verifiedBy: "worker-a",
  });
  return { plane, task, finding, base: plane.url + "/tasks/" + task.id };
}

async function call(
  method: string,
  url: string,
  body?: unknown,
): Promise<{ status: number; text: string; json: any }> {
  const res = await fetch(url, {
    method,
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* non-json */
  }
  return { status: res.status, text, json };
}

test("validate API: self-validation refused, independent confirmed, audit visible", async (t) => {
  const { task, finding, base } = await fixture(t);

  const self = await call("POST", `${base}/findings/${finding.id}/validate`, {
    verdict: "confirmed",
    method: "replay",
    evidencePaths: ["proof.txt"],
    validator: "worker-a",
  });
  assert.equal(self.status, 409);
  assert.match(self.text, /self-validation refused/);

  const ok = await call("POST", `${base}/findings/${finding.id}/validate`, {
    verdict: "confirmed",
    method: "control-compare",
    evidencePaths: ["proof.txt"],
    note: "A 用户读到 B 的数据，B 用户自身请求返回 200",
    validator: "worker-b",
  });
  assert.equal(ok.status, 201, ok.text);
  assert.equal(ok.json.validation.verdict, "confirmed");
  assert.equal(ok.json.validation.independent, true);

  const validations = await call("GET", `${base}/validations?findingId=${finding.id}`);
  assert.equal(validations.status, 200);
  assert.equal(validations.json.validations.length, 1);

  const p14 = await call("GET", `${base}/p14`);
  assert.equal(p14.status, 200);
  assert.equal(p14.json.validations.length, 1);

  const audit = await call("GET", `${base}/audit`);
  assert.equal(audit.status, 200);
  assert.equal(audit.json.scorecard.findings.confirmed, 1);
  assert.equal(audit.json.scorecard.findings.confirmationRate, 1);
  assert.ok(Array.isArray(audit.json.observations));
});

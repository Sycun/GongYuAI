/**
 * P14 API 验收：`GET /tasks/:id/p14` 与跨任务 `GET /tasks/:id/asset-history`。
 * 走 HTTP 正常入口，不直接改数据库。
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { CreateTaskRequestSchema } from "@gongyuai/contracts";
import { openHistory } from "@gongyuai/history";
import { bootControlPlane, taskPaths } from "./index.js";

async function fixture(t: TestContext, name: string) {
  const root = mkdtempSync(join(tmpdir(), "gy-p14-api-"));
  const plane = await bootControlPlane({ dataRoot: root, host: "127.0.0.1", port: 0, runtime: "local", watchdogMs: 60_000 });
  t.after(async () => { await plane.close(); rmSync(root, { recursive: true, force: true }); });
  const task = plane.store.createTask(CreateTaskRequestSchema.parse({
    name,
    auth: { targets: ["p14.lab.test"], authorizationNote: "P14 本地夹具，仅工程验收" },
    goals: [{ id: "g1", title: "覆盖", description: "P14", evidencePatterns: ["*"] }],
    mock: true,
  }));
  const paths = taskPaths(task.dataDir);
  const history = openHistory({ dbPath: paths.historyDb, evidenceDir: paths.evidenceDir });
  history.seedGoals(task.id, task.goals);
  t.after(() => history.close());
  return { plane, task, paths, history, base: plane.url + "/tasks/" + task.id };
}

async function getJson(url: string): Promise<{ status: number; body: any }> {
  const res = await fetch(url);
  return { status: res.status, body: await res.json() };
}

test("GET /tasks/:id/p14 exposes transactions/plan/credentials/retests with full secretRef", async (t) => {
  const { task, paths, history, base } = await fixture(t, "P14 投影");
  // transaction
  mkdirSync(join(paths.evidenceDir, "http"), { recursive: true });
  const req = "GET /login HTTP/1.1\nhost: p14.lab.test\n\n";
  const res = "HTTP/1.1 200\n\nok";
  const reqSha = createHash("sha256").update(req).digest("hex");
  const resSha = createHash("sha256").update(res).digest("hex");
  writeFileSync(join(paths.evidenceDir, "http", `${reqSha}.req.txt`), req);
  writeFileSync(join(paths.evidenceDir, "http", `${resSha}.res.txt`), res);
  history.recordHttpTransaction({
    taskId: task.id, intentId: null, method: "GET", url: "http://p14.lab.test/login",
    host: "p14.lab.test", path: "/login", status: 200, requestSha256: reqSha,
    responseSha256: resSha, requestPath: `http/${reqSha}.req.txt`,
    responsePath: `http/${resSha}.res.txt`, requestBytes: req.length, responseBytes: res.length,
    responseHead: "ok", truncated: false, redirects: [], startedAt: new Date().toISOString(),
    durationMs: 5, note: "",
  });
  // plan
  const seed = history.recordAsset({ taskId: task.id, address: "p14.lab.test", auth: { targets: ["p14.lab.test"], outOfScope: [] } }).fact;
  history.setPlan(task.id, [{ title: "step 1", needsFactIds: [seed.id] }]);
  // credential (pointer only)
  history.recordCredential({
    taskId: task.id, kind: "password", asset: "p14.lab.test", username: "admin",
    secretRef: "credentials/admin.txt", verified: true,
  });
  // retest needs a verified finding + evidence
  const { finding } = history.recordFinding({
    taskId: task.id, title: "SQLi", asset: "p14.lab.test", vulnClass: "CWE-89", severity: "high",
  });
  writeFileSync(join(paths.evidenceDir, "proof.txt"), "proof");
  history.verifyFinding(task.id, finding.id, { evidencePaths: ["proof.txt"], repro: "replay" });
  writeFileSync(join(paths.evidenceDir, "fixed.txt"), "fixed");
  history.recordFindingRetest(task.id, finding.id, {
    verdict: "fixed", evidencePaths: ["fixed.txt"], repro: "same payload", reviewer: "qa",
  });
  // oast token + hit
  history.recordOastToken({
    token: "abcdef1234567890", taskId: task.id, kind: "http",
    callback: "http://127.0.0.1/t/abcdef1234567890", expiresAt: new Date(Date.now() + 3600_000).toISOString(),
  });
  history.recordOastHit(task.id, { token: "abcdef1234567890", sourceIp: "10.0.0.5" });

  const { status, body } = await getJson(`${base}/p14`);
  assert.equal(status, 200);
  assert.equal(body.transactions.length, 1);
  assert.equal(body.plan.length, 1);
  assert.equal(body.credentials.length, 1);
  assert.equal(body.credentials[0].secretRef, "credentials/admin.txt");
  assert.equal(body.retests.length, 1);
  assert.equal(body.retests[0].verdict, "fixed");
  assert.equal(body.oastTokens.length, 1);
  assert.equal(body.oastHits.length, 1);
});

test("GET /tasks/:id/asset-history returns read-only cross-task leads", async (t) => {
  const first = await fixture(t, "P14 当前任务");
  const second = await fixture(t, "P14 历史任务");
  // Both fixtures share the same control plane? No — each fixture boots its own
  // plane, so build the historical hit in the FIRST plane's second task.
  const other = first.plane.store.createTask(CreateTaskRequestSchema.parse({
    name: "历史任务",
    auth: { targets: ["p14.lab.test"], authorizationNote: "P14 历史接触夹具" },
    goals: [{ id: "g1", title: "覆盖", description: "P14", evidencePatterns: ["*"] }],
    mock: true,
  }));
  const otherPaths = taskPaths(other.dataDir);
  const otherHistory = openHistory({ dbPath: otherPaths.historyDb, evidenceDir: otherPaths.evidenceDir });
  try {
    otherHistory.seedGoals(other.id, other.goals);
    otherHistory.recordAsset({
      taskId: other.id, address: "https://p14.lab.test/admin", auth: { targets: ["p14.lab.test"], outOfScope: [] },
      assetType: "endpoint",
    });
    const { finding } = otherHistory.recordFinding({
      taskId: other.id, title: "weak password", asset: "p14.lab.test", vulnClass: "CWE-521", severity: "medium",
    });
    writeFileSync(join(otherPaths.evidenceDir, "proof.txt"), "proof");
    otherHistory.verifyFinding(other.id, finding.id, { evidencePaths: ["proof.txt"], repro: "login" });
  } finally {
    otherHistory.close();
  }
  const { status, body } = await getJson(`${first.base}/asset-history?address=p14.lab.test`);
  assert.equal(status, 200);
  assert.equal(body.host, "p14.lab.test");
  assert.ok(body.hits.length >= 1);
  assert.ok(body.hits.some((hit: any) => hit.findings.some((f: any) => f.status === "verified")));
  assert.match(body.note, /历史接触≠本次授权/);
  void second;
});

test("GET /tasks/:id/evidence/file supports opt-in workspace fallback for credential secretRef preview", async (t) => {
  const { paths, base } = await fixture(t, "P14 secretRef 文件读取");
  mkdirSync(join(paths.evidenceDir, "c07"), { recursive: true });
  writeFileSync(join(paths.evidenceDir, "c07", "telnet.txt"), "root:root123\n");

  mkdirSync(join(paths.workspaceDir, "evidence", "d06"), { recursive: true });
  writeFileSync(join(paths.workspaceDir, "evidence", "d06", "repro-chain.log"), "AWS_SECRET=xyz\n");

  const evRes = await fetch(`${base}/evidence/file?path=${encodeURIComponent("c07/telnet.txt")}`);
  assert.equal(evRes.status, 200);
  assert.equal(evRes.headers.get("x-gy-evidence-source"), "evidence");
  assert.equal(await evRes.text(), "root:root123\n");

  const strictMiss = await fetch(`${base}/evidence/file?path=${encodeURIComponent("evidence/d06/repro-chain.log")}`);
  assert.equal(strictMiss.status, 404);

  const wsFallback = await fetch(
    `${base}/evidence/file?path=${encodeURIComponent("evidence/d06/repro-chain.log")}&fallbackWorkspace=1`,
  );
  assert.equal(wsFallback.status, 200);
  assert.equal(wsFallback.headers.get("x-gy-evidence-source"), "workspace");
  assert.equal(await wsFallback.text(), "AWS_SECRET=xyz\n");

  const traversal = await fetch(
    `${base}/evidence/file?path=${encodeURIComponent("../manifest.json")}&fallbackWorkspace=1`,
  );
  assert.equal(traversal.status, 404);
});

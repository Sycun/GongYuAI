import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { CreateTaskRequestSchema } from "@gongyuai/contracts";
import { openHistory, writeEvidenceFile } from "@gongyuai/history";
import { bootControlPlane, taskPaths } from "./index.js";
import {
  buildValidatorPacket,
  gradeDarkMoon,
  resetAutoValidationState,
  scheduleAutoValidationsForTask,
} from "./validate-runner.js";

const SECRET = "EXPLORER_TRANSCRIPT_9f3a_do_not_leak";

test("Dark-Moon grading refuses to promote an echo or a SQL error into exploited", () => {
  const echo = gradeDarkMoon({
    requestText: "GET /echo?q=alert(1)",
    responseText: "alert(1)",
    status: 200,
    claimed: "exploited",
  });
  assert.equal(echo.qualification, "unconfirmed");
  const sql = gradeDarkMoon({
    requestText: "GET /sql?q='",
    responseText: "you have an error in your sql syntax near 'x'",
    status: 500,
    claimed: "exploited",
  });
  assert.equal(sql.qualification, "confirmed");
  const harm = gradeDarkMoon({
    requestText: "GET /hold",
    responseText: "root:x:0:0:root",
    status: 200,
  });
  assert.equal(harm.qualification, "exploited");
  const generic = gradeDarkMoon({
    requestText: "GET /err",
    responseText: "Internal Server Error",
    status: 500,
    claimed: "exploited",
  });
  assert.equal(generic.qualification, "unconfirmed");
});

test("validate-run is an isolated replay and does not carry explorer messages", { timeout: 20_000 }, async (t) => {
  const root = mkdtempSync(join(tmpdir(), "gy-validate-run-"));
  const plane = await bootControlPlane({
    dataRoot: root,
    host: "127.0.0.1",
    port: 0,
    runtime: "local",
    watchdogMs: 60_000,
  });
  let releaseHold = () => {};
  const held = new Promise<void>((resolve) => {
    releaseHold = resolve;
  });
  let sawHold = () => {};
  const holdArrived = new Promise<void>((resolve) => {
    sawHold = resolve;
  });
  const origin = createServer((req, res) => {
    const url = req.url ?? "/";
    if (url.startsWith("/hold")) {
      sawHold();
      void held.then(() => {
        res.writeHead(200, { "content-type": "text/plain" });
        res.end("root:x:0:0:root");
      });
      return;
    }
    if (url.startsWith("/echo")) {
      res.end("alert(1)");
      return;
    }
    res.end("you have an error in your sql syntax near 'x'");
  });
  await new Promise<void>((resolve) => origin.listen(0, "127.0.0.1", () => resolve()));
  const address = origin.address();
  if (!address || typeof address === "string") throw new Error("no port");
  const baseUrl = `http://127.0.0.1:${address.port}`;
  t.after(async () => {
    releaseHold();
    origin.close();
    await plane.close();
    rmSync(root, { recursive: true, force: true });
  });

  const task = plane.store.createTask(CreateTaskRequestSchema.parse({
    name: "独立复核",
    auth: { targets: ["127.0.0.1"], authorizationNote: "本地夹具，仅工程验收" },
    goals: [{ id: "g1", title: "复核", description: "复核", evidencePatterns: ["*"] }],
    mock: true,
  }));
  const paths = taskPaths(task.dataDir);
  mkdirSync(paths.workspaceDir, { recursive: true });
  writeFileSync(join(paths.workspaceDir, "relay.json"), JSON.stringify({ messages: [{ content: SECRET }] }));
  writeFileSync(join(task.dataDir, "durable.sqlite"), SECRET);
  const history = openHistory({ dbPath: paths.historyDb, evidenceDir: paths.evidenceDir });
  history.seedGoals(task.id, task.goals);
  writeFileSync(join(paths.evidenceDir, "proof.txt"), "sealed\n");
  const make = (title: string, endpoint: string) => {
    const { finding } = history.recordFinding({
      taskId: task.id,
      title,
      asset: "127.0.0.1",
      vulnClass: "CWE-200",
      severity: "high",
      endpoint,
    });
    history.verifyFinding(task.id, finding.id, {
      evidencePaths: ["proof.txt"],
      repro: `GET ${endpoint}`,
      verifiedBy: "worker-explorer",
    });
    return finding.id;
  };
  const holdId = make("hold", `${baseUrl}/hold`);
  const echoId = make("echo", `${baseUrl}/echo?q=alert(1)`);
  const sqlId = make("sql", `${baseUrl}/sql`);
  history.close();

  const packet = buildValidatorPacket({
    taskId: task.id,
    targets: task.auth.targets,
    finding: {
      id: echoId,
      title: "echo",
      asset: "127.0.0.1",
      endpoint: `${baseUrl}/echo?q=alert(1)`,
      vulnClass: "CWE-200",
      repro: "GET",
      impact: "",
      messages: [{ role: "assistant", content: SECRET }],
    } as never,
  });
  assert.equal(JSON.stringify(packet).includes(SECRET), false);
  assert.equal("messages" in packet, false);
  assert.deepEqual(packet.isolatedFrom, ["explorer-messages", "compaction", "relay"]);

  const base = `${plane.url}/tasks/${task.id}`;
  const smuggled = await call("POST", `${base}/findings/${echoId}/validate-run`, {
    findingId: echoId,
    messages: [{ content: SECRET }],
  });
  assert.equal(smuggled.status, 400);

  const first = call("POST", `${base}/findings/${holdId}/validate-run`, { findingId: holdId });
  await holdArrived;
  const busy = await call("POST", `${base}/findings/${holdId}/validate-run`, { findingId: holdId });
  assert.equal(busy.status, 409, busy.text);
  assert.equal(busy.json.status, "running");
  releaseHold();
  const exploited = await first;
  assert.equal(exploited.status, 200, exploited.text);
  assert.equal(exploited.json.status, "succeeded");
  assert.equal(exploited.json.qualification, "exploited");
  assert.equal(exploited.json.independent, true);
  assert.equal(JSON.stringify(exploited.json.packet).includes(SECRET), false);

  const echo = await call("POST", `${base}/findings/${echoId}/validate-run`, { findingId: echoId });
  assert.equal(echo.status, 200, echo.text);
  assert.equal(echo.json.qualification, "unconfirmed");
  const echoAgain = await call("POST", `${base}/findings/${echoId}/validate-run`, { findingId: echoId });
  assert.equal(echoAgain.json.jobId, echo.json.jobId);
  assert.equal(echoAgain.json.validationId, echo.json.validationId);

  const sql = await call("POST", `${base}/findings/${sqlId}/validate-run`, { findingId: sqlId });
  assert.equal(sql.status, 200, sql.text);
  assert.equal(sql.json.qualification, "confirmed");

  const db = new DatabaseSync(paths.historyDb, { readOnly: true });
  const grades = db.prepare(
    "SELECT id, qualification, traffic_ids_json FROM findings WHERE task_id = ?",
  ).all(task.id) as Array<{ id: string; qualification: string; traffic_ids_json: string }>;
  db.close();
  const byId = new Map(grades.map((row) => [row.id, row]));
  assert.equal(byId.get(holdId)?.qualification, "exploited");
  assert.equal(byId.get(echoId)?.qualification, "unconfirmed");
  assert.equal(byId.get(sqlId)?.qualification, "confirmed");
  assert.ok(JSON.parse(byId.get(holdId)?.traffic_ids_json ?? "[]").length >= 1);

  const opened = openHistory({ dbPath: paths.historyDb, evidenceDir: paths.evidenceDir, readOnly: true });
  try {
    const rows = opened.listFindingValidations(task.id);
    assert.ok(rows.length >= 3);
    assert.ok(rows.every((row) => row.independent && row.validator.startsWith("independent-validator:")));
    assert.equal(rows.some((row) => row.validator === "worker-explorer"), false);
  } finally {
    opened.close();
  }

  const trafficDb = new DatabaseSync(join(task.dataDir, "traffic", "index.sqlite"), { readOnly: true });
  const packets = trafficDb.prepare("SELECT packet_json FROM validate_jobs").all() as Array<{ packet_json: string }>;
  trafficDb.close();
  assert.ok(packets.length >= 1);
  assert.ok(packets.every((row) => !row.packet_json.includes(SECRET)));

  const listed = await call("GET", `${base}/traffic?host=127.0.0.1`);
  assert.equal(listed.status, 200, listed.text);
  assert.ok(listed.json.traffic.length >= 1);
  const trafficId = listed.json.traffic[0].id as string;
  const detail = await call("GET", `${base}/traffic/${trafficId}`);
  assert.equal(detail.json.evidenceRef, `http:${trafficId}`);
  const blob = await call("GET", `${base}/traffic/${trafficId}/blob?side=res&offset=0&maxBytes=32`);
  assert.equal(blob.status, 200, blob.text);
  assert.equal(blob.json.offset, 0);
  const raw = Buffer.from(blob.json.bytes, "base64");
  assert.equal(raw.toString("utf8"), blob.json.body);
  const tooBig = await call("GET", `${base}/traffic/${trafficId}/blob?side=res&maxBytes=65537`);
  assert.equal(tooBig.status, 400);
});

test("scheduleAutoValidationsForTask enqueues verified findings asynchronously and deduplicates", async (t) => {
  resetAutoValidationState();
  const root = mkdtempSync(join(tmpdir(), "gy-auto-val-"));
  const evidenceDir = join(root, "evidence");
  const historyDb = join(root, "history.sqlite");
  const server = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("root:x:0:0:root:/root:/bin/bash\n");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("no port");
  const url = `http://127.0.0.1:${addr.port}/exec`;

  t.after(async () => {
    resetAutoValidationState();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(root, { recursive: true, force: true });
  });

  const taskId = "44444444-4444-4444-8444-444444444444";
  const history = openHistory({ dbPath: historyDb, evidenceDir });
  const { finding } = history.recordFinding({
    taskId,
    title: "Command Execution",
    asset: `127.0.0.1:${addr.port}`,
    vulnClass: "CWE-78",
    severity: "critical",
    endpoint: url,
    pocCurl: `curl -sS '${url}'`,
  });
  const ev = writeEvidenceFile(evidenceDir, "cmd.txt", "uid=0(root)");
  history.verifyFinding(taskId, finding.id, {
    evidencePaths: [ev],
    repro: `curl -sS '${url}'`,
    verifiedBy: "w0",
  });
  history.close();

  const firstQueued = scheduleAutoValidationsForTask({
    taskId,
    taskDir: root,
    historyDb,
    evidenceDir,
    targets: [`127.0.0.1:${addr.port}`],
  });
  assert.deepEqual(firstQueued, [finding.id]);

  // Second call immediately deduplicates.
  const secondQueued = scheduleAutoValidationsForTask({
    taskId,
    taskDir: root,
    historyDb,
    evidenceDir,
    targets: [`127.0.0.1:${addr.port}`],
  });
  assert.deepEqual(secondQueued, []);

  // Poll until async validation completes.
  let validations: ReturnType<ReturnType<typeof openHistory>["listFindingValidations"]> = [];
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 100));
    const h = openHistory({ dbPath: historyDb, evidenceDir });
    validations = h.listFindingValidations(taskId, finding.id);
    h.close();
    if (validations.length > 0) break;
  }
  assert.ok(validations.length >= 1, "expected independent validation to complete asynchronously");
  assert.equal(validations[0]!.independent, true);
  assert.equal(validations[0]!.verdict, "confirmed");
});

async function call(method: string, url: string, body?: unknown): Promise<{ status: number; text: string; json: any }> {
  const res = await fetch(url, {
    method,
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch { /* text */ }
  return { status: res.status, text, json };
}

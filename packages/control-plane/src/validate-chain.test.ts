import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { openTrafficDb } from "@gongyuai/exec";
import { openHistory, writeEvidenceFile } from "@gongyuai/history";
import {
  findActiveTunnelRoute,
  runIndependentValidation,
} from "./validate-runner.js";

function insertExchange(
  taskDir: string,
  row: {
    id: string;
    taskId: string;
    method: string;
    url: string;
    path: string;
    status: number;
    startedAt: string;
    reqHeaders: Record<string, string | string[]>;
  },
): void {
  const host = new URL(row.url).host;
  openTrafficDb(taskDir)
    .prepare(
      `INSERT INTO exchanges
        (id, task_id, intent_id, worker_id, method, url, host, path, status, duration_ms, started_at,
         req_headers_json, res_headers_json, req_sha256, req_size, req_type, res_sha256, res_size, res_type,
         req_preview, res_preview, finding_ids_json)
       VALUES (?, ?, NULL, 'worker-explorer', ?, ?, ?, ?, ?, 5, ?, ?, '{}',
               NULL, NULL, NULL, NULL, NULL, NULL, '', '', '[]')`,
    )
    .run(
      row.id,
      row.taskId,
      row.method,
      row.url,
      host,
      row.path,
      row.status,
      row.startedAt,
      JSON.stringify(row.reqHeaders),
    );
}

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no port");
  return address.port;
}

test("validate-run replays a two-step Set-Cookie chain and grades the final state", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "gy-chain-validate-"));
  const evidenceDir = join(root, "evidence");
  mkdirSync(evidenceDir, { recursive: true });
  const historyDb = join(root, "history.sqlite");
  const taskId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  let cookieSeen = "";
  const origin = createServer((req, res) => {
    const url = req.url ?? "/";
    if (url.startsWith("/login")) {
      res.writeHead(200, { "set-cookie": "sid=s3cr3t-session; Path=/; HttpOnly", "content-type": "text/plain" });
      res.end("login ok");
      return;
    }
    if (url.startsWith("/admin")) {
      cookieSeen = req.headers.cookie ?? "";
      if (cookieSeen.includes("sid=s3cr3t-session")) {
        res.writeHead(200, { "content-type": "text/plain" });
        res.end("root:x:0:0:root:/root:/bin/bash\n");
      } else {
        res.writeHead(403, { "content-type": "text/plain" });
        res.end("denied");
      }
      return;
    }
    res.writeHead(404);
    res.end();
  });
  const port = await listen(origin);
  const base = `http://127.0.0.1:${port}`;
  t.after(async () => {
    await new Promise<void>((resolve) => origin.close(() => resolve()));
    rmSync(root, { recursive: true, force: true });
  });

  const loginId = randomUUID();
  const adminId = randomUUID();
  insertExchange(root, {
    id: loginId,
    taskId,
    method: "GET",
    url: `${base}/login`,
    path: "/login",
    status: 200,
    startedAt: new Date(Date.now() - 2_000).toISOString(),
    reqHeaders: { host: `127.0.0.1:${port}`, accept: "*/*" },
  });
  insertExchange(root, {
    id: adminId,
    taskId,
    method: "GET",
    url: `${base}/admin`,
    path: "/admin",
    status: 403,
    startedAt: new Date(Date.now() - 1_000).toISOString(),
    reqHeaders: { host: `127.0.0.1:${port}`, accept: "*/*" },
  });

  const history = openHistory({ dbPath: historyDb, evidenceDir });
  const { finding } = history.recordFinding({
    taskId,
    title: "两步会话越权读取",
    asset: "127.0.0.1",
    vulnClass: "CWE-639",
    severity: "high",
    endpoint: `${base}/admin`,
  });
  const evidence = writeEvidenceFile(evidenceDir, "chain-proof.txt", "login -> admin\n");
  history.verifyFinding(taskId, finding.id, {
    evidencePaths: [evidence],
    repro: `GET ${base}/login ; GET ${base}/admin`,
    verifiedBy: "worker-explorer",
  });
  history.linkFindingTraffic(taskId, finding.id, [loginId, adminId]);
  history.close();

  const result = await runIndependentValidation({
    taskId,
    taskDir: root,
    historyDb,
    evidenceDir,
    targets: ["127.0.0.1"],
    findingId: finding.id,
  });
  assert.equal(result.httpStatus, 200);
  assert.equal(result.body.qualification, "exploited", JSON.stringify(result.body));
  assert.ok(cookieSeen.includes("sid=s3cr3t-session"), "第二步必须自动携带第一步的 Set-Cookie");

  const reopened = openHistory({ dbPath: historyDb, evidenceDir });
  try {
    const validations = reopened.listFindingValidations(taskId, finding.id);
    assert.equal(validations.length, 1);
    assert.equal(validations[0]!.verdict, "confirmed");
    assert.match(validations[0]!.note, /chain: 2\/2 steps/);
  } finally {
    reopened.close();
  }
});

test("validate-run routes a matching RFC1918 target through a live local tunnel", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "gy-tunnel-validate-"));
  const evidenceDir = join(root, "evidence");
  mkdirSync(evidenceDir, { recursive: true });
  const historyDb = join(root, "history.sqlite");
  const taskId = "bbbbbbbb-cccc-4bbb-8bbb-bbbbbbbbbbbc";
  let seenHost = "";
  const origin = createServer((req, res) => {
    seenHost = req.headers.host ?? "";
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("root:x:0:0:root:/root:/bin/bash\n");
  });
  const port = await listen(origin);
  t.after(async () => {
    await new Promise<void>((resolve) => origin.close(() => resolve()));
    rmSync(root, { recursive: true, force: true });
  });

  const targetHost = "10.20.30.40";
  const endpoint = `http://${targetHost}:${port}/secret`;
  const tunnelDir = join(root, "exec", "tunnels", "tn-validate");
  mkdirSync(tunnelDir, { recursive: true });

  assert.equal(
    findActiveTunnelRoute(root, new URL(endpoint)),
    null,
    "没有 meta 时不得臆造隧道路由",
  );
  writeFileSync(
    join(tunnelDir, "meta.json"),
    JSON.stringify(
      {
        id: "tn-validate",
        kind: "socat",
        targetHost,
        targetPort: port,
        localPort: port,
        pid: process.pid,
        status: "running",
        command: `socat TCP-LISTEN:${port},bind=127.0.0.1,reuseaddr,fork TCP:${targetHost}:${port}`,
        logPath: join(tunnelDir, "socat.log"),
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
      null,
      2,
    ),
  );
  const route = findActiveTunnelRoute(root, new URL(endpoint));
  assert.equal(route?.id, "tn-validate");

  // A closed tunnel or a dead pid must never be used.
  writeFileSync(
    join(tunnelDir, "meta.json"),
    JSON.stringify(
      {
        id: "tn-validate",
        kind: "socat",
        targetHost,
        targetPort: port,
        localPort: port,
        pid: 2_000_000_000,
        status: "running",
        command: "socat",
        logPath: join(tunnelDir, "socat.log"),
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
      null,
      2,
    ),
  );
  assert.equal(findActiveTunnelRoute(root, new URL(endpoint)), null, "dead pid 不得被路由");
  // Restore a live tunnel for the validation itself.
  writeFileSync(
    join(tunnelDir, "meta.json"),
    JSON.stringify(
      {
        id: "tn-validate",
        kind: "ssh-local",
        targetHost,
        targetPort: port,
        localPort: port,
        pid: process.pid,
        status: "running",
        command: "ssh-local",
        logPath: join(tunnelDir, "ssh-local.log"),
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
      null,
      2,
    ),
  );

  const history = openHistory({ dbPath: historyDb, evidenceDir });
  const { finding } = history.recordFinding({
    taskId,
    title: "内网纵深命令执行",
    asset: `${targetHost}:${port}`,
    vulnClass: "CWE-78",
    severity: "critical",
    endpoint,
  });
  const evidence = writeEvidenceFile(evidenceDir, "tunnel-proof.txt", "tunnel -> intranet\n");
  history.verifyFinding(taskId, finding.id, {
    evidencePaths: [evidence],
    repro: `GET ${endpoint}`,
    verifiedBy: "worker-explorer",
  });
  history.close();

  const result = await runIndependentValidation({
    taskId,
    taskDir: root,
    historyDb,
    evidenceDir,
    targets: [targetHost],
    findingId: finding.id,
  });
  assert.equal(result.httpStatus, 200);
  assert.equal(result.body.qualification, "exploited", JSON.stringify(result.body));
  assert.equal(seenHost, `${targetHost}:${port}`, "隧道重放必须保留原始 Host 头");

  const reopened = openHistory({ dbPath: historyDb, evidenceDir });
  try {
    const validations = reopened.listFindingValidations(taskId, finding.id);
    assert.equal(validations.length, 1);
    assert.match(validations[0]!.note, /tunnel: tn-validate → 127\.0\.0\.1:/);
  } finally {
    reopened.close();
  }
});
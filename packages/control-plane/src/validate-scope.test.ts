import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { openHistory, writeEvidenceFile } from "@gongyuai/history";
import {
  buildReplayRequest,
  buildValidatorPacket,
  loadEffectiveValidatorAuth,
  parsePocCurl,
  runIndependentValidation,
  validatorHostAllowed,
} from "./validate-runner.js";

test("validator scope accepts CIDR, wildcard, admitted targets, and pivot sidecar", () => {
  const root = mkdtempSync(join(tmpdir(), "gy-val-scope-"));
  try {
    writeFileSync(join(root, "admitted-targets.json"), JSON.stringify(["extra.lab.test"]));
    writeFileSync(join(root, "admitted-pivot.json"), JSON.stringify({ mode: "foothold-private" }));
    const auth = loadEffectiveValidatorAuth(root, {
      targets: ["10.0.0.0/24", "*.lab.test"],
      outOfScope: ["secret.lab.test"],
    });
    assert.ok(auth.targets.includes("extra.lab.test"));
    assert.equal(auth.pivotPolicy?.mode, "foothold-private");
    assert.equal(validatorHostAllowed(new URL("http://10.0.0.9/x"), auth), true);
    assert.equal(validatorHostAllowed(new URL("http://a.lab.test/x"), auth), true);
    assert.equal(validatorHostAllowed(new URL("http://extra.lab.test/x"), auth), true);
    assert.equal(validatorHostAllowed(new URL("http://secret.lab.test/x"), auth), false);
    assert.equal(validatorHostAllowed(new URL("http://172.19.0.4/x"), auth), true);
    assert.equal(validatorHostAllowed(new URL("http://203.0.113.9/x"), auth), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("pocCurl replay keeps method, headers, and body and skips redacted headers", async () => {
  const hits: Array<{ method?: string; body: string; type?: string | string[]; test?: string | string[]; auth?: string | string[]; cookie?: string | string[] }> = [];
  const origin = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      hits.push({
        method: req.method,
        body: Buffer.concat(chunks).toString("utf8"),
        type: req.headers["content-type"],
        test: req.headers["x-test"],
        auth: req.headers.authorization,
        cookie: req.headers.cookie,
      });
      res.end("you have an error in your sql syntax near 'x'");
    });
  });
  await new Promise<void>((resolve) => origin.listen(0, "127.0.0.1", () => resolve()));
  const address = origin.address();
  if (!address || typeof address === "string") throw new Error("no port");
  const root = mkdtempSync(join(tmpdir(), "gy-val-curl-"));
  const evidenceDir = join(root, "evidence");
  mkdirSync(evidenceDir, { recursive: true });
  writeEvidenceFile(evidenceDir, "proof.txt", "sealed\n");
  writeFileSync(join(root, "http-sessions.json"), JSON.stringify({
    default: { "127.0.0.1": { sid: "from-jar" } },
  }));
  const history = openHistory({ dbPath: join(root, "history.sqlite"), evidenceDir });
  try {
    const parsed = parsePocCurl(`curl -sS -X POST http://127.0.0.1/api -H 'Content-Type: application/json' -H 'Authorization: <redacted>' -d '{"id":1}'`);
    assert.equal(parsed.method, "POST");
    assert.equal(parsed.headers.Authorization, undefined);
    assert.equal(parsed.headers["Content-Type"], "application/json");
    assert.equal(parsed.body, '{"id":1}');

    const taskId = "33333333-3333-4333-8333-333333333333";
    const endpoint = `http://127.0.0.1:${address.port}/api`;
    const { finding } = history.recordFinding({
      taskId,
      title: "post replay",
      asset: "127.0.0.1",
      vulnClass: "CWE-89",
      severity: "high",
      endpoint,
    });
    history.verifyFinding(taskId, finding.id, {
      evidencePaths: ["proof.txt"],
      repro: "POST /api",
      pocCurl: `curl -sS -X POST '${endpoint}' -H 'Content-Type: application/json' -H 'Authorization: <redacted>' -H 'X-Test: kept' -d '{"id":1}'`,
      verifiedBy: "worker-explorer",
    });
    const stored = history.getFinding(taskId, finding.id)!;
    const packet = buildValidatorPacket({
      taskId,
      targets: ["127.0.0.1"],
      finding: stored,
    });
    const replay = buildReplayRequest(packet, root, new URL(endpoint));
    assert.equal(replay.method, "POST");
    assert.equal(replay.headers["Content-Length"], String(Buffer.byteLength('{"id":1}')));
    assert.match(replay.headers.Cookie ?? "", /sid=from-jar/);
    assert.equal(replay.headers.Authorization, undefined);

    const result = await runIndependentValidation({
      taskId,
      taskDir: root,
      historyDb: join(root, "history.sqlite"),
      evidenceDir,
      targets: ["127.0.0.1"],
      findingId: finding.id,
      force: true,
    });
    assert.equal(result.body.status, "succeeded");
    assert.equal(hits.length, 1);
    assert.equal(hits[0]?.method, "POST");
    assert.equal(hits[0]?.body, '{"id":1}');
    assert.equal(hits[0]?.type, "application/json");
    assert.equal(hits[0]?.test, "kept");
    assert.equal(hits[0]?.auth, undefined);
    assert.match(String(hits[0]?.cookie), /sid=from-jar/);

    // Multi-role jars (e.g. userA + admin without `default`) must NOT be blindly merged onto a replay.
    writeFileSync(join(root, "http-sessions.json"), JSON.stringify({
      userA: { "127.0.0.1": { sid: "low-priv" } },
      admin: { "127.0.0.1": { sid: "high-priv", admin: "1" } },
    }));
    const multiRoleReplay = buildReplayRequest(packet, root, new URL(endpoint));
    assert.equal(multiRoleReplay.headers.Cookie, undefined);
  } finally {
    history.close();
    origin.close();
    rmSync(root, { recursive: true, force: true });
  }
});

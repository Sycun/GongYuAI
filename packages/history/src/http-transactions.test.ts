import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { openHistory } from "./index.js";

const TASK_ID = "66666666-6666-4666-8666-666666666666";

function sha(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function setup(prefix: string) {
  const root = mkdtempSync(join(tmpdir(), prefix));
  const evidenceDir = join(root, "evidence");
  mkdirSync(join(evidenceDir, "http"), { recursive: true });
  const store = openHistory({ dbPath: join(root, "history.sqlite"), evidenceDir });
  return { root, store, evidenceDir };
}

function recordTx(store: ReturnType<typeof openHistory>, evidenceDir: string, resBody = "vulnerable") {
  const req = "GET /login HTTP/1.1\nhost: lab.example.com\n\n";
  const res = `HTTP/1.1 200\nauthorization: bypassed\n\n${resBody}`;
  const requestSha256 = sha(req);
  const responseSha256 = sha(res);
  writeFileSync(join(evidenceDir, "http", `${requestSha256}.req.txt`), req);
  writeFileSync(join(evidenceDir, "http", `${responseSha256}.res.txt`), res);
  return store.recordHttpTransaction({
    taskId: TASK_ID,
    intentId: null,
    method: "GET",
    url: "http://lab.example.com/login",
    host: "lab.example.com",
    path: "/login",
    status: 200,
    requestSha256,
    responseSha256,
    requestPath: `http/${requestSha256}.req.txt`,
    responsePath: `http/${responseSha256}.res.txt`,
    requestBytes: req.length,
    responseBytes: res.length,
    responseHead: resBody,
    truncated: false,
    redirects: [],
    startedAt: new Date().toISOString(),
    durationMs: 12,
    note: "",
  });
}

test("recordHttpTransaction is idempotent on method+url+hashes", () => {
  const { root, store, evidenceDir } = setup("gy-http-tx-idem-");
  try {
    const first = recordTx(store, evidenceDir);
    assert.equal(first.created, true);
    const again = recordTx(store, evidenceDir);
    assert.equal(again.created, false);
    assert.equal(again.transaction.id, first.transaction.id);
    assert.equal(store.listHttpTransactions(TASK_ID).length, 1);
    const kinds = store.listEvents(TASK_ID).map((e) => e.kind);
    assert.ok(kinds.includes("http_transaction_recorded"));
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("verifyFinding accepts http:<id> refs and seals the transaction hash", () => {
  const { root, store, evidenceDir } = setup("gy-http-tx-ref-");
  try {
    const { transaction } = recordTx(store, evidenceDir);
    const { finding } = store.recordFinding({
      taskId: TASK_ID,
      title: "Auth bypass on login",
      asset: "lab.example.com",
      vulnClass: "CWE-287",
      severity: "high",
      endpoint: "http://lab.example.com/login",
    });
    const verified = store.verifyFinding(TASK_ID, finding.id, {
      evidencePaths: [`http:${transaction.id}`],
      repro: "1) send the same request 2) observe the response header",
    });
    assert.equal(verified.status, "verified");
    assert.equal(verified.evidence.length, 1);
    assert.equal(verified.evidence[0]!.path, `http:${transaction.id}`);
    assert.equal(verified.evidence[0]!.sha256, transaction.responseSha256);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("verifyFinding rejects unknown or tampered refs", () => {
  const { root, store, evidenceDir } = setup("gy-http-tx-reject-");
  try {
    const { finding } = store.recordFinding({
      taskId: TASK_ID,
      title: "Ref injection attempt",
      asset: "lab.example.com",
      vulnClass: "CWE-20",
      severity: "low",
    });
    assert.throws(
      () =>
        store.verifyFinding(TASK_ID, finding.id, {
          evidencePaths: ["http:77777777-7777-4777-8777-777777777777"],
          repro: "n/a",
        }),
      /unknown http transaction ref/,
    );

    const { transaction } = recordTx(store, evidenceDir);
    writeFileSync(join(evidenceDir, transaction.responsePath), "tampered body");
    assert.throws(
      () =>
        store.verifyFinding(TASK_ID, finding.id, {
          evidencePaths: [`http:${transaction.id}`],
          repro: "n/a",
        }),
      /hash mismatch/,
    );
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

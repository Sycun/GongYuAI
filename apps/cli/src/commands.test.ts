import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { GlobalOpts } from "./args.js";
import { api, ensureServer, splitCsv, withServer } from "./client.js";
import { handleCoreCommand } from "./commands-core.js";
import { handleReviewCommand } from "./commands-review.js";

type RecordedRequest = {
  method: string;
  url: string;
  body: unknown;
};

async function withMockControlPlane(
  responder: (req: RecordedRequest) => { status?: number; body?: unknown; rawText?: string },
  fn: (opts: GlobalOpts, calls: RecordedRequest[], dir: string) => Promise<void>,
): Promise<void> {
  const calls: RecordedRequest[] = [];
  const dir = mkdtempSync(join(tmpdir(), "gy-cli-test-"));
  const srv = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      let parsed: unknown = undefined;
      if (raw.length > 0) {
        try {
          parsed = JSON.parse(raw);
        } catch {
          parsed = raw;
        }
      }
      const rec: RecordedRequest = {
        method: req.method ?? "GET",
        url: req.url ?? "/",
        body: parsed,
      };
      calls.push(rec);
      if (rec.method === "GET" && rec.url === "/health") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
        return;
      }
      const reply = responder(rec);
      const status = reply.status ?? 200;
      if (reply.rawText !== undefined) {
        res.writeHead(status, { "content-type": "text/plain" });
        res.end(reply.rawText);
      } else {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(reply.body ?? { ok: true }));
      }
    });
  });

  await new Promise<void>((resolve) => srv.listen(0, "127.0.0.1", () => resolve()));
  const addr = srv.address();
  assert.ok(addr && typeof addr !== "string");
  const opts: GlobalOpts = {
    host: "127.0.0.1",
    port: addr.port,
    baseUrl: `http://127.0.0.1:${addr.port}`,
    dataDir: dir,
  };

  const origLog = console.log;
  const origOut = process.stdout.write.bind(process.stdout);
  console.log = () => {};
  process.stdout.write = (() => true) as typeof process.stdout.write;
  try {
    await fn(opts, calls, dir);
  } finally {
    console.log = origLog;
    process.stdout.write = origOut;
    await new Promise<void>((resolve) => srv.close(() => resolve()));
    rmSync(dir, { recursive: true, force: true });
  }
}

test("splitCsv, api client, and ensureServer reuse healthy control plane", async () => {
  assert.deepEqual(splitCsv(undefined), []);
  assert.deepEqual(splitCsv(" a, , b ,c "), ["a", "b", "c"]);

  await withMockControlPlane(
    (req) => {
      if (req.url === "/plain") return { rawText: "plain-response" };
      return { body: { echoed: req.body } };
    },
    async (opts) => {
      const owned = await ensureServer(opts);
      assert.equal(owned.close, undefined);

      const plain = await api(opts, "GET", "/plain");
      assert.equal(plain.status, 200);
      assert.equal(plain.text, "plain-response");
      assert.equal(plain.json, undefined);

      let ran = false;
      await withServer(opts, async () => {
        const res = await api(opts, "POST", "/echo", { hello: "world" });
        assert.deepEqual(res.json, { echoed: { hello: "world" } });
        ran = true;
      });
      assert.equal(ran, true);
    },
  );
});

test("handleCoreCommand validates arguments and dispatches task lifecycle, jobs, consults, materials, and rollback", async () => {
  await withMockControlPlane(
    (req) => {
      if (req.url.endsWith("/pause")) return { status: 409, rawText: "cannot pause terminal task" };
      if (req.url.endsWith("/rollback")) return { rawText: "#!/usr/bin/env bash\necho rollback\n" };
      return { body: { ok: true } };
    },
    async (opts, calls, dir) => {
      assert.equal(await handleCoreCommand("non-existent", [], opts), false);

      await assert.rejects(() => handleCoreCommand("hint", ["t1"], opts), /gy hint/);
      await assert.rejects(() => handleCoreCommand("pause", ["t1"], opts), /cannot pause terminal task/);

      await handleCoreCommand("status", [], opts);
      await handleCoreCommand("status", ["t1"], opts);
      await handleCoreCommand("hint", ["t1", "check", "/admin"], opts);
      await handleCoreCommand("handoff", ["t1", "--next-owner", "alice", "--now", "2026-11-28T00:00:00Z"], opts);
      await handleCoreCommand("jobs", ["t1", "--receipts"], opts);
      await handleCoreCommand(
        "job-submit",
        ["t1", "--kind", "hashcat", "--label", "crack", "--input", "a.txt,b.txt", "--asset", "10.0.0.1"],
        opts,
      );
      await handleCoreCommand("job-ack", ["t1", "j1", "--key", "dk-1", "--by", "bob"], opts);
      await handleCoreCommand("consult", ["t1", "--question", "Allow restart?", "--options", "yes,no", "--blocking", "false"], opts);
      await handleCoreCommand("answer", ["t1", "c1", "yes", "--by", "lead"], opts);

      const matFile = join(dir, "sample.txt");
      writeFileSync(matFile, "sample-material", "utf8");
      await handleCoreCommand("material", ["t1", "--path", "ev/sample.txt", "--file", matFile, "--asset", "app.test"], opts);

      const outScript = join(dir, "rb.sh");
      await handleCoreCommand("rollback", ["t1", "--out", outScript], opts);
      assert.match(readFileSync(outScript, "utf8"), /echo rollback/);

      const statusDir = join(dir, "tasks", "t-local");
      mkdirSync(statusDir, { recursive: true });
      writeFileSync(join(statusDir, "worker-status.json"), '{"slot":0}', "utf8");
      await handleCoreCommand("inspect", ["t-local"], opts);
      await assert.rejects(() => handleCoreCommand("inspect", ["missing-task"], opts), /missing/);

      const urls = calls.map((c) => `${c.method} ${c.url}`);
      assert.ok(urls.includes("GET /tasks"));
      assert.ok(urls.includes("GET /tasks/t1"));
      assert.ok(urls.includes("POST /tasks/t1/hints"));
      assert.ok(urls.includes("GET /tasks/t1/handoff?nextOwner=alice&now=2026-11-28T00%3A00%3A00Z"));
      assert.ok(urls.includes("GET /tasks/t1/jobs?receipts=1"));
      assert.ok(urls.includes("POST /tasks/t1/jobs"));
      assert.ok(urls.includes("POST /tasks/t1/consults"));
      assert.ok(urls.includes("POST /tasks/t1/consults/c1/answer"));
      assert.ok(urls.includes("POST /tasks/t1/materials"));
    },
  );
});

test("handleReviewCommand dispatches verification, retest, reconcile, peer-review, and http-session commands", async () => {
  await withMockControlPlane(
    (req) => {
      if (req.url === "/tasks/t1/reconcile") return { body: { counts: { changed: 1 } } };
      return { body: { ok: true } };
    },
    async (opts, calls, dir) => {
      assert.equal(await handleReviewCommand("unknown-cmd", [], opts), false);
      await assert.rejects(() => handleReviewCommand("coverage-snapshot", ["t1"], opts), /请省略 --base-url/);

      await handleReviewCommand("finding-verify", ["t1", "--finding", "f1", "--evidence", "e1.txt,e2.txt", "--repro", "curl /p"], opts);
      await handleReviewCommand("finding-retract", ["t1", "--finding", "f1", "--reason", "fp"], opts);
      await handleReviewCommand(
        "finding-validate",
        ["t1", "--finding", "f1", "--verdict", "confirmed", "--method", "replay", "--evidence", "e1.txt"],
        opts,
      );
      await handleReviewCommand("validations", ["t1", "--finding", "f1"], opts);
      await handleReviewCommand(
        "retest",
        ["t1", "--finding", "f1", "--result", "fixed", "--evidence", "retest.txt", "--repro", "curl -I"],
        opts,
      );
      const recOut = join(dir, "rec-out.json");
      await handleReviewCommand(
        "reconcile",
        ["t1", "--baseline", "base.csv", "--current", "cur.csv", "--required", "id,role", "--out", recOut],
        opts,
      );
      assert.deepEqual(JSON.parse(readFileSync(recOut, "utf8")), { counts: { changed: 1 } });

      await handleReviewCommand(
        "peer-review",
        ["t1", "--reviewer", "sec-b", "--role", "lead", "--source", "t0", "--basis", "verified poc", "--finding", "f1"],
        opts,
      );
      await handleReviewCommand("session", ["list", "t1"], opts);
      await handleReviewCommand(
        "session",
        ["import", "t1", "--name", "admin", "--host", "app.test", "--cookie", "sid=1", "--header", "X-CSRF: tok"],
        opts,
      );
      await handleReviewCommand("session", ["delete", "t1", "--name", "admin"], opts);

      const sessionImport = calls.find((c) => c.method === "POST" && c.url === "/tasks/t1/http-sessions");
      assert.deepEqual(sessionImport?.body, {
        name: "admin",
        host: "app.test",
        cookie: "sid=1",
        headers: { "X-CSRF": "tok" },
      });
      assert.ok(calls.some((c) => c.method === "DELETE" && c.url === "/tasks/t1/http-sessions/admin"));
    },
  );
});

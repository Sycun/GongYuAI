import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { startTrafficProxy } from "@gongyuai/exec";
import { runTrafficTool } from "./traffic-tools.js";

const TASK = "6460e5ec-1a8c-4b95-b4e3-d77a02c79680";

test("traffic tools search, summarize, and page a body without dropping the evidence ref", async () => {
  const taskDir = mkdtempSync(join(tmpdir(), "gy-traffic-tools-"));
  const origin = createServer((req, res) => {
    res.writeHead(201, { "content-type": "text/plain" });
    res.end("marker-needle-ok");
  });
  await new Promise<void>((resolve) => origin.listen(0, "127.0.0.1", () => resolve()));
  const address = origin.address();
  if (!address || typeof address === "string") throw new Error("no port");
  const proxy = await startTrafficProxy({ taskId: TASK, taskDir });
  try {
    await new Promise<void>((resolve, reject) => {
      const req = httpRequest({
        host: "127.0.0.1",
        port: proxy.port,
        method: "GET",
        path: `http://127.0.0.1:${address.port}/needle`,
        headers: { host: `127.0.0.1:${address.port}` },
      }, (res) => {
        res.resume();
        res.on("end", () => resolve());
      });
      req.on("error", reject);
      req.end();
    });

    const found = JSON.parse(runTrafficTool(taskDir, TASK, "traffic_search", { keyword: "needle", status: 201 })) as {
      ok: boolean;
      evidence: string[];
      traffic: Array<{ id: string }>;
    };
    assert.equal(found.ok, true);
    assert.equal(found.traffic.length, 1);
    assert.equal(found.evidence[0], `http:${found.traffic[0]!.id}`);
    const missed = JSON.parse(runTrafficTool(taskDir, TASK, "traffic_search", { host: "other.invalid" })) as { traffic: unknown[] };
    assert.equal(missed.traffic.length, 0);

    const detail = JSON.parse(runTrafficTool(taskDir, TASK, "traffic_get", { id: found.traffic[0]!.id })) as {
      evidenceRef: string;
      record: { reqHeaders: Record<string, string> };
      summary: { resHead: string; status: number };
    };
    assert.equal(detail.evidenceRef, `http:${found.traffic[0]!.id}`);
    assert.equal(detail.summary.status, 201);
    assert.match(detail.summary.resHead, /marker-/);

    const blob = JSON.parse(runTrafficTool(taskDir, TASK, "traffic_blob", {
      id: found.traffic[0]!.id,
      side: "res",
      offset: 7,
      maxBytes: 6,
    })) as { evidenceRef: string; body: string; bytes: string; nextOffset: number | null };
    assert.equal(blob.evidenceRef, detail.evidenceRef);
    assert.equal(Buffer.from(blob.bytes, "base64").toString("utf8"), "needle");
    assert.equal(blob.body, "needle");
  } finally {
    await proxy.close();
    origin.close();
    rmSync(taskDir, { recursive: true, force: true });
  }
});

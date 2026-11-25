import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  clearTrafficRing,
  countTrafficExchanges,
  promoteTrafficForFinding,
  startTrafficProxy,
} from "@gongyuai/exec";
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

test("traffic tools merge hot ring rows with persisted rows and dedupe after promote", async () => {
  const taskDir = mkdtempSync(join(tmpdir(), "gy-traffic-tools-live-"));
  const FINDING = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const origin = createServer((req, res) => {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end(`body-of-${req.url ?? "/"}`);
  });
  await new Promise<void>((resolve) => origin.listen(0, "127.0.0.1", () => resolve()));
  const address = origin.address();
  if (!address || typeof address === "string") throw new Error("no port");
  const proxy = await startTrafficProxy({ taskId: TASK, taskDir, mode: "finding-window" });
  const fetchVia = (path: string) => new Promise<void>((resolve, reject) => {
    const req = httpRequest({
      host: "127.0.0.1",
      port: proxy.port,
      method: "GET",
      path: `http://127.0.0.1:${address.port}${path}`,
      headers: { host: `127.0.0.1:${address.port}` },
    }, (res) => {
      res.resume();
      res.on("end", () => resolve());
    });
    req.on("error", reject);
    req.end();
  });
  try {
    await fetchVia("/probe-1");
    await fetchVia("/probe-2");
    assert.equal(countTrafficExchanges(taskDir), 0);

    type Search = { ok: boolean; total: number; traffic: Array<{ id: string; path: string }>; hotIds?: string[] };
    const hot = JSON.parse(runTrafficTool(taskDir, TASK, "traffic_search", { keyword: "probe" })) as Search;
    assert.equal(hot.total, 2);
    assert.equal(hot.hotIds?.length, 2);
    const probe1 = hot.traffic.find((row) => row.path === "/probe-1")!;
    const getHot = JSON.parse(runTrafficTool(taskDir, TASK, "traffic_get", { id: probe1.id })) as {
      persisted: boolean;
      summary: { resHead: string };
    };
    assert.equal(getHot.persisted, false);
    assert.equal(getHot.summary.resHead, "body-of-/probe-1");
    const blobHot = JSON.parse(runTrafficTool(taskDir, TASK, "traffic_blob", { id: probe1.id, side: "res" })) as { body: string };
    assert.equal(blobHot.body, "body-of-/probe-1");

    // finding_record would promote the id the agent saw; it keeps the same id.
    const promoted = promoteTrafficForFinding(taskDir, { findingId: FINDING, trafficIds: [probe1.id], postWindowMs: 0 });
    assert.deepEqual(promoted.trafficIds, [probe1.id]);

    const merged = JSON.parse(runTrafficTool(taskDir, TASK, "traffic_search", { keyword: "probe" })) as Search;
    assert.equal(merged.total, 2, "promoted row must not be counted twice");
    assert.deepEqual(merged.hotIds?.length, 1);
    assert.equal(new Set(merged.traffic.map((row) => row.id)).size, 2);
    const getStored = JSON.parse(runTrafficTool(taskDir, TASK, "traffic_get", { id: probe1.id })) as {
      persisted: boolean;
      record: { findingIds?: string[] };
    };
    assert.equal(getStored.persisted, true);
    assert.deepEqual(getStored.record.findingIds, [FINDING]);

    // Paging walks hot rows first, then stored rows, without gaps.
    const page1 = JSON.parse(runTrafficTool(taskDir, TASK, "traffic_search", { keyword: "probe", limit: 1 })) as Search & { nextOffset: number | null };
    const page2 = JSON.parse(runTrafficTool(taskDir, TASK, "traffic_search", { keyword: "probe", limit: 1, offset: 1 })) as Search & { nextOffset: number | null };
    assert.equal(page1.nextOffset, 1);
    assert.equal(page2.nextOffset, null);
    assert.notEqual(page1.traffic[0]!.id, page2.traffic[0]!.id);

    const missing = JSON.parse(runTrafficTool(taskDir, TASK, "traffic_get", { id: "00000000-0000-4000-8000-000000000000" })) as { ok: boolean };
    assert.equal(missing.ok, false);
  } finally {
    await proxy.close();
    origin.close();
    clearTrafficRing(taskDir);
    rmSync(taskDir, { recursive: true, force: true });
  }
});

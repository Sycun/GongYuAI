import assert from "node:assert/strict";
import { createServer, request as httpRequest } from "node:http";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  activeFindingWindows,
  clearTrafficRing,
  closeFindingWindow,
  closeTrafficDb,
  countTrafficExchanges,
  getTraffic,
  getTrafficLive,
  insertTraffic,
  promoteTrafficForFinding,
  pushTrafficRing,
  queryTrafficLive,
  queryTrafficRing,
  readTrafficBody,
  readTrafficBodyLive,
  startTrafficProxy,
  targetHostOf,
  trafficLabelUuid,
  trafficRingSize,
  type CapturedBody,
} from "./traffic/index.js";

const TASK = "6460e5ec-1a8c-4b95-b4e3-d77a02c79680";
const FINDING = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const INTENT_A = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const INTENT_B = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function tempTask(): string {
  return mkdtempSync(join(tmpdir(), "gy-traffic-window-"));
}

function get(port: number, target: string): Promise<{ status: number; body: Buffer }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({
      host: "127.0.0.1",
      port,
      method: "GET",
      path: target,
      headers: { host: new URL(target).host },
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks) }));
    });
    req.on("error", reject);
    req.end();
  });
}

const BIG = Buffer.alloc(100 * 1024, 0x61);

test("finding-window proxy: ring only, static/404 noise skipped, promote + post-window persist", async () => {
  const taskDir = tempTask();
  const origin = createServer((req, res) => {
    const path = req.url ?? "/";
    if (path.startsWith("/api/login")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end('{"token":"token-xyz"}');
    } else if (path.startsWith("/static/")) {
      res.writeHead(200, { "content-type": "application/javascript" });
      res.end("console.log(1)");
    } else if (path.startsWith("/big")) {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end(BIG);
    } else if (path.startsWith("/api/")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(`{"path":"${path}"}`);
    } else {
      res.writeHead(404, { "content-type": "text/html" });
      res.end("nope");
    }
  });
  await new Promise<void>((resolve) => origin.listen(0, "127.0.0.1", () => resolve()));
  const address = origin.address();
  if (!address || typeof address === "string") throw new Error("no port");
  const base = `http://127.0.0.1:${address.port}`;
  const proxy = await startTrafficProxy({ taskId: TASK, taskDir, mode: "finding-window" });
  try {
    assert.equal((await get(proxy.port, `${base}/api/login`)).body.toString(), '{"token":"token-xyz"}');
    assert.equal((await get(proxy.port, `${base}/static/app.js`)).body.toString(), "console.log(1)");
    await get(proxy.port, `${base}/missing`);
    await get(proxy.port, `${base}/missing`);
    const big = await get(proxy.port, `${base}/big`);
    assert.equal(big.body.length, BIG.length);

    // Nothing on disk: no rows, no blobs, no temp spool files.
    assert.equal(countTrafficExchanges(taskDir), 0);
    assert.equal(existsSync(join(taskDir, "traffic", "_blobs")), false);
    assert.equal(existsSync(join(taskDir, "traffic", "_tmp")) && readdirSync(join(taskDir, "traffic", "_tmp")).length > 0, false);
    // login + first 404 + big; static asset and repeated 404 never enter the ring.
    assert.equal(trafficRingSize(taskDir), 3);

    const hot = queryTrafficLive(taskDir, { taskId: TASK, keyword: "token-xyz" });
    assert.equal(hot.traffic.length, 1);
    assert.deepEqual(hot.hotIds, [hot.traffic[0]!.id]);
    const loginId = hot.traffic[0]!.id;
    assert.equal(getTrafficLive(taskDir, loginId)?.path, "/api/login");
    const bigRow = queryTrafficLive(taskDir, { taskId: TASK, path: "/big" }).traffic[0]!;
    const bigSlice = readTrafficBodyLive(taskDir, bigRow.id, "res", 0, 16);
    assert.equal(bigSlice.source, "ring");
    assert.equal(bigSlice.size, BIG.length);
    assert.equal(bigSlice.truncated, true);
    assert.equal(bigSlice.bufferedBytes, 64 * 1024);
    assert.equal(bigSlice.body, "a".repeat(16));

    // Pre-window promote by target host.
    const promoted = promoteTrafficForFinding(taskDir, { findingId: FINDING, asset: `${base}/api/login` });
    assert.equal(promoted.promoted, 3);
    assert.ok(promoted.trafficIds.includes(loginId));
    assert.equal(promoted.window?.host, "127.0.0.1");
    assert.equal(countTrafficExchanges(taskDir), 3);
    assert.deepEqual(getTraffic(taskDir, loginId)?.findingIds, [FINDING]);
    assert.match(readTrafficBody(taskDir, loginId, "res").body, /token-xyz/);
    const bigStored = getTraffic(taskDir, bigRow.id);
    assert.equal(bigStored?.resBodyBlob?.size, 64 * 1024);
    assert.match(String(bigStored?.resHeaders["x-gy-body-truncated-res"]), /size=102400/);
    // Promoted rows no longer counted twice in live search.
    assert.equal(queryTrafficLive(taskDir, { taskId: TASK }).total, 3);
    assert.equal(queryTrafficRing(taskDir, { taskId: TASK }).length, 0);

    // Post-window: next matching exchange is persisted directly and linked.
    await get(proxy.port, `${base}/api/me`);
    assert.equal(countTrafficExchanges(taskDir), 4);
    const me = queryTrafficLive(taskDir, { taskId: TASK, path: "/api/me" });
    assert.deepEqual(me.hotIds, []);
    assert.deepEqual(me.traffic[0]?.findingIds, [FINDING]);
    // Static stays out even inside the window.
    await get(proxy.port, `${base}/static/app.js`);
    assert.equal(countTrafficExchanges(taskDir), 4);

    // Verify converges the window to one more capture, then it closes.
    const converged = promoteTrafficForFinding(taskDir, { findingId: FINDING, host: "127.0.0.1", converge: true, postMaxItems: 1 });
    assert.equal(converged.promoted, 0);
    assert.equal(converged.window?.remaining, 1);
    await get(proxy.port, `${base}/api/confirm`);
    assert.equal(countTrafficExchanges(taskDir), 5);
    assert.deepEqual(activeFindingWindows(taskDir), []);
    await get(proxy.port, `${base}/api/after`);
    assert.equal(countTrafficExchanges(taskDir), 5);
    assert.equal(queryTrafficLive(taskDir, { taskId: TASK, path: "/api/after" }).hotIds.length, 1);
  } finally {
    await proxy.close();
    origin.close();
    clearTrafficRing(taskDir);
    rmSync(taskDir, { recursive: true, force: true });
  }
});

function body(text: string): CapturedBody {
  const head = Buffer.from(text);
  return { head, size: head.length, sha256: "0".repeat(64) };
}

function ringWrite(over: { host?: string; intentId?: string; path?: string; at: number }) {
  return {
    taskId: TASK,
    ...(over.intentId ? { intentId: over.intentId } : {}),
    method: "GET",
    url: `http://${over.host ?? "a.local"}${over.path ?? "/"}`,
    host: over.host ?? "a.local",
    path: over.path ?? "/",
    status: 200,
    durationMs: 1,
    startedAt: new Date(over.at).toISOString(),
    reqHeaders: {},
    resHeaders: { "content-type": "text/plain" },
  };
}

test("ring is bounded and pre-window selects by intent/host, time and count; explicit ids always win", () => {
  const taskDir = tempTask();
  try {
    for (let i = 0; i < 5; i += 1) {
      pushTrafficRing(taskDir, { id: `00000000-0000-4000-8000-00000000000${i}`, atMs: i, write: ringWrite({ at: i }) }, { ringMax: 3 });
    }
    assert.equal(trafficRingSize(taskDir), 3);
    assert.equal(getTrafficLive(taskDir, "00000000-0000-4000-8000-000000000000"), null);
    clearTrafficRing(taskDir);

    const now = 10 * 60_000;
    const id = (n: number) => `11111111-1111-4111-8111-${String(n).padStart(12, "0")}`;
    // Old (outside 5 min), intent A x3 recent, intent B on another host, host match without intent.
    pushTrafficRing(taskDir, { id: id(1), atMs: now - 6 * 60_000, write: ringWrite({ intentId: INTENT_A, at: now - 6 * 60_000 }), resBody: body("old") });
    for (let i = 2; i <= 4; i += 1) {
      pushTrafficRing(taskDir, { id: id(i), atMs: now - (10 - i) * 1000, write: ringWrite({ intentId: INTENT_A, host: "x.local", at: now - (10 - i) * 1000 }), resBody: body(`a${i}`) });
    }
    pushTrafficRing(taskDir, { id: id(5), atMs: now - 1000, write: ringWrite({ intentId: INTENT_B, host: "b.local", at: now - 1000 }) });
    pushTrafficRing(taskDir, { id: id(6), atMs: now - 500, write: ringWrite({ host: "a.local", at: now - 500 }) });

    const res = promoteTrafficForFinding(taskDir, {
      findingId: FINDING,
      intentId: INTENT_A,
      trafficIds: [`http:${id(1)}`],
      preMaxItems: 2,
      nowMs: now,
    });
    // id(1) explicit (old but named); newest 2 of intent A = id(3), id(4).
    assert.deepEqual(new Set(res.trafficIds), new Set([id(1), id(3), id(4)]));
    assert.equal(res.promoted, 3);
    assert.equal(getTraffic(taskDir, id(2)), null);
    assert.equal(getTraffic(taskDir, id(5)), null);
    assert.equal(res.window?.intentId, INTENT_A);

    // Re-promoting an already persisted id only links; no duplicate row.
    const again = promoteTrafficForFinding(taskDir, {
      findingId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
      trafficIds: [id(3)],
      postWindowMs: 0,
      nowMs: now,
    });
    assert.equal(again.promoted, 0);
    assert.equal(again.window, null);
    assert.deepEqual(getTraffic(taskDir, id(3))?.findingIds, [FINDING, "dddddddd-dddd-4ddd-8ddd-dddddddddddd"]);
    assert.equal(countTrafficExchanges(taskDir), 3);

    // Explicit id that already lives in index.sqlite (e.g. GY_TRAFFIC_MODE=all) is linked too.
    const stored = insertTraffic(taskDir, { ...ringWrite({ at: now }), id: id(9) });
    const linked = promoteTrafficForFinding(taskDir, { findingId: FINDING, trafficIds: [stored.id], nowMs: now });
    assert.ok(linked.trafficIds.includes(stored.id));
    assert.deepEqual(getTraffic(taskDir, stored.id)?.findingIds, [FINDING]);

    assert.equal(closeFindingWindow(taskDir, FINDING), true);
    assert.deepEqual(activeFindingWindows(taskDir, now), []);
  } finally {
    clearTrafficRing(taskDir);
    closeTrafficDb(taskDir);
    rmSync(taskDir, { recursive: true, force: true });
  }
});

test("label UUIDs are stable and schema-valid; host parsing accepts URLs and bare hosts", () => {
  const a = trafficLabelUuid("tsecbench:web-01");
  assert.match(a, UUID);
  assert.equal(a, trafficLabelUuid("tsecbench:web-01"));
  assert.notEqual(a, trafficLabelUuid("tsecbench:web-02"));
  assert.equal(targetHostOf("https://Lab.Local:8443/x?y=1"), "lab.local");
  assert.equal(targetHostOf("lab.local:8080/path"), "lab.local");
  assert.equal(targetHostOf("10.0.0.5"), "10.0.0.5");
  assert.equal(targetHostOf(""), undefined);
});

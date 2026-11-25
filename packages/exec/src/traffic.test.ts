import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { createServer as createHttpServer, request as httpRequest } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { connect as netConnect } from "node:net";
import { connect as tlsConnect } from "node:tls";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  blobPath,
  closeTrafficDb,
  countTrafficExchanges,
  getTraffic,
  insertTraffic,
  linkTrafficFinding,
  pruneTrafficNow,
  queryTraffic,
  readBlobSlice,
  readStoredExchange,
  resolveTrafficMode,
  startTrafficProxy,
  TRAFFIC_MAX_EXCHANGES,
  TRAFFIC_PREVIEW_CHARS,
  TRAFFIC_PRUNE_CHECK_EVERY,
  TRAFFIC_PRUNE_SLACK,
  TRAFFIC_VACUUM_PAGES,
  trafficPruneDue,
  trafficRetentionDefaults,
  type TrafficWrite,
} from "./traffic/index.js";
import { ensureTaskCa, leafFor } from "./traffic/ca.js";

const TASK = "6460e5ec-1a8c-4b95-b4e3-d77a02c79680";

function tempTask(): string {
  return mkdtempSync(join(tmpdir(), "gy-traffic-"));
}

function listen(server: ReturnType<typeof createHttpServer>): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("no port");
      resolve(address.port);
    });
  });
}

function proxyRequest(
  port: number,
  target: string,
  body?: Buffer,
  method = "POST",
): Promise<{ status: number; body: Buffer }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({
      host: "127.0.0.1",
      port,
      method,
      path: target,
      headers: {
        host: new URL(target).host,
        ...(body ? { "content-type": "application/octet-stream", "content-length": body.length } : {}),
      },
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks) }));
    });
    req.on("error", reject);
    req.end(body);
  });
}

test("recorded bodies are deduped under sha256/<ab>/<hash>.bin and slice by offset", async () => {
  const taskDir = tempTask();
  const origin = createHttpServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    req.on("end", () => {
      const body = Buffer.concat(chunks);
      res.writeHead(200, { "content-type": "application/octet-stream" });
      res.end(body);
    });
  });
  const originPort = await listen(origin);
  const proxy = await startTrafficProxy({ taskId: TASK, taskDir, workerId: "w0", mode: "all" });
  try {
    const before = { ...process.env };
    const env = proxy.getProxyEnv();
    assert.equal(process.env.HTTP_PROXY, before.HTTP_PROXY);
    assert.equal(process.env.NODE_EXTRA_CA_CERTS, before.NODE_EXTRA_CA_CERTS);
    assert.equal(env.HTTP_PROXY, `http://127.0.0.1:${proxy.port}`);
    assert.equal(env.HTTPS_PROXY, env.HTTP_PROXY);
    assert.equal(env.NODE_EXTRA_CA_CERTS, proxy.caPath);
    assert.equal(env.REQUESTS_CA_BUNDLE, proxy.caPath);
    assert.equal(env.SSL_CERT_FILE, proxy.caPath);
    const injected = spawnSync(process.execPath, ["-e", "process.stdout.write(process.env.HTTP_PROXY ?? '')"], {
      env: { ...process.env, ...env },
      encoding: "utf8",
    });
    assert.equal(injected.stdout, env.HTTP_PROXY);
    assert.equal(process.env.HTTP_PROXY, before.HTTP_PROXY);

    const payload = randomBytes(20 * 1024);
    const target = `http://127.0.0.1:${originPort}/echo`;
    const first = await proxyRequest(proxy.port, target, payload);
    assert.equal(first.status, 200);
    assert.deepEqual(first.body, payload);
    const sha = createHash("sha256").update(payload).digest("hex");
    const stored = blobPath(taskDir, sha);
    assert.equal(stored.endsWith(`/sha256/${sha.slice(0, 2)}/${sha}.bin`), true);
    const info = statSync(stored);
    assert.equal(info.mode & 0o777, 0o600);
    const stamp = info.mtimeMs;

    const second = await proxyRequest(proxy.port, target, payload);
    assert.equal(second.status, 200);
    assert.equal(statSync(stored).mtimeMs, stamp);

    const other = randomBytes(32);
    await proxyRequest(proxy.port, target, other);
    const otherSha = createHash("sha256").update(other).digest("hex");
    assert.notEqual(otherSha, sha);
    assert.equal(statSync(blobPath(taskDir, otherSha)).isFile(), true);

    const slice = readBlobSlice(taskDir, sha, 100, 50);
    assert.equal(slice.size, payload.length);
    assert.deepEqual(slice.bytes, payload.subarray(100, 150));
    const next = readBlobSlice(taskDir, sha, slice.nextOffset ?? payload.length, 50);
    assert.deepEqual(next.bytes, payload.subarray(150, 200));
    assert.throws(() => readBlobSlice(taskDir, `../${"a".repeat(60)}`), /invalid sha256/);
    assert.throws(() => readBlobSlice(taskDir, sha, 0, 64 * 1024 + 1), /65536/);
    const def = readBlobSlice(taskDir, sha);
    assert.equal(def.maxBytes, 8192);
    assert.equal(def.bytes.length, 8192);
    const page = queryTraffic(taskDir, { taskId: TASK, method: "POST" });
    assert.equal(page.traffic.length, 3);
    assert.equal(page.nextOffset, null);
    const one = getTraffic(taskDir, page.traffic[0]!.id);
    assert.equal(one?.reqBodyBlob?.sha256, sha);
    assert.equal(one?.resBodyBlob?.sha256, sha);
  } finally {
    await proxy.close();
    origin.close();
    rmSync(taskDir, { recursive: true, force: true });
  }
});

test("HTTPS CONNECT is decrypted with the task CA and an upstream proxy is swappable", async () => {
  const taskDir = tempTask();
  const ca = ensureTaskCa(taskDir);
  const pem = leafFor(ca, "127.0.0.1");
  let viaUpstream = 0;
  const origin = createHttpsServer({ cert: pem.cert, key: pem.key }, (_req, res) => {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("mitm-ok");
  });
  const originPort = await listen(origin);
  const plain = createHttpServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("via-upstream");
  });
  const plainPort = await listen(plain);
  const hop = createHttpServer((req, res) => {
    viaUpstream += 1;
    const target = new URL(req.url ?? "");
    const up = httpRequest(target, (upstream) => {
      res.writeHead(upstream.statusCode ?? 502);
      upstream.pipe(res);
    });
    req.pipe(up);
  });
  const hopPort = await listen(hop);
  const proxy = await startTrafficProxy({
    taskId: TASK,
    taskDir,
    insecureUpstream: true,
    mode: "all",
  });
  try {
    const tlsBody = await connectHttps(proxy.port, originPort, proxy.caPath);
    assert.match(tlsBody.toString("utf8"), /mitm-ok/);
    const recorded = queryTraffic(taskDir, { taskId: TASK, path: "/secret" });
    assert.equal(recorded.traffic.length, 1);
    const blob = recorded.traffic[0]?.resBodyBlob;
    assert.ok(blob);
    assert.equal(readBlobSlice(taskDir, blob.sha256).bytes.toString("utf8"), "mitm-ok");

    proxy.setUpstream(`http://127.0.0.1:${hopPort}`);
    const forwarded = await proxyRequest(proxy.port, `http://127.0.0.1:${plainPort}/direct`, undefined, "GET");
    assert.equal(viaUpstream, 1);
    assert.equal(forwarded.status, 200);
    assert.equal(forwarded.body.toString("utf8"), "via-upstream");
  } finally {
    await proxy.close();
    origin.close();
    plain.close();
    hop.close();
    rmSync(taskDir, { recursive: true, force: true });
  }
});

function connectHttps(proxyPort: number, originPort: number, caPath: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const socket = netConnect(proxyPort, "127.0.0.1");
    socket.once("error", reject);
    socket.once("connect", () => {
      socket.write(`CONNECT 127.0.0.1:${originPort} HTTP/1.1\r\nHost: 127.0.0.1:${originPort}\r\n\r\n`);
      let buf = Buffer.alloc(0);
      const onData = (chunk: Buffer) => {
        buf = Buffer.concat([buf, chunk]);
        const split = buf.indexOf("\r\n\r\n");
        if (split < 0) return;
        socket.off("data", onData);
        const rest = buf.subarray(split + 4);
        if (rest.length) socket.unshift(rest);
        const tls = tlsConnect({
          socket,
          host: "127.0.0.1",
          ca: readFileSync(caPath),
          rejectUnauthorized: true,
        });
        tls.once("error", reject);
        tls.once("secureConnect", () => {
          tls.write("GET /secret HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n");
        });
        const chunks: Buffer[] = [];
        tls.on("data", (part) => chunks.push(Buffer.from(part)));
        tls.on("end", () => {
          const raw = Buffer.concat(chunks).toString("utf8");
          const body = raw.slice(raw.indexOf("\r\n\r\n") + 4);
          resolve(Buffer.from(body));
        });
      };
      socket.on("data", onData);
    });
  });
}

const RETAIN = {
  maxPreviewChars: 64,
  maxHeadersJsonChars: 180,
  maxExchanges: 5,
  compactStaticAssets: true,
  compactNoise: true,
  noiseRepeatAfter: 1,
  noiseHostThreshold: 3,
};

function exchange(over: Partial<TrafficWrite> = {}): TrafficWrite {
  return {
    taskId: TASK,
    method: "GET",
    url: "http://lab.local/a",
    host: "lab.local",
    path: "/a",
    status: 200,
    durationMs: 4,
    startedAt: "2026-11-25T00:00:00.000Z",
    reqHeaders: { host: "lab.local", cookie: "session=abc" },
    resHeaders: { "content-type": "text/html; charset=utf-8", "set-cookie": "a=b" },
    reqPreview: "request-body",
    resPreview: "response-body",
    ...over,
  };
}

test("traffic index caps previews and headers, and compacts static assets and repeated 404s", () => {
  const previous = {
    preview: process.env.GY_TRAFFIC_MAX_PREVIEW_CHARS,
    headers: process.env.GY_TRAFFIC_MAX_HEADERS_CHARS,
    cap: process.env.GY_TRAFFIC_MAX_EXCHANGES,
  };
  delete process.env.GY_TRAFFIC_MAX_PREVIEW_CHARS;
  delete process.env.GY_TRAFFIC_MAX_HEADERS_CHARS;
  delete process.env.GY_TRAFFIC_MAX_EXCHANGES;
  const taskDir = tempTask();
  try {
    const defaults = trafficRetentionDefaults();
    assert.equal(defaults.maxPreviewChars, TRAFFIC_PREVIEW_CHARS);
    assert.ok(defaults.maxPreviewChars <= 1024);
    assert.equal(defaults.maxExchanges, TRAFFIC_MAX_EXCHANGES);
    assert.ok(defaults.maxExchanges > 0);

    const fat = insertTraffic(taskDir, exchange({
      startedAt: "2026-11-25T00:00:01.000Z",
      path: "/login",
      url: "http://lab.local/login",
      reqPreview: "R".repeat(4000),
      resPreview: "S".repeat(4000),
      reqHeaders: { cookie: "c".repeat(5000), host: "lab.local" },
      resHeaders: { "content-type": "text/html", "x-debug": "d".repeat(5000) },
    }), RETAIN);
    const stored = readStoredExchange(taskDir, fat.id);
    assert.ok(stored);
    assert.equal(stored.reqPreview.length, 64);
    assert.equal(stored.resPreview.length, 64);
    assert.ok(stored.reqHeadersJson.length <= 180);
    assert.ok(stored.resHeadersJson.length <= 180);
    assert.match(stored.resHeadersJson, /content-type/);

    const asset = insertTraffic(taskDir, exchange({
      startedAt: "2026-11-25T00:00:02.000Z",
      path: "/static/app.js",
      url: "http://lab.local/static/app.js",
      resHeaders: { "content-type": "application/javascript", "set-cookie": "" },
      reqPreview: "should-drop",
      resPreview: "console.log(1)",
    }), RETAIN);
    const assetRow = readStoredExchange(taskDir, asset.id);
    assert.equal(assetRow?.reqPreview, "");
    assert.equal(assetRow?.resPreview, "");
    assert.equal(assetRow?.reqHeadersJson.includes("cookie"), false);
    assert.equal(getTraffic(taskDir, asset.id)?.path, "/static/app.js");

    const stateful = insertTraffic(taskDir, exchange({
      startedAt: "2026-11-25T00:00:03.000Z",
      path: "/static/app.js",
      url: "http://lab.local/static/app.js",
      resHeaders: { "content-type": "application/javascript", "set-cookie": "sid=1" },
      resPreview: "still-visible",
    }), RETAIN);
    assert.equal(readStoredExchange(taskDir, stateful.id)?.resPreview, "still-visible");

    const linkedAsset = insertTraffic(taskDir, exchange({
      startedAt: "2026-11-25T00:00:04.000Z",
      path: "/static/proof.js",
      url: "http://lab.local/static/proof.js",
      resHeaders: { "content-type": "text/javascript" },
      resPreview: "finding-preview",
      findingIds: ["11111111-1111-4111-8111-111111111111"],
    }), RETAIN);
    assert.equal(readStoredExchange(taskDir, linkedAsset.id)?.resPreview, "finding-preview");
    assert.deepEqual(readStoredExchange(taskDir, linkedAsset.id)?.findingIds, ["11111111-1111-4111-8111-111111111111"]);

    const repeatCfg = { ...RETAIN, noiseHostThreshold: 100 };
    const first404 = insertTraffic(taskDir, exchange({
      startedAt: "2026-11-25T00:00:05.000Z",
      method: "GET",
      path: "/missing",
      url: "http://lab.local/missing",
      status: 404,
      resHeaders: { "content-type": "text/html" },
      resPreview: "first-404",
    }), repeatCfg);
    assert.equal(readStoredExchange(taskDir, first404.id)?.resPreview, "first-404");
    const second404 = insertTraffic(taskDir, exchange({
      startedAt: "2026-11-25T00:00:06.000Z",
      path: "/missing",
      url: "http://lab.local/missing",
      status: 404,
      resHeaders: { "content-type": "text/html" },
      resPreview: "repeat-404",
    }), repeatCfg);
    assert.equal(readStoredExchange(taskDir, second404.id)?.resPreview, "");
    assert.equal(getTraffic(taskDir, second404.id)?.status, 404);

    const floodCfg = { ...RETAIN, noiseRepeatAfter: 100, noiseHostThreshold: 2 };
    for (let i = 0; i < 2; i += 1) {
      const row = insertTraffic(taskDir, exchange({
        startedAt: `2026-11-25T00:00:1${i}.000Z`,
        host: "flood.local",
        path: `/scan-${i}`,
        url: `http://flood.local/scan-${i}`,
        status: 404,
        resHeaders: { "content-type": "text/plain" },
        resPreview: `unique-${i}`,
      }), floodCfg);
      assert.equal(readStoredExchange(taskDir, row.id)?.resPreview, `unique-${i}`);
    }
    const flooded = insertTraffic(taskDir, exchange({
      startedAt: "2026-11-25T00:00:20.000Z",
      host: "flood.local",
      path: "/scan-flood",
      url: "http://flood.local/scan-flood",
      status: 404,
      resHeaders: { "content-type": "text/plain" },
      resPreview: "flood-preview",
    }), floodCfg);
    assert.equal(readStoredExchange(taskDir, flooded.id)?.resPreview, "");
    assert.equal(getTraffic(taskDir, flooded.id)?.path, "/scan-flood");
  } finally {
    if (previous.preview !== undefined) process.env.GY_TRAFFIC_MAX_PREVIEW_CHARS = previous.preview;
    if (previous.headers !== undefined) process.env.GY_TRAFFIC_MAX_HEADERS_CHARS = previous.headers;
    if (previous.cap !== undefined) process.env.GY_TRAFFIC_MAX_EXCHANGES = previous.cap;
    closeTrafficDb(taskDir);
    rmSync(taskDir, { recursive: true, force: true });
  }
});

test("traffic rolling prune drops the oldest unlinked rows and keeps finding_ids", () => {
  const taskDir = tempTask();
  try {
    const cfg = {
      ...RETAIN,
      maxExchanges: 4,
      compactStaticAssets: false,
      compactNoise: false,
      pruneCheckEvery: 1,
      pruneSlack: 0,
    };
    const linked = insertTraffic(taskDir, exchange({
      startedAt: "2026-11-25T01:00:00.000Z",
      path: "/kept",
      url: "http://lab.local/kept",
      findingIds: ["22222222-2222-4222-8222-222222222222"],
      resPreview: "linked",
    }), cfg);
    const doomed: string[] = [];
    for (let i = 1; i <= 3; i += 1) {
      const row = insertTraffic(taskDir, exchange({
        startedAt: `2026-11-25T01:00:0${i}.000Z`,
        path: `/old-${i}`,
        url: `http://lab.local/old-${i}`,
        resPreview: `old-${i}`,
      }), cfg);
      doomed.push(row.id);
    }
    linkTrafficFinding(taskDir, doomed[0]!, "33333333-3333-4333-8333-333333333333");
    insertTraffic(taskDir, exchange({
      startedAt: "2026-11-25T01:00:05.000Z",
      path: "/new",
      url: "http://lab.local/new",
      resPreview: "new",
    }), cfg);

    assert.ok(countTrafficExchanges(taskDir) <= 4);
    assert.equal(readStoredExchange(taskDir, linked.id)?.resPreview, "linked");
    assert.deepEqual(readStoredExchange(taskDir, doomed[0]!)?.findingIds, ["33333333-3333-4333-8333-333333333333"]);
    assert.equal(readStoredExchange(taskDir, doomed[1]!), null);
    assert.equal(readStoredExchange(taskDir, doomed[2]!), null);

    const onlyLinked = tempTask();
    try {
      for (let i = 0; i < 4; i += 1) {
        insertTraffic(onlyLinked, exchange({
          startedAt: `2026-11-25T02:00:0${i}.000Z`,
          path: `/proof-${i}`,
          url: `http://lab.local/proof-${i}`,
          findingIds: [`44444444-4444-4444-8444-44444444444${i}`],
        }), { ...cfg, maxExchanges: 2 });
      }
      assert.equal(countTrafficExchanges(onlyLinked), 4);
    } finally {
      closeTrafficDb(onlyLinked);
      rmSync(onlyLinked, { recursive: true, force: true });
    }
  } finally {
    closeTrafficDb(taskDir);
    rmSync(taskDir, { recursive: true, force: true });
  }
});

test("traffic prune is lagged: no count/delete until the check interval and slack are exceeded", () => {
  const taskDir = tempTask();
  try {
    const cfg = {
      ...RETAIN,
      maxExchanges: 10,
      compactStaticAssets: false,
      compactNoise: false,
      pruneCheckEvery: 5,
      pruneSlack: 5,
      vacuumPages: 200,
    };
    const ids: string[] = [];
    const add = (i: number) => {
      const row = insertTraffic(taskDir, exchange({
        startedAt: new Date(Date.UTC(2026, 10, 25, 3, 0, i)).toISOString(),
        path: `/lag-${i}`,
        url: `http://lab.local/lag-${i}`,
      }), cfg);
      ids.push(row.id);
    };
    // 15 rows = maxExchanges + slack: never over the threshold, nothing pruned.
    for (let i = 0; i < 15; i += 1) add(i);
    assert.equal(countTrafficExchanges(taskDir), 15);
    // Rows 16..19 are over the threshold but between checks: still kept.
    for (let i = 15; i < 19; i += 1) add(i);
    assert.equal(countTrafficExchanges(taskDir), 19);
    // The 20th insert hits the check interval: batch delete down to 90% of the cap.
    add(19);
    assert.equal(countTrafficExchanges(taskDir), 9);
    assert.equal(readStoredExchange(taskDir, ids[0]!), null);
    assert.ok(readStoredExchange(taskDir, ids[19]!));

    // pruneTrafficNow honors slack and is a no-op under the threshold.
    assert.equal(pruneTrafficNow(taskDir, cfg), 0);
  } finally {
    closeTrafficDb(taskDir);
    rmSync(taskDir, { recursive: true, force: true });
  }
});

test("GY_TRAFFIC_MODE defaults to finding-window and lag defaults are 200/500/200", () => {
  assert.equal(resolveTrafficMode(undefined), "finding-window");
  assert.equal(resolveTrafficMode(""), "finding-window");
  assert.equal(resolveTrafficMode("bogus"), "finding-window");
  assert.equal(resolveTrafficMode(" ALL "), "all");
  const prev = {
    every: process.env.GY_TRAFFIC_PRUNE_CHECK_EVERY,
    slack: process.env.GY_TRAFFIC_PRUNE_SLACK,
    vac: process.env.GY_TRAFFIC_VACUUM_PAGES,
  };
  delete process.env.GY_TRAFFIC_PRUNE_CHECK_EVERY;
  delete process.env.GY_TRAFFIC_PRUNE_SLACK;
  delete process.env.GY_TRAFFIC_VACUUM_PAGES;
  try {
    const d = trafficRetentionDefaults();
    assert.equal(d.pruneCheckEvery, TRAFFIC_PRUNE_CHECK_EVERY);
    assert.equal(d.pruneSlack, TRAFFIC_PRUNE_SLACK);
    assert.equal(d.vacuumPages, TRAFFIC_VACUUM_PAGES);
    assert.equal(trafficPruneDue(8_500, 8_000, 500), false);
    assert.equal(trafficPruneDue(8_501, 8_000, 500), true);
    assert.equal(trafficPruneDue(99_999, 0, 500), false);
  } finally {
    if (prev.every !== undefined) process.env.GY_TRAFFIC_PRUNE_CHECK_EVERY = prev.every;
    if (prev.slack !== undefined) process.env.GY_TRAFFIC_PRUNE_SLACK = prev.slack;
    if (prev.vac !== undefined) process.env.GY_TRAFFIC_VACUUM_PAGES = prev.vac;
  }
});

test("upstream abort mid-body does not crash the proxy (unhandled stream 'error' regression)", async () => {
  for (const mode of ["finding-window", "all"] as const) {
    const taskDir = tempTask();
    const aborting = createHttpServer((req, res) => {
      res.writeHead(200, { "content-type": "application/octet-stream", "content-length": "100000" });
      res.write("partial");
      setTimeout(() => res.socket?.destroy(), 5);
    });
    const abortPort = await listen(aborting);
    const healthy = createHttpServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("ok");
    });
    const healthyPort = await listen(healthy);
    const proxy = await startTrafficProxy({ taskId: TASK, taskDir, mode });
    try {
      // Aborted upstream destroys the forward PassThrough with an error; without a
      // listener that 'error' is unhandled and kills the process. Must survive.
      await proxyRequest(proxy.port, `http://127.0.0.1:${abortPort}/abort`, undefined, "GET").catch(() => {});
      const ok = await proxyRequest(proxy.port, `http://127.0.0.1:${healthyPort}/ok`, undefined, "GET");
      assert.equal(ok.status, 200);
      assert.equal(ok.body.toString("utf8"), "ok");
    } finally {
      await proxy.close();
      aborting.close();
      healthy.close();
      rmSync(taskDir, { recursive: true, force: true });
    }
  }
});

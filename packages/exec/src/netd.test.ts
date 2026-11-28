import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  clearTrafficRing,
  listNetdTunnels,
  netdJsonAsync,
  performHttpBatch,
  performHttpRequest,
  queryTrafficLive,
  resolveNetdBinaryPath,
  startNetdTunnel,
  startTrafficProxy,
  stopNetdTunnel,
  trafficRingSize,
} from "./index.js";

const TASK = "6460e5ec-1a8c-4b95-b4e3-d77a02c79680";

function proxyGet(port: number, url: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      { host: "127.0.0.1", port, method: "GET", path: url, headers: { host: new URL(url).host } },
      (res) => {
        res.resume();
        res.on("end", () => resolve(res.statusCode ?? 0));
      },
    );
    req.on("error", reject);
    req.end();
  });
}

test("performHttpBatch preserves order, enforces scope, and writes content-addressed blobs", async () => {
  const origin = createServer((req, res) => {
    res.sendDate = false;
    if (req.url === "/redir") {
      res.writeHead(302, { location: "http://blocked.invalid/escape" });
      res.end("redirect-body");
      return;
    }
    res.writeHead(200, { "content-type": "text/plain" });
    res.end(`batch:${req.url}`);
  });
  await new Promise<void>((resolve) => origin.listen(0, "127.0.0.1", () => resolve()));
  const addr = origin.address();
  if (!addr || typeof addr === "string") throw new Error("no port");
  const base = `http://127.0.0.1:${addr.port}`;
  const evDir = mkdtempSync(join(tmpdir(), "gy-batch-"));
  try {
    const items = [
      ...Array.from({ length: 10 }, (_, i) => ({ url: `${base}/p/${i}` })),
      { url: `${base}/redir` },
    ];
    const results = await performHttpBatch(items, {
      evidenceDir: evDir,
      concurrency: 8,
      authorizeHost: (h) => ({ allowed: h === "127.0.0.1" }),
      scope: { allowHosts: ["127.0.0.1"] },
    });
    assert.equal(results.length, 11);
    for (let i = 0; i < 10; i++) {
      const item = results[i]!;
      assert.equal(item.ok, true);
      if (item.ok) {
        assert.equal(item.result.artifact.status, 200);
        assert.equal(item.result.bodyHead, `batch:/p/${i}`);
        const resTxt = readFileSync(join(evDir, item.result.artifact.responsePath), "utf8");
        assert.match(resTxt, new RegExp(`batch:/p/${i}$`));
      }
    }
    const redir = results[10]!;
    assert.equal(redir.ok, true);
    if (redir.ok) {
      assert.equal(redir.result.artifact.status, 302);
      assert.equal(redir.result.artifact.blockedRedirect, "blocked.invalid");
    }

    // Direct Go sidecar single-hop redirect block check without fetch spy
    const direct = await performHttpRequest(
      { url: `${base}/redir` },
      { evidenceDir: evDir, authorizeHost: (h) => ({ allowed: h === "127.0.0.1" }) },
    );
    assert.equal(direct.artifact.status, 302);
    assert.equal(direct.artifact.blockedRedirect, "blocked.invalid");
  } finally {
    origin.close();
    rmSync(evDir, { recursive: true, force: true });
  }
});

test("gy-netd shares finding-window ring across multiple worker proxies for the same taskDir", async (t) => {
  if (!resolveNetdBinaryPath() || process.env.GY_EXEC_BACKEND === "ts") {
    t.skip("requires Go gy-netd backend");
    return;
  }
  const origin = createServer((req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ path: req.url }));
  });
  await new Promise<void>((resolve) => origin.listen(0, "127.0.0.1", () => resolve()));
  const addr = origin.address();
  if (!addr || typeof addr === "string") throw new Error("no port");
  const base = `http://127.0.0.1:${addr.port}`;
  const taskDir = mkdtempSync(join(tmpdir(), "gy-netd-shared-"));
  const p1 = await startTrafficProxy({ taskId: TASK, taskDir, workerId: "w1", mode: "finding-window" });
  const p2 = await startTrafficProxy({ taskId: TASK, taskDir, workerId: "w2", mode: "finding-window" });
  try {
    assert.notEqual(p1.port, p2.port);
    assert.equal(await proxyGet(p1.port, `${base}/from-w1`), 200);
    assert.equal(await proxyGet(p2.port, `${base}/from-w2`), 200);

    assert.equal(trafficRingSize(taskDir), 2);
    const live = queryTrafficLive(taskDir, { taskId: TASK });
    assert.equal(live.total, 2);
    assert.deepEqual(new Set(live.traffic.map((r) => r.workerId)), new Set(["w1", "w2"]));

    const health = await netdJsonAsync<{ ok: boolean; proxies: number }>("GET", "/v1/health");
    assert.equal(health.ok, true);
    assert.ok(health.proxies >= 2);
  } finally {
    await p1.close();
    await p2.close();
    clearTrafficRing(taskDir);
    origin.close();
    rmSync(taskDir, { recursive: true, force: true });
  }
});

test("gy-netd local tcp tunnel forwarder binds 127.0.0.1 and forwards traffic cleanly", async (t) => {
  if (!resolveNetdBinaryPath() || process.env.GY_EXEC_BACKEND === "ts") {
    t.skip("requires Go gy-netd backend");
    return;
  }
  const origin = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("go-tunnel-ok");
  });
  await new Promise<void>((resolve) => origin.listen(0, "127.0.0.1", () => resolve()));
  const addr = origin.address();
  if (!addr || typeof addr === "string") throw new Error("no port");

  const tun = await startNetdTunnel({
    kind: "tcp",
    targetHost: "127.0.0.1",
    targetPort: addr.port,
  });
  try {
    assert.ok(tun.localPort > 0);
    const active = await listNetdTunnels();
    assert.ok(active.some((item) => item.id === tun.id));
    const res = await fetch(`http://127.0.0.1:${tun.localPort}/`);
    assert.equal(res.status, 200);
    assert.equal(await res.text(), "go-tunnel-ok");
  } finally {
    assert.equal(await stopNetdTunnel(tun.id), true);
    origin.close();
  }
});

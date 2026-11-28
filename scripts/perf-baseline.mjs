import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { Agent, createServer, get } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";

const LOOPBACK = "127.0.0.1";
const TASK = "6460e5ec-1a8c-4b95-b4e3-d77a02c79680";
const KiB = 1024;
const small = 4 * KiB;
const large = 64 * KiB;

function quantile(sorted, p) {
  return sorted[Math.ceil(sorted.length * p) - 1];
}

function latencies(samples) {
  const sorted = samples.toSorted((a, b) => a - b);
  return {
    p50Ms: quantile(sorted, 0.5),
    p95Ms: quantile(sorted, 0.95),
    p99Ms: quantile(sorted, 0.99),
  };
}

async function measureRequests(requestCount, concurrency, run) {
  let next = 0;
  let failed = false;
  const samples = [];
  const initialRssBytes = process.memoryUsage.rss();
  let peakSampledRssBytes = initialRssBytes;
  const start = performance.now();
  const workers = await Promise.allSettled(Array.from({ length: concurrency }, async () => {
    while (!failed && next < requestCount) {
      const i = next++;
      const started = performance.now();
      try {
        await run(i);
      } catch (error) {
        failed = true;
        throw error;
      }
      samples.push(performance.now() - started);
      peakSampledRssBytes = Math.max(peakSampledRssBytes, process.memoryUsage.rss());
    }
  }));
  const totalMs = performance.now() - start;
  const rejected = workers.find((worker) => worker.status === "rejected");
  if (rejected) throw rejected.reason;
  return {
    requestCount, concurrency, totalMs, rps: requestCount * 1_000 / totalMs,
    ...latencies(samples), initialRssBytes, peakSampledRssBytes,
    finalRssBytes: process.memoryUsage.rss(),
  };
}

async function listenFixture() {
  const bodies = new Map([[small, Buffer.alloc(small, "x")], [large, Buffer.alloc(large, "x")]]);
  const server = createServer((req, res) => {
    const match = /^\/bench\/(\d+)\/\d+$/.exec(req.url ?? "");
    const body = match && bodies.get(Number(match[1]));
    if (!body || req.method !== "GET") {
      res.writeHead(404).end();
      return;
    }
    res.sendDate = false;
    res.writeHead(200, { "content-type": "text/plain", "content-length": body.length });
    res.end(body);
  });
  server.listen(0, LOOPBACK);
  await once(server, "listening");
  return server;
}

function requestThroughLocalProxy(agent, proxyPort, url, expectedBytes) {
  return new Promise((resolve, reject) => {
    const req = get({ hostname: LOOPBACK, port: proxyPort, agent, path: url.href, headers: { host: url.host } }, (res) => {
      let bytes = 0;
      res.on("data", (chunk) => { bytes += chunk.length; });
      res.on("error", reject);
      res.on("end", () => {
        if (res.statusCode !== 200 || bytes !== expectedBytes) {
          reject(new Error(`Loopback proxy returned status ${res.statusCode} and ${bytes} bytes, expected 200 and ${expectedBytes}`));
        } else {
          resolve();
        }
      });
    });
    req.setTimeout(5_000, () => req.destroy(new Error("Loopback proxy request timed out")));
    req.on("error", reject);
  });
}

function measureTls(ensureTaskCa, leafFor, dir) {
  const ca = ensureTaskCa(dir);
  const hostCount = 20;
  const samples = [];
  const start = performance.now();
  for (let i = 0; i < hostCount; i++) {
    const started = performance.now();
    leafFor(ca, `bench-${i}.invalid`);
    samples.push(performance.now() - started);
  }
  const totalMs = performance.now() - start;
  return { hostCount, totalMs, hostsPerSecond: hostCount * 1_000 / totalMs, ...latencies(samples) };
}

function measureHistory(HistoryStore, root) {
  const writeCount = 300;
  function trial(dir) {
    const store = new HistoryStore({ dbPath: join(dir, "history.sqlite"), evidenceDir: join(dir, "evidence") });
    const samples = [];
    try {
      const start = performance.now();
      for (let i = 0; i < writeCount; i++) {
        const started = performance.now();
        store.appendFact({ taskId: TASK, layer: "title", title: `Fixture fact ${i}`, summary: "Synthetic data" });
        samples.push(performance.now() - started);
      }
      const totalMs = performance.now() - start;
      assert.equal(store.listFacts(TASK).length, writeCount);
      return { totalMs, writesPerSecond: writeCount * 1_000 / totalMs, ...latencies(samples) };
    } finally {
      store.close();
    }
  }
  trial(join(root, "history-warmup"));
  const trials = Array.from({ length: 5 }, (_, i) => trial(join(root, `history-${i}`)));
  const medianTrial = trials.toSorted((a, b) => a.totalMs - b.totalMs)[Math.floor(trials.length / 2)];
  return { writeCount, medianTrial, trials };
}

async function runBackend(backend) {
  process.env.GY_EXEC_BACKEND = backend;
  const [traffic, { ensureTaskCa, leafFor }, { performHttpRequest, performHttpBatch }, netd, { HistoryStore }] = await Promise.all([
    import("../packages/exec/dist/traffic/index.js"),
    import("../packages/exec/dist/traffic/ca.js"),
    import("../packages/exec/dist/http.js"),
    import("../packages/exec/dist/netd-client.js"),
    import("../packages/history/dist/index.js"),
  ]);
  if (backend === "go" && !netd.resolveNetdBinaryPath() && !process.env.GY_NETD_SOCKET) {
    return { backend, status: "unavailable", reason: "bin/gy-netd not found; run pnpm build:netd first" };
  }
  const root = mkdtempSync(join(tmpdir(), "gy-perf-"));
  try {
    const history = measureHistory(HistoryStore, root);
    let tlsLeaf;
    if (backend === "go") {
      await netd.ensureNetdSocket();
      const tlsDir = join(root, "tls");
      const hostCount = 20;
      const samples = [];
      const start = performance.now();
      for (let i = 0; i < hostCount; i++) {
        const started = performance.now();
        await netd.netdJsonAsync("POST", "/v1/tls/leaf", { taskDir: tlsDir, host: `bench-${i}.invalid` });
        samples.push(performance.now() - started);
      }
      const totalMs = performance.now() - start;
      tlsLeaf = { hostCount, totalMs, hostsPerSecond: hostCount * 1_000 / totalMs, ...latencies(samples) };
    } else {
      tlsLeaf = measureTls(ensureTaskCa, leafFor, join(root, "tls"));
    }

    const origin = await listenFixture();
    try {
      const originUrl = `http://${LOOPBACK}:${origin.address().port}`;
      const fixtureUrl = (size, i) => new URL(`/bench/${size}/${i}`, originUrl);
      const concurrency = 16;
      const proxyCases = [];
      for (const [mode, bodyBytes, count] of [
        ["finding-window", small, 200], ["finding-window", large, 200],
        ["all", small, 200], ["all", large, 100],
      ]) {
        const taskDir = join(root, `proxy-${mode}-${bodyBytes}`);
        const proxy = await traffic.startTrafficProxy({ taskId: TASK, taskDir, mode });
        const agent = new Agent({ keepAlive: true, maxSockets: concurrency });
        try {
          const metrics = await measureRequests(count, concurrency, (i) =>
            requestThroughLocalProxy(agent, proxy.port, fixtureUrl(bodyBytes, i), bodyBytes));
          const retained = mode === "all" ? traffic.countTrafficExchanges(taskDir) : traffic.trafficRingSize(taskDir);
          const expected = mode === "all" ? count : Math.min(count, traffic.trafficWindowDefaults().ringMax);
          assert.equal(retained, expected, `unexpected retained exchange count for ${mode}`);
          proxyCases.push({ mode, bodyBytes, retained, ...metrics });
        } finally {
          agent.destroy();
          await proxy.close();
          traffic.clearTrafficRing(taskDir);
        }
      }

      const httpRequest = [];
      for (const [bodyBytes, count] of [[small, 200], [large, 100]]) {
        const evidenceDir = join(root, `http-${bodyBytes}`);
        const metrics = await measureRequests(count, concurrency, async (i) => {
          const result = await performHttpRequest({ url: fixtureUrl(bodyBytes, i).href, follow: false, timeoutMs: 5_000 }, {
            evidenceDir, authorizeHost: (host) => ({ allowed: host === LOOPBACK }),
          });
          assert.equal(result.artifact.status, 200, result.artifact.error);
          assert.equal(result.headers["content-length"], String(bodyBytes));
          assert.equal(result.artifact.truncated, false);
        });
        httpRequest.push({ bodyBytes, ...metrics });
      }

      const httpBatch = [];
      for (const [bodyBytes, count, batchConcurrency] of [[small, 200, 32], [large, 100, 32]]) {
        const evidenceDir = join(root, `http-batch-${bodyBytes}`);
        const items = Array.from({ length: count }, (_, i) => ({
          url: fixtureUrl(bodyBytes, i).href,
          follow: false,
          timeoutMs: 5_000,
        }));
        const start = performance.now();
        const res = await performHttpBatch(items, {
          evidenceDir,
          concurrency: batchConcurrency,
          authorizeHost: (host) => ({ allowed: host === LOOPBACK }),
          scope: { allowHosts: [LOOPBACK] },
        });
        const totalMs = performance.now() - start;
        assert.equal(res.length, count);
        for (const item of res) {
          assert.equal(item.ok, true);
          if (item.ok) assert.equal(item.result.artifact.status, 200);
        }
        httpBatch.push({
          bodyBytes,
          requestCount: count,
          concurrency: batchConcurrency,
          totalMs,
          rps: count * 1_000 / totalMs,
        });
      }

      let sidecarHealth = null;
      if (backend === "go") {
        sidecarHealth = await netd.netdJsonAsync("GET", "/v1/health");
      }

      return {
        backend, status: "ok",
        runtime: { platform: process.platform, arch: process.arch, node: process.version, sqlite: process.versions.sqlite },
        fixture: {
          origin: "loopback-http", uniqueRequestPaths: true, repeatedResponseBodyPerSize: true,
          rssScope: "Single Node process including fixture, sampled before and after each request. Go sidecar memory reported separately in sidecarHealth.",
        },
        ...(sidecarHealth ? { sidecarHealth } : {}),
        tlsLeaf, proxy: proxyCases, httpRequest, httpBatch, history,
      };
    } finally {
      await new Promise((resolve, reject) => {
        origin.close((error) => error ? reject(error) : resolve());
        origin.closeAllConnections();
      });
    }
  } finally {
    if (backend === "go") {
      await netd.shutdownLocalNetd().catch(() => {});
    }
    rmSync(root, { recursive: true, force: true });
  }
}

try {
  const { values: { backend } } = parseArgs({ options: { backend: { type: "string", default: "ts" } } });
  if (backend !== "ts" && backend !== "go") throw new Error("Usage: node scripts/perf-baseline.mjs --backend ts|go");
  // Do not let Node's opt-in environment proxy send the fixed fixture requests through a proxy.
  if (process.env.NODE_USE_ENV_PROXY === "1" || process.execArgv.includes("--use-env-proxy") ||
      /(?:^|\s)--use-env-proxy(?:\s|$)/.test(process.env.NODE_OPTIONS ?? "")) {
    throw new Error("Run the loopback fixture with Node environment proxying disabled");
  }
  const report = await runBackend(backend);
  console.log(JSON.stringify(report, null, 2));
  if (report.status !== "ok") process.exitCode = 2;
} catch (error) {
  console.error(error?.code === "ERR_MODULE_NOT_FOUND" ? `${error.message}\nBuild the workspace with pnpm -r run build first.` : error);
  process.exitCode = 1;
}

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
import { blobPath, getTraffic, queryTraffic, readBlobSlice, startTrafficProxy } from "./traffic/index.js";
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
  const proxy = await startTrafficProxy({ taskId: TASK, taskDir, workerId: "w0" });
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

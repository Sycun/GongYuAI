import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  brotliCompressSync,
  deflateRawSync,
  deflateSync,
  gzipSync,
  zstdCompressSync,
} from "node:zlib";
import {
  clearTrafficRing,
  decodeTrafficBody,
  promoteTrafficForFinding,
  queryTraffic,
  queryTrafficLive,
  readBlobSlice,
  readTrafficBody,
  readTrafficBodyLive,
  startTrafficProxy,
} from "./traffic/index.js";

const TASK = "6460e5ec-1a8c-4b95-b4e3-d77a02c79680";

function fetchViaProxy(
  proxyPort: number,
  url: string,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: Buffer }> {
  const target = new URL(url);
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        host: "127.0.0.1",
        port: proxyPort,
        method: "POST",
        path: url,
        headers: {
          host: target.host,
          "accept-encoding": "deflate, gzip, br, zstd",
          "content-type": "application/json",
          ...headers,
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks) }));
      },
    );
    req.on("error", reject);
    req.end('{"gremlin":"1+1"}');
  });
}

test("decodeTrafficBody handles gzip, deflate (zlib + raw), br, zstd, chained encodings, and fallbacks", () => {
  const plain = Buffer.from('{"status":200,"flag":"flag{gremlin-utf8-明文}"}', "utf8");

  for (const [enc, buf] of [
    ["gzip", gzipSync(plain)],
    ["x-gzip", gzipSync(plain)],
    ["deflate", deflateSync(plain)],
    ["deflate", deflateRawSync(plain)],
    ["br", brotliCompressSync(plain)],
    ["zstd", zstdCompressSync(plain)],
    ["deflate, gzip", gzipSync(deflateSync(plain))],
  ] as const) {
    const out = decodeTrafficBody(buf, { "Content-Encoding": enc });
    assert.ok(out, `expected ${enc} to decode`);
    assert.deepEqual(out.bytes, plain);
    assert.equal(out.partial, false);
  }

  // Truncated gzip stream recovers readable prefix instead of garbled binary.
  const longText = Buffer.from(JSON.stringify({ items: Array.from({ length: 400 }, (_, i) => `item-${i}`) }));
  const fullGz = gzipSync(longText);
  const truncatedGz = fullGz.subarray(0, Math.floor(fullGz.length * 0.6));
  const partial = decodeTrafficBody(truncatedGz, { "content-encoding": "gzip" });
  assert.ok(partial);
  assert.equal(partial.partial, true);
  assert.match(partial.bytes.toString("utf8"), /^\{"items":\["item-0"/);

  // Misleading Content-Encoding on plain text returns null so callers fall back safely.
  assert.equal(decodeTrafficBody(plain, { "content-encoding": "gzip" }), null);

  // Compression bomb exceeding maxOutputLength is rejected.
  const bigZeros = Buffer.alloc(64 * 1024, 0x41);
  const smallBomb = gzipSync(bigZeros);
  assert.equal(decodeTrafficBody(smallBomb, { "content-encoding": "gzip" }, 1024), null);
});

test("proxy preserves raw compressed blob sha256 while readTrafficBody/search return decoded UTF-8", async () => {
  const taskDir = mkdtempSync(join(tmpdir(), "gy-traffic-gz-"));
  const jsonBody = JSON.stringify({
    requestId: "b1f2-gremlin",
    result: { data: ["flag{compressed_gremlin_response_ok}"], pad: "x".repeat(400) },
  });
  const gzPayload = gzipSync(Buffer.from(jsonBody, "utf8"));
  const expectedWireSha = createHash("sha256").update(gzPayload).digest("hex");

  const origin = createServer((_req, res) => {
    res.writeHead(200, {
      "content-encoding": "gzip",
      "content-type": "application/json;charset=UTF-8",
      "content-length": String(gzPayload.length),
    });
    res.end(gzPayload);
  });
  await new Promise<void>((resolve) => origin.listen(0, "127.0.0.1", () => resolve()));
  const addr = origin.address();
  if (!addr || typeof addr === "string") throw new Error("no port");
  const url = `http://127.0.0.1:${addr.port}/gremlin`;

  // 1) All-mode persistence: preview search + sliced decoded read + untouched wire blob.
  const proxyAll = await startTrafficProxy({ taskId: TASK, taskDir, mode: "all" });
  try {
    const wire = await fetchViaProxy(proxyAll.port, url);
    assert.equal(wire.status, 200);
    assert.deepEqual(wire.body, gzPayload);

    const hits = queryTraffic(taskDir, { taskId: TASK, keyword: "compressed_gremlin_response_ok" });
    assert.equal(hits.traffic.length, 1);
    const rec = hits.traffic[0]!;
    assert.equal(rec.resBodyBlob?.sha256, expectedWireSha);
    assert.equal(rec.resBodyBlob?.size, gzPayload.length);

    // Raw blob on disk is still exact wire gzip bytes.
    assert.deepEqual(readBlobSlice(taskDir, expectedWireSha, 0, gzPayload.length).bytes, gzPayload);

    // Decoded read supports multi-slice pagination cleanly.
    const first = readTrafficBody(taskDir, rec.id, "res", 0, 120);
    assert.equal(first.sha256, expectedWireSha);
    assert.equal(first.rawSize, gzPayload.length);
    assert.equal(first.decodedEncoding, "gzip");
    assert.equal(first.size, Buffer.byteLength(jsonBody, "utf8"));
    assert.equal(first.nextOffset, 120);
    const rest = readTrafficBody(taskDir, rec.id, "res", first.nextOffset!, 2048);
    assert.equal(rest.nextOffset, null);
    assert.equal(first.body + rest.body, jsonBody);
  } finally {
    await proxyAll.close();
  }

  // 2) Finding-window live ring mode: hot search + live read + promote.
  const ringDir = mkdtempSync(join(tmpdir(), "gy-traffic-gz-ring-"));
  const proxyWin = await startTrafficProxy({ taskId: TASK, taskDir: ringDir, mode: "finding-window" });
  try {
    await fetchViaProxy(proxyWin.port, url);
    const liveHits = queryTrafficLive(ringDir, { taskId: TASK, keyword: "compressed_gremlin_response_ok" });
    assert.equal(liveHits.traffic.length, 1);
    const hotId = liveHits.traffic[0]!.id;

    const hotSlice = readTrafficBodyLive(ringDir, hotId, "res", 0, 8192);
    assert.equal(hotSlice.source, "ring");
    assert.equal(hotSlice.decodedEncoding, "gzip");
    assert.equal(hotSlice.rawSize, gzPayload.length);
    assert.equal(hotSlice.body, jsonBody);

    promoteTrafficForFinding(ringDir, {
      findingId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      trafficIds: [hotId],
    });
    const promotedSlice = readTrafficBodyLive(ringDir, hotId, "res", 0, 8192);
    assert.equal(promotedSlice.source, "store");
    assert.equal(promotedSlice.body, jsonBody);
  } finally {
    await proxyWin.close();
    clearTrafficRing(ringDir);
    rmSync(ringDir, { recursive: true, force: true });
    origin.close();
    rmSync(taskDir, { recursive: true, force: true });
  }
});

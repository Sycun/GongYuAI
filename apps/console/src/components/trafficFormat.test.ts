import test from "node:test";
import assert from "node:assert/strict";
import type { TrafficRecord } from "@gongyuai/contracts";
import {
  buildCurl, buildRawRequest, buildRawResponse, formatBodyProgress, formatBytes, formatDuration,
  httpStatusColor, matchKeyword, sliceLoadedBytes,
} from "./trafficFormat.js";

const record: TrafficRecord = {
  id: "2fac045e-3bdc-4efc-a2ba-ca177546875c",
  taskId: "6460e5ec-1a8c-4b95-b4e3-d77a02c79680",
  method: "POST",
  url: "https://app.example.com/login?next=/admin",
  host: "app.example.com",
  path: "/login?next=/admin",
  status: 200,
  durationMs: 1234,
  startedAt: "2026-11-24T01:00:00.000Z",
  reqHeaders: { "Content-Type": "application/x-www-form-urlencoded", Cookie: ["sid=abc", "theme=dark"] },
  resHeaders: { "Set-Cookie": "sid=xyz" },
};

test("Raw Request 补全 Host 头并拼接请求体", () => {
  const raw = buildRawRequest(record, "user=admin&pass=' OR 1=1--");
  assert.ok(raw.startsWith("POST /login?next=/admin HTTP/1.1\r\n"));
  assert.ok(raw.includes("Host: app.example.com"));
  assert.ok(raw.includes("Cookie: sid=abc, theme=dark"));
  assert.ok(raw.endsWith("\r\n\r\nuser=admin&pass=' OR 1=1--"));
});

test("Raw Response 以状态行开头并拼接响应体", () => {
  const raw = buildRawResponse(record, "<html>welcome</html>");
  assert.ok(raw.startsWith("HTTP/1.1 200\r\n"));
  assert.ok(raw.includes("Set-Cookie: sid=xyz"));
  assert.ok(raw.endsWith("<html>welcome</html>"));
});

test("复制 cURL：POST 带 --data-raw，单引号正确转义", () => {
  const curl = buildCurl(record, "pass=' OR 1=1--");
  assert.ok(curl.startsWith("curl -sS -X POST"));
  assert.ok(curl.includes("'https://app.example.com/login?next=/admin'"));
  assert.ok(curl.includes("--data-raw 'pass='\\'' OR 1=1--'"));
});

test("复制 cURL：GET 无请求体时省略 --data-raw", () => {
  const curl = buildCurl({ ...record, method: "GET" }, "");
  assert.ok(curl.startsWith("curl -sS '"));
  assert.equal(curl.includes("--data-raw"), false);
  assert.equal(curl.includes("-X"), false);
});

test("关键字大小写不敏感，匹配 URL 与头部", () => {
  assert.equal(matchKeyword(record, "ADMIN"), true);
  assert.equal(matchKeyword(record, "sid=abc"), true);
  assert.equal(matchKeyword(record, "not-present"), false);
  assert.equal(matchKeyword(record, "  "), true);
});

test("状态码色标与耗时/大小格式化", () => {
  assert.equal(httpStatusColor(200), "green");
  assert.equal(httpStatusColor(302), "blue");
  assert.equal(httpStatusColor(404), "orange");
  assert.equal(httpStatusColor(500), "red");
  assert.equal(httpStatusColor(0), "grey");
  assert.equal(formatDuration(1234), "1.23 s");
  assert.equal(formatDuration(80), "80 ms");
  assert.equal(formatBytes(2048), "2.0 KB");
  assert.equal(formatBytes(512), "512 B");
});

test("字节进度按服务端切片长度统计，不受 U+FFFD 膨胀影响，并标注压缩编码", () => {
  assert.equal(
    sliceLoadedBytes({ offset: 0, size: 160, byteLength: 160, nextOffset: null }),
    160,
  );
  assert.equal(
    sliceLoadedBytes({ offset: 8192, size: 20000, byteLength: 8192, nextOffset: 16384 }),
    16384,
  );
  assert.equal(
    formatBodyProgress({ loadedBytes: 215, size: 215, rawSize: 160, decodedEncoding: "gzip" }),
    "215 B / 215 B（gzip 解压，原始 160 B）",
  );
  assert.equal(
    formatBodyProgress({ loadedBytes: 249, size: 249 }),
    "249 B / 249 B",
  );
});
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  TrafficBlobSliceSchema,
  TrafficRecordSchema,
  TrafficSearchQuerySchema,
} from "./index.js";

const id = "2fac045e-3bdc-4efc-a2ba-ca177546875c";
const taskId = "6460e5ec-1a8c-4b95-b4e3-d77a02c79680";
const sha256 = "a".repeat(64);

test("TrafficRecord accepts metadata with or without body references", () => {
  const record = {
    id,
    taskId,
    method: "GET",
    url: "https://docs.example.com/index.html",
    host: "docs.example.com",
    path: "/index.html",
    status: 200,
    durationMs: 50,
    reqHeaders: { accept: "text/html" },
    resHeaders: { vary: ["Accept", "Accept-Encoding"] },
    startedAt: "2026-11-24T01:00:00.000Z",
  };
  assert.deepEqual(TrafficRecordSchema.parse(record), record);
  const resBodyBlob = { sha256, size: 2 * 1024 * 1024, contentType: "text/html" };
  assert.deepEqual(TrafficRecordSchema.parse({ ...record, resBodyBlob }).resBodyBlob, resBodyBlob);
  assert.equal(TrafficRecordSchema.safeParse({ ...record, resBodyBlob: { ...resBodyBlob, size: -1 } }).success, false);
});

test("traffic queries and blob ranges have finite defaults and reject invalid bounds", () => {
  assert.deepEqual(TrafficSearchQuerySchema.parse({ taskId }), { taskId, offset: 0, limit: 50 });
  assert.equal(TrafficSearchQuerySchema.safeParse({ taskId, limit: 201 }).success, false);

  assert.deepEqual(TrafficBlobSliceSchema.parse({ sha256 }), { sha256, offset: 0, maxBytes: 64 * 1024 });
  const range = { sha256, offset: 2 * 1024 * 1024, maxBytes: 1024 * 1024 };
  assert.deepEqual(TrafficBlobSliceSchema.parse(range), range);
  for (const invalid of [
    { offset: -1 },
    { offset: 1.5 },
    { maxBytes: 0 },
    { maxBytes: range.maxBytes + 1 },
    { sha256: "g".repeat(64) },
  ]) {
    assert.equal(TrafficBlobSliceSchema.safeParse({ ...range, ...invalid }).success, false);
  }
});

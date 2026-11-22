/**
 * 原始材料差异核算（验收项 2）的纯函数回归。
 *
 * 覆盖：CSV/JSON 解析与来源行号、新增/移除/变更/未变/缺件六类结论、
 * 约定检查项缺件、材料缺失时降级为未知、单值变化必须改变对应差异。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ReconcileRequestSchema,
  parseMaterial,
  reconcileMaterials,
  summarizeReconcile,
} from "./reconcile.js";

const BASELINE_CSV = [
  "host,role,version,tls",
  "app-a-1,web,1.4,required",
  "app-a-2,db,2.1,required",
  "app-a-3,cache,3.0,optional",
].join("\n");

const CURRENT_CSV = [
  "host,role,version,tls",
  "app-a-1,web,1.5,required",
  "app-a-2,db,2.1,required",
  "app-a-4,worker,1.0,required",
].join("\n");

function request(overrides: Record<string, unknown> = {}) {
  return ReconcileRequestSchema.parse({
    name: "baseline-diff",
    baseline: { path: "assets/baseline.csv" },
    current: { path: "assets/current.csv" },
    keyField: "host",
    ...overrides,
  });
}

test("CSV 差异：新增/移除/变更/未变四类可定位到来源行与字段", () => {
  const req = request();
  const baseline = parseMaterial({ path: req.baseline.path, content: BASELINE_CSV, keyField: req.keyField });
  const current = parseMaterial({ path: req.current.path, content: CURRENT_CSV, keyField: req.keyField });
  const result = reconcileMaterials({ request: req, baseline, current });

  assert.deepEqual(
    { added: result.counts.added, removed: result.counts.removed, changed: result.counts.changed, unchanged: result.counts.unchanged },
    { added: 1, removed: 1, changed: 1, unchanged: 1 },
  );
  const changed = result.items.find((item) => item.key === "app-a-1")!;
  assert.equal(changed.status, "changed");
  assert.equal(changed.baselineLine, 2, "基线第 2 行");
  assert.equal(changed.currentLine, 2, "当前第 2 行");
  assert.deepEqual(changed.changes, [{ field: "version", before: "1.4", after: "1.5" }]);

  const removed = result.items.find((item) => item.key === "app-a-3")!;
  assert.equal(removed.status, "removed");
  assert.equal(removed.baselineLine, 4);

  const added = result.items.find((item) => item.key === "app-a-4")!;
  assert.equal(added.status, "added");
  assert.equal(added.currentLine, 4);

  assert.match(summarizeReconcile(result), /新增 1、移除 1、变更 1、未变 1/);
});

test("只改一个值：对应项的差异随之变化，其余项不受影响", () => {
  const req = request({ compareFields: ["version"] });
  const baseline = parseMaterial({ path: req.baseline.path, content: BASELINE_CSV, keyField: req.keyField });
  const before = reconcileMaterials({
    request: req,
    baseline,
    current: parseMaterial({ path: req.current.path, content: CURRENT_CSV, keyField: req.keyField }),
  });
  const mutated = CURRENT_CSV.replace("app-a-2,db,2.1,required", "app-a-2,db,2.2,required");
  const after = reconcileMaterials({
    request: req,
    baseline,
    current: parseMaterial({ path: req.current.path, content: mutated, keyField: req.keyField }),
  });

  assert.equal(before.counts.changed, 1);
  assert.equal(after.counts.changed, 2);
  const item = after.items.find((entry) => entry.key === "app-a-2")!;
  assert.deepEqual(item.changes, [{ field: "version", before: "2.1", after: "2.2" }]);
  // 其他键的结论不因这一次改动而变化。
  assert.deepEqual(
    after.items.filter((entry) => entry.key !== "app-a-2").map((entry) => [entry.key, entry.status]),
    before.items.filter((entry) => entry.key !== "app-a-2").map((entry) => [entry.key, entry.status]),
  );
});

test("约定检查项：当前记录缺失时标为缺件，两侧都缺时也标缺件", () => {
  const req = request({ requiredKeys: ["app-a-4", "app-a-9"] });
  const result = reconcileMaterials({
    request: req,
    baseline: parseMaterial({ path: req.baseline.path, content: BASELINE_CSV, keyField: req.keyField }),
    current: parseMaterial({
      path: req.current.path,
      content: CURRENT_CSV.replace(",app-a-4,worker,1.0,required", "").replace("app-a-4,worker,1.0,required", ""),
      keyField: req.keyField,
    }),
  });
  const absent = result.items.find((item) => item.key === "app-a-4")!;
  assert.equal(absent.status, "missing");
  assert.equal(absent.reason, "required-key-absent-in-both");
  assert.equal(result.counts.missing, 2, "app-a-4 与 app-a-9 都缺件");
});

test("缺件材料：整份材料缺失时对应项降级为未知，并写明缺哪一侧", () => {
  const req = request({ requiredKeys: ["app-a-1"] });
  const current = parseMaterial({ path: req.current.path, content: CURRENT_CSV, keyField: req.keyField });
  const result = reconcileMaterials({ request: req, baseline: null, current });

  assert.deepEqual(result.missingMaterials, ["assets/baseline.csv"]);
  assert.equal(result.counts.unknown, result.counts.totalKeys);
  assert.ok(result.items.every((item) => item.status === "unknown" && item.reason === "baseline-material-missing"));
  assert.equal(result.baseline.format, null);
});

test("JSON 配置基线：对象映射与数组两种形状都能定位到键所在行", () => {
  const baselineJson = [
    "{",
    '  "tls.minVersion": {"value": "1.2", "owner": "platform"},',
    '  "session.timeout": {"value": "30", "owner": "app"}',
    "}",
  ].join("\n");
  const currentJson = [
    "[",
    '  {"id": "tls.minVersion", "value": "1.3", "owner": "platform"},',
    '  {"id": "session.timeout", "value": "30", "owner": "app"}',
    "]",
  ].join("\n");
  const req = ReconcileRequestSchema.parse({
    name: "config-diff",
    baseline: { path: "config/baseline.json" },
    current: { path: "config/current.json" },
    keyField: "id",
  });
  const result = reconcileMaterials({
    request: req,
    baseline: parseMaterial({ path: req.baseline.path, content: baselineJson, keyField: "id" }),
    current: parseMaterial({ path: req.current.path, content: currentJson, keyField: req.keyField }),
  });
  const changed = result.items.find((item) => item.key === "tls.minVersion")!;
  assert.equal(changed.status, "changed");
  assert.equal(changed.baselineLine, 2, "JSON 里键第一次出现的行");
  assert.equal(changed.currentLine, 2);
  assert.deepEqual(changed.changes, [{ field: "value", before: "1.2", after: "1.3" }]);
});

test("相同输入重复核算得到逐字节相同的结果（可独立复算）", () => {
  const req = request();
  const run = () => reconcileMaterials({
    request: req,
    baseline: parseMaterial({ path: req.baseline.path, content: BASELINE_CSV, keyField: req.keyField }),
    current: parseMaterial({ path: req.current.path, content: CURRENT_CSV, keyField: req.keyField }),
    baselineSha256: "a".repeat(64),
    currentSha256: "b".repeat(64),
  });
  assert.equal(JSON.stringify(run()), JSON.stringify(run()));
});

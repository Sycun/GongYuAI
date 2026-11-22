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

// ── 第七轮补充：物理行号、跨行引号字段、重复主键 ────────────────────────────

function diff(baselineCsv: string, currentCsv: string, overrides: Record<string, unknown> = {}) {
  const req = request(overrides);
  return reconcileMaterials({
    request: req,
    baseline: parseMaterial({ path: req.baseline.path, content: baselineCsv, keyField: req.keyField }),
    current: parseMaterial({ path: req.current.path, content: currentCsv, keyField: req.keyField }),
  });
}

test("来源行号是原文件物理行号：空行占行号，第 3 行的变化报第 3 行", () => {
  const baseline = "host,role,version\napp-a-1,web,1.4\n\napp-a-2,db,2.1\n";
  const current = "host,role,version\napp-a-1,web,1.5\n\napp-a-2,db,2.1\n";
  const result = diff(baseline, current);
  const changed = result.items.find((item) => item.key === "app-a-1")!;
  assert.equal(changed.baselineLine, 2, "第 2 行是 app-a-1");
  assert.equal(changed.currentLine, 2);
  const untouched = result.items.find((item) => item.key === "app-a-2")!;
  assert.equal(untouched.baselineLine, 4, "空行在物理第 3 行，app-a-2 在第 4 行");
  assert.equal(untouched.currentLine, 4);

  // 首行表头 + 一个空行 + 数据 → 数据在第 3 行（旧实现会报第 2 行）。
  const withBlankAtTop = "host,role,version\n\napp-a-1,web,1.4\n";
  const parsed = parseMaterial({ path: "b.csv", content: withBlankAtTop, keyField: "host" });
  assert.equal(parsed.rows[0]!.line, 3);
});

test("CRLF 与引号内逗号：行号不偏移，字段不被切碎", () => {
  const baseline = 'host,role,note\r\napp-a-1,web,"dc-1, rack-7"\r\napp-a-2,db,plain\r\n';
  const current = 'host,role,note\r\napp-a-1,web,"dc-1, rack-8"\r\napp-a-2,db,plain\r\n';
  const result = diff(baseline, current);
  const changed = result.items.find((item) => item.key === "app-a-1")!;
  assert.equal(changed.baselineLine, 2);
  assert.equal(changed.currentLine, 2);
  assert.deepEqual(changed.changes, [
    { field: "note", before: "dc-1, rack-7", after: "dc-1, rack-8" },
  ]);
});

test("引号内换行：起止行区间被记录，结论仍按字段比对", () => {
  const baseline = 'host,note\napp-a-1,"line-1\nline-2"\napp-a-2,ok\n';
  const current = 'host,note\napp-a-1,"line-1\nline-3"\napp-a-2,ok\n';
  const parsed = parseMaterial({ path: "b.csv", content: baseline, keyField: "host" });
  assert.equal(parsed.rows[0]!.line, 2, "跨行字段起始行");
  assert.equal(parsed.rows[0]!.endLine, 3, "跨行字段结束行");
  assert.equal(parsed.rows[1]!.line, 4, "下一条记录仍在物理第 4 行");

  const result = diff(baseline, current);
  const changed = result.items.find((item) => item.key === "app-a-1")!;
  assert.equal(changed.status, "changed");
  assert.equal(changed.baselineLine, 2);
  assert.equal(changed.baselineEndLine, 3);
  assert.equal(changed.changes[0]!.field, "note");
});

test("引号未闭合：明确拒绝，不给出行号猜测", () => {
  assert.throws(
    () => parseMaterial({ path: "b.csv", content: 'host,note\napp-a-1,"unterminated\n', keyField: "host" }),
    /引号未闭合/,
  );
});

test("基线侧重复主键且内容冲突：标为歧义并列出全部来源行，不报未变", () => {
  const baseline = "host,version\ntest-A,1\ntest-A,2\n";
  const current = "host,version\ntest-A,2\n";
  const result = diff(baseline, current);
  const item = result.items.find((entry) => entry.key === "test-A")!;
  assert.equal(item.status, "ambiguous", "冲突重复键不得给出确定结论");
  assert.notEqual(item.status, "unchanged");
  assert.match(String(item.reason), /duplicate-key-conflict/);
  assert.deepEqual(item.duplicates?.map((entry) => [entry.material, entry.line]), [["baseline", 2], ["baseline", 3]],
    "只列重复出现的那一侧");
  assert.equal(result.counts.ambiguous, 1);
  assert.equal(result.counts.unchanged, 0);
  // 材料摘要里也写明重复来源行。
  assert.deepEqual(result.baseline.duplicateKeys, [{ key: "test-A", lines: [2, 3], identical: false }]);
  assert.match(summarizeReconcile(result), /歧义 1/);
});

test("当前侧重复主键冲突：同样标为歧义；两侧都冲突只报一次", () => {
  const baseline = "host,version\ntest-A,1\n";
  const current = "host,version\ntest-A,1\ntest-A,9\n";
  const oneSide = diff(baseline, current);
  assert.equal(oneSide.items.find((entry) => entry.key === "test-A")!.status, "ambiguous");

  const both = diff("host,version\ntest-A,1\ntest-A,2\n", "host,version\ntest-A,1\ntest-A,9\n");
  const item = both.items.find((entry) => entry.key === "test-A")!;
  assert.equal(item.status, "ambiguous");
  assert.equal(both.counts.ambiguous, 1, "同一键只记一次");
  assert.equal(item.duplicates?.length, 4, "两侧各两行全部列出");
});

test("重复主键但内容完全相同：收敛为一行，行号取首次出现，规则可测", () => {
  const baseline = "host,version\ntest-A,1\ntest-A,1\ntest-B,7\n";
  const current = "host,version\ntest-A,2\ntest-B,7\n";
  const result = diff(baseline, current);
  const item = result.items.find((entry) => entry.key === "test-A")!;
  assert.equal(item.status, "changed", "内容相同的重复行不改变结论");
  assert.equal(item.baselineLine, 2, "取首次出现的行号");
  assert.deepEqual(item.duplicates?.map((entry) => entry.line), [2, 3]);
  assert.deepEqual(result.baseline.duplicateKeys, [{ key: "test-A", lines: [2, 3], identical: true }]);
  assert.equal(result.counts.ambiguous, 0);
  assert.equal(result.counts.totalKeys, 2);
});

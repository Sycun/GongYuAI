import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  AuthorizationLedgerSchema,
  CreateTaskRequestSchema,
  authorizationStatus,
  targetAllows,
} from "@gongyuai/contracts";
import { ControlStore } from "./store.js";
import {
  authorizationDigest,
  currentRecord,
  ledgerPath,
  normalizeTargetToken,
  parseCapabilityValue,
  parseScopeMessage,
  readLedger,
  splitTargets,
} from "./authorization.js";

function fixture(root: string) {
  const store = new ControlStore(root);
  const task = store.createTask(CreateTaskRequestSchema.parse({
    name: "任务坐标测试",
    auth: { targets: ["local:submitted-materials"] },
    goals: [{ id: "deliver", title: "提交任务结果", description: "坐标", evidencePatterns: ["task-result.md"] }],
  }));
  return { store, task };
}

test("parseScopeMessage：JSON、逐字段中文、一句话口语；能力词不当主机", () => {
  const json = parseScopeMessage(JSON.stringify({ targets: ["10.0.0.0/8"], capability: "scan", outOfScope: ["10.0.0.9"] }));
  assert.deepEqual(json.targets, ["10.0.0.0/8"]);
  assert.deepEqual(json.outOfScope, ["10.0.0.9"]);
  assert.equal(json.capability, "scan");

  const labeled = parseScopeMessage("目标: 10.0.0.0/8、*.example.com / 能力: active-lab / 排除: 10.0.0.9");
  assert.deepEqual(labeled.targets, ["10.0.0.0/8", "*.example.com"]);
  assert.deepEqual(labeled.outOfScope, ["10.0.0.9"]);
  assert.equal(labeled.capability, "active-lab");

  const prose = parseScopeMessage("已授权 10.0.0.0/8 与 *.example.com，可做 active-lab");
  assert.deepEqual(prose.targets, ["10.0.0.0/8", "*.example.com"]);
  assert.equal(prose.capability, "active-lab");

  // 续接消息里的口语形态：目标是 127.0.0.1，"继续" 不能当目标。
  const verbal = parseScopeMessage("已授权 127.0.0.1，继续");
  assert.deepEqual(verbal.targets, ["127.0.0.1"]);
  assert.equal(verbal.targets.includes("active-lab"), false);

  // 坐标澄清答复：目标/能力档位。
  const clarify = parseScopeMessage("目标: 192.0.2.9，继续");
  assert.deepEqual(clarify.targets, ["192.0.2.9"]);
  const gear = parseScopeMessage("能力: full，继续");
  assert.equal(gear.capability, "full");
  assert.deepEqual(gear.targets, []);

  // 纯「继续」不产生坐标。
  assert.deepEqual(parseScopeMessage("继续").targets, []);
  assert.equal(parseScopeMessage("继续").capability, null);
});

test("坐标解析助手：能力别名、目标形状、CJK 过滤", () => {
  assert.equal(parseCapabilityValue("完全"), "full");
  assert.equal(parseCapabilityValue("只读"), "observe");
  assert.equal(parseCapabilityValue("扫描"), "scan");
  assert.equal(parseCapabilityValue("active-lab"), "active-lab");
  assert.equal(parseCapabilityValue("不是档位"), null);
  assert.equal(normalizeTargetToken("10.0.0.0/8"), "10.0.0.0/8");
  assert.equal(normalizeTargetToken("*.example.com"), "*.example.com");
  assert.equal(normalizeTargetToken("继续"), null);
  assert.equal(normalizeTargetToken("full"), null);
  assert.deepEqual(splitTargets("a.example.com、b.example.com 与 c.example.com"), ["a.example.com", "b.example.com", "c.example.com"]);
});

test("旧授权台账只读兼容：可回查、不阻塞新任务；损坏回落投影", t => {
  const root = mkdtempSync(join(tmpdir(), "gy-authorization-readonly-"));
  const { store, task } = fixture(root);
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });

  // 新任务无台账：currentRecord 为 null，digest 为未登记占位。
  assert.equal(currentRecord(task), null);
  assert.match(authorizationDigest(task), /^v0\/未登记/);

  // 历史任务封存的台账：只读回查（不再写入）。
  const ledger = AuthorizationLedgerSchema.parse({
    taskId: task.id,
    current: 2,
    records: [
      { version: 1, issuedBy: "张三", issuedAt: "2026-01-01T00:00:00.000Z", targets: ["10.0.0.0/8"], capability: "scan", evidence: null },
      { version: 2, issuedBy: "李四", issuedAt: "2026-02-01T00:00:00.000Z", targets: ["127.0.0.1"], capability: "full", evidence: null },
    ],
  });
  mkdirSync(join(task.dataDir, "authorization"), { recursive: true });
  writeFileSync(ledgerPath(task), JSON.stringify(ledger, null, 2), { mode: 0o600 });

  const read = readLedger(task);
  assert.equal(read.records.length, 2);
  assert.equal(currentRecord(task)?.version, 2);
  assert.match(authorizationDigest(task), /^v2\/李四\/127\.0\.0\.1\/full\/生效中$/);

  // 过期记录状态只读可判，不再裁决执行。
  const expired = { ...read.records[1]!, version: 9, validUntil: "2020-01-01T00:00:00.000Z" };
  const status = authorizationStatus(expired);
  assert.equal(status.active, false);

  // 坐标判定仍按 task.auth（操作配置），与旧台账无关。
  assert.equal(targetAllows(["10.0.0.0/8"], "10.1.2.3", ["10.0.0.9"]), true);
  assert.equal(targetAllows(["10.0.0.0/8"], "10.0.0.9", ["10.0.0.9"]), false);

  // 台账损坏：currentRecord 回落 task.authorization 投影，不抛、不阻塞。
  writeFileSync(ledgerPath(task), "{ not json", { mode: 0o600 });
  assert.throws(() => readLedger(task), /无法解析/);
  task.authorization = ledger.records[0]!;
  assert.equal(currentRecord(task)?.version, 1);
});
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  AuthorizationRecordSchema,
  CreateTaskRequestSchema,
  authorizationStatus,
  targetAllows,
} from "@gongyuai/contracts";
import { ControlStore } from "./store.js";
import {
  authorizationDigest,
  currentRecord,
  ledgerPath,
  parseAuthorizationText,
  readLedger,
  registerAuthorization,
} from "./authorization.js";

function fixture(root: string) {
  const store = new ControlStore(root);
  const task = store.createTask(CreateTaskRequestSchema.parse({
    name: "授权台账测试",
    auth: { capability: "observe", authorizationNote: "工作区任务，限提交的材料和本地只读检查", targets: ["local:submitted-materials"] },
    goals: [{ id: "deliver", title: "提交任务结果", description: "台账", evidencePatterns: ["task-result.md"] }],
  }));
  return { store, task };
}

test("解析三种授权形态：JSON、逐字段文本、一句话口语", () => {
  const json = parseAuthorizationText(JSON.stringify({
    targets: ["10.0.0.0/8"], issuedBy: "张三", capability: "scan",
    issuedAt: "2026-01-01T00:00:00.000Z", validUntil: "2026-12-31",
  }));
  assert.deepEqual(json.input.targets, ["10.0.0.0/8"]);
  assert.equal(json.input.issuedBy, "张三");
  assert.equal(json.input.capability, "scan");
  assert.deepEqual(json.missing, []);
  assert.ok(json.input.raw, "JSON 原文要能封存");

  const labeled = parseAuthorizationText(
    "授权人: 张三 / 目标: 10.0.0.0/8、*.example.com / 能力: active-lab / 有效期至: 2026-12-31 / 排除: 10.0.0.9",
  );
  assert.equal(labeled.input.issuedBy, "张三");
  assert.deepEqual(labeled.input.targets, ["10.0.0.0/8", "*.example.com"]);
  assert.deepEqual(labeled.input.outOfScope, ["10.0.0.9"]);
  assert.equal(labeled.input.capability, "active-lab");
  assert.equal(labeled.input.validUntil, "2026-12-31");

  const prose = parseAuthorizationText("已授权 10.0.0.0/8 与 *.example.com，可做 active-lab");
  assert.deepEqual(prose.input.targets, ["10.0.0.0/8", "*.example.com"]);
  assert.equal(prose.input.capability, "active-lab");

  // 续接消息里的口语形态：目标是 127.0.0.1，"继续" 不能当目标。
  const verbal = parseAuthorizationText("已授权 127.0.0.1，继续");
  assert.deepEqual(verbal.input.targets, ["127.0.0.1"]);
  assert.equal(verbal.input.capability, "active-lab");

  // 能力词不能被当作主机（"可做 active-lab"）。
  assert.equal(verbal.input.targets.includes("active-lab"), false);

  const missing = parseAuthorizationText("授权人: 张三 / 能力: scan");
  assert.deepEqual(missing.missing, ["targets"]);
});

test("登记授权：原件封存、sha256/bytes/excerpt、台账 0600、task.auth 投影与越界/过期状态", t => {
  const root = mkdtempSync(join(tmpdir(), "gy-authorization-"));
  const { store, task } = fixture(root);
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });

  const source = [
    "授权人: 张三",
    "目标: 10.0.0.0/8、*.example.com",
    "能力: active-lab",
    "有效期至: 2026-12-31",
    "排除: 10.0.0.9",
  ].join("\n");
  const record = registerAuthorization(task, { text: source }, { save: saved => store.save(saved) });

  assert.equal(record.version, 1);
  assert.equal(record.issuedBy, "张三");
  assert.equal(record.capability, "active-lab");
  assert.equal(record.validUntil, "2026-12-31T23:59:59.999Z");
  assert.deepEqual(record.outOfScope, ["10.0.0.9"]);

  // 原件封存 + 哈希自证
  assert.ok(record.evidence);
  assert.equal(record.evidence!.path, "authorization/v1-source.md");
  assert.equal(record.evidence!.sha256, createHash("sha256").update(source, "utf8").digest("hex"));
  assert.equal(record.evidence!.bytes, Buffer.byteLength(source, "utf8"));
  assert.ok(record.evidence!.excerpt.length <= 500);
  assert.ok(source.startsWith(record.evidence!.excerpt));
  const sealedPath = join(task.dataDir, "evidence", "authorization", "v1-source.md");
  assert.ok(existsSync(sealedPath), "原件必须落到 evidence/authorization/v1-source.md");
  assert.equal(readFileSync(sealedPath, "utf8"), source);

  // 台账 0600
  const ledgerStat = statSync(ledgerPath(task));
  assert.equal(ledgerStat.mode & 0o777, 0o600);

  // task.auth 投影 + scopeVersion
  const saved = store.get(task.id)!;
  assert.deepEqual(saved.auth.targets, ["10.0.0.0/8", "*.example.com"]);
  assert.deepEqual(saved.auth.outOfScope, ["10.0.0.9"]);
  assert.equal(saved.auth.capability, "active-lab");
  assert.match(saved.auth.authorizationNote, /张三/);
  assert.equal(saved.scopeVersion, 2);
  assert.equal(saved.authorization?.version, 1);
  assert.equal(currentRecord(saved)?.version, 1);

  // 越界判定：排除项优先于授权范围
  assert.equal(targetAllows(saved.auth.targets, "10.0.0.9", saved.auth.outOfScope), false);
  assert.equal(targetAllows(saved.auth.targets, "10.1.2.3", saved.auth.outOfScope), true);
  assert.equal(targetAllows(saved.auth.targets, "a.example.com", saved.auth.outOfScope), true);

  // 过期记录：状态为未生效，不能当作授权在用
  const expired = AuthorizationRecordSchema.parse({
    ...record, version: 9, validUntil: "2020-01-01T00:00:00.000Z", evidence: null,
  });
  const status = authorizationStatus(expired);
  assert.equal(status.active, false);
  assert.match(status.active ? "" : status.reason, /失效/);

  // 第二版：结构化对象（无原文 → evidence 必须为 null，不伪造）
  const second = registerAuthorization(task, { targets: ["127.0.0.1"], capability: "scan" }, { save: next => store.save(next) });
  assert.equal(second.version, 2);
  assert.equal(second.evidence, null);
  assert.equal(second.issuedBy, "操作员（会话内声明）");
  assert.equal(second.source, "api");
  const ledger = readLedger(task);
  assert.equal(ledger.records.length, 2);
  assert.equal(ledger.current, 2);
  assert.equal(store.get(task.id)!.authorization?.version, 2);
  assert.match(authorizationDigest(store.get(task.id)!), /^v2\/操作员（会话内声明）\/127\.0\.0\.1\/scan\/生效中$/);

  // 缺 targets：报错并给出缺项，不写台账
  assert.throws(
    () => registerAuthorization(task, "授权人: 张三", { save: next => store.save(next) }),
    /授权目标为空/,
  );
  assert.equal(readLedger(task).records.length, 2);
});

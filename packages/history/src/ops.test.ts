import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { openHistory } from "./index.js";
import { rollbackScript } from "@gongyuai/contracts";

function tempStore() {
  const dir = mkdtempSync(join(tmpdir(), "gy-ops-"));
  const history = openHistory({ dbPath: join(dir, "history.sqlite"), evidenceDir: join(dir, "evidence") });
  return { dir, history };
}

const TASK = "11111111-1111-4111-8111-111111111111";
const ENG = "eng-ops-test";
const scope = { taskId: TASK, engagementId: ENG, scopeVersion: 1 };

test("作业登记：输入版本、进度、范围版本落库可查", () => {
  const { history } = tempStore();
  const job = history.ops.submitJob(scope, {
    kind: "material-check",
    label: "核查两份清单",
    submittedBy: "op-a",
    inputs: [
      { path: "materials/baseline.csv", sha256: "a".repeat(64) },
      { path: "materials/current.csv", sha256: "b".repeat(64) },
    ],
    options: { keyField: "host" },
  }, "2026-11-22T00:00:00.000Z");
  assert.equal(job.status, "queued");
  assert.equal(job.scopeVersion, 1);
  assert.equal(job.inputs.length, 2);
  const listed = history.ops.listJobs(TASK);
  assert.equal(listed.length, 1);
  assert.equal(listed[0]!.progress.total, 2);
  history.close();
});

test("作业完成：范围已收缩时标迟到结果但仍保留", () => {
  const { history } = tempStore();
  const job = history.ops.submitJob(scope, {
    kind: "material-check",
    label: "核查",
    submittedBy: "op-a",
    inputs: [{ path: "materials/current.csv", sha256: "c".repeat(64) }],
    options: {},
  }, "2026-11-22T00:00:00.000Z");
  history.ops.startJob(TASK, job.id, "boot-1", "2026-11-22T00:00:01.000Z");
  const done = history.ops.finishJob(TASK, job.id, {
    status: "succeeded",
    artifacts: [{ path: "reconcile/diff.json", sha256: "d".repeat(64) }],
    result: { counts: { changed: 1 } },
    scopeVersion: 2,
    nowIso: "2026-11-22T00:00:02.000Z",
  });
  assert.equal(done?.status, "succeeded");
  assert.equal(done?.lateResult, true);
  assert.equal(done?.artifacts[0]!.path, "reconcile/diff.json");
  const events = history.listEvents(TASK).map((event) => event.kind);
  assert.ok(events.includes("job_finished"));
  assert.ok(events.includes("job_late_result"));
  history.close();
});

test("回执幂等：同一 deliveryKey 重复投递只记一次", () => {
  const { history } = tempStore();
  const job = history.ops.submitJob(scope, {
    kind: "evidence-pack",
    label: "打包",
    submittedBy: "op-a",
    inputs: [{ path: "evidence/a.txt", sha256: "e".repeat(64) }],
    options: {},
  }, "2026-11-22T00:00:00.000Z");
  history.ops.startJob(TASK, job.id, "boot-1", "2026-11-22T00:00:01.000Z");
  history.ops.finishJob(TASK, job.id, { status: "succeeded", scopeVersion: 1, nowIso: "2026-11-22T00:00:02.000Z" });
  const first = history.ops.ackJob(TASK, job.id, { deliveryKey: "k1", deliveredBy: "op-b", note: "" }, "2026-11-22T00:00:03.000Z");
  const second = history.ops.ackJob(TASK, job.id, { deliveryKey: "k1", deliveredBy: "op-b", note: "" }, "2026-11-22T00:00:04.000Z");
  assert.equal(first.duplicate, false);
  assert.equal(second.duplicate, true);
  assert.equal(history.ops.listReceipts(TASK, job.id).length, 1);
  assert.equal(history.listEvents(TASK).filter((event) => event.kind === "job_delivered").length, 1);
  history.close();
});

test("暂停三态：执行中标 draining，未开始标 stopped，重启后 running 标 unknown", () => {
  const { history } = tempStore();
  const running = history.ops.submitJob(scope, { kind: "material-check", label: "a", submittedBy: "op", inputs: [{ path: "a.csv", sha256: null }], options: {} }, "2026-11-22T00:00:00.000Z");
  const queued = history.ops.submitJob(scope, { kind: "material-check", label: "b", submittedBy: "op", inputs: [{ path: "b.csv", sha256: null }], options: {} }, "2026-11-22T00:00:00.000Z");
  history.ops.startJob(TASK, running.id, "boot-1", "2026-11-22T00:00:01.000Z");
  const paused = history.ops.pauseJobs(TASK, new Set([running.id]), "2026-11-22T00:00:02.000Z");
  const byId = new Map(paused.map((job) => [job.id, job]));
  assert.equal(byId.get(running.id)?.status, "draining");
  assert.equal(byId.get(running.id)?.pauseState, "draining");
  assert.equal(byId.get(queued.id)?.status, "paused");
  assert.equal(byId.get(queued.id)?.pauseState, "stopped");

  // 模拟另一个控制面进程在 running 状态下崩溃：boot-2 对账后变 unknown。
  const other = history.ops.submitJob(scope, { kind: "material-check", label: "c", submittedBy: "op", inputs: [{ path: "c.csv", sha256: null }], options: {} }, "2026-11-22T00:00:00.000Z");
  history.ops.startJob(TASK, other.id, "boot-1", "2026-11-22T00:00:01.000Z");
  const reconciled = history.ops.reconcileJobsAfterBoot(TASK, "boot-2", "2026-11-22T00:00:05.000Z");
  assert.equal(reconciled.find((job) => job.id === other.id)?.status, "unknown");
  assert.equal(reconciled.find((job) => job.id === other.id)?.pauseState, "unknown");
  history.close();
});

test("人工求助：24h 只转非阻塞，问题仍待明确答复", () => {
  const { history } = tempStore();
  const created = history.ops.createConsult(scope, {
    question: "生产环境是否允许继续验证 SQL 注入?",
    options: ["允许", "停止"],
    context: "需要客户确认",
    blocking: true,
    askedBy: "agent",
  }, Date.parse("2026-11-22T00:00:00.000Z"));
  assert.equal(created.dueAt, "2026-11-23T00:00:00.000Z");

  const before = history.ops.sweepConsults(TASK, Date.parse("2026-11-22T23:59:59.000Z"));
  assert.equal(before.length, 0);

  const after = history.ops.sweepConsults(TASK, Date.parse("2026-11-23T00:00:01.000Z"));
  assert.equal(after.length, 1);
  assert.equal(after[0]!.blocking, false);
  assert.equal(after[0]!.status, "open");
  assert.equal(after[0]!.releasedAt, "2026-11-23T00:00:01.000Z");
  assert.equal(history.listEvents(TASK).filter((event) => event.kind === "consult_released").length, 1);

  const answered = history.ops.answerConsult(TASK, created.id, { answer: "允许", answeredBy: "客户A", injectHint: true }, Date.parse("2026-11-23T01:00:00.000Z"));
  assert.equal(answered.status, "answered");
  assert.equal(answered.answer, "允许");
  assert.throws(() => history.ops.answerConsult(TASK, created.id, { answer: "再答", answeredBy: "客户A", injectHint: true }, Date.now()), /consult-not-open/);
  history.close();
});

test("材料台账：不支持/归属不明/过期/accepted 分别表达并留痕", () => {
  const { history, dir } = tempStore();
  const base = {
    taskId: TASK,
    engagementId: ENG,
    source: "operator-import",
    importedAt: "2026-11-22T00:00:00.000Z",
    observedAt: "2026-11-21T00:00:00.000Z",
    locator: "line=1",
    sensitivity: "redacted" as const,
    secretRef: null,
    scopeVersion: 1,
  };
  history.ops.recordMaterial({ ...base, id: "22222222-2222-4222-8222-222222222222", kind: "asset-inventory", status: "accepted", parser: { name: "csv", version: "1" }, asset: "app-a-1.example.com", materialPath: "materials/baseline.csv", sha256: "1".repeat(64), reason: null });
  history.ops.recordMaterial({ ...base, id: "33333333-3333-4333-8333-333333333333", kind: null, status: "unsupported", parser: null, asset: null, materialPath: "materials/weird.bin", sha256: "2".repeat(64), reason: "unrecognized-material-format" });
  history.ops.recordMaterial({ ...base, id: "44444444-4444-4444-8444-444444444444", kind: "http-transaction", status: "expired", parser: { name: "http", version: "1" }, asset: "app-a-1.example.com", materialPath: "http/tx.txt", sha256: "3".repeat(64), reason: "material-older-than-7d" });
  const listed = history.ops.listMaterials(TASK);
  assert.equal(listed.length, 3);
  assert.equal(listed.find((entry) => entry.status === "unsupported")?.kind, null);
  assert.equal(listed.find((entry) => entry.status === "expired")?.reason, "material-older-than-7d");
  assert.ok(dir.length > 0);
  history.close();
});

test("变更台账：逆序回滚脚本 + 确认人可回查", () => {
  const { history } = tempStore();
  const first = history.ops.recordChange(scope, {
    kind: "account",
    asset: "app-a-1.example.com",
    location: "local user gy-test",
    rollbackCmd: "userdel gy-test",
    registeredBy: "op-a",
    note: "临时账号",
  }, null, "2026-11-22T00:00:00.000Z", []);
  const second = history.ops.recordChange(scope, {
    kind: "webshell",
    asset: "app-a-1.example.com",
    location: "/uploads/a.jsp",
    rollbackCmd: "rm -f /uploads/a.jsp",
    registeredBy: "op-a",
    note: "验证用",
  }, "f".repeat(64), "2026-11-22T00:01:00.000Z", [{ path: "evidence/before.txt", sha256: "9".repeat(64) }]);
  const script = rollbackScript(history.ops.listChanges(TASK));
  assert.ok(script.indexOf("rm -f /uploads/a.jsp") < script.indexOf("userdel gy-test"));
  const confirmed = history.ops.confirmChange(TASK, first.id, "reviewer-b", "2026-11-22T02:00:00.000Z");
  assert.equal(confirmed?.confirmedBy, "reviewer-b");
  assert.equal(history.ops.listChanges(TASK).find((entry) => entry.id === second.id)?.beforeSha256, "f".repeat(64));
  history.close();
});

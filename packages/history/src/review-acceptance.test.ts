import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { AuthScopeSchema, goalsFromSpecs } from "@gongyuai/contracts";
import { openHistory, writeEvidenceFile, writeTaskReport } from "./index.js";

test("offline reader recovers the early receipt, distinguishes the correction and identifies the unsupported goal", (t) => {
  const parent = process.env.GY_REVIEW_OUTPUT ?? tmpdir();
  mkdirSync(parent, { recursive: true });
  const dataDir = mkdtempSync(join(parent, "gy-review-"));
  const paths = { dbPath: join(dataDir, "history.sqlite"), evidenceDir: join(dataDir, "evidence") };
  const taskId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const auth = AuthScopeSchema.parse({ targets: ["inventory.invalid"], authorizationNote: "离线合成台账复核" });
  let history = openHistory(paths);
  t.after(() => {
    history.close();
    if (!process.env.GY_REVIEW_OUTPUT) rmSync(dataDir, { recursive: true, force: true });
  });

  const receipt = "archive/receipt.json";
  const original = JSON.stringify({ asset: "B", receipt: "R-017" });
  history.seedGoals(taskId, goalsFromSpecs([
    { id: "ownership", title: "核对收件归属", description: "原始 R-017 收件凭据应指向资产 B。",
      evidencePatterns: [receipt], evidenceChecks: [{ pattern: receipt, field: "asset", equals: "B" }] },
    { id: "signature", title: "核对签收人", description: "取得经过确认的签收记录。",
      evidencePatterns: ["signoff.json"], evidenceChecks: [{ pattern: "signoff.json", field: "signed", equals: true }] },
  ]));
  writeEvidenceFile(paths.evidenceDir, receipt, original);
  const early = history.appendFact({ taskId, layer: "title", title: "早期收件凭据 R-017", evidencePath: receipt });
  assert.equal(history.assertGoal(taskId, "ownership", [receipt]).ok, true);
  const old = history.appendFact({ taskId, layer: "summary", title: "原判断：材料属于资产 A" });
  const reason = history.proposeIntent({ taskId, title: "整理台账", sourceFactIds: [old.id] });
  history.appendFact({ taskId, layer: "summary", title: "沿用旧归属的汇总", intentId: reason.id });
  const fixed = history.appendFact({ taskId, layer: "summary", title: "更正：材料属于资产 B" });
  const signed = { goalId: "ownership", reviewer: "离线复核员", evidencePath: receipt };
  history.appendReview(taskId, { ...signed, factId: early.id, decision: "confirmed", reason: "已核对原始凭据编号。" });
  const correction = { ...signed, factId: old.id, decision: "retracted" as const, replacementFactId: fixed.id, reason: "原判断误读归属栏。" };
  const first = history.appendReview(taskId, correction);
  assert.equal(history.appendReview(taskId, correction).id, first.id);
  history.appendReview(taskId, { ...signed, factId: fixed.id, decision: "confirmed", reason: "与原始凭据归属栏一致。" });

  for (let i = 0; i < 52; i++) {
    history.appendFact({ taskId, layer: i % 2 ? "summary" : "title", title: `整理批次 ${i}` });
  }
  for (let i = 0; i < 26; i++) history.appendFact({ taskId, layer: "title", title: `归档批次 ${i}` });
  assert.doesNotMatch(history.overview(taskId), /早期收件凭据 R-017|原判断：材料属于资产 A/);
  writeEvidenceFile(paths.evidenceDir, "signoff.json", '{"signed":false}');
  assert.equal(history.assertGoal(taskId, "signature", ["signoff.json"]).ok, false);
  writeEvidenceFile(paths.evidenceDir, receipt, '{"asset":"C","receipt":"later"}');
  history.close();
  history = openHistory(paths);
  const path = writeTaskReport({ taskId, dataDir, auth }, history, { status: "incomplete" });

  // The reader gets only report.md and its linked attachments.
  const report = readFileSync(path, "utf8");
  const sections = report.split(/^### /m);
  const ownership = sections.find((s) => s.startsWith("核对收件归属"))!;
  const signature = sections.find((s) => s.startsWith("核对签收人"))!;
  const attachment = /断言时证据：[^\n]*\]\((report-evidence\/([0-9a-f]{64}))\)/u.exec(ownership);
  assert.ok(attachment);
  const bytes = readFileSync(join(dataDir, attachment[1]!));
  assert.equal(bytes.toString(), original);
  assert.equal(createHash("sha256").update(bytes).digest("hex"), attachment[2]);
  assert.match(ownership, /已复核\*\* 早期收件凭据 R-017/);
  assert.match(ownership, /已撤回\*\* 原判断：材料属于资产 A/);
  assert.match(ownership, /已复核\*\* 更正：材料属于资产 B/);
  assert.match(ownership, /依据已撤回，待复核\*\* 沿用旧归属的汇总/);
  assert.match(signature.split("\n")[0]!, /未验证/);
  assert.match(signature, /signoff\.json/);
  assert.doesNotMatch(signature, /断言时证据/);
  assert.equal(history.readProofVersion("another-task", attachment[2]!), undefined);
  t.diagnostic("读者验收 3/3：早期原版可定位且哈希一致；撤回与更正可区分；缺签收的目标仍未验证。");
  if (process.env.GY_REVIEW_OUTPUT) t.diagnostic(`报告：${path}`);
});

test("legacy assertions retain unknown evidence versions; evidence remains byte-exact for new assertions", (t) => {
  const dataDir = mkdtempSync(join(tmpdir(), "gy-review-legacy-"));
  const evidenceDir = join(dataDir, "evidence");
  const history = openHistory({ dbPath: join(dataDir, "history.sqlite"), evidenceDir });
  t.after(() => { history.close(); rmSync(dataDir, { recursive: true, force: true }); });
  const taskId = "legacy";
  const [goal] = goalsFromSpecs([{ id: "old", title: "旧记录", description: "过去的证明", evidencePatterns: ["old.txt"] }]);
  history.seedGoals(taskId, [{ ...goal!, passes: true, evidencePaths: ["old.txt"] }]);
  writeEvidenceFile(evidenceDir, "old.txt", "today's bytes");
  const auth = AuthScopeSchema.parse({ targets: ["archive.invalid"], authorizationNote: "离线合成历史台账复核" });
  const path = writeTaskReport({ taskId, dataDir, auth }, history, { status: "completed" });
  assert.match(readFileSync(path, "utf8"), /历史通过，原版证据未留存/);
  assert.equal(history.listGoalProofs(taskId).length, 0);
  const [binary] = goalsFromSpecs([{ id: "binary", title: "原始字节", description: "二进制附件", evidencePatterns: ["item.bin"] }]);
  history.seedGoals(taskId, [binary!]);
  const bytes = Buffer.from([0, 255, 128, 10, 23]);
  writeFileSync(join(evidenceDir, "item.bin"), bytes);
  assert.equal(history.assertGoal(taskId, "binary", ["item.bin"]).ok, true);
  const [proof] = history.listGoalProofs(taskId);
  assert.deepEqual(history.readProofVersion(taskId, proof!.sha256), bytes);
});

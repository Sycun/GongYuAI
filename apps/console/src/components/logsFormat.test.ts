import test from "node:test";
import assert from "node:assert/strict";
import { classifyLine, filterLogLines, highlightSegments, splitLogSlots } from "./logsFormat.js";

test("日志级别分类：错误/警告/进度/其他", () => {
  assert.equal(classifyLine("2026-11-24 ERROR 连接失败"), "error");
  assert.equal(classifyLine("WARNING 重试第 2 次"), "warn");
  assert.equal(classifyLine("2026-11-24 16:27 第 10 步 · 工具 shell"), "progress");
  assert.equal(classifyLine("普通信息行"), "other");
});

test("按 worker-wN.log 分段；共享日志不分段", () => {
  const text = "===== worker-w0.log =====\nline-a\n===== worker-w1.log =====\nline-b\n";
  const sections = splitLogSlots(text);
  assert.deepEqual(sections.map((s) => s.slot), ["worker-w0.log", "worker-w1.log"]);
  assert.ok(sections[0].text.includes("line-a"));
  assert.ok(sections[1].text.includes("line-b"));
  const shared = splitLogSlots("plain shared log\nline-x");
  assert.deepEqual(shared.map((s) => s.slot), [null]);
});

test("过滤组合：级别 + 关键字 + 节点", () => {
  const text = "===== worker-w0.log =====\nERROR 注入失败\nINFO 第 1 步\n===== worker-w1.log =====\nERROR 超时\n";
  const errors = filterLogLines(text, { level: "error" });
  assert.deepEqual(errors.map((l) => l.text), ["ERROR 注入失败", "ERROR 超时"]);
  const slot0 = filterLogLines(text, { slot: "worker-w0.log" });
  assert.deepEqual(slot0.map((l) => l.text), ["ERROR 注入失败", "INFO 第 1 步"]);
  const keyword = filterLogLines(text, { keyword: "超时" });
  assert.deepEqual(keyword.map((l) => l.text), ["ERROR 超时"]);
});

test("关键字高亮分段大小写不敏感", () => {
  const segments = highlightSegments("ERROR 注入失败 error", "error");
  assert.deepEqual(segments.filter((s) => s.hit).map((s) => s.text), ["ERROR", "error"]);
  assert.equal(segments.map((s) => s.text).join(""), "ERROR 注入失败 error");
  assert.deepEqual(highlightSegments("no keyword", ""), [{ text: "no keyword", hit: false }]);
});
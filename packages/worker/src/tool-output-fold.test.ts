import assert from "node:assert/strict";
import { test } from "node:test";
import { smartTruncateToolOutput } from "./tool-catalog.js";
import { foldRepetitiveToolNoise } from "./tool-output.js";

test("foldRepetitiveToolNoise strips ANSI, progress bars and carriage-return redraws", () => {
  const raw = [
    "\u001b[32m[*] starting scan\u001b[0m",
    "Progress: [=====>    ] 12%",
    "Progress: [========> ] 67%",
    "\rProgress: 900 / 1000 (90.00%)",
    "[####################] 100%",
    "rate: 1234.00-kpps, 0.01% done, 1:02:03 remaining",
    "Discovered open port 22/tcp on 10.0.0.5",
  ].join("\n");
  const folded = foldRepetitiveToolNoise(raw);
  assert.ok(!folded.includes("\u001b"), "ANSI 控制序列必须剥离");
  assert.ok(folded.includes("starting scan"));
  assert.ok(folded.includes("Discovered open port 22/tcp on 10.0.0.5"));
  assert.ok(!folded.includes("Progress:"), "进度刷屏行必须移除");
  assert.ok(!folded.includes("[####################]"), "纯进度条必须移除");
  assert.ok(!folded.includes("rate: 1234.00-kpps"));
  assert.ok(!folded.includes("900 / 1000"), "回车覆盖的进度片段必须丢弃");
});

test("foldRepetitiveToolNoise folds >=4 identical or timestamp-only/sequence-only lines", () => {
  const identical = [
    "[*] probing /admin (waiting for response)",
    ...Array.from({ length: 6 }, () => "[*] probing /admin (waiting for response)"),
    "[+] found /admin -> 200",
  ].join("\n");
  const foldedIdentical = foldRepetitiveToolNoise(identical);
  assert.match(foldedIdentical, /\[已折叠 5 行重复扫描输出\]/);
  assert.ok(foldedIdentical.includes("[+] found /admin -> 200"));

  const withTimestamps = [
    "2026-11-28T10:00:01.000Z connection reset by peer",
    "2026-11-28T10:00:02.000Z connection reset by peer",
    "2026-11-28T10:00:03.000Z connection reset by peer",
    "2026-11-28T10:00:04.000Z connection reset by peer",
    "2026-11-28T10:00:05.000Z connection reset by peer",
  ].join("\n");
  const foldedTimestamps = foldRepetitiveToolNoise(withTimestamps);
  assert.match(foldedTimestamps, /\[已折叠 3 行重复扫描输出\]/);
  assert.equal(
    foldedTimestamps.split("\n").filter((line) => line.includes("connection reset")).length,
    2,
    "首尾行保留，中间折叠",
  );

  const withCounters = [
    "[1] retrying upstream",
    "[2] retrying upstream",
    "[3] retrying upstream",
    "[4] retrying upstream",
    "[5] retrying upstream",
  ].join("\n");
  assert.match(foldRepetitiveToolNoise(withCounters), /\[已折叠 3 行重复扫描输出\]/);

  // 只有 3 行重复时不折叠。
  const three = ["same line", "same line", "same line"].join("\n");
  assert.equal(foldRepetitiveToolNoise(three), three);
});

test("smartTruncateToolOutput folds noise before the character budget so real hits survive", () => {
  const noise = Array.from({ length: 900 }, () => "Progress: [=====>    ] 42%").join("\n");
  const vital = "[open] 10.0.0.5:445/tcp open microsoft-ds\n[hit] /admin -> 200 len=1024";
  const text = `${noise}\n${vital}`;
  assert.ok(text.length > 12_000);
  const out = smartTruncateToolOutput(text, 12_000);
  assert.ok(out.includes("10.0.0.5:445/tcp open"), "折叠后关键命中不得被截断丢出");
  assert.ok(out.includes("/admin -> 200"));
  assert.ok(!out.includes("Progress:"));
  assert.ok(!out.includes("已省略中间"), "折叠后总量应落入预算，无需再截断");
});
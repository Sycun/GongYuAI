import test from "node:test";
import assert from "node:assert/strict";
import { extractHeadings, highlightTokens } from "./reportFormat.js";

test("目录提取跳过代码块内的伪标题，id 唯一", () => {
  const md = [
    "# 渗透测试报告",
    "## 概述",
    "```bash",
    "# 这不是标题",
    "curl https://app.example.com",
    "```",
    "### 高危发现",
    "## 概述",
  ].join("\n");
  const headings = extractHeadings(md);
  assert.deepEqual(headings.map((h) => h.text), ["渗透测试报告", "概述", "高危发现", "概述"]);
  assert.deepEqual(headings.map((h) => h.level), [1, 2, 3, 2]);
  assert.equal(new Set(headings.map((h) => h.id)).size, headings.length);
});

test("代码着色区分注释/字符串/数字/关键字", () => {
  const tokens = highlightTokens("curl -sS 'https://x' # 注释\nstatus=200", "bash");
  const types = tokens.map((t) => t.type);
  assert.ok(types.includes("keyword"));
  assert.ok(types.includes("string"));
  assert.ok(types.includes("comment"));
  assert.ok(types.includes("number"));
  assert.equal(tokens.map((t) => t.text).join(""), "curl -sS 'https://x' # 注释\nstatus=200");
  assert.equal(tokens.find((t) => t.type === "keyword")?.text, "curl");
});

test("HTTP 报文关键字着色", () => {
  const tokens = highlightTokens("GET /admin HTTP/1.1", "http");
  assert.equal(tokens.find((t) => t.text === "GET")?.type, "keyword");
});
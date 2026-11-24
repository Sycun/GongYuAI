import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { ChatMarkdown } from "./ChatMarkdown";

test("renders the headings, table, emphasis and list in a saved task message", () => {
  const text = "# 核对结果\n\n| 状态 | 说明 |\n| --- | --- |\n| **完成** | `ok` |\n\n1. 复核记录\n2. 归档";
  const html = renderToStaticMarkup(<ChatMarkdown text={text} />);
  for (const expected of ["<h1>核对结果</h1>", "<th>状态</th>", "<strong>完成</strong>", "<code>ok</code>", "<ol>", "<li>归档</li>"]) {
    assert.ok(html.includes(expected), expected);
  }
});

test("preserves literal HTML as text and describes images without loading them", () => {
  const html = renderToStaticMarkup(<ChatMarkdown text={'<button>示例</button>\n\n![示意图](https://example.invalid/chart.png)'} />);
  assert.match(html, /&lt;button&gt;示例&lt;\/button&gt;/);
  assert.match(html, /示意图/);
  assert.doesNotMatch(html, /<img|<button/);
});

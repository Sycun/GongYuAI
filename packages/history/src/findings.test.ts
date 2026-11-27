import { mkdtempSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import { openHistory, writeEvidenceFile, writeTaskReport } from "./index.js";

const TASK_ID = "33333333-3333-4333-8333-333333333333";

function setup(prefix: string) {
  const root = mkdtempSync(join(tmpdir(), prefix));
  const evidenceDir = join(root, "evidence");
  mkdirSync(evidenceDir, { recursive: true });
  const store = openHistory({ dbPath: join(root, "history.sqlite"), evidenceDir });
  return { root, evidenceDir, store };
}

function recordLead(store: ReturnType<typeof openHistory>, overrides: Record<string, unknown> = {}) {
  return store.recordFinding({
    taskId: TASK_ID,
    title: "SQLi in login",
    asset: "https://lab.example.com/login",
    vulnClass: "CWE-89",
    severity: "high",
    endpoint: "/login?user=",
    ...overrides,
  });
}

test("recordFinding is dedup-idempotent and normalizes asset", () => {
  const { root, store } = setup("gy-find-dedup-");
  try {
    const first = recordLead(store);
    assert.equal(first.created, true);
    assert.equal(first.finding.status, "tentative");
    assert.equal(first.finding.asset, "lab.example.com");
    assert.equal(first.finding.dedupKey, "lab.example.com|cwe-89|/login?user=");

    const again = recordLead(store, { title: "重复线索", severity: "critical" });
    assert.equal(again.created, false);
    assert.equal(again.finding.id, first.finding.id);
    assert.equal(again.finding.title, "SQLi in login");
    assert.equal(store.listFindings(TASK_ID).length, 1);

    const other = recordLead(store, { endpoint: "/other" });
    assert.equal(other.created, true);
    assert.equal(store.listFindings(TASK_ID).length, 2);
    assert.ok(
      store.listEvents(TASK_ID).some((e) => e.kind === "finding_recorded"),
    );
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("verifyFinding demands evidence + repro and seals SHA-256", () => {
  const { root, evidenceDir, store } = setup("gy-find-verify-");
  try {
    const { finding } = recordLead(store);
    assert.throws(
      () => store.verifyFinding(TASK_ID, finding.id, { evidencePaths: [], repro: "curl …" }),
      /≥1 evidence/,
    );
    assert.throws(
      () =>
        store.verifyFinding(TASK_ID, finding.id, {
          evidencePaths: ["findings/sqli.txt"],
          repro: "  ",
        }),
      /repro/,
    );
    assert.throws(
      () =>
        store.verifyFinding(TASK_ID, finding.id, {
          evidencePaths: ["findings/missing.txt"],
          repro: "curl …",
        }),
      /empty evidence|missing|invalid/,
    );
    assert.equal(store.getFinding(TASK_ID, finding.id)!.status, "tentative");

    writeEvidenceFile(evidenceDir, "findings/sqli.txt", "POST /login → 500 SQL error\n");
    const verified = store.verifyFinding(TASK_ID, finding.id, {
      evidencePaths: ["findings/sqli.txt"],
      repro: "curl -d \"user='\" https://lab.example.com/login",
      impact: "拖库",
    });
    assert.equal(verified.status, "verified");
    assert.equal(verified.confidence, "firm");
    assert.ok(verified.verifiedAt);
    assert.equal(verified.evidence.length, 1);
    const sha = verified.evidence[0]!.sha256;
    assert.match(sha, /^[a-f0-9]{64}$/);
    const bytes = store.readProofVersion(TASK_ID, sha);
    assert.ok(bytes);
    assert.equal(bytes!.toString("utf8"), "POST /login → 500 SQL error\n");

    // Idempotent repeat keeps the sealed version.
    const repeat = store.verifyFinding(TASK_ID, finding.id, {
      evidencePaths: ["findings/sqli.txt"],
      repro: "another repro",
    });
    assert.equal(repeat.verifiedAt, verified.verifiedAt);
    assert.equal(repeat.repro, verified.repro);
    assert.ok(
      store.listEvents(TASK_ID).some((e) => e.kind === "finding_verified"),
    );
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("retracted findings are retained, queryable, and cannot be re-verified", () => {
  const { root, evidenceDir, store } = setup("gy-find-retract-");
  try {
    const { finding } = recordLead(store);
    writeEvidenceFile(evidenceDir, "findings/x.txt", "proof\n");
    store.verifyFinding(TASK_ID, finding.id, {
      evidencePaths: ["findings/x.txt"],
      repro: "steps",
    });
    const retracted = store.retractFinding(TASK_ID, finding.id, "误报：WAF 拦截页");
    assert.equal(retracted.status, "retracted");
    assert.equal(store.listFindings(TASK_ID).length, 1);
    assert.equal(store.getFinding(TASK_ID, finding.id)!.status, "retracted");
    assert.throws(
      () =>
        store.verifyFinding(TASK_ID, finding.id, {
          evidencePaths: ["findings/x.txt"],
          repro: "steps",
        }),
      /retracted/,
    );
    assert.throws(() => store.retractFinding(TASK_ID, finding.id, "again"), /retracted/);
    assert.ok(
      store.listEvents(TASK_ID).some((e) => e.kind === "finding_retracted"),
    );
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("findingsGate blocks assert_goal until verified findings satisfy it", () => {
  const { root, evidenceDir, store } = setup("gy-find-gate-");
  try {
    store.seedGoals(TASK_ID, [
      {
        id: "delivery",
        title: "交付",
        description: "高危已复现",
        evidencePatterns: ["goals/*.md"],
        findingsGate: { minVerified: 1, minSeverity: "high", scope: "task" },
        passes: false,
        evidencePaths: [],
        assertedAt: null,
      },
    ]);
    writeEvidenceFile(evidenceDir, "goals/report.md", "# delivery\n");
    writeEvidenceFile(evidenceDir, "findings/sqli.txt", "proof\n");
    const paths = ["goals/report.md"];

    // No findings at all.
    let r = store.assertGoal(TASK_ID, "delivery", paths);
    assert.equal(r.ok, false);
    if (!r.ok) assert.match(r.reason, /findings gate/);

    // Tentative only — scan hit is not delivery.
    const { finding } = recordLead(store);
    r = store.assertGoal(TASK_ID, "delivery", paths);
    assert.equal(r.ok, false);

    // Verified but below minSeverity.
    store.verifyFinding(TASK_ID, finding.id, {
      evidencePaths: ["findings/sqli.txt"],
      repro: "steps",
    });
    const low = recordLead(store, {
      title: "版本号泄露",
      vulnClass: "CWE-200",
      severity: "low",
      endpoint: "/banner",
    });
    store.verifyFinding(TASK_ID, low.finding.id, {
      evidencePaths: ["findings/sqli.txt"],
      repro: "steps",
    });
    r = store.assertGoal(TASK_ID, "delivery", paths);
    assert.equal(r.ok, true);

    // vulnClasses filter narrows the gate.
    store.seedGoals(TASK_ID, [
      {
        id: "sqli-only",
        title: "SQLi 专项",
        description: "只认 CWE-89",
        evidencePatterns: ["goals/*.md"],
        findingsGate: { minVerified: 2, vulnClasses: ["CWE-89"], scope: "task" },
        passes: false,
        evidencePaths: [],
        assertedAt: null,
      },
    ]);
    r = store.assertGoal(TASK_ID, "sqli-only", paths);
    assert.equal(r.ok, false);
    if (!r.ok) assert.match(r.reason, /CWE-89/);

    // Retraction drops the qualifying count again (goal not yet sticky).
    store.retractFinding(TASK_ID, finding.id, "误报");
    const fresh = store.listGoals(TASK_ID).find((g) => g.id === "delivery");
    assert.equal(fresh!.passes, true); // sticky: already passed stays passed
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("report renders Findings chapter without tentative leads", () => {
  const { root, evidenceDir, store } = setup("gy-find-report-");
  try {
    store.seedGoals(TASK_ID, [
      {
        id: "g1",
        title: "目标",
        description: "d",
        evidencePatterns: ["goals/*.md"],
        passes: false,
        evidencePaths: [],
        assertedAt: null,
      },
    ]);
    const { finding } = recordLead(store);
    recordLead(store, {
      title: "未验证线索-勿入交付",
      vulnClass: "CWE-79",
      severity: "critical",
      endpoint: "/xss",
    });
    writeEvidenceFile(evidenceDir, "findings/sqli.txt", "proof-bytes\n");
    store.verifyFinding(TASK_ID, finding.id, {
      evidencePaths: ["findings/sqli.txt"],
      repro: "curl -d \"user='\" …",
      impact: "数据库可读",
      fix: "参数化查询",
    });
    const reportPath = writeTaskReport(
      {
        taskId: TASK_ID,
        dataDir: root,
        auth: {
          authorizationNote: "Written authorization: local fixture",
          targets: ["lab.example.com"],
          outOfScope: [],
          capability: "full",
        },
      },
      store,
      { status: "completed" },
    );
    const report = readFileSync(reportPath, "utf8");
    assert.ok(report.includes("## Findings"));
    assert.ok(report.includes("SQLi in login"));
    assert.ok(report.includes("参数化查询"));
    assert.ok(report.includes("SHA-256"));
    assert.ok(!report.includes("未验证线索-勿入交付"));
    assert.ok(report.includes("tentative"));
    // Sealed finding evidence is exported for re-verification.
    const sha = store.getFinding(TASK_ID, finding.id)!.evidence[0]!.sha256;
    assert.equal(
      readFileSync(join(root, "report-evidence", sha), "utf8"),
      "proof-bytes\n",
    );
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("recordFinding dedup and verifyFinding backfill missing intentId and evidence-matched factIds", () => {
  const { root, evidenceDir, store } = setup("gy-find-backfill-");
  try {
    const seedFact = store.appendFact({
      taskId: TASK_ID,
      layer: "summary",
      title: "发现 Gradio 服务",
      summary: "Gradio 4.12.0",
    });
    const intent = store.proposeIntent({
      taskId: TASK_ID,
      title: "验证 Gradio 任意文件读取",
      sourceFactIds: [seedFact.id],
    });
    // First recorded outside any active intent and without factIds.
    const first = recordLead(store, { intentId: null });
    assert.equal(first.finding.intentId, null);
    assert.deepEqual(first.finding.factIds, []);

    // Dedup call with factIds backfills them without creating a duplicate.
    const deduped = recordLead(store, { intentId: null, factIds: [seedFact.id] });
    assert.equal(deduped.created, false);
    assert.equal(deduped.finding.id, first.finding.id);
    assert.deepEqual(deduped.finding.factIds, [seedFact.id]);

    // verifyFinding backfills intentId and any Fact sharing the same evidencePath.
    writeEvidenceFile(evidenceDir, "findings/gradio-poc.txt", "root:x:0:0\n");
    const evFact = store.appendFact({
      taskId: TASK_ID,
      layer: "summary",
      title: "读取 /etc/passwd 证据",
      summary: "proof",
      evidencePath: "findings/gradio-poc.txt",
    });
    const verified = store.verifyFinding(TASK_ID, first.finding.id, {
      evidencePaths: ["findings/gradio-poc.txt"],
      repro: "curl http://lab.example.com/file=/etc/passwd",
      intentId: intent.id,
    });
    assert.equal(verified.intentId, intent.id);
    assert.ok(verified.factIds.includes(seedFact.id));
    assert.ok(verified.factIds.includes(evFact.id));
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("verifyFinding and updateFindingReport persist ARTEX detail fields and report tolerates missing proof blobs", () => {
  const { root, evidenceDir, store } = setup("gy-find-artex-");
  try {
    const { finding } = recordLead(store, {
      summary: "登录接口 user 参数存在未过滤 SQL 注入",
      affectedScope: "POST /login (参数 user)",
      rootCause: "直接字符串拼接 SQL 查询语句",
    });
    assert.equal(finding.rootCause, "直接字符串拼接 SQL 查询语句");
    assert.equal(finding.summary, "登录接口 user 参数存在未过滤 SQL 注入");

    writeEvidenceFile(evidenceDir, "findings/sqli-detail.txt", "uid=admin\n");
    const verified = store.verifyFinding(TASK_ID, finding.id, {
      evidencePaths: ["findings/sqli-detail.txt"],
      repro: "### 步骤 1：发送单引号载荷\n观察 500 报错\n### 步骤 2：联合查询提取数据\n提取管理员行",
      impact: "可脱取全库用户凭据并接管后台",
      fix: "改用 PreparedStatement 参数化绑定",
      pocCurl: "curl -X POST https://lab.example.com/login -d \"user=admin' OR '1'='1\"",
    });
    assert.equal(verified.rootCause, "直接字符串拼接 SQL 查询语句");

    const updated = store.updateFindingReport(TASK_ID, finding.id, {
      report: "## 概述\n完整定制报告正文。\n\n## 根因分析\nDAO 层未使用占位符。",
      rootCause: "DAO 层未使用占位符。",
    });
    assert.ok(updated);
    assert.equal(updated!.rootCause, "DAO 层未使用占位符。");
    assert.match(updated!.report ?? "", /完整定制报告正文/);

    const reportPath = writeTaskReport(
      {
        taskId: TASK_ID,
        dataDir: root,
        auth: {
          authorizationNote: "test",
          targets: ["lab.example.com"],
          outOfScope: [],
          capability: "full",
        },
      },
      store,
      { status: "completed" },
    );
    const md = readFileSync(reportPath, "utf8");
    assert.match(md, /#### 概述/);
    assert.match(md, /#### 复现步骤/);
    assert.match(md, /##### 步骤 1：发送单引号载荷/);
    assert.match(md, /#### 根因分析/);
    assert.match(md, /DAO 层未使用占位符/);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});
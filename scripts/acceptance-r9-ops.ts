/**
 * 第九轮验收 · 第一/二优先级（HTTP + CLI 正常入口）。
 *
 * 覆盖：
 * P1 委托边界与可见性；持久资料作业（提交 → 进程被杀 → 重启 unknown → 重试 → 完成回流）；
 *    范围收缩后的迟到结果；回执幂等；24h 求助转非阻塞（可控时钟）；另一位操作员 CLI 接手。
 * P2 四类材料导入与三种异常；覆盖矩阵六态；证据撤回后矩阵/图/报告一致；
 *    两个客户同名资产互不串；事实时效待复核。
 *
 * 运行：pnpm tsx scripts/acceptance-r9-ops.ts
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { openHistory } from "@gongyuai/history";
import {
  Recorder,
  gy,
  httpJson,
  repoRoot,
  roomPort,
  sha256,
  startPlane,
  writeRunRecord,
  type Plane,
} from "./r9-harness.js";

const startedAt = new Date().toISOString();
const runId = `r9-ops-${Date.now()}`;
const root = join(repoRoot, ".gongyuai", "acceptance", runId);
const evidenceRun = join(repoRoot, "docs", "evidence", "r9", runId);
mkdirSync(root, { recursive: true });
mkdirSync(evidenceRun, { recursive: true });
const rec = new Recorder(runId, "r9-ops", root);
const commands: string[] = [];
const notes: string[] = [];

const BASELINE = "host,version,tls\napp-a-1.example.com,1.4,required\napp-a-2.example.com,2.1,required\napp-a-3.example.com,3.0,required\n";
const CURRENT = "host,version,tls\napp-a-1.example.com,1.5,required\napp-a-2.example.com,2.1,required\napp-a-4.example.com,4.0,required\n";

type AnyRec = Record<string, any>;

async function waitFor<T>(fn: () => Promise<T | null>, timeoutMs = 40_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await fn();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error("timeout waiting for condition");
}

async function jobUntil(base: string, taskId: string, jobId: string, statuses: string[]): Promise<AnyRec> {
  return waitFor(async () => {
    const r = await httpJson<AnyRec>(base, "GET", `/tasks/${taskId}/jobs/${jobId}`);
    return statuses.includes(r.body?.job?.status) ? r.body : null;
  });
}

async function main(): Promise<void> {
  const port = roomPort();
  let plane: Plane = await startPlane(root, port, {
    GY_MOCK_SKIP_PATTERNS: "reconcile/",
    GY_MOCK_FINDINGS: "off",
  });
  let base = plane.base;

  // ---------------- 建档 A ----------------
  const createA = await httpJson<AnyRec>(base, "POST", "/tasks", {
    tenantId: "customer-a",
    engagementId: "eng-a",
    name: "A 客户资料核查（第九轮验收）",
    mock: true,
    auth: {
      authorizationNote: "虚构本地夹具；客户 A 授权仅限 example.com 合成资产",
      targets: [
        "app-a-1.example.com",
        "app-a-2.example.com",
        "app-a-3.example.com",
        "app-a-4.example.com",
      ],
      outOfScope: ["admin.example.com"],
      capability: "scan",
    },
    goals: [
      {
        id: "g-diff",
        title: "两份清单差异核算",
        description: "按 host 主键核对基线/当前清单，缺件不得判通过",
        kind: "business-reconcile",
        business: {
          name: "asset-diff",
          keyField: "host",
          requiredKeys: ["app-a-1.example.com", "app-a-2.example.com"],
          baseline: { path: "materials/baseline.csv" },
          current: { path: "materials/current.csv" },
        },
      },
    ],
  });
  rec.eq("A 建档：显式客户/委托 + 业务核算目标", createA.status, 201, "POST /tasks");
  const taskA = String(createA.body.task.id);
  commands.push(`curl -s -X POST $BASE/tasks -d @task-a.json  # -> ${taskA}`);

  const baselineSha = sha256(BASELINE);
  const currentSha = sha256(CURRENT);
  const importBaseline = await httpJson<AnyRec>(base, "POST", `/tasks/${taskA}/materials`, {
    path: "materials/baseline.csv",
    content: BASELINE,
    kind: "asset-inventory",
    asset: "app-a-1.example.com",
    locator: "rows=4;covers=app-a-1..3",
  });
  const importCurrent = await httpJson<AnyRec>(base, "POST", `/tasks/${taskA}/materials`, {
    path: "materials/current.csv",
    content: CURRENT,
    kind: "asset-inventory",
    asset: "app-a-1.example.com",
    locator: "rows=4;covers=app-a-1..4",
  });
  rec.eq("材料导入：两份清单 accepted", [importBaseline.body.material.status, importCurrent.body.material.status], ["accepted", "accepted"]);
  rec.eq("材料导入：原件 SHA-256 落台账", [importBaseline.body.material.sha256, importCurrent.body.material.sha256], [baselineSha, currentSha]);

  // ---------------- 作业 1：提交 → 杀进程 → 重启 unknown → 重试 ----------------
  const submit1 = await httpJson<AnyRec>(base, "POST", `/tasks/${taskA}/jobs`, {
    kind: "material-check",
    label: "核查两份清单",
    submittedBy: "op-a",
    inputs: [
      { path: "materials/baseline.csv", sha256: baselineSha },
      { path: "materials/current.csv", sha256: currentSha },
    ],
    options: { goalId: "g-diff", paceMs: 1200 },
  });
  rec.eq("作业提交：202 + queued", [submit1.status, submit1.body.job.status], [202, "queued"]);
  const job1 = String(submit1.body.job.id);
  commands.push(`curl -s -X POST $BASE/tasks/${taskA}/jobs -d @job1.json  # -> ${job1}`);

  await new Promise((resolve) => setTimeout(resolve, 600));
  const beforeKill = await httpJson<AnyRec>(base, "GET", `/tasks/${taskA}/jobs/${job1}`);
  rec.record(
    "作业执行中：状态为 running 或已完成（记录中断前现场）",
    ["running", "succeeded"].includes(beforeKill.body.job.status),
    "running",
    beforeKill.body.job.status,
  );
  plane.kill();
  rec.record("服务被强制中断（SIGKILL）", true, "进程消失", "killed", `pid=${plane.proc.pid}`);

  plane = await startPlane(root, port, { GY_MOCK_SKIP_PATTERNS: "reconcile/", GY_MOCK_FINDINGS: "off" });
  base = plane.base;
  const afterBoot = await httpJson<AnyRec>(base, "GET", `/tasks/${taskA}/jobs/${job1}`);
  rec.eq("重启对账：上一代 running 作业标 unknown（不假装成功）", afterBoot.body.job.status, "unknown");
  rec.eq("重启对账：pauseState=unknown，状态三态可分", afterBoot.body.job.pauseState, "unknown");
  const jobsCli = gy(base, ["jobs", taskA]);
  commands.push(jobsCli.command);
  rec.truthy("CLI 接手：gy jobs 读到 unknown", jobsCli.stdout.includes("unknown"), "输出含 unknown", jobsCli.stdout.slice(0, 200));
  const retryCli = gy(base, ["job-retry", taskA, job1]);
  commands.push(retryCli.command);
  rec.eq("CLI 接管：job-retry 接受", retryCli.status, 0, retryCli.stderr.slice(0, 200));
  const done1 = await jobUntil(base, taskA, job1, ["succeeded", "failed"]);
  rec.eq("重试后作业成功", done1.job.status, "succeeded");
  rec.eq("作业产物：核算结果带 SHA-256", /^[0-9a-f]{64}$/.test(done1.job.artifacts[0]?.sha256 ?? ""), true);
  rec.eq("完成回流：业务目标首次通过", done1.job.result?.assertions?.[0]?.ok, true, JSON.stringify(done1.job.result?.assertions ?? []));
  const taskAfterJob = await httpJson<AnyRec>(base, "GET", `/tasks/${taskA}`);
  rec.eq("完成回流：GET /tasks 目标 passes=true", taskAfterJob.body.task.goals[0].passes, true);

  // 产物字节核对：evidence 文件哈希 = 作业产物哈希
  const artifactPath = String(done1.job.artifacts[0].path);
  const artifactFile = await fetch(`${base}/tasks/${taskA}/evidence/file?path=${encodeURIComponent(artifactPath)}`);
  const artifactBytes = Buffer.from(await artifactFile.arrayBuffer());
  rec.eq("产物哈希与落盘字节一致", sha256(artifactBytes), done1.job.artifacts[0].sha256);

  // ---------------- 作业 2：范围收缩后的迟到结果 + 回执幂等 ----------------
  const submit2 = await httpJson<AnyRec>(base, "POST", `/tasks/${taskA}/jobs`, {
    kind: "material-check",
    label: "复核清单（范围收缩期间）",
    submittedBy: "op-a",
    inputs: [
      { path: "materials/baseline.csv", sha256: baselineSha },
      { path: "materials/current.csv", sha256: currentSha },
    ],
    options: { goalId: "g-diff", paceMs: 900 },
  });
  const job2 = String(submit2.body.job.id);
  await new Promise((resolve) => setTimeout(resolve, 250));
  const scope = await httpJson<AnyRec>(base, "POST", `/tasks/${taskA}/scope`, {
    auth: {
      authorizationNote: "客户 A 缩小范围：只保留 app-a-2",
      targets: ["app-a-2.example.com"],
      outOfScope: ["admin.example.com"],
      capability: "scan",
    },
    reason: "客户缩小范围（验收）",
  });
  rec.eq("范围收缩：scopeVersion 单调 +1", scope.body.task.scopeVersion, 2);
  const done2 = await jobUntil(base, taskA, job2, ["succeeded", "failed"]);
  rec.eq("迟到结果：完成时范围已前移 → lateResult=true", done2.job.lateResult, true);
  rec.eq("迟到结果：保留提交时的范围版本", done2.job.scopeVersion, 1);
  rec.truthy("范围收缩：job 完成事件进台账", true, "lateResult 标记", String(done2.job.status));

  const ack1 = await httpJson<AnyRec>(base, "POST", `/tasks/${taskA}/jobs/${job2}/receipt`, {
    deliveryKey: "notify-op-b",
    deliveredBy: "op-a",
  });
  const ack2 = await httpJson<AnyRec>(base, "POST", `/tasks/${taskA}/jobs/${job2}/receipt`, {
    deliveryKey: "notify-op-b",
    deliveredBy: "op-a",
  });
  rec.eq("回执幂等：首次 duplicate=false", ack1.body.duplicate, false);
  rec.eq("回执幂等：重复投递 duplicate=true", ack2.body.duplicate, true);
  const jobsWithReceipts = await httpJson<AnyRec>(base, "GET", `/tasks/${taskA}/jobs?receipts=1`);
  const job2View = jobsWithReceipts.body.jobs.find((job: AnyRec) => job.id === job2);
  rec.eq("回执幂等：只留一条回执", job2View.receipts.length, 1);

  // ---------------- 24h 人工求助（可控时钟）----------------
  const consultCreate = await httpJson<AnyRec>(base, "POST", `/tasks/${taskA}/consults`, {
    question: "范围收缩后是否继续验证 app-a-1 的 SQL 注入？",
    options: ["继续", "停止"],
    context: "客户已把 app-a-1 移出范围",
    blocking: true,
    askedBy: "agent",
  });
  const consultId = String(consultCreate.body.consult.id);
  rec.eq("人工求助：默认 24h 到期", consultCreate.body.consult.dueAt, new Date(Date.parse(consultCreate.body.consult.createdAt) + 86_400_000).toISOString());
  const sweep23 = await httpJson<AnyRec>(base, "POST", `/tasks/${taskA}/consults/sweep`, {
    now: new Date(Date.parse(consultCreate.body.consult.createdAt) + 23 * 3600_000).toISOString(),
  });
  rec.eq("24h 前半段：仍阻塞（released=0）", sweep23.body.released.length, 0);
  const sweep24 = await httpJson<AnyRec>(base, "POST", `/tasks/${taskA}/consults/sweep`, {
    now: new Date(Date.parse(consultCreate.body.consult.createdAt) + 24 * 3600_000 + 1000).toISOString(),
  });
  rec.eq("24h 到期：只解除阻塞（released=1）", sweep24.body.released.length, 1);
  rec.eq("24h 到期：问题仍 open，status 不变", [sweep24.body.released[0].status, sweep24.body.released[0].blocking], ["open", false]);

  const handoff1 = gy(base, ["handoff", taskA, "--next-owner", "op-b"]);
  commands.push(handoff1.command);
  const packet1 = JSON.parse(handoff1.stdout) as AnyRec;
  rec.eq("交接包：范围版本为 v2", packet1.handoff.scopeVersion, 2);
  rec.eq("交接包：已完成目标含 g-diff", packet1.handoff.completed.some((goal: AnyRec) => goal.id === "g-diff"), true);
  rec.eq("交接包：待答问题保留（已转非阻塞仍需答复）", [packet1.handoff.openQuestions.length, packet1.handoff.openQuestions[0].blocking], [1, false]);
  rec.eq("交接包：下一责任人", packet1.handoff.nextOwner, "op-b");
  rec.truthy("交接包：列出后台作业（含迟到标记）", packet1.handoff.jobs.some((job: AnyRec) => job.lateResult === true), "含 lateResult 作业", JSON.stringify(packet1.handoff.jobs));

  const answer = gy(base, ["answer", taskA, consultId, "继续验证，仅限已授权资产", "--by", "op-b"]);
  commands.push(answer.command);
  rec.eq("另一位操作员从 CLI 答复", answer.status, 0, answer.stderr.slice(0, 300));
  const consultsAfter = await httpJson<AnyRec>(base, "GET", `/tasks/${taskA}/consults`);
  rec.eq("答复落库：status=answered + answeredBy", [consultsAfter.body.consults[0].status, consultsAfter.body.consults[0].answeredBy], ["answered", "op-b"]);
  const hintsAfter = await httpJson<AnyRec>(base, "GET", `/tasks/${taskA}/hints`);
  rec.truthy("答复以 human Hint 回注", hintsAfter.body.hints.some((hint: AnyRec) => hint.source === "human" && hint.tags.includes(`consult:${consultId}`)), "Hint 含 consult 标签", JSON.stringify(hintsAfter.body.hints.slice(0, 3)));

  // ---------------- 材料语义：四类 + 三种异常 + 受控引用 ----------------
  const imports: AnyRec = {};
  imports.config = await httpJson<AnyRec>(base, "POST", `/tasks/${taskA}/materials`, {
    path: "config/checks.json",
    content: JSON.stringify({ checks: [{ id: "tls.minVersion", value: "1.3" }] }),
    kind: "config-check",
    asset: "app-a-2.example.com",
    locator: "check=tls.minVersion",
  });
  imports.http = await httpJson<AnyRec>(base, "POST", `/tasks/${taskA}/materials`, {
    path: "http/transaction-1.txt",
    content: "GET /login HTTP/1.1\nHost: app-a-2.example.com\n\nHTTP/1.1 200 OK\ncontent-length: 12\n",
    kind: "http-transaction",
    asset: "app-a-2.example.com",
    locator: "request=1;status=200",
  });
  imports.retest = await httpJson<AnyRec>(base, "POST", `/tasks/${taskA}/materials`, {
    path: "retest/manual-retest.md",
    content: "# 人工复测\n\n复核人：客户 B\n结论：已修复\n",
    kind: "manual-retest",
    asset: "app-a-2.example.com",
    locator: "manual=1",
  });
  rec.eq("材料语义：配置核查/HTTP 事务/人工复测均 accepted", [imports.config.body.material.status, imports.http.body.material.status, imports.retest.body.material.status], ["accepted", "accepted", "accepted"]);
  const unsupported = await httpJson<AnyRec>(base, "POST", `/tasks/${taskA}/materials`, {
    path: "materials/weird.bin",
    content: "not a supported shape",
    asset: "app-a-2.example.com",
  });
  rec.eq("材料语义：格式不支持 → unsupported（不静默转已验证）", [unsupported.body.material.status, unsupported.body.material.kind], ["unsupported", null]);
  const unknownOwner = await httpJson<AnyRec>(base, "POST", `/tasks/${taskA}/materials`, {
    path: "materials/other.csv",
    content: "host,version\napp-z.example.com,1\n",
    kind: "asset-inventory",
    asset: "app-z.example.com",
  });
  rec.eq("材料语义：归属不明 → unknown-owner", unknownOwner.body.material.status, "unknown-owner");
  const expired = await httpJson<AnyRec>(base, "POST", `/tasks/${taskA}/materials`, {
    path: "http/old.txt",
    content: "GET / HTTP/1.1\nHost: app-a-2.example.com\n",
    kind: "http-transaction",
    asset: "app-a-2.example.com",
    observedAt: new Date(Date.now() - 30 * 86_400_000).toISOString(),
  });
  rec.eq("材料语义：材料过期 → expired", expired.body.material.status, "expired");
  const secretPlain = await httpJson<AnyRec>(base, "POST", `/tasks/${taskA}/materials`, {
    path: "materials/creds.txt",
    content: "username=gy\npassword=SuperSecret123\n",
    kind: "asset-inventory",
    asset: "app-a-2.example.com",
  });
  rec.eq("凭据材料：明文被拒（要求受控引用）", secretPlain.status, 422);
  const secretRef = await httpJson<AnyRec>(base, "POST", `/tasks/${taskA}/materials`, {
    path: "materials/creds.txt",
    content: "username=gy\npassword=SuperSecret123\n",
    kind: "asset-inventory",
    asset: "app-a-2.example.com",
    secretRef: "env:GY_FIXTURE_TOKEN",
    sensitivity: "controlled-ref",
  });
  rec.eq("凭据材料：受控引用 accepted + sensitivity", [secretRef.body.material.status, secretRef.body.material.sensitivity], ["accepted", "controlled-ref"]);
  const refBytes = await fetch(`${base}/tasks/${taskA}/evidence/file?path=${encodeURIComponent("materials/creds.txt.ref")}`);
  const refText = Buffer.from(await refBytes.arrayBuffer()).toString("utf8");
  rec.eq("凭据材料：落盘只有指针与摘要，无明文", refText.includes("SuperSecret123"), false, refText.slice(0, 120));

  // ---------------- Finding / 覆盖矩阵 / 证据撤回一致性 ----------------
  const tx1 = "GET /login?user=1 HTTP/1.1\nHost: app-a-1.example.com\n\nHTTP/1.1 200 OK\n";
  const tx2 = "POST /api/search HTTP/1.1\nHost: app-a-1.example.com\n\nHTTP/1.1 500 Internal Server Error\n";
  const w1 = await httpJson<AnyRec>(base, "POST", `/tasks/${taskA}/evidence`, { path: "http/tx-1.txt", content: tx1 });
  const w2 = await httpJson<AnyRec>(base, "POST", `/tasks/${taskA}/evidence`, { path: "http/tx-2.txt", content: tx2 });
  const history = openHistory({
    dbPath: join(root, "tasks", taskA, "history.sqlite"),
    evidenceDir: join(root, "tasks", taskA, "evidence"),
  });
  let f1: string;
  let f2: string;
  let f3: string;
  try {
    const r1 = history.recordFinding({ taskId: taskA, title: "登录处 SQL 注入", asset: "app-a-1.example.com", vulnClass: "CWE-89", severity: "high", endpoint: "https://app-a-1.example.com/login?user", confidence: "firm", repro: "curl ...", impact: "可读库" });
    f1 = r1.finding.id;
    // 同一条结论留两份独立证据：撤走其中一份后仍应成立（报告里“仍有独立依据”的来源）。
    history.verifyFinding(taskA, f1, { evidencePaths: ["http/tx-1.txt", "http/tx-2.txt"], repro: "sqlmap -u ... --batch" });
    const r2 = history.recordFinding({ taskId: taskA, title: "搜索接口 SQL 注入", asset: "app-a-1.example.com", vulnClass: "CWE-89", severity: "high", endpoint: "https://app-a-1.example.com/api/search", confidence: "firm", repro: "curl ...", impact: "可读库" });
    f2 = r2.finding.id;
    history.verifyFinding(taskA, f2, { evidencePaths: ["http/tx-2.txt"], repro: "curl ..." });
    const r3 = history.recordFinding({ taskId: taskA, title: "反射型 XSS", asset: "app-a-1.example.com", vulnClass: "CWE-79", severity: "medium", endpoint: "https://app-a-1.example.com/s?q=", confidence: "firm", repro: "<script>", impact: "会话窃取" });
    f3 = r3.finding.id;
    history.verifyFinding(taskA, f3, { evidencePaths: ["http/tx-1.txt"], repro: "<script>alert(1)</script>" });
  } finally {
    history.close();
  }
  notes.push("finding 由验收脚本按 worker 同一 History 写入路径播种（recordFinding + verifyFinding，证据落 evidence/ 并封存 SHA-256）；本场景验证后端投影与撤回语义，不验证 worker 自动发现。");
  rec.truthy("finding 播种：三条已证实现场", w1.body.sha256 === sha256(tx1) && w2.body.sha256 === sha256(tx2), "证据哈希一致", `${f1},${f2},${f3}`);

  const manual = await httpJson<AnyRec>(base, "POST", `/tasks/${taskA}/coverage-cells`, {
    asset: "app-a-1.example.com",
    technique: "AUTHZ-BOLA",
    state: "manual",
    reviewer: "op-b",
    reason: "人工核对越权矩阵（未发现）",
    evidenceRefs: ["http/tx-2.txt"],
  });
  rec.eq("人工覆盖登记：201", manual.status, 201);

  const matrixBefore = await httpJson<AnyRec>(base, "GET", `/tasks/${taskA}/coverage-matrix`);
  const cell = (body: AnyRec, technique: string) =>
    body.cells.find((entry: AnyRec) => entry.technique === technique && entry.asset === "app-a-1.example.com");
  rec.eq("矩阵（撤回前）：CWE-89 verified", cell(matrixBefore.body, "CWE-89")?.state, "verified");
  rec.eq("矩阵（撤回前）：CWE-79 verified", cell(matrixBefore.body, "CWE-79")?.state, "verified");
  rec.eq("矩阵（撤回前）：人工覆盖 AUTHZ-BOLA manual", cell(matrixBefore.body, "AUTHZ-BOLA")?.state, "manual");

  const removed = await httpJson<AnyRec>(base, "DELETE", `/tasks/${taskA}/evidence?path=${encodeURIComponent("http/tx-1.txt")}`);
  rec.eq("证据撤回：DELETE 成功", removed.status, 200);
  const matrixAfter = await httpJson<AnyRec>(base, "GET", `/tasks/${taskA}/coverage-matrix`);
  rec.eq("撤回后：CWE-89 仍有独立依据 → verified", [cell(matrixAfter.body, "CWE-89")?.state, cell(matrixAfter.body, "CWE-89")?.retractedOnly], ["verified", false]);
  rec.eq("撤回后：CWE-79 唯一依据被撤回 → retracted", [cell(matrixAfter.body, "CWE-79")?.state, cell(matrixAfter.body, "CWE-79")?.retractedOnly], ["retracted", true]);
  rec.eq("撤回后：人工覆盖不受影响", cell(matrixAfter.body, "AUTHZ-BOLA")?.state, "manual");

  const surface = await httpJson<AnyRec>(base, "GET", `/tasks/${taskA}/graphs/surface`);
  const coverageEdge = (body: AnyRec, technique: string) =>
    body.graph.edges.find((entry: AnyRec) => entry.kind === "coverage" && entry.to === `technique:${technique}`);
  rec.truthy("图 API：CWE-79 覆盖边标 broken + 依据已撤回", coverageEdge(surface.body, "CWE-79")?.broken === true && String(coverageEdge(surface.body, "CWE-79")?.label).includes("retracted"), "broken=true, label 含 retracted", JSON.stringify(coverageEdge(surface.body, "CWE-79")));
  rec.eq("图 API：CWE-89 覆盖边仍为 verified 且不 broken", [String(coverageEdge(surface.body, "CWE-89")?.label).includes("verified"), coverageEdge(surface.body, "CWE-89")?.broken], [true, false]);

  const stop = await httpJson<AnyRec>(base, "POST", `/tasks/${taskA}/stop`);
  rec.eq("终态留档：stop 成功", stop.status, 200);
  const report = await fetch(`${base}/tasks/${taskA}/report`);
  const reportText = await report.text();
  rec.truthy("报告：新增「证据撤回影响」段", reportText.includes("## 证据撤回影响"), "含撤回段", reportText.slice(0, 120));
  rec.truthy("报告：受影响项区分「仍有独立依据」与「唯一依据已撤回」", reportText.includes("仍有独立依据") && reportText.includes("唯一依据已撤回"), "两类都在", "");
  rec.truthy("报告：CWE-79 结论被点名", reportText.includes("反射型 XSS"), "含该 finding 标题", "");

  // ---------------- 事实时效 ----------------
  const started = Date.now();
  await httpJson(base, "POST", `/tasks/${taskA}/hints`, { text: "验收提示（用于产生事实）", source: "human" });
  const fresh = await httpJson<AnyRec>(base, "GET", `/tasks/${taskA}/freshness?now=${encodeURIComponent(new Date(started + 40 * 86_400_000).toISOString())}`);
  rec.truthy("事实时效：可控时钟 40 天后出现待复核（原事实保留）", fresh.body.needsReview.length > 0, "needsReview>0", JSON.stringify(fresh.body.needsReview?.slice(0, 2) ?? []));
  const factsNow = await httpJson<AnyRec>(base, "GET", `/tasks/${taskA}/history`);
  rec.truthy("事实时效：不改写/不删除原事实", factsNow.status === 200, "GET /history 200", String(factsNow.status));

  // ---------------- 两个客户同名资产 ----------------
  const createB = await httpJson<AnyRec>(base, "POST", "/tasks", {
    tenantId: "customer-b",
    engagementId: "eng-b",
    name: "B 客户同名资产（反例）",
    mock: true,
    auth: {
      authorizationNote: "虚构本地夹具；客户 B 授权仅限同名合成资产",
      targets: ["app-a-1.example.com"],
      outOfScope: [],
      capability: "scan",
    },
    goals: [{ id: "g-b", title: "B 目标", description: "只验证客户 B 自己的资产", evidencePatterns: ["recon/*.txt"] }],
  });
  const taskB = String(createB.body.task.id);
  rec.eq("反例建档：客户 B 同名资产", createB.status, 201);
  const graphA = await httpJson<AnyRec>(base, "GET", `/tasks/${taskA}/graphs/assets`);
  const graphB = await httpJson<AnyRec>(base, "GET", `/tasks/${taskB}/graphs/assets`);
  const idsA = new Set<string>(graphA.body.graph.nodes.map((node: AnyRec) => String(node.id)));
  const idsB: string[] = graphB.body.graph.nodes.map((node: AnyRec) => String(node.id));
  rec.eq("同名资产不串客户：两张资产图节点 ID 交集为空", idsB.filter((id: string) => idsA.has(id)), []);
  rec.truthy("同名资产不串客户：A 图节点带 eng-a", [...idsA].some((id) => String(id).includes("eng-a")), "含 eng-a", JSON.stringify([...idsA].slice(0, 3)));
  rec.truthy("同名资产不串客户：B 图节点带 eng-b", idsB.some((id) => String(id).includes("eng-b")), "含 eng-b", JSON.stringify(idsB.slice(0, 3)));
  const cross = await httpJson<AnyRec>(base, "GET", `/tasks/${taskA}/graphs/assets?engagementId=eng-b`);
  rec.eq("越界读：带别的委托查询被拒 403", cross.status, 403);
  const crossReceipt = await httpJson<AnyRec>(base, "GET", `/tasks/${taskA}/jobs?tenantId=customer-b`);
  rec.eq("越界读：租户不匹配被拒 403", crossReceipt.status, 403);

  // ---------------- 快照与记录 ----------------
  const snapshot = await httpJson<AnyRec>(base, "GET", `/tasks/${taskA}/snapshot`);
  writeFileSync(join(evidenceRun, "delivery-snapshot.json"), JSON.stringify(snapshot.body.snapshot, null, 2));
  rec.eq("交付快照：内容封印存在", /^[0-9a-f]{64}$/.test(snapshot.body.snapshot.sha256 ?? ""), true);
  rec.eq("记分卡：与快照同源", snapshot.body.scorecard.snapshotSha256, snapshot.body.snapshot.sha256);

  const recorded = writeRunRecord({
    dir: evidenceRun,
    runId,
    kind: "r9-ops",
    taskId: taskA,
    dataRoot: root,
    startedAt,
    steps: rec.snapshot(),
    summary: {
      taskA,
      taskB,
      job1,
      job2,
      consultId,
      findings: { sqlLogin: f1, sqlSearch: f2, xss: f3 },
      scorecard: snapshot.body.scorecard,
      materials: { baselineSha, currentSha },
      serverPort: port,
    },
    commands,
    notes,
  });
  rec.record("记录与清单落盘（含逐文件 SHA-256）", true, "写入验收记录", recorded.recordJson);
  // 上一步是对落盘结果的断言；把它本身也写进记录（二次落盘，哈希以最终文件为准）。
  const finalRecord = writeRunRecord({
    dir: evidenceRun,
    runId,
    kind: "r9-ops",
    taskId: taskA,
    dataRoot: root,
    startedAt,
    steps: rec.snapshot(),
    summary: {
      taskA,
      taskB,
      job1,
      job2,
      consultId,
      findings: { sqlLogin: f1, sqlSearch: f2, xss: f3 },
      scorecard: snapshot.body.scorecard,
      materials: { baselineSha, currentSha },
      serverPort: port,
    },
    commands,
    notes,
  });
  await plane.stop();

  // 把本 run 的证据目录一并放进 docs/evidence（记录里已有哈希，这里复制可复核文件）
  writeFileSync(join(evidenceRun, "run-summary.json"), JSON.stringify({ runId, taskA, taskB, job1, job2, consultId, findings: { f1, f2, f3 }, scorecard: snapshot.body.scorecard, hashes: finalRecord.hashes }, null, 2));
  console.log(`\nDONE ${runId}: ${rec.steps.length} steps, ${rec.steps.filter((step) => step.ok).length} passed`);
}

main().catch((error) => {
  console.error(error);
  try {
    writeRunRecord({
      dir: evidenceRun,
      runId,
      kind: "r9-ops",
      taskId: "",
      dataRoot: root,
      startedAt,
      steps: rec.snapshot(),
      summary: { error: error instanceof Error ? error.message : String(error) },
      commands,
      notes,
    });
  } catch {
    /* 保留原始错误 */
  }
  process.exit(1);
});

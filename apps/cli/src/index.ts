#!/usr/bin/env node
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { compareCommand, snapshotCommand } from "./coverage-audit.js";
import {
  BUDGET_UNLIMITED,
  CreateTaskRequestSchema,
  UpdateScopeRequestSchema,
  isTerminalTaskStatus,
} from "@gongyuai/contracts";
import { scorecardFromSnapshot } from "@gongyuai/history";
import {
  bootControlPlane,
  resolveCanonicalDataRoot,
  resolveInstallRoot,
} from "@gongyuai/control-plane";

type GlobalOpts = {
  dataDir: string;
  host: string;
  port: number;
  baseUrl?: string;
};

function printHelp(): void {
  console.log(`GongYuAI CLI (single-user MVP)

Usage:
  gy serve [--data-dir DIR] [--port N] [--isolated]
  gy run --goals FILE --target URL [--target URL ...] --auth NOTE [--name NAME]
       [--mock] [--wait] [--concurrency N]
       [--capability observe|scan|active-lab|full]
       [--max-wall-ms MS] [--max-tool-calls N] [--max-tokens N] [--max-installs N]
  gy status [taskId]
  gy hint <taskId> "<text>"     # inject tactical Hint into History
  gy logs <taskId>
  gy report <taskId>
  gy coverage-snapshot <taskId> --out FILE [--data-dir DIR]
  gy coverage-compare SNAPSHOT REFERENCE --snapshot-sha256 HASH --reference-sha256 HASH
  gy review <taskId> --file REVIEW.json
  gy pause <taskId>             # 请求暂停；确认 worker 退出后记录为 paused
  gy resume <taskId>            # 从 paused 继续；启动时读取最新授权版本
  gy scope <taskId> --file SCOPE.json   # { "auth": {...}, "reason": "..." }
  gy scorecard <taskId> [--out FILE]    # 交付记分卡；--out 导出可复算快照
  gy scorecard --recompute FILE         # 只读快照，离线复算分子/分母
  gy reconcile <taskId> --baseline PATH --current PATH [--key host] [--required a,b]
       [--name NAME] [--out FILE]       # 从原始材料算差异（新增/移除/变更/未变/缺件）
  gy retest-request <taskId> --requester NAME --finding ID[,ID] --reason TEXT
       [--role R] [--evidence PATH]     # 客户从正常入口发起复测申请
  gy retest-requests <taskId>
  gy peer-review <taskId> --reviewer NAME --role ROLE --source TASKID --basis TEXT
       [--decision confirm|challenge|retest-requested] [--finding ID | --fact ID]
       [--evidence PATH]                # 同一委托内跨任务署名复核
  gy peer-reviews <taskId>
  gy evidence <taskId> --path P --file LOCAL   # 导入材料（utf8 文本）
  gy finding-verify <taskId> --finding ID --evidence FILE[,FILE] --repro TEXT
  gy finding-retract <taskId> --finding ID --reason TEXT
  gy findings <taskId>
  gy retest <taskId> --finding ID --result fixed|still-present|partially-fixed
            --evidence FILE[,FILE] --repro TEXT [--note TEXT]
  gy accept <taskId> --finding ID --note TEXT --evidence FILE
  gy correct <taskId> --reason TEXT [--findings ID,ID] [--notice pending|notified]
  gy correction-notice <taskId> <correctionId> --status notified|confirmed [--evidence FILE]
  gy corrections <taskId>
  gy stop <taskId>
  gy archive <taskId>
  gy unarchive <taskId>

  gy handoff <taskId> [--next-owner NAME] [--now ISO]   # 跨班接手包
  gy jobs <taskId> [--receipts]        # 持久作业列表
  gy job-submit <taskId> --kind material-check|evidence-pack|parse-import|role-plan|role-review
        --label TEXT --input PATH[,PATH] [--sha SHA] [--asset A] [--options JSON]
  gy job-retry <taskId> <jobId>        # unknown/failed/paused 才可重试
  gy job-ack <taskId> <jobId> --key K [--by NAME]   # 幂等回执（重复投递只记一次）
  gy consults <taskId>                 # 人工求助列表
  gy consult <taskId> --question TEXT [--options a,b] [--blocking true|false]
  gy answer <taskId> <consultId> "答复" --by NAME
  gy consult-sweep <taskId> [--now ISO]  # 24h 转非阻塞（可控时钟）
  gy material <taskId> --path P --file LOCAL --asset A [--kind K] [--secret-ref REF]
  gy materials <taskId>
  gy coverage-cell <taskId> --asset A --technique CWE-89 --state manual|verified --reviewer N --reason TEXT
  gy matrix <taskId> | gy freshness <taskId>
  gy changes <taskId> | gy change <taskId> --kind K --asset A --location L --rollback CMD [--before FILE]
  gy rollback <taskId> --out FILE
  gy graph <taskId> assets|surface|execution|memory | gy causality <taskId> <findingId> | gy today
  gy memory list | gy memory draft --file F | gy memory review <id> --decision confirm|retract --reviewer N --reason TEXT
  gy memory refs <id> | gy memory inject <taskId> [--asset A] | gy contact --targets A,B
  gy proposals | gy proposal <id> | gy proposal-create --file F
  gy proposal-decide <id> --decision approve|reject --by NAME [--reason TEXT]
  gy proposal-promote <id> --by NAME --eval RUNID | gy proposal-rollback <id> --by NAME --reason TEXT
  gy eval-run --file F | gy evals [--suite S] | gy trend [--tenant T]
  gy role <taskId> --role planner|reviewer|assistant --kind plan|review|incident [--file F]
  gy provider-fault <taskId> --provider NAME --fault rate-limit|timeout|insufficient-balance|egress-denied
        [--attempt N] [--fallback true] [--billing billed] [--tokens N]

Defaults: all budget gates unlimited (0). Pass --max-* only when you want a hard cap.
Data dir defaults to <repo>/.gongyuai (not cwd). Legacy ~/.gongyuai tasks are imported on boot.

Environment:
  GY_DATA_DIR  GY_HOST  GY_PORT  GY_RUNTIME  OPENAI_API_KEY
  GY_RELAY_TOKEN_THRESHOLD  GY_RELAY_MIN_TOOL_CALLS
`);
}

/** Collect repeated --flag value pairs (e.g. multiple --target). */
function flags(rest: string[], name: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === name && rest[i + 1]) {
      out.push(rest[++i]!);
    }
  }
  return out;
}

function parseGlobal(argv: string[]): { cmd: string; rest: string[]; opts: GlobalOpts } {
  const opts: GlobalOpts = {
    // Empty → control-plane resolves to <installRoot>/.gongyuai (never cwd-relative).
    dataDir: process.env.GY_DATA_DIR ?? "",
    host: process.env.GY_HOST ?? "127.0.0.1",
    port: Number(process.env.GY_PORT ?? 8787),
  };
  const out: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--") continue;
    if (a === "--data-dir") opts.dataDir = argv[++i]!;
    else if (a === "--host") opts.host = argv[++i]!;
    else if (a === "--port") opts.port = Number(argv[++i]);
    else if (a === "--base-url") opts.baseUrl = argv[++i]!;
    else out.push(a);
  }
  const cmd = out[0] ?? "help";
  return { cmd, rest: out.slice(1), opts };
}

function flag(rest: string[], name: string): string | undefined {
  const i = rest.indexOf(name);
  if (i < 0) return undefined;
  return rest[i + 1];
}

function has(rest: string[], name: string): boolean {
  return rest.includes(name);
}

async function api(
  opts: GlobalOpts,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; text: string; json?: unknown }> {
  const base = opts.baseUrl ?? `http://${opts.host}:${opts.port}`;
  const res = await fetch(`${base}${path}`, {
    method,
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    json = undefined;
  }
  return { status: res.status, text, json };
}

async function ensureServer(opts: GlobalOpts): Promise<{ close?: () => Promise<void> }> {
  try {
    const health = await api(opts, "GET", "/health");
    if (health.status === 200) return {};
  } catch {
    /* start local */
  }
  const plane = await bootControlPlane({
    dataRoot: opts.dataDir || undefined,
    host: opts.host,
    port: opts.port,
  });
  console.error(`[gy] control plane ${plane.url}`);
  return { close: () => plane.close() };
}

async function main(): Promise<void> {
  const { cmd, rest, opts } = parseGlobal(process.argv.slice(2));
  if (cmd === "help" || cmd === "--help" || cmd === "-h") {
    printHelp();
    return;
  }

  if (cmd === "coverage-compare" || cmd === "coverage-snapshot") {
    if (opts.baseUrl) throw new Error("覆盖复核命令使用本地文件；请省略 --base-url");
    if (cmd === "coverage-compare") compareCommand(rest);
    else snapshotCommand(rest, resolveCanonicalDataRoot({ installRoot: resolveInstallRoot(), explicit: opts.dataDir }));
    return;
  }

  if (cmd === "serve") {
    const plane = await bootControlPlane({
      dataRoot: opts.dataDir || undefined,
      host: opts.host,
      port: opts.port,
      // 隔离模式（恢复演练）：不导入旧任务、不起 watchdog、不自动续跑。
      isolated: has(rest, "--isolated") || process.env.GY_ISOLATED === "1",
    });
    for (const rehome of plane.rehomed) {
      console.log(`[gy] 数据目录归属：${rehome.taskId} ${rehome.from || "(空)"} → ${rehome.to}`);
    }
    console.log(`GongYuAI control plane listening on ${plane.url}`);
    await new Promise(() => undefined);
  }

  if (cmd === "run") {
    const goalsPath = flag(rest, "--goals");
    const targets = flags(rest, "--target");
    const auth = flag(rest, "--auth");
    const name = flag(rest, "--name") ?? "mvp-run";
    const mock = has(rest, "--mock");
    const wait = has(rest, "--wait");
    const concurrency = Number(flag(rest, "--concurrency") ?? 1);
    const capability = (flag(rest, "--capability") ?? "active-lab") as
      | "observe"
      | "scan"
      | "active-lab"
      | "full";
    if (!goalsPath || !targets.length || !auth) {
      throw new Error("gy run requires --goals --target --auth");
    }
    const goals = JSON.parse(readFileSync(resolve(goalsPath), "utf8"));
    const body = CreateTaskRequestSchema.parse({
      tenantId: "default",
      name,
      mock,
      auth: {
        authorizationNote: auth,
        targets,
        outOfScope: [],
        capability,
      },
      goals,
      execution: {
        maxConcurrentExplores: concurrency,
      },
      budget: {
        maxTokens: Number(flag(rest, "--max-tokens") ?? BUDGET_UNLIMITED),
        maxWallMs: Number(flag(rest, "--max-wall-ms") ?? BUDGET_UNLIMITED),
        maxToolCalls: Number(flag(rest, "--max-tool-calls") ?? BUDGET_UNLIMITED),
        maxInstalls: Number(flag(rest, "--max-installs") ?? BUDGET_UNLIMITED),
        relayTokenThreshold: Number(
          flag(rest, "--relay-token-threshold") ??
            process.env.GY_RELAY_TOKEN_THRESHOLD ??
            30_000,
        ),
        relayMinToolCalls: Number(
          flag(rest, "--relay-min-tool-calls") ??
            process.env.GY_RELAY_MIN_TOOL_CALLS ??
            2,
        ),
      },
    });

    const owned = await ensureServer(opts);
    const created = await api(opts, "POST", "/tasks", body);
    if (created.status >= 400) {
      throw new Error(created.text);
    }
    const task = (created.json as { task: { id: string; status: string } }).task;
    console.log(JSON.stringify(task, null, 2));

    if (wait) {
      try {
        for (;;) {
          await new Promise((r) => setTimeout(r, 1000));
          const st = await api(opts, "GET", `/tasks/${task.id}`);
          const t = (st.json as { task: { id: string; status: string } }).task;
          process.stderr.write(`\r[gy] status=${t.status}   `);
          if (isTerminalTaskStatus(t.status)) {
            console.log();
            console.log(JSON.stringify(t, null, 2));
            break;
          }
        }
      } finally {
        if (owned.close) await owned.close();
      }
      return;
    }

    if (owned.close) {
      console.error(
        "[gy] embedded control plane stays up for this process; prefer `gy serve` for long-lived use",
      );
    }
    return;
  }

  if (cmd === "status") {
    const owned = await ensureServer(opts);
    try {
      const id = rest[0];
      if (!id) {
        const all = await api(opts, "GET", "/tasks");
        console.log(all.text);
        return;
      }
      const one = await api(opts, "GET", `/tasks/${id}`);
      console.log(one.text);
    } finally {
      if (owned.close) await owned.close();
    }
    return;
  }

  if (cmd === "hint") {
    const id = rest[0];
    const text = rest.slice(1).join(" ").trim();
    if (!id || !text) throw new Error('gy hint <taskId> "<text>"');
    const owned = await ensureServer(opts);
    try {
      const r = await api(opts, "POST", `/tasks/${id}/hints`, {
        text,
        source: "human",
      });
      if (r.status >= 400) throw new Error(r.text);
      console.log(r.text);
    } finally {
      if (owned.close) await owned.close();
    }
    return;
  }

  if (cmd === "logs") {
    const id = rest[0];
    if (!id) throw new Error("gy logs <taskId>");
    const owned = await ensureServer(opts);
    try {
      const logs = await api(opts, "GET", `/tasks/${id}/logs`);
      process.stdout.write(logs.text);
    } finally {
      if (owned.close) await owned.close();
    }
    return;
  }

  if (cmd === "review") {
    const id = rest[0];
    const path = flag(rest, "--file");
    if (!id || !path) throw new Error("gy review <taskId> --file REVIEW.json");
    const input: unknown = JSON.parse(readFileSync(resolve(path), "utf8"));
    const owned = await ensureServer(opts);
    try {
      const response = await api(opts, "POST", `/tasks/${encodeURIComponent(id)}/reviews`, input);
      if (response.status >= 400) throw new Error(response.text);
      console.log(response.text);
    } finally {
      if (owned.close) await owned.close();
    }
    return;
  }

  if (cmd === "report") {
    const id = rest[0];
    if (!id) throw new Error("gy report <taskId>");
    const owned = await ensureServer(opts);
    try {
      const report = await api(opts, "GET", `/tasks/${id}/report`);
      process.stdout.write(report.text);
    } finally {
      if (owned.close) await owned.close();
    }
    return;
  }

  if (cmd === "evidence") {
    const id = rest[0];
    const path = flag(rest, "--path");
    const file = flag(rest, "--file");
    if (!id || !path || !file) throw new Error("gy evidence <taskId> --path P --file LOCAL");
    const content = readFileSync(resolve(file), "utf8");
    const owned = await ensureServer(opts);
    try {
      const r = await api(opts, "POST", `/tasks/${id}/evidence`, { path, content });
      if (r.status >= 400) throw new Error(r.text);
      console.log(r.text);
    } finally {
      if (owned.close) await owned.close();
    }
    return;
  }

  if (cmd === "finding-verify" || cmd === "finding-retract") {
    const id = rest[0];
    const finding = flag(rest, "--finding");
    if (!id || !finding) throw new Error(`gy ${cmd} <taskId> --finding ID`);
    const owned = await ensureServer(opts);
    try {
      const body = cmd === "finding-retract"
        ? { reason: flag(rest, "--reason") ?? "" }
        : {
            evidencePaths: (flag(rest, "--evidence") ?? "").split(",").map((v) => v.trim()).filter(Boolean),
            repro: flag(rest, "--repro") ?? "",
          };
      const r = await api(
        opts,
        "POST",
        `/tasks/${id}/findings/${finding}/${cmd === "finding-retract" ? "retract" : "verify"}`,
        body,
      );
      if (r.status >= 400) throw new Error(r.text);
      console.log(r.text);
    } finally {
      if (owned.close) await owned.close();
    }
    return;
  }

  if (cmd === "findings") {
    const id = rest[0];
    if (!id) throw new Error("gy findings <taskId>");
    const owned = await ensureServer(opts);
    try {
      const r = await api(opts, "GET", `/tasks/${id}/findings`);
      console.log(r.text);
    } finally {
      if (owned.close) await owned.close();
    }
    return;
  }

  if (cmd === "retest") {
    const id = rest[0];
    const finding = flag(rest, "--finding");
    const result = flag(rest, "--result");
    const evidence = flag(rest, "--evidence");
    const repro = flag(rest, "--repro");
    if (!id || !finding || !result || !evidence || !repro) {
      throw new Error("gy retest <taskId> --finding ID --result fixed|still-present|partially-fixed --evidence FILE --repro TEXT");
    }
    const owned = await ensureServer(opts);
    try {
      const r = await api(opts, "POST", `/tasks/${id}/findings/${finding}/retest`, {
        result,
        evidencePaths: evidence.split(",").map((v) => v.trim()).filter(Boolean),
        repro,
        ...(flag(rest, "--note") ? { note: flag(rest, "--note") } : {}),
      });
      if (r.status >= 400) throw new Error(r.text);
      console.log(r.text);
    } finally {
      if (owned.close) await owned.close();
    }
    return;
  }

  if (cmd === "accept") {
    const id = rest[0];
    const finding = flag(rest, "--finding");
    const note = flag(rest, "--note");
    const evidence = flag(rest, "--evidence");
    if (!id || !finding || !note || !evidence) {
      throw new Error("gy accept <taskId> --finding ID --note TEXT --evidence FILE");
    }
    const owned = await ensureServer(opts);
    try {
      const r = await api(opts, "POST", `/tasks/${id}/findings/${finding}/accept`, { note, evidencePath: evidence });
      if (r.status >= 400) throw new Error(r.text);
      console.log(r.text);
    } finally {
      if (owned.close) await owned.close();
    }
    return;
  }

  if (cmd === "pause" || cmd === "resume") {
    const id = rest[0];
    if (!id) throw new Error(`gy ${cmd} <taskId>`);
    const owned = await ensureServer(opts);
    try {
      const r = await api(opts, "POST", `/tasks/${id}/${cmd}`);
      if (r.status >= 400) throw new Error(r.text);
      console.log(r.text);
    } finally {
      if (owned.close) await owned.close();
    }
    return;
  }

  if (cmd === "scope") {
    const id = rest[0];
    const path = flag(rest, "--file");
    if (!id || !path) throw new Error("gy scope <taskId> --file SCOPE.json");
    const body = UpdateScopeRequestSchema.parse(JSON.parse(readFileSync(resolve(path), "utf8")));
    const owned = await ensureServer(opts);
    try {
      const r = await api(opts, "POST", `/tasks/${id}/scope`, body);
      if (r.status >= 400) throw new Error(r.text);
      console.log(r.text);
    } finally {
      if (owned.close) await owned.close();
    }
    return;
  }

  if (cmd === "scorecard") {
    const recompute = flag(rest, "--recompute");
    if (recompute) {
      const parsed: unknown = JSON.parse(readFileSync(resolve(recompute), "utf8"));
      const result = scorecardFromSnapshot(parsed);
      if (!result.ok) throw new Error(result.reason);
      console.log(JSON.stringify({ sealValid: result.sealValid, scorecard: result.scorecard }, null, 2));
      if (!result.sealValid) process.exitCode = 2;
      return;
    }
    const id = rest[0];
    if (!id) throw new Error("gy scorecard <taskId> [--out FILE]");
    const out = flag(rest, "--out");
    const owned = await ensureServer(opts);
    try {
      const r = await api(opts, "GET", `/tasks/${id}/snapshot`);
      if (r.status >= 400) throw new Error(r.text);
      const payload = r.json as { snapshot: unknown; scorecard: unknown };
      if (out) writeFileSync(resolve(out), JSON.stringify(payload.snapshot, null, 2) + "\n");
      console.log(JSON.stringify(payload.scorecard, null, 2));
    } finally {
      if (owned.close) await owned.close();
    }
    return;
  }

  if (cmd === "corrections") {
    const id = rest[0];
    if (!id) throw new Error("gy corrections <taskId>");
    const owned = await ensureServer(opts);
    try {
      const r = await api(opts, "GET", `/tasks/${id}/corrections`);
      console.log(r.text);
    } finally {
      if (owned.close) await owned.close();
    }
    return;
  }

  if (cmd === "correct") {
    const id = rest[0];
    const reason = flag(rest, "--reason");
    if (!id || !reason) throw new Error("gy correct <taskId> --reason TEXT");
    const findings = flag(rest, "--findings");
    const notice = flag(rest, "--notice");
    const owned = await ensureServer(opts);
    try {
      const r = await api(opts, "POST", `/tasks/${id}/corrections`, {
        reason,
        ...(findings ? { findings: findings.split(",").map((v) => v.trim()).filter(Boolean) } : {}),
        ...(notice ? { noticeStatus: notice } : {}),
      });
      if (r.status >= 400) throw new Error(r.text);
      console.log(r.text);
    } finally {
      if (owned.close) await owned.close();
    }
    return;
  }

  if (cmd === "correction-notice") {
    const id = rest[0];
    const correctionId = rest[1];
    const status = flag(rest, "--status");
    const evidence = flag(rest, "--evidence");
    if (!id || !correctionId || !status) {
      throw new Error("gy correction-notice <taskId> <correctionId> --status notified|confirmed [--evidence FILE]");
    }
    const owned = await ensureServer(opts);
    try {
      const r = await api(opts, "POST", `/tasks/${id}/corrections/${correctionId}/notice`, {
        status,
        ...(evidence ? { evidencePath: evidence } : {}),
      });
      if (r.status >= 400) throw new Error(r.text);
      console.log(r.text);
    } finally {
      if (owned.close) await owned.close();
    }
    return;
  }

  if (cmd === "stop") {
    const id = rest[0];
    if (!id) throw new Error("gy stop <taskId>");
    const owned = await ensureServer(opts);
    try {
      const stopped = await api(opts, "POST", `/tasks/${id}/stop`);
      console.log(stopped.text);
    } finally {
      if (owned.close) await owned.close();
    }
    return;
  }

  if (cmd === "archive" || cmd === "unarchive") {
    const id = rest[0];
    if (!id) throw new Error(`gy ${cmd} <taskId>`);
    const owned = await ensureServer(opts);
    try {
      const r = await api(opts, "POST", `/tasks/${id}/${cmd}`);
      if (r.status >= 400) throw new Error(r.text);
      console.log(r.text);
    } finally {
      if (owned.close) await owned.close();
    }
    return;
  }

  if (cmd === "reconcile") {
    const id = rest[0];
    const baseline = flag(rest, "--baseline");
    const current = flag(rest, "--current");
    if (!id || !baseline || !current) {
      throw new Error("gy reconcile <taskId> --baseline PATH --current PATH [--key host] [--required a,b] [--name NAME] [--out FILE]");
    }
    const required = flag(rest, "--required");
    const body = {
      name: flag(rest, "--name") ?? "baseline-diff",
      baseline: { path: baseline },
      current: { path: current },
      keyField: flag(rest, "--key") ?? "host",
      ...(required ? { requiredKeys: required.split(",").map((v) => v.trim()).filter(Boolean) } : {}),
    };
    const owned = await ensureServer(opts);
    try {
      const r = await api(opts, "POST", `/tasks/${id}/reconcile`, body);
      if (r.status >= 400) throw new Error(r.text);
      const out = flag(rest, "--out");
      if (out) writeFileSync(resolve(out), JSON.stringify(r.json, null, 2) + "\n");
      console.log(JSON.stringify(r.json, null, 2));
    } finally {
      if (owned.close) await owned.close();
    }
    return;
  }

  if (cmd === "retest-request") {
    const id = rest[0];
    const requester = flag(rest, "--requester");
    const finding = flag(rest, "--finding");
    const reason = flag(rest, "--reason");
    if (!id || !requester || !finding || !reason) {
      throw new Error("gy retest-request <taskId> --requester NAME --finding ID[,ID] --reason TEXT [--role R] [--evidence PATH]");
    }
    const role = flag(rest, "--role");
    const evidence = flag(rest, "--evidence");
    const owned = await ensureServer(opts);
    try {
      const r = await api(opts, "POST", `/tasks/${id}/retest-requests`, {
        requester,
        findingIds: finding.split(",").map((v) => v.trim()).filter(Boolean),
        reason,
        ...(role ? { role } : {}),
        ...(evidence ? { evidencePath: evidence } : {}),
      });
      if (r.status >= 400) throw new Error(r.text);
      console.log(r.text);
    } finally {
      if (owned.close) await owned.close();
    }
    return;
  }

  if (cmd === "retest-requests") {
    const id = rest[0];
    if (!id) throw new Error("gy retest-requests <taskId>");
    const owned = await ensureServer(opts);
    try {
      const r = await api(opts, "GET", `/tasks/${id}/retest-requests`);
      console.log(r.text);
    } finally {
      if (owned.close) await owned.close();
    }
    return;
  }

  if (cmd === "peer-review") {
    const id = rest[0];
    const reviewer = flag(rest, "--reviewer");
    const role = flag(rest, "--role");
    const source = flag(rest, "--source");
    const basis = flag(rest, "--basis");
    if (!id || !reviewer || !role || !source || !basis) {
      throw new Error(
        "gy peer-review <taskId> --reviewer NAME --role ROLE --source TASKID --basis TEXT [--decision confirm|challenge|retest-requested] [--finding ID] [--fact ID] [--evidence PATH]",
      );
    }
    const finding = flag(rest, "--finding");
    const fact = flag(rest, "--fact");
    const evidence = flag(rest, "--evidence");
    const owned = await ensureServer(opts);
    try {
      const r = await api(opts, "POST", `/tasks/${id}/peer-reviews`, {
        reviewer,
        role,
        sourceTaskId: source,
        decision: flag(rest, "--decision") ?? "confirm",
        basis,
        ...(finding ? { findingId: finding } : {}),
        ...(fact ? { factId: fact } : {}),
        ...(evidence ? { evidencePath: evidence } : {}),
      });
      if (r.status >= 400) throw new Error(r.text);
      console.log(r.text);
    } finally {
      if (owned.close) await owned.close();
    }
    return;
  }

  if (cmd === "peer-reviews") {
    const id = rest[0];
    if (!id) throw new Error("gy peer-reviews <taskId>");
    const owned = await ensureServer(opts);
    try {
      const r = await api(opts, "GET", `/tasks/${id}/peer-reviews`);
      console.log(r.text);
    } finally {
      if (owned.close) await owned.close();
    }
    return;
  }

  // Direct local status from data dir without server

  if (cmd === "handoff") {
    const id = rest[0];
    if (!id) throw new Error("gy handoff <taskId>");
    const qs = new URLSearchParams();
    if (flag(rest, "--next-owner")) qs.set("nextOwner", flag(rest, "--next-owner")!);
    if (flag(rest, "--now")) qs.set("now", flag(rest, "--now")!);
    const owned = await ensureServer(opts);
    try {
      const r = await api(opts, "GET", `/tasks/${id}/handoff?${qs.toString()}`);
      if (r.status >= 400) throw new Error(r.text);
      console.log(r.text);
    } finally {
      if (owned.close) await owned.close();
    }
    return;
  }

  if (cmd === "jobs") {
    const id = rest[0];
    if (!id) throw new Error("gy jobs <taskId>");
    const owned = await ensureServer(opts);
    try {
      const r = await api(opts, "GET", `/tasks/${id}/jobs${has(rest, "--receipts") ? "?receipts=1" : ""}`);
      console.log(r.text);
    } finally {
      if (owned.close) await owned.close();
    }
    return;
  }

  if (cmd === "job-submit") {
    const id = rest[0];
    const kind = flag(rest, "--kind");
    const label = flag(rest, "--label") ?? "job";
    const inputs = (flag(rest, "--input") ?? "").split(",").map((v) => v.trim()).filter(Boolean);
    if (!id || !kind || inputs.length === 0) throw new Error("gy job-submit <taskId> --kind K --label L --input PATH[,PATH]");
    const sha = flag(rest, "--sha");
    const options = flag(rest, "--options");
    const body = {
      kind,
      label,
      ...(flag(rest, "--asset") ? { asset: flag(rest, "--asset") } : {}),
      submittedBy: flag(rest, "--by") ?? "operator",
      inputs: inputs.map((path) => ({ path, sha256: sha ?? null })),
      options: options ? JSON.parse(options) : {},
    };
    const owned = await ensureServer(opts);
    try {
      const r = await api(opts, "POST", `/tasks/${id}/jobs`, body);
      if (r.status >= 400) throw new Error(r.text);
      console.log(r.text);
    } finally {
      if (owned.close) await owned.close();
    }
    return;
  }

  if (cmd === "job" || cmd === "job-retry") {
    const id = rest[0];
    const jobId = rest[1];
    if (!id || !jobId) throw new Error(`gy ${cmd} <taskId> <jobId>`);
    const owned = await ensureServer(opts);
    try {
      const r = cmd === "job"
        ? await api(opts, "GET", `/tasks/${id}/jobs/${jobId}`)
        : await api(opts, "POST", `/tasks/${id}/jobs/${jobId}/retry`, {});
      if (r.status >= 400) throw new Error(r.text);
      console.log(r.text);
    } finally {
      if (owned.close) await owned.close();
    }
    return;
  }

  if (cmd === "job-ack") {
    const id = rest[0];
    const jobId = rest[1];
    const key = flag(rest, "--key");
    if (!id || !jobId || !key) throw new Error("gy job-ack <taskId> <jobId> --key K");
    const owned = await ensureServer(opts);
    try {
      const r = await api(opts, "POST", `/tasks/${id}/jobs/${jobId}/receipt`, {
        deliveryKey: key,
        deliveredBy: flag(rest, "--by") ?? "operator",
        note: flag(rest, "--note") ?? "",
      });
      console.log(r.text);
    } finally {
      if (owned.close) await owned.close();
    }
    return;
  }

  if (cmd === "consults") {
    const id = rest[0];
    if (!id) throw new Error("gy consults <taskId>");
    const owned = await ensureServer(opts);
    try {
      const r = await api(opts, "GET", `/tasks/${id}/consults`);
      console.log(r.text);
    } finally {
      if (owned.close) await owned.close();
    }
    return;
  }

  if (cmd === "consult") {
    const id = rest[0];
    const question = flag(rest, "--question");
    if (!id || !question) throw new Error("gy consult <taskId> --question TEXT");
    const owned = await ensureServer(opts);
    try {
      const r = await api(opts, "POST", `/tasks/${id}/consults`, {
        question,
        options: (flag(rest, "--options") ?? "").split(",").map((v) => v.trim()).filter(Boolean),
        context: flag(rest, "--context") ?? "",
        blocking: (flag(rest, "--blocking") ?? "true") !== "false",
        askedBy: flag(rest, "--by") ?? "agent",
      });
      if (r.status >= 400) throw new Error(r.text);
      console.log(r.text);
    } finally {
      if (owned.close) await owned.close();
    }
    return;
  }

  if (cmd === "answer") {
    const id = rest[0];
    const consultId = rest[1];
    const answer = flag(rest, "--answer") ?? rest[2];
    if (!id || !consultId || !answer) throw new Error('gy answer <taskId> <consultId> "答复" --by NAME');
    const owned = await ensureServer(opts);
    try {
      const r = await api(opts, "POST", `/tasks/${id}/consults/${consultId}/answer`, {
        answer,
        answeredBy: flag(rest, "--by") ?? "operator",
        injectHint: true,
      });
      if (r.status >= 400) throw new Error(r.text);
      console.log(r.text);
    } finally {
      if (owned.close) await owned.close();
    }
    return;
  }

  if (cmd === "consult-sweep") {
    const id = rest[0];
    if (!id) throw new Error("gy consult-sweep <taskId> [--now ISO]");
    const owned = await ensureServer(opts);
    try {
      const r = await api(opts, "POST", `/tasks/${id}/consults/sweep`, {
        ...(flag(rest, "--now") ? { now: flag(rest, "--now") } : {}),
      });
      console.log(r.text);
    } finally {
      if (owned.close) await owned.close();
    }
    return;
  }

  if (cmd === "material") {
    const id = rest[0];
    const path = flag(rest, "--path");
    const file = flag(rest, "--file");
    const asset = flag(rest, "--asset");
    if (!id || !path || !file || !asset) throw new Error("gy material <taskId> --path P --file LOCAL --asset A");
    const content = readFileSync(resolve(file), "utf8");
    const owned = await ensureServer(opts);
    try {
      const r = await api(opts, "POST", `/tasks/${id}/materials`, {
        path,
        content,
        asset,
        ...(flag(rest, "--kind") ? { kind: flag(rest, "--kind") } : {}),
        ...(flag(rest, "--observed-at") ? { observedAt: flag(rest, "--observed-at") } : {}),
        ...(flag(rest, "--secret-ref") ? { secretRef: flag(rest, "--secret-ref") } : {}),
        source: flag(rest, "--source") ?? "operator-import",
        locator: flag(rest, "--locator") ?? "",
      });
      if (r.status >= 400) throw new Error(r.text);
      console.log(r.text);
    } finally {
      if (owned.close) await owned.close();
    }
    return;
  }

  if (cmd === "materials") {
    const id = rest[0];
    if (!id) throw new Error("gy materials <taskId>");
    const owned = await ensureServer(opts);
    try {
      const r = await api(opts, "GET", `/tasks/${id}/materials`);
      console.log(r.text);
    } finally {
      if (owned.close) await owned.close();
    }
    return;
  }

  if (cmd === "coverage-cell") {
    const id = rest[0];
    const asset = flag(rest, "--asset");
    const technique = flag(rest, "--technique");
    if (!id || !asset || !technique) throw new Error("gy coverage-cell <taskId> --asset A --technique CWE-89 --state manual");
    const owned = await ensureServer(opts);
    try {
      const r = await api(opts, "POST", `/tasks/${id}/coverage-cells`, {
        asset,
        technique,
        state: flag(rest, "--state") ?? "manual",
        reviewer: flag(rest, "--reviewer") ?? "operator",
        reason: flag(rest, "--reason") ?? "人工覆盖登记",
        evidenceRefs: (flag(rest, "--evidence") ?? "").split(",").map((v) => v.trim()).filter(Boolean),
      });
      if (r.status >= 400) throw new Error(r.text);
      console.log(r.text);
    } finally {
      if (owned.close) await owned.close();
    }
    return;
  }

  if (cmd === "matrix" || cmd === "freshness") {
    const id = rest[0];
    if (!id) throw new Error(`gy ${cmd} <taskId>`);
    const owned = await ensureServer(opts);
    try {
      const r = await api(opts, "GET", `/tasks/${id}/${cmd}`);
      if (r.status >= 400) throw new Error(r.text);
      console.log(r.text);
    } finally {
      if (owned.close) await owned.close();
    }
    return;
  }

  if (cmd === "changes") {
    const id = rest[0];
    if (!id) throw new Error("gy changes <taskId>");
    const owned = await ensureServer(opts);
    try {
      const r = await api(opts, "GET", `/tasks/${id}/changes`);
      console.log(r.text);
    } finally {
      if (owned.close) await owned.close();
    }
    return;
  }

  if (cmd === "change") {
    const id = rest[0];
    const kind = flag(rest, "--kind");
    const asset = flag(rest, "--asset");
    const location = flag(rest, "--location");
    const rollbackCmd = flag(rest, "--rollback");
    if (!id || !kind || !asset || !location || !rollbackCmd) {
      throw new Error("gy change <taskId> --kind K --asset A --location L --rollback CMD");
    }
    const before = flag(rest, "--before");
    const body = {
      kind,
      asset,
      location,
      rollbackCmd,
      registeredBy: flag(rest, "--by") ?? "operator",
      note: flag(rest, "--note") ?? "",
      ...(before ? { beforeMaterial: { path: `changes/${Date.now()}-before.txt`, content: readFileSync(resolve(before), "utf8") } } : {}),
    };
    const owned = await ensureServer(opts);
    try {
      const r = await api(opts, "POST", `/tasks/${id}/changes`, body);
      if (r.status >= 400) throw new Error(r.text);
      console.log(r.text);
    } finally {
      if (owned.close) await owned.close();
    }
    return;
  }

  if (cmd === "rollback") {
    const id = rest[0];
    const out = flag(rest, "--out");
    if (!id) throw new Error("gy rollback <taskId> [--out FILE]");
    const owned = await ensureServer(opts);
    try {
      const r = await api(opts, "GET", `/tasks/${id}/rollback`);
      if (r.status >= 400) throw new Error(r.text);
      if (out) {
        writeFileSync(resolve(out), r.text);
        console.log(`rollback script written: ${resolve(out)}`);
      } else {
        console.log(r.text);
      }
    } finally {
      if (owned.close) await owned.close();
    }
    return;
  }

  if (cmd === "graph" || cmd === "causality") {
    const id = rest[0];
    const target = rest[1];
    if (!id || !target) throw new Error(`gy ${cmd} <taskId> ${cmd === "graph" ? "assets|surface|execution|memory" : "<findingId>"}`);
    const owned = await ensureServer(opts);
    try {
      const r = await api(opts, "GET", cmd === "graph" ? `/tasks/${id}/graphs/${target}` : `/tasks/${id}/causality/${target}`);
      if (r.status >= 400) throw new Error(r.text);
      console.log(r.text);
    } finally {
      if (owned.close) await owned.close();
    }
    return;
  }

  if (cmd === "today") {
    const owned = await ensureServer(opts);
    try {
      const r = await api(opts, "GET", "/today");
      console.log(r.text);
    } finally {
      if (owned.close) await owned.close();
    }
    return;
  }

  if (cmd === "memory") {
    const sub = rest[0];
    const owned = await ensureServer(opts);
    try {
      if (sub === "list") {
        const r = await api(opts, "GET", "/memory/nodes");
        console.log(r.text);
      } else if (sub === "draft") {
        const file = flag(rest, "--file");
        if (!file) throw new Error("gy memory draft --file F");
        const r = await api(opts, "POST", "/memory/nodes", JSON.parse(readFileSync(resolve(file), "utf8")));
        if (r.status >= 400) throw new Error(r.text);
        console.log(r.text);
      } else if (sub === "review") {
        const id = rest[1];
        const decision = flag(rest, "--decision");
        if (!id || !decision) throw new Error("gy memory review <id> --decision confirm|retract --reviewer N --reason TEXT");
        const r = await api(opts, "POST", `/memory/nodes/${id}/review`, {
          decision,
          reviewer: flag(rest, "--reviewer") ?? "operator",
          reason: flag(rest, "--reason") ?? "",
        });
        if (r.status >= 400) throw new Error(r.text);
        console.log(r.text);
      } else if (sub === "refs") {
        const id = rest[1];
        if (!id) throw new Error("gy memory refs <id>");
        const r = await api(opts, "GET", `/memory/nodes/${id}/references`);
        console.log(r.text);
      } else if (sub === "inject") {
        const id = rest[1];
        if (!id) throw new Error("gy memory inject <taskId> [--asset A]");
        const r = await api(opts, "POST", `/tasks/${id}/memory/inject`, {
          ...(flag(rest, "--asset") ? { asset: flag(rest, "--asset") } : {}),
        });
        if (r.status >= 400) throw new Error(r.text);
        console.log(r.text);
      } else {
        throw new Error("gy memory list|draft|review|refs|inject");
      }
    } finally {
      if (owned.close) await owned.close();
    }
    return;
  }

  if (cmd === "contact") {
    const targets = flag(rest, "--targets");
    if (!targets) throw new Error("gy contact --targets A,B");
    const owned = await ensureServer(opts);
    try {
      const r = await api(opts, "GET", `/archive/contact?targets=${encodeURIComponent(targets)}`);
      console.log(r.text);
    } finally {
      if (owned.close) await owned.close();
    }
    return;
  }

  if (cmd === "proposals" || cmd === "proposal") {
    const owned = await ensureServer(opts);
    try {
      const id = rest[0];
      const r = cmd === "proposals" ? await api(opts, "GET", "/proposals") : await api(opts, "GET", `/proposals/${id ?? ""}`);
      if (r.status >= 400) throw new Error(r.text);
      console.log(r.text);
    } finally {
      if (owned.close) await owned.close();
    }
    return;
  }

  if (cmd === "proposal-create" || cmd === "eval-run") {
    const file = flag(rest, "--file");
    if (!file) throw new Error(`gy ${cmd} --file F`);
    const owned = await ensureServer(opts);
    try {
      const body = JSON.parse(readFileSync(resolve(file), "utf8"));
      const r = await api(opts, "POST", cmd === "proposal-create" ? "/proposals" : "/evaluations", body);
      if (r.status >= 400) throw new Error(r.text);
      console.log(r.text);
    } finally {
      if (owned.close) await owned.close();
    }
    return;
  }

  if (cmd === "proposal-decide" || cmd === "proposal-promote" || cmd === "proposal-rollback") {
    const id = rest[0];
    if (!id) throw new Error(`gy ${cmd} <id>`);
    const owned = await ensureServer(opts);
    try {
      const path = cmd === "proposal-decide" ? "decide" : cmd === "proposal-promote" ? "promote" : "rollback";
      const body = cmd === "proposal-decide"
        ? { decision: flag(rest, "--decision") ?? "approve", decidedBy: flag(rest, "--by") ?? "operator", reason: flag(rest, "--reason") ?? "" }
        : cmd === "proposal-promote"
          ? { promotedBy: flag(rest, "--by") ?? "operator", evaluationRunId: flag(rest, "--eval") ?? "" }
          : { rolledBackBy: flag(rest, "--by") ?? "operator", reason: flag(rest, "--reason") ?? "" };
      const r = await api(opts, "POST", `/proposals/${id}/${path}`, body);
      if (r.status >= 400) throw new Error(r.text);
      console.log(r.text);
    } finally {
      if (owned.close) await owned.close();
    }
    return;
  }

  if (cmd === "evals" || cmd === "trend") {
    const owned = await ensureServer(opts);
    try {
      const qs = new URLSearchParams();
      if (flag(rest, "--suite")) qs.set("suite", flag(rest, "--suite")!);
      if (flag(rest, "--tenant")) qs.set("tenantId", flag(rest, "--tenant")!);
      const r = await api(opts, "GET", `/${cmd === "evals" ? "evaluations" : "trends"}?${qs.toString()}`);
      console.log(r.text);
    } finally {
      if (owned.close) await owned.close();
    }
    return;
  }

  if (cmd === "role") {
    const id = rest[0];
    const role = flag(rest, "--role");
    const kind = flag(rest, "--kind");
    if (!id || !role || !kind) throw new Error("gy role <taskId> --role planner|reviewer|assistant --kind plan|review|incident");
    const file = flag(rest, "--file");
    const body = { role, kind, input: file ? JSON.parse(readFileSync(resolve(file), "utf8")) : {}, simulated: true };
    const owned = await ensureServer(opts);
    try {
      const r = await api(opts, "POST", `/tasks/${id}/roles`, body);
      if (r.status >= 400) throw new Error(r.text);
      console.log(r.text);
    } finally {
      if (owned.close) await owned.close();
    }
    return;
  }

  if (cmd === "provider-fault") {
    const id = rest[0];
    const provider = flag(rest, "--provider");
    const fault = flag(rest, "--fault");
    if (!id || !provider || !fault) throw new Error("gy provider-fault <taskId> --provider NAME --fault rate-limit");
    const owned = await ensureServer(opts);
    try {
      const r = await api(opts, "POST", `/tasks/${id}/provider`, {
        provider,
        fault,
        attempt: Number(flag(rest, "--attempt") ?? 0),
        fallbackAllowed: (flag(rest, "--fallback") ?? "false") === "true",
        billing: flag(rest, "--billing") ?? "none",
        tokens: flag(rest, "--tokens") ? Number(flag(rest, "--tokens")) : null,
      });
      if (r.status >= 400) throw new Error(r.text);
      console.log(r.text);
    } finally {
      if (owned.close) await owned.close();
    }
    return;
  }

  if (cmd === "inspect") {
    const id = rest[0];
    const dataRoot = resolveCanonicalDataRoot({
      installRoot: resolveInstallRoot(),
      explicit: opts.dataDir || undefined,
      envValue: process.env.GY_DATA_DIR,
    });
    const p = resolve(dataRoot, "tasks", id ?? "", "worker-status.json");
    if (!existsSync(p)) throw new Error(`missing ${p}`);
    console.log(readFileSync(p, "utf8"));
    return;
  }

  printHelp();
  process.exitCode = 1;
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});

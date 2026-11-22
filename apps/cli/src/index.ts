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

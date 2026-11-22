/**
 * 第九轮验收 harness：起停控制面、走 HTTP/CLI、记录「命令 / 输入 / 预期 / 实际」。
 * 只用于验收脚本，不进入产品运行时。
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { gitCodeInfo } from "./acceptance-manifest.js";

export type Step = {
  step: string;
  ok: boolean;
  expected: string;
  actual: string;
  detail?: string;
  at: string;
};

export type Plane = {
  base: string;
  proc: ChildProcess;
  dataDir: string;
  stop: () => Promise<void>;
  kill: () => void;
};

export const repoRoot = process.cwd();

export function sha256(bytes: Buffer | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export async function waitHealth(base: string, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${base}/health`);
      if (res.ok) return;
    } catch {
      /* retry */
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error(`control plane did not become healthy: ${base}`);
}

export async function startPlane(dataDir: string, port: number, env: Record<string, string> = {}): Promise<Plane> {
  mkdirSync(dataDir, { recursive: true });
  const proc = spawn(
    process.execPath,
    ["--import", "tsx", "apps/cli/src/index.ts", "serve", "--data-dir", dataDir, "--port", String(port)],
    { cwd: repoRoot, env: { ...process.env, GY_WATCHDOG_MS: "600000", ...env }, stdio: ["ignore", "pipe", "pipe"] },
  );
  const logs: string[] = [];
  proc.stdout?.on("data", (chunk: Buffer) => logs.push(chunk.toString()));
  proc.stderr?.on("data", (chunk: Buffer) => logs.push(chunk.toString()));
  const base = `http://127.0.0.1:${port}`;
  try {
    await waitHealth(base);
  } catch (error) {
    proc.kill("SIGKILL");
    throw new Error(`${String(error)}\n${logs.join("")}`);
  }
  return {
    base,
    proc,
    dataDir,
    async stop() {
      proc.kill("SIGTERM");
      await new Promise((resolve) => setTimeout(resolve, 300));
      if (!proc.killed) proc.kill("SIGKILL");
    },
    kill() {
      proc.kill("SIGKILL");
    },
  };
}

export async function httpJson<T = unknown>(
  base: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; body: T; text: string }> {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = text;
  }
  return { status: res.status, body: parsed as T, text };
}

export function gy(base: string, args: string[]): { status: number; stdout: string; stderr: string; command: string } {
  const command = `gy ${args.join(" ")} --base-url ${base}`;
  const result = spawnSync(
    process.execPath,
    ["--import", "tsx", "apps/cli/src/index.ts", ...args, "--base-url", base],
    { cwd: repoRoot, encoding: "utf8" as const, env: { ...process.env, GY_DATA_DIR: "" } },
  );
  return { status: result.status ?? -1, stdout: result.stdout ?? "", stderr: result.stderr ?? "", command };
}

export class Recorder {
  readonly steps: Step[] = [];
  constructor(
    readonly runId: string,
    readonly kind: string,
    readonly dataRoot: string,
  ) {}

  record(step: string, ok: boolean, expected: string, actual: string, detail?: string): boolean {
    this.steps.push({ step, ok, expected, actual, ...(detail ? { detail } : {}), at: new Date().toISOString() });
    console.log(`${ok ? "PASS" : "FAIL"}  ${step}  expected=${expected}  actual=${actual}`);
    if (!ok) throw new Error(`${step}: expected ${expected}, actual ${actual}`);
    return ok;
  }

  eq(step: string, actual: unknown, expected: unknown, detail?: string): boolean {
    return this.record(step, JSON.stringify(actual) === JSON.stringify(expected), JSON.stringify(expected), JSON.stringify(actual), detail);
  }

  truthy(step: string, value: unknown, expected = "truthy", detail?: string): boolean {
    return this.record(step, Boolean(value), expected, String(value), detail);
  }

  snapshot(): Step[] {
    return [...this.steps];
  }
}

export function writeRunRecord(input: {
  dir: string;
  runId: string;
  kind: string;
  taskId: string;
  dataRoot: string;
  startedAt: string;
  steps: Step[];
  summary: Record<string, unknown>;
  commands?: string[];
  notes?: string[];
  artifacts?: string[];
}): { recordJson: string; recordMd: string; manifest: string; hashes: Record<string, string> } {
  mkdirSync(input.dir, { recursive: true });
  const finishedAt = new Date().toISOString();
  // 源码脏检查：验收产物（docs/evidence/r9、.gongyuai、out）不算源码改动。
  const rawCode = gitCodeInfo();
  const sourceDirtyPaths = rawCode.dirtyPaths.filter((line) =>
    /(^|\s)(packages|apps|scripts)\/|(^|\s)package\.json$|pnpm-lock\.yaml$/.test(line),
  );
  const code = {
    ...rawCode,
    dirty: sourceDirtyPaths.length > 0,
    sourceDirtyPaths,
    evidenceOnlyDirty: rawCode.dirty && sourceDirtyPaths.length === 0,
  };
  const record = {
    version: 2,
    kind: input.kind,
    runId: input.runId,
    taskId: input.taskId,
    dataRoot: input.dataRoot,
    startedAt: input.startedAt,
    finishedAt,
    code,
    steps: {
      total: input.steps.length,
      passed: input.steps.filter((step) => step.ok).length,
      failed: input.steps.filter((step) => !step.ok).length,
      items: input.steps,
    },
    summary: input.summary,
    commands: input.commands ?? [],
    notes: input.notes ?? [],
    artifacts: input.artifacts ?? [],
  };
  const recordJson = writeJson(join(input.dir, "acceptance-record.json"), record);
  const md = renderMarkdown(record);
  const recordMd = join(input.dir, "acceptance-record.md");
  writeFileSync(recordMd, md);

  const files: Record<string, { path: string; sha256: string; bytes: number }> = {};
  for (const name of readdirSync(input.dir).sort()) {
    const abs = join(input.dir, name);
    if (!statSync(abs).isFile()) continue;
    const bytes = readFileSync(abs);
    files[name] = { path: name, sha256: sha256(bytes), bytes: bytes.length };
  }
  const manifest = {
    version: 2,
    kind: input.kind,
    runId: input.runId,
    taskId: input.taskId,
    dataRoot: input.dataRoot,
    startedAt: input.startedAt,
    finishedAt,
    code: record.code,
    steps: record.steps.total === 0 ? { total: 0, passed: 0, failed: 0 } : { total: record.steps.total, passed: record.steps.passed, failed: record.steps.failed },
    files,
    artifacts: collectArtifacts(input.dataRoot, input.taskId),
    commands: record.commands,
  };
  const manifestPath = writeJson(join(input.dir, "manifest.json"), manifest);
  return {
    recordJson,
    recordMd,
    manifest: manifestPath,
    hashes: {
      recordJson: files["acceptance-record.json"]?.sha256 ?? "",
      recordMd: files["acceptance-record.md"]?.sha256 ?? "",
      manifest: sha256(readFileSync(manifestPath)),
    },
  };
}

function writeJson(path: string, value: unknown): string {
  writeFileSync(path, JSON.stringify(value, null, 2));
  return path;
}

function renderMarkdown(record: {
  kind: string;
  runId: string;
  taskId: string;
  dataRoot: string;
  startedAt: string;
  finishedAt: string;
  code: ReturnType<typeof gitCodeInfo>;
  steps: { total: number; passed: number; failed: number; items: Step[] };
  summary: Record<string, unknown>;
  notes: string[];
}): string {
  const lines = [
    `# 第九轮验收记录：${record.kind}`,
    "",
    `- 运行 ID：\`${record.runId}\``,
    `- 任务 ID：\`${record.taskId}\``,
    `- 数据根：\`${record.dataRoot}\``,
    `- 代码：\`${record.code.commit ?? "unknown"}\`（dirty=${record.code.dirty}）`,
    `- 时间：${record.startedAt} → ${record.finishedAt}`,
    `- 步骤：${record.steps.passed}/${record.steps.total} 通过，${record.steps.failed} 失败`,
    "",
    "## 步骤（命令 / 输入 / 预期 / 实际）",
    "",
    "| # | 步骤 | 预期 | 实际 | 结果 |",
    "| --- | --- | --- | --- | --- |",
    ...record.steps.items.map(
      (step, index) =>
        `| ${index + 1} | ${escapeCell(step.step)} | ${escapeCell(step.expected)} | ${escapeCell(step.actual)} | ${step.ok ? "PASS" : "FAIL"} |`,
    ),
    "",
    "## 汇总",
    "",
    "```json",
    JSON.stringify(record.summary, null, 2),
    "```",
    "",
  ];
  if (record.notes.length) {
    lines.push("## 说明", "", ...record.notes.map((note) => `- ${note}`), "");
  }
  return lines.join("\n");
}

function escapeCell(value: string): string {
  return value.replace(/\|/g, "\\|").replace(/\n/g, " ");
}

function collectArtifacts(dataRoot: string, taskId: string): Array<{ path: string; sha256: string; bytes: number }> {
  const evidenceDir = join(dataRoot, "tasks", taskId, "evidence");
  if (!existsSync(evidenceDir)) return [];
  const out: Array<{ path: string; sha256: string; bytes: number }> = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const abs = join(dir, entry.name);
      if (entry.isDirectory()) walk(abs);
      else if (entry.isFile()) {
        const bytes = readFileSync(abs);
        out.push({ path: relative(evidenceDir, abs), sha256: sha256(bytes), bytes: bytes.length });
      }
    }
  };
  walk(evidenceDir);
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

export function roomPort(): number {
  return 19_000 + (process.pid % 700);
}

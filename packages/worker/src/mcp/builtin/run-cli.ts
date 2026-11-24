import { checkCommandRun, commandProposal, reviewBeforeDispatch } from "../../command-guard.js";
import { spawnSync } from "node:child_process";
import { authorizeCommand } from "@gongyuai/exec";
import type { ToolContext } from "../../tools.js";
import { writeEvidence } from "../../tools.js";

export async function runCliTool(
  ctx: ToolContext,
  opts: {
    binary: string;
    args: string[];
    evidenceRel: string;
    timeoutMs?: number;
  },
): Promise<{ exitCode: number; stdout: string; stderr: string; evidencePath: string }> {
  const quoted = opts.args.map((a) => JSON.stringify(a)).join(" ");
  const cmd = `${opts.binary} ${quoted}`;
  checkCommandRun(ctx.manifest);
  const literalPrint = opts.binary === "/usr/bin/printf" && opts.args.length > 0 && opts.args.length <= 8 && /^[a-zA-Z0-9_./-]+%?$/.test(opts.args[0]!) &&
    opts.args.every(a => /^[a-zA-Z0-9_./%-]{1,120}$/.test(a)) && !opts.args.some(a => /%[0-9]/.test(a));
  // 提案必须携带真实命令：控制面按任务坐标裁决（与 shell 同一闸），
  // 缺 command 的旧提案会被降级成 localProbe 白名单直接拦截。
  const verdict = authorizeCommand(ctx.manifest.auth, cmd);
  if (!verdict.allowed) throw new Error(`denied: ${verdict.reason}`);
  if (!literalPrint) await reviewBeforeDispatch(ctx.manifest, {
    ...commandProposal("cli", opts.binary, opts.args),
    command: cmd,
    hosts: verdict.hosts,
    need: verdict.need,
  });
  checkCommandRun(ctx.manifest);
  const result = spawnSync(opts.binary, opts.args, {
    cwd: ctx.manifest.workspaceDir,
    encoding: "utf8",
    timeout: opts.timeoutMs ?? 180_000,
    env: process.env,
  });
  const stdout = result.stdout ?? "";
  const stderr = result.stderr ?? "";
  const exitCode = result.status ?? 1;
  const body = [
    `# ${opts.binary}`,
    `cmd: ${cmd}`,
    `exit: ${exitCode}`,
    "",
    "## stdout",
    stdout.slice(0, 200_000),
    "",
    "## stderr",
    stderr.slice(0, 50_000),
    "",
  ].join("\n");
  const evidencePath = writeEvidence(ctx, opts.evidenceRel, body);
  return { exitCode, stdout, stderr, evidencePath };
}

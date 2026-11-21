import { spawnSync } from "node:child_process";
import type { ToolContext } from "../../tools.js";
import { writeEvidence } from "../../tools.js";

export function runCliTool(
  ctx: ToolContext,
  opts: {
    binary: string;
    args: string[];
    evidenceRel: string;
    timeoutMs?: number;
  },
): { exitCode: number; stdout: string; stderr: string; evidencePath: string } {
  const quoted = opts.args.map((a) => JSON.stringify(a)).join(" ");
  const cmd = `${opts.binary} ${quoted}`;
  const result = spawnSync("bash", ["-lc", cmd], {
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

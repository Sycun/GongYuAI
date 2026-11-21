import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync, existsSync, appendFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { WorkerManifest } from "@gongyuai/contracts";
import type { HistoryStore } from "@gongyuai/history";

export type ToolContext = {
  manifest: WorkerManifest;
  history: HistoryStore;
  usage: { toolCalls: number; installs: number };
};

function assertInScope(manifest: WorkerManifest, command: string): void {
  // Soft check: refuse obvious out-of-scope hosts if present as bare IPs/URLs not in targets
  const targets = manifest.auth.targets.map((t) => t.toLowerCase());
  const urlMatch = command.match(/https?:\/\/([^/\s:]+)/i);
  if (urlMatch) {
    const host = urlMatch[1]!.toLowerCase();
    const ok = targets.some((t) => t.includes(host) || host.includes(t.replace(/^https?:\/\//, "")));
    if (!ok && !targets.includes("*")) {
      throw new Error(`target host ${host} not in auth.targets`);
    }
  }
}

export function runShell(ctx: ToolContext, command: string, timeoutMs = 120_000): {
  exitCode: number;
  stdout: string;
  stderr: string;
} {
  assertInScope(ctx.manifest, command);
  ctx.usage.toolCalls += 1;
  if (ctx.usage.toolCalls > ctx.manifest.budget.maxToolCalls) {
    throw new Error("maxToolCalls exceeded");
  }
  const result = spawnSync("bash", ["-lc", command], {
    cwd: ctx.manifest.workspaceDir,
    encoding: "utf8",
    timeout: timeoutMs,
    env: process.env,
  });
  return {
    exitCode: result.status ?? 1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

export function writeEvidence(
  ctx: ToolContext,
  relativePath: string,
  content: string,
): string {
  const abs = join(ctx.manifest.evidenceDir, relativePath);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content);
  return relativePath.replace(/\\/g, "/");
}

export function installTool(
  ctx: ToolContext,
  spec: { name: string; method?: "apt" | "which"; package?: string },
): { ok: boolean; detail: string } {
  if (ctx.usage.installs >= ctx.manifest.budget.maxInstalls) {
    return { ok: false, detail: "maxInstalls exceeded" };
  }
  const name = spec.name;
  const which = spawnSync("bash", ["-lc", `command -v ${JSON.stringify(name)}`], {
    encoding: "utf8",
  });
  if ((which.status ?? 1) === 0) {
    ctx.history.recordInstall(ctx.manifest.taskId, name, { alreadyPresent: true });
    return { ok: true, detail: `${name} already present at ${which.stdout.trim()}` };
  }

  ctx.usage.installs += 1;
  const pkg = spec.package ?? name;
  const method = spec.method ?? "apt";
  let cmd: string;
  if (method === "apt") {
    cmd = `sudo DEBIAN_FRONTEND=noninteractive apt-get update -qq && sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq ${pkg}`;
  } else {
    return { ok: false, detail: `unknown install method ${method}` };
  }

  // Local/dev fallback: create a stub shim so smoke can proceed without root/apt
  if (process.env.GY_ALLOW_STUB_INSTALL === "1" || process.platform === "darwin") {
    const binDir = join(ctx.manifest.workspaceDir, ".bin");
    mkdirSync(binDir, { recursive: true });
    const stub = join(binDir, name);
    writeFileSync(
      stub,
      `#!/usr/bin/env bash\necho \"${name} stub (dev install)\"\nexit 0\n`,
      { mode: 0o755 },
    );
    const pathFile = join(ctx.manifest.workspaceDir, ".path");
    appendFileSync(pathFile, `${binDir}\n`);
    process.env.PATH = `${binDir}:${process.env.PATH ?? ""}`;
    ctx.history.recordInstall(ctx.manifest.taskId, name, {
      method: "stub",
      path: stub,
    });
    writeEvidence(
      ctx,
      `installs/${name}.txt`,
      `installed stub for ${name} at ${stub}\n`,
    );
    return { ok: true, detail: `stub-installed ${name} (dev)` };
  }

  const result = spawnSync("bash", ["-lc", cmd], {
    encoding: "utf8",
    timeout: 600_000,
  });
  const ok = (result.status ?? 1) === 0;
  const verify = spawnSync("bash", ["-lc", `command -v ${JSON.stringify(name)}`], {
    encoding: "utf8",
  });
  const present = (verify.status ?? 1) === 0;
  ctx.history.recordInstall(ctx.manifest.taskId, name, {
    method,
    package: pkg,
    ok: ok && present,
    stdout: (result.stdout ?? "").slice(-2000),
    stderr: (result.stderr ?? "").slice(-2000),
  });
  writeEvidence(
    ctx,
    `installs/${name}.txt`,
    `method=${method}\nok=${ok && present}\n${result.stdout}\n${result.stderr}\n`,
  );
  return {
    ok: ok && present,
    detail: present
      ? `installed ${name}`
      : `install failed: ${result.stderr || result.stdout}`,
  };
}

export function appendProgress(workspaceDir: string, line: string): void {
  const path = join(workspaceDir, "PROGRESS.md");
  if (!existsSync(path)) {
    writeFileSync(path, `# 执行进度\n\n`);
  }
  appendFileSync(path, `- ${new Date().toISOString()} ${line}\n`);
}

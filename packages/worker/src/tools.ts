import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync, existsSync, appendFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { AuthCapability, WorkerManifest } from "@gongyuai/contracts";
import type { HistoryStore } from "@gongyuai/history";

const CAPABILITY_RANK: Record<AuthCapability, number> = {
  observe: 0,
  scan: 1,
  "active-lab": 2,
  full: 3,
};

/** True if task capability is at least `need`. */
export function capabilityAtLeast(
  have: AuthCapability | undefined,
  need: AuthCapability,
): boolean {
  const h = CAPABILITY_RANK[have ?? "observe"] ?? 0;
  return h >= CAPABILITY_RANK[need];
}

/**
 * Tool-surface gate by auth.capability ladder.
 * Host VPN/proxy mutations remain denied at every level.
 */
export function assertCapabilityAllows(
  manifest: WorkerManifest,
  action: "shell" | "install" | "mcp-scan" | "mcp-active",
): void {
  const cap = manifest.auth.capability ?? "observe";
  if (action === "shell" && !capabilityAtLeast(cap, "scan")) {
    throw new Error(
      `denied: shell requires auth.capability≥scan (have ${cap}); observe is read-only`,
    );
  }
  if (action === "install" && !capabilityAtLeast(cap, "scan")) {
    throw new Error(`denied: install_tool requires auth.capability≥scan (have ${cap})`);
  }
  if (action === "mcp-scan" && !capabilityAtLeast(cap, "scan")) {
    throw new Error(`denied: scan MCP requires auth.capability≥scan (have ${cap})`);
  }
  if (action === "mcp-active" && !capabilityAtLeast(cap, "active-lab")) {
    throw new Error(
      `denied: active MCP requires auth.capability≥active-lab (have ${cap})`,
    );
  }
}

/** Core recon MCP ids allowed at scan; the rest need active-lab+. */
const SCAN_MCP_IDS = new Set(["nmap", "httpx", "gobuster", "ffuf"]);

export function mcpActionForServer(serverId: string): "mcp-scan" | "mcp-active" {
  const id = serverId.replace(/^mcp__/, "").split("__")[0] ?? serverId;
  if (SCAN_MCP_IDS.has(id) || SCAN_MCP_IDS.has(serverId)) return "mcp-scan";
  return "mcp-active";
}

export type ToolContext = {
  manifest: WorkerManifest;
  history: HistoryStore;
  usage: { toolCalls: number; installs: number };
};

/** Host-network / proxy mutations — always denied (lab VPN must be pre-connected). */
const HOST_NETWORK_DENY =
  /\b(route\s+(add|delete|change|flush)|ip\s+route\s+(add|del|change|replace)|networksetup\b|scutil\s+--nc|pfctl\b|iptables\b|ip6tables\b|nft\s+|sysctl\s+.*\bnet\.|launchctl\s+(load|unload).*vpn|osascript[^\n]*Viscosity|viscosity\s+(connect|disconnect)|set\s+system\s+proxy|networksetup\s+-set(web|secureweb|socks)proxy|mitmproxy\s+--mode\s+local|proxychains|tsocks\b)/i;

const DESTRUCTIVE_DENY =
  /\b(rm\s+-rf\s+\/|mkfs\.|dd\s+if=.*of=\/dev\/|diskutil\s+erase|shutdown\b|reboot\b|halt\b)\b/i;

function parseIpv4(host: string): number | null {
  const m = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return null;
  const parts = m.slice(1).map(Number);
  if (parts.some((n) => n > 255)) return null;
  return ((parts[0]! << 24) | (parts[1]! << 16) | (parts[2]! << 8) | parts[3]!) >>> 0;
}

function cidrContains(cidr: string, host: string): boolean {
  const [base, bitsRaw] = cidr.split("/");
  if (!base || bitsRaw == null) return false;
  const ip = parseIpv4(host);
  const net = parseIpv4(base);
  const bits = Number(bitsRaw);
  if (ip == null || net == null || !Number.isInteger(bits) || bits < 0 || bits > 32) {
    return false;
  }
  if (bits === 0) return true;
  const mask = bits === 32 ? 0xffffffff : (~((1 << (32 - bits)) - 1)) >>> 0;
  return (ip & mask) === (net & mask);
}

export function hostInTargets(targets: string[], host: string): boolean {
  const h = host.toLowerCase().replace(/\.$/, "");
  if (!h) return false;
  if (targets.some((t) => t.trim() === "*")) return true;
  for (const raw of targets) {
    const t = raw.trim().toLowerCase();
    if (!t) continue;
    if (t.includes("/")) {
      const bare = t.replace(/^https?:\/\//, "").split("/")[0]!;
      // CIDR like 10.0.0.0/8
      if (/^\d+\.\d+\.\d+\.\d+\/\d+$/.test(t) && cidrContains(t, h)) return true;
      if (h === bare || h.endsWith(`.${bare}`)) return true;
      continue;
    }
    const bare = t.replace(/^https?:\/\//, "").split("/")[0]!.split(":")[0]!;
    if (h === bare || h.endsWith(`.${bare}`) || bare.includes(h) || h.includes(bare)) {
      return true;
    }
  }
  return false;
}

export function extractHosts(command: string): string[] {
  const hosts = new Set<string>();
  const patterns = [
    /https?:\/\/([^/\s:]+)/gi,
    /\b(?:curl|wget|nc|ncat|nmap|ffuf|httpx)\b[^\n]*?\s(?:-H\s+\S+\s+)*['"]?(?:https?:\/\/)?(\d{1,3}(?:\.\d{1,3}){3})(?:[:/\s'"]|$)/gi,
    /\b(?:curl|wget)\s+[^\n]*?\s(\d{1,3}(?:\.\d{1,3}){3})(?:[:/\s]|$)/gi,
  ];
  for (const re of patterns) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(command))) {
      const host = m[1]?.toLowerCase();
      if (host && host !== "localhost" && host !== "127.0.0.1") hosts.add(host);
    }
  }
  return [...hosts];
}

export function assertCommandAllowed(manifest: WorkerManifest, command: string): void {
  assertCapabilityAllows(manifest, "shell");
  if (HOST_NETWORK_DENY.test(command)) {
    throw new Error(
      "denied: host network/VPN/proxy mutation is forbidden; connect lab VPN before the task",
    );
  }
  if (DESTRUCTIVE_DENY.test(command)) {
    throw new Error("denied: destructive host command");
  }

  const targets = manifest.auth.targets;
  if (!targets.length) {
    throw new Error("auth.targets is empty");
  }

  const hosts = extractHosts(command);
  for (const host of hosts) {
    if (!hostInTargets(targets, host)) {
      throw new Error(`target host ${host} not in auth.targets`);
    }
  }
}

export function runShell(
  ctx: ToolContext,
  command: string,
  timeoutMs = 120_000,
): {
  exitCode: number;
  stdout: string;
  stderr: string;
} {
  assertCommandAllowed(ctx.manifest, command);
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
    stdout: (result.stdout ?? "").slice(0, 32_000),
    stderr: (result.stderr ?? "").slice(0, 8_000),
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
  assertCapabilityAllows(ctx.manifest, "install");
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

/** 北京时间戳 */
export function beijingStamp(d = new Date()): string {
  const t = new Date(d.getTime() + 8 * 3600_000);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${t.getUTCFullYear()}-${p(t.getUTCMonth() + 1)}-${p(t.getUTCDate())} ${p(t.getUTCHours())}:${p(t.getUTCMinutes())}`;
}

export function appendProgress(workspaceDir: string, line: string): void {
  const path = join(workspaceDir, "PROGRESS.md");
  if (!existsSync(path)) {
    writeFileSync(path, `# 执行进度\n\n`);
  }
  appendFileSync(path, `- ${beijingStamp()} ${line}\n`);
}

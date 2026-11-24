import { pivotCidrs, targetAllows, type AuthCapability, type PivotPolicy } from "@gongyuai/contracts";

/**
 * 执行期坐标判定（shell / 会话 / C2 共用一个闸）。
 *
 * P16 — 按任务坐标与操作配置裁决，不做目标合法性审查（red-team-positioning.md）：
 * - 返回结构化判定（需要什么能力档位、命中哪些目标、越界在哪），供审批卡与模型共用；
 * - 命令文本本身进入台账（审批要看到真实动作），摘要只用于列表；
 * - 工程自保（主机网络/破坏性）确定性拒绝，与目标无关，不依赖模型；
 * - 本地动作（无外部主机）不要求坐标白名单：能力档位 ≥ scan 即可执行，仍受审批闸控制。
 */

export type AuthSnapshot = {
  targets: string[];
  outOfScope?: string[];
  capability?: AuthCapability;
  /** P14-B4 — declared internal pivot CIDRs (operator-written). */
  pivotPolicy?: PivotPolicy;
};

export type CommandClass = "read" | "exec" | "destructive" | "host-network";

export type CommandVerdict = {
  allowed: boolean;
  reason: string;
  hosts: string[];
  outOfScopeHits: string[];
  need: AuthCapability;
  klass: CommandClass;
};

const CAP_RANK: Record<AuthCapability, number> = {
  observe: 0,
  scan: 1,
  "active-lab": 2,
  full: 3,
};

export function capabilityAtLeast(have: AuthCapability | undefined, need: AuthCapability): boolean {
  return (CAP_RANK[have ?? "observe"] ?? 0) >= (CAP_RANK[need] ?? 0);
}

/** 主机网络/代理/VPN 变更：任何能力级都拒绝（实验室线路须预先接好）；只读状态查询（scutil --nc 的 list/status/probe、networksetup 的 -get 与 -list 系列）放行。 */
const HOST_NETWORK_DENY =
  /\b(route\s+(add|delete|change|flush)|ip\s+route\s+(add|del|change|replace)|networksetup\s+-(?!get|list)\w|scutil\s+--nc\s+(?!list\b|status\b|probe\b)\w|pfctl\b|iptables\b|ip6tables\b|nft\s+|sysctl\s+.*\bnet\.|launchctl\s+(load|unload).*vpn|osascript[^\n]*Viscosity|viscosity\s+(connect|disconnect)|set\s+system\s+proxy|mitmproxy\s+--mode\s+local|proxychains|tsocks\b)/i;

/** 不可回滚的本机破坏动作。pkill/killall 可能误杀无关进程，属工程自保拒绝；后台作业用 shell_job kill。 */
const DESTRUCTIVE_DENY =
  /\b(rm\s+-rf?\s+\/(?!\/)|mkfs\.|dd\s+if=.*of=\/dev\/|diskutil\s+erase|shutdown\b|reboot\b|halt\b|pkill\b|killall\b|chmod\s+-R\s+777\s+\/|:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:|\.\s+\/dev\/sd[a-z])/i;

const RECON_VERBS = new Set([
  "nmap", "masscan", "naabu", "httpx", "httprobe", "whatweb", "wafw00f", "whatweb",
  "gobuster", "ffuf", "feroxbuster", "dirsearch", "dirb", "wfuzz", "arjun", "paramspider",
  "subfinder", "amass", "assetfinder", "findomain", "dnsx", "dnsrecon", "dig", "host", "nslookup",
  "whois", "theharvester", "sublist3r", "katana", "gau", "waybackurls", "hakrawler", "gospider",
  "nikto", "nuclei", "wpscan", "joomscan", "droopescan", "enum4linux", "enum4linux-ng", "smbmap",
  "showmount", "snmpwalk", "onesixtyone", "curl", "wget", "openssl", "ping", "traceroute", "mtr",
  "nbtscan", "ldapsearch", "rpcclient", "swaks", "dnsenum", "fierce", "sslscan", "testssl",
]);

const POST_VERBS = new Set([
  "mimikatz", "cobaltstrike", "sliver", "havoc", "empire", "responder", "mitm6", "ntlmrelayx", "petitpotam",
]);

const EXPLOIT_VERBS = new Set([
  "sqlmap", "hydra", "medusa", "patator", "nc", "ncat", "netcat", "socat", "ssh", "scp", "sftp",
  "smbclient", "evil-winrm", "xfreerdp", "rdesktop", "msfconsole", "msfvenom", "meterpreter",
  "searchsploit", "commix", "tplmap", "ysoserial", "jwt_tool", "hashcat", "john", "aircrack-ng",
  "reaver", "bettercap", "secretsdump", "psexec", "wmiexec", "smbexec", "atexec",
  "dcomexec", "chisel", "ligolo", "proxychains4", "rubeus", "certipy", "bloodhound", "sharphound",
  "kerbrute", "impacket", "crackmapexec", "netexec", "nxc",
]);

function isValidIpv4(ip: string): boolean {
  const parts = ip.split(".");
  if (parts.length !== 4) return false;
  return parts.every((p) => {
    if (!/^\d{1,3}$/.test(p)) return false;
    const n = Number(p);
    return n >= 0 && n <= 255;
  });
}

/**
 * 从命令里抽取真正的网络目标主机；loopback 不算外部目标。
 * 先提取显式 URL 的 authority 并剥离 URL 路径/查询参数与 HTTP 请求体数据，
 * 避免把 `/socket.io/`、查询串邮箱 `admin@example.com`、版本号 `Apache/2.4.49.1` 误判为越界主机。
 */
export function extractHosts(command: string): string[] {
  const hosts = new Set<string>();
  const push = (raw: string | undefined) => {
    if (!raw) return;
    let h = raw.trim().toLowerCase();
    h = h.replace(/^["'`(]+|["'`),;]+$/g, "");
    h = h.replace(/^[a-z][a-z0-9+.-]*:\/\//i, "");
    h = h.split("/")[0] ?? h;
    h = h.split("?")[0] ?? h;
    h = h.replace(/^\[|\]$/g, "");
    // Strip userinfo@ prefix if present on authority
    if (h.includes("@")) h = h.split("@").pop() ?? h;
    const m = /^([^:\s]+?)(?::\d+)?$/.exec(h);
    if (!m) return;
    h = m[1]!;
    if (!h || h === "localhost" || h === "127.0.0.1" || h === "::1" || h === "0.0.0.0") return;
    if (/^\d+\.\d+\.\d+\.\d+$/.test(h) && !isValidIpv4(h)) return;
    hosts.add(h);
  };

  // 1) Extract explicit scheme://authority URLs first, then blank out the full URL (including path & query)
  // so path segments like `/socket.io/` or `?email=a@example.com` are not re-scanned as hosts.
  const urlRe = /\b(?:https?|wss?|ftp|ldap|ldaps|smb|ssh|redis|mysql|postgres|postgresql):\/\/([^/\s'"`]+)(?:\/[^\s'"`]*)?/gi;
  let scrubbed = command.replace(urlRe, (_full, authority: string) => {
    push(authority);
    return " __URL__ ";
  });

  // 2) If command already has an explicit URL target, strip inline curl/http body flags (-d / --data*)
  // so form/JSON payload fields (like `{"email":"admin@example.com"}`) do not trigger false OOS blocks.
  if (hosts.size > 0) {
    scrubbed = scrubbed.replace(
      /\s(?:-d|--data|--data-raw|--data-binary|--data-urlencode)\s+(?:'[^']*'|"[^"]*"|\S+)/g,
      " ",
    );
  }

  // 3) Explicit host flags (-h / --host / -u / --target / Host: header)
  const flagPatterns: RegExp[] = [
    /\b(?:-h|--host|--url|-u|--target|-t|--domain|--ip|--address)\s+['"]?([a-z0-9.-]+(?::\d+)?)/gi,
    /\bHost:\s*([a-z0-9.-]+(?::\d+)?)/gi,
  ];
  for (const re of flagPatterns) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(scrubbed))) push(m[1]);
  }

  // 4) SSH/SCP user@host (only when preceded by whitespace or quote, avoiding inline JSON/form emails when possible)
  const sshRe = /(?:^|[\s'"`])(?:[a-z0-9._-]+)@(\d{1,3}(?:\.\d{1,3}){3}|(?:[a-z0-9-]+\.)+(?:local|internal|lan|test|example|com|net|org|io|cn))\b/gi;
  {
    let m: RegExpExecArray | null;
    while ((m = sshRe.exec(scrubbed))) push(m[1]);
  }

  // 5) Bare IPv4 addresses (exclude version strings like `v1.2.3.4` or `/2.4.49.1` or `1.2.3.4.5`)
  const ipRe = /(?<![a-zA-Z0-9./-])(\d{1,3}(?:\.\d{1,3}){3})(?::\d+)?(?![.\d])/g;
  {
    let m: RegExpExecArray | null;
    while ((m = ipRe.exec(scrubbed))) push(m[1]);
  }

  // 6) Bare domain names (must NOT be preceded by `/`, `.`, or `@` so file paths like `/socket.io` are ignored)
  const domainRe = /(?<![a-zA-Z0-9/_.-])(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+(?:com|net|org|io|cn|co|info|biz|dev|app|cloud|site|xyz|top|me|tv|cc|edu|gov|mil|local|internal|lan|test|example)(?::\d+)?\b/gi;
  {
    let m: RegExpExecArray | null;
    while ((m = domainRe.exec(scrubbed))) push(m[0]);
  }

  return [...hosts];
}

/**
 * P14-B7 — shell-lexical tokens: quoted payloads become their own token so
 * `bash -c 'mimikatz'` is classified by the payload, not by `bash`.
 */
export function shellTokens(command: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quote: string | null = null;
  for (const ch of command) {
    if (quote) {
      if (ch === quote) {
        quote = null;
        for (const part of cur.split(/\s+/)) if (part) out.push(part);
        cur = "";
        continue;
      }
      cur += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      if (cur) out.push(cur);
      cur = "";
      quote = ch;
      continue;
    }
    if (/[\s;|&()`$]/.test(ch)) {
      if (cur) out.push(cur);
      cur = "";
      continue;
    }
    cur += ch;
  }
  if (cur) out.push(cur);
  return out;
}

function verbName(token: string): string {
  const base = token.split("/").pop() ?? token;
  return base
    .replace(/[^a-zA-Z0-9_.+-]/g, "")
    .replace(/\.(exe|py|pl|rb|sh|bin)$/i, "")
    .toLowerCase();
}

function firstVerb(command: string): string {
  const trimmed = command.trim().replace(/^(?:sudo|env|time|timeout\s+\S+|nice|nohup)\s+/i, "");
  const m = /^([a-zA-Z0-9_.+-]+)/.exec(trimmed.split(/[\s;|&(]/)[0] ?? "");
  return (m?.[1] ?? "").toLowerCase();
}

export function classifyCommand(command: string): CommandClass {
  if (HOST_NETWORK_DENY.test(command)) return "host-network";
  if (DESTRUCTIVE_DENY.test(command)) return "destructive";
  const tokens = shellTokens(command);
  // Parameter-level check: a destructive payload carried inside quotes or a
  // different token still counts (`bash -c "rm -rf /"`, `sh -c '...'`).
  for (const token of tokens) {
    if (DESTRUCTIVE_DENY.test(token)) return "destructive";
    if (HOST_NETWORK_DENY.test(token)) return "host-network";
  }
  const verb = firstVerb(command);
  const verbs = new Set(tokens.map(verbName));
  if ([...verbs].some((v) => POST_VERBS.has(v))) return "exec";
  if (RECON_VERBS.has(verb)) return "read";
  return "exec";
}

function capabilityFor(command: string, hosts: string[]): AuthCapability {
  const verb = firstVerb(command);
  const verbs = new Set(shellTokens(command).map(verbName));
  // Highest-risk verb wins even when wrapped in an interpreter.
  if (verbs.has(verb) && POST_VERBS.has(verb)) return "full";
  if ([...verbs].some((v) => POST_VERBS.has(v))) return "full";
  if ([...verbs].some((v) => EXPLOIT_VERBS.has(v))) return "active-lab";
  if (EXPLOIT_VERBS.has(verb)) return "active-lab";
  if (hosts.length && !RECON_VERBS.has(verb)) return "active-lab";
  if (hosts.length) return "scan";
  return "scan";
}

/**
 * 命令坐标判定。`extraHosts` 用于会话/C2：把会话对端主机并入本次判定。
 */
export function authorizeCommand(
  auth: AuthSnapshot,
  command: string,
  opts: { extraHosts?: string[] } = {},
): CommandVerdict {
  const klass = classifyCommand(command);
  const hosts = [...new Set([...extractHosts(command), ...(opts.extraHosts ?? [])])];
  const outOfScopeHits: string[] = [];
  const need = capabilityFor(command, hosts);
  const base = { hosts, outOfScopeHits, need, klass };

  if (!command.trim()) {
    return { ...base, allowed: false, reason: "空命令" };
  }
  if (klass === "host-network") {
    return { ...base, allowed: false, reason: "主机网络/VPN/代理变更被拒绝：请在任务外接好实验线路" };
  }
  if (klass === "destructive") {
    return { ...base, allowed: false, reason: "不可回滚的本机破坏命令被拒绝" };
  }
  if (!auth.targets.length) {
    return { ...base, allowed: false, reason: "任务目标坐标为空：先在任务里补充目标（needs_input 澄清）" };
  }
  const pivot = pivotCidrs(auth);
  for (const host of hosts) {
    if (!targetAllows(auth.targets, host, auth.outOfScope ?? [], pivot)) outOfScopeHits.push(host);
  }
  if (outOfScopeHits.length) {
    return {
      ...base,
      allowed: false,
      reason: `目标越界：${outOfScopeHits.join("、")} 不在任务目标坐标内（或命中排除项）`,
    };
  }
  if (!capabilityAtLeast(auth.capability, need)) {
    return {
      ...base,
      allowed: false,
      reason: `能力档位不足：该动作需要 ${need}，当前 ${auth.capability ?? "observe"}`,
    };
  }
  return {
    ...base,
    allowed: true,
    reason: hosts.length
      ? `任务坐标内：${hosts.join("、")}（需要 ${need}，已满足）`
      : `本地动作（需要 ${need}，已满足）`,
  };
}

/** C2 会话对端坐标判定：对端必须在任务坐标内（loopback 视为实验室本机）。 */
export function authorizePeer(auth: AuthSnapshot, peer: string): { allowed: boolean; reason: string } {
  const host = peer.trim().toLowerCase().replace(/^::ffff:/, "");
  if (host === "127.0.0.1" || host === "::1" || host === "localhost") {
    return { allowed: true, reason: "loopback（实验本机）" };
  }
  if (!auth.targets.length) return { allowed: false, reason: "任务目标坐标为空：先在任务里补充目标（needs_input 澄清）" };
  if (targetAllows(auth.targets, host, auth.outOfScope ?? [], pivotCidrs(auth))) {
    return { allowed: true, reason: `对端 ${host} 在任务坐标内` };
  }
  return { allowed: false, reason: `对端 ${host} 不在任务坐标内：只记录不回连任务` };
}

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import {
  isBudgetHit,
  type ToolCatalogEntry,
  type WorkerMcpServer,
  type WorkerSkillPack,
} from "@gongyuai/contracts";
import { commandProposal, reviewBeforeDispatch } from "./command-guard.js";
import type { McpHub } from "./mcp/client.js";
import type { SkillHub } from "./skills/runtime.js";
import { findInstalledBinary, KALI_APT_PACKAGES } from "./tool-installer.js";
import {
  appendProgress,
  assertCapabilityAllows,
  gateTool,
  installTool,
  writeEvidence,
  type ToolContext,
} from "./tools.js";

/** Minimum GitHub stars required for non-official community MCP/Skill repos. */
export const MIN_COMMUNITY_STARS = 500;

/** Official / well-known security & MCP organizations (lowercase). */
export const OFFICIAL_TRUSTED_OWNERS = new Set([
  "modelcontextprotocol",
  "anthropics",
  "microsoft",
  "github",
  "cloudflare",
  "projectdiscovery",
  "owasp",
  "portswigger",
  "chromedevtools",
  "vercel",
  "vercel-labs",
  "kali-linux",
  "swisskyrepo",
  "hacktricks-wiki",
  "ffuf",
  "hahwul",
  "hakluke",
  "sqlmapproject",
  "upstash",
]);

/** Trusted npm scopes for stdio MCP packages. */
export const OFFICIAL_NPM_SCOPES = new Set([
  "@modelcontextprotocol",
  "@playwright",
  "@anthropic-ai",
  "@github",
  "@cloudflare",
  "@vercel",
  "@upstash",
  "@browserbasehq",
]);

export type CuratedMcpEntry = {
  id: string;
  name: string;
  description: string;
  category: string;
  source: string;
  transport: "stdio";
  command: string;
  args: string[];
  capability: "observe" | "scan" | "active-lab" | "full";
  whenToUse: string;
};

/**
 * Curated official & high-star community MCP servers (non-Kali-overlapping).
 * Tools already covered by Kali builtin MCPs (nmap, sqlmap, nuclei, ffuf, etc.)
 * are intentionally excluded so Kali-integrated binaries are always preferred.
 */
export const CURATED_OFFICIAL_MCPS: Record<string, CuratedMcpEntry> = {
  fetch: {
    id: "fetch",
    name: "MCP Fetch (Official)",
    description: "Official @modelcontextprotocol/server-fetch for web content fetching",
    category: "web",
    source: "official:modelcontextprotocol",
    transport: "stdio",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-fetch"],
    capability: "scan",
    whenToUse: "Fetch and convert web pages to markdown via official MCP",
  },
  playwright: {
    id: "playwright",
    name: "Playwright MCP (Microsoft Official)",
    description: "Official @playwright/mcp for real browser automation, JS rendering, DOM & SPA inspection",
    category: "browser",
    source: "official:microsoft",
    transport: "stdio",
    command: "npx",
    args: ["-y", "@playwright/mcp@latest", "--headless"],
    capability: "scan",
    whenToUse: "Interact with JS-heavy SPAs, login flows, DOM XSS, or browser-only targets",
  },
  "chrome-devtools": {
    id: "chrome-devtools",
    name: "Chrome DevTools MCP (Official)",
    description: "Official chrome-devtools-mcp for browser debugging, network traces & console inspection",
    category: "browser",
    source: "official:ChromeDevTools",
    transport: "stdio",
    command: "npx",
    args: ["-y", "chrome-devtools-mcp@latest"],
    capability: "scan",
    whenToUse: "Inspect browser network requests, cookies, storage, and JS execution",
  },
  "sequential-thinking": {
    id: "sequential-thinking",
    name: "Sequential Thinking MCP (Official)",
    description: "Official @modelcontextprotocol/server-sequential-thinking for structured multi-step analysis",
    category: "reasoning",
    source: "official:modelcontextprotocol",
    transport: "stdio",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-sequential-thinking"],
    capability: "observe",
    whenToUse: "Break down complex attack chains or multi-step vulnerability analysis",
  },
  memory: {
    id: "memory",
    name: "Knowledge Graph Memory MCP (Official)",
    description: "Official @modelcontextprotocol/server-memory for entity-relation graph storage",
    category: "memory",
    source: "official:modelcontextprotocol",
    transport: "stdio",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-memory"],
    capability: "observe",
    whenToUse: "Store structured entity relations during deep investigations",
  },
  github: {
    id: "github",
    name: "GitHub MCP (Official)",
    description: "Official @modelcontextprotocol/server-github for code/repo/issue reconnaissance",
    category: "osint",
    source: "official:modelcontextprotocol",
    transport: "stdio",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-github"],
    capability: "scan",
    whenToUse: "Search public GitHub repositories, code, or commits when GITHUB_PERSONAL_ACCESS_TOKEN is set",
  },
  context7: {
    id: "context7",
    name: "Context7 Docs MCP (Community High-Star)",
    description: "Upstash Context7 MCP for up-to-date framework/library documentation lookup",
    category: "docs",
    source: "community-high-star:upstash",
    transport: "stdio",
    command: "npx",
    args: ["-y", "@upstash/context7-mcp@latest"],
    capability: "observe",
    whenToUse: "Look up exact framework/library APIs and security behavior",
  },
};

export type CuratedSkillEntry = {
  id: string;
  name: string;
  description: string;
  owner: string;
  repo: string;
  path: string;
  source: string;
};

/** Curated official & high-star community skill/reference documents. */
export const CURATED_OFFICIAL_SKILLS: Record<string, CuratedSkillEntry> = {
  "owasp-ssrf": {
    id: "owasp-ssrf",
    name: "OWASP SSRF Cheat Sheet",
    description: "Official OWASP SSRF prevention & bypass reference",
    owner: "OWASP",
    repo: "CheatSheetSeries",
    path: "cheatsheets/Server_Side_Request_Forgery_Prevention_Cheat_Sheet.md",
    source: "official:OWASP",
  },
  "owasp-xxe": {
    id: "owasp-xxe",
    name: "OWASP XXE Cheat Sheet",
    description: "Official OWASP XML External Entity reference",
    owner: "OWASP",
    repo: "CheatSheetSeries",
    path: "cheatsheets/XML_External_Entity_Prevention_Cheat_Sheet.md",
    source: "official:OWASP",
  },
  "owasp-deserialization": {
    id: "owasp-deserialization",
    name: "OWASP Deserialization Cheat Sheet",
    description: "Official OWASP Deserialization attack & defense reference",
    owner: "OWASP",
    repo: "CheatSheetSeries",
    path: "cheatsheets/Deserialization_Cheat_Sheet.md",
    source: "official:OWASP",
  },
  "owasp-graphql": {
    id: "owasp-graphql",
    name: "OWASP GraphQL Cheat Sheet",
    description: "Official OWASP GraphQL security & testing reference",
    owner: "OWASP",
    repo: "CheatSheetSeries",
    path: "cheatsheets/GraphQL_Cheat_Sheet.md",
    source: "official:OWASP",
  },
  "patt-ssti": {
    id: "patt-ssti",
    name: "PayloadsAllTheThings SSTI",
    description: "High-star community SSTI payloads & engine identification guide",
    owner: "swisskyrepo",
    repo: "PayloadsAllTheThings",
    path: "Server Side Template Injection/README.md",
    source: "community-high-star:swisskyrepo",
  },
  "patt-sqli": {
    id: "patt-sqli",
    name: "PayloadsAllTheThings SQLi",
    description: "High-star community SQL Injection reference",
    owner: "swisskyrepo",
    repo: "PayloadsAllTheThings",
    path: "SQL Injection/README.md",
    source: "community-high-star:swisskyrepo",
  },
  "patt-jwt": {
    id: "patt-jwt",
    name: "PayloadsAllTheThings JWT",
    description: "High-star community JSON Web Token attack reference",
    owner: "swisskyrepo",
    repo: "PayloadsAllTheThings",
    path: "JSON Web Token/README.md",
    source: "community-high-star:swisskyrepo",
  },
  "patt-cors": {
    id: "patt-cors",
    name: "PayloadsAllTheThings CORS",
    description: "High-star community CORS misconfiguration reference",
    owner: "swisskyrepo",
    repo: "PayloadsAllTheThings",
    path: "CORS Misconfiguration/README.md",
    source: "community-high-star:swisskyrepo",
  },
  "patt-prototype-pollution": {
    id: "patt-prototype-pollution",
    name: "PayloadsAllTheThings Prototype Pollution",
    description: "High-star community JavaScript Prototype Pollution reference",
    owner: "swisskyrepo",
    repo: "PayloadsAllTheThings",
    path: "Prototype Pollution/README.md",
    source: "community-high-star:swisskyrepo",
  },
};

/** Map common external MCP names/aliases back to Kali-integrated builtin MCP ids. */
const KALI_BUILTIN_MCP_ALIASES: Record<string, string> = {
  "nmap-mcp": "nmap",
  "mcp-nmap": "nmap",
  "sqlmap-mcp": "sqlmap",
  "mcp-sqlmap": "sqlmap",
  "nuclei-mcp": "nuclei",
  "mcp-nuclei": "nuclei",
  "ffuf-mcp": "ffuf",
  "httpx-mcp": "httpx",
  "gobuster-mcp": "gobuster",
  "hydra-mcp": "hydra",
  "nikto-mcp": "nikto",
  "wpscan-mcp": "wpscan",
  "amass-mcp": "amass",
  "subfinder-mcp": "subfinder",
  "dirsearch-mcp": "dirsearch",
  "dalfox-mcp": "dalfox",
  "arjun-mcp": "arjun",
  "masscan-mcp": "masscan",
  "naabu-mcp": "naabu",
  "searchsploit-mcp": "searchsploit",
  nxc: "netexec",
  crackmapexec: "netexec",
  theHarvester: "theharvester",
  "httpx-toolkit": "httpx",
};

export function resolveDataRoot(dataDir: string): string {
  // Standard layout: <dataRoot>/tasks/<taskId>
  const parent = dirname(dataDir);
  if (basename(parent) === "tasks") {
    return dirname(parent);
  }
  return dataDir;
}

export function validatePackId(id: string): string {
  const clean = id.trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(clean) || clean.includes("..")) {
    throw new Error(`非法 id：${id}（仅允许小写字母/数字/._-）`);
  }
  return clean;
}

export type FetchLike = typeof fetch;

export type GithubRepoVerification = {
  ok: boolean;
  reason: string;
  owner: string;
  repo: string;
  defaultBranch: string;
  stars: number;
  official: boolean;
};

/**
 * Verify a GitHub repository is either from an official trusted owner OR
 * has >= MIN_COMMUNITY_STARS stars and is not archived.
 */
export async function verifyGithubRepo(
  owner: string,
  repo: string,
  fetchFn: FetchLike = fetch,
): Promise<GithubRepoVerification> {
  if (!/^[a-zA-Z0-9_.-]+$/.test(owner) || !/^[a-zA-Z0-9_.-]+$/.test(repo)) {
    return {
      ok: false,
      reason: `非法 GitHub 仓库坐标：${owner}/${repo}`,
      owner,
      repo,
      defaultBranch: "main",
      stars: 0,
      official: false,
    };
  }
  const official = OFFICIAL_TRUSTED_OWNERS.has(owner.toLowerCase());
  const headers: Record<string, string> = {
    accept: "application/vnd.github+json",
    "user-agent": "GongYuAI-Registry/0.1",
  };
  if (process.env.GITHUB_TOKEN) {
    headers.authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  }
  try {
    const res = await fetchFn(`https://api.github.com/repos/${owner}/${repo}`, {
      headers,
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
      if (official) {
        return {
          ok: true,
          reason: `官方受信任源 ${owner}/${repo}（GitHub API 返回 ${res.status}，按官方白名单放行）`,
          owner,
          repo,
          defaultBranch: "main",
          stars: 0,
          official: true,
        };
      }
      return {
        ok: false,
        reason: `无法校验 GitHub 仓库 ${owner}/${repo}（HTTP ${res.status}）；非官方源必须可校验且 ≥${MIN_COMMUNITY_STARS} stars`,
        owner,
        repo,
        defaultBranch: "main",
        stars: 0,
        official: false,
      };
    }
    const meta = (await res.json()) as {
      stargazers_count?: number;
      archived?: boolean;
      default_branch?: string;
    };
    const stars = Number(meta.stargazers_count ?? 0);
    const defaultBranch = meta.default_branch || "main";
    if (meta.archived && !official) {
      return {
        ok: false,
        reason: `拒绝安装已归档社区仓库 ${owner}/${repo}`,
        owner,
        repo,
        defaultBranch,
        stars,
        official: false,
      };
    }
    if (!official && stars < MIN_COMMUNITY_STARS) {
      return {
        ok: false,
        reason: `拒绝安装低星仓库 ${owner}/${repo}（当前 ${stars} stars，要求官方源或社区 ≥${MIN_COMMUNITY_STARS} stars）`,
        owner,
        repo,
        defaultBranch,
        stars,
        official: false,
      };
    }
    return {
      ok: true,
      reason: official
        ? `官方源 ${owner}/${repo}（${stars}⭐）`
        : `高星社区源 ${owner}/${repo}（${stars}⭐）`,
      owner,
      repo,
      defaultBranch,
      stars,
      official,
    };
  } catch (err) {
    if (official) {
      return {
        ok: true,
        reason: `官方受信任源 ${owner}/${repo}（离线/网络超时，按官方白名单放行）`,
        owner,
        repo,
        defaultBranch: "main",
        stars: 0,
        official: true,
      };
    }
    return {
      ok: false,
      reason: `校验 ${owner}/${repo} 失败：${err instanceof Error ? err.message : String(err)}`,
      owner,
      repo,
      defaultBranch: "main",
      stars: 0,
      official: false,
    };
  }
}

export function trustedRegistryCatalogHint(): string {
  const mcps = Object.keys(CURATED_OFFICIAL_MCPS).join(", ");
  const skills = Object.keys(CURATED_OFFICIAL_SKILLS).join(", ");
  return `官方/高星可按需安装目录（仅在 Kali 内置未覆盖时使用）：MCP=[${mcps}]；Skill=[${skills}]（也支持 github:owner/repo 或官方 npm 包，自动校验官方白名单或 ≥${MIN_COMMUNITY_STARS}⭐）。`;
}

/**
 * Install (or reuse Kali-integrated) MCP server, persist to <dataRoot>/mcp/user/<id>/mcp.json,
 * hot-register into the live McpHub, and enable it immediately.
 */
export async function installMcp(
  ctx: ToolContext,
  mcpHub: McpHub,
  spec: {
    id: string;
    source?: string;
    reason?: string;
    autoEnable?: boolean;
  },
  deps?: { fetchFn?: FetchLike },
): Promise<{ ok: boolean; detail: string; id: string; reusedKali?: boolean }> {
  const rawId = spec.id.trim();
  const reason = spec.reason?.trim() || "needed for task";
  let id: string;
  try {
    id = validatePackId(rawId);
  } catch (err) {
    return { ok: false, id: rawId, detail: err instanceof Error ? err.message : String(err) };
  }

  // 1) Kali-first & local dedup: if already in mcpPool (or maps to a Kali builtin MCP), reuse directly!
  const canonicalKali = KALI_BUILTIN_MCP_ALIASES[id] ?? id;
  if (mcpHub.hasServer(canonicalKali)) {
    const reused = canonicalKali !== id ? `（已映射到 Kali 内置 MCP \`${canonicalKali}\`，无需重复下载）` : "（已在本地 MCP 目录中，无需重复下载）";
    if (spec.autoEnable !== false) {
      const enabledMsg = await mcpHub.enable(canonicalKali, reason);
      return {
        ok: true,
        id: canonicalKali,
        reusedKali: true,
        detail: `${reused}${enabledMsg}`,
      };
    }
    return {
      ok: true,
      id: canonicalKali,
      reusedKali: true,
      detail: `MCP \`${canonicalKali}\` 已存在${reused}`,
    };
  }

  try {
    gateTool(ctx, "install_mcp", () => {
      assertCapabilityAllows(ctx.manifest, "install");
      if (isBudgetHit(ctx.usage.installs + 1, ctx.manifest.budget.maxInstalls)) {
        throw new Error("maxInstalls exceeded");
      }
    }, { id, source: spec.source?.slice(0, 120) });
  } catch (err) {
    return { ok: false, id, detail: err instanceof Error ? err.message : String(err) };
  }

  const dataRoot = resolveDataRoot(ctx.manifest.dataDir);
  const packDir = join(dataRoot, "mcp", "user", id);

  // 2) If it's a Kali CLI tool (already installed or in Kali APT) and no external npm/github source specified,
  //    install via Kali-first installTool and wrap as a builtin CLI MCP — no external MCP download needed!
  const source = spec.source?.trim() || "";
  if (!source && !CURATED_OFFICIAL_MCPS[id] && (findInstalledBinary(id).found || KALI_APT_PACKAGES[id])) {
    const binInstall = await installTool(ctx, { name: id, method: "auto" });
    if (!binInstall.ok) {
      return { ok: false, id, detail: `Kali 工具 ${id} 安装失败：${binInstall.detail}` };
    }
    mkdirSync(packDir, { recursive: true });
    const meta = {
      id,
      name: `${id} (Kali CLI)`,
      description: `Kali-integrated CLI MCP wrapper for ${id}`,
      category: "kali-cli",
      transport: "builtin" as const,
      binary: id,
      capability: "scan" as const,
      whenToUse: `Run Kali tool ${id} against authorized targets`,
    };
    writeFileSync(join(packDir, "mcp.json"), JSON.stringify(meta, null, 2));
    const workerCfg: WorkerMcpServer = {
      id,
      name: meta.name,
      transport: "builtin",
      rootDir: packDir,
      args: [],
      env: {},
      binary: id,
      capability: "scan",
      whenToUse: meta.whenToUse,
    };
    const catEntry: ToolCatalogEntry = {
      id,
      name: meta.name,
      description: meta.description,
      category: meta.category,
    };
    mcpHub.register(workerCfg, catEntry);
    const enabledMsg = spec.autoEnable !== false ? await mcpHub.enable(id, reason) : `已注册 ${id}`;
    appendProgress(ctx.manifest.workspaceDir, `install_mcp ${id} (kali-cli) · ${reason.slice(0, 100)}`);
    return {
      ok: true,
      id,
      reusedKali: Boolean(binInstall.alreadyPresent),
      detail: `使用 Kali 集成/APT 工具 ${id}（${binInstall.detail}）并注册 MCP：${enabledMsg}`,
    };
  }

  // 3) Curated official / high-star MCP registry
  let entry: CuratedMcpEntry | undefined = CURATED_OFFICIAL_MCPS[id];
  let provenance = entry?.source ?? "";

  // 4) Custom source: strictly official npm scope or verified GitHub repo (>=500 stars or official owner)
  if (!entry && source) {
    if (source.startsWith("npm:")) {
      const pkg = source.slice(4).trim();
      if (!/^(@[a-z0-9._-]+\/)?[a-z0-9._-]+(?:@[a-z0-9.^~+-]+)?$/i.test(pkg)) {
        return { ok: false, id, detail: `非法 npm 包名：${pkg}` };
      }
      const scopeMatch = /^(@[a-z0-9._-]+)\//i.exec(pkg);
      const scope = scopeMatch?.[1]?.toLowerCase() ?? "";
      const isCuratedPkg = Object.values(CURATED_OFFICIAL_MCPS).some((c) =>
        c.args.some((a) => a === pkg || a.startsWith(`${pkg}@`)),
      );
      if (!OFFICIAL_NPM_SCOPES.has(scope) && !isCuratedPkg) {
        return {
          ok: false,
          id,
          detail: `拒绝非官方 npm 作用域 ${pkg}；请使用官方作用域（${[...OFFICIAL_NPM_SCOPES].join(", ")}）或通过 github:owner/repo 校验 ≥${MIN_COMMUNITY_STARS}⭐`,
        };
      }
      provenance = `npm-official:${scope || "curated"}`;
      entry = {
        id,
        name: `${id} (${pkg})`,
        description: `Official npm MCP server ${pkg}`,
        category: "community",
        source: provenance,
        transport: "stdio",
        command: "npx",
        args: ["-y", pkg],
        capability: "scan",
        whenToUse: reason,
      };
    } else if (source.startsWith("github:")) {
      const rest = source.slice(7).trim().replace(/\.git$/, "");
      const [owner, repo, npmPkg] = rest.split("/");
      if (!owner || !repo) {
        return { ok: false, id, detail: `非法 github 坐标：${source}（格式：github:owner/repo 或 github:owner/repo/npm-pkg）` };
      }
      const check = await verifyGithubRepo(owner, repo, deps?.fetchFn);
      if (!check.ok) {
        return { ok: false, id, detail: check.reason };
      }
      provenance = check.reason;
      const pkgSpec = npmPkg?.trim() || `github:${owner}/${repo}`;
      if (!/^[a-zA-Z0-9@_./:-]+$/.test(pkgSpec) || pkgSpec.includes("..")) {
        return { ok: false, id, detail: `非法包标识：${pkgSpec}` };
      }
      entry = {
        id,
        name: `${id} (${owner}/${repo})`,
        description: `Verified MCP from ${check.reason}`,
        category: "community",
        source: check.reason,
        transport: "stdio",
        command: "npx",
        args: ["-y", pkgSpec],
        capability: "scan",
        whenToUse: reason,
      };
    } else {
      return {
        ok: false,
        id,
        detail: `不支持的 MCP 来源格式：${source}（仅支持预置官方目录 id、npm:@official/pkg 或 github:owner/repo）`,
      };
    }
  }

  if (!entry) {
    return {
      ok: false,
      id,
      detail: `未在官方/高星 MCP 目录找到 \`${id}\`。可用目录：${Object.keys(CURATED_OFFICIAL_MCPS).join(", ")}；或传入 source="npm:@modelcontextprotocol/..." / source="github:owner/repo"（需官方源或 ≥${MIN_COMMUNITY_STARS}⭐）。`,
    };
  }

  if (ctx.manifest.commandFence) {
    await reviewBeforeDispatch(ctx.manifest, {
      ...commandProposal("install_mcp", id, [entry.command, ...entry.args]),
      command: `install_mcp ${id} ${entry.command} ${entry.args.join(" ")}`,
      hosts: [],
      need: "scan",
    });
  }

  ctx.usage.installs += 1;
  mkdirSync(packDir, { recursive: true });
  const meta = {
    id: entry.id,
    name: entry.name,
    description: entry.description,
    category: entry.category,
    transport: entry.transport,
    command: entry.command,
    args: entry.args,
    capability: entry.capability,
    whenToUse: entry.whenToUse,
    provenance,
  };
  writeFileSync(join(packDir, "mcp.json"), JSON.stringify(meta, null, 2));

  const workerCfg: WorkerMcpServer = {
    id: entry.id,
    name: entry.name,
    transport: entry.transport,
    rootDir: packDir,
    command: entry.command,
    args: entry.args,
    env: {},
    capability: entry.capability,
    whenToUse: entry.whenToUse,
  };
  const catEntry: ToolCatalogEntry = {
    id: entry.id,
    name: entry.name,
    description: entry.description,
    category: entry.category,
  };
  mcpHub.register(workerCfg, catEntry);
  ctx.history.recordInstall(ctx.manifest.taskId, `mcp:${id}`, {
    source: provenance,
    command: entry.command,
    args: entry.args,
    rootDir: packDir,
  });
  writeEvidence(
    ctx,
    `installs/mcp-${id}.json`,
    JSON.stringify(meta, null, 2),
  );
  appendProgress(ctx.manifest.workspaceDir, `install_mcp ${id} (${provenance}) · ${reason.slice(0, 100)}`);

  if (spec.autoEnable !== false && !ctx.manifest.mock) {
    try {
      const enabledMsg = await mcpHub.enable(id, reason);
      return {
        ok: true,
        id,
        detail: `已从 ${provenance} 安装并启用 MCP \`${id}\`：${enabledMsg}`,
      };
    } catch (err) {
      return {
        ok: true,
        id,
        detail: `已从 ${provenance} 安装并注册 MCP \`${id}\`（启动连接失败：${err instanceof Error ? err.message : String(err)}）`,
      };
    }
  }
  return {
    ok: true,
    id,
    detail: `已从 ${provenance} 安装并注册 MCP \`${id}\`（可调用 enable_mcp("${id}") 启用）`,
  };
}

/**
 * Install (or reuse local) Skill from official or high-star (>=500⭐) GitHub sources,
 * persist to <dataRoot>/skills/user/<id>/SKILL.md, hot-register into SkillHub, and load it.
 */
export async function installSkill(
  ctx: ToolContext,
  skillHub: SkillHub,
  spec: {
    id: string;
    source?: string;
    reason?: string;
    autoLoad?: boolean;
  },
  deps?: { fetchFn?: FetchLike },
): Promise<{ ok: boolean; detail: string; id: string; content?: string }> {
  const rawId = spec.id.trim();
  const reason = spec.reason?.trim() || "needed for task";
  let id: string;
  try {
    id = validatePackId(rawId);
  } catch (err) {
    return { ok: false, id: rawId, detail: err instanceof Error ? err.message : String(err) };
  }

  // 1) Local-first dedup: already in skillHub? Load directly without downloading!
  if (skillHub.hasSkill(id)) {
    const content = spec.autoLoad !== false ? skillHub.load(id, reason) : undefined;
    return {
      ok: true,
      id,
      content,
      detail: `Skill \`${id}\` 已在本地路由表中（无需重复下载）`,
    };
  }

  const dataRoot = resolveDataRoot(ctx.manifest.dataDir);
  const packDir = join(dataRoot, "skills", "user", id);
  if (existsSync(join(packDir, "SKILL.md"))) {
    const pack: WorkerSkillPack = { id, name: id, rootDir: packDir };
    skillHub.register(pack);
    const content = spec.autoLoad !== false ? skillHub.load(id, reason) : undefined;
    return {
      ok: true,
      id,
      content,
      detail: `Skill \`${id}\` 已在本地用户目录存在，已热注册（无需重复下载）`,
    };
  }

  try {
    gateTool(ctx, "install_skill", () => {
      assertCapabilityAllows(ctx.manifest, "install");
      if (isBudgetHit(ctx.usage.installs + 1, ctx.manifest.budget.maxInstalls)) {
        throw new Error("maxInstalls exceeded");
      }
    }, { id, source: spec.source?.slice(0, 120) });
  } catch (err) {
    return { ok: false, id, detail: err instanceof Error ? err.message : String(err) };
  }

  let owner = "";
  let repo = "";
  let filePath = "";
  let displayName = id;
  let description = "";

  const curated = CURATED_OFFICIAL_SKILLS[id];
  const source = spec.source?.trim() || "";
  if (curated && !source) {
    owner = curated.owner;
    repo = curated.repo;
    filePath = curated.path;
    displayName = curated.name;
    description = curated.description;
  } else if (source.startsWith("github:")) {
    const rest = source.slice(7).trim();
    const parts = rest.split("/").filter(Boolean);
    if (parts.length < 2) {
      return {
        ok: false,
        id,
        detail: `非法 github 坐标：${source}（格式：github:owner/repo/path/to/SKILL.md）`,
      };
    }
    owner = parts[0]!;
    repo = parts[1]!;
    filePath = parts.slice(2).join("/") || "SKILL.md";
    if (filePath.includes("..")) {
      return { ok: false, id, detail: `非法文件路径：${filePath}` };
    }
    displayName = `${id} (${owner}/${repo})`;
    description = `Installed from github:${owner}/${repo}/${filePath}`;
  } else {
    return {
      ok: false,
      id,
      detail: `未在官方/高星 Skill 目录找到 \`${id}\`。可用目录：${Object.keys(CURATED_OFFICIAL_SKILLS).join(", ")}；或传入 source="github:owner/repo/path/to/SKILL.md"（需官方源或 ≥${MIN_COMMUNITY_STARS}⭐）。`,
    };
  }

  const check = await verifyGithubRepo(owner, repo, deps?.fetchFn);
  if (!check.ok) {
    return { ok: false, id, detail: check.reason };
  }

  if (ctx.manifest.commandFence) {
    await reviewBeforeDispatch(ctx.manifest, {
      ...commandProposal("install_skill", id, [owner, repo, filePath]),
      command: `install_skill ${id} github:${owner}/${repo}/${filePath}`,
      hosts: [],
      need: "scan",
    });
  }

  const fetchFn = deps?.fetchFn ?? fetch;
  const encodedPath = filePath
    .split("/")
    .map((seg) => encodeURIComponent(seg))
    .join("/");
  const rawUrl = `https://raw.githubusercontent.com/${owner}/${repo}/${check.defaultBranch}/${encodedPath}`;

  let markdown = "";
  if (ctx.manifest.mock && !deps?.fetchFn) {
    markdown = `---\nname: ${displayName}\ndescription: ${description}\n---\n\n# ${displayName}\n\nMock skill installed from ${check.reason}.\n`;
  } else {
    try {
      const res = await fetchFn(rawUrl, {
        headers: { "user-agent": "GongYuAI-Registry/0.1" },
        signal: AbortSignal.timeout(20_000),
      });
      if (!res.ok) {
        return {
          ok: false,
          id,
          detail: `下载 Skill 失败（HTTP ${res.status}）：${rawUrl}`,
        };
      }
      const text = await res.text();
      if (!text.trim()) {
        return { ok: false, id, detail: `下载的 Skill 内容为空：${rawUrl}` };
      }
      markdown = text.slice(0, 200_000);
    } catch (err) {
      return {
        ok: false,
        id,
        detail: `下载 Skill 网络错误：${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  ctx.usage.installs += 1;
  mkdirSync(packDir, { recursive: true });
  writeFileSync(join(packDir, "SKILL.md"), markdown, "utf8");
  writeFileSync(
    join(packDir, "skill.json"),
    JSON.stringify(
      {
        id,
        name: displayName,
        description,
        defaultEnabled: true,
        provenance: check.reason,
        sourceUrl: rawUrl,
      },
      null,
      2,
    ),
    "utf8",
  );

  const pack: WorkerSkillPack = { id, name: displayName, rootDir: packDir };
  const catEntry: ToolCatalogEntry = {
    id,
    name: displayName,
    description,
    category: "skill",
  };
  skillHub.register(pack, catEntry);
  ctx.history.recordInstall(ctx.manifest.taskId, `skill:${id}`, {
    source: check.reason,
    url: rawUrl,
    rootDir: packDir,
  });
  writeEvidence(
    ctx,
    `installs/skill-${id}.txt`,
    `id=${id}\nsource=${check.reason}\nurl=${rawUrl}\nbytes=${markdown.length}\n`,
  );
  appendProgress(ctx.manifest.workspaceDir, `install_skill ${id} (${check.reason}) · ${reason.slice(0, 100)}`);

  const content = spec.autoLoad !== false ? skillHub.load(id, reason) : undefined;
  return {
    ok: true,
    id,
    content,
    detail: `已从 ${check.reason} 安装并热注册 Skill \`${id}\``,
  };
}

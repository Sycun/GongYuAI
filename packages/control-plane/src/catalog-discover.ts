import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  McpServerConfigSchema,
  SkillPackConfigSchema,
  type McpServerConfig,
  type SkillPackConfig,
} from "@gongyuai/contracts";

type McpJson = {
  id?: string;
  name?: string;
  description?: string;
  category?: string;
  transport?: "builtin" | "stdio" | "http";
  binary?: string;
  defaultFlags?: string;
  targetFlag?: string;
  defaultEnabled?: boolean;
  command?: string;
  args?: string[];
  url?: string;
  env?: Record<string, string>;
  capability?: "observe" | "scan" | "active-lab" | "full";
  parser?: "nmap" | "httpx" | "nuclei" | "ffuf";
  timeoutMs?: number;
  whenToUse?: string;
};

type SkillJson = {
  id?: string;
  name?: string;
  description?: string;
  defaultEnabled?: boolean;
};

function listDirs(abs: string): string[] {
  if (!existsSync(abs) || !statSync(abs).isDirectory()) return [];
  return readdirSync(abs).filter((name) => {
    try {
      return statSync(join(abs, name)).isDirectory();
    } catch {
      return false;
    }
  });
}

function discoverMcpRoot(
  root: string,
  source: "builtin" | "user",
): McpServerConfig[] {
  const out: McpServerConfig[] = [];
  for (const id of listDirs(root)) {
    const dir = join(root, id);
    const metaPath = join(dir, "mcp.json");
    if (!existsSync(metaPath)) continue;
    try {
      const raw = JSON.parse(readFileSync(metaPath, "utf8")) as McpJson;
      const transport = raw.transport ?? (source === "builtin" ? "builtin" : "stdio");
      out.push(
        McpServerConfigSchema.parse({
          id: raw.id ?? id,
          name: raw.name ?? id,
          description: raw.description ?? "",
          category: raw.category ?? "general",
          enabled: raw.defaultEnabled ?? source === "builtin",
          builtin: source === "builtin",
          source,
          transport,
          rootDir: dir,
          command: raw.command,
          args: raw.args ?? [],
          url: raw.url,
          env: raw.env ?? {},
          binary: raw.binary,
          defaultFlags: raw.defaultFlags,
          targetFlag: raw.targetFlag,
          capability: raw.capability,
          parser: raw.parser,
          timeoutMs: raw.timeoutMs,
          whenToUse: raw.whenToUse,
        }),
      );
    } catch {
      /* skip broken pack */
    }
  }
  return out;
}

function discoverSkillRoot(
  root: string,
  source: "builtin" | "user",
): SkillPackConfig[] {
  const out: SkillPackConfig[] = [];
  for (const id of listDirs(root)) {
    const dir = join(root, id);
    if (!existsSync(join(dir, "SKILL.md"))) continue;
    let meta: SkillJson = {};
    const metaPath = join(dir, "skill.json");
    if (existsSync(metaPath)) {
      try {
        meta = JSON.parse(readFileSync(metaPath, "utf8")) as SkillJson;
      } catch {
        meta = {};
      }
    }
    let description = meta.description ?? "";
    if (!description) {
      try {
        const body = readFileSync(join(dir, "SKILL.md"), "utf8");
        const m = /^description:\s*(.+)$/m.exec(body);
        if (m) description = m[1]!.trim();
      } catch {
        /* ignore */
      }
    }
    out.push(
      SkillPackConfigSchema.parse({
        id: meta.id ?? id,
        name: meta.name ?? id,
        description,
        enabled: meta.defaultEnabled ?? true,
        builtin: source === "builtin",
        source,
        rootDir: dir,
      }),
    );
  }
  return out;
}

/**
 * Scan installRoot + dataRoot for mcp/ and skills/ packs.
 * User dirs overlay builtin by id (user wins metadata).
 */
export function discoverMcpCatalog(
  installRoot: string,
  dataRoot: string,
): McpServerConfig[] {
  const byId = new Map<string, McpServerConfig>();
  for (const item of [
    ...discoverMcpRoot(join(installRoot, "mcp", "builtin"), "builtin"),
    ...discoverMcpRoot(join(installRoot, "mcp", "user"), "user"),
    ...discoverMcpRoot(join(dataRoot, "mcp", "user"), "user"),
  ]) {
    byId.set(item.id, item);
  }
  return [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
}

export function discoverSkillCatalog(
  installRoot: string,
  dataRoot: string,
): SkillPackConfig[] {
  const byId = new Map<string, SkillPackConfig>();
  for (const item of [
    ...discoverSkillRoot(join(installRoot, "skills", "builtin"), "builtin"),
    ...discoverSkillRoot(join(installRoot, "skills", "user"), "user"),
    ...discoverSkillRoot(join(dataRoot, "skills", "user"), "user"),
  ]) {
    byId.set(item.id, item);
  }
  return [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
}

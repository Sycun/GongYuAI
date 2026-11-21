import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ToolCatalogEntry, WorkerManifest, WorkerSkillPack } from "@gongyuai/contracts";
import type { HistoryStore } from "@gongyuai/history";
import { appendProgress } from "../tools.js";

export type SkillHub = {
  /** Compact routing table lines for system prompt (no full bodies). */
  routingTable(): string[];
  /** Goal-based soft hints (ids only). */
  suggestForGoals(): string[];
  /** Load full SKILL.md into tool result (on-demand). */
  load(id: string, reason: string): string;
  /** Which skills have been loaded this run (for progress). */
  loadedIds(): string[];
};

type RouteExtra = { triggers?: string[] };

function stripFrontmatter(raw: string): string {
  if (!raw.startsWith("---")) return raw;
  const end = raw.indexOf("\n---", 3);
  if (end < 0) return raw;
  return raw.slice(end + 4);
}

function readTriggers(rootDir: string): string[] {
  const p = join(rootDir, "skill.json");
  if (!existsSync(p)) return [];
  try {
    const j = JSON.parse(readFileSync(p, "utf8")) as RouteExtra & {
      triggers?: string[];
    };
    return Array.isArray(j.triggers) ? j.triggers.map(String) : [];
  } catch {
    return [];
  }
}

function loadRoutingFile(installHintDirs: string[]): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const dir of installHintDirs) {
    const p = join(dir, "routing.json");
    if (!existsSync(p)) continue;
    try {
      const raw = JSON.parse(readFileSync(p, "utf8")) as {
        routes?: Array<{ id: string; triggers?: string[] }>;
      };
      for (const r of raw.routes ?? []) {
        if (r.id && r.triggers?.length) map.set(r.id, r.triggers);
      }
    } catch {
      /* ignore */
    }
  }
  return map;
}

/**
 * Skill hub: routing-table + on-demand load_skill.
 * Never dumps all SKILL.md into the system prompt (token bomb).
 */
export function openSkillHub(
  manifest: WorkerManifest,
  history: HistoryStore,
): SkillHub {
  const pool = new Map<string, WorkerSkillPack>();
  for (const p of manifest.skillPool?.length ? manifest.skillPool : manifest.skillPacks ?? []) {
    pool.set(p.id, p);
  }
  for (const p of manifest.skillPacks ?? []) {
    if (!pool.has(p.id)) pool.set(p.id, p);
  }

  const catalog: ToolCatalogEntry[] =
    manifest.skillCatalog?.length
      ? manifest.skillCatalog
      : [...pool.values()].map((p) => ({
          id: p.id,
          name: p.name,
          description: "",
          category: "skill",
        }));

  // Project skills/routing.json — derive from any pack path (…/skills/builtin/<id>)
  const skillsRoots: string[] = [];
  for (const p of pool.values()) {
    const root = join(p.rootDir, "..", "..");
    if (!skillsRoots.includes(root)) skillsRoots.push(root);
    const builtinParent = join(p.rootDir, "..");
    if (!skillsRoots.includes(builtinParent)) skillsRoots.push(builtinParent);
  }
  const routeFile = loadRoutingFile(skillsRoots);

  const loaded = new Set<string>();

  function triggersFor(id: string, rootDir?: string): string[] {
    if (routeFile.has(id)) return routeFile.get(id)!;
    if (rootDir) return readTriggers(rootDir);
    return [];
  }

  return {
    routingTable: () => {
      const lines: string[] = [];
      for (const c of catalog) {
        if (!pool.has(c.id)) continue;
        const pack = pool.get(c.id)!;
        const trig = triggersFor(c.id, pack.rootDir);
        const trigPart = trig.length ? ` · 触发:${trig.slice(0, 8).join(",")}` : "";
        const desc = (c.description || "").slice(0, 80);
        lines.push(`- \`${c.id}\` ${c.name}${desc ? ` — ${desc}` : ""}${trigPart}`);
      }
      return lines;
    },

    suggestForGoals: () => {
      const hay = [
        ...manifest.goals.map((g) => `${g.title} ${g.description}`),
        ...manifest.auth.targets,
        manifest.auth.authorizationNote,
      ]
        .join(" ")
        .toLowerCase();
      const scored: Array<{ id: string; score: number }> = [];
      for (const c of catalog) {
        const pack = pool.get(c.id);
        if (!pack) continue;
        const trig = triggersFor(c.id, pack.rootDir);
        let score = 0;
        for (const t of trig) {
          if (t && hay.includes(t.toLowerCase())) score += 2;
        }
        const bits = `${c.id} ${c.name} ${c.description}`.toLowerCase();
        for (const token of bits.split(/[^a-z0-9\u4e00-\u9fff]+/).filter((x) => x.length > 3)) {
          if (hay.includes(token)) score += 1;
        }
        if (score > 0) scored.push({ id: c.id, score });
      }
      scored.sort((a, b) => b.score - a.score);
      return scored.slice(0, 5).map((s) => s.id);
    },

    load(id, reason) {
      const pack = pool.get(id);
      if (!pack) {
        const known = [...pool.keys()].slice(0, 30).join(", ");
        return `未知 Skill id：${id}。已知：${known}`;
      }
      const path = join(pack.rootDir, "SKILL.md");
      if (!existsSync(path)) return `Skill ${id} 缺少 SKILL.md`;
      let body: string;
      try {
        body = stripFrontmatter(readFileSync(path, "utf8")).trim();
      } catch (err) {
        return `读取失败：${err instanceof Error ? err.message : String(err)}`;
      }
      // Soft cap — keep tool results bounded
      const max = 12_000;
      const clipped =
        body.length > max
          ? `${body.slice(0, max)}\n\n…(已截断，全文 ${body.length} 字；按需再分节阅读)`
          : body;
      loaded.add(id);
      appendProgress(
        manifest.workspaceDir,
        `load_skill ${id} · ${reason.slice(0, 100)}`,
      );
      history.appendFact({
        taskId: manifest.taskId,
        layer: "summary",
        title: `加载 Skill ${id}`,
        summary: reason.slice(0, 400),
      });
      return `# Skill ${pack.name} (\`${id}\`)\n理由：${reason.slice(0, 200)}\n\n${clipped}`;
    },

    loadedIds: () => [...loaded],
  };
}

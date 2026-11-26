import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import type { ToolCatalogEntry, WorkerManifest, WorkerSkillPack } from "@gongyuai/contracts";
import type { HistoryStore } from "@gongyuai/history";
import { appendProgress } from "../tools.js";

export type SkillPhase = "discover" | "verify" | "both";

export type SkillHub = {
  /** Compact routing table lines for system prompt (no full bodies). */
  routingTable(): string[];
  /** Goal-based soft hints (ids only). */
  suggestForGoals(): string[];
  /** Check if skill id is already in the live pool. */
  hasSkill(id: string): boolean;
  /** Hot-register a newly installed skill pack into the live pool/routing table. */
  register(pack: WorkerSkillPack, catalogEntry?: ToolCatalogEntry): void;
  /** Load full SKILL.md (or an optional reference file under references/) into tool result. */
  load(id: string, reason: string, ref?: string): string;
  /**
   * Dark-Moon reactive triggering: match recent asset/fingerprint facts against routing.json
   * triggers and return compact Skill excerpts (deduped per session, hard token/char cap).
   * Respects optional `phase` ("discover" | "verify") so discovery and verification skills do not conflict.
   */
  autoInjectForFacts(
    facts: ReadonlyArray<{ title: string; summary?: string; tags?: readonly string[] }>,
    opts?: { maxChars?: number; maxSkills?: number; phase?: "discover" | "verify" },
  ): string;
  /** Which skills have been loaded this run (for progress). */
  loadedIds(): string[];
};

type RouteExtra = { triggers?: string[]; phase?: SkillPhase };

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Match a routing trigger against lowercased fact text.
 * Pure ASCII triggers require non-alphanumeric boundaries so short tokens like
 * "ad", "rf", or "ai" never match inside unrelated English words ("admin", "csrf", "main").
 */
export function matchesTrigger(hayLower: string, rawTrigger: string): boolean {
  const needle = rawTrigger.trim().toLowerCase();
  if (needle.length < 2) return false;
  if (/^[a-z0-9][a-z0-9._ -]*[a-z0-9]$/i.test(needle)) {
    return new RegExp(`(?<![a-z0-9_])${escapeRegex(needle)}(?![a-z0-9_])`, "i").test(hayLower);
  }
  return hayLower.includes(needle);
}

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

function loadRoutingFile(installHintDirs: string[]): {
  triggers: Map<string, string[]>;
  phases: Map<string, SkillPhase>;
} {
  const triggers = new Map<string, string[]>();
  const phases = new Map<string, SkillPhase>();
  for (const dir of installHintDirs) {
    const p = join(dir, "routing.json");
    if (!existsSync(p)) continue;
    try {
      const raw = JSON.parse(readFileSync(p, "utf8")) as {
        routes?: Array<{ id: string; triggers?: string[]; phase?: SkillPhase }>;
      };
      for (const r of raw.routes ?? []) {
        if (r.id && r.triggers?.length) triggers.set(r.id, r.triggers);
        if (r.id && (r.phase === "discover" || r.phase === "verify" || r.phase === "both")) {
          phases.set(r.id, r.phase);
        }
      }
    } catch {
      /* ignore */
    }
  }
  return { triggers, phases };
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

  const startCall = history.trackIntegrationCalls(manifest.taskId);
  const loaded = new Set<string>();
  const autoInjected = new Set<string>();

  function triggersFor(id: string, rootDir?: string): string[] {
    if (routeFile.triggers.has(id)) return routeFile.triggers.get(id)!;
    if (rootDir) return readTriggers(rootDir);
    return [];
  }

  function phaseFor(id: string): SkillPhase {
    return routeFile.phases.get(id) ?? "both";
  }

  function listReferences(rootDir: string): string[] {
    const refDir = join(rootDir, "references");
    if (!existsSync(refDir)) return [];
    try {
      if (!statSync(refDir).isDirectory()) return [];
      return readdirSync(refDir)
        .filter((f) => !f.startsWith("."))
        .sort()
        .map((f) => `references/${f}`);
    } catch {
      return [];
    }
  }

  return {
    hasSkill: (id) => pool.has(id),
    register(pack, catalogEntry) {
      pool.set(pack.id, pack);
      if (!catalog.some((c) => c.id === pack.id)) {
        catalog.push(
          catalogEntry ?? {
            id: pack.id,
            name: pack.name,
            description: "",
            category: "skill",
          },
        );
      }
    },
    routingTable: () => {
      const lines: string[] = [];
      for (const c of catalog) {
        if (!pool.has(c.id)) continue;
        const pack = pool.get(c.id)!;
        const trig = triggersFor(c.id, pack.rootDir);
        const trigPart = trig.length ? ` · 触发:${trig.slice(0, 8).join(",")}` : "";
        const phase = phaseFor(c.id);
        const phaseTag = phase === "discover" ? "[发现] " : phase === "verify" ? "[验证] " : "";
        const desc = (c.description || "").slice(0, 80);
        lines.push(`- ${phaseTag}\`${c.id}\` ${c.name}${desc ? ` — ${desc}` : ""}${trigPart}`);
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

    load(id, reason, ref) {
      const finish = startCall("skill", id);
      let success = false;
      try {
        const pack = pool.get(id);
        if (!pack) {
          const known = [...pool.keys()].slice(0, 30).join(", ");
          return `未知 Skill id：${id}。已知：${known}`;
        }
        let targetPath = join(pack.rootDir, "SKILL.md");
        let label = "SKILL.md";
        if (ref && ref.trim()) {
          const cleanRef = ref.trim().replace(/^\/+/, "");
          const rootAbs = resolve(pack.rootDir);
          const candidate = resolve(rootAbs, cleanRef);
          const rel = relative(rootAbs, candidate);
          if (!rel || rel.startsWith("..") || rel.includes("..")) {
            return `非法参考路径：${ref}`;
          }
          if (!existsSync(candidate) || !statSync(candidate).isFile()) {
            const avail = listReferences(pack.rootDir);
            return `Skill ${id} 中不存在参考文件 ${cleanRef}。可用：${avail.join(", ") || "（无）"}`;
          }
          targetPath = candidate;
          label = rel;
        }
        if (!existsSync(targetPath)) return `Skill ${id} 缺少 SKILL.md`;
        let body: string;
        try {
          body = stripFrontmatter(readFileSync(targetPath, "utf8")).trim();
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
          `load_skill ${id}${ref ? ` (${label})` : ""} · ${reason.slice(0, 100)}`,
        );
        history.appendFact({
          taskId: manifest.taskId,
          layer: "summary",
          title: `加载 Skill ${id}`,
          summary: `${ref ? `[${label}] ` : ""}${reason.slice(0, 380)}`,
          tags: ["system", "skill"],
        });
        success = body.length > 0;
        const refs = !ref ? listReferences(pack.rootDir) : [];
        const refNote = refs.length
          ? `\n\n---\n可用参考文档（调用 load_skill(id="${id}", ref="...") 按需读取）：${refs.join(", ")}`
          : "";
        return `# Skill ${pack.name} (\`${id}\` · ${label})\n理由：${reason.slice(0, 200)}\n\n${clipped}${refNote}`;
      } finally {
        finish(success);
      }
    },

    autoInjectForFacts(facts, opts) {
      if (!facts.length) return "";
      const maxChars = Math.max(400, Math.min(opts?.maxChars ?? 4500, 6000));
      const maxSkills = Math.max(1, Math.min(opts?.maxSkills ?? 2, 3));
      const hay = facts
        .slice(-25)
        .map((f) => `${f.title} ${f.summary ?? ""} ${(f.tags ?? []).join(" ")}`)
        .join(" ")
        .toLowerCase();
      if (!hay.trim()) return "";

      const scored: Array<{ id: string; score: number; matched: string[] }> = [];
      for (const c of catalog) {
        if (loaded.has(c.id) || autoInjected.has(c.id)) continue;
        const skillPhase = phaseFor(c.id);
        if (opts?.phase && skillPhase !== "both" && skillPhase !== opts.phase) continue;
        const pack = pool.get(c.id);
        if (!pack) continue;
        const trig = triggersFor(c.id, pack.rootDir);
        const matched: string[] = [];
        for (const t of trig) {
          if (matchesTrigger(hay, t)) matched.push(t);
        }
        if (matched.length > 0) {
          scored.push({ id: c.id, score: matched.length, matched });
        }
      }
      if (!scored.length) return "";
      scored.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));

      const sections: string[] = [];
      let used = 0;
      const perSkillCap = Math.min(1800, Math.floor(maxChars / Math.min(scored.length, maxSkills)));

      for (const pick of scored.slice(0, maxSkills)) {
        const pack = pool.get(pick.id);
        if (!pack) continue;
        const skillFile = join(pack.rootDir, "SKILL.md");
        if (!existsSync(skillFile)) continue;
        const finish = startCall("skill", pick.id);
        let ok = false;
        try {
          const body = stripFrontmatter(readFileSync(skillFile, "utf8")).trim();
          if (!body) continue;
          const remaining = maxChars - used;
          if (remaining < 200) break;
          const cap = Math.min(perSkillCap, remaining);
          const excerpt =
            body.length > cap ? `${body.slice(0, cap)}\n…（自动精简注入；完整内容可 load_skill("${pick.id}")）` : body;
          const block = `### 指纹触发 Skill：${pack.name} (\`${pick.id}\` · 命中: ${pick.matched.slice(0, 4).join(", ")})\n${excerpt}`;
          sections.push(block);
          used += block.length;
          autoInjected.add(pick.id);
          ok = true;
          appendProgress(
            manifest.workspaceDir,
            `auto_skill ${pick.id} (triggers=${pick.matched.slice(0, 3).join(",")}, chars=${excerpt.length})`,
          );
        } catch {
          /* skip unreadable skill */
        } finally {
          finish(ok);
        }
      }
      if (!sections.length) return "";
      return `## 指纹自动注入专精指南（每会话去重 · 预算硬顶 ≤1500 tokens）\n${sections.join("\n\n")}`;
    },

    loadedIds: () => [...loaded],
  };
}

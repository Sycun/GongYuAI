import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { WorkerSkillPack } from "@gongyuai/contracts";

export type LoadedSkill = { id: string; name: string; body: string };

export function loadSkillPacks(packs: WorkerSkillPack[]): LoadedSkill[] {
  const out: LoadedSkill[] = [];
  for (const pack of packs ?? []) {
    const path = join(pack.rootDir, "SKILL.md");
    if (!existsSync(path)) continue;
    try {
      const raw = readFileSync(path, "utf8");
      out.push({ id: pack.id, name: pack.name, body: stripFrontmatter(raw).trim() });
    } catch {
      /* skip */
    }
  }
  return out;
}

export function skillsPromptBlock(packs: WorkerSkillPack[]): string {
  const loaded = loadSkillPacks(packs);
  if (!loaded.length) return "";
  const parts = loaded.map(
    (s) => `### Skill: ${s.name} (\`${s.id}\`)\n\n${s.body}`,
  );
  return `\n启用的 Skill（彼此独立）：\n\n${parts.join("\n\n")}\n`;
}

function stripFrontmatter(raw: string): string {
  if (!raw.startsWith("---")) return raw;
  const end = raw.indexOf("\n---", 3);
  if (end < 0) return raw;
  return raw.slice(end + 4);
}

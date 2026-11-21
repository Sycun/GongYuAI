import type { WorkerManifest, WorkerSkillPack } from "@gongyuai/contracts";
import type { HistoryStore } from "@gongyuai/history";
import { appendProgress } from "../tools.js";
import { loadToolsRuntime, saveToolsRuntime } from "../tools-runtime.js";
import { loadSkillPacks, skillsPromptBlock } from "./load.js";

export type SkillHub = {
  enabledPacks(): WorkerSkillPack[];
  promptBlock(): string;
  catalogLines(): string[];
  enable(id: string, reason: string): string;
  disable(id: string, reason: string): string;
};

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

  const runtime = loadToolsRuntime(manifest.dataDir);
  const enabled = new Set<string>([
    ...(manifest.skillPacks ?? []).map((s) => s.id),
    ...(runtime?.skillEnabledIds ?? []),
  ]);

  function persist(): void {
    const mcpEnabledIds = runtime?.mcpEnabledIds ?? (manifest.mcpServers ?? []).map((s) => s.id);
    // Prefer live MCP ids from tools-runtime if worker already wrote them.
    const live = loadToolsRuntime(manifest.dataDir);
    saveToolsRuntime(manifest.dataDir, {
      mcpEnabledIds: live?.mcpEnabledIds ?? mcpEnabledIds,
      skillEnabledIds: [...enabled],
    });
  }

  persist();

  return {
    enabledPacks: () =>
      [...enabled]
        .map((id) => pool.get(id))
        .filter((p): p is WorkerSkillPack => Boolean(p)),
    promptBlock: () => skillsPromptBlock(
      [...enabled]
        .map((id) => pool.get(id))
        .filter((p): p is WorkerSkillPack => Boolean(p)),
    ),
    catalogLines: () => {
      const lines: string[] = [];
      const catalog =
        manifest.skillCatalog?.length
          ? manifest.skillCatalog
          : [...pool.values()].map((p) => ({
              id: p.id,
              name: p.name,
              description: "",
              category: "skill",
            }));
      for (const c of catalog) {
        if (enabled.has(c.id)) continue;
        lines.push(
          `- \`${c.id}\` ${c.name}${c.description ? ` — ${c.description}` : ""}`,
        );
      }
      return lines;
    },
    enable(id, reason) {
      const pack = pool.get(id);
      if (!pack) return `未知 Skill id：${id}`;
      if (enabled.has(id)) return `Skill ${id} 已启用`;
      const loaded = loadSkillPacks([pack]);
      if (!loaded.length) return `Skill ${id} 缺少 SKILL.md`;
      enabled.add(id);
      persist();
      appendProgress(manifest.workspaceDir, `enable_skill ${id} · ${reason.slice(0, 120)}`);
      history.appendFact({
        taskId: manifest.taskId,
        layer: "summary",
        title: `解锁 Skill ${id}`,
        summary: reason.slice(0, 500),
      });
      return `已启用 Skill ${id}（${pack.name}）。理由：${reason.slice(0, 200)}`;
    },
    disable(id, reason) {
      if (!enabled.has(id)) return `Skill ${id} 未启用`;
      enabled.delete(id);
      persist();
      appendProgress(manifest.workspaceDir, `disable_skill ${id} · ${reason.slice(0, 120)}`);
      history.appendFact({
        taskId: manifest.taskId,
        layer: "summary",
        title: `关闭 Skill ${id}`,
        summary: reason.slice(0, 500),
      });
      return `已关闭 Skill ${id}`;
    },
  };
}

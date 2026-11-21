import type { WorkerManifest, WorkerMcpServer } from "@gongyuai/contracts";
import type { ToolContext } from "../tools.js";
import { appendProgress } from "../tools.js";
import { loadToolsRuntime, saveToolsRuntime } from "../tools-runtime.js";
import { createBuiltinFromRoot } from "./builtin/from-manifest.js";
import { openHttpSession } from "./http-session.js";
import { openStdioSession } from "./stdio-session.js";
import {
  mcpToolName,
  parseMcpToolName,
  type McpServerSession,
  type OpenAiFunctionTool,
} from "./types.js";

export type McpHub = {
  openaiTools: OpenAiFunctionTool[];
  promptLines: string[];
  catalogLines(): string[];
  enabledIds(): string[];
  enable(id: string, reason: string): Promise<string>;
  disable(id: string, reason: string): Promise<string>;
  call(fullName: string, args: Record<string, unknown>): Promise<string>;
  /** Call by serverId + toolName (for Pi after mid-run unlock). */
  invoke(serverId: string, toolName: string, args: Record<string, unknown>): Promise<string>;
  close(): Promise<void>;
};

export async function openMcpHub(
  manifest: WorkerManifest,
  ctx: ToolContext,
): Promise<McpHub> {
  const pool = new Map<string, WorkerMcpServer>();
  for (const cfg of manifest.mcpPool?.length ? manifest.mcpPool : manifest.mcpServers ?? []) {
    pool.set(cfg.id, cfg);
  }
  // Ensure initially enabled servers are in the pool.
  for (const cfg of manifest.mcpServers ?? []) {
    if (!pool.has(cfg.id)) pool.set(cfg.id, cfg);
  }

  const sessions = new Map<string, McpServerSession>();
  const openaiTools: OpenAiFunctionTool[] = [];
  const promptLines: string[] = [];
  const enabled = new Set<string>();

  const runtime = loadToolsRuntime(manifest.dataDir);
  const initialIds = new Set<string>([
    ...(manifest.mcpServers ?? []).map((s) => s.id),
    ...(runtime?.mcpEnabledIds ?? []),
  ]);

  async function attach(cfg: WorkerMcpServer): Promise<string> {
    if (sessions.has(cfg.id)) {
      enabled.add(cfg.id);
      return `MCP ${cfg.id} 已启用`;
    }
    const session = await openOne(cfg, ctx);
    if (!session) {
      return `MCP ${cfg.id} 无法连接（配置不全或 adapter 缺失）`;
    }
    sessions.set(cfg.id, session);
    enabled.add(cfg.id);
    const tools = await session.listTools();
    const names: string[] = [];
    for (const t of tools) {
      const full = mcpToolName(cfg.id, t.name);
      names.push(t.name);
      if (!openaiTools.some((x) => x.function.name === full)) {
        openaiTools.push({
          type: "function",
          function: {
            name: full,
            description: `[MCP:${cfg.id}] ${t.description}`,
            parameters: t.inputSchema,
          },
        });
      }
    }
    const line = `- MCP \`${cfg.id}\`（${cfg.name}）: ${names.map((n) => mcpToolName(cfg.id, n)).join(", ") || "（无工具）"}`;
    if (!promptLines.some((l) => l.includes(`\`${cfg.id}\``))) {
      promptLines.push(line);
    }
    return `已启用 MCP ${cfg.id}；工具：${names.map((n) => mcpToolName(cfg.id, n)).join(", ") || "无"}`;
  }

  function persist(): void {
    const live = loadToolsRuntime(manifest.dataDir);
    saveToolsRuntime(manifest.dataDir, {
      mcpEnabledIds: [...enabled],
      skillEnabledIds:
        live?.skillEnabledIds ??
        runtime?.skillEnabledIds ??
        (manifest.skillPacks ?? []).map((s) => s.id),
    });
  }

  function catalogLines(): string[] {
    const lines: string[] = [];
    const catalog =
      manifest.mcpCatalog?.length
        ? manifest.mcpCatalog
        : [...pool.values()].map((c) => ({
            id: c.id,
            name: c.name,
            description: "",
            category: "general",
          }));
    for (const c of catalog) {
      if (enabled.has(c.id)) continue;
      lines.push(
        `- \`${c.id}\` [${c.category}] ${c.name}${c.description ? ` — ${c.description}` : ""}`,
      );
    }
    return lines;
  }

  for (const id of initialIds) {
    const cfg = pool.get(id);
    if (!cfg) continue;
    try {
      const msg = await attach(cfg);
      if (msg.includes("无法")) {
        appendProgress(manifest.workspaceDir, msg);
      }
    } catch (err) {
      appendProgress(
        manifest.workspaceDir,
        `MCP ${id} 失败：${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  persist();

  return {
    openaiTools,
    promptLines,
    catalogLines,
    enabledIds: () => [...enabled],
    async enable(id, reason) {
      const cfg = pool.get(id);
      if (!cfg) return `未知 MCP id：${id}（不在 mcpPool/目录中）`;
      if (enabled.has(id) && sessions.has(id)) {
        return `MCP ${id} 已处于启用状态`;
      }
      const msg = await attach(cfg);
      persist();
      appendProgress(manifest.workspaceDir, `enable_mcp ${id} · ${reason.slice(0, 120)}`);
      ctx.history.appendFact({
        taskId: manifest.taskId,
        layer: "summary",
        title: `解锁 MCP ${id}`,
        summary: reason.slice(0, 500),
      });
      return `${msg}。理由：${reason.slice(0, 200)}`;
    },
    async disable(id, reason) {
      if (!enabled.has(id)) return `MCP ${id} 未启用`;
      const session = sessions.get(id);
      if (session) {
        try {
          await session.close();
        } catch {
          /* ignore */
        }
        sessions.delete(id);
      }
      enabled.delete(id);
      // Remove tool schemas for this server
      for (let i = openaiTools.length - 1; i >= 0; i--) {
        if (openaiTools[i]!.function.name.startsWith(`mcp__${id}__`)) {
          openaiTools.splice(i, 1);
        }
      }
      for (let i = promptLines.length - 1; i >= 0; i--) {
        if (promptLines[i]!.includes(`\`${id}\``)) promptLines.splice(i, 1);
      }
      persist();
      appendProgress(manifest.workspaceDir, `disable_mcp ${id} · ${reason.slice(0, 120)}`);
      ctx.history.appendFact({
        taskId: manifest.taskId,
        layer: "summary",
        title: `关闭 MCP ${id}`,
        summary: reason.slice(0, 500),
      });
      return `已关闭 MCP ${id}`;
    },
    async call(fullName, args) {
      const parsed = parseMcpToolName(fullName);
      if (!parsed) return `不是 MCP 工具: ${fullName}`;
      if (!enabled.has(parsed.serverId)) {
        return `MCP 未启用: ${parsed.serverId}。先调用 enable_mcp。`;
      }
      const session = sessions.get(parsed.serverId);
      if (!session) return `MCP 会话丢失: ${parsed.serverId}`;
      ctx.usage.toolCalls += 1;
      if (ctx.usage.toolCalls > ctx.manifest.budget.maxToolCalls) {
        throw new Error("maxToolCalls exceeded");
      }
      const r = await session.callTool(parsed.toolName, args);
      return r.text.slice(0, 12_000);
    },
    async invoke(serverId, toolName, args) {
      if (!enabled.has(serverId)) {
        return `MCP 未启用: ${serverId}。先调用 enable_mcp。`;
      }
      const session = sessions.get(serverId);
      if (!session) return `MCP 会话丢失: ${serverId}`;
      ctx.usage.toolCalls += 1;
      if (ctx.usage.toolCalls > ctx.manifest.budget.maxToolCalls) {
        throw new Error("maxToolCalls exceeded");
      }
      const r = await session.callTool(toolName, args);
      return r.text.slice(0, 12_000);
    },
    async close() {
      for (const s of sessions.values()) {
        try {
          await s.close();
        } catch {
          /* ignore */
        }
      }
      sessions.clear();
    },
  };
}

async function openOne(
  cfg: WorkerMcpServer,
  ctx: ToolContext,
): Promise<McpServerSession | null> {
  if (cfg.transport === "builtin") {
    if (!cfg.rootDir) return null;
    return createBuiltinFromRoot(cfg.id, cfg.rootDir, ctx);
  }
  if (cfg.transport === "stdio") {
    if (!cfg.command) return null;
    return openStdioSession(cfg.id, cfg.command, cfg.args ?? [], cfg.env ?? {});
  }
  if (cfg.transport === "http") {
    if (!cfg.url) return null;
    return openHttpSession(cfg.id, cfg.url, cfg.env ?? {});
  }
  return null;
}

export function isMcpToolName(name: string): boolean {
  return Boolean(parseMcpToolName(name));
}

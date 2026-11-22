import {
  isIpv4Cidr,
  targetAllows,
  type WorkerManifest,
  type WorkerMcpServer,
} from "@gongyuai/contracts";
import type { ToolContext } from "../tools.js";
import { appendProgress, assertCapabilityAllows, chargeToolCall, gateTool, mcpActionForServer } from "../tools.js";
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

  async function attach(id: string): Promise<string> {
    const cfg = gateTool(ctx, "enable_mcp", () => {
      const server = pool.get(id);
      if (!server) throw new Error(`未知 MCP id：${id}（不在 mcpPool/目录中）`);
      assertCapabilityAllows(manifest, mcpActionForServer(id));
      return server;
    }, { serverId: id });
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
    try {
      const msg = await attach(id);
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

  async function invoke(serverId: string, toolName: string, args: Record<string, unknown>) {
    const session = gateTool(ctx, "mcp", () => {
      assertCapabilityAllows(manifest, mcpActionForServer(serverId));
      if (!enabled.has(serverId)) {
        throw new Error(`MCP 未启用: ${serverId}。先调用 enable_mcp。`);
      }
      const active = sessions.get(serverId);
      if (!active) throw new Error(`MCP 会话丢失: ${serverId}`);
      if (!openaiTools.some((tool) => tool.function.name === mcpToolName(serverId, toolName))) {
        throw new Error(`未知 MCP 工具: ${serverId}/${toolName}`);
      }
      const builtin = pool.get(serverId)?.transport === "builtin";
      if (builtin || typeof args.target === "string") {
        const target = typeof args.target === "string" ? args.target.trim() : "";
        const { targets, outOfScope } = manifest.auth;
        const allowed = isIpv4Cidr(target)
          ? targets.includes(target) && !outOfScope?.length && targetAllows(targets, target)
          : target && !/\s|\*/.test(target) && targetAllows(targets, target, outOfScope);
        if (!allowed) throw new Error("denied: MCP target is outside the authorized scope");
      }
      chargeToolCall(ctx);
      return active;
    }, { serverId, toolName });
    const result = await session.callTool(toolName, args);
    return result.text.slice(0, 12_000);
  }

  return {
    openaiTools,
    promptLines,
    catalogLines,
    enabledIds: () => [...enabled],
    async enable(id, reason) {
      const msg = await attach(id);
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
      if (!parsed) {
        return gateTool(ctx, "mcp", () => {
          throw new Error(`不是 MCP 工具: ${fullName}`);
        });
      }
      return invoke(parsed.serverId, parsed.toolName, args);
    },
    invoke,
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

export type McpToolDef = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
};

export type McpCallResult = { ok: boolean; text: string };

export type McpServerSession = {
  serverId: string;
  listTools(): Promise<McpToolDef[]>;
  callTool(name: string, args: Record<string, unknown>): Promise<McpCallResult>;
  close(): Promise<void>;
};

export type OpenAiFunctionTool = {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
};

export function mcpToolName(serverId: string, toolName: string): string {
  return `mcp__${serverId}__${toolName}`;
}

export function parseMcpToolName(
  full: string,
): { serverId: string; toolName: string } | null {
  if (!full.startsWith("mcp__")) return null;
  const rest = full.slice("mcp__".length);
  const idx = rest.indexOf("__");
  if (idx <= 0) return null;
  return { serverId: rest.slice(0, idx), toolName: rest.slice(idx + 2) };
}

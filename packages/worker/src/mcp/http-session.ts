import type { McpCallResult, McpServerSession, McpToolDef } from "./types.js";

export async function openHttpSession(
  serverId: string,
  url: string,
  env: Record<string, string>,
): Promise<McpServerSession> {
  let nextId = 1;
  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: "application/json",
  };
  if (env.AUTHORIZATION) headers.authorization = env.AUTHORIZATION;
  if (env.MCP_AUTH_TOKEN) headers.authorization = `Bearer ${env.MCP_AUTH_TOKEN}`;

  async function rpc(method: string, params: unknown): Promise<unknown> {
    const id = nextId++;
    const res = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`HTTP MCP ${res.status}: ${text.slice(0, 400)}`);
    const msg = JSON.parse(text) as { result?: unknown; error?: unknown };
    if (msg.error) throw new Error(JSON.stringify(msg.error));
    return msg.result;
  }

  await rpc("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "gongyuai-worker", version: "0.1.0" },
  });

  return {
    serverId,
    async listTools() {
      const res = (await rpc("tools/list", {})) as {
        tools?: Array<{
          name: string;
          description?: string;
          inputSchema?: Record<string, unknown>;
        }>;
      };
      return (res.tools ?? []).map(
        (t): McpToolDef => ({
          name: t.name,
          description: t.description ?? t.name,
          inputSchema: t.inputSchema ?? { type: "object", properties: {} },
        }),
      );
    },
    async callTool(name, args): Promise<McpCallResult> {
      try {
        const res = (await rpc("tools/call", {
          name,
          arguments: args,
        })) as { content?: Array<{ text?: string }>; isError?: boolean };
        const text = (res.content ?? [])
          .map((c) => c.text ?? "")
          .filter(Boolean)
          .join("\n");
        return { ok: !res.isError, text: text || JSON.stringify(res) };
      } catch (err) {
        return { ok: false, text: err instanceof Error ? err.message : String(err) };
      }
    },
    async close() {},
  };
}

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import type { McpCallResult, McpServerSession, McpToolDef } from "./types.js";

export async function openStdioSession(
  serverId: string,
  command: string,
  args: string[],
  env: Record<string, string>,
): Promise<McpServerSession> {
  const child = spawn(command, args, {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, ...env },
  });
  const rpc = new JsonRpc(child);
  await rpc.request("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "gongyuai-worker", version: "0.1.0" },
  });
  void rpc.notify("notifications/initialized", {});

  return {
    serverId,
    async listTools() {
      const res = (await rpc.request("tools/list", {})) as {
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
        const res = (await rpc.request("tools/call", {
          name,
          arguments: args,
        })) as {
          content?: Array<{ text?: string }>;
          isError?: boolean;
        };
        const text = (res.content ?? [])
          .map((c) => c.text ?? "")
          .filter(Boolean)
          .join("\n");
        return { ok: !res.isError, text: text || JSON.stringify(res) };
      } catch (err) {
        return { ok: false, text: err instanceof Error ? err.message : String(err) };
      }
    },
    async close() {
      rpc.close();
      child.kill("SIGTERM");
    },
  };
}

class JsonRpc {
  private nextId = 1;
  private buffer = "";
  private readonly pending = new Map<
    number,
    { resolve: (v: unknown) => void; reject: (e: Error) => void }
  >();

  constructor(private readonly child: ChildProcessWithoutNullStreams) {
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => this.onData(chunk));
    child.stderr.on("data", () => {});
    child.on("exit", () => {
      for (const [, p] of this.pending) p.reject(new Error("MCP process exited"));
      this.pending.clear();
    });
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    while (true) {
      const headerEnd = this.buffer.indexOf("\r\n\r\n");
      if (headerEnd < 0) {
        const nl = this.buffer.indexOf("\n");
        if (nl < 0) return;
        const line = this.buffer.slice(0, nl).trim();
        this.buffer = this.buffer.slice(nl + 1);
        if (!line || line.startsWith("Content-Length")) continue;
        try {
          this.handleMessage(JSON.parse(line) as Record<string, unknown>);
        } catch {
          /* ignore */
        }
        continue;
      }
      const header = this.buffer.slice(0, headerEnd);
      const match = /Content-Length:\s*(\d+)/i.exec(header);
      if (!match) {
        this.buffer = this.buffer.slice(headerEnd + 4);
        continue;
      }
      const len = Number(match[1]);
      const bodyStart = headerEnd + 4;
      if (this.buffer.length < bodyStart + len) return;
      const body = this.buffer.slice(bodyStart, bodyStart + len);
      this.buffer = this.buffer.slice(bodyStart + len);
      try {
        this.handleMessage(JSON.parse(body) as Record<string, unknown>);
      } catch {
        /* ignore */
      }
    }
  }

  private handleMessage(msg: Record<string, unknown>): void {
    if (typeof msg.id === "number" && this.pending.has(msg.id)) {
      const p = this.pending.get(msg.id)!;
      this.pending.delete(msg.id);
      if (msg.error) p.reject(new Error(JSON.stringify(msg.error)));
      else p.resolve(msg.result);
    }
  }

  request(method: string, params: unknown): Promise<unknown> {
    const id = this.nextId++;
    const payload = JSON.stringify({ jsonrpc: "2.0", id, method, params });
    const frame = `Content-Length: ${Buffer.byteLength(payload)}\r\n\r\n${payload}`;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.child.stdin.write(frame, (err) => {
        if (err) {
          this.pending.delete(id);
          reject(err);
        }
      });
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`MCP timeout: ${method}`));
        }
      }, 60_000);
    });
  }

  notify(method: string, params: unknown): void {
    const payload = JSON.stringify({ jsonrpc: "2.0", method, params });
    const frame = `Content-Length: ${Buffer.byteLength(payload)}\r\n\r\n${payload}`;
    this.child.stdin.write(frame);
  }

  close(): void {
    try {
      this.child.stdin.end();
    } catch {
      /* ignore */
    }
  }
}

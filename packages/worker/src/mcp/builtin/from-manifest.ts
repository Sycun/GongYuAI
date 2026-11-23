import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ToolContext } from "../../tools.js";
import type { McpCallResult, McpServerSession, McpToolDef } from "../types.js";
import { runCliTool } from "./run-cli.js";

type McpJson = {
  id?: string;
  binary?: string;
  defaultFlags?: string;
  toolName?: string;
  toolDescription?: string;
  description?: string;
};

/** Generic one-tool MCP session driven by mcp/<id>/mcp.json — fully decoupled. */
export function createBuiltinFromRoot(
  serverId: string,
  rootDir: string,
  ctx: ToolContext,
): McpServerSession | null {
  const metaPath = join(rootDir, "mcp.json");
  if (!existsSync(metaPath)) return null;
  let meta: McpJson;
  try {
    meta = JSON.parse(readFileSync(metaPath, "utf8")) as McpJson;
  } catch {
    return null;
  }
  const binary = meta.binary ?? serverId;
  const toolName = meta.toolName ?? "run";
  const toolDescription =
    meta.toolDescription ?? meta.description ?? `Run ${binary}`;
  const defaultFlags = meta.defaultFlags ?? "";

  const tools: McpToolDef[] = [
    {
      name: toolName,
      description: toolDescription,
      inputSchema: {
        type: "object",
        properties: {
          target: { type: "string", description: "Authorized host/URL/CIDR" },
          flags: {
            type: "string",
            description: `Extra CLI flags (default: ${defaultFlags || "none"})`,
          },
          extraArgs: {
            type: "string",
            description: "Additional argv joined by spaces",
          },
        },
        required: ["target"],
      },
    },
  ];

  return {
    serverId,
    async listTools() {
      return tools;
    },
    async callTool(name, args): Promise<McpCallResult> {
      if (name !== toolName) return { ok: false, text: `unknown tool ${name}` };
      const target = String(args.target ?? "");
      const flags = String(args.flags ?? defaultFlags);
      const extra = String(args.extraArgs ?? "");
      const flagArgs = flags.trim() ? flags.trim().split(/\s+/) : [];
      const extraArgs = extra.trim() ? extra.trim().split(/\s+/) : [];
      // Heuristic argv shapes for common Kali CLIs
      let argv: string[];
      if (["httpx", "nuclei", "wapiti", "feroxbuster", "dirsearch", "arjun", "wpscan"].includes(binary)) {
        argv = [...flagArgs, "-u", target, ...extraArgs];
      } else if (binary === "nikto") {
        argv = [...flagArgs, "-h", target, ...extraArgs];
      } else if (binary === "gobuster") {
        argv = flagArgs[0] === "dir" || flagArgs[0] === "dns" || flagArgs[0] === "vhost"
          ? [...flagArgs, "-u", target, ...extraArgs]
          : ["dir", "-u", target, ...flagArgs, ...extraArgs];
      } else if (binary === "sqlmap") {
        argv = ["-u", target, ...flagArgs, ...extraArgs];
      } else if (binary === "dalfox") {
        argv = ["url", target, ...flagArgs, ...extraArgs];
      } else if (binary === "subfinder") {
        argv = ["-d", target, ...flagArgs, ...extraArgs];
      } else if (binary === "dnsrecon" || binary === "theHarvester") {
        argv = ["-d", target, ...flagArgs, ...extraArgs];
      } else if (binary === "smbmap") {
        argv = ["-H", target, ...flagArgs, ...extraArgs];
      } else if (binary === "netexec") {
        argv = [...flagArgs, target, ...extraArgs];
      } else {
        argv = [...flagArgs, target, ...extraArgs];
      }
      const r = await runCliTool(ctx, {
        binary,
        args: argv,
        evidenceRel: `mcp/${serverId}/${Date.now()}.txt`,
        timeoutMs: 600_000,
      });
      return {
        ok: r.exitCode === 0,
        text: JSON.stringify({
          exitCode: r.exitCode,
          evidencePath: r.evidencePath,
          stdout: r.stdout.slice(0, 8000),
          stderr: r.stderr.slice(0, 2000),
        }),
      };
    },
    async close() {},
  };
}

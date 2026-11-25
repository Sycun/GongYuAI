import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ToolContext } from "../../tools.js";
import type { McpCallResult, McpServerSession, McpToolDef } from "../types.js";
import { runCliTool } from "./run-cli.js";

type McpJson = {
  id?: string;
  binary?: string;
  defaultFlags?: string;
  targetFlag?: string;
  toolName?: string;
  toolDescription?: string;
  description?: string;
  whenToUse?: string;
  timeoutMs?: number;
};

/** Normalize CLI flag/extra arguments from either a space-separated string or a JSON string array. */
export function normalizeArgList(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value
      .flatMap((item) =>
        typeof item === "string" || typeof item === "number"
          ? String(item).trim().split(/\s+/)
          : [],
      )
      .filter(Boolean);
  }
  if (typeof value === "string") {
    return value.trim() ? value.trim().split(/\s+/) : [];
  }
  return [];
}

/** P15: explicit target flag + subcommand-first argv. Exported for tests. */
export function buildMcpArgv(input: {
  flags: string | string[];
  targetFlag: string;
  target: string;
  extraArgs: string | string[];
}): string[] {
  const flagArgs = normalizeArgList(input.flags);
  const extra = normalizeArgList(input.extraArgs);
  return [
    ...flagArgs,
    ...(input.targetFlag ? [input.targetFlag] : []),
    input.target,
    ...extra,
  ];
}

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
  const toolDescription = [
    meta.toolDescription ?? meta.description ?? `Run ${binary}`,
    meta.whenToUse ?? "",
  ].filter(Boolean).join(" ");
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
      const flagArgs = normalizeArgList(args.flags === undefined || args.flags === null ? defaultFlags : args.flags);
      const extraArgs = normalizeArgList(args.extraArgs);
      // Support common top-level `wordlist` parameter (e.g. ffuf) when not already specified via -w/--wordlist.
      if (
        typeof args.wordlist === "string" &&
        args.wordlist.trim() &&
        ![...flagArgs, ...extraArgs].some((tok) => tok === "-w" || tok === "--wordlist" || tok.startsWith("-w=") || tok.startsWith("--wordlist="))
      ) {
        extraArgs.push("-w", args.wordlist.trim());
      }
      // P15: explicit targetFlag from mcp.json; subcommands stay in defaultFlags.
      // ffuf/gobuster/netexec/amass put their subcommand first, which this preserves.
      const argv = buildMcpArgv({
        flags: flagArgs,
        targetFlag: meta.targetFlag ?? "",
        target,
        extraArgs,
      });
      const r = await runCliTool(ctx, {
        binary,
        args: argv,
        evidenceRel: `mcp/${serverId}/${Date.now()}.txt`,
        timeoutMs: meta.timeoutMs ?? 600_000,
      });
      return {
        ok: r.exitCode === 0,
        text: JSON.stringify({
          exitCode: r.exitCode,
          evidencePath: r.evidencePath,
          stdout: r.stdout.slice(0, 8000),
          stderr: r.stderr.slice(0, 2000),
        }),
        // P15-C4: parsers get the full stdout, not the model-facing slice.
        raw: r.stdout,
      };
    },
    async close() {},
  };
}

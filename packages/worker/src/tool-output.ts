import {
  parseToolOutput,
  type ParsedToolOutput,
  type SupportedTool,
} from "@gongyuai/contracts";
import type { ToolContext } from "./tools.js";

/** Shell-invoked tools that have a structured parser (P15-C4). */
const SHELL_TOOLS: Record<string, SupportedTool> = {
  nmap: "nmap",
  httpx: "httpx",
  nuclei: "nuclei",
  ffuf: "ffuf",
};

const MACHINE_FLAGS: Record<SupportedTool, string> = {
  nmap: "-oX -",
  httpx: "-json",
  nuclei: "-jsonl",
  ffuf: "-of json -o <file>",
};

export function shellParserTool(command: string): SupportedTool | null {
  const first = command.trim().split(/\s+/)[0] ?? "";
  const base = first.split("/").pop() ?? "";
  return SHELL_TOOLS[base] ?? null;
}

/**
 * P15-C4 — shell output is parsed too, not only MCP output. If the command
 * belongs to a parser-backed tool but the output is not machine-readable, the
 * model gets an explicit instruction to re-run with the right flag; we never
 * silently treat free text as a structured result.
 */
export function parseShellOutput(
  ctx: ToolContext,
  command: string,
  stdout: string,
  opts?: { strict?: boolean },
): string {
  const tool = shellParserTool(command);
  if (!tool) return "";
  const result = parseAndRecord(ctx, tool, stdout, { intentId: ctx.getActiveIntentId?.() });
  if (result.skipped) {
    if (opts?.strict === false) return "";
    return `\n[parser] mandatory: ${tool} output is not machine-readable; re-run with ${MACHINE_FLAGS[tool]}`;
  }
  return parseSummaryLine(result);
}

/** Server ids that ship machine-readable output we know how to parse. */
const TOOL_BY_SERVER: Record<string, SupportedTool> = {
  nmap: "nmap",
  httpx: "httpx",
  nuclei: "nuclei",
  ffuf: "ffuf",
  "ffuf-json": "ffuf",
};

export function toolForServer(serverId: string): SupportedTool | null {
  return TOOL_BY_SERVER[serverId.toLowerCase()] ?? null;
}

/**
 * P14-B1 — parser lane: transport machine-readable tool output into the
 * inventory and tentative findings. Never upgrades a conclusion; unknown or
 * malformed output returns `skipped` and records nothing.
 */
export function parseAndRecord(
  ctx: ToolContext,
  tool: SupportedTool,
  text: string,
  opts: { intentId?: string | null } = {},
): ParsedToolOutput & { recordedAssets: number; recordedFindings: number } {
  const parsed = parseToolOutput(tool, text);
  const activeIntentId = opts.intentId !== undefined ? opts.intentId : ctx.getActiveIntentId?.();
  let recordedAssets = 0;
  let recordedFindings = 0;
  for (const asset of parsed.assets) {
    // Services are per-port identities; endpoints keep their path.
    const address =
      asset.kind === "service" && asset.attrs.port
        ? `${asset.address}:${asset.attrs.port}`
        : asset.address;
    try {
      const result = ctx.history.recordAsset({
        taskId: ctx.manifest.taskId,
        address,
        auth: ctx.manifest.auth,
        source: "discover",
        assetType: asset.kind,
        ...(asset.parent ? { parentAddress: asset.parent } : {}),
        summary: `${tool} 解析 · ${JSON.stringify(asset.attrs)}`,
        ...(activeIntentId !== undefined ? { intentId: activeIntentId } : {}),
      });
      if (result.created) recordedAssets += 1;
    } catch {
      /* a bad single row must not abort the batch */
    }
  }
  for (const finding of parsed.findings) {
    try {
      const result = ctx.history.recordFinding({
        taskId: ctx.manifest.taskId,
        title: finding.title,
        asset: finding.asset,
        vulnClass: finding.vulnClass,
        severity: finding.severity,
        endpoint: finding.endpoint ?? null,
        ...(activeIntentId !== undefined ? { intentId: activeIntentId } : {}),
      });
      if (result.created) recordedFindings += 1;
    } catch {
      /* same: keep transporting the rest */
    }
  }
  return { ...parsed, recordedAssets, recordedFindings };
}

/** One-line summary appended to the model-visible tool result. */
export function parseSummaryLine(result: ParsedToolOutput & { recordedAssets: number; recordedFindings: number }): string {
  if (result.skipped) return `\n[parser] skipped: ${result.reason ?? "no parser"}`;
  return `\n[parser] assets=${result.assets.length} (new ${result.recordedAssets}) findings=${result.findings.length} (new ${result.recordedFindings})`;
}

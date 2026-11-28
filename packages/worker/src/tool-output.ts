import {
  parseToolOutput,
  type ParsedToolOutput,
  type SupportedTool,
} from "@gongyuai/contracts";
import type { ToolContext } from "./tools.js";

const ANSI_SEQUENCE = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;

/** Scanner progress chatter that never carries evidence (ports/paths/headers). */
const PROGRESS_NOISE: RegExp[] = [
  // "Progress: [=====>    ] 42%", ffuf ":: Progress: [123/5000] :: Job ..."
  /^\s*(?:::\s*)?progress\s*[:=]/i,
  // "[####################] 100%"
  /^\s*\[[=>.#\-\s]*\]\s*\d{1,3}\s*%/,
  // masscan "rate: 1234.00-kpps, 0.01% done, ..." / generic "rate: 100/s"
  /^\s*(?:\[\s*[^\]]*\s*\]\s*)?rate\s*[:=]\s*[\d.]+\s*[-a-z0-9/]*(?:pps|\/s)\b/i,
  // "42% |█████     | 123/500"
  /^\s*\d{1,3}\s*%\s*\|/,
  // "[12:34:56] 42%"
  /^\s*\[?\d{2}:\d{2}:\d{2}\]?\s*\[?\d{1,3}\s*%\s*\]?\s*$/,
];

function isProgressNoise(line: string): boolean {
  return PROGRESS_NOISE.some((pattern) => pattern.test(line));
}

/** Lines that differ only by timestamps / leading sequence counters are duplicates. */
function foldKey(line: string): string {
  return line
    .replace(
      /\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:[.,]\d+)?(?:Z|[+-]\d{2}:?\d{2})?/g,
      "<ts>",
    )
    .replace(/\b\d{2}:\d{2}:\d{2}(?:[.,]\d+)?\b/g, "<ts>")
    .replace(/^(\s*(?:\[\s*)?)\d+(\s*\])?[.:)]?\s+/, "$1# ");
}

/**
 * P18 — keep the 12k-character window for real results. Strips ANSI, removes
 * scanner progress spam (carriage-return redraws included), and folds runs of
 * >=4 identical (or timestamp/counter-only differing) log lines to
 * first + last + `… [已折叠 N 行重复扫描输出]`.
 */
export function foldRepetitiveToolNoise(text: string): string {
  if (!text) return text;
  const cleaned = text.replace(ANSI_SEQUENCE, "").replace(/\r\n/g, "\n");
  const lines = cleaned.split("\n").map((line) => {
    const overwritten = line.lastIndexOf("\r");
    return overwritten >= 0 ? line.slice(overwritten + 1) : line;
  });
  const out: string[] = [];
  let index = 0;
  while (index < lines.length) {
    const key = foldKey(lines[index]!);
    let end = index + 1;
    if (key.trim() !== "" && !isProgressNoise(lines[index]!)) {
      while (end < lines.length && foldKey(lines[end]!) === key && !isProgressNoise(lines[end]!)) {
        end += 1;
      }
    }
    const run = end - index;
    if (run >= 4) {
      out.push(lines[index]!);
      out.push(lines[end - 1]!);
      out.push(`… [已折叠 ${run - 2} 行重复扫描输出]`);
    } else {
      for (let k = index; k < end; k += 1) {
        if (isProgressNoise(lines[k]!)) continue;
        out.push(lines[k]!);
      }
    }
    index = end;
  }
  // Collapse 3+ consecutive blank lines left behind by removed progress bars.
  const compacted: string[] = [];
  let blanks = 0;
  for (const line of out) {
    if (line.trim() === "") {
      blanks += 1;
      if (blanks >= 2) continue;
    } else {
      blanks = 0;
    }
    compacted.push(line);
  }
  return compacted.join("\n");
}

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

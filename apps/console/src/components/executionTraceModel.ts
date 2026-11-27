import type { ExecutionStep, ExecutionTracePage } from "@gongyuai/contracts";
import { parseTime } from "../time";

export type TraceFact = {
  id?: string;
  title: string;
  summary: string;
  layer: string;
  createdAt: string;
};

export type TraceNode = {
  id: string;
  at: string;
  label: string;
  tools: string[];
  stepNum?: number;
  tokens?: number;
  step?: ExecutionStep;
  fact?: TraceFact;
  kind: "step" | "event";
  timelineType: "default" | "ongoing" | "success" | "warning" | "error";
};

/** `2026-11-21 16:27 第 10 步 · 工具 shell · Token 66626`（旧行仍可能是 ISO Z） */
export function parseProgressLine(line: string): {
  at: string;
  body: string;
  stepNum?: number;
  tools: string[];
  tokens?: number;
} {
  const m = line.match(
    /^(\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z)?)?)\s+(.*)$/,
  );
  const at = m?.[1] ?? "";
  const body = m?.[2] ?? line;
  const stepM = body.match(/第\s*(\d+)\s*步/);
  const toolM = body.match(/工具\s+([^·]+)/);
  const tokenM = body.match(/Token\s+(\d+)/i);
  const tools = toolM
    ? toolM[1]
        .split(/[、,，/\s]+/)
        .map((t) => t.trim())
        .filter(Boolean)
        .filter((t) => t !== "无")
    : [];
  return {
    at,
    body,
    stepNum: stepM ? Number(stepM[1]) : undefined,
    tools,
    tokens: tokenM ? Number(tokenM[1]) : undefined,
  };
}

export function mergeTraceSteps(
  trace?: ExecutionTracePage,
  historyPage?: ExecutionTracePage,
): ExecutionStep[] {
  const byId = new Map<string, ExecutionStep>();
  for (const step of [...(trace?.steps ?? []), ...(historyPage?.steps ?? [])]) {
    if (!byId.has(step.id)) byId.set(step.id, step);
  }
  return [...byId.values()].reverse();
}

export function buildTrace(
  progress: string[],
  facts: TraceFact[],
  steps: ExecutionStep[],
): TraceNode[] {
  const seenLines = new Map<string, number>();
  const nodes: TraceNode[] = [];
  for (const line of progress) {
    // Structured steps are loaded from the trace store by ID. Skip their log mirrors.
    if (/ · stepId=\S+$/.test(line)) continue;
    const p = parseProgressLine(line);
    const occurrence = (seenLines.get(line) ?? 0) + 1;
    seenLines.set(line, occurrence);
    let timelineType: TraceNode["timelineType"] = p.stepNum == null ? "default" : "success";
    if (/失败|错误|error/i.test(p.body)) timelineType = "error";
    if (/重试|警告|warning/i.test(p.body)) timelineType = "warning";

    const label =
      p.stepNum != null
        ? `第 ${p.stepNum} 步`
        : p.body.replace(/\s*·\s*工具.*$/, "").replace(/\s*·\s*Token.*$/i, "").trim() ||
          p.body;

    nodes.push({
      id: `p-${occurrence}-${line}`,
      at: p.at,
      label,
      tools: p.tools,
      stepNum: p.stepNum,
      tokens: p.tokens,
      kind: p.stepNum != null ? ("step" as const) : ("event" as const),
      timelineType,
    });
  }

  steps.forEach((step) => nodes.push({
    id: `s-${step.id}`,
    at: step.at,
    label: `第 ${step.number} 步`,
    tools: step.tools,
    tokens: step.tokens,
    step,
    kind: "step",
    timelineType: "success",
  }));
  [...facts].reverse().forEach((fact, i) => nodes.push({
    id: `f-${fact.id ?? `${fact.createdAt}-${i}`}`,
    at: fact.createdAt,
    label: fact.title,
    tools: [],
    fact,
    kind: "event",
    timelineType: "default",
  }));
  return nodes.sort((a, b) => {
    const dt = parseTime(a.at) - parseTime(b.at);
    if (dt !== 0) return dt;
    const sa = a.step?.number ?? a.stepNum;
    const sb = b.step?.number ?? b.stepNum;
    if (sa != null && sb != null && sa !== sb) return sa - sb;
    return 0;
  });
}

export function orderTraceView(
  nodes: TraceNode[],
  opts: { newestFirst?: boolean; groupByIntent?: boolean } = {},
): {
  displayNodes: TraceNode[];
  currentId: string | null;
  groups: Map<string, TraceNode[]> | null;
  groupKeys: string[];
} {
  const newestFirst = opts.newestFirst ?? true;
  const groupByIntent = opts.groupByIntent ?? false;
  const currentId = [...nodes].reverse().find((n) => !n.fact)?.id ?? null;
  const displayNodes = newestFirst ? [...nodes].reverse() : nodes;

  if (!groupByIntent) {
    return { displayNodes, currentId, groups: null, groupKeys: [] };
  }

  const groups = new Map<string, TraceNode[]>();
  for (const n of displayNodes) {
    const key = n.step?.intentId ?? "_other";
    const bucket = groups.get(key);
    if (bucket) bucket.push(n);
    else groups.set(key, [n]);
  }
  const groupKeys = newestFirst
    ? [...groups.keys()]
    : [...groups.keys()].sort((a, b) => (a === "_other" ? 1 : b === "_other" ? -1 : 0));

  return { displayNodes, currentId, groups, groupKeys };
}

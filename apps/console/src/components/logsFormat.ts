export type LogLevel = "error" | "warn" | "progress" | "other";

export function classifyLine(line: string): LogLevel {
  if (/error|failed|failure|exception|fatal|panic|失败|错误/i.test(line)) return "error";
  if (/warn|warning|retry|重试|警告/i.test(line)) return "warn";
  if (/第\s*\d+\s*步|step|progress|进度|完成|done/i.test(line)) return "progress";
  return "other";
}

export type LogSection = { slot: string | null; text: string };

/** 按 `===== worker-wN.log =====` 分段；共享日志无分段时返回单段（slot=null）。 */
export function splitLogSlots(text: string): LogSection[] {
  const re = /^===== (worker-w\d+\.log) =====\s*$/gm;
  const sections: LogSection[] = [];
  let lastSlot: string | null = null;
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  let matched = false;
  while ((match = re.exec(text)) !== null) {
    matched = true;
    if (match.index > lastIndex || lastSlot !== null) {
      sections.push({ slot: lastSlot, text: text.slice(lastIndex, match.index) });
    }
    lastSlot = match[1];
    lastIndex = re.lastIndex;
  }
  if (!matched) return [{ slot: null, text }];
  sections.push({ slot: lastSlot, text: text.slice(lastIndex) });
  return sections.filter((s) => s.text.length > 0 || s.slot !== null);
}

export type FilteredLine = { text: string; level: LogLevel };

export function filterLogLines(
  text: string,
  opts: { keyword?: string; level?: LogLevel | "all"; slot?: string | null } = {},
): FilteredLine[] {
  const sections = splitLogSlots(text);
  const chosen = opts.slot
    ? sections.filter((s) => s.slot === opts.slot)
    : sections;
  const needle = (opts.keyword ?? "").trim().toLowerCase();
  const out: FilteredLine[] = [];
  for (const section of chosen) {
    for (const raw of section.text.split(/\r?\n/)) {
      if (!raw.trim()) continue;
      const level = classifyLine(raw);
      if (opts.level && opts.level !== "all" && level !== opts.level) continue;
      if (needle && !raw.toLowerCase().includes(needle)) continue;
      out.push({ text: raw, level });
    }
  }
  return out;
}

export type HighlightSegment = { text: string; hit: boolean };

/** 关键字高亮分段（大小写不敏感）；无关键字时整行一段。 */
export function highlightSegments(line: string, keyword: string): HighlightSegment[] {
  const needle = keyword.trim();
  if (!needle) return [{ text: line, hit: false }];
  const lower = line.toLowerCase();
  const target = needle.toLowerCase();
  const segments: HighlightSegment[] = [];
  let cursor = 0;
  let idx = lower.indexOf(target, cursor);
  while (idx !== -1) {
    if (idx > cursor) segments.push({ text: line.slice(cursor, idx), hit: false });
    segments.push({ text: line.slice(idx, idx + needle.length), hit: true });
    cursor = idx + needle.length;
    idx = lower.indexOf(target, cursor);
  }
  if (cursor < line.length) segments.push({ text: line.slice(cursor), hit: false });
  return segments;
}

export const LOG_LEVEL_OPTIONS = [
  { value: "all", label: "全部" },
  { value: "error", label: "错误" },
  { value: "warn", label: "警告" },
  { value: "progress", label: "进度" },
];
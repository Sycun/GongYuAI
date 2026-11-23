import { createHash } from "node:crypto";
import { inflateSync } from "node:zlib";
import type {
  KnowledgeBodyFormat,
  KnowledgeBodyStatus,
  KnowledgePageBasis,
  KnowledgeSection,
} from "@gongyuai/contracts";

/** 切分算法版本。改动切分规则就要 +1，旧版本可原地重建而不动资料版本。 */
export const CHUNKER_VERSION = 2;
/** 正文提取实现版本。1 起 PDF 保留物理页边界；0 是按空行推算页码的旧实现。 */
export const EXTRACTION_VERSION = 1;

/**
 * 片段目标长度与硬上限（字符）。偏小的片段让语义召回更聚焦：
 * 一段里混进多个话题会稀释向量，实测同一段单独成片时相似度明显更高。
 * 上下文由 section 接口的 parentText / previous / next 补回，不靠把片段撑大。
 */
const CHUNK_TARGET_CHARS = 700;
const CHUNK_MAX_CHARS = 1400;
const CHUNK_MIN_CHARS = 150;

export type ExtractedBody = {
  body: string;
  bodyStatus: KnowledgeBodyStatus;
  bodyStatusReason?: string;
  sections: KnowledgeSection[];
};

/** 来源身份：默认用原链接（含 fragment，不同章节算不同来源），否则用标题+发布者。 */
export function deriveSourceKey(input: {
  sourceKey?: string;
  sourceUrl?: string;
  title: string;
  publisher: string;
}): string {
  if (input.sourceKey?.trim()) return input.sourceKey.trim();
  const url = input.sourceUrl?.trim();
  if (url) {
    try {
      const parsed = new URL(url);
      parsed.hash = parsed.hash.replace(/#$/, "");
      return parsed.toString();
    } catch {
      return url;
    }
  }
  return `${input.title.trim()}|${input.publisher.trim()}`;
}

function trimTrailingBlank(text: string): string {
  return text.replace(/\s+$/, "");
}

function uniqueLocator(base: string, used: Map<string, number>): string {
  const seen = used.get(base) ?? 0;
  used.set(base, seen + 1);
  return seen === 0 ? base : `${base}#${seen + 1}`;
}

function lineStartsOf(body: string): number[] {
  const starts: number[] = [];
  let offset = 0;
  for (const line of body.split("\n")) {
    starts.push(offset);
    offset += line.length + 1;
  }
  return starts;
}

function chunkSha256(text: string): string {
  return createHash("sha256").update(Buffer.from(text, "utf8")).digest("hex");
}

function lineOfChar(starts: number[], charStart: number): number {
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid]! <= charStart) lo = mid;
    else hi = mid - 1;
  }
  return lo + 1;
}

type Block = { from: number; to: number };

const isBlank = (line: string) => !line.trim();
const fenceOf = (line: string) => /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1] ?? null;
const isTableRow = (line: string) => /^\s*\|/.test(line);

/**
 * 把行区间切成「块」：围栏代码块整块、表格整块、其余按空行分段。
 * 块是切分的原子单位，因此表格与代码块不会被拆散（除非单块超过硬上限）。
 */
function blocksIn(lines: string[], from: number, to: number): Block[] {
  const blocks: Block[] = [];
  let i = from;
  while (i < to) {
    if (isBlank(lines[i]!)) {
      i += 1;
      continue;
    }
    const fence = fenceOf(lines[i]!);
    if (fence) {
      let j = i + 1;
      while (j < to) {
        const closing = fenceOf(lines[j]!);
        j += 1;
        if (closing && closing[0] === fence[0] && closing.length >= fence.length) break;
      }
      blocks.push({ from: i, to: j });
      i = j;
      continue;
    }
    if (isTableRow(lines[i]!)) {
      let j = i;
      while (j < to && !isBlank(lines[j]!) && !fenceOf(lines[j]!)
        && (isTableRow(lines[j]!) || lines[j]!.includes("|"))) j += 1;
      blocks.push({ from: i, to: j });
      i = j;
      continue;
    }
    let j = i;
    while (j < to && !isBlank(lines[j]!) && !fenceOf(lines[j]!) && !isTableRow(lines[j]!)) j += 1;
    blocks.push({ from: i, to: Math.max(j, i + 1) });
    i = Math.max(j, i + 1);
  }
  return blocks;
}

/** 单块超过硬上限时按行拆开，保证每片仍在模型上下文内。 */
function splitOversized(body: string, starts: number[], block: Block): Block[] {
  const endOf = (b: Block) => (b.to >= starts.length ? body.length : starts[b.to]!);
  if (endOf(block) - starts[block.from]! <= CHUNK_MAX_CHARS) return [block];
  const out: Block[] = [];
  let cur = block.from;
  for (let i = block.from; i < block.to; i += 1) {
    const projected = (i + 1 >= starts.length ? body.length : starts[i + 1]!) - starts[cur]!;
    if (projected > CHUNK_TARGET_CHARS && i > cur) {
      out.push({ from: cur, to: i });
      cur = i;
    }
  }
  if (cur < block.to) out.push({ from: cur, to: block.to });
  return out;
}

/** 贪心装片到目标长度；过短的尾片并回前一片，避免只有一行的碎片。 */
function packBlocks(body: string, starts: number[], blocks: Block[]): Block[] {
  const endOf = (b: Block) => (b.to >= starts.length ? body.length : starts[b.to]!);
  const sizeOf = (b: Block) => endOf(b) - starts[b.from]!;
  const chunks: Block[] = [];
  let cur: Block | null = null;
  for (const block of blocks) {
    if (cur && sizeOf({ from: cur.from, to: block.to }) > CHUNK_TARGET_CHARS) {
      chunks.push(cur);
      cur = null;
    }
    cur = cur ? { from: cur.from, to: block.to } : { ...block };
  }
  if (cur) chunks.push(cur);
  if (chunks.length > 1) {
    const last = chunks[chunks.length - 1]!;
    const prev = chunks[chunks.length - 2]!;
    if (sizeOf(last) < CHUNK_MIN_CHARS && sizeOf({ from: prev.from, to: last.to }) <= CHUNK_MAX_CHARS) {
      chunks[chunks.length - 2] = { from: prev.from, to: last.to };
      chunks.pop();
    }
  }
  return chunks;
}

type Draft = {
  locator: string;
  heading: string | null;
  headingPath: string[];
  parentLocator: string;
  chunkIndex: number;
  chunkCount: number;
  page: number | null;
  pageBasis: KnowledgePageBasis | null;
  from: number;
  to: number;
};

function draftToSection(body: string, starts: number[], draft: Draft, ordinal: number): KnowledgeSection | null {
  const charStart = starts[draft.from] ?? body.length;
  const rawEnd = draft.to >= starts.length ? body.length : starts[draft.to]!;
  const text = trimTrailingBlank(body.slice(charStart, rawEnd));
  if (!text.trim()) return null;
  return {
    ordinal,
    locator: draft.locator,
    heading: draft.heading,
    page: draft.page,
    text,
    charStart,
    charEnd: charStart + text.length,
    headingPath: draft.headingPath,
    parentLocator: draft.parentLocator,
    chunkSha256: chunkSha256(text),
    chunkIndex: draft.chunkIndex,
    chunkCount: draft.chunkCount,
    lineStart: draft.from + 1,
    lineEnd: draft.from + 1 + (text.match(/\n/g)?.length ?? 0),
    pageBasis: draft.pageBasis,
  };
}

/**
 * Markdown 按标题层级切章，长章节按块继续切片。
 * 围栏代码块里的 `#` 不是标题；表格与代码块尽量整块保留。
 */
function markdownSections(body: string): KnowledgeSection[] {
  const lines = body.split("\n");
  const starts = lineStartsOf(body);
  const headings: Array<{ line: number; level: number; text: string }> = [];
  let fence: string | null = null;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!;
    const marker = fenceOf(line);
    if (marker) {
      if (!fence) fence = marker;
      else if (marker[0] === fence[0] && marker.length >= fence.length) fence = null;
      continue;
    }
    if (fence) continue;
    const heading = /^ {0,3}(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
    if (heading) headings.push({ line: i, level: heading[1]!.length, text: heading[2]!.trim() });
  }

  const used = new Map<string, number>();
  const sections: KnowledgeSection[] = [];
  const stack: Array<{ level: number; text: string }> = [];

  const emit = (from: number, to: number, heading: { level: number; text: string } | null) => {
    if (to <= from) return;
    let headingPath: string[] = [];
    let base = "¶0";
    if (heading) {
      while (stack.length && stack[stack.length - 1]!.level >= heading.level) stack.pop();
      headingPath = [...stack.map((h) => h.text), heading.text];
      stack.push({ level: heading.level, text: heading.text });
      const numbered = /^(\d+(?:\.\d+)*)(?:[.、\s]|$)/.exec(heading.text);
      base = numbered ? `§${numbered[1]}` : `§${heading.text}`;
    }
    const blocks = blocksIn(lines, from, to).flatMap((block) => splitOversized(body, starts, block));
    if (!blocks.length) return;
    const parentLocator = uniqueLocator(base, used);
    const packed = packBlocks(body, starts, blocks);
    const produced: KnowledgeSection[] = [];
    for (const [index, chunk] of packed.entries()) {
      const section = draftToSection(body, starts, {
        locator: index === 0 ? parentLocator : `${parentLocator}~${index + 1}`,
        heading: heading?.text ?? null,
        headingPath,
        parentLocator,
        chunkIndex: index,
        chunkCount: packed.length,
        page: null,
        pageBasis: null,
        from: chunk.from,
        to: chunk.to,
      }, sections.length + produced.length);
      if (section) produced.push(section);
    }
    for (const section of produced) sections.push({ ...section, chunkCount: produced.length });
  };

  emit(0, headings[0]?.line ?? lines.length, null);
  for (let i = 0; i < headings.length; i += 1) {
    emit(headings[i]!.line, headings[i + 1]?.line ?? lines.length, headings[i]!);
  }
  return sections.map((section, index) => ({ ...section, ordinal: index }));
}

/** 纯文本按段落装片。 */
function textSections(body: string): KnowledgeSection[] {
  const lines = body.split("\n");
  const starts = lineStartsOf(body);
  const blocks = blocksIn(lines, 0, lines.length).flatMap((block) => splitOversized(body, starts, block));
  const packed = packBlocks(body, starts, blocks);
  const sections: KnowledgeSection[] = [];
  for (const [index, chunk] of packed.entries()) {
    const locator = `¶${index + 1}`;
    const section = draftToSection(body, starts, {
      locator,
      heading: null,
      headingPath: [],
      parentLocator: locator,
      chunkIndex: 0,
      chunkCount: 1,
      page: null,
      pageBasis: null,
      from: chunk.from,
      to: chunk.to,
    }, sections.length);
    if (section) sections.push(section);
  }
  return sections.map((section, index) => ({ ...section, ordinal: index }));
}

// ---------------------------------------------------------------------------
// 旧切分：只用于旧版 locator 引用的回读，保证升级前后读到的是同一段原文。
// 不参与新导入，也不参与检索。
// ---------------------------------------------------------------------------

function legacySection(
  body: string,
  starts: number[],
  ordinal: number,
  locator: string,
  heading: string | null,
  page: number | null,
  charStart: number,
  text: string,
  pageBasis: KnowledgePageBasis | null,
): KnowledgeSection {
  const lineStart = lineOfChar(starts, charStart);
  return {
    ordinal,
    locator,
    heading,
    page,
    text,
    charStart,
    charEnd: charStart + text.length,
    headingPath: heading ? [heading] : [],
    parentLocator: locator,
    chunkSha256: chunkSha256(text),
    chunkIndex: 0,
    chunkCount: 1,
    lineStart,
    lineEnd: lineStart + (text.match(/\n/g)?.length ?? 0),
    pageBasis,
  };
}

/** 旧实现：一个标题章节整段，不再切片。 */
function legacyMarkdownSections(body: string): KnowledgeSection[] {
  const lines = body.split("\n");
  const starts = lineStartsOf(body);
  const headings: Array<{ line: number; text: string }> = [];
  let fence: string | null = null;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!;
    const marker = fenceOf(line);
    if (marker) {
      if (!fence) fence = marker;
      else if (marker[0] === fence[0] && marker.length >= fence.length) fence = null;
      continue;
    }
    if (fence) continue;
    const heading = /^ {0,3}#{1,6}\s+(.+?)\s*#*\s*$/.exec(line);
    if (heading) headings.push({ line: i, text: heading[1]!.trim() });
  }
  const used = new Map<string, number>();
  const sections: KnowledgeSection[] = [];
  const push = (from: number, to: number, heading: string | null) => {
    const charStart = starts[from] ?? 0;
    const charEnd = to >= lines.length ? body.length : (starts[to] ?? body.length);
    const text = trimTrailingBlank(body.slice(charStart, charEnd));
    if (!text.trim()) return;
    const numbered = heading ? /^(\d+(?:\.\d+)*)(?:[.、\s]|$)/.exec(heading) : null;
    const base = heading === null ? "¶0" : numbered ? `§${numbered[1]}` : `§${heading}`;
    sections.push(legacySection(body, starts, sections.length, uniqueLocator(base, used),
      heading, null, charStart, text, null));
  };
  push(0, headings[0]?.line ?? lines.length, null);
  for (let i = 0; i < headings.length; i += 1) {
    push(headings[i]!.line, headings[i + 1]?.line ?? lines.length, headings[i]!.text);
  }
  return sections.map((section, index) => ({ ...section, ordinal: index }));
}

/** 旧实现：纯文本一段一节。 */
function legacyTextSections(body: string): KnowledgeSection[] {
  const starts = lineStartsOf(body);
  const sections: KnowledgeSection[] = [];
  const used = new Map<string, number>();
  const re = /[^\n]+(?:\n(?!\s*\n)[^\n]*)*/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(body)) !== null) {
    const text = trimTrailingBlank(match[0]);
    if (!text.trim()) continue;
    sections.push(legacySection(body, starts, sections.length,
      uniqueLocator(`¶${sections.length + 1}`, used), null, null, match.index, text, null));
  }
  return sections;
}

// ---------------------------------------------------------------------------
// PDF：只承诺“可提取正文”的那一部分。取不到正文时如实标记待补，不编造内容。
// ---------------------------------------------------------------------------

type PdfObject = { num: number; dict: string; stream: Buffer | null };

function scanPdfObjects(raw: Buffer): Map<number, PdfObject> {
  const latin = raw.toString("latin1");
  const objects = new Map<number, PdfObject>();
  const re = /(\d+)\s+(\d+)\s+obj\b/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(latin)) !== null) {
    const num = Number(match[1]);
    const bodyStart = match.index + match[0].length;
    const endObj = latin.indexOf("endobj", bodyStart);
    const limit = endObj === -1 ? latin.length : endObj;
    const streamKeyword = /\bstream\r?\n?/.exec(latin.slice(bodyStart, limit));
    if (!streamKeyword) {
      objects.set(num, { num, dict: latin.slice(bodyStart, limit), stream: null });
      continue;
    }
    const dict = latin.slice(bodyStart, bodyStart + streamKeyword.index);
    const dataStart = bodyStart + streamKeyword.index + streamKeyword[0].length;
    const declared = /\/Length\s+(\d+)/.exec(dict);
    let dataEnd: number;
    if (declared) {
      dataEnd = Math.min(dataStart + Number(declared[1]), limit);
    } else {
      const found = latin.indexOf("endstream", dataStart);
      dataEnd = found === -1 ? limit : found;
    }
    objects.set(num, { num, dict, stream: raw.subarray(dataStart, dataEnd) });
    re.lastIndex = dataEnd;
  }
  return objects;
}

/** PDF 1.5+ 把页面对象放进压缩对象流；不展开就看不到任何 /Type /Page。 */
function expandObjectStreams(objects: Map<number, PdfObject>): void {
  for (const object of [...objects.values()]) {
    if (!/\/Type\s*\/ObjStm/.test(object.dict)) continue;
    const decoded = decodeStream(object);
    if (!decoded) continue;
    const count = Number(/\/N\s+(\d+)/.exec(object.dict)?.[1] ?? 0);
    const first = Number(/\/First\s+(\d+)/.exec(object.dict)?.[1] ?? 0);
    const text = decoded.toString("latin1");
    const header = text.slice(0, first).trim().split(/\s+/).map(Number);
    for (let i = 0; i < count; i += 1) {
      const num = header[i * 2];
      const offset = header[i * 2 + 1];
      if (num === undefined || offset === undefined || !Number.isFinite(offset)) continue;
      const end = i + 1 < count ? first + (header[(i + 1) * 2 + 1] ?? text.length - first) : text.length;
      if (!objects.has(num)) objects.set(num, { num, dict: text.slice(first + offset, end), stream: null });
    }
  }
}

function decodeStream(object: PdfObject): Buffer | null {
  if (!object.stream) return null;
  const filters = [...object.dict.matchAll(/\/(FlateDecode|ASCIIHexDecode|ASCII85Decode|DCTDecode|CCITTFaxDecode|LZWDecode|RunLengthDecode|Crypt)\b/g)]
    .map((m) => m[1]!);
  let data = object.stream;
  for (const filter of filters) {
    if (filter === "FlateDecode") {
      try {
        data = inflateSync(data);
      } catch {
        try {
          data = inflateSync(data.subarray(1));
        } catch {
          return null;
        }
      }
    } else if (filter === "ASCIIHexDecode") {
      const hex = data.toString("latin1").replace(/[^0-9A-Fa-f]/g, "");
      data = Buffer.from(hex.length % 2 ? `${hex}0` : hex, "hex");
    } else {
      return null;
    }
  }
  return data;
}

/** ToUnicode CMap：bfchar / bfrange。现代 PDF 的 CID 文本靠它才能还原成字符。 */
function parseToUnicode(text: string): Map<number, string> {
  const map = new Map<number, string>();
  const hexToString = (hex: string): string => {
    const clean = hex.replace(/[^0-9A-Fa-f]/g, "");
    let out = "";
    for (let i = 0; i + 4 <= clean.length; i += 4) {
      out += String.fromCharCode(parseInt(clean.slice(i, i + 4), 16));
    }
    return out;
  };
  for (const block of text.matchAll(/beginbfchar([\s\S]*?)endbfchar/g)) {
    for (const pair of block[1]!.matchAll(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/g)) {
      map.set(parseInt(pair[1]!, 16), hexToString(pair[2]!));
    }
  }
  for (const block of text.matchAll(/beginbfrange([\s\S]*?)endbfrange/g)) {
    for (const range of block[1]!.matchAll(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*(?:<([0-9A-Fa-f]+)>|\[([\s\S]*?)\])/g)) {
      const lo = parseInt(range[1]!, 16);
      const hi = parseInt(range[2]!, 16);
      if (hi - lo > 65535) continue;
      if (range[3]) {
        const base = parseInt(range[3], 16);
        for (let code = lo; code <= hi; code += 1) map.set(code, String.fromCharCode(base + (code - lo)));
      } else if (range[4]) {
        const items = [...range[4].matchAll(/<([0-9A-Fa-f]+)>/g)].map((m) => hexToString(m[1]!));
        for (let code = lo; code <= hi && code - lo < items.length; code += 1) map.set(code, items[code - lo]!);
      }
    }
  }
  return map;
}

type PdfFont = { twoByte: boolean; toUnicode: Map<number, string> | null };

function readPdfFonts(objects: Map<number, PdfObject>, resourcesDict: string): Map<string, PdfFont> {
  const fonts = new Map<string, PdfFont>();
  const fontDictRef = /\/Font\s+(\d+)\s+\d+\s+R/.exec(resourcesDict);
  const fontBlock = fontDictRef
    ? objects.get(Number(fontDictRef[1]))?.dict ?? ""
    : /\/Font\s*<<([\s\S]*?)>>/.exec(resourcesDict)?.[1] ?? "";
  for (const entry of fontBlock.matchAll(/\/([^\s/<>[\]]+)\s+(\d+)\s+\d+\s+R/g)) {
    const fontObject = objects.get(Number(entry[2]!));
    if (!fontObject) continue;
    const twoByte = /\/Subtype\s*\/Type0/.test(fontObject.dict);
    const cmapRef = /\/ToUnicode\s+(\d+)\s+\d+\s+R/.exec(fontObject.dict);
    let toUnicode: Map<number, string> | null = null;
    if (cmapRef) {
      const decoded = decodeStream(objects.get(Number(cmapRef[1]!)) ?? { num: 0, dict: "", stream: null });
      if (decoded) toUnicode = parseToUnicode(decoded.toString("latin1"));
    }
    fonts.set(entry[1]!, { twoByte, toUnicode });
  }
  return fonts;
}

function pdfStringBytes(raw: string): number[] {
  const bytes: number[] = [];
  for (let i = 0; i < raw.length; i += 1) {
    const char = raw[i]!;
    if (char !== "\\") {
      bytes.push(char.charCodeAt(0) & 0xff);
      continue;
    }
    const next = raw[++i];
    if (next === undefined) break;
    if (next >= "0" && next <= "7") {
      let oct = next;
      while (oct.length < 3) {
        const digit = raw[i + 1];
        if (digit === undefined || digit < "0" || digit > "7") break;
        oct += digit;
        i += 1;
      }
      bytes.push(parseInt(oct, 8) & 0xff);
      continue;
    }
    const escapes: Record<string, number> = { n: 10, r: 13, t: 9, b: 8, f: 12, "(": 40, ")": 41, "\\": 92 };
    if (next in escapes) bytes.push(escapes[next]!);
    else if (next === "\n") continue;
    else if (next === "\r") {
      if (raw[i + 1] === "\n") i += 1;
    } else bytes.push(next.charCodeAt(0) & 0xff);
  }
  return bytes;
}

function decodePdfBytes(bytes: number[], font: PdfFont | undefined): string {
  if (font?.toUnicode?.size) {
    const width = font.twoByte ? 2 : 1;
    let out = "";
    for (let i = 0; i < bytes.length; i += width) {
      const code = width === 2 ? ((bytes[i] ?? 0) << 8) | (bytes[i + 1] ?? 0) : (bytes[i] ?? 0);
      const mapped = font.toUnicode.get(code);
      out += mapped ?? (width === 2 ? "" : String.fromCharCode(code));
    }
    return out;
  }
  if (font?.twoByte) return "";
  return Buffer.from(bytes).toString("latin1");
}

/** 内容流里的文本算子。只取 Tj / TJ / ' / "，换行由 Td / TD / T* / ET 提示。 */
function extractContentText(content: string, fonts: Map<string, PdfFont>): string {
  let out = "";
  let font: PdfFont | undefined;
  let i = 0;
  const operands: Array<{ text: string } | { raw: string }> = [];
  const readLiteral = (): string | null => {
    let depth = 1;
    let raw = "";
    i += 1;
    while (i < content.length && depth > 0) {
      const char = content[i]!;
      if (char === "\\") {
        raw += char + (content[i + 1] ?? "");
        i += 2;
        continue;
      }
      if (char === "(") depth += 1;
      if (char === ")") {
        depth -= 1;
        if (depth === 0) break;
      }
      raw += char;
      i += 1;
    }
    i += 1;
    return raw;
  };
  const flush = (kerning: boolean) => {
    for (const operand of operands) {
      if ("text" in operand) out += operand.text;
      // TJ 数组里的负位移是字距；超过阈值即为词间空格，丢掉会把整行粘成一个词。
      else if (kerning && /^-?[\d.]+$/.test(operand.raw) && Number(operand.raw) <= -100) out += " ";
    }
    operands.length = 0;
  };
  while (i < content.length) {
    const char = content[i]!;
    if (char === "(") {
      const raw = readLiteral();
      operands.push({ text: decodePdfBytes(pdfStringBytes(raw ?? ""), font) });
      continue;
    }
    if (char === "<" && content[i + 1] !== "<") {
      const end = content.indexOf(">", i);
      if (end === -1) break;
      const hex = content.slice(i + 1, end).replace(/[^0-9A-Fa-f]/g, "");
      const bytes = [...Buffer.from(hex.length % 2 ? `${hex}0` : hex, "hex")];
      operands.push({ text: decodePdfBytes(bytes, font) });
      i = end + 1;
      continue;
    }
    if (/\s/.test(char) || char === "[" || char === "]" || char === "<" || char === ">") {
      i += 1;
      continue;
    }
    if (char === "/") {
      const match = /^\/([^\s/<>[\]()]+)/.exec(content.slice(i));
      if (match) {
        operands.push({ raw: match[1]! });
        i += match[0].length;
        continue;
      }
      i += 1;
      continue;
    }
    const word = /^[A-Za-z'"*][A-Za-z0-9*]*|^-?[\d.]+/.exec(content.slice(i));
    if (!word) {
      i += 1;
      continue;
    }
    const token = word[0];
    i += token.length;
    if (/^-?[\d.]+$/.test(token)) {
      operands.push({ raw: token });
      continue;
    }
    if (token === "Tf") {
      const name = [...operands].reverse().find((o) => "raw" in o && !/^-?[\d.]+$/.test(o.raw));
      font = name && "raw" in name ? fonts.get(name.raw) : undefined;
      operands.length = 0;
    } else if (token === "Tj" || token === "'" || token === '"') {
      if (token !== "Tj") out += "\n";
      flush(false);
    } else if (token === "TJ") {
      flush(true);
    } else if (token === "Td" || token === "TD" || token === "T*" || token === "ET") {
      operands.length = 0;
      out += "\n";
    } else {
      operands.length = 0;
    }
  }
  return out;
}

function pdfPages(objects: Map<number, PdfObject>): Array<{ num: number; dict: string }> {
  const pages: Array<{ num: number; dict: string }> = [];
  const seen = new Set<number>();
  const walk = (num: number) => {
    if (seen.has(num)) return;
    seen.add(num);
    const object = objects.get(num);
    if (!object) return;
    if (/\/Type\s*\/Page\b(?!s)/.test(object.dict)) {
      pages.push({ num, dict: object.dict });
      return;
    }
    const kids = /\/Kids\s*\[([\s\S]*?)\]/.exec(object.dict);
    if (kids) for (const ref of kids[1]!.matchAll(/(\d+)\s+\d+\s+R/g)) walk(Number(ref[1]));
  };
  const rootRef = /\/Type\s*\/Catalog[\s\S]*?\/Pages\s+(\d+)\s+\d+\s+R/.exec(
    [...objects.values()].map((o) => o.dict).find((d) => /\/Type\s*\/Catalog/.test(d)) ?? "",
  );
  if (rootRef) walk(Number(rootRef[1]));
  if (!pages.length) {
    for (const object of objects.values()) {
      if (/\/Type\s*\/Page\b(?!s)/.test(object.dict)) pages.push({ num: object.num, dict: object.dict });
    }
  }
  return pages;
}

/**
 * 逐页提取，返回**物理页**文本数组。页内空行一律压成单换行，
 * 因此页与页之间用空行分隔后仍能按空行精确还原页边界——不再用空行推算页码。
 */
function extractPdfPages(raw: Buffer): { pages: string[]; reason?: string } {
  if (!raw.subarray(0, 1024).toString("latin1").includes("%PDF-")) {
    return { pages: [], reason: "不是 PDF 文件（缺少 %PDF- 头）" };
  }
  const objects = scanPdfObjects(raw);
  expandObjectStreams(objects);
  const pages = pdfPages(objects);
  if (!pages.length) return { pages: [], reason: "PDF 无可解析页面（可能已加密或结构不支持）" };
  const texts: string[] = [];
  for (const page of pages) {
    const contents = /\/Contents\s*(?:(\d+)\s+\d+\s+R|\[([\s\S]*?)\])/.exec(page.dict);
    const refs: number[] = [];
    if (contents?.[1]) refs.push(Number(contents[1]));
    if (contents?.[2]) for (const ref of contents[2].matchAll(/(\d+)\s+\d+\s+R/g)) refs.push(Number(ref[1]));
    const resourcesRef = /\/Resources\s+(\d+)\s+\d+\s+R/.exec(page.dict);
    const resourcesDict = resourcesRef
      ? objects.get(Number(resourcesRef[1]))?.dict ?? ""
      : /\/Resources\s*<<([\s\S]*?)>>\s*(?:\/|>>)/.exec(page.dict)?.[1] ?? page.dict;
    const fonts = readPdfFonts(objects, resourcesDict);
    let text = "";
    for (const ref of refs) {
      const decoded = decodeStream(objects.get(ref) ?? { num: ref, dict: "", stream: null });
      if (decoded) text += extractContentText(decoded.toString("latin1"), fonts);
    }
    texts.push(text.replace(/[ \t]+\n/g, "\n").replace(/\n{2,}/g, "\n").trim());
  }
  const body = texts.join("\n\n");
  if (!body.trim()) return { pages: texts, reason: "PDF 正文提取为空（扫描版、加密或字体无 ToUnicode 映射）" };
  const printable = [...body].filter((c) => /[\p{L}\p{N}\p{P}]/u.test(c)).length;
  if (printable / body.length < 0.5) {
    return { pages: texts, reason: "PDF 提取结果不可读（字体编码无法还原），标记待补正文" };
  }
  return { pages: texts };
}

/**
 * 按物理页切段：body 的每个空行分隔块恰好对应一个物理页（含提取为空的页）。
 * 超长页继续切片，但页码仍是该物理页号。
 */
function pdfSections(body: string): KnowledgeSection[] {
  const starts = lineStartsOf(body);
  const lines = body.split("\n");
  const pages = body.split("\n\n");
  const sections: KnowledgeSection[] = [];
  let offset = 0;
  for (let index = 0; index < pages.length; index += 1) {
    const pageText = pages[index]!;
    const charStart = offset;
    offset += pageText.length + 2;
    if (!pageText.trim()) continue;
    const from = lineOfChar(starts, charStart) - 1;
    const to = from + pageText.split("\n").length;
    const blocks = blocksIn(lines, from, to).flatMap((block) => splitOversized(body, starts, block));
    const packed = packBlocks(body, starts, blocks);
    const parentLocator = `p.${index + 1}`;
    const produced: KnowledgeSection[] = [];
    for (const [chunkIndex, chunk] of packed.entries()) {
      const firstLine = lines[chunk.from]?.trim() ?? "";
      const section = draftToSection(body, starts, {
        locator: chunkIndex === 0 ? parentLocator : `${parentLocator}~${chunkIndex + 1}`,
        heading: firstLine.slice(0, 80) || null,
        headingPath: [],
        parentLocator,
        chunkIndex,
        chunkCount: packed.length,
        page: index + 1,
        pageBasis: "physical-page",
        from: chunk.from,
        to: chunk.to,
      }, sections.length + produced.length);
      if (section) produced.push(section);
    }
    for (const section of produced) sections.push({ ...section, chunkCount: produced.length });
  }
  return sections.map((section, index) => ({ ...section, ordinal: index }));
}

/** 旧实现：按空行推算页码。页码无法确认，如实标记，只用于旧引用与旧版本回读。 */
function legacyPdfSections(body: string): KnowledgeSection[] {
  const starts = lineStartsOf(body);
  const pages = body.split("\n\n");
  const sections: KnowledgeSection[] = [];
  let offset = 0;
  for (let index = 0; index < pages.length; index += 1) {
    const text = pages[index]!;
    const charStart = offset;
    offset += text.length + 2;
    if (!text.trim()) continue;
    const firstLine = text.split("\n").find((line) => line.trim()) ?? "";
    sections.push(legacySection(body, starts, sections.length, `p.${index + 1}`,
      firstLine.trim().slice(0, 80) || null, index + 1, charStart, text, "legacy-paragraph"));
  }
  return sections;
}

/** 提取正文并切段。只有链接、或提取为空时标记待补正文，不产生全文命中。 */
export function extractKnowledgeBody(input: {
  format: KnowledgeBodyFormat;
  content?: string;
  contentBase64?: string;
}): ExtractedBody {
  let body = "";
  let reason: string | undefined;
  if (input.format === "pdf") {
    if (!input.contentBase64?.trim()) {
      reason = "仅登记链接或元数据，尚无 PDF 字节";
    } else {
      const extracted = extractPdfPages(Buffer.from(input.contentBase64, "base64"));
      reason = extracted.reason;
      body = extracted.reason ? "" : extracted.pages.join("\n\n");
    }
  } else if (!input.content?.trim()) {
    reason = "仅登记链接或元数据，尚无正文";
  } else {
    body = input.content.replace(/\r\n?/g, "\n");
  }

  if (!body.trim()) {
    return { body: "", bodyStatus: "pending_body", bodyStatusReason: reason ?? "正文为空", sections: [] };
  }
  const sections = input.format === "markdown"
    ? markdownSections(body)
    : input.format === "pdf"
      ? pdfSections(body)
      : textSections(body);
  return { body, bodyStatus: "ready", sections };
}

/**
 * 从已密封的快照字节复算段落。
 * legacy=true 走旧切分（旧 locator 引用回读）；PDF 旧提取版本仍按空行分页并标记页码不可确认。
 */
export function sectionsFromSnapshot(
  body: string,
  format: KnowledgeBodyFormat,
  opts: { legacy?: boolean; extractionVersion?: number } = {},
): KnowledgeSection[] {
  if (!body.trim()) return [];
  if (opts.legacy) {
    return format === "markdown" ? legacyMarkdownSections(body)
      : format === "pdf" ? legacyPdfSections(body)
      : legacyTextSections(body);
  }
  if (format === "pdf" && (opts.extractionVersion ?? EXTRACTION_VERSION) < 1) return legacyPdfSections(body);
  return format === "markdown" ? markdownSections(body) : format === "pdf" ? pdfSections(body) : textSections(body);
}

export function findSection(sections: KnowledgeSection[], locator: string): KnowledgeSection | undefined {
  const byLocator = sections.find((section) => section.locator === locator);
  if (byLocator) return byLocator;
  const ordinal = /^ordinal:(\d+)$/.exec(locator);
  if (ordinal) return sections.find((section) => section.ordinal === Number(ordinal[1]));
  return undefined;
}

/** 同一父章节的全部片段拼回整章原文，用于命中后的上下文回读。 */
export function parentRangeOf(sections: KnowledgeSection[], section: KnowledgeSection): {
  charStart: number; charEnd: number; previous: KnowledgeSection | null; next: KnowledgeSection | null;
} {
  const siblings = sections.filter((s) => s.parentLocator === section.parentLocator);
  const first = siblings[0] ?? section;
  const last = siblings[siblings.length - 1] ?? section;
  const index = siblings.findIndex((s) => s.ordinal === section.ordinal);
  return {
    charStart: first.charStart,
    charEnd: last.charEnd,
    previous: index > 0 ? siblings[index - 1]! : null,
    next: index >= 0 && index < siblings.length - 1 ? siblings[index + 1]! : null,
  };
}
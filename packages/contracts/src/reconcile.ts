/**
 * 原始材料差异核算（业务验收项 2）。
 *
 * 输入只有业务字段：两份原始记录（资产清单 CSV / 配置基线 JSON）与约定的
 * 键字段。输出按键给出 新增 / 移除 / 变更 / 未变 / 缺件 / 歧义，并能定位到
 * 具体来源行与字段。这里不读任何“预期结果”，预期差异由验收端另行封存比对。
 *
 * 缺件有两层含义，分别上报，不合并：
 * - `missingMaterials`：申请里点名、但 evidence/ 下读不到的材料文件；
 * - `items[].status = "missing"`：约定的检查项（requiredKeys）在原始记录中不存在。
 * 材料缺失时不做猜测：对应项一律 `unknown`，并写明缺哪一侧。
 *
 * 来源行号一律是**原文件的物理行号**（首行表头 = 1）：空行只占行号不产生记录；
 * CRLF 与 LF 记同一行；引号内的逗号不切列；引号内换行按一个字段处理，并记下
 * 起止行（`line`/`endLine`）。未闭合的引号直接报错，不做猜测。
 *
 * 同名主键重复出现时不允许“后写的覆盖先写的”：
 * - 内容完全相同（比较字段一致）→ 收敛为一行，行号取首次出现，并在
 *   `duplicates` 里列出全部来源行（规则固定、可测）；
 * - 内容冲突 → 该项 `status = "ambiguous"`，列出材料、键与所有来源行；
 *   不生成“未变”，也不允许据此让目标通过。
 */
import { z } from "zod";

export const ReconcileMaterialSchema = z.object({
  /** evidence/ 下的相对路径。 */
  path: z.string().trim().min(1),
  /** 省略时按扩展名判断。 */
  format: z.enum(["csv", "json"]).optional(),
  /** 覆盖请求级 keyField。 */
  keyField: z.string().trim().min(1).optional(),
});
export type ReconcileMaterial = z.infer<typeof ReconcileMaterialSchema>;

export const ReconcileRequestSchema = z.object({
  name: z.string().trim().min(1).max(64).regex(/^[A-Za-z0-9._-]+$/, "name 只允许字母数字与 ._-").default("reconcile"),
  baseline: ReconcileMaterialSchema,
  current: ReconcileMaterialSchema,
  /** 差异的主键字段（资产名 / 主机名 / 配置项 ID）。 */
  keyField: z.string().trim().min(1).default("host"),
  /** 只比较这些字段；省略时比较两侧出现过的全部字段。 */
  compareFields: z.array(z.string().trim().min(1)).optional(),
  /** 约定的检查项清单；其中未出现在当前记录里的键标为“缺件”。 */
  requiredKeys: z.array(z.string().trim().min(1)).optional(),
});
export type ReconcileRequest = z.infer<typeof ReconcileRequestSchema>;

/**
 * 目标级业务条件：目标自报“完成差异比对”时，只挂一份差异 JSON 不算完成。
 *
 * 判定读的是本次核算结果本身：
 * - 两侧材料都必须真正被读到（`missingMaterials` 为空，两侧 `sha256` 都是 64 位）；
 * - 结论不得停在未知（`counts.unknown > maxUnknown` 拒绝）或歧义（`counts.ambiguous > maxAmbiguous` 拒绝）；
 * - 若声明 `names`，核算名必须在白名单内，避免拿别的核算冒充。
 *
 * 约定检查项在两份清单中都不存在（`required-key-absent-in-both`）属于**有效核查结论**，
 * 与“整份输入缺失”不同，不受这里拦截。
 */
export const ReconcileGateSchema = z.object({
  /** evidence/ 下可作为通过依据的核算结果 glob。 */
  pattern: z.string().trim().min(1).default("reconcile/*.json"),
  /** 允许的未知项上限（默认 0：材料齐了才能通过）。 */
  maxUnknown: z.number().int().nonnegative().default(0),
  /** 允许的重复主键歧义项上限（默认 0：歧义不给结论，也不让目标通过）。 */
  maxAmbiguous: z.number().int().nonnegative().default(0),
  /** 核算名白名单；省略表示不限制名字。 */
  names: z.array(z.string().trim().min(1)).optional(),
});
export type ReconcileGate = z.infer<typeof ReconcileGateSchema>;

export type MaterialRow = {
  key: string;
  /** 记录起始物理行号（1 起）。 */
  line: number;
  /** 记录结束物理行号；跨行引号字段时大于 `line`。 */
  endLine: number;
  fields: Record<string, string>;
};

/** 同名主键在一份材料里出现多次时的记录（同键多行）。 */
export type MaterialDuplicate = {
  key: string;
  /** 该键出现的全部物理行号，按出现顺序。 */
  lines: number[];
  /** true = 各行内容完全一致（已收敛）；false = 内容冲突（标为歧义）。 */
  identical: boolean;
};

export type ParsedMaterial = {
  path: string;
  format: "csv" | "json";
  keyField: string;
  rows: MaterialRow[];
  /** 表头 / JSON 顶层键数量（用于核对输入规模）。 */
  fieldCount: number;
  /** 同名主键重复出现的记录；没有重复时为空数组。 */
  duplicates: MaterialDuplicate[];
};

export type ReconcileFieldChange = { field: string; before: string | null; after: string | null };

export type ReconcileItemStatus =
  | "added"
  | "removed"
  | "changed"
  | "unchanged"
  | "missing"
  | "unknown"
  | "ambiguous";

/** 某个键在一份材料里的全部出处（重复主键时有多条）。 */
export type ReconcileOccurrence = {
  material: "baseline" | "current";
  line: number;
  endLine: number;
  fields: Record<string, string>;
};

export type ReconcileItem = {
  key: string;
  status: ReconcileItemStatus;
  baselineLine: number | null;
  currentLine: number | null;
  changes: ReconcileFieldChange[];
  /** 非正常状态的原因（例如材料缺失、约定项两侧都没有、重复主键冲突）。 */
  reason?: string;
  /** 跨行引号字段时记录结束行；与起始行相同时省略。 */
  baselineEndLine?: number;
  currentEndLine?: number;
  /** 同名主键重复出现时的全部出处；内容相同也会列出。 */
  duplicates?: ReconcileOccurrence[];
};

export type ReconcileCounts = {
  added: number;
  removed: number;
  changed: number;
  unchanged: number;
  missing: number;
  unknown: number;
  /** 同名主键内容冲突、无法给出确定结论的项数。 */
  ambiguous: number;
  totalKeys: number;
};

export type ReconcileMaterialSummary = {
  path: string;
  format: "csv" | "json" | null;
  rows: number;
  sha256: string | null;
  /** 同名主键重复出现时的来源行（便于人眼复核）。 */
  duplicateKeys?: MaterialDuplicate[];
};

export type ReconcileResult = {
  version: 1;
  name: string;
  keyField: string;
  compareFields: string[];
  baseline: ReconcileMaterialSummary;
  current: ReconcileMaterialSummary;
  missingMaterials: string[];
  counts: ReconcileCounts;
  items: ReconcileItem[];
};

/** 一条 CSV 记录：单元格、起始行、结束行。 */
type CsvRecord = { cells: string[]; startLine: number; endLine: number };

/**
 * 逐字符解析 CSV（RFC 4180 取值）：
 * - 引号内可含逗号、换行；`""` 表示一个字面引号；
 * - `\r\n`、`\n`、`\r` 都是记录分隔符，且只让行号前进一次；
 * - 全空的物理行不产生记录，但**占用行号**（保证后续行号与原文件一致）。
 */
export function parseCsvRecords(content: string, path = "<csv>"): CsvRecord[] {
  const records: CsvRecord[] = [];
  let cells: string[] = [];
  let field = "";
  let quoted = false;
  let lineNo = 1;
  let recordStart = 1;
  let touched = false;

  const pushCell = () => {
    cells.push(field.trim());
    field = "";
  };
  const pushRecord = (endLine: number) => {
    pushCell();
    const blank = !touched && cells.length === 1 && cells[0] === "";
    if (!blank) records.push({ cells, startLine: recordStart, endLine });
    cells = [];
    touched = false;
  };

  let i = 0;
  while (i < content.length) {
    const ch = content[i]!;
    if (quoted) {
      if (ch === '"') {
        if (content[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        quoted = false;
        i += 1;
        continue;
      }
      if (ch === "\r") {
        if (content[i + 1] === "\n") {
          field += "\r\n";
          i += 2;
        } else {
          field += "\r";
          i += 1;
        }
        lineNo += 1;
        continue;
      }
      if (ch === "\n") {
        field += "\n";
        lineNo += 1;
        i += 1;
        continue;
      }
      field += ch;
      i += 1;
      continue;
    }
    if (ch === '"') {
      quoted = true;
      touched = true;
      i += 1;
      continue;
    }
    if (ch === ",") {
      pushCell();
      touched = true;
      i += 1;
      continue;
    }
    if (ch === "\r" || ch === "\n") {
      const endLine = lineNo;
      if (ch === "\r" && content[i + 1] === "\n") i += 2;
      else i += 1;
      lineNo += 1;
      pushRecord(endLine);
      recordStart = lineNo;
      continue;
    }
    field += ch;
    touched = true;
    i += 1;
  }
  if (quoted) {
    throw new Error(`${path}: 第 ${recordStart} 行起的引号未闭合，拒绝猜测字段边界`);
  }
  if (touched || field.length > 0 || cells.length > 0) pushRecord(lineNo);
  return records;
}

function detectFormat(path: string, explicit?: "csv" | "json"): "csv" | "json" {
  if (explicit) return explicit;
  return /\.json$/i.test(path) ? "json" : "csv";
}

function sameFields(a: Record<string, string>, b: Record<string, string>): boolean {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const key of keys) if ((a[key] ?? "") !== (b[key] ?? "")) return false;
  return true;
}

/** 按出现顺序分组，并判定同名行内容是否一致。 */
function collectDuplicates(rows: MaterialRow[]): MaterialDuplicate[] {
  const byKey = new Map<string, MaterialRow[]>();
  for (const row of rows) {
    const list = byKey.get(row.key);
    if (list) list.push(row);
    else byKey.set(row.key, [row]);
  }
  const duplicates: MaterialDuplicate[] = [];
  for (const [key, list] of byKey) {
    if (list.length < 2) continue;
    const identical = list.every((row) => sameFields(row.fields, list[0]!.fields));
    duplicates.push({ key, lines: list.map((row) => row.line), identical });
  }
  return duplicates;
}

/** 行号按 1 开始计；CSV 首行为表头，第一条数据在表头之后（空行也占行号）。 */
export function parseMaterial(input: {
  path: string;
  content: string;
  keyField: string;
  format?: "csv" | "json";
}): ParsedMaterial {
  const format = detectFormat(input.path, input.format);
  const keyField = input.keyField;
  if (format === "csv") {
    const records = parseCsvRecords(input.content, input.path);
    if (!records.length) throw new Error(`${input.path}: 空材料，没有表头`);
    const header = records[0]!.cells;
    if (!header.includes(keyField)) {
      throw new Error(`${input.path}: 表头缺少主键字段 ${keyField}（表头：${header.join(",")}）`);
    }
    const rows: MaterialRow[] = [];
    for (const record of records.slice(1)) {
      const fields: Record<string, string> = {};
      header.forEach((name, index) => {
        fields[name] = record.cells[index] ?? "";
      });
      const key = fields[keyField] ?? "";
      if (!key) throw new Error(`${input.path}: 第 ${record.startLine} 行缺少主键 ${keyField}`);
      rows.push({ key, line: record.startLine, endLine: record.endLine, fields });
    }
    return { path: input.path, format, keyField, rows, fieldCount: header.length, duplicates: collectDuplicates(rows) };
  }

  let data: unknown;
  try {
    data = JSON.parse(input.content);
  } catch (err) {
    throw new Error(`${input.path}: JSON 解析失败（${err instanceof Error ? err.message : String(err)}）`);
  }
  const lineOf = (needle: string): number => {
    const marker = `"${needle}"`;
    const index = input.content.indexOf(marker);
    if (index < 0) return 1;
    return input.content.slice(0, index).split("\n").length;
  };
  const toFields = (value: unknown): Record<string, string> => {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      throw new Error(`${input.path}: 记录必须是对象`);
    }
    const fields: Record<string, string> = {};
    for (const [field, cell] of Object.entries(value as Record<string, unknown>)) {
      fields[field] = cell === null || cell === undefined
        ? ""
        : typeof cell === "string"
          ? cell
          : JSON.stringify(cell);
    }
    return fields;
  };

  const rows: MaterialRow[] = [];
  const fieldsSeen = new Set<string>();
  if (Array.isArray(data)) {
    data.forEach((row, index) => {
      const fields = toFields(row);
      Object.keys(fields).forEach((field) => fieldsSeen.add(field));
      const key = fields[keyField] ?? "";
      if (!key) throw new Error(`${input.path}: 第 ${index + 1} 条记录缺少主键 ${keyField}`);
      const line = lineOf(key);
      rows.push({ key, line, endLine: line, fields });
    });
  } else if (data && typeof data === "object") {
    for (const [key, value] of Object.entries(data as Record<string, unknown>)) {
      const fields = toFields(value);
      Object.keys(fields).forEach((field) => fieldsSeen.add(field));
      const line = lineOf(key);
      rows.push({ key, line, endLine: line, fields: { ...fields, [keyField]: fields[keyField] ?? key } });
    }
  } else {
    throw new Error(`${input.path}: JSON 顶层必须是数组或对象`);
  }
  return {
    path: input.path,
    format,
    keyField,
    rows,
    fieldCount: fieldsSeen.size,
    duplicates: collectDuplicates(rows),
  };
}

type RowPlace = { line: number; endLine: number; fields: Record<string, string> };

/**
 * 收敛重复行：内容相同的键只保留首次出现的那一行（规则固定、可测）；
 * 内容冲突的键进 `conflicting`，由调用方标为歧义。
 */
function indexRows(material: ParsedMaterial): {
  byKey: Map<string, MaterialRow>;
  occurrences: Map<string, RowPlace[]>;
  conflicting: Set<string>;
} {
  const byKey = new Map<string, MaterialRow>();
  const occurrences = new Map<string, RowPlace[]>();
  const conflicting = new Set<string>();
  for (const row of material.rows) {
    const place: RowPlace = { line: row.line, endLine: row.endLine, fields: row.fields };
    const list = occurrences.get(row.key);
    if (list) list.push(place);
    else occurrences.set(row.key, [place]);
    if (!byKey.has(row.key)) byKey.set(row.key, row);
  }
  for (const dup of material.duplicates) if (!dup.identical) conflicting.add(dup.key);
  return { byKey, occurrences, conflicting };
}

function materialSummary(material: ParsedMaterial | null, request: ReconcileMaterial, sha256: string | null): ReconcileMaterialSummary {
  return {
    path: request.path,
    format: material?.format ?? null,
    rows: material?.rows.length ?? 0,
    sha256,
    ...(material && material.duplicates.length ? { duplicateKeys: material.duplicates } : {}),
  };
}

export function reconcileMaterials(input: {
  request: ReconcileRequest;
  baseline: ParsedMaterial | null;
  current: ParsedMaterial | null;
  baselineSha256?: string | null;
  currentSha256?: string | null;
}): ReconcileResult {
  const { request, baseline, current } = input;
  const keyField = baseline?.keyField ?? current?.keyField ?? request.keyField;
  const required = [...new Set(request.requiredKeys ?? [])];
  const missingMaterials: string[] = [];
  if (!baseline) missingMaterials.push(request.baseline.path);
  if (!current) missingMaterials.push(request.current.path);

  const declaredFields = request.compareFields?.length ? [...new Set(request.compareFields)] : null;
  const compareFieldsFor = (fields: string[]): string[] =>
    (declaredFields ?? [...new Set(fields)]).filter((field) => field !== keyField);

  if (!baseline || !current) {
    const known = baseline ?? current;
    const keys = [...new Set([...(known?.rows.map((row) => row.key) ?? []), ...required])].sort();
    const items: ReconcileItem[] = keys.map((key) => ({
      key,
      status: "unknown" as const,
      baselineLine: baseline?.rows.find((row) => row.key === key)?.line ?? null,
      currentLine: current?.rows.find((row) => row.key === key)?.line ?? null,
      changes: [],
      reason: baseline ? "current-material-missing" : "baseline-material-missing",
    }));
    const counts: ReconcileCounts = {
      added: 0, removed: 0, changed: 0, unchanged: 0, missing: 0,
      unknown: items.length, ambiguous: 0, totalKeys: items.length,
    };
    return {
      version: 1,
      name: request.name,
      keyField,
      compareFields: compareFieldsFor(
        [...(baseline?.rows ?? []), ...(current?.rows ?? [])].flatMap((row) => Object.keys(row.fields)),
      ),
      baseline: materialSummary(baseline, request.baseline, input.baselineSha256 ?? null),
      current: materialSummary(current, request.current, input.currentSha256 ?? null),
      missingMaterials,
      counts,
      items,
    };
  }

  const baseIndex = indexRows(baseline);
  const currIndex = indexRows(current);
  const baselineByKey = baseIndex.byKey;
  const currentByKey = currIndex.byKey;
  const compareFields = compareFieldsFor([
    ...baseline.rows.flatMap((row) => Object.keys(row.fields)),
    ...current.rows.flatMap((row) => Object.keys(row.fields)),
  ]);

  /** 只列出“确实重复”的那一侧；另一侧单行出处不混进重复清单。 */
  const repeatedOccurrences = (key: string): ReconcileOccurrence[] => [
    ...((baseIndex.occurrences.get(key)?.length ?? 0) > 1
      ? (baseIndex.occurrences.get(key) ?? []).map((entry) => ({ ...entry, material: "baseline" as const }))
      : []),
    ...((currIndex.occurrences.get(key)?.length ?? 0) > 1
      ? (currIndex.occurrences.get(key) ?? []).map((entry) => ({ ...entry, material: "current" as const }))
      : []),
  ];
  // 输出顺序固定：先基线顺序，再当前侧新增，最后只在约定清单里出现的键。
  const order: string[] = [];
  for (const row of baseline.rows) if (!order.includes(row.key)) order.push(row.key);
  for (const row of current.rows) if (!order.includes(row.key)) order.push(row.key);
  for (const key of required) if (!order.includes(key)) order.push(key);

  const items: ReconcileItem[] = order.map((key) => {
    const inBaseline = baselineByKey.get(key);
    const inCurrent = currentByKey.get(key);
    const isRequired = required.includes(key);
    const conflicts = baseIndex.conflicting.has(key) || currIndex.conflicting.has(key);
    const dupNote = baseline.duplicates.some((dup) => dup.key === key) ||
      current.duplicates.some((dup) => dup.key === key)
      ? { duplicates: repeatedOccurrences(key) }
      : {};

    // 冲突的重复主键：不给结论，列出材料、键与全部来源行。
    if (conflicts) {
      const sides: string[] = [];
      if (baseIndex.conflicting.has(key)) sides.push(`基线 ${request.baseline.path}`);
      if (currIndex.conflicting.has(key)) sides.push(`当前 ${request.current.path}`);
      return {
        key,
        status: "ambiguous",
        baselineLine: inBaseline?.line ?? null,
        currentLine: inCurrent?.line ?? null,
        changes: [],
        reason: `duplicate-key-conflict: 主键 ${key} 在 ${sides.join(" 与 ")} 中重复出现且内容冲突`,
        ...(inBaseline && inBaseline.endLine !== inBaseline.line ? { baselineEndLine: inBaseline.endLine } : {}),
        ...(inCurrent && inCurrent.endLine !== inCurrent.line ? { currentEndLine: inCurrent.endLine } : {}),
        duplicates: repeatedOccurrences(key),
      };
    }

    if (inBaseline && inCurrent) {
      const changes: ReconcileFieldChange[] = [];
      for (const field of compareFields) {
        const before = inBaseline.fields[field] ?? null;
        const after = inCurrent.fields[field] ?? null;
        if ((before ?? "") !== (after ?? "")) changes.push({ field, before, after });
      }
      return {
        key,
        status: changes.length ? "changed" : "unchanged",
        baselineLine: inBaseline.line,
        currentLine: inCurrent.line,
        changes,
        ...(inBaseline.endLine !== inBaseline.line ? { baselineEndLine: inBaseline.endLine } : {}),
        ...(inCurrent.endLine !== inCurrent.line ? { currentEndLine: inCurrent.endLine } : {}),
        ...dupNote,
      };
    }
    if (inBaseline) {
      return {
        key,
        status: isRequired ? "missing" : "removed",
        baselineLine: inBaseline.line,
        currentLine: null,
        changes: [],
        ...(isRequired ? { reason: "required-key-absent-in-current" } : {}),
        ...(inBaseline.endLine !== inBaseline.line ? { baselineEndLine: inBaseline.endLine } : {}),
        ...dupNote,
      };
    }
    if (inCurrent) {
      return {
        key,
        status: "added",
        baselineLine: null,
        currentLine: inCurrent.line,
        changes: [],
        ...(inCurrent.endLine !== inCurrent.line ? { currentEndLine: inCurrent.endLine } : {}),
        ...dupNote,
      };
    }
    return {
      key,
      status: "missing",
      baselineLine: null,
      currentLine: null,
      changes: [],
      reason: "required-key-absent-in-both",
    };
  });

  const counts: ReconcileCounts = {
    added: items.filter((item) => item.status === "added").length,
    removed: items.filter((item) => item.status === "removed").length,
    changed: items.filter((item) => item.status === "changed").length,
    unchanged: items.filter((item) => item.status === "unchanged").length,
    missing: items.filter((item) => item.status === "missing").length,
    unknown: items.filter((item) => item.status === "unknown").length,
    ambiguous: items.filter((item) => item.status === "ambiguous").length,
    totalKeys: items.length,
  };

  return {
    version: 1,
    name: request.name,
    keyField,
    compareFields,
    baseline: materialSummary(baseline, request.baseline, input.baselineSha256 ?? null),
    current: materialSummary(current, request.current, input.currentSha256 ?? null),
    missingMaterials,
    counts,
    items,
  };
}

/** 便于报告渲染的一行摘要，分子/分母都写明。 */
export function summarizeReconcile(result: ReconcileResult): string {
  const c = result.counts;
  return [
    `${result.name}：共 ${c.totalKeys} 项（主键 ${result.keyField}）`,
    `新增 ${c.added}、移除 ${c.removed}、变更 ${c.changed}、未变 ${c.unchanged}、缺件 ${c.missing}、未知 ${c.unknown}` +
      (c.ambiguous ? `、歧义 ${c.ambiguous}` : ""),
    result.missingMaterials.length ? `缺失材料 ${result.missingMaterials.join("、")}` : "",
    c.ambiguous ? "存在重复主键冲突，相关项不给确定结论" : "",
  ].filter(Boolean).join("；");
}

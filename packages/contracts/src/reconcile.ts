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
import { createHash } from "node:crypto";
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
  /**
   * 本次核算对应的目标。业务核算目标必须点名，判定时据此拒绝跨目标套用；
   * 手动核算留空表示不绑定目标。
   */
  goalIds: z.array(z.string().trim().min(1)).optional(),
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
  /**
   * 第八轮：本次核算的版本身份（对应目标、两侧材料内容哈希、采用的核算口径）。
   * 纯函数 `reconcileMaterials` 不填这一项；正常入口（runReconcile）一定带上。
   * 首次判定要求它存在，否则无法证明“判定当时读的是哪一版输入”。
   */
  revision?: ReconcileRevision;
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

/**
 * 目标级核算请求：只点名目标，其余口径全部取目标建档时持久化的 business 配置。
 * 避免操作员每次手抄基线/当前路径而与目标声明不一致。
 */
export const GoalReconcileRequestSchema = z.object({
  goalId: z.string().trim().min(1),
});
export type GoalReconcileRequest = z.infer<typeof GoalReconcileRequestSchema>;

/* ─────────────────────────────────────────────────────────────────────────
 * 第八轮：业务核算目标（正常建档入口的显式类型）与核算版本身份
 *
 * 两件事都在这里定死，其他地方只引用，不再各写一份：
 * 1. 操作员在控制台选“业务核算”并填基线/当前材料与核算配置后，系统据此
 *    派生 `reconcileGate` 与证据 glob。派生只发生在这一处，建档请求、落库、
 *    目标详情、恢复后的任务读的是同一份派生结果。
 * 2. 每次核算都带一个可排序、唯一、自描述的版本号（`reconcileRevision`），
 *    记下对应的目标、两侧材料的内容哈希与采用的核算配置口径。首次判定用它
 *    核对“判定当时有效的输入”，而不是在证据目录里挑一份曾经合格的文件。
 * ───────────────────────────────────────────────────────────────────────── */

/** evidence/ 下的一份核算材料。 */
export const ReconcileInputRefSchema = z.object({
  /** evidence/ 下的相对路径。 */
  path: z.string().trim().min(1),
  /** 省略时按扩展名判断。 */
  format: z.enum(["csv", "json"]).optional(),
  /** 覆盖核算级 keyField。 */
  keyField: z.string().trim().min(1).optional(),
});
export type ReconcileInputRef = z.infer<typeof ReconcileInputRefSchema>;

/**
 * 业务核算配置：一次“比对两份原始清单”所需的全部业务口径。
 *
 * 这是操作员在建档界面填的东西，也就是服务端落库、目标详情与恢复后的任务
 * 共同使用的那一份配置。判定阈值（maxUnknown / maxAmbiguous）属于目标条件，
 * 由它派生到 `reconcileGate`，不参与 `configDigest`——阈值只决定“是否接受”，
 * 不改变核算结果本身的口径。
 */
export const BusinessReconcileConfigSchema = z.object({
  /** 核算名。结果文件为 reconcile/<name>-<revisionId>.json，同名的多次核算互不覆盖。 */
  name: z
    .string()
    .trim()
    .min(1)
    .max(64)
    .regex(/^[A-Za-z0-9._-]+$/, "name 只允许字母数字与 ._-")
    .default("reconcile"),
  /** 差异主键字段（资产名 / 主机名 / 配置项 ID）。 */
  keyField: z.string().trim().min(1).default("host"),
  /** 只比较这些字段；省略时比较两侧出现过的全部字段。 */
  compareFields: z.array(z.string().trim().min(1)).optional(),
  /** 约定的检查项清单；未出现在当前记录里的键标为“缺件”。 */
  requiredKeys: z.array(z.string().trim().min(1)).optional(),
  /** 允许的未知项上限（默认 0）。 */
  maxUnknown: z.number().int().nonnegative().default(0),
  /** 允许的重复主键歧义上限（默认 0）。 */
  maxAmbiguous: z.number().int().nonnegative().default(0),
  baseline: ReconcileInputRefSchema,
  current: ReconcileInputRefSchema,
});
export type BusinessReconcileConfig = z.infer<typeof BusinessReconcileConfigSchema>;

/** 业务核算目标的 kind 字面量。 */
export const BUSINESS_RECONCILE_KIND = "business-reconcile" as const;

/** 该核算名的结果归档 glob；同一核算名的多次核算都在这个集合里。 */
export function reconcileResultPattern(name: string): string {
  return `reconcile/${name}-*.json`;
}

/**
 * 由业务配置派生目标级核算条件。默认值即“材料齐、无未知、无歧义才通过”，
 * 操作员不需要手写 JSON，也不会因为自然语言措辞不同而得到不同结论。
 */
export function reconcileGateFromConfig(config: BusinessReconcileConfig): ReconcileGate {
  return {
    pattern: reconcileResultPattern(config.name),
    maxUnknown: config.maxUnknown,
    maxAmbiguous: config.maxAmbiguous,
  };
}

/**
 * 核算配置的规范化字符串：键序固定、省略项按默认值补齐，保证同一份配置
 * 在任何进程里都得到同一个摘要。
 */
export function reconcileConfigCanonical(config: BusinessReconcileConfig): string {
  const canonical = {
    name: config.name,
    keyField: config.keyField,
    compareFields: [...new Set(config.compareFields ?? [])],
    requiredKeys: [...new Set(config.requiredKeys ?? [])],
    baseline: {
      path: config.baseline.path.replace(/\\/g, "/"),
      format: config.baseline.format ?? null,
      keyField: config.baseline.keyField ?? null,
    },
    current: {
      path: config.current.path.replace(/\\/g, "/"),
      format: config.current.format ?? null,
      keyField: config.current.keyField ?? null,
    },
  };
  return JSON.stringify(canonical);
}

/** 核算口径摘要。用于确认“这次结果是不是按目标声明的口径算出来的”。 */
export function reconcileConfigDigest(config: BusinessReconcileConfig): string {
  return createHash("sha256").update(reconcileConfigCanonical(config), "utf8").digest("hex");
}

/** 由 ReconcileRequest 构造同一口径的业务配置（手动核算也带得上自描述信息）。 */
export function businessConfigFromRequest(request: ReconcileRequest): BusinessReconcileConfig {
  return BusinessReconcileConfigSchema.parse({
    name: request.name,
    keyField: request.keyField,
    ...(request.compareFields?.length ? { compareFields: request.compareFields } : {}),
    ...(request.requiredKeys?.length ? { requiredKeys: request.requiredKeys } : {}),
    baseline: {
      path: request.baseline.path,
      ...(request.baseline.format ? { format: request.baseline.format } : {}),
      ...(request.baseline.keyField ? { keyField: request.baseline.keyField } : {}),
    },
    current: {
      path: request.current.path,
      ...(request.current.format ? { format: request.current.format } : {}),
      ...(request.current.keyField ? { keyField: request.current.keyField } : {}),
    },
  });
}

/** 一份材料在核算那一刻的样子（内容哈希是核对“输入是否变过”的唯一依据）。 */
export const ReconcileInputStampSchema = z.object({
  path: z.string().min(1),
  format: z.enum(["csv", "json"]).nullable(),
  /** 核算时该材料是否真的读到了。 */
  present: z.boolean(),
  /** 读到的字节的 SHA-256；没读到时为 null。 */
  sha256: z.string().regex(/^[0-9a-f]{64}$/).nullable(),
  /** 解析出的记录行数。 */
  rows: z.number().int().nonnegative(),
});
export type ReconcileInputStamp = z.infer<typeof ReconcileInputStampSchema>;

/**
 * 核算版本号：`r<13 位毫秒>-<4 位序号>`。
 *
 * 字典序即时间序，同一毫秒内的连续核算靠序号区分（同名同路径也不撞），
 * 因此“同名连续核算”可以被区分，也不需要用文件名或秒级时间戳来挑选结果。
 */
export const ReconcileRevisionIdPattern = /^r\d{13}-\d{4}$/;

export const ReconcileRevisionSchema = z.object({
  id: z.string().regex(ReconcileRevisionIdPattern, "核算版本号形如 r<毫秒>-<序号>"),
  taskId: z.string().min(1),
  /** 本次核算对应的目标；手动核算未指定时为空数组。 */
  goalIds: z.array(z.string().min(1)).default([]),
  /** 采用的核算配置（自描述，便于离线复核）。 */
  config: BusinessReconcileConfigSchema,
  /** 核算口径摘要。 */
  configDigest: z.string().regex(/^[0-9a-f]{64}$/),
  /** 两侧材料哈希与口径摘要的合成摘要：输入集合一变就不一样。 */
  inputDigest: z.string().regex(/^[0-9a-f]{64}$/),
  baseline: ReconcileInputStampSchema,
  current: ReconcileInputStampSchema,
  createdAt: z.string().min(1),
});
export type ReconcileRevision = z.infer<typeof ReconcileRevisionSchema>;

/** 输入摘要：口径 + 两侧路径与内容哈希。任一变化都会改变它。 */
export function reconcileInputDigest(
  configDigest: string,
  baseline: ReconcileInputStamp,
  current: ReconcileInputStamp,
): string {
  const canonical = JSON.stringify({
    configDigest,
    baseline: { path: baseline.path, present: baseline.present, sha256: baseline.sha256 },
    current: { path: current.path, present: current.present, sha256: current.sha256 },
  });
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

/** 下一个核算版本号：单调、唯一；时钟回拨也不会产生更小的号。 */
export function nextReconcileRevisionId(previousIds: string[], nowMs = Date.now()): string {
  let lastMs = 0;
  let lastSeq = 0;
  for (const id of previousIds) {
    const match = /^r(\d{13})-(\d{4})$/.exec(id);
    if (!match) continue;
    const ms = Number(match[1]);
    const seq = Number(match[2]);
    if (ms > lastMs) {
      lastMs = ms;
      lastSeq = seq;
    } else if (ms === lastMs) {
      lastSeq = Math.max(lastSeq, seq);
    }
  }
  // 时钟回拨（nowMs <= lastMs）时沿用上一毫秒并递增序号，保持严格单调。
  if (lastMs > 0 && nowMs <= lastMs) {
    return `r${String(lastMs).padStart(13, "0")}-${String(lastSeq + 1).padStart(4, "0")}`;
  }
  return `r${String(nowMs).padStart(13, "0")}-0001`;
}

/**
 * 原始材料差异核算（业务验收项 2）。
 *
 * 输入只有业务字段：两份原始记录（资产清单 CSV / 配置基线 JSON）与约定的
 * 键字段。输出按键给出 新增 / 移除 / 变更 / 未变 / 缺件，并能定位到具体
 * 来源行与字段。这里不读任何“预期结果”，预期差异由验收端另行封存比对。
 *
 * 缺件有两层含义，分别上报，不合并：
 * - `missingMaterials`：申请里点名、但 evidence/ 下读不到的材料文件；
 * - `items[].status = "missing"`：约定的检查项（requiredKeys）在原始记录中不存在。
 * 材料缺失时不做猜测：对应项一律 `unknown`，并写明缺哪一侧。
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

export type MaterialRow = { key: string; line: number; fields: Record<string, string> };

export type ParsedMaterial = {
  path: string;
  format: "csv" | "json";
  keyField: string;
  rows: MaterialRow[];
  /** 表头 / JSON 顶层键数量（用于核对输入规模）。 */
  fieldCount: number;
};

export type ReconcileFieldChange = { field: string; before: string | null; after: string | null };

export type ReconcileItemStatus = "added" | "removed" | "changed" | "unchanged" | "missing" | "unknown";

export type ReconcileItem = {
  key: string;
  status: ReconcileItemStatus;
  baselineLine: number | null;
  currentLine: number | null;
  changes: ReconcileFieldChange[];
  /** 非正常状态的原因（例如材料缺失、约定项两侧都没有）。 */
  reason?: string;
};

export type ReconcileCounts = {
  added: number;
  removed: number;
  changed: number;
  unchanged: number;
  missing: number;
  unknown: number;
  totalKeys: number;
};

export type ReconcileResult = {
  version: 1;
  name: string;
  keyField: string;
  compareFields: string[];
  baseline: { path: string; format: "csv" | "json" | null; rows: number; sha256: string | null };
  current: { path: string; format: "csv" | "json" | null; rows: number; sha256: string | null };
  missingMaterials: string[];
  counts: ReconcileCounts;
  items: ReconcileItem[];
};

function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i]!;
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') {
        field += '"';
        i += 1;
      } else if (ch === '"') {
        quoted = false;
      } else {
        field += ch;
      }
      continue;
    }
    if (ch === '"') quoted = true;
    else if (ch === ",") {
      out.push(field);
      field = "";
    } else field += ch;
  }
  out.push(field);
  return out.map((value) => value.trim());
}

function detectFormat(path: string, explicit?: "csv" | "json"): "csv" | "json" {
  if (explicit) return explicit;
  return /\.json$/i.test(path) ? "json" : "csv";
}

/** 行号按 1 开始计；CSV 首行为表头，第一条数据在第 2 行。 */
export function parseMaterial(input: {
  path: string;
  content: string;
  keyField: string;
  format?: "csv" | "json";
}): ParsedMaterial {
  const format = detectFormat(input.path, input.format);
  const keyField = input.keyField;
  if (format === "csv") {
    const lines = input.content.split(/\r?\n/).filter((line) => line.trim().length > 0);
    if (!lines.length) throw new Error(`${input.path}: 空材料，没有表头`);
    const header = splitCsvLine(lines[0]!);
    if (!header.includes(keyField)) {
      throw new Error(`${input.path}: 表头缺少主键字段 ${keyField}（表头：${header.join(",")}）`);
    }
    const rows: MaterialRow[] = [];
    for (let i = 1; i < lines.length; i += 1) {
      const cells = splitCsvLine(lines[i]!);
      const fields: Record<string, string> = {};
      header.forEach((name, index) => {
        fields[name] = cells[index] ?? "";
      });
      const key = fields[keyField] ?? "";
      if (!key) throw new Error(`${input.path}: 第 ${i + 1} 行缺少主键 ${keyField}`);
      rows.push({ key, line: i + 1, fields });
    }
    return { path: input.path, format, keyField, rows, fieldCount: header.length };
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
      rows.push({ key, line: lineOf(key), fields });
    });
  } else if (data && typeof data === "object") {
    for (const [key, value] of Object.entries(data as Record<string, unknown>)) {
      const fields = toFields(value);
      Object.keys(fields).forEach((field) => fieldsSeen.add(field));
      rows.push({ key, line: lineOf(key), fields: { ...fields, [keyField]: fields[keyField] ?? key } });
    }
  } else {
    throw new Error(`${input.path}: JSON 顶层必须是数组或对象`);
  }
  return { path: input.path, format, keyField, rows, fieldCount: fieldsSeen.size };
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
      unknown: items.length, totalKeys: items.length,
    };
    return {
      version: 1,
      name: request.name,
      keyField,
      compareFields: declaredFields ?? [],
      baseline: {
        path: request.baseline.path,
        format: baseline?.format ?? null,
        rows: baseline?.rows.length ?? 0,
        sha256: input.baselineSha256 ?? null,
      },
      current: {
        path: request.current.path,
        format: current?.format ?? null,
        rows: current?.rows.length ?? 0,
        sha256: input.currentSha256 ?? null,
      },
      missingMaterials,
      counts,
      items,
    };
  }

  const baselineByKey = new Map(baseline.rows.map((row) => [row.key, row]));
  const currentByKey = new Map(current.rows.map((row) => [row.key, row]));
  const compareFields = declaredFields ?? [...new Set([
    ...baseline.rows.flatMap((row) => Object.keys(row.fields)),
    ...current.rows.flatMap((row) => Object.keys(row.fields)),
  ])].filter((field) => field !== keyField);

  // 输出顺序固定：先基线顺序，再当前侧新增，最后只在约定清单里出现的键。
  const order: string[] = [];
  for (const row of baseline.rows) if (!order.includes(row.key)) order.push(row.key);
  for (const row of current.rows) if (!order.includes(row.key)) order.push(row.key);
  for (const key of required) if (!order.includes(key)) order.push(key);

  const items: ReconcileItem[] = order.map((key) => {
    const inBaseline = baselineByKey.get(key);
    const inCurrent = currentByKey.get(key);
    const isRequired = required.includes(key);
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
      };
    }
    if (inCurrent) {
      return { key, status: "added", baselineLine: null, currentLine: inCurrent.line, changes: [] };
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
    totalKeys: items.length,
  };

  return {
    version: 1,
    name: request.name,
    keyField,
    compareFields,
    baseline: { path: request.baseline.path, format: baseline.format, rows: baseline.rows.length, sha256: input.baselineSha256 ?? null },
    current: { path: request.current.path, format: current.format, rows: current.rows.length, sha256: input.currentSha256 ?? null },
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
    `新增 ${c.added}、移除 ${c.removed}、变更 ${c.changed}、未变 ${c.unchanged}、缺件 ${c.missing}、未知 ${c.unknown}`,
    result.missingMaterials.length ? `缺失材料 ${result.missingMaterials.join("、")}` : "",
  ].filter(Boolean).join("；");
}

/**
 * 原始材料差异核算的正常入口实现（验收项 2）。
 *
 * 只读取操作员通过 `POST /tasks/:id/evidence` 导入的原始记录、按业务字段
 * 计算差异，并把核算结果本身写成一份带 SHA-256 的证据与一条 Fact。这里
 * 不接触任何“预期结果”：预期由验收端另行封存后逐项比对。
 */
import { createHash } from "node:crypto";
import {
  ReconcileRequestSchema,
  parseMaterial,
  reconcileMaterials,
  summarizeReconcile,
  type ReconcileRequest,
  type ReconcileResult,
} from "@gongyuai/contracts";
import {
  openHistory,
  readEvidenceBytes,
  resolveEvidenceFile,
  writeEvidenceFile,
} from "@gongyuai/history";
import { taskPaths } from "./paths.js";

export type ReconcileMaterialState = {
  path: string;
  present: boolean;
  sha256: string | null;
  bytes: Buffer | null;
};

export type ReconcileOutcome = {
  result: ReconcileResult;
  /** 核算结果在 evidence/ 下的相对路径。 */
  evidencePath: string;
  evidenceSha256: string;
  factId: string | null;
  materials: { baseline: ReconcileMaterialState; current: ReconcileMaterialState };
};

function materialState(evidenceDir: string, path: string): ReconcileMaterialState {
  try {
    // resolveEvidenceFile enforces containment (no traversal, no symlink).
    resolveEvidenceFile(evidenceDir, path);
    const bytes = readEvidenceBytes(evidenceDir, path);
    return { path, present: true, sha256: createHash("sha256").update(bytes).digest("hex"), bytes };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (/ENOENT|no such file/i.test(message)) {
      return { path, present: false, sha256: null, bytes: null };
    }
    throw err;
  }
}

function stamp(): string {
  return new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
}

export function runReconcile(
  taskId: string,
  dataDir: string,
  input: unknown,
): ReconcileOutcome {
  const request: ReconcileRequest = ReconcileRequestSchema.parse(input);
  const { evidenceDir, historyDb } = taskPaths(dataDir);

  const baseline = materialState(evidenceDir, request.baseline.path);
  const current = materialState(evidenceDir, request.current.path);

  const baselineParsed = baseline.bytes
    ? parseMaterial({
        path: baseline.path,
        content: baseline.bytes.toString("utf8"),
        keyField: request.baseline.keyField ?? request.keyField,
        ...(request.baseline.format ? { format: request.baseline.format } : {}),
      })
    : null;
  const currentParsed = current.bytes
    ? parseMaterial({
        path: current.path,
        content: current.bytes.toString("utf8"),
        keyField: request.current.keyField ?? request.keyField,
        ...(request.current.format ? { format: request.current.format } : {}),
      })
    : null;

  const result = reconcileMaterials({
    request,
    baseline: baselineParsed,
    current: currentParsed,
    baselineSha256: baseline.sha256,
    currentSha256: current.sha256,
  });

  const serialized = JSON.stringify(result, null, 2) + "\n";
  const relativePath = `reconcile/${request.name}-${stamp()}.json`;
  writeEvidenceFile(evidenceDir, relativePath, serialized);
  const evidenceSha256 = createHash("sha256").update(Buffer.from(serialized, "utf8")).digest("hex");

  let factId: string | null = null;
  const history = openHistory({ dbPath: historyDb, evidenceDir });
  try {
    const fact = history.appendFact({
      taskId,
      layer: "evidence",
      title: `原始材料差异核算 · ${request.name}`,
      summary: summarizeReconcile(result),
      evidencePath: relativePath,
      tags: ["reconcile", `reconcile:${request.name}`, "source:operator"],
    });
    factId = fact.id;
  } finally {
    history.close();
  }

  return {
    result,
    evidencePath: relativePath,
    evidenceSha256,
    factId,
    materials: {
      baseline: { path: baseline.path, present: baseline.present, sha256: baseline.sha256, bytes: null },
      current: { path: current.path, present: current.present, sha256: current.sha256, bytes: null },
    },
  };
}

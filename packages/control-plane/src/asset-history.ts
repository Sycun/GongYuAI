import { existsSync } from "node:fs";
import type { TaskRecord } from "@gongyuai/contracts";
import { normalizeHost } from "@gongyuai/contracts";
import { openHistory } from "@gongyuai/history";
import { taskPaths } from "./paths.js";
import type { ControlStore } from "./store.js";

/**
 * P14-B3 — read-only "历史接触" projection across the archive.
 *
 * A prior task touching the same host is a lead, never authorization and never
 * a fact in the current graph: the caller only shows it as context (system
 * Hint / console panel), so the current task still has to verify everything.
 */
export type AssetHistoryHit = {
  taskId: string;
  name: string;
  engagementId: string;
  status: string;
  createdAt: string;
  assets: Array<{
    address: string;
    kind: string;
    assetType: string | null;
    weight: number;
    createdAt: string;
  }>;
  findings: Array<{
    id: string;
    title: string;
    severity: string;
    status: string;
    asset: string;
    endpoint: string | null;
    vulnClass: string;
    verifiedAt: string | null;
  }>;
};

export type AssetHistory = {
  host: string;
  hits: AssetHistoryHit[];
  note: string;
};

export function assetHistory(
  store: ControlStore,
  current: TaskRecord,
  address: string,
  limit = 20,
): AssetHistory {
  const host = normalizeHost(address) || address.trim().toLowerCase();
  const hits: AssetHistoryHit[] = [];
  if (!host) {
    return { host, hits, note: "历史接触≠本次授权；只作线索，需在本任务重新验证。" };
  }
  for (const task of store.list()) {
    if (task.id === current.id) continue;
    if ((task.tenantId ?? "default") !== (current.tenantId ?? "default")) continue;
    const paths = taskPaths(task.dataDir);
    if (!existsSync(paths.historyDb)) continue;
    let history;
    try {
      history = openHistory({ dbPath: paths.historyDb, evidenceDir: paths.evidenceDir, readOnly: true });
    } catch {
      continue;
    }
    try {
      const assets = history
        .listAssets(task.id)
        .filter((asset) => {
          const assetHost = normalizeHost(asset.address);
          return assetHost === host || asset.parentAddress === host;
        })
        .map((asset) => ({
          address: asset.address,
          kind: asset.kind,
          assetType: asset.assetType,
          weight: asset.weight,
          createdAt: asset.createdAt,
        }));
      const findings = history
        .listFindings(task.id)
        .filter(
          (finding) =>
            ["verified", "retested", "accepted"].includes(finding.status) &&
            normalizeHost(finding.asset) === host,
        )
        .map((finding) => ({
          id: finding.id,
          title: finding.title,
          severity: finding.severity,
          status: finding.status,
          asset: finding.asset,
          endpoint: finding.endpoint,
          vulnClass: finding.vulnClass,
          verifiedAt: finding.verifiedAt,
        }));
      if (!assets.length && !findings.length) continue;
      hits.push({
        taskId: task.id,
        name: task.name,
        engagementId: task.engagementId,
        status: task.status,
        createdAt: task.createdAt,
        assets,
        findings,
      });
    } catch {
      /* a corrupt/old archive must not break the panel */
    } finally {
      history.close();
    }
  }
  hits.sort((a, b) => {
    if (b.findings.length !== a.findings.length) return b.findings.length - a.findings.length;
    return b.createdAt.localeCompare(a.createdAt);
  });
  return {
    host,
    hits: hits.slice(0, limit),
    note: "历史接触≠本次授权；只作线索，需在本任务重新验证（不写入当前图）。",
  };
}

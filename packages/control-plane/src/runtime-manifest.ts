import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import {
  DEFAULT_MAX_CONCURRENT_EXPLORES,
  resolveExploreWorkerCount,
  resolveWorkerSlotCount,
  type TaskRecord,
  type WorkerManifest,
} from "@gongyuai/contracts";
import { openHistory } from "@gongyuai/history";
import { durableDbForSlot, manifestPathForSlot, taskPaths } from "./paths.js";
import type { SettingsStore } from "./settings.js";

export function taskWorkerCount(task: TaskRecord, assetCount?: number): number {
  const configured = task.execution?.maxConcurrentExplores ?? DEFAULT_MAX_CONCURRENT_EXPLORES;
  const hasTsecBoard = !task.mock && task.goals.some((g) => g.boardGate === "tsecbench");
  // Decouple Explore worker concurrency (e.g. 8–10 Followers) from the 3-container platform cap
  // so multi-hypothesis fan-out (2–4 orthogonal Intents sharing 1 medium/hard container) starts at full pool size.
  const effectiveTargets = hasTsecBoard
    ? Math.max(task.auth.targets.length, configured)
    : task.auth.targets.length;
  const exploreCount = resolveExploreWorkerCount({
    maxConcurrentExplores: configured,
    targetCount: effectiveTargets,
    assetCount,
  });
  return resolveWorkerSlotCount(exploreCount);
}

/**
 * Distinct scalable exploration units from History (0 when no History yet):
 * `max(admitted/live assets, open Intents)` so single-target engagements that fan out
 * 2–3 orthogonal Intents on the same host also scale Follower slots up to operator cap.
 */
export function countScalableAssets(task: TaskRecord): number {
  const paths = taskPaths(task.dataDir);
  if (!existsSync(paths.historyDb)) return 0;
  const history = openHistory({ dbPath: paths.historyDb, evidenceDir: paths.evidenceDir, readOnly: true });
  try {
    const assetUnits = history
      .listAssets(task.id)
      .filter((a) => a.kind === "admitted" || a.kind === "live").length;
    const openIntentUnits = history.openIntents(task.id).length;
    return Math.max(assetUnits, openIntentUnits);
  } finally {
    history.close();
  }
}

export function writeManifestForSlot(
  task: TaskRecord,
  settings: SettingsStore,
  slot: number,
  workerCount: number,
): WorkerManifest {
  const paths = taskPaths(task.dataDir);
  const model = settings.modelForManifest();
  const durableDb = durableDbForSlot(task.dataDir, slot);
  const manifestPath = manifestPathForSlot(task.dataDir, slot);
  // A checkpoint already includes its own counters. Debit any earlier usage
  // that survived only in the control ledger from finite worker limits.
  const budget = { ...task.budget };
  if (task.usageOffset) {
    for (const [limit, meter] of [
      ["maxTokens", "tokens"], ["maxToolCalls", "toolCalls"], ["maxInstalls", "installs"],
    ] as const) {
      if (budget[limit] > 0) {
        budget[limit] -= task.usageOffset[meter];
        if (budget[limit] <= 0) throw new Error(`existing task budget exhausted: ${limit}`);
      }
    }
  }
  const manifest: WorkerManifest = {
    taskId: task.id,
    engagementId: task.engagementId,
    commandFence: task.fence,
    commandConfirmation: settings.get().chatApproval.confirmation,
    dataDir: task.dataDir,
    historyDb: paths.historyDb,
    durableDb,
    evidenceDir: paths.evidenceDir,
    workspaceDir: paths.workspaceDir,
    auth: task.auth,
    scopeVersion: task.scopeVersion,
    goals: task.goals,
    budget,
    execution: task.execution,
    workerId: `w${slot}-${task.id.slice(0, 8)}`,
    workerSlot: slot,
    workerCount,
    mock: task.mock,
    model,
    mcpServers: settings.enabledMcpForManifest(),
    mcpPool: settings.allMcpForManifest(),
    mcpCatalog: settings.mcpCatalogForManifest(),
    skillPacks: settings.enabledSkillsForManifest(),
    skillPool: settings.routedSkillsForManifest(),
    skillCatalog: settings.skillCatalogForManifest(),
    assetCollectors: settings.enabledAssetCollectorsForManifest(),
  };
  mkdirSync(task.dataDir, { recursive: true });
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

  // Seed once (idempotent) from the leader write path.
  if (slot === 0) {
    const history = openHistory({
      dbPath: paths.historyDb,
      evidenceDir: paths.evidenceDir,
    });
    history.seedGoals(task.id, task.goals);
    history.seedAssetsFromAuth(task.id, task.auth);
    history.close();
  }

  return manifest;
}

export function recordExploreScaled(task: TaskRecord, from: number, to: number, assetCount: number): void {
  const paths = taskPaths(task.dataDir);
  const history = openHistory({ dbPath: paths.historyDb, evidenceDir: paths.evidenceDir });
  try {
    history.recordExploreScaled(task.id, { from, to, assetCount });
  } finally {
    history.close();
  }
}

import { sameAssetScope, type WorkerAdvisory } from "@gongyuai/contracts";
import type { HistoryStore } from "@gongyuai/history";

/**
 * Cross-slot supervisor inbox helpers.
 *
 * Advisories are written by the scheduler (`intent_advise`) or auto-broadcast when
 * a slot registers a shared resource (credential / tunnel). They are drained by the
 * target Worker's own main loop and surfaced as `[SUPERVISOR_ADVISORY_GATE]` notes —
 * never as chat interruptions, and never carrying plaintext secrets.
 */

export function formatSupervisorAdvisoryGate(advisories: readonly WorkerAdvisory[]): string {
  const lines = [
    "[SUPERVISOR_ADVISORY_GATE] 你收到调度督导 / 友邻资源广播（已原子消费，仅本次可见）：",
  ];
  for (const advisory of advisories.slice(0, 8)) {
    const scope = advisory.assetScope ? ` @${advisory.assetScope}` : "";
    lines.push(
      `- (${advisory.priority}/${advisory.kind})${scope} from=${advisory.createdBy}: ${advisory.summary}`,
    );
  }
  if (advisories.length > 8) {
    lines.push(`- … 另有 ${advisories.length - 8} 条督导未展开。`);
  }
  lines.push(
    "（无需回执；请立即把定向建议吸收进当前动作：复用广播的凭据/隧道、避免重复探测同一子路径、按督导切换攻击面或优先级。）",
  );
  return lines.join("\n");
}

/**
 * Broadcast one resource (credential pointer / tunnel port) to peer Intents running
 * on the same asset scope (identical assetRoot or same RFC1918 /24). The caller must
 * pass an already-redacted summary — only ids, asset, username, kind / ports.
 */
export function enqueuePeerResourceBroadcast(opts: {
  history: HistoryStore;
  taskId: string;
  createdBy: string;
  excludeIntentId?: string | null;
  asset: string;
  summary: string;
}): string[] {
  const asset = opts.asset.trim();
  if (!asset) return [];
  const peers = opts.history
    .listIntents(opts.taskId)
    .filter(
      (intent) =>
        (intent.status === "claimed" || intent.status === "running") &&
        intent.id !== opts.excludeIntentId &&
        Boolean(intent.assetRoot) &&
        sameAssetScope(intent.assetRoot, asset),
    );
  const ids: string[] = [];
  for (const peer of peers) {
    try {
      const advisory = opts.history.enqueueAdvisory({
        taskId: opts.taskId,
        kind: "resource_broadcast",
        priority: "important",
        targetIntentId: peer.id,
        targetWorkerSlot: null,
        assetScope: peer.assetRoot,
        summary: opts.summary,
        createdBy: opts.createdBy,
      });
      ids.push(advisory.id);
    } catch {
      /* best-effort cross-slot notification */
    }
  }
  return ids;
}

/** Redacted credential broadcast: only id / asset / username / kind — never secret material. */
export function broadcastCredentialAdvisory(opts: {
  history: HistoryStore;
  taskId: string;
  createdBy: string;
  excludeIntentId?: string | null;
  credential: { id: string; asset: string; username?: string | null; kind?: string | null };
}): string[] {
  return enqueuePeerResourceBroadcast({
    history: opts.history,
    taskId: opts.taskId,
    createdBy: opts.createdBy,
    excludeIntentId: opts.excludeIntentId,
    asset: opts.credential.asset,
    summary:
      `新凭据入库：id=${opts.credential.id} asset=${opts.credential.asset} ` +
      `username=${opts.credential.username || "—"} kind=${opts.credential.kind ?? "—"}；` +
      "同一资产面可直接 credential_list 查看元数据后复用（明文不广播，secretRef 请按需读证据）。",
  });
}

/** Tunnel broadcast: forward port + target only; no credentials, no command lines. */
export function broadcastTunnelAdvisory(opts: {
  history: HistoryStore;
  taskId: string;
  createdBy: string;
  excludeIntentId?: string | null;
  tunnel: {
    id: string;
    kind?: string | null;
    localPort?: number | null;
    targetHost?: string | null;
    via?: string | null;
  };
}): string[] {
  const asset = opts.tunnel.targetHost || opts.tunnel.via || "";
  return enqueuePeerResourceBroadcast({
    history: opts.history,
    taskId: opts.taskId,
    createdBy: opts.createdBy,
    excludeIntentId: opts.excludeIntentId,
    asset,
    summary:
      `新转发隧道：id=${opts.tunnel.id} kind=${opts.tunnel.kind ?? "—"} ` +
      `127.0.0.1:${opts.tunnel.localPort ?? "?"} → ${opts.tunnel.targetHost ?? opts.tunnel.via ?? "?"}；` +
      "同资产面可直接 tunnel_list 查看并复用现有隧道（勿重复新建同端口）。",
  });
}
import { join } from "node:path";
import { TunnelManager, hostScopeAllows, type TunnelOpenInput } from "@gongyuai/exec";
import type { WorkerManifest } from "@gongyuai/contracts";
import type { ToolContext } from "./tools.js";
import { capabilityAtLeast, syncAdmittedTargets, unlockFootholdPivotSidecar } from "./tools.js";

/**
 * P14-B4 — local-listener tunnels (pivot). The manager only binds 127.0.0.1 and
 * every target/jump host passes the task's scope (targets ∪ declared pivot
 * CIDRs). Opens are recorded in the change ledger as `network` changes whose
 * rollback command is the kill line — generated, never executed automatically.
 */
const managers = new Map<string, TunnelManager>();

function managerFor(ctx: ToolContext): TunnelManager {
  const key = `${ctx.manifest.dataDir}::${ctx.manifest.taskId}`;
  const existing = managers.get(key);
  if (existing) return existing;
  const manager = new TunnelManager({
    baseDir: join(ctx.manifest.dataDir, "exec"),
    authorizeHost: (host) => {
      syncAdmittedTargets(ctx.manifest);
      return hostScopeAllows(ctx.manifest.auth, host, { dataDir: ctx.manifest.dataDir });
    },
  });
  managers.set(key, manager);
  return manager;
}

function requireTunnelCapability(manifest: WorkerManifest): void {
  const cap = manifest.auth.capability ?? "observe";
  if (!capabilityAtLeast(cap, "active-lab")) {
    throw new Error(`denied: tunnel_open requires auth.capability≥active-lab (have ${cap})`);
  }
}

function parseKind(raw: string | undefined): TunnelOpenInput["kind"] {
  if (raw === "socat" || raw === "ssh-local" || raw === "ssh-socks" || raw === "chisel-socks") return raw;
  throw new Error("tunnel kind must be socat|ssh-local|ssh-socks|chisel-socks");
}

function openInput(args: Record<string, string>): TunnelOpenInput {
  const kind = parseKind(args.kind);
  const localPort = args.localPort ? Number(args.localPort) : undefined;
  const targetPort = args.targetPort ? Number(args.targetPort) : undefined;
  if (localPort !== undefined && (!Number.isInteger(localPort) || localPort < 1 || localPort > 65535)) {
    throw new Error("localPort must be 1-65535");
  }
  if (kind === "socat") {
    if (!args.targetHost || targetPort === undefined) throw new Error("socat needs targetHost + targetPort");
    return { kind, targetHost: args.targetHost, targetPort, ...(localPort ? { localPort } : {}) };
  }
  if (kind === "ssh-local") {
    if (!args.via || !args.targetHost || targetPort === undefined) {
      throw new Error("ssh-local needs via + targetHost + targetPort");
    }
    return { kind, via: args.via, targetHost: args.targetHost, targetPort, ...(localPort ? { localPort } : {}) };
  }
  if (!args.via) throw new Error(`${kind} needs via`);
  return { kind, via: args.via, ...(localPort ? { localPort } : {}) };
}

export async function tunnelOpenTool(ctx: ToolContext, args: Record<string, string>): Promise<string> {
  requireTunnelCapability(ctx.manifest);
  syncAdmittedTargets(ctx.manifest);
  const input = openInput(args);
  if ("via" in input && input.via && hostScopeAllows(ctx.manifest.auth, input.via, { dataDir: ctx.manifest.dataDir })) {
    unlockFootholdPivotSidecar(ctx.manifest);
  }
  const tunnel = await managerFor(ctx).open(input);
  try {
    ctx.history.ops.recordChange(
      {
        taskId: ctx.manifest.taskId,
        engagementId: ctx.manifest.engagementId || ctx.manifest.taskId,
        scopeVersion: ctx.manifest.scopeVersion ?? 1,
      },
      {
        kind: "network",
        asset: tunnel.targetHost || tunnel.via || "127.0.0.1",
        location: `127.0.0.1:${tunnel.localPort}`,
        rollbackCmd: `kill -TERM -${tunnel.pid ?? 0} 2>/dev/null || true`,
        registeredBy: ctx.manifest.workerId || "worker",
        note: `${tunnel.kind} tunnel ${tunnel.id}`,
      },
      null,
      new Date().toISOString(),
      [],
    );
  } catch {
    /* ledger is best-effort; the tunnel itself is already authorized */
  }
  return JSON.stringify({ ok: true, tunnel });
}

export function tunnelListTool(ctx: ToolContext): string {
  const tunnels = managerFor(ctx).list();
  return JSON.stringify({ ok: true, count: tunnels.length, tunnels });
}

export async function tunnelCloseTool(ctx: ToolContext, args: { id?: string }): Promise<string> {
  const id = (args.id ?? "").trim();
  if (!id) return JSON.stringify({ ok: false, error: "tunnel id required" });
  const closed = await managerFor(ctx).close(id);
  return closed
    ? JSON.stringify({ ok: true, tunnel: closed })
    : JSON.stringify({ ok: false, error: `unknown tunnel: ${id}` });
}

/** Test helper: forget cached managers (not used on worker exit — tunnels persist). */
export function resetTunnelManagersForTest(): void {
  managers.clear();
}

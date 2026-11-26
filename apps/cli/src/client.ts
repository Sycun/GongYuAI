import { bootControlPlane } from "@gongyuai/control-plane";
import type { GlobalOpts } from "./args.js";

export function splitCsv(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

export async function api(
  opts: GlobalOpts,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; text: string; json?: unknown }> {
  const base = opts.baseUrl ?? `http://${opts.host}:${opts.port}`;
  const res = await fetch(`${base}${path}`, {
    method,
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    json = undefined;
  }
  return { status: res.status, text, json };
}

export async function ensureServer(opts: GlobalOpts): Promise<{ close?: () => Promise<void> }> {
  try {
    const health = await api(opts, "GET", "/health");
    if (health.status === 200) return {};
  } catch {
    /* start local */
  }
  const plane = await bootControlPlane({
    dataRoot: opts.dataDir || undefined,
    host: opts.host,
    port: opts.port,
  });
  console.error(`[gy] control plane ${plane.url}`);
  return { close: () => plane.close() };
}

export async function withServer(opts: GlobalOpts, run: () => Promise<void>): Promise<void> {
  const owned = await ensureServer(opts);
  try {
    await run();
  } finally {
    if (owned.close) await owned.close();
  }
}

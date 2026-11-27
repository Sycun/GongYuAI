import { normalizeHost } from "./scope.js";

/**
 * Reason / transfer fanout helpers.
 *
 * Concurrency root (`assetRootKey`) is keyed by concrete host so sibling hosts in
 * the same `/24` subnet or `*.corp.com` wildcard domain never starve one another,
 * while up to `DEFAULT_MAX_INTENTS_PER_ASSET_ROOT` orthogonal Intents can probe a
 * single host in parallel. Coarser registrable-domain / `/24` grouping lives in
 * `assetGroupKey` strictly for family-key suggestion (`family-key.ts`).
 */

/** Per-host fanout concurrency key (normalized concrete IPv4 or hostname). */
export function assetRootKey(address: string): string {
  return normalizeHost(address);
}

/** Coarse family-grouping key (registrable-ish domain or IPv4 /24) for `suggestFamilyKey`. */
export function assetGroupKey(address: string): string {
  const host = normalizeHost(address);
  if (!host) return "";
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(host)) {
    const [a, b, c] = host.split(".");
    return `${a}.${b}.${c}.0/24`;
  }
  const labels = host.split(".").filter(Boolean);
  if (labels.length <= 2) return host;
  // Naive eTLD+1; good enough for family suggestion (not cookie policy).
  const multi = new Set(["co.uk", "com.cn", "com.au", "com.br", "co.jp", "ne.jp"]);
  const last2 = labels.slice(-2).join(".");
  if (multi.has(last2) && labels.length >= 3) {
    return labels.slice(-3).join(".");
  }
  return last2;
}

export const DEFAULT_MAX_INTENTS_PER_REASON = 4;
export const DEFAULT_MAX_INTENTS_PER_ASSET_ROOT = 3;
/** 0 = disabled. Default 15 minutes. */
export const DEFAULT_EXPLORE_TIMEOUT_MS = 900_000;
/** Reason project lease TTL; multi-Explore CAS. */
export const DEFAULT_REASON_LEASE_MS = 120_000;

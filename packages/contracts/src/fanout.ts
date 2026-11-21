import { normalizeHost } from "./scope.js";

/**
 * Reason / transfer fanout helpers.
 * Keeps Intent explosion bounded (same-root merge + hard caps).
 */

/** Grouping key for an asset address (registrable-ish domain or IPv4 /24). */
export function assetRootKey(address: string): string {
  const host = normalizeHost(address);
  if (!host) return "";
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(host)) {
    const [a, b, c] = host.split(".");
    return `${a}.${b}.${c}.0/24`;
  }
  const labels = host.split(".").filter(Boolean);
  if (labels.length <= 2) return host;
  // Naive eTLD+1; good enough for fanout merge (not cookie policy).
  const multi = new Set(["co.uk", "com.cn", "com.au", "com.br", "co.jp", "ne.jp"]);
  const last2 = labels.slice(-2).join(".");
  if (multi.has(last2) && labels.length >= 3) {
    return labels.slice(-3).join(".");
  }
  return last2;
}

export const DEFAULT_MAX_INTENTS_PER_REASON = 4;
export const DEFAULT_MAX_INTENTS_PER_ASSET_ROOT = 2;
/** 0 = disabled. Default 15 minutes. */
export const DEFAULT_EXPLORE_TIMEOUT_MS = 900_000;
/** Reason project lease TTL; multi-Explore CAS. */
export const DEFAULT_REASON_LEASE_MS = 120_000;

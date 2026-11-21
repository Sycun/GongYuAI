import { z } from "zod";

/**
 * Asset inventory is a projection of Facts tagged `asset` — not a second source of truth.
 * See docs/asset-inventory.md.
 */
export const AssetKindSchema = z.enum([
  "seed",
  "candidate",
  "admitted",
  "live",
  "oos",
]);
export type AssetKind = z.infer<typeof AssetKindSchema>;

export const ASSET_KIND_RANK: Record<AssetKind, number> = {
  oos: 0,
  candidate: 1,
  seed: 2,
  admitted: 3,
  live: 4,
};

export const AssetSourceSchema = z.enum(["auth", "discover"]);
export type AssetSource = z.infer<typeof AssetSourceSchema>;

export const AssetRecordSchema = z.object({
  address: z.string().min(1),
  kind: AssetKindSchema,
  factId: z.string().min(1),
  title: z.string().min(1),
  summary: z.string().default(""),
  source: AssetSourceSchema,
  createdAt: z.string().datetime(),
  intentId: z.string().nullable().default(null),
});
export type AssetRecord = z.infer<typeof AssetRecordSchema>;

export const ASSET_TAG = "asset";
export const assetKindTag = (kind: AssetKind) => `asset.kind:${kind}`;
export const assetAddrTag = (address: string) => `asset.addr:${address}`;
export const assetSourceTag = (source: AssetSource) => `asset.source:${source}`;

export function parseAssetKindFromTags(tags: string[]): AssetKind | null {
  for (const t of tags) {
    if (t.startsWith("asset.kind:")) {
      const k = t.slice("asset.kind:".length);
      const parsed = AssetKindSchema.safeParse(k);
      if (parsed.success) return parsed.data;
    }
  }
  return null;
}

export function parseAssetAddrFromTags(tags: string[]): string | null {
  for (const t of tags) {
    if (t.startsWith("asset.addr:")) return t.slice("asset.addr:".length);
  }
  return null;
}

export function parseAssetSourceFromTags(tags: string[]): AssetSource {
  for (const t of tags) {
    if (t.startsWith("asset.source:")) {
      const s = t.slice("asset.source:".length);
      const parsed = AssetSourceSchema.safeParse(s);
      if (parsed.success) return parsed.data;
    }
  }
  return "discover";
}

/** Strip scheme / path / port; keep host or IPv4; lowercase; drop trailing dot. */
export function normalizeHost(input: string): string {
  let s = input.trim().toLowerCase();
  if (!s) return "";
  s = s.replace(/^https?:\/\//, "");
  s = s.split("/")[0] ?? s;
  s = s.split("?")[0] ?? s;
  // Drop brackets for IPv6 literals if ever present; MVP focuses on host/IPv4/CIDR.
  s = s.replace(/^\[|\]$/g, "");
  // hostname:port — but not IPv4 CIDR (handled separately) and not bare IPv4 without port confusion
  if (!/^\d{1,3}(?:\.\d{1,3}){3}$/.test(s) && s.includes(":")) {
    const idx = s.lastIndexOf(":");
    const maybePort = s.slice(idx + 1);
    if (/^\d+$/.test(maybePort)) s = s.slice(0, idx);
  }
  return s.replace(/\.$/, "");
}

/** Normalize an auth.targets entry for inventory identity (preserves CIDR & *.wildcards). */
export function normalizeTargetPattern(input: string): string {
  const raw = input.trim().toLowerCase();
  if (!raw) return "";
  if (raw === "*") return "*";
  if (isIpv4Cidr(raw)) return raw;
  if (raw.startsWith("*.")) {
    const base = normalizeHost(raw.slice(2));
    return base ? `*.${base}` : "";
  }
  return normalizeHost(raw);
}

export function isIpv4Cidr(value: string): boolean {
  return /^\d{1,3}(?:\.\d{1,3}){3}\/\d{1,2}$/.test(value.trim());
}

function parseIpv4(host: string): number | null {
  const m = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return null;
  const parts = m.slice(1).map(Number);
  if (parts.some((n) => n > 255)) return null;
  return ((parts[0]! << 24) | (parts[1]! << 16) | (parts[2]! << 8) | parts[3]!) >>> 0;
}

/** True if IPv4 `host` is inside `cidr` (e.g. 10.0.0.0/8). */
export function cidrContains(cidr: string, host: string): boolean {
  const [base, bitsRaw] = cidr.trim().split("/");
  if (!base || bitsRaw == null) return false;
  const ip = parseIpv4(normalizeHost(host));
  const net = parseIpv4(base);
  const bits = Number(bitsRaw);
  if (ip == null || net == null || !Number.isInteger(bits) || bits < 0 || bits > 32) {
    return false;
  }
  if (bits === 0) return true;
  const mask = bits === 32 ? 0xffffffff : (~((1 << (32 - bits)) - 1)) >>> 0;
  return (ip & mask) === (net & mask);
}

export type ScopeMatch =
  | { ok: true; by: string; via: "star" | "cidr" | "wildcard" | "exact" | "suffix" }
  | { ok: false };

/**
 * Formal auth.targets match: `*`, IPv4 CIDR, `*.domain`, exact host, subdomain suffix.
 * Candidate may be host, URL, or IPv4.
 */
export function matchTarget(targets: string[], candidate: string): ScopeMatch {
  const host = normalizeHost(candidate);
  if (!host && !isIpv4Cidr(candidate.trim())) return { ok: false };

  for (const raw of targets) {
    const t = raw.trim();
    if (!t) continue;
    if (t === "*") return { ok: true, by: "*", via: "star" };

    if (isIpv4Cidr(t)) {
      if (host && cidrContains(t, host)) return { ok: true, by: t, via: "cidr" };
      continue;
    }

    const pattern = normalizeTargetPattern(t);
    if (!pattern) continue;

    if (pattern.startsWith("*.")) {
      const base = pattern.slice(2);
      if (host === base || host.endsWith(`.${base}`)) {
        return { ok: true, by: t, via: "wildcard" };
      }
      continue;
    }

    if (host === pattern) return { ok: true, by: t, via: "exact" };
    if (host.endsWith(`.${pattern}`)) return { ok: true, by: t, via: "suffix" };
  }
  return { ok: false };
}

/** outOfScope wins over targets when both match. */
export function targetAllows(
  targets: string[],
  candidate: string,
  outOfScope: string[] = [],
): boolean {
  if (outOfScope.length && matchTarget(outOfScope, candidate).ok) return false;
  return matchTarget(targets, candidate).ok;
}

/**
 * Auto-admit discovered address against auth scope.
 * Seed patterns (CIDR / wildcard / bare domain) stay as inventory rows of their own;
 * concrete hosts under them become admitted (or oos).
 */
export function admitAddress(
  auth: { targets: string[]; outOfScope?: string[] },
  address: string,
): { kind: Extract<AssetKind, "admitted" | "oos">; matchedBy?: string } {
  const oos = auth.outOfScope ?? [];
  if (oos.length && matchTarget(oos, address).ok) {
    return { kind: "oos" };
  }
  const hit = matchTarget(auth.targets, address);
  if (hit.ok) return { kind: "admitted", matchedBy: hit.by };
  return { kind: "oos" };
}

export function assetTags(input: {
  kind: AssetKind;
  address: string;
  source: AssetSource;
}): string[] {
  return [
    ASSET_TAG,
    assetKindTag(input.kind),
    assetAddrTag(input.address),
    assetSourceTag(input.source),
  ];
}

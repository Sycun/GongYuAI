import { assetRootKey } from "./fanout.js";
import { normalizeHost } from "./scope.js";

const FAMILY_TAG_PREFIX = "family:";

/** Extract `family:foo` tag → `foo`. */
export function parseFamilyKeyFromTags(tags: string[]): string | null {
  for (const t of tags) {
    if (t.startsWith(FAMILY_TAG_PREFIX)) {
      const k = t.slice(FAMILY_TAG_PREFIX.length).trim().toLowerCase();
      if (k) return k;
    }
  }
  return null;
}

/** Fingerprint / stack tokens → stable family slug. */
const STACK_PATTERNS: Array<{ re: RegExp; key: string }> = [
  { re: /\bcloudflare\b/i, key: "cloudflare" },
  { re: /\bwaf\b/i, key: "waf" },
  { re: /\bwordpress\b|\bwp[-_]?login\b/i, key: "wordpress" },
  { re: /\bdrupal\b/i, key: "drupal" },
  { re: /\bjoomla\b/i, key: "joomla" },
  { re: /\bnginx\b/i, key: "nginx" },
  { re: /\bapache\b/i, key: "apache" },
  { re: /\btomcat\b/i, key: "tomcat" },
  { re: /\bspring\b|\bspringboot\b/i, key: "spring" },
  { re: /\bdjango\b/i, key: "django" },
  { re: /\bflask\b/i, key: "flask" },
  { re: /\brails\b|\bruby\b/i, key: "rails" },
  { re: /\blaravel\b/i, key: "laravel" },
  { re: /\bexpress\b|\bnodejs\b/i, key: "nodejs" },
  { re: /\biis\b|\basp\.?net\b/i, key: "iis" },
  { re: /\bjenkins\b/i, key: "jenkins" },
  { re: /\bgitlab\b/i, key: "gitlab" },
  { re: /\bgrafana\b/i, key: "grafana" },
  { re: /\bkubernetes\b|\bk8s\b/i, key: "k8s" },
  { re: /\bdocker\b/i, key: "docker" },
  { re: /\bredis\b/i, key: "redis" },
  { re: /\bmysql\b|\bmariadb\b/i, key: "mysql" },
  { re: /\bpostgres\b/i, key: "postgres" },
  { re: /\bmongodb\b/i, key: "mongodb" },
  { re: /\bopenssl\b/i, key: "openssl" },
  { re: /\bopenssh\b/i, key: "openssh" },
  { re: /\bsamba\b|\bsmb\b/i, key: "smb" },
  { re: /\bactive\s*directory\b|\bkerberos\b/i, key: "ad" },
];

export type FamilyKeyHint = {
  key: string;
  via: "tag" | "stack" | "root" | "component";
  confidence: "high" | "medium" | "low";
};

/**
 * Suggest a family key for technique_transfer when the model omits one.
 * Prefer explicit tags → stack fingerprint → shared asset root.
 */
export function suggestFamilyKey(input: {
  title?: string;
  summary?: string;
  tags?: string[];
  /** Peer / source asset addresses involved. */
  addresses?: string[];
  /** Optional component name (CVE product, package). */
  component?: string;
}): FamilyKeyHint | null {
  const fromTag = parseFamilyKeyFromTags(input.tags ?? []);
  if (fromTag) {
    return { key: fromTag, via: "tag", confidence: "high" };
  }

  const component = (input.component ?? "").trim().toLowerCase();
  if (component) {
    const slug = component.replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
    if (slug) return { key: slug.slice(0, 48), via: "component", confidence: "high" };
  }

  const blob = `${input.title ?? ""}\n${input.summary ?? ""}`;
  for (const { re, key } of STACK_PATTERNS) {
    if (re.test(blob)) {
      return { key, via: "stack", confidence: "medium" };
    }
  }

  const roots = [
    ...new Set(
      (input.addresses ?? [])
        .map((a) => assetRootKey(a))
        .filter(Boolean),
    ),
  ];
  if (roots.length === 1) {
    return { key: `root:${roots[0]}`, via: "root", confidence: "low" };
  }
  if (roots.length > 1) {
    // Shared parent among roots (e.g. a.ex.com + b.ex.com → ex.com)
    const shared = sharedRootSuffix(roots);
    if (shared) return { key: `root:${shared}`, via: "root", confidence: "low" };
  }

  return null;
}

function sharedRootSuffix(roots: string[]): string | null {
  if (!roots.length) return null;
  // Prefer domain roots over CIDR.
  const domains = roots.filter((r) => !r.includes("/"));
  if (domains.length < 2) return domains[0] ?? null;
  const parts = domains.map((d) => d.split("."));
  const minLen = Math.min(...parts.map((p) => p.length));
  let i = 0;
  while (i < minLen) {
    const idx = parts[0]!.length - 1 - i;
    const label = parts[0]![idx];
    if (parts.every((p) => p[p.length - 1 - i] === label)) {
      i += 1;
    } else break;
  }
  if (i < 2) return null;
  return parts[0]!.slice(-i).join(".");
}

/** Normalize an optional model-supplied familyKey; empty → undefined. */
export function normalizeFamilyKey(raw: string | undefined | null): string | undefined {
  const s = (raw ?? "").trim().toLowerCase();
  if (!s) return undefined;
  return s.replace(/\s+/g, "-").slice(0, 64);
}

/** Host label used when suggesting peers that share a family root. */
export function addressLooksRelated(a: string, b: string): boolean {
  const ra = assetRootKey(a);
  const rb = assetRootKey(b);
  if (!ra || !rb) return false;
  if (ra === rb) return true;
  const ha = normalizeHost(a);
  const hb = normalizeHost(b);
  return Boolean(ha && hb && (ha.endsWith(`.${hb}`) || hb.endsWith(`.${ha}`)));
}

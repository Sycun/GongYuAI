export type SecretRefTarget =
  | { kind: "none" }
  | { kind: "http"; trafficId: string }
  | { kind: "file"; paths: string[] };

function stripCodeTicks(raw: string): string {
  return raw.trim().replace(/^`+|`+$/g, "").trim();
}

/**
 * Env-var pointer refs (e.g. `PASSWORD`, `API_TOKEN`, `env:GY_TOKEN`, `$ADMIN_PASS`)
 * never correspond to downloadable evidence files.
 */
export function isEnvVarRef(ref: string): boolean {
  const s = stripCodeTicks(ref);
  if (!s) return false;
  if (/^env:/i.test(s)) return true;
  if (/^\$[A-Z_][A-Z0-9_]*$/i.test(s)) return true;
  return /^[A-Z][A-Z0-9_]{2,}$/.test(s);
}

function cleanRelativeCandidate(raw: string): string | null {
  const normalized = raw
    .replace(/\\/g, "/")
    .replace(/^(\.\/)+/, "")
    .replace(/^\/+/, "")
    .trim();
  if (!normalized || normalized === "." || normalized.endsWith("/")) return null;
  const parts = normalized.split("/");
  if (parts.some((part) => !part || part === "." || part === "..")) return null;
  return normalized;
}

/**
 * Resolve a credential/session `secretRef` into ordered lookup candidates:
 * - `http:<trafficId>` → traffic blob lookup
 * - `evidence/foo/bar.txt` → `["foo/bar.txt", "evidence/foo/bar.txt"]`
 * - `workspace/evidence/foo.txt` → `["foo.txt", "evidence/foo.txt", "workspace/evidence/foo.txt"]`
 * - Optional `#L10` or `:12` line suffixes are also tried stripped as fallbacks.
 */
export function resolveSecretRefTarget(secretRef: string): SecretRefTarget {
  const cleaned = stripCodeTicks(secretRef);
  if (!cleaned || isEnvVarRef(cleaned)) return { kind: "none" };

  const httpMatch = /^http:([A-Za-z0-9_.:-]+)$/.exec(cleaned);
  if (httpMatch?.[1]) {
    return { kind: "http", trafficId: httpMatch[1] };
  }
  if (/^(oast|tool):/i.test(cleaned)) {
    return { kind: "none" };
  }

  const variants = [
    cleaned,
    cleaned.replace(/#L?\d+(?:-L?\d+)?$/i, ""),
    cleaned.replace(/:\d+(?::\d+)?$/, ""),
  ];

  const seen = new Set<string>();
  const add = (candidate: string) => {
    const valid = cleanRelativeCandidate(candidate);
    if (valid && !seen.has(valid)) seen.add(valid);
  };

  for (const variant of variants) {
    const base = cleanRelativeCandidate(variant);
    if (!base) continue;
    if (base.startsWith("workspace/evidence/")) {
      add(base.slice("workspace/evidence/".length));
      add(base.slice("workspace/".length));
      add(base);
    } else if (base.startsWith("evidence/")) {
      add(base.slice("evidence/".length));
      add(base);
    } else if (base.startsWith("workspace/")) {
      add(base.slice("workspace/".length));
      add(base);
    } else {
      add(base);
      add(`evidence/${base}`);
    }
  }

  return seen.size > 0 ? { kind: "file", paths: [...seen] } : { kind: "none" };
}

export function isMarkdownPath(path: string): boolean {
  return /\.(md|markdown)$/i.test(path.trim());
}

/**
 * Copy text to clipboard across both HTTPS/localhost (`navigator.clipboard`)
 * and plain HTTP LAN origins (e.g. `http://10.211.55.5:8877`) where `navigator.clipboard` is undefined.
 */
export async function copyTextWithFallback(text: string): Promise<void> {
  if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return;
    } catch {
      /* fall through to execCommand fallback */
    }
  }
  if (typeof document === "undefined") {
    throw new Error("当前环境不支持剪贴板复制");
  }
  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.left = "-9999px";
  textarea.style.top = "0";
  textarea.style.opacity = "0";
  document.body.appendChild(textarea);
  try {
    textarea.focus();
    textarea.select();
    textarea.setSelectionRange(0, text.length);
    const ok = document.execCommand("copy");
    if (!ok) throw new Error("浏览器拒绝写入剪贴板");
  } finally {
    document.body.removeChild(textarea);
  }
}

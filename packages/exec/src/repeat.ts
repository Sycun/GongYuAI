import { createHash } from "node:crypto";

/**
 * P15-C2 — repeated-command circuit breaker key.
 *
 * Normalization is deliberately conservative: trim, collapse runs of whitespace,
 * drop a trailing `;`. We do **not** lowercase or reorder arguments, because
 * payloads and paths are case-sensitive and different arguments are different
 * attempts. The hash is stable across worker restarts (stored by History).
 */
export function normalizeCommandForRepeat(command: string): string {
  return command.trim().replace(/\s+/g, " ").replace(/;+$/, "").trim();
}

export function commandRepeatHash(command: string): string {
  return createHash("sha256")
    .update(normalizeCommandForRepeat(command))
    .digest("hex");
}

/**
 * Read-only/polling commands may legitimately repeat. This is a narrow allowlist:
 * it covers liveness checks, not "retry the same exploit".
 */
export function isRepeatExemptCommand(command: string): boolean {
  const normalized = normalizeCommandForRepeat(command);
  if (!normalized) return true;
  const first = normalized.split(" ")[0] ?? "";
  if (
    [
      "sleep",
      "ps",
      "tail",
      "head",
      "ss",
      "netstat",
      "lsof",
      "date",
      "whoami",
      "id",
      "uname",
      "hostname",
      "pgrep",
      "pwd",
      "wc",
    ].includes(first)
  ) {
    return true;
  }
  // curl status probes that discard the body.
  if (
    first === "curl" &&
    /(?:-o\s+\/dev\/null|--output\s+\/dev\/null|-w\s+['"]?%\{http_code\})/.test(normalized)
  ) {
    return true;
  }
  return false;
}

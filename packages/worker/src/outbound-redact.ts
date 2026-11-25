import { createHash } from "node:crypto";

/**
 * Redact high-confidence secrets from text that is about to be sent to an
 * external model. This function only returns a new string. It does not read
 * or write `evidence/` — callers must keep the on-disk original untouched.
 *
 * Default is on. Set `GY_OUTBOUND_REDACT=0|false|off|no` to disable, or pass
 * `{ enabled: false }` for one call.
 */
export type OutboundRedactOptions = {
  enabled?: boolean;
};

const PEM = /-----BEGIN (?:RSA |EC |OPENSSH |ENCRYPTED )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH |ENCRYPTED )?PRIVATE KEY-----/g;
const BEARER = /Authorization:\s*Bearer\s+\S+/gi;
const AWS_KEY = /(?<![A-Z0-9])AKIA[0-9A-Z]{16}(?![A-Z0-9])/g;
const GITHUB = /(?<![A-Za-z0-9_])(?:ghp_[A-Za-z0-9]{36}|github_pat_[A-Za-z0-9_]{22,})(?![A-Za-z0-9_])/g;
const API_KEY = /(?<![A-Za-z0-9])sk-(?:proj-|ant-)?[A-Za-z0-9_\-]{20,}(?![A-Za-z0-9_\-])/g;

export function outboundRedactEnabled(options?: OutboundRedactOptions): boolean {
  if (typeof options?.enabled === "boolean") return options.enabled;
  const raw = process.env.GY_OUTBOUND_REDACT?.trim().toLowerCase();
  if (!raw) return true;
  if (raw === "0" || raw === "false" || raw === "off" || raw === "no" || raw === "disabled") return false;
  return true;
}

function placeholder(type: string, secret: string): string {
  const digest = createHash("sha256").update(secret).digest("hex").slice(0, 6);
  return `[REDACTED:${type}#${digest}]`;
}

function replaceMatches(input: string, pattern: RegExp, type: string): string {
  pattern.lastIndex = 0;
  return input.replace(pattern, (match) => placeholder(type, match));
}

/** Deterministic replacement. The same secret always maps to the same placeholder. */
export function redactOutboundText(input: string, options?: OutboundRedactOptions): string {
  if (!outboundRedactEnabled(options) || !input) return input;
  let text = input;
  text = replaceMatches(text, PEM, "PEM");
  text = replaceMatches(text, BEARER, "BEARER");
  text = replaceMatches(text, AWS_KEY, "AWS");
  text = replaceMatches(text, GITHUB, "GITHUB");
  text = replaceMatches(text, API_KEY, "API_KEY");
  return text;
}

type ChatLike = {
  role?: string;
  content?: unknown;
};

/** Copy of a chat payload with tool-result text redacted. The input array is not mutated. */
export function redactOutboundChatMessages<T extends ChatLike>(
  messages: readonly T[],
  options?: OutboundRedactOptions,
): T[] {
  if (!outboundRedactEnabled(options)) return messages.slice();
  return messages.map((message) => {
    if (message.role !== "tool" || typeof message.content !== "string") return message;
    const content = redactOutboundText(message.content, { enabled: true });
    if (content === message.content) return message;
    return { ...message, content };
  });
}

/** Redact model-facing tool text. `details` and every other field stay as the tool returned them. */
export function redactModelToolResult<T>(result: T, options?: OutboundRedactOptions): T {
  if (!outboundRedactEnabled(options) || !result || typeof result !== "object") return result;
  const record = result as { output?: unknown };
  if (!Array.isArray(record.output)) return result;
  let changed = false;
  const output = record.output.map((part) => {
    if (!part || typeof part !== "object") return part;
    const item = part as { type?: unknown; text?: unknown };
    if (item.type !== "text" || typeof item.text !== "string") return part;
    const text = redactOutboundText(item.text, { enabled: true });
    if (text === item.text) return part;
    changed = true;
    return { ...item, text };
  });
  if (!changed) return result;
  return { ...(result as object), output } as T;
}

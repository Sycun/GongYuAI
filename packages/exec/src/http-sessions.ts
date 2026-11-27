import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Task-level named HTTP sessions.
 *
 * Legacy `http-sessions.json` is `session -> host -> cookieName -> cookieValue`.
 * A host that also carries custom headers is stored as `{ cookies, headers }`.
 * Loaders accept both shapes so older jars keep working.
 */
export type HttpSessionCookies = Record<string, string>;
export type HttpSessionHeaders = Record<string, string>;

export type HttpSessionHostState = {
  cookies: HttpSessionCookies;
  headers: HttpSessionHeaders;
};

/** session name -> host -> cookies and headers */
export type HttpSessionStore = Record<string, Record<string, HttpSessionHostState>>;

export type HttpSessionSummary = {
  name: string;
  host: string;
  cookieKeys: string[];
  headerKeys: string[];
};

export type HttpSessionUpsert = {
  name: string;
  host: string;
  cookies?: Record<string, unknown>;
  headers?: Record<string, unknown>;
  /** Raw `Cookie` request-header value, e.g. `sid=abc; csrf=xyz`. */
  cookie?: string;
};

const HEADER_NAME = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

export function httpSessionStorePath(dataDir: string): string {
  return join(dataDir, "http-sessions.json");
}

function assertHeaderValue(label: string, value: string): void {
  if (/[\r\n\u0000]/.test(value)) {
    throw new Error(`${label} contains CR/LF/NUL`);
  }
}

function stringMap(input: Record<string, unknown> | undefined, label: string): Record<string, string> {
  if (!input) return {};
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(input)) {
    const name = key.trim();
    if (!name) throw new Error(`${label} name required`);
    if (typeof value !== "string") throw new Error(`${label} ${name} must be a string`);
    assertHeaderValue(label, name);
    assertHeaderValue(label, value);
    out[name] = value;
  }
  return out;
}

function asStringRecord(value: unknown): Record<string, string> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const out: Record<string, string> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (typeof item !== "string") return null;
    out[key] = item;
  }
  return out;
}

function parseHostValue(value: unknown): HttpSessionHostState {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { cookies: {}, headers: {} };
  }
  const obj = value as Record<string, unknown>;
  const cookiesIsObject = !!obj.cookies && typeof obj.cookies === "object" && !Array.isArray(obj.cookies);
  const headersIsObject = !!obj.headers && typeof obj.headers === "object" && !Array.isArray(obj.headers);
  const extra = Object.keys(obj).filter((key) => key !== "cookies" && key !== "headers");
  if ((cookiesIsObject || headersIsObject) && extra.length === 0) {
    return {
      cookies: asStringRecord(obj.cookies) ?? {},
      headers: asStringRecord(obj.headers) ?? {},
    };
  }
  return { cookies: asStringRecord(obj) ?? {}, headers: {} };
}

export function normalizeSessionHost(raw: string): string {
  const value = raw.trim();
  if (!value) throw new Error("host required");
  if (/[\r\n\u0000\s]/.test(value)) throw new Error("invalid host");
  if (value.includes("://")) {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      throw new Error("invalid host");
    }
    const hostname = url.hostname.toLowerCase();
    if (!hostname) throw new Error("invalid host");
    return hostname;
  }
  if (/[/\\]/.test(value) || value.includes("..")) throw new Error("invalid host");
  const host = value.replace(/:\d+$/, "").replace(/\.$/, "").toLowerCase();
  if (!host) throw new Error("invalid host");
  return host;
}

export function normalizeSessionName(raw: string): string {
  const name = raw.trim();
  if (!name || name.length > 128) throw new Error("session name required");
  if (/[\r\n\u0000/\\]/.test(name) || name === "." || name === "..") throw new Error("invalid session name");
  return name;
}

/** Parse a Cookie header. Later pairs with the same name win. */
export function parseCookieHeader(raw: string): HttpSessionCookies {
  assertHeaderValue("cookie", raw);
  const cookies: HttpSessionCookies = {};
  for (const part of raw.split(";")) {
    const piece = part.trim();
    if (!piece) continue;
    const eq = piece.indexOf("=");
    if (eq <= 0) continue;
    const name = piece.slice(0, eq).trim();
    const value = piece.slice(eq + 1).trim();
    if (!name) continue;
    assertHeaderValue("cookie", name);
    assertHeaderValue("cookie", value);
    cookies[name] = value;
  }
  return cookies;
}

export function loadHttpSessions(dataDir: string): HttpSessionStore {
  const path = httpSessionStorePath(dataDir);
  if (!existsSync(path)) return {};
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const store: HttpSessionStore = {};
    for (const [name, hosts] of Object.entries(parsed as Record<string, unknown>)) {
      if (!hosts || typeof hosts !== "object" || Array.isArray(hosts)) continue;
      const bucket: Record<string, HttpSessionHostState> = {};
      for (const [host, value] of Object.entries(hosts as Record<string, unknown>)) {
        const key = host.trim().toLowerCase().replace(/\.$/, "");
        if (!key) continue;
        const parsedHost = parseHostValue(value);
        const prev = bucket[key];
        bucket[key] = prev
          ? {
              cookies: { ...prev.cookies, ...parsedHost.cookies },
              headers: { ...prev.headers, ...parsedHost.headers },
            }
          : parsedHost;
      }
      store[name] = bucket;
    }
    return store;
  } catch {
    return {};
  }
}

function serializeStore(store: HttpSessionStore): Record<string, Record<string, unknown>> {
  const out: Record<string, Record<string, unknown>> = {};
  for (const name of Object.keys(store).sort()) {
    const hosts = store[name] ?? {};
    const bucket: Record<string, unknown> = {};
    for (const host of Object.keys(hosts).sort()) {
      const state = hosts[host] ?? { cookies: {}, headers: {} };
      bucket[host] = Object.keys(state.headers).length === 0
        ? state.cookies
        : { cookies: state.cookies, headers: state.headers };
    }
    out[name] = bucket;
  }
  return out;
}

export function saveHttpSessions(dataDir: string, store: HttpSessionStore): void {
  const path = httpSessionStorePath(dataDir);
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(serializeStore(store), null, 2), { mode: 0o600 });
  renameSync(tmp, path);
}

export function upsertHttpSession(dataDir: string, input: HttpSessionUpsert): HttpSessionHostState & {
  name: string;
  host: string;
} {
  const name = normalizeSessionName(input.name);
  const host = normalizeSessionHost(input.host);
  const store = loadHttpSessions(dataDir);
  const hosts = store[name] ?? {};
  const current = hosts[host] ?? { cookies: {}, headers: {} };
  const fromHeader = input.cookie !== undefined && input.cookie !== null
    ? parseCookieHeader(String(input.cookie))
    : {};
  const cookies = {
    ...current.cookies,
    ...fromHeader,
    ...stringMap(input.cookies, "cookie"),
  };
  const headers = {
    ...current.headers,
    ...stringMap(input.headers, "header"),
  };
  for (const headerName of Object.keys(headers)) {
    if (!HEADER_NAME.test(headerName)) throw new Error(`invalid header name: ${headerName}`);
  }
  hosts[host] = { cookies, headers };
  store[name] = hosts;
  saveHttpSessions(dataDir, store);
  return { name, host, cookies, headers };
}

export function listHttpSessionSummaries(dataDir: string): HttpSessionSummary[] {
  const store = loadHttpSessions(dataDir);
  const out: HttpSessionSummary[] = [];
  for (const name of Object.keys(store).sort()) {
    const hosts = store[name] ?? {};
    for (const host of Object.keys(hosts).sort()) {
      const state = hosts[host] ?? { cookies: {}, headers: {} };
      out.push({
        name,
        host,
        cookieKeys: Object.keys(state.cookies).sort(),
        headerKeys: Object.keys(state.headers).sort(),
      });
    }
  }
  return out;
}

export function deleteHttpSession(dataDir: string, name: string): boolean {
  const key = normalizeSessionName(name);
  const store = loadHttpSessions(dataDir);
  if (!Object.prototype.hasOwnProperty.call(store, key)) return false;
  delete store[key];
  saveHttpSessions(dataDir, store);
  return true;
}

function headerKey(headers: Record<string, string>, name: string): string | undefined {
  const target = name.toLowerCase();
  return Object.keys(headers).find((key) => key.toLowerCase() === target);
}

/** Stored headers fill gaps. An explicit header of the same name wins, case-insensitively. */
export function mergeStoredHeaders(
  headers: Record<string, string>,
  stored: HttpSessionHeaders | undefined,
): Record<string, string> {
  if (!stored || Object.keys(stored).length === 0) return { ...headers };
  const out = { ...headers };
  for (const [name, value] of Object.entries(stored)) {
    if (headerKey(out, name)) continue;
    out[name] = value;
  }
  return out;
}

/** Jar cookies fill names the caller did not already set on the Cookie header. */
export function mergeCookiesForHost(
  headers: Record<string, string>,
  jarForHost: HttpSessionCookies | undefined,
): Record<string, string> {
  if (!jarForHost || Object.keys(jarForHost).length === 0) return { ...headers };
  const out = { ...headers };
  const existingKey = headerKey(out, "cookie");
  if (!existingKey) {
    out.Cookie = Object.entries(jarForHost).map(([key, value]) => `${key}=${value}`).join("; ");
    return out;
  }
  const existing = out[existingKey] ?? "";
  const explicitNames = new Set(
    existing
      .split(";")
      .map((part) => part.trim().split("=")[0]?.trim())
      .filter((name): name is string => Boolean(name)),
  );
  const merged = [
    existing.trim(),
    ...Object.entries(jarForHost)
      .filter(([key]) => !explicitNames.has(key))
      .map(([key, value]) => `${key}=${value}`),
  ].filter(Boolean);
  out[existingKey] = merged.join("; ");
  return out;
}

/** Apply one host's stored headers, then its cookie jar. Other hosts are ignored by the caller. */
export function applySessionToHeaders(
  headers: Record<string, string>,
  state: HttpSessionHostState | undefined,
): Record<string, string> {
  return mergeCookiesForHost(mergeStoredHeaders(headers, state?.headers), state?.cookies);
}

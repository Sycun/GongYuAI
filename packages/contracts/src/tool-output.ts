/**
 * P14 — machine-readable pentest tool output parsers.
 *
 * These parsers only transport facts (host / port / status / template result)
 * into the asset and tentative-finding shapes. They never upgrade a finding's
 * conclusion and never throw: unparseable input degrades to
 * `{ assets: [], findings: [], skipped: true, reason }`.
 *
 * The caller keeps the raw tool output as evidence; this module has no I/O.
 */

export type ParsedAssetKind = "domain" | "ip" | "service" | "endpoint";

export type ParsedAsset = {
  /** Canonical primary key: host for ip/domain/service, full URL for endpoint. */
  address: string;
  kind: ParsedAssetKind;
  /** Host parent for service/endpoint; host IP for domain. */
  parent?: string;
  attrs: {
    port?: number;
    protocol?: string;
    status?: number;
    tech?: string[];
    title?: string;
  };
};

export type ParsedFinding = {
  title: string;
  /** Canonical host. */
  asset: string;
  /** `nuclei:<template-id>` / `ffuf:exposed-path`. */
  vulnClass: string;
  severity: "info" | "low" | "medium" | "high" | "critical";
  /** Full URL of the match, when the tool reported one. */
  endpoint?: string;
  note?: string;
};

export type ParsedToolOutput = {
  assets: ParsedAsset[];
  findings: ParsedFinding[];
  skipped: boolean;
  reason?: string;
};

export type SupportedTool = "nmap" | "httpx" | "nuclei" | "ffuf";

const NMAP_MAX_ASSETS = 2000;
const SEVERITIES = ["info", "low", "medium", "high", "critical"] as const;

const ASSET_KIND_ORDER: Record<ParsedAssetKind, number> = {
  domain: 0,
  ip: 1,
  service: 2,
  endpoint: 3,
};

const XML_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
};

/** Format-level failure: handled by `parseToolOutput`, never escapes. */
class ParseFailure extends Error {}

/**
 * Parse one supported tool's machine-readable output.
 *
 * Contract:
 * - empty / whitespace-only input → skipped
 * - malformed JSON / XML or a malformed JSONL line → skipped (whole output)
 * - a JSON object with an unusable URL is dropped; if none remain → skipped
 * - any unexpected exception → skipped
 */
export function parseToolOutput(tool: SupportedTool, text: string): ParsedToolOutput {
  try {
    if (typeof text !== "string") return skipped("input is not text");
    if (text.trim() === "") return skipped("empty input");

    switch (tool) {
      case "nmap":
        return parseNmap(text);
      case "httpx":
        return parseHttpx(text);
      case "nuclei":
        return parseNuclei(text);
      case "ffuf":
        return parseFfuf(text);
      default:
        return skipped(`unsupported tool: ${String(tool)}`);
    }
  } catch (error) {
    return skipped(errorReason(error));
  }
}

function skipped(reason: string): ParsedToolOutput {
  return { assets: [], findings: [], skipped: true, reason };
}

/**
 * Successful parse. `reason` is only set when some records were non-fatally
 * ignored, so callers can surface a degraded parse instead of silently
 * presenting partial data as complete.
 */
function success(
  assets: ParsedAsset[],
  findings: ParsedFinding[],
  reason?: string,
): ParsedToolOutput {
  const output: ParsedToolOutput = {
    assets: dedupeAssets(assets),
    findings: dedupeFindings(findings),
    skipped: false,
  };
  if (reason) output.reason = reason;
  return output;
}

function errorReason(error: unknown): string {
  if (error instanceof Error) {
    const message = error.message.trim();
    if (message) return message.slice(0, 300);
  }
  return "parse failure";
}

// ---------------------------------------------------------------------------
// nmap -oX
// ---------------------------------------------------------------------------

type NmapXml = {
  host: string | null;
  hostnames: string[];
  ports: Array<{ port: number; service: string | null }>;
  /** Number of `<port ...>` tags seen, for malformed-XML detection. */
  portTags: number;
};

function parseNmap(text: string): ParsedToolOutput {
  // Comments can contain tag-like text; they are not scan facts.
  const xml = text.replace(/<!--[\s\S]*?-->/g, "");

  if (!/<nmaprun\b/i.test(xml)) {
    throw new ParseFailure("nmap: missing <nmaprun> element");
  }
  if (!/<\/nmaprun\s*>/i.test(xml)) {
    throw new ParseFailure("nmap: missing </nmaprun>");
  }

  const assets: ParsedAsset[] = [];
  const hostRe = /<host\b[^>]*>([\s\S]*?)<\/host\s*>/gi;
  let hostMatches = 0;
  let portMatches = 0;
  let capReached = false;
  let hostMatch: RegExpExecArray | null;

  while ((hostMatch = hostRe.exec(xml)) !== null) {
    hostMatches += 1;
    const parsed = parseNmapHost(hostMatch[1] ?? "");
    portMatches += parsed.portTags;
    if (!parsed.host) continue;

    // Ports are the substantive nmap result, so they consume the cap first.
    for (const openPort of parsed.ports) {
      const attrs: ParsedAsset["attrs"] = { port: openPort.port };
      if (openPort.service) attrs.protocol = openPort.service;
      const asset: ParsedAsset = {
        address: parsed.host,
        kind: "service",
        parent: parsed.host,
        attrs,
      };
      if (!pushNmapAsset(assets, asset)) {
        capReached = true;
        break;
      }
    }
    if (capReached) break;

    for (const hostname of parsed.hostnames) {
      const asset: ParsedAsset = {
        address: hostname,
        kind: "domain",
        parent: parsed.host,
        attrs: {},
      };
      if (!pushNmapAsset(assets, asset)) {
        capReached = true;
        break;
      }
    }
    if (capReached) break;
  }

  // When the cap stopped the walk early we intentionally did not inspect the
  // rest of the document, so structural counts only guard complete walks.
  if (!capReached) {
    if (countTagStarts(xml, "host") > hostMatches) {
      throw new ParseFailure("nmap: unclosed <host> block");
    }
    if (countTagStarts(xml, "port") > portMatches) {
      throw new ParseFailure("nmap: unclosed <port> block");
    }
  }

  return success(assets, []);
}

function parseNmapHost(block: string): NmapXml {
  const result: NmapXml = {
    host: null,
    hostnames: [],
    ports: [],
    portTags: 0,
  };

  // The host address is the parent for both services and names.
  const addresses: Array<Record<string, string>> = [];
  const addressRe = /<address\b([^>]*?)\/?>/gi;
  let addressMatch: RegExpExecArray | null;
  while ((addressMatch = addressRe.exec(block)) !== null) {
    addresses.push(parseXmlAttrs(addressMatch[1] ?? ""));
  }

  // IPv4 first, then IPv6, then a non-MAC fallback.
  for (const type of ["ipv4", "ipv6"]) {
    for (const addr of addresses) {
      if (readString(addr.addrtype).toLowerCase() !== type) continue;
      const host = normalizeHostLike(addr.addr);
      if (host) {
        result.host = host;
        break;
      }
    }
    if (result.host) break;
  }
  if (!result.host) {
    for (const addr of addresses) {
      if (readString(addr.addrtype).toLowerCase() === "mac") continue;
      const host = normalizeHostLike(addr.addr);
      if (host) {
        result.host = host;
        break;
      }
    }
  }

  const hostnameRe = /<hostname\b([^>]*?)\/?>/gi;
  let hostnameMatch: RegExpExecArray | null;
  while ((hostnameMatch = hostnameRe.exec(block)) !== null) {
    const attrs = parseXmlAttrs(hostnameMatch[1] ?? "");
    const hostname = normalizeHostLike(attrs.name);
    if (hostname) result.hostnames.push(hostname);
  }

  const portRe = /<port\b([^>]*?)(?:\/>|>([\s\S]*?)<\/port\s*>)/gi;
  let portMatch: RegExpExecArray | null;
  while ((portMatch = portRe.exec(block)) !== null) {
    result.portTags += 1;
    const portAttrs = parseXmlAttrs(portMatch[1] ?? "");
    const port = readPort(portAttrs.portid);
    if (port === null) continue;

    const inner = portMatch[2] ?? "";
    const stateMatch = /<state\b([^>]*?)\/?>/i.exec(inner);
    if (!stateMatch) continue;
    const state = readString(parseXmlAttrs(stateMatch[1] ?? "").state).toLowerCase();
    if (state !== "open") continue;

    const serviceMatch = /<service\b([^>]*?)\/?>/i.exec(inner);
    const serviceAttrs = serviceMatch ? parseXmlAttrs(serviceMatch[1] ?? "") : {};
    const service = readString(serviceAttrs.name);

    result.ports.push({
      port,
      service: service || null,
    });
  }

  return result;
}

function pushNmapAsset(assets: ParsedAsset[], asset: ParsedAsset): boolean {
  if (assets.length >= NMAP_MAX_ASSETS) return false;
  assets.push(asset);
  return true;
}

function countTagStarts(xml: string, tag: string): number {
  const re = new RegExp(`<${tag}\\b`, "gi");
  return (xml.match(re) ?? []).length;
}

function parseXmlAttrs(raw: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const re = /([A-Za-z_:][A-Za-z0-9_.:-]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(raw)) !== null) {
    const name = match[1];
    if (!name) continue;
    const value = match[2] ?? match[3] ?? match[4] ?? "";
    attrs[name.toLowerCase()] = decodeXmlEntities(value);
  }
  return attrs;
}

function decodeXmlEntities(value: string): string {
  return value.replace(
    /&(amp|lt|gt|quot|apos);/g,
    (whole: string, name: string) => XML_ENTITIES[name] ?? whole,
  );
}

// ---------------------------------------------------------------------------
// httpx -json (JSON Lines)
// ---------------------------------------------------------------------------

function parseHttpx(text: string): ParsedToolOutput {
  const records = jsonRecords(text, "httpx");
  const assets: ParsedAsset[] = [];
  let dropped = 0;

  for (const row of records) {
    const endpoint = normalizeUrl(row.url);
    if (!endpoint) {
      dropped += 1;
      continue;
    }

    const urlHost = hostFromUrl(endpoint);
    const parent = normalizeHostLike(row.host) ?? urlHost;
    if (!urlHost || !parent) {
      dropped += 1;
      continue;
    }

    const attrs: ParsedAsset["attrs"] = {};
    const status = readInteger(row.status_code);
    if (status !== null) attrs.status = status;

    const tech = readStringArray(row.tech);
    if (tech && tech.length > 0) attrs.tech = tech;

    const title = readString(row.title);
    if (title) attrs.title = title;

    assets.push({
      address: endpoint,
      kind: "endpoint",
      parent,
      attrs,
    });
  }

  if (assets.length === 0) {
    throw new ParseFailure(`httpx: no valid records (${dropped} ignored)`);
  }

  return success(
    assets,
    [],
    dropped > 0 ? `ignored ${dropped} invalid record(s)` : undefined,
  );
}

// ---------------------------------------------------------------------------
// nuclei -jsonl
// ---------------------------------------------------------------------------

function parseNuclei(text: string): ParsedToolOutput {
  const records = jsonRecords(text, "nuclei");
  const findings: ParsedFinding[] = [];
  let dropped = 0;

  for (const row of records) {
    const templateId = readString(row["template-id"]);
    if (!templateId) {
      dropped += 1;
      continue;
    }

    const info: Record<string, unknown> = isRecord(row.info) ? row.info : {};
    const matchedUrl = normalizeUrl(row["matched-at"]);
    const host =
      normalizeHostLike(row.host) ?? (matchedUrl ? hostFromUrl(matchedUrl) : null);
    if (!host) {
      dropped += 1;
      continue;
    }

    const finding: ParsedFinding = {
      title: readString(info.name) || templateId,
      asset: host,
      vulnClass: `nuclei:${templateId}`,
      severity: normalizeSeverity(info.severity),
    };
    if (matchedUrl) finding.endpoint = matchedUrl;

    findings.push(finding);
  }

  if (findings.length === 0) {
    throw new ParseFailure(`nuclei: no valid records (${dropped} ignored)`);
  }

  return success(
    [],
    findings,
    dropped > 0 ? `ignored ${dropped} invalid record(s)` : undefined,
  );
}

function normalizeSeverity(value: unknown): ParsedFinding["severity"] {
  const raw = readString(value).toLowerCase();
  for (const severity of SEVERITIES) {
    if (severity === raw) return severity;
  }
  return "info";
}

// ---------------------------------------------------------------------------
// ffuf -of json
// ---------------------------------------------------------------------------

function parseFfuf(text: string): ParsedToolOutput {
  let root: unknown;
  try {
    root = JSON.parse(text.replace(/^\uFEFF/, "").trim());
  } catch {
    throw new ParseFailure("ffuf: invalid JSON");
  }

  if (!isRecord(root)) {
    throw new ParseFailure("ffuf: expected a JSON object");
  }
  const results = root.results;
  if (!Array.isArray(results)) {
    throw new ParseFailure("ffuf: missing results[]");
  }

  const assets: ParsedAsset[] = [];
  const findings: ParsedFinding[] = [];
  let validRecords = 0;
  let dropped = 0;

  for (const item of results) {
    if (!isRecord(item)) {
      dropped += 1;
      continue;
    }

    const endpoint = normalizeUrl(item.url);
    const status = readInteger(item.status);
    if (!endpoint || status === null) {
      dropped += 1;
      continue;
    }
    validRecords += 1;

    // 404 is the negative wordlist answer, not an exposed path.
    if (status === 404) continue;

    const host = hostFromUrl(endpoint);
    if (!host) {
      validRecords -= 1;
      dropped += 1;
      continue;
    }

    assets.push({
      address: endpoint,
      kind: "endpoint",
      parent: host,
      attrs: { status },
    });

    const noteParts = [`status=${status}`];
    for (const field of ["length", "words", "lines"] as const) {
      const value = readInteger(item[field]);
      if (value !== null) noteParts.push(`${field}=${value}`);
    }

    findings.push({
      title: `Exposed path: ${urlPath(endpoint)}`,
      asset: host,
      vulnClass: "ffuf:exposed-path",
      severity: "info",
      endpoint,
      note: noteParts.join(" "),
    });
  }

  // A valid empty results[] is a successful scan with no hits. Results that
  // exist but cannot be read are a format failure.
  if (results.length > 0 && validRecords === 0) {
    throw new ParseFailure(`ffuf: no valid results (${dropped} ignored)`);
  }

  return success(
    assets,
    findings,
    dropped > 0 ? `ignored ${dropped} invalid result(s)` : undefined,
  );
}

function urlPath(endpoint: string): string {
  try {
    const url = new URL(endpoint);
    return `${url.pathname}${url.search}`;
  } catch {
    return endpoint;
  }
}

// ---------------------------------------------------------------------------
// Shared normalization / validation
// ---------------------------------------------------------------------------

/**
 * Validate an http(s) URL and canonicalize it. Fragments are dropped, query
 * parameter names *and* values are preserved, and default ports are removed by
 * the WHATWG URL serializer. Invalid URLs return null (the caller drops the
 * record) instead of throwing.
 */
function normalizeUrl(value: unknown): string | null {
  const raw = readString(value);
  if (!raw) return null;

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  if (!url.hostname) return null;

  url.hash = "";
  return url.toString();
}

/** Lowercase host, strip a numeric port, brackets, and a trailing dot. */
function normalizeHostLike(value: unknown): string | null {
  const raw = readString(value);
  if (!raw) return null;

  // Absolute URL: let WHATWG URL extract the hostname.
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) {
    const url = normalizeUrl(raw);
    return url ? hostFromUrl(url) : null;
  }

  // A bare host cannot contain these; reject rather than guess a hostname.
  if (/[\s/?#]/.test(raw)) return null;

  const bracketed = /^\[([^\]]+)\](?::(\d+))?$/.exec(raw);
  if (bracketed) return cleanHost(bracketed[1] ?? "");
  if (raw.startsWith("[")) return null;

  const colonCount = raw.split(":").length - 1;
  if (colonCount > 1) {
    // Bare IPv6 literal; never strip its final segment as a "port".
    return cleanHost(raw);
  }
  if (colonCount === 1) {
    const index = raw.lastIndexOf(":");
    const portPart = raw.slice(index + 1);
    if (!/^\d+$/.test(portPart)) return null;
    return cleanHost(raw.slice(0, index));
  }

  return cleanHost(raw);
}

function hostFromUrl(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  return cleanHost(parsed.hostname);
}

function cleanHost(value: string): string | null {
  let host = value.trim().toLowerCase();
  if (!host) return null;
  if (host.startsWith("[") && host.endsWith("]")) host = host.slice(1, -1);
  if (host.endsWith(".")) host = host.slice(0, -1);
  return host || null;
}

function readPort(value: unknown): number | null {
  const raw = readString(value);
  if (!/^\d+$/.test(raw)) return null;
  const port = Number(raw);
  return Number.isInteger(port) && port >= 0 && port <= 65535 ? port : null;
}

function readInteger(value: unknown): number | null {
  const number = readNumber(value);
  return number !== null && Number.isInteger(number) ? number : null;
}

function readNumber(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string" && value.trim() !== "") {
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
  }
  return null;
}

function readString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function readStringArray(value: unknown): string[] | null {
  if (typeof value === "string") {
    const single = value.trim();
    return single ? [single] : [];
  }
  if (!Array.isArray(value)) return null;

  const values: string[] = [];
  for (const item of value) {
    const text = readString(item);
    if (text) values.push(text);
  }
  return values;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function jsonRecords(text: string, tool: string): Array<Record<string, unknown>> {
  const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/);
  const records: Array<Record<string, unknown>> = [];

  for (let index = 0; index < lines.length; index += 1) {
    const line = (lines[index] ?? "").trim();
    if (!line) continue;

    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      throw new ParseFailure(`${tool}: line ${index + 1} is not valid JSON`);
    }
    if (!isRecord(value)) {
      throw new ParseFailure(`${tool}: line ${index + 1} is not a JSON object`);
    }
    records.push(value);
  }

  if (records.length === 0) throw new ParseFailure(`${tool}: no JSON records`);
  return records;
}

// ---------------------------------------------------------------------------
// Dedupe / stable ordering
// ---------------------------------------------------------------------------

/**
 * Service identity is host + port + service name. Using address+kind alone
 * would collapse every open port on a host into one asset and lose ports, which
 * conflicts with nmap's "one service asset per open port" contract. Other
 * kinds use the requested address+kind key.
 */
function assetKey(asset: ParsedAsset): string {
  if (asset.kind === "service") {
    return [
      asset.address,
      asset.kind,
      String(asset.attrs.port ?? ""),
      asset.attrs.protocol ?? "",
    ].join("\u0000");
  }
  return `${asset.address}\u0000${asset.kind}`;
}

function findingKey(finding: ParsedFinding): string {
  return [
    finding.asset,
    finding.vulnClass,
    finding.endpoint ?? "",
  ].join("\u0000");
}

function dedupeAssets(assets: ParsedAsset[]): ParsedAsset[] {
  const seen = new Set<string>();
  const unique: ParsedAsset[] = [];
  for (const asset of assets) {
    const key = assetKey(asset);
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(asset);
  }
  unique.sort(compareAssets);
  return unique;
}

function dedupeFindings(findings: ParsedFinding[]): ParsedFinding[] {
  const seen = new Set<string>();
  const unique: ParsedFinding[] = [];
  for (const finding of findings) {
    const key = findingKey(finding);
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(finding);
  }
  unique.sort(compareFindings);
  return unique;
}

function compareAssets(a: ParsedAsset, b: ParsedAsset): number {
  let order = compareText(a.address, b.address);
  if (order !== 0) return order;

  order = ASSET_KIND_ORDER[a.kind] - ASSET_KIND_ORDER[b.kind];
  if (order !== 0) return order;

  order = (a.attrs.port ?? -1) - (b.attrs.port ?? -1);
  if (order !== 0) return order;

  return compareText(a.attrs.protocol ?? "", b.attrs.protocol ?? "");
}

function compareFindings(a: ParsedFinding, b: ParsedFinding): number {
  let order = compareText(a.asset, b.asset);
  if (order !== 0) return order;

  order = compareText(a.vulnClass, b.vulnClass);
  if (order !== 0) return order;

  order = compareText(a.endpoint ?? "", b.endpoint ?? "");
  if (order !== 0) return order;

  order = compareText(a.title, b.title);
  if (order !== 0) return order;

  return compareText(a.note ?? "", b.note ?? "");
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

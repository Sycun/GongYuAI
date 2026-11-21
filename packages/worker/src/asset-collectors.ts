/**
 * Passive asset discovery via FOFA / 鹰图(Hunter) / custom HTTP collectors.
 * Results are written through History.recordAsset (same inventory as console).
 */
import {
  isBudgetHit,
  type WorkerAssetCollector,
  type WorkerManifest,
} from "@gongyuai/contracts";
import { writeEvidence, type ToolContext } from "./tools.js";

export type AssetSearchHit = {
  address: string;
  summary: string;
};

export type AssetSearchResult = {
  collectorId: string;
  collectorName: string;
  query: string;
  totalHint: number | null;
  recorded: Array<{ address: string; kind: string }>;
  skipped: number;
  evidencePath: string | null;
  error?: string;
};

function b64(s: string): string {
  return Buffer.from(s, "utf8").toString("base64");
}

function dig(obj: unknown, path: string): unknown {
  if (!path) return obj;
  let cur: unknown = obj;
  for (const part of path.split(".").filter(Boolean)) {
    if (cur == null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

function asRows(raw: unknown): unknown[] {
  if (Array.isArray(raw)) return raw;
  if (raw && typeof raw === "object") return [raw];
  return [];
}

function pickAddress(
  row: unknown,
  fields: string[],
): { address: string; summary: string } | null {
  if (typeof row === "string") {
    const a = row.trim();
    return a ? { address: a, summary: "" } : null;
  }
  if (Array.isArray(row)) {
    // FOFA fields mode often returns [host, ip, port, protocol, title, ...]
    for (const cell of row) {
      if (typeof cell === "string" && /[.:]/.test(cell) && cell.length > 3) {
        return {
          address: cell.includes("://") ? cell : cell,
          summary: row.filter((x) => typeof x === "string").join(" | ").slice(0, 240),
        };
      }
    }
    return null;
  }
  if (!row || typeof row !== "object") return null;
  const o = row as Record<string, unknown>;
  for (const f of fields) {
    const v = o[f];
    if (typeof v === "string" && v.trim()) {
      let address = v.trim();
      if (f === "ip" && typeof o.port === "number") {
        address = `${address}:${o.port}`;
      } else if (f === "ip" && typeof o.port === "string" && o.port) {
        address = `${address}:${o.port}`;
      }
      const bits = fields
        .map((k) => (typeof o[k] === "string" || typeof o[k] === "number" ? `${k}=${o[k]}` : ""))
        .filter(Boolean);
      return { address, summary: bits.join(" · ").slice(0, 240) };
    }
  }
  return null;
}

function resolveSecrets(c: WorkerAssetCollector): { email: string; apiKey: string } {
  const email = c.emailEnv ? (process.env[c.emailEnv] ?? "") : "";
  const apiKey = process.env[c.apiKeyEnv] ?? "";
  return { email, apiKey };
}

async function fetchJson(
  url: string,
  init: RequestInit,
): Promise<{ ok: boolean; status: number; json: unknown; text: string }> {
  const res = await fetch(url, {
    ...init,
    headers: {
      "user-agent": "GongYuAI/0.1",
      accept: "application/json",
      ...(init.headers ?? {}),
    },
  });
  const text = await res.text();
  let json: unknown = null;
  try {
    json = JSON.parse(text) as unknown;
  } catch {
    json = null;
  }
  return { ok: res.ok, status: res.status, json, text };
}

async function searchFofa(
  c: WorkerAssetCollector,
  query: string,
  size: number,
): Promise<{ hits: AssetSearchHit[]; totalHint: number | null; raw: unknown }> {
  const { email, apiKey } = resolveSecrets(c);
  if (!email || !apiKey) throw new Error("FOFA 未配置 email/apiKey（设置 → 资产收集）");
  const base = (c.baseUrl || "https://fofa.info/api/v1/search/all").replace(/\/$/, "");
  const u = new URL(base);
  u.searchParams.set("email", email);
  u.searchParams.set("key", apiKey);
  u.searchParams.set("qbase64", b64(query));
  u.searchParams.set("size", String(Math.min(Math.max(size, 1), 100)));
  u.searchParams.set("fields", "host,ip,port,protocol,title,domain");
  const r = await fetchJson(u.toString(), { method: "GET" });
  if (!r.ok) {
    throw new Error(`FOFA HTTP ${r.status}: ${r.text.slice(0, 300)}`);
  }
  if (dig(r.json, "error") === true) {
    throw new Error(`FOFA: ${String(dig(r.json, "errmsg") ?? "error")}`);
  }
  const rows = asRows(dig(r.json, c.resultPath || "results"));
  const hits: AssetSearchHit[] = [];
  for (const row of rows) {
    const hit = pickAddress(row, c.addressFields?.length ? c.addressFields : ["host", "ip", "domain"]);
    if (hit) hits.push(hit);
  }
  const total = dig(r.json, "size");
  return {
    hits,
    totalHint: typeof total === "number" ? total : null,
    raw: r.json,
  };
}

async function searchHunter(
  c: WorkerAssetCollector,
  query: string,
  size: number,
): Promise<{ hits: AssetSearchHit[]; totalHint: number | null; raw: unknown }> {
  const { apiKey } = resolveSecrets(c);
  if (!apiKey) throw new Error("鹰图 (Hunter) 未配置 apiKey（设置 → 资产收集）");
  const base = (c.baseUrl || "https://hunter.qianxin.com/openApi/search").replace(/\/$/, "");
  const u = new URL(base);
  u.searchParams.set("api-key", apiKey);
  u.searchParams.set("search", b64(query));
  u.searchParams.set("page", "1");
  u.searchParams.set("page_size", String(Math.min(Math.max(size, 1), 100)));
  u.searchParams.set("is_web", "3");
  const r = await fetchJson(u.toString(), { method: "GET" });
  if (!r.ok) {
    throw new Error(`Hunter HTTP ${r.status}: ${r.text.slice(0, 300)}`);
  }
  const code = dig(r.json, "code");
  if (code !== undefined && code !== 200 && code !== "200") {
    throw new Error(`Hunter: ${String(dig(r.json, "message") ?? code)}`);
  }
  const rows = asRows(dig(r.json, c.resultPath || "data.arr"));
  const hits: AssetSearchHit[] = [];
  for (const row of rows) {
    const hit = pickAddress(
      row,
      c.addressFields?.length ? c.addressFields : ["url", "domain", "ip"],
    );
    if (hit) hits.push(hit);
  }
  const total = dig(r.json, "data.total");
  return {
    hits,
    totalHint: typeof total === "number" ? total : null,
    raw: r.json,
  };
}

function applyTemplate(
  tpl: string,
  vars: Record<string, string>,
): string {
  return tpl.replace(/\{\{(\w+)\}\}/g, (_, k: string) => vars[k] ?? "");
}

async function searchCustom(
  c: WorkerAssetCollector,
  query: string,
  size: number,
): Promise<{ hits: AssetSearchHit[]; totalHint: number | null; raw: unknown }> {
  const { email, apiKey } = resolveSecrets(c);
  if (!apiKey) throw new Error(`自定义收集器 ${c.id} 未配置 apiKey`);
  if (!c.baseUrl) throw new Error(`自定义收集器 ${c.id} 缺少 baseUrl`);
  const qEncoded = c.queryEncoding === "base64" ? b64(query) : query;
  const vars = {
    apiKey,
    email,
    query,
    queryBase64: b64(query),
    page: "1",
    size: String(Math.min(Math.max(size, 1), 200)),
  };
  const headers: Record<string, string> = {};
  if (c.authHeader) {
    headers[c.authHeader] = applyTemplate(
      c.authHeader.toLowerCase() === "authorization" ? "Bearer {{apiKey}}" : "{{apiKey}}",
      vars,
    );
    // If authHeader value looks like a template name stored wrongly, prefer Bearer for Authorization
    if (c.authHeader.includes("{{")) {
      /* unused */
    }
  }
  // Support authHeader as "Authorization: Bearer {{apiKey}}" stored in authHeader field as header name only;
  // allow bodyTemplate / separate: if authHeader contains ":", treat as full header line template.
  let headerName = c.authHeader;
  let headerValue = apiKey;
  if (c.authHeader.includes(":")) {
    const [n, ...rest] = c.authHeader.split(":");
    headerName = (n ?? "").trim();
    headerValue = applyTemplate(rest.join(":").trim() || "{{apiKey}}", vars);
  } else if (c.authHeader) {
    headerName = c.authHeader.trim();
    headerValue =
      headerName.toLowerCase() === "authorization"
        ? `Bearer ${apiKey}`
        : apiKey;
  }
  if (headerName) headers[headerName] = headerValue;

  const method = c.method || "GET";
  let url = c.baseUrl;
  let body: string | undefined;
  if (method === "GET") {
    const u = new URL(c.baseUrl);
    const qp = c.queryParam || "q";
    u.searchParams.set(qp, qEncoded);
    u.searchParams.set("page", vars.page);
    u.searchParams.set("size", vars.size);
    if (c.authQueryParam) u.searchParams.set(c.authQueryParam, apiKey);
    url = u.toString();
  } else {
    const u = new URL(c.baseUrl);
    if (c.authQueryParam) u.searchParams.set(c.authQueryParam, apiKey);
    url = u.toString();
    if (c.bodyTemplate) {
      body = applyTemplate(c.bodyTemplate, { ...vars, query: qEncoded });
      headers["content-type"] = headers["content-type"] ?? "application/json";
    } else {
      body = JSON.stringify({
        [c.queryParam || "q"]: qEncoded,
        page: Number(vars.page),
        size: Number(vars.size),
      });
      headers["content-type"] = "application/json";
    }
  }

  const r = await fetchJson(url, { method, headers, body });
  if (!r.ok) {
    throw new Error(`${c.id} HTTP ${r.status}: ${r.text.slice(0, 300)}`);
  }
  const rows = asRows(dig(r.json, c.resultPath || ""));
  const hits: AssetSearchHit[] = [];
  const fields = c.addressFields?.length
    ? c.addressFields
    : ["host", "ip", "domain", "url"];
  for (const row of rows) {
    const hit = pickAddress(row, fields);
    if (hit) hits.push(hit);
  }
  return { hits, totalHint: hits.length, raw: r.json };
}

export function listReadyCollectors(manifest: WorkerManifest): WorkerAssetCollector[] {
  return (manifest.assetCollectors ?? []).filter((c) => c.enabled);
}

export function collectorsPromptBlock(manifest: WorkerManifest): string {
  const list = listReadyCollectors(manifest);
  if (!list.length) {
    return "\n资产收集 API：未启用。在控制台「设置 → 资产收集」配置 FOFA / 鹰图 / 自定义后，可用 asset_search 自动发现并写入资产清单。\n";
  }
  const lines = list.map(
    (c) => `- ${c.id}（${c.name} · ${c.kind}）→ asset_search(collectorId="${c.id}", query=…)`,
  );
  return `\n已启用资产收集 API（被动测绘；命中须经 asset_record 同等准入逻辑写入清单）：\n${lines.join("\n")}\n用法：asset_search；query 用各平台语法（FOFA: domain="example.com"；鹰图: domain="example.com"）。结果自动写入资产清单与 evidence。\n`;
}

export async function runAssetSearch(
  ctx: ToolContext,
  args: {
    collectorId: string;
    query: string;
    size?: number;
    intentId?: string | null;
  },
): Promise<AssetSearchResult> {
  const collectors = listReadyCollectors(ctx.manifest);
  const c = collectors.find((x) => x.id === args.collectorId);
  if (!c) {
    const available = collectors.map((x) => x.id).join(", ") || "（无）";
    throw new Error(`收集器不可用: ${args.collectorId}；已启用: ${available}`);
  }
  const query = (args.query ?? "").trim();
  if (!query) throw new Error("query 不能为空");
  const size = args.size ?? 50;

  ctx.usage.toolCalls += 1;
  if (isBudgetHit(ctx.usage.toolCalls, ctx.manifest.budget.maxToolCalls)) {
    throw new Error("maxToolCalls exceeded");
  }

  let hits: AssetSearchHit[] = [];
  let totalHint: number | null = null;
  let raw: unknown = null;
  try {
    const r =
      c.kind === "fofa"
        ? await searchFofa(c, query, size)
        : c.kind === "hunter"
          ? await searchHunter(c, query, size)
          : await searchCustom(c, query, size);
    hits = r.hits;
    totalHint = r.totalHint;
    raw = r.raw;
  } catch (e) {
    return {
      collectorId: c.id,
      collectorName: c.name,
      query,
      totalHint: null,
      recorded: [],
      skipped: 0,
      evidencePath: null,
      error: e instanceof Error ? e.message : String(e),
    };
  }

  // Dedupe by address
  const seen = new Set<string>();
  const unique: AssetSearchHit[] = [];
  for (const h of hits) {
    const key = h.address.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(h);
  }

  const recorded: Array<{ address: string; kind: string }> = [];
  let skipped = 0;
  for (const h of unique) {
    try {
      const r = ctx.history.recordAsset({
        taskId: ctx.manifest.taskId,
        address: h.address,
        auth: ctx.manifest.auth,
        summary: h.summary || `${c.name}: ${query}`,
        live: false,
        source: "discover",
        intentId: args.intentId ?? null,
      });
      recorded.push({ address: r.asset.address, kind: r.asset.kind });
    } catch {
      skipped += 1;
    }
  }

  let evidencePath: string | null = null;
  try {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const rel = `recon/asset-search-${c.id}-${stamp}.json`;
    evidencePath = writeEvidence(
      ctx,
      rel,
      JSON.stringify(
        {
          collectorId: c.id,
          kind: c.kind,
          query,
          totalHint,
          recordedCount: recorded.length,
          sample: unique.slice(0, 30),
          // Truncate raw to keep evidence bounded
          raw: JSON.stringify(raw).slice(0, 48_000),
        },
        null,
        2,
      ),
    );
  } catch {
    evidencePath = null;
  }

  return {
    collectorId: c.id,
    collectorName: c.name,
    query,
    totalHint,
    recorded,
    skipped,
    evidencePath,
  };
}

/** For unit tests: extract addresses from FOFA/Hunter-shaped payloads. */
export function extractHitsForTest(
  kind: "fofa" | "hunter" | "custom",
  json: unknown,
  fields?: string[],
): AssetSearchHit[] {
  const path = kind === "fofa" ? "results" : kind === "hunter" ? "data.arr" : "";
  const rows = asRows(dig(json, path));
  const f = fields ?? (kind === "hunter" ? ["url", "domain", "ip"] : ["host", "ip", "domain"]);
  const hits: AssetSearchHit[] = [];
  for (const row of rows) {
    const hit = pickAddress(row, f);
    if (hit) hits.push(hit);
  }
  return hits;
}

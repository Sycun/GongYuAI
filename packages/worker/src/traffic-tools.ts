import {
  getTraffic,
  getTrafficLive,
  queryTrafficLive,
  readTrafficBodyLive,
  trafficEvidenceRef,
  type TrafficQuery,
} from "@gongyuai/exec";

export const TRAFFIC_TOOLS = [
  {
    name: "traffic_search",
    description: "Search recorded HTTP exchanges for this task by host, method, status, keyword, or intentId. Includes recent in-memory (hot, not yet persisted) exchanges listed in hotIds; they are saved to disk once finding_record links them. Returns evidence refs http:<id>.",
    parameters: {
      type: "object",
      properties: {
        host: { type: "string" },
        method: { type: "string" },
        status: { type: "number" },
        keyword: { type: "string" },
        intentId: { type: "string" },
        offset: { type: "number" },
        limit: { type: "number" },
      },
    },
  },
  {
    name: "traffic_get",
    description: "Read one exchange: request headers, response headers, and a short body summary. Evidence ref is http:<id>.",
    parameters: {
      type: "object",
      properties: { id: { type: "string" } },
      required: ["id"],
    },
  },
  {
    name: "traffic_blob",
    description: "Read one slice of a request or response body. Default 8 KiB, maximum 64 KiB, continue with offset. Hot (in-memory) bodies keep only their first 64 KiB (truncated=true). Evidence ref is http:<id>.",
    parameters: {
      type: "object",
      properties: {
        id: { type: "string" },
        side: { type: "string", enum: ["req", "res"] },
        offset: { type: "number" },
        maxBytes: { type: "number" },
      },
      required: ["id", "side"],
    },
  },
] as const;

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function num(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() && Number.isFinite(Number(value))) return Number(value);
  return undefined;
}

function isHot(taskDir: string, id: string): boolean {
  return getTraffic(taskDir, id) == null;
}

function fail(error: unknown): string {
  return JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) });
}

function head(taskDir: string, id: string, side: "req" | "res"): string {
  try {
    return readTrafficBodyLive(taskDir, id, side, 0, 512).body;
  } catch {
    return "";
  }
}

/**
 * Agent-facing traffic tools. Read-only. In finding-window mode they merge
 * index.sqlite rows with the in-memory ring (hot, not yet persisted), so an
 * exchange is searchable before finding_record promotes it.
 */
export function runTrafficTool(
  taskDir: string,
  taskId: string,
  name: string,
  args: Record<string, unknown> = {},
): string {
  try {
    if (name === "traffic_search") {
      const query: TrafficQuery = {
        taskId,
        ...(text(args.host) ? { host: text(args.host) } : {}),
        ...(text(args.method) ? { method: text(args.method) } : {}),
        ...(text(args.keyword) ? { keyword: text(args.keyword) } : {}),
        ...(text(args.intentId) ? { intentId: text(args.intentId) } : {}),
        ...(num(args.status) !== undefined ? { status: num(args.status) } : {}),
        ...(num(args.offset) !== undefined ? { offset: num(args.offset) } : {}),
        ...(num(args.limit) !== undefined ? { limit: num(args.limit) } : {}),
      };
      const page = queryTrafficLive(taskDir, query);
      return JSON.stringify({
        ok: true,
        traffic: page.traffic,
        total: page.total,
        nextOffset: page.nextOffset,
        ...(page.hotIds.length ? { hotIds: page.hotIds } : {}),
        evidence: page.traffic.map((row) => trafficEvidenceRef(row.id)),
      });
    }
    if (name === "traffic_get") {
      const id = text(args.id);
      if (!id) return fail("id required");
      const record = getTrafficLive(taskDir, id);
      if (!record || record.taskId !== taskId) return fail("traffic not found");
      return JSON.stringify({
        ok: true,
        evidenceRef: trafficEvidenceRef(record.id),
        persisted: !isHot(taskDir, record.id),
        record,
        summary: {
          method: record.method,
          url: record.url,
          status: record.status,
          reqBytes: record.reqBodyBlob?.size ?? 0,
          resBytes: record.resBodyBlob?.size ?? 0,
          reqHead: head(taskDir, record.id, "req"),
          resHead: head(taskDir, record.id, "res"),
        },
      });
    }
    if (name === "traffic_blob") {
      const id = text(args.id);
      const side = args.side === "req" || args.side === "res" ? args.side : null;
      if (!id || !side) return fail("id and side=req|res required");
      const record = getTrafficLive(taskDir, id);
      if (!record || record.taskId !== taskId) return fail("traffic not found");
      const slice = readTrafficBodyLive(taskDir, id, side, num(args.offset), num(args.maxBytes));
      return JSON.stringify({
        ok: true,
        evidenceRef: slice.evidenceRef,
        side: slice.side,
        sha256: slice.sha256,
        offset: slice.offset,
        size: slice.size,
        nextOffset: slice.nextOffset,
        ...(slice.rawSize != null ? { rawSize: slice.rawSize } : {}),
        ...(slice.decodedEncoding ? { decodedEncoding: slice.decodedEncoding } : {}),
        ...(slice.contentType ? { contentType: slice.contentType } : {}),
        ...(slice.truncated ? { truncated: true, bufferedBytes: slice.bufferedBytes } : {}),
        body: slice.body,
        bytes: slice.bytes.toString("base64"),
      });
    }
    return fail(`unknown traffic tool: ${name}`);
  } catch (err) {
    return fail(err);
  }
}

import { z } from "zod";

/**
 * P14-B1 — an HTTP transaction is a first-class evidence object.
 * Requests/responses live as content-addressed files under evidence/; the row
 * below is the index used by tools, the report and `finding_verify` refs
 * (`http:<id>`).
 */
export const HttpTransactionSchema = z.object({
  id: z.string().uuid(),
  taskId: z.string().uuid(),
  intentId: z.string().uuid().nullable().default(null),
  method: z.string().min(1),
  url: z.string().min(1),
  host: z.string().min(1),
  path: z.string().min(1),
  status: z.number().int().min(0),
  requestSha256: z.string().length(64),
  responseSha256: z.string().length(64),
  /** Evidence-relative paths (`http/<sha>.req.txt` / `.res.txt`). */
  requestPath: z.string().min(1),
  responsePath: z.string().min(1),
  requestBytes: z.number().int().nonnegative(),
  responseBytes: z.number().int().nonnegative(),
  /** Up to 16 KiB of the response body is kept inline for prompts. */
  responseHead: z.string().default(""),
  truncated: z.boolean().default(false),
  redirects: z.array(z.string()).default([]),
  startedAt: z.string().datetime(),
  durationMs: z.number().int().nonnegative(),
  note: z.string().default(""),
});
export type HttpTransaction = z.infer<typeof HttpTransactionSchema>;

export const HttpRequestInputSchema = z.object({
  method: z.string().trim().min(1).max(16).default("GET"),
  url: z.string().url(),
  headers: z.record(z.string(), z.string()).optional(),
  body: z.string().optional(),
  /** Follow redirects only while every hop stays in scope. Default true. */
  follow: z.boolean().default(true),
  timeoutMs: z.number().int().min(1).max(120_000).default(30_000),
  note: z.string().trim().max(500).default(""),
});
export type HttpRequestInput = z.infer<typeof HttpRequestInputSchema>;

/** Response delivered to the model: head + metadata, never the whole body. */
export const HttpToolResultSchema = z.object({
  ok: z.boolean(),
  transactionId: z.string().uuid().optional(),
  status: z.number().int().optional(),
  headers: z.record(z.string(), z.string()).optional(),
  bodyHead: z.string().default(""),
  truncated: z.boolean().default(false),
  redirects: z.array(z.string()).default([]),
  error: z.string().optional(),
});
export type HttpToolResult = z.infer<typeof HttpToolResultSchema>;

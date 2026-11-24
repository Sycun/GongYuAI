import { z } from "zod";
import { HttpTransactionSchema } from "./http.js";

const Sha256Schema = z.string().regex(/^[0-9a-f]{64}$/i);
const ByteOffsetSchema = z.number().int().nonnegative();
const TrafficHeadersSchema = z.record(z.string(), z.union([z.string(), z.array(z.string())]));

/** Content-addressed reference to a recorded body. Size is in bytes. */
export const TrafficBlobRefSchema = z.object({
  sha256: Sha256Schema,
  size: z.number().int().nonnegative(),
  contentType: z.string().optional(),
});
export type TrafficBlobRef = z.infer<typeof TrafficBlobRefSchema>;

/** Metadata for an observed HTTP exchange. Bodies are stored by reference. */
export const TrafficRecordSchema = HttpTransactionSchema.pick({
  id: true,
  taskId: true,
  method: true,
  url: true,
  host: true,
  path: true,
  status: true,
  durationMs: true,
  startedAt: true,
}).extend({
  intentId: z.string().uuid().optional(),
  workerId: z.string().min(1).optional(),
  reqHeaders: TrafficHeadersSchema,
  resHeaders: TrafficHeadersSchema,
  reqBodyBlob: TrafficBlobRefSchema.optional(),
  resBodyBlob: TrafficBlobRefSchema.optional(),
  findingIds: z.array(z.string().uuid()).optional(),
});
export type TrafficRecord = z.infer<typeof TrafficRecordSchema>;

export const TrafficSearchQuerySchema = TrafficRecordSchema.pick({
  intentId: true,
  workerId: true,
  method: true,
  host: true,
  path: true,
  status: true,
}).partial().extend({
  taskId: TrafficRecordSchema.shape.taskId,
  findingId: z.string().uuid().optional(),
  startedAfter: z.string().datetime().optional(),
  startedBefore: z.string().datetime().optional(),
  offset: ByteOffsetSchema.default(0),
  limit: z.number().int().min(1).max(200).default(50),
});
export type TrafficSearchQuery = z.infer<typeof TrafficSearchQuerySchema>;

/** Bounded byte range for reading an archived body by its digest. */
export const TrafficBlobSliceSchema = z.object({
  sha256: Sha256Schema,
  offset: ByteOffsetSchema.default(0),
  maxBytes: z.number().int().min(1).max(1024 * 1024).default(64 * 1024),
});
export type TrafficBlobSlice = z.infer<typeof TrafficBlobSliceSchema>;

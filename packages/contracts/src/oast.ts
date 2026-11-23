import { z } from "zod";

/**
 * P14-B2 — out-of-band callback tokens. A token is issued by the task, placed
 * inside a payload (URL/DNS), and later correlated with an inbound hit. A hit
 * only proves "the target made an out-of-band request"; impact still needs a
 * transaction or host-level proof.
 */
export const OastTokenSchema = z.object({
  token: z.string().min(8).max(64),
  taskId: z.string().uuid(),
  kind: z.enum(["http", "dns"]).default("http"),
  /** Full callback URL or hostname handed to the payload. */
  callback: z.string().min(1),
  note: z.string().default(""),
  issuedAt: z.string().datetime(),
  expiresAt: z.string().datetime(),
  hits: z.number().int().nonnegative().default(0),
});
export type OastToken = z.infer<typeof OastTokenSchema>;

export const OastHitSchema = z.object({
  token: z.string().min(8).max(64),
  taskId: z.string().uuid(),
  at: z.string().datetime(),
  sourceIp: z.string().default(""),
  method: z.string().default(""),
  path: z.string().default(""),
  userAgent: z.string().default(""),
  protocol: z.enum(["http", "dns"]).default("http"),
});
export type OastHit = z.infer<typeof OastHitSchema>;

/** Default token shelf life; hits after expiry are still recorded but flagged. */
export const OAST_TOKEN_TTL_MS = 2 * 60 * 60 * 1000;

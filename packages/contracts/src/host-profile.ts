import { z } from "zod";

/**
 * P14-B4 — structured picture of a foothold host. The profile is an indexed
 * domain object (one row per task+asset); it never replaces the Fact graph and
 * every field stays evidence-backed (evidencePath) — unknown stays empty.
 */
export const HostProfileSchema = z.object({
  id: z.string().uuid(),
  taskId: z.string().uuid(),
  /** Normalized host address. */
  asset: z.string().min(1),
  hostname: z.string().nullable().default(null),
  os: z.string().nullable().default(null),
  domain: z.string().nullable().default(null),
  users: z.array(z.string()).default([]),
  privileges: z.array(z.string()).default([]),
  services: z.array(z.string()).default([]),
  shares: z.array(z.string()).default([]),
  /** AV/EDR signals observed (read-only; never used to build bypasses). */
  av: z.array(z.string()).default([]),
  evidencePath: z.string().nullable().default(null),
  source: z.string().default("worker"),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type HostProfile = z.infer<typeof HostProfileSchema>;

export const HostProfileDraftSchema = z.object({
  asset: z.string().trim().min(1),
  hostname: z.string().trim().max(255).optional(),
  os: z.string().trim().max(255).optional(),
  domain: z.string().trim().max(255).optional(),
  users: z.array(z.string().min(1)).max(200).default([]),
  privileges: z.array(z.string().min(1)).max(200).default([]),
  services: z.array(z.string().min(1)).max(200).default([]),
  shares: z.array(z.string().min(1)).max(200).default([]),
  av: z.array(z.string().min(1)).max(50).default([]),
  evidencePath: z.string().trim().optional(),
  source: z.string().trim().max(64).default("worker"),
});
export type HostProfileDraft = z.infer<typeof HostProfileDraftSchema>;
export type HostProfileDraftInput = z.input<typeof HostProfileDraftSchema>;

/** Technique families used for bounded internal fan-out (not a fixed playbook). */
export const INTERNAL_TECHNIQUES = [
  "T1046", // network service discovery
  "T1069", // permission groups discovery
  "T1087", // account discovery
  "T1135", // network share discovery
  "T1021", // remote services (lateral)
  "T1550", // use alternate authentication material
] as const;

import { z } from "zod";

/**
 * P14-B0 — credential as a first-class object (foothold reuse).
 * Only pointers land here: `secretRef` is an evidence-relative path or env var
 * name; `secretHmac` is a one-way fingerprint used to correlate "same password
 * on two assets" without storing the secret. Observe / π / tool_gate payloads
 * only ever see the id.
 */
export const CredentialKindSchema = z.enum([
  "password",
  "hash",
  "ticket",
  "token",
  "key",
  "session",
  "cookie",
  "foothold-shell",
]);
export type CredentialKind = z.infer<typeof CredentialKindSchema>;

export const CredentialTierSchema = z.enum(["L1", "L2", "L3"]);
export type CredentialTier = z.infer<typeof CredentialTierSchema>;

/**
 * Explicit tier wins. Otherwise a successful authentication (`verified` or
 * `verifiedAt`) is L2; everything else stays L1 until it is upgraded.
 */
export function defaultCredentialTier(input: {
  tier?: CredentialTier | null;
  verified?: boolean | null;
  verifiedAt?: string | null;
}): CredentialTier {
  if (input.tier === "L1" || input.tier === "L2" || input.tier === "L3") return input.tier;
  if (input.verified === true) return "L2";
  if (typeof input.verifiedAt === "string" && input.verifiedAt.trim().length > 0) return "L2";
  return "L1";
}

const credentialTierRank: Record<CredentialTier, number> = { L1: 1, L2: 2, L3: 3 };

/** True when `next` is a strictly higher verification tier than `current`. */
export function credentialTierUpgrades(current: CredentialTier, next: CredentialTier): boolean {
  return credentialTierRank[next] > credentialTierRank[current];
}

const CredentialObjectSchema = z.object({
  id: z.string().uuid(),
  taskId: z.string().uuid(),
  kind: CredentialKindSchema,
  /** Normalized asset this credential is known to work on. */
  asset: z.string().min(1),
  username: z.string().nullable().default(null),
  /** Pointer only — evidence path or env var name. Never plaintext. */
  secretRef: z.string().min(1),
  /** Hex fingerprint (sha256 of a keyed digest). Never the secret itself. */
  secretHmac: z.string().length(64).nullable().default(null),
  sourceFindingId: z.string().uuid().nullable().default(null),
  /** P14-B4 bridge — Fact that can be cited as an Intent predecessor. */
  factId: z.string().uuid().nullable().default(null),
  verifiedAt: z.string().datetime().nullable().default(null),
  lastUsedAt: z.string().datetime().nullable().default(null),
  reuseCount: z.number().int().nonnegative().default(0),
  expiresAt: z.string().datetime().nullable().default(null),
  createdAt: z.string().datetime(),
  tier: CredentialTierSchema.optional(),
  /** L3 scope note: what this credential can actually reach. Never the secret. */
  impactSummary: z.string().nullable().default(null),
});

export const CredentialSchema = CredentialObjectSchema.transform((row) => ({
  ...row,
  tier: defaultCredentialTier({ tier: row.tier, verifiedAt: row.verifiedAt }),
  impactSummary: row.impactSummary ?? null,
}));
export type Credential = z.infer<typeof CredentialSchema>;

const CredentialDraftObjectSchema = z.object({
  kind: CredentialKindSchema,
  asset: z.string().min(1),
  username: z.string().trim().max(255).optional(),
  secretRef: z.string().trim().min(1).max(512),
  secretHmac: z.string().length(64).optional(),
  sourceFindingId: z.string().uuid().optional(),
  /** True only when a real authentication succeeded (evidence-backed). */
  verified: z.boolean().default(false),
  expiresAt: z.string().datetime().optional(),
  tier: CredentialTierSchema.optional(),
  impactSummary: z.string().nullable().default(null),
});

export const CredentialDraftSchema = CredentialDraftObjectSchema.transform((draft) => ({
  ...draft,
  tier: defaultCredentialTier({ tier: draft.tier, verified: draft.verified }),
  impactSummary: draft.impactSummary ?? null,
}));
export type CredentialDraft = z.infer<typeof CredentialDraftSchema>;

/** Redact anything that looks like a secret value before it reaches a prompt. */
export function redactSecretRef(ref: string): string {
  const value = ref.trim();
  if (!value) return "";
  if (/^[A-Z][A-Z0-9_]{2,}$/.test(value)) return value; // env var name
  return value.replace(/[^/]+$/, "***");
}

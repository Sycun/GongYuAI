/**
 * P17 — provider pool + tiered model routing.
 *
 * This is the startup decision, not a mid-run hot swap: Pi's root model is
 * fixed when the durable harness opens. The router picks a primary ref for the
 * process and an ordered fallback chain; the control plane/operator can still
 * change the task model between runs.
 *
 * Tiers:
 * - `reason`  — slot 0 (leader): planning, evidence review, reporting;
 * - `explore` — execution slots: tool calls, parsing, verification;
 * - `execute` — reserved for short tool-only workers / future subagents;
 * - `base`    — legacy single-model configuration.
 */
import { z } from "zod";

export const ModelRefSchema = z.object({
  provider: z.string().min(1),
  modelId: z.string().min(1),
  baseUrl: z.string().url().optional(),
  apiKeyEnv: z.string().min(1).optional(),
  label: z.string().min(1).optional(),
});
export type ModelRef = z.infer<typeof ModelRefSchema>;

export const ModelTiersSchema = z.object({
  reason: ModelRefSchema.optional(),
  explore: ModelRefSchema.optional(),
  execute: ModelRefSchema.optional(),
});
export type ModelTiers = z.infer<typeof ModelTiersSchema>;

export type ModelTier = "reason" | "explore" | "execute" | "base";

export type ModelRouteInput = {
  /** Legacy single model from `manifest.model`. */
  base: ModelRef | null;
  /** Per-tier overrides from `manifest.execution.models`. */
  tiers?: ModelTiers | null;
  /** Ordered provider pool from `manifest.execution.providers`. */
  providers?: readonly ModelRef[] | null;
  /** Worker slot; 0 is the leader (Reason/Report). */
  slot: number;
  /** Testable key-availability check; defaults to "no env or env present". */
  keyPresent?: (ref: ModelRef) => boolean;
};

export type ModelRoute = {
  ref: ModelRef;
  tier: ModelTier;
  /** Ordered alternatives after `ref` (same tier/provider pool/base). */
  fallbacks: ModelRef[];
};

const keyByEnv = (ref: ModelRef): boolean => {
  if (!ref.apiKeyEnv) return true;
  if (typeof process === "undefined" || !process.env) return true;
  return Boolean(process.env[ref.apiKeyEnv]);
};

const dedupe = (refs: ModelRef[]): ModelRef[] => {
  const seen = new Set<string>();
  const out: ModelRef[] = [];
  for (const ref of refs) {
    const key = `${ref.provider}/${ref.modelId}/${ref.baseUrl ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(ref);
  }
  return out;
};

/**
 * Deterministic. Prefer the slot's tier; if its key is absent, try the other
 * tiers, then the provider pool, then the base ref. The *last* candidate is
 * returned even when every key is missing, so the caller can surface a clear
 * provider error instead of silently inventing a model.
 */
export function selectModelRoute(input: ModelRouteInput): ModelRoute {
  const keyPresent = input.keyPresent ?? keyByEnv;
  const tiers = input.tiers ?? {};
  const preferred = input.slot === 0 ? tiers.reason : tiers.explore;
  const primaryTier: ModelTier =
    preferred ? (input.slot === 0 ? "reason" : "explore") : "base";
  const candidates: Array<{ ref: ModelRef; tier: ModelTier }> = [];

  const push = (ref: ModelRef | undefined, tier: ModelTier) => {
    if (ref) candidates.push({ ref, tier });
  };

  push(preferred, primaryTier);
  push(input.slot === 0 ? tiers.explore : tiers.reason, input.slot === 0 ? "explore" : "reason");
  push(tiers.execute, "execute");
  for (const ref of input.providers ?? []) push(ref, primaryTier === "base" ? "base" : primaryTier);
  push(input.base ?? undefined, "base");

  const ordered = dedupe(candidates.map((entry) => entry.ref)).map((ref) => {
    const found = candidates.find((entry) => entry.ref === ref)!;
    return { ref, tier: found.tier };
  });
  const chosen =
    ordered.find((entry) => keyPresent(entry.ref)) ??
    ordered.find((entry) => entry.tier === "base") ??
    ordered[0];
  if (!chosen) throw new Error("no model configured");
  return {
    ref: chosen.ref,
    tier: chosen.tier,
    fallbacks: ordered.filter((entry) => entry !== chosen).map((entry) => entry.ref),
  };
}

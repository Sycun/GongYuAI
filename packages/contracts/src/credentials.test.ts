import assert from "node:assert/strict";
import { test } from "node:test";
import { CredentialDraftSchema, CredentialSchema } from "./credentials.js";

const credential = {
  id: "11111111-1111-4111-8111-111111111111",
  taskId: "22222222-2222-4222-8222-222222222222",
  kind: "token" as const,
  asset: "lab.example.com",
  secretRef: "credentials/token.txt",
  createdAt: "2026-11-24T00:00:00.000Z",
};

test("credential tier defaults to L1, L2 when verified, and keeps an explicit tier", () => {
  const unverified = CredentialSchema.parse(credential);
  assert.equal(unverified.tier, "L1");
  assert.equal(unverified.impactSummary, null);

  const verified = CredentialSchema.parse({
    ...credential,
    verifiedAt: "2026-11-24T01:00:00.000Z",
  });
  assert.equal(verified.tier, "L2");

  const explicit = CredentialSchema.parse({
    ...credential,
    verifiedAt: "2026-11-24T01:00:00.000Z",
    tier: "L3",
    impactSummary: "可读取邮箱",
  });
  assert.equal(explicit.tier, "L3");
  assert.equal(explicit.impactSummary, "可读取邮箱");
});

test("credential drafts use the same tier default", () => {
  const draft = CredentialDraftSchema.parse({
    kind: "password",
    asset: "lab.example.com",
    secretRef: "PASSWORD",
  });
  assert.equal(draft.verified, false);
  assert.equal(draft.tier, "L1");
  assert.equal(draft.impactSummary, null);

  const verified = CredentialDraftSchema.parse({
    kind: "password",
    asset: "lab.example.com",
    secretRef: "PASSWORD",
    verified: true,
  });
  assert.equal(verified.tier, "L2");

  const pinned = CredentialDraftSchema.parse({
    kind: "password",
    asset: "lab.example.com",
    secretRef: "PASSWORD",
    tier: "L1",
    verified: true,
  });
  assert.equal(pinned.tier, "L1");
});

import assert from "node:assert/strict";
import test from "node:test";
import {
  MEMORY_READ_UNAVAILABLE,
  MEMORY_REVIEW_UNAVAILABLE,
  beginMemoryReview,
  memoryReadAllowed,
  memoryReviewAllowed,
  memoryReviewEngagementMatches,
  verifiedIdentityFromRequest,
} from "./memory-access.js";

test("this control plane cannot prove a caller identity, so memory reads stay closed", () => {
  assert.equal(verifiedIdentityFromRequest(), null);
  assert.equal(memoryReadAllowed(verifiedIdentityFromRequest()), false);
  assert.equal(memoryReadAllowed({ verified: false }), false);
  assert.equal(memoryReadAllowed({ verified: true }), true);
  assert.equal(MEMORY_READ_UNAVAILABLE.available, false);
  assert.equal(Object.hasOwn(MEMORY_READ_UNAVAILABLE, "nodes"), false);
  assert.match(MEMORY_READ_UNAVAILABLE.message, /身份/);
});

test("memory review stays closed unless identity, review permission and engagement are all present", () => {
  const gate = beginMemoryReview(verifiedIdentityFromRequest());
  assert.equal(gate.proceed, false);
  if (!gate.proceed) assert.deepEqual(gate.body, MEMORY_REVIEW_UNAVAILABLE);
  assert.equal(memoryReviewAllowed(null), false);
  assert.equal(memoryReviewAllowed({ verified: true }), false);
  assert.equal(memoryReviewAllowed({ verified: true, canReviewMemory: true, tenantId: "tenant-a", engagementId: "" }), false);
  assert.equal(memoryReviewAllowed({
    verified: true,
    canReviewMemory: true,
    tenantId: "tenant-a",
    engagementId: "eng-a",
  }), true);
  assert.equal(memoryReviewEngagementMatches({ engagementIds: ["eng-a"] }, { engagementId: "eng-a" }), true);
  assert.equal(memoryReviewEngagementMatches({ engagementIds: ["eng-a"] }, { engagementId: "eng-b" }), false);
  assert.equal(Object.hasOwn(MEMORY_REVIEW_UNAVAILABLE, "node"), false);
});

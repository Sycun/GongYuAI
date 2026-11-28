import assert from "node:assert/strict";
import test from "node:test";
import { confirmationDescription, confirmationLabel, confirmationOptions } from "./approvalPolicy";
import { formatDateTime, parseTime } from "./time";

test("parseTime and formatDateTime normalize ISO timestamps to Beijing UTC+8 and preserve local strings", () => {
  assert.equal(parseTime(""), 0);
  assert.equal(parseTime("not-a-date"), 0);
  assert.equal(formatDateTime(null), "—");
  assert.equal(formatDateTime(undefined), "—");
  assert.equal(formatDateTime("invalid-raw"), "invalid-raw");

  // UTC midnight -> 08:00 Beijing time
  assert.equal(formatDateTime("2026-11-28T00:05:09.000Z"), "2026-11-28 08:05");
  assert.equal(formatDateTime("2026-11-28T00:05:09.000Z", true), "2026-11-28 08:05:09");

  // Local Beijing string must not be shifted a second time
  assert.equal(formatDateTime("2026-11-28 20:30"), "2026-11-28 20:30");
  assert.equal(formatDateTime("2026-11-28 20:30", true), "2026-11-28 20:30:00");
  assert.equal(formatDateTime("2026-11-28 20:30:45.123", true), "2026-11-28 20:30:45");
  assert.equal(parseTime("2026-11-28 08:05:09"), Date.parse("2026-11-28T00:05:09Z"));
});

test("approvalPolicy exposes matching labels and descriptions for auto vs manual confirmation", () => {
  assert.equal(confirmationLabel({ confirmation: "auto" }), confirmationOptions[0].label);
  assert.equal(confirmationDescription({ confirmation: "auto" }), confirmationOptions[0].description);
  assert.equal(confirmationLabel({ confirmation: "manual" }), confirmationOptions[1].label);
  assert.equal(confirmationDescription({ confirmation: "manual" }), confirmationOptions[1].description);
});

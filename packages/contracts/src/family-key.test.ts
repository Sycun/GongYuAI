import { test } from "node:test";
import assert from "node:assert/strict";
import {
  normalizeFamilyKey,
  parseFamilyKeyFromTags,
  suggestFamilyKey,
} from "./family-key.js";

test("suggestFamilyKey prefers tag then stack then root", () => {
  assert.equal(parseFamilyKeyFromTags(["family:Acme-WAF"]), "acme-waf");
  const tagged = suggestFamilyKey({
    tags: ["family:acme-waf"],
    title: "nginx something",
  });
  assert.deepEqual(tagged, {
    key: "acme-waf",
    via: "tag",
    confidence: "high",
  });

  const stack = suggestFamilyKey({
    title: "WAF bypass on edge",
    summary: "Cloudflare challenge skipped via XFF",
  });
  assert.equal(stack?.via, "stack");
  assert.ok(stack?.key === "cloudflare" || stack?.key === "waf");

  const root = suggestFamilyKey({
    title: "probe",
    addresses: ["a.lab.example.com", "b.lab.example.com"],
  });
  assert.equal(root?.via, "root");
  assert.match(root?.key ?? "", /example\.com/);
});

test("normalizeFamilyKey trims and lowercases", () => {
  assert.equal(normalizeFamilyKey("  Foo Bar  "), "foo-bar");
  assert.equal(normalizeFamilyKey(""), undefined);
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { assetGroupKey, assetRootKey, DEFAULT_MAX_INTENTS_PER_ASSET_ROOT } from "./fanout.js";

test("assetRootKey isolates individual hosts across /24 subnets and subdomains", () => {
  assert.equal(assetRootKey("a.example.com"), "a.example.com");
  assert.equal(assetRootKey("https://b.example.com:8443/x"), "b.example.com");
  assert.equal(assetRootKey("10.1.2.3"), "10.1.2.3");
  assert.equal(assetRootKey("http://10.1.2.4:8080/api"), "10.1.2.4");
  assert.notEqual(assetRootKey("10.0.160.144"), assetRootKey("10.0.160.145"));
  assert.equal(DEFAULT_MAX_INTENTS_PER_ASSET_ROOT, 3);
});

test("assetGroupKey groups registrable domains and IPv4 /24 for family hints", () => {
  assert.equal(assetGroupKey("a.example.com"), "example.com");
  assert.equal(assetGroupKey("https://b.example.com:8443/x"), "example.com");
  assert.equal(assetGroupKey("example.com"), "example.com");
  assert.equal(assetGroupKey("10.1.2.3"), "10.1.2.0/24");
  assert.equal(assetGroupKey("foo.co.uk"), "foo.co.uk");
  assert.equal(assetGroupKey("x.foo.co.uk"), "foo.co.uk");
});

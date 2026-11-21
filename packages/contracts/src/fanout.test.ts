import { test } from "node:test";
import assert from "node:assert/strict";
import { assetRootKey } from "./fanout.js";

test("assetRootKey groups domains and IPv4 /24", () => {
  assert.equal(assetRootKey("a.example.com"), "example.com");
  assert.equal(assetRootKey("https://b.example.com:8443/x"), "example.com");
  assert.equal(assetRootKey("example.com"), "example.com");
  assert.equal(assetRootKey("10.1.2.3"), "10.1.2.0/24");
  assert.equal(assetRootKey("foo.co.uk"), "foo.co.uk");
  assert.equal(assetRootKey("x.foo.co.uk"), "foo.co.uk");
});

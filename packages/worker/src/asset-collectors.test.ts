import { test } from "node:test";
import assert from "node:assert/strict";
import { extractHitsForTest } from "./asset-collectors.js";
import { mergeAssetCollectors } from "@gongyuai/contracts";

test("extractHitsForTest parses FOFA results arrays", () => {
  const hits = extractHitsForTest("fofa", {
    results: [
      ["www.example.com", "1.2.3.4", "443", "https", "Example", "example.com"],
      ["api.example.com", "1.2.3.5", "80", "http", "API", "example.com"],
    ],
  });
  assert.equal(hits.length, 2);
  assert.ok(hits[0]!.address.includes("example.com") || hits[0]!.address.includes("1.2.3"));
});

test("extractHitsForTest parses Hunter data.arr objects", () => {
  const hits = extractHitsForTest("hunter", {
    data: {
      arr: [
        { url: "https://a.example.com", domain: "a.example.com", ip: "9.9.9.9", port: 443 },
        { domain: "b.example.com", ip: "8.8.8.8" },
      ],
    },
  });
  assert.equal(hits.length, 2);
  assert.equal(hits[0]!.address, "https://a.example.com");
  assert.equal(hits[1]!.address, "b.example.com");
});

test("mergeAssetCollectors keeps builtins and custom", () => {
  const merged = mergeAssetCollectors([
    {
      id: "fofa",
      name: "FOFA",
      kind: "fofa",
      enabled: true,
      builtin: true,
      email: "a@b.c",
      apiKey: "k",
      baseUrl: "",
      method: "GET",
      authHeader: "",
      authQueryParam: "",
      queryParam: "qbase64",
      queryEncoding: "base64",
      bodyTemplate: "",
      resultPath: "results",
      addressFields: ["host"],
    },
    {
      id: "my-lab",
      name: "Lab",
      kind: "custom",
      enabled: true,
      builtin: false,
      email: "",
      apiKey: "x",
      baseUrl: "https://lab.local/search",
      method: "GET",
      authHeader: "",
      authQueryParam: "key",
      queryParam: "q",
      queryEncoding: "plain",
      bodyTemplate: "",
      resultPath: "items",
      addressFields: ["host"],
    },
  ]);
  assert.equal(merged.find((c) => c.id === "fofa")?.enabled, true);
  assert.equal(merged.find((c) => c.id === "fofa")?.apiKey, "k");
  assert.ok(merged.some((c) => c.id === "hunter"));
  assert.ok(merged.some((c) => c.id === "my-lab"));
});

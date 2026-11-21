import assert from "node:assert/strict";
import { test } from "node:test";
import {
  admitAddress,
  cidrContains,
  matchTarget,
  normalizeHost,
  normalizeTargetPattern,
  targetAllows,
} from "./scope.js";

test("normalizeHost strips URL noise", () => {
  assert.equal(normalizeHost("https://Api.Example.com:8443/path"), "api.example.com");
  assert.equal(normalizeHost("10.0.188.64"), "10.0.188.64");
});

test("normalizeTargetPattern keeps CIDR and wildcards", () => {
  assert.equal(normalizeTargetPattern("10.0.0.0/8"), "10.0.0.0/8");
  assert.equal(normalizeTargetPattern("*.Example.COM"), "*.example.com");
  assert.equal(normalizeTargetPattern("https://corp.example.com/app"), "corp.example.com");
});

test("cidrContains formal IPv4", () => {
  assert.equal(cidrContains("10.0.0.0/8", "10.0.188.64"), true);
  assert.equal(cidrContains("10.0.0.0/8", "11.0.0.1"), false);
  assert.equal(cidrContains("192.168.1.0/24", "192.168.1.20"), true);
  assert.equal(cidrContains("192.168.1.0/24", "192.168.2.1"), false);
});

test("matchTarget: CIDR / wildcard / suffix / star", () => {
  assert.equal(matchTarget(["10.0.0.0/8"], "10.1.2.3").ok, true);
  assert.equal(matchTarget(["*.example.com"], "a.example.com").ok, true);
  assert.equal(matchTarget(["*.example.com"], "example.com").ok, true);
  assert.equal(matchTarget(["example.com"], "www.example.com").ok, true);
  assert.equal(matchTarget(["example.com"], "evil.com").ok, false);
  assert.equal(matchTarget(["*"], "1.2.3.4").ok, true);
});

test("outOfScope beats targets", () => {
  assert.equal(
    targetAllows(["*.example.com"], "admin.example.com", ["admin.example.com"]),
    false,
  );
  assert.equal(targetAllows(["10.0.0.0/8"], "10.0.0.9", ["10.0.0.9"]), false);
});

test("admitAddress auto-admits under CIDR", () => {
  const r = admitAddress({ targets: ["10.0.0.0/8"] }, "10.9.9.9");
  assert.equal(r.kind, "admitted");
  assert.equal(admitAddress({ targets: ["10.0.0.0/8"] }, "8.8.8.8").kind, "oos");
});

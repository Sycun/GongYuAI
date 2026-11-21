import assert from "node:assert/strict";
import { test } from "node:test";
import {
  assertCommandAllowed,
  extractHosts,
  hostInTargets,
} from "./tools.js";
import type { WorkerManifest } from "@gongyuai/contracts";

function manifest(targets: string[]): WorkerManifest {
  return {
    taskId: "11111111-1111-4111-8111-111111111111",
    dataDir: "/tmp",
    historyDb: "/tmp/h.sqlite",
    durableDb: "/tmp/d.sqlite",
    evidenceDir: "/tmp/e",
    workspaceDir: "/tmp/w",
    auth: {
      authorizationNote: "lab auth note for tests",
      targets,
      outOfScope: [],
    },
    goals: [],
    budget: { maxTokens: 1000, maxWallMs: 60_000, maxToolCalls: 10, maxInstalls: 2 },
    mock: false,
    mcpServers: [],
    mcpPool: [],
    mcpCatalog: [],
    skillPacks: [],
    skillPool: [],
    skillCatalog: [],
  };
}

test("hostInTargets supports CIDR and exact host", () => {
  assert.equal(hostInTargets(["10.0.0.0/8"], "10.0.188.64"), true);
  assert.equal(hostInTargets(["10.0.0.0/8"], "11.0.0.1"), false);
  assert.equal(hostInTargets(["http://10.0.188.64"], "10.0.188.64"), true);
  assert.equal(hostInTargets(["*"], "1.2.3.4"), true);
});

test("extractHosts finds curl targets", () => {
  const hosts = extractHosts("curl -s http://10.0.188.64/login");
  assert.ok(hosts.includes("10.0.188.64"));
});

test("assertCommandAllowed denies host network mutation even with *", () => {
  assert.throws(
    () => assertCommandAllowed(manifest(["*"]), "sudo route add -net 10.0.0.0/8 -interface utun4"),
    /host network/,
  );
  assert.throws(
    () => assertCommandAllowed(manifest(["*"]), "networksetup -setwebproxy Wi-Fi 127.0.0.1 8080"),
    /host network/,
  );
});

test("assertCommandAllowed denies out-of-scope hosts", () => {
  assert.throws(
    () => assertCommandAllowed(manifest(["10.0.0.0/8"]), "curl -s https://example.com/"),
    /not in auth.targets/,
  );
  assert.doesNotThrow(() =>
    assertCommandAllowed(manifest(["10.0.0.0/8"]), "curl -s http://10.0.188.64/"),
  );
});

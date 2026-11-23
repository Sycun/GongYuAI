import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { openHistory } from "./index.js";

const TASK_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

function setup(prefix: string) {
  const root = mkdtempSync(join(tmpdir(), prefix));
  const evidenceDir = join(root, "evidence");
  mkdirSync(evidenceDir, { recursive: true });
  const store = openHistory({ dbPath: join(root, "history.sqlite"), evidenceDir });
  return { root, store };
}

test("host profile upserts per asset and dedupes fields", () => {
  const { root, store } = setup("gy-host-profile-");
  try {
    const first = store.recordHostProfile(TASK_ID, {
      asset: "https://10.0.0.5:8443/",
      hostname: "web01",
      os: "Ubuntu 22.04",
      domain: "lab.internal",
      users: ["www-data", "root", "www-data"],
      privileges: ["www-data", "sudo"],
      services: ["ssh:22", "http:8443"],
      shares: [],
      av: ["none"],
      evidencePath: "profiles/web01.txt",
    });
    assert.equal(first.asset, "10.0.0.5");
    assert.deepEqual(first.users, ["www-data", "root"]);
    assert.equal(first.source, "worker");

    const second = store.recordHostProfile(TASK_ID, {
      asset: "10.0.0.5",
      os: "Ubuntu 22.04",
      privileges: ["www-data", "sudo", "docker"],
      source: "enumerator",
    });
    assert.equal(second.id, first.id);
    assert.deepEqual(second.users, []); // omitted fields are replaced, not merged
    assert.deepEqual(second.privileges, ["www-data", "sudo", "docker"]);
    assert.equal(store.listHostProfiles(TASK_ID).length, 1);
    const kinds = store.listEvents(TASK_ID).map((e) => e.kind);
    assert.ok(kinds.includes("host_profile_recorded"));
    assert.match(store.observe(TASK_ID), /Foothold 主机画像/);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("host profile list orders by update and rejects empty asset", () => {
  const { root, store } = setup("gy-host-profile-2-");
  try {
    store.recordHostProfile(TASK_ID, { asset: "10.0.0.5", os: "linux" });
    store.recordHostProfile(TASK_ID, { asset: "10.0.0.6", os: "windows" });
    assert.equal(store.listHostProfiles(TASK_ID).length, 2);
    assert.equal(store.getHostProfile(TASK_ID, "10.0.0.6")?.os, "windows");
    assert.throws(() => store.recordHostProfile(TASK_ID, { asset: "   " }), /asset required/);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

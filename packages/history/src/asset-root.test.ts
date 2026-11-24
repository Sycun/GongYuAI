import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import { ORIGIN_FACT_ID } from "@gongyuai/contracts";
import { openHistory } from "./index.js";

const TASK = "77777777-7777-4777-8777-777777777777";

const AUTH = {
  targets: ["*.example.com", "10.0.0.0/8"],
  outOfScope: [] as string[],
  pivotPolicy: { mode: "off" as const, cidrs: [] as string[] },
};

function setup(prefix: string) {
  const root = mkdtempSync(join(tmpdir(), prefix));
  const evidenceDir = join(root, "evidence");
  mkdirSync(evidenceDir, { recursive: true });
  const store = openHistory({ dbPath: join(root, "history.sqlite"), evidenceDir });
  return { root, store };
}

test("asset_root 边界：前驱 Fact 已确认的资产（精确/父域/CIDR 覆盖）", () => {
  const { root, store } = setup("gy-root-fact-");
  try {
    const app = store.recordAsset({ taskId: TASK, address: "app.example.com", auth: AUTH, live: true });
    const exact = store.groundedAssetRoot(TASK, "app.example.com", [app.fact.id]);
    assert.deepEqual(exact, { ok: true, address: "app.example.com", matchedBy: "source-fact" });

    // 前驱是子域，根取父域：仍在已确认资产族内。
    const parent = store.groundedAssetRoot(TASK, "example.com", [app.fact.id]);
    assert.equal(parent.ok, true);
    if (parent.ok) assert.equal(parent.address, "example.com");

    // 前驱是 CIDR，根取其中具体主机：由 matchTarget 覆盖，不靠猜。
    const cidr = store.recordAsset({ taskId: TASK, address: "10.0.0.0/24", auth: AUTH });
    const inside = store.groundedAssetRoot(TASK, "10.0.0.5", [cidr.fact.id]);
    assert.equal(inside.ok, true);
    if (inside.ok) assert.equal(inside.matchedBy, "source-fact");

    // 公共后缀（单标签）不能承接子域事实当资产根。
    const publicSuffix = store.groundedAssetRoot(TASK, "com", [app.fact.id]);
    assert.equal(publicSuffix.ok, false);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("asset_root 边界：只有 origin 时回落到资产清单", () => {
  const { root, store } = setup("gy-root-inventory-");
  try {
    store.recordAsset({ taskId: TASK, address: "app.example.com", auth: AUTH, live: true });
    const grounded = store.groundedAssetRoot(TASK, "https://App.Example.com/login", [ORIGIN_FACT_ID]);
    assert.deepEqual(grounded, { ok: true, address: "app.example.com", matchedBy: "inventory" });
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("asset_root 边界：范围外资产、通配、CIDR、未登记主机全部拒绝", () => {
  const { root, store } = setup("gy-root-reject-");
  try {
    // 记录一个 oos 资产：位于清单里但不可作为利用 Intent 的根。
    store.recordAsset({ taskId: TASK, address: "192.0.2.7", auth: AUTH });
    const oos = store.groundedAssetRoot(TASK, "192.0.2.7", [ORIGIN_FACT_ID]);
    assert.equal(oos.ok, false);
    if (!oos.ok) assert.match(oos.reason, /范围外/);

    const wildcard = store.groundedAssetRoot(TASK, "*", [ORIGIN_FACT_ID]);
    assert.equal(wildcard.ok, false);

    const cidr = store.groundedAssetRoot(TASK, "172.16.0.0/24", [ORIGIN_FACT_ID]);
    assert.equal(cidr.ok, false);

    const invented = store.groundedAssetRoot(TASK, "invented.example.org", [ORIGIN_FACT_ID]);
    assert.equal(invented.ok, false);
    if (!invented.ok) assert.match(invented.reason, /未被前驱 Fact 或资产清单确认/);

    const empty = store.groundedAssetRoot(TASK, "   ", [ORIGIN_FACT_ID]);
    assert.equal(empty.ok, false);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

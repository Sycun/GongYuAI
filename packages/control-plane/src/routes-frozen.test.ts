import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TaskCoordinatesSchema } from "@gongyuai/contracts";
import { bootControlPlane, parseTaskCoordinates, taskCoordinatesDigest } from "./index.js";
import { areFrozenRoutesEnabled } from "./routes-ops.js";

test("TaskCoordinates 契约与单兵坐标摘要保持清晰语义与向后兼容", () => {
  const coords = TaskCoordinatesSchema.parse({
    targets: ["app.lab.test", "10.0.0.0/24"],
    outOfScope: ["admin.lab.test"],
    capability: "active-lab",
    roe: "优先审计认证与越权链路",
  });
  assert.deepEqual(coords.targets, ["app.lab.test", "10.0.0.0/24"]);
  assert.equal(coords.capability, "active-lab");

  const parsed = parseTaskCoordinates("目标：api.lab.test；排除：pay.lab.test；能力：scan");
  assert.deepEqual(parsed, {
    targets: ["api.lab.test"],
    outOfScope: ["pay.lab.test"],
    capability: "scan",
  });

  const digest = taskCoordinatesDigest({ auth: coords, scopeVersion: 2 });
  assert.equal(digest, "scope#v2/app.lab.test、10.0.0.0/24/排除:admin.lab.test/active-lab");
});

test("GY_DISABLE_FROZEN_ROUTES=1 一键关闭冻结支线与模拟路由，不影响活跃红队路由", async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), "gy-frozen-routes-"));
  const prev = process.env.GY_DISABLE_FROZEN_ROUTES;
  const cp = await bootControlPlane({ dataRoot, port: 0, isolated: true });
  try {
    const createRes = await fetch(`${cp.url}/tasks`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "frozen-route-gate-check",
        mock: true,
        auth: { targets: ["target.lab.test"], capability: "scan" },
        goals: [
          {
            id: "g1",
            title: "Verify surface",
            description: "Collect initial surface note",
            evidencePatterns: ["notes/*.txt"],
          },
        ],
      }),
    });
    assert.equal(createRes.status, 201);
    const created = (await createRes.json()) as { task: { id: string } };
    const taskId = created.task.id;

    // 默认开启冻结兼容路由
    delete process.env.GY_DISABLE_FROZEN_ROUTES;
    assert.equal(areFrozenRoutesEnabled(), true);
    const simDefault = await fetch(`${cp.url}/tasks/${taskId}/model-request`, { method: "POST" });
    assert.equal(simDefault.status, 200);
    const proposalsDefault = await fetch(`${cp.url}/proposals`);
    assert.equal(proposalsDefault.status, 200);

    // 开启纯净单兵开关后，冻结与模拟路由全部离线（404），但活跃红队路由依然正常响应
    process.env.GY_DISABLE_FROZEN_ROUTES = "1";
    assert.equal(areFrozenRoutesEnabled(), false);

    const simDisabled = await fetch(`${cp.url}/tasks/${taskId}/model-request`, { method: "POST" });
    assert.equal(simDisabled.status, 404);
    const proposalsDisabled = await fetch(`${cp.url}/proposals`);
    assert.equal(proposalsDisabled.status, 404);
    const memGraphDisabled = await fetch(`${cp.url}/tasks/${taskId}/graphs/memory`);
    assert.equal(memGraphDisabled.status, 404);

    const todayActive = await fetch(`${cp.url}/today`);
    assert.equal(todayActive.status, 200);
    const auditActive = await fetch(`${cp.url}/tasks/${taskId}/audit`);
    assert.equal(auditActive.status, 200);
    const chainActive = await fetch(`${cp.url}/tasks/${taskId}/chain`);
    assert.equal(chainActive.status, 200);
  } finally {
    if (prev === undefined) delete process.env.GY_DISABLE_FROZEN_ROUTES;
    else process.env.GY_DISABLE_FROZEN_ROUTES = prev;
    await cp.close();
    rmSync(dataRoot, { recursive: true, force: true });
  }
});

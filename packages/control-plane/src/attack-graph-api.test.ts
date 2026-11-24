import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { CreateTaskRequestSchema } from "@gongyuai/contracts";
import { openHistory } from "@gongyuai/history";
import { bootControlPlane, taskPaths } from "./index.js";

async function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), "gy-attack-api-"));
  const plane = await bootControlPlane({
    dataRoot: root,
    host: "127.0.0.1",
    port: 0,
    runtime: "local",
    watchdogMs: 60_000,
    isolated: true,
  });
  t.after(async () => {
    await plane.close();
    rmSync(root, { recursive: true, force: true });
  });
  const task = plane.store.createTask(CreateTaskRequestSchema.parse({
    name: "P17 attack graph",
    auth: { targets: ["lab.test"], authorizationNote: "P17 local fixture" },
    goals: [{ id: "g1", title: "cover", description: "P17", evidencePatterns: ["*"] }],
    mock: true,
  }));
  const paths = taskPaths(task.dataDir);
  const history = openHistory({ dbPath: paths.historyDb, evidenceDir: paths.evidenceDir });
  history.seedGoals(task.id, task.goals);
  history.recordAttackNode(task.id, { id: "U1", kind: "ad-user", name: "alice", owned: true });
  history.recordAttackNode(task.id, { id: "G1", kind: "ad-group", name: "Domain Admins" });
  history.recordAttackEdge(task.id, { from: "U1", to: "G1", kind: "member-of" });
  history.recordAttackNode(task.id, { id: "arn:aws:s3:::x", kind: "cloud-resource", name: "x", provider: "aws" });
  history.close();
  return { plane, task, base: plane.url + "/tasks/" + task.id };
}

test("GET /tasks/:id/graphs/ad returns typed nodes/edges and DA paths", async (t) => {
  const { task, base } = await fixture(t);
  const res = await fetch(`${base}/graphs/ad`);
  assert.equal(res.status, 200);
  const body = await res.json() as {
    view: string;
    nodes: Array<{ id: string; kind: string }>;
    edges: Array<{ from: string; to: string; kind: string }>;
    paths: Array<{ nodes: string[]; depth: number }>;
  };
  assert.equal(body.view, "ad");
  assert.equal(body.nodes.length, 2);
  assert.equal(body.edges.length, 1);
  assert.equal(body.paths.length, 1);
  assert.deepEqual(body.paths[0]!.nodes, ["U1", "G1"]);

  const cloud = await fetch(`${base}/graphs/cloud`);
  assert.equal(cloud.status, 200);
  const cloudBody = await cloud.json() as { nodes: Array<{ kind: string; provider?: string }> };
  assert.equal(cloudBody.nodes.length, 1);
  assert.equal(cloudBody.nodes[0]!.kind, "cloud-resource");
  assert.equal(cloudBody.nodes[0]!.provider, "aws");
  assert.ok(task.id);
});

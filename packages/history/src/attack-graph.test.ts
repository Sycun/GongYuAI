import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { openHistory } from "./index.js";

function setup(prefix: string) {
  const root = mkdtempSync(join(tmpdir(), prefix));
  const evidenceDir = join(root, "evidence");
  mkdirSync(evidenceDir, { recursive: true });
  const store = openHistory({ dbPath: join(root, "history.sqlite"), evidenceDir });
  return { root, store };
}

test("AD nodes/edges are Fact-backed and paths are derived, not stored", () => {
  const { root, store } = setup("gy-attack-");
  const taskId = randomUUID();
  try {
    store.recordAttackNode(taskId, { id: "U1", kind: "ad-user", name: "alice", owned: true });
    store.recordAttackNode(taskId, { id: "G1", kind: "ad-group", name: "Helpdesk" });
    store.recordAttackNode(taskId, { id: "G2", kind: "ad-group", name: "Domain Admins" });
    store.recordAttackEdge(taskId, { from: "U1", to: "G1", kind: "member-of" });
    store.recordAttackEdge(taskId, { from: "G1", to: "G2", kind: "generic-all" });

    const graph = store.attackGraph(taskId);
    assert.equal(graph.nodes.length, 3);
    assert.equal(graph.edges.length, 2);
    assert.ok(graph.nodes.every((node) => node.factId));
    assert.ok(graph.edges.every((edge) => edge.factId));

    const paths = store.attackPaths(taskId);
    assert.equal(paths.length, 1);
    assert.deepEqual(paths[0]!.nodes, ["U1", "G1", "G2"]);
    assert.equal(paths[0]!.depth, 2);

    // The graph is a projection: the backing Facts are plain title-layer Facts.
    const attackFacts = store.listFacts(taskId).filter((fact) => fact.tags.includes("attack.node") || fact.tags.includes("attack.edge"));
    assert.equal(attackFacts.length, 5);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

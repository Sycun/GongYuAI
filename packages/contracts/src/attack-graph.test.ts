import assert from "node:assert/strict";
import { test } from "node:test";
import {
  attackEdgeTags,
  attackNodeTags,
  buildAttackGraph,
  cloudEdge,
  cloudNode,
  findAttackPaths,
  parseBloodHound,
  type AttackNode,
} from "./attack-graph.js";

const fact = (id: string, tags: string[]) => ({ id, tags });

test("Fact-tagged AD graph finds a path from an owned user to Domain Admins", () => {
  const alice: AttackNode = { id: "S-1-5-21-1001", kind: "ad-user", name: "alice", domain: "corp.local", owned: true };
  const helpdesk: AttackNode = { id: "S-1-5-21-2001", kind: "ad-group", name: "Helpdesk", domain: "corp.local" };
  const da: AttackNode = { id: "S-1-5-21-512", kind: "ad-group", name: "Domain Admins", domain: "corp.local" };
  const graph = buildAttackGraph([
    fact("f1", attackNodeTags(alice)),
    fact("f2", attackNodeTags(helpdesk)),
    fact("f3", attackNodeTags(da)),
    fact("e1", attackEdgeTags({ from: alice.id, to: helpdesk.id, kind: "member-of" })),
    fact("e2", attackEdgeTags({ from: helpdesk.id, to: da.id, kind: "generic-all" })),
  ]);
  assert.equal(graph.nodes.length, 3);
  assert.equal(graph.edges.length, 2);
  const paths = findAttackPaths(graph);
  assert.equal(paths.length, 1);
  assert.deepEqual(paths[0]!.nodes, [alice.id, helpdesk.id, da.id]);
  assert.deepEqual(paths[0]!.edges, ["member-of", "generic-all"]);
  assert.equal(paths[0]!.depth, 2);
});

test("BloodHound JSON imports users/groups/computers, Members/Aces/Sessions", () => {
  const data = {
    users: [
      { ObjectIdentifier: "U1", Properties: { name: "alice@CORP.LOCAL", domain: "CORP.LOCAL", owned: true } },
      { ObjectIdentifier: "U2", Properties: { name: "bob@CORP.LOCAL", domain: "CORP.LOCAL" } },
    ],
    groups: [
      { ObjectIdentifier: "G1", Properties: { name: "HELPDESK@CORP.LOCAL", domain: "CORP.LOCAL" }, Members: [{ ObjectIdentifier: "U1" }] },
      { ObjectIdentifier: "G2", Properties: { name: "DOMAIN ADMINS@CORP.LOCAL", domain: "CORP.LOCAL" }, Members: [{ ObjectIdentifier: "G1" }] },
    ],
    computers: [
      { ObjectIdentifier: "C1", Properties: { name: "DC01.CORP.LOCAL", domain: "CORP.LOCAL" }, Sessions: [{ UserSID: "U2" }], LocalAdmins: [{ ObjectIdentifier: "G2" }] },
    ],
  };
  const imported = parseBloodHound(data);
  assert.equal(imported.skipped, false);
  assert.equal(imported.nodes.length, 5);
  assert.ok(imported.edges.some((edge) => edge.from === "U1" && edge.to === "G1" && edge.kind === "member-of"));
  assert.ok(imported.edges.some((edge) => edge.from === "G1" && edge.to === "G2" && edge.kind === "member-of"));
  assert.ok(imported.edges.some((edge) => edge.from === "U2" && edge.to === "C1" && edge.kind === "has-session"));
  assert.ok(imported.edges.some((edge) => edge.from === "G2" && edge.to === "C1" && edge.kind === "admin-to"));

  const graph = buildAttackGraph(
    [
      ...imported.nodes.map((node, index) => fact(`n${index}`, attackNodeTags(node))),
      ...imported.edges.map((edge, index) => fact(`e${index}`, attackEdgeTags(edge))),
    ],
  );
  const paths = findAttackPaths(graph);
  assert.ok(paths.some((path) => path.nodes.at(-1) === "G2" && path.depth === 2), JSON.stringify(paths));
});

test("cloud nodes/edges project and cloud paths are bounded", () => {
  const user = cloudNode({ id: "arn:aws:iam::1:user/alice", kind: "cloud-role", name: "alice", provider: "aws", account: "1" });
  const role = cloudNode({ id: "arn:aws:iam::1:role/admin", kind: "cloud-role", name: "admin", provider: "aws", account: "1" });
  const bucket = cloudNode({ id: "arn:aws:s3:::secret", kind: "cloud-resource", name: "secret", provider: "aws", account: "1" });
  const graph = buildAttackGraph([
    fact("n1", [...attackNodeTags(user), "attack.node.owned:true"]),
    fact("n2", attackNodeTags(role)),
    fact("n3", attackNodeTags(bucket)),
    fact("e1", attackEdgeTags(cloudEdge({ from: user.id, to: role.id, kind: "assume-role" }))),
    fact("e2", attackEdgeTags(cloudEdge({ from: role.id, to: bucket.id, kind: "can-access" }))),
  ]);
  assert.equal(graph.nodes.length, 3);
  assert.equal(graph.edges.length, 2);
  const paths = findAttackPaths(graph, { from: [user.id], targets: [bucket.id], maxPaths: 1 });
  assert.equal(paths.length, 1);
  assert.deepEqual(paths[0]!.edges, ["assume-role", "can-access"]);
});

test("unknown BloodHound shape is a skip, not a guess", () => {
  const imported = parseBloodHound({ hello: "world" });
  assert.equal(imported.skipped, true);
  assert.equal(imported.nodes.length, 0);
});

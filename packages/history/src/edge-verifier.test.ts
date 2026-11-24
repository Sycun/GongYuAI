import assert from "node:assert/strict";
import { test } from "node:test";
import {
  applyCausalVerdict,
  artifact,
  artifactsFromTags,
  evidenceArtifacts,
  normalizeEndpointValue,
  sharedArtifacts,
  summarizeCausalEdges,
  verifyCausalEdge,
  type CausalNodeRef,
} from "./edge-verifier.js";
import type { GraphEdge } from "@gongyuai/contracts";

const T0 = "2026-11-24T00:00:00.000Z";
const T1 = "2026-11-24T00:01:00.000Z";
const T2 = "2026-11-24T00:02:00.000Z";

function node(
  id: string,
  createdAt: string,
  overrides: Partial<CausalNodeRef> = {},
): CausalNodeRef {
  return { id, createdAt, references: [], artifacts: [], ...overrides };
}

test("proven：共享资产指纹 + 时序单调（Fact → Intent）", () => {
  const fact = node("fact-1", T0, {
    artifacts: [artifact("asset", "10.0.0.9")!],
  });
  const intent = node("intent-1", T1, {
    artifacts: [artifact("asset", "10.0.0.9")!],
  });
  const verdict = verifyCausalEdge({ kind: "fact->intent", from: fact, to: intent });
  assert.equal(verdict.verification, "proven");
  assert.equal(verdict.abstentionReason, null);
  assert.equal(verdict.proof.rule, "shared-artifact");
  assert.deepEqual(verdict.proof.sharedArtifacts, ["asset:10.0.0.9"]);
});

test("proven：共享凭据 id（凭据 Fact → 横向 Intent）", () => {
  const from = node("cred-fact", T0, {
    artifacts: [artifact("credential", "Credential-ABC")!],
  });
  const to = node("intent-lateral", T1, {
    artifacts: [artifact("credential", "credential-abc")!],
  });
  const verdict = verifyCausalEdge({ kind: "fact->intent", from, to });
  assert.equal(verdict.verification, "proven");
  assert.deepEqual(verdict.proof.sharedArtifacts, ["credential:credential-abc"]);
});

test("proven：显式引用 sourceFactIds（无共享指纹也算有据）", () => {
  const fact = node("fact-1", T0);
  const intent = node("intent-1", T1, { references: ["fact-1"] });
  const verdict = verifyCausalEdge({ kind: "fact->intent", from: fact, to: intent });
  assert.equal(verdict.verification, "proven");
  assert.equal(verdict.proof.rule, "reference");
  assert.equal(verdict.proof.referenced, true);
  assert.deepEqual(verdict.proof.sharedArtifacts, []);
});

test("proposed + timestamp_inversion：前驱晚于后继，引用再多也不洗白", () => {
  const fact = node("fact-1", T2, {
    artifacts: [artifact("asset", "app.example.com")!],
  });
  const intent = node("intent-1", T1, {
    references: ["fact-1"],
    artifacts: [artifact("asset", "app.example.com")!],
  });
  const verdict = verifyCausalEdge({ kind: "fact->intent", from: fact, to: intent });
  assert.equal(verdict.verification, "proposed");
  assert.equal(verdict.abstentionReason, "timestamp_inversion");
  assert.equal(verdict.proof.referenced, true);
});

test("proposed + missing_shared_artifact：时间正常但没有共同对象", () => {
  const fact = node("fact-1", T0, {
    artifacts: [artifact("asset", "a.example.com")!],
  });
  const finding = node("finding-1", T2, {
    artifacts: [artifact("asset", "b.example.com")!, artifact("endpoint", "/login")!],
  });
  const verdict = verifyCausalEdge({ kind: "fact->finding", from: fact, to: finding });
  assert.equal(verdict.verification, "proposed");
  assert.equal(verdict.abstentionReason, "missing_shared_artifact");
  assert.deepEqual(verdict.proof.sharedArtifacts, []);
});

test("proposed + ungrounded_reference：端点缺失 / 自指边", () => {
  const present = node("fact-1", T0);
  const missingEnd = verifyCausalEdge({ kind: "fact->intent", from: present, to: null });
  assert.equal(missingEnd.verification, "proposed");
  assert.equal(missingEnd.abstentionReason, "ungrounded_reference");

  const missingFrom = verifyCausalEdge({ kind: "intent->fact", from: null, to: present });
  assert.equal(missingFrom.abstentionReason, "ungrounded_reference");

  const self = verifyCausalEdge({ kind: "finding->finding", from: present, to: present });
  assert.equal(self.abstentionReason, "ungrounded_reference");
});

test("proposed + missing_timestamp：时间不可解析就不许证明", () => {
  const from = node("fact-1", "not-a-date");
  const to = node("intent-1", T1, { references: ["fact-1"] });
  const verdict = verifyCausalEdge({ kind: "fact->intent", from, to });
  assert.equal(verdict.verification, "proposed");
  assert.equal(verdict.abstentionReason, "missing_timestamp");
});

test("finding → finding：共享证据 SHA-256 证明，时间倒挂则弃证", () => {
  const sha = "a".repeat(64);
  const earlier = node("finding-a", T1, {
    artifacts: [artifact("sha256", sha)!, artifact("asset", "app.example.com")!],
  });
  const later = node("finding-b", T2, {
    artifacts: [artifact("sha256", sha)!, artifact("asset", "app.example.com")!],
  });
  const proven = verifyCausalEdge({ kind: "finding->finding", from: earlier, to: later });
  assert.equal(proven.verification, "proven");
  assert.equal(proven.proof.rule, "shared-artifact");

  const inverted = verifyCausalEdge({ kind: "finding->finding", from: later, to: earlier });
  assert.equal(inverted.verification, "proposed");
  assert.equal(inverted.abstentionReason, "timestamp_inversion");
});

test("确定性：共享指纹排序去重、重复调用同结果、不改输入", () => {
  const from = node("fact-1", T0, {
    artifacts: [
      artifact("asset", "Z.example.com")!,
      artifact("asset", "z.example.com")!,
      artifact("traffic", "http:AAAA")!,
    ],
  });
  const to = node("intent-1", T1, {
    artifacts: [
      artifact("traffic", "aaaa")!,
      artifact("asset", "z.example.com")!,
    ],
  });
  const first = verifyCausalEdge({ kind: "fact->intent", from, to });
  const second = verifyCausalEdge({ kind: "fact->intent", from, to });
  assert.deepEqual(first, second);
  assert.deepEqual(first.proof.sharedArtifacts, ["asset:z.example.com", "traffic:aaaa"]);
  // 输入没有被排序/去重副作用改写。
  assert.equal(from.artifacts?.length, 3);
  assert.equal(to.artifacts?.length, 2);
});

test("指纹归一化：资产 URL / 端点路径 / http:<id> / 非法 sha256", () => {
  assert.equal(artifact("asset", "https://App.Example.com/login?a=1")!.value, "app.example.com");
  assert.equal(artifact("asset", "10.0.0.0/24")!.value, "10.0.0.0/24");
  assert.equal(artifact("endpoint", "https://app.example.com/login?user=1#frag")!.value, "/login?user=1");
  assert.equal(normalizeEndpointValue("/login/"), "/login");
  assert.equal(normalizeEndpointValue("/"), "/");
  assert.equal(artifact("traffic", "http:DEAD-BEEF")!.value, "dead-beef");
  assert.equal(artifact("sha256", "not-a-hash"), null);
  assert.equal(artifact("sha256", "A".repeat(64))!.value, "a".repeat(64));
  assert.equal(artifact("evidence", "./findings\\sqli.txt")!.value, "findings/sqli.txt");
});

test("标签与证据引用抽取：只认显式写入，不猜", () => {
  const fromTags = artifactsFromTags([
    "asset",
    "asset.addr:https://app.example.com/x",
    "credential.id:Cred-1",
    "family:web-login",
  ]);
  assert.deepEqual(
    fromTags.map((entry) => `${entry.kind}:${entry.value}`),
    ["asset:app.example.com", "endpoint:/x", "credential:cred-1"],
  );
  const fromEvidence = evidenceArtifacts([
    { path: "http:0b7c", sha256: "b".repeat(64) },
    { path: "oast:token-1" },
    { path: "findings/sqli.txt", sha256: "bad" },
  ]);
  assert.deepEqual(
    fromEvidence.map((entry) => `${entry.kind}:${entry.value}`),
    ["traffic:0b7c", `sha256:${"b".repeat(64)}`, "evidence:oast:token-1", "evidence:findings/sqli.txt"],
  );
  assert.deepEqual(sharedArtifacts(fromTags, fromEvidence), []);
});

test("applyCausalVerdict：proposed 写 abstentionReason，ungrounded 才标 broken", () => {
  const edge: GraphEdge = { id: "e1", from: "a", to: "b", kind: "anchors", label: "", broken: false };
  const inversion = applyCausalVerdict(edge, verifyCausalEdge({
    kind: "fact->intent",
    from: node("a", T2),
    to: node("b", T1),
  }));
  assert.equal(inversion.verification, "proposed");
  assert.equal(inversion.abstentionReason, "timestamp_inversion");
  assert.equal(inversion.broken, false);

  const ungrounded = applyCausalVerdict(edge, verifyCausalEdge({
    kind: "fact->intent",
    from: null,
    to: node("b", T1),
  }));
  assert.equal(ungrounded.abstentionReason, "ungrounded_reference");
  assert.equal(ungrounded.broken, true);

  const proven = applyCausalVerdict(edge, verifyCausalEdge({
    kind: "fact->intent",
    from: node("a", T0),
    to: node("b", T1, { references: ["a"] }),
  }));
  assert.equal(proven.verification, "proven");
  assert.equal("abstentionReason" in proven, false);
});

test("summarizeCausalEdges：按 reason 计数，未校验边不计入", () => {
  const edges: GraphEdge[] = [
    { id: "1", from: "a", to: "b", kind: "anchors", label: "", broken: false, verification: "proven" },
    {
      id: "2", from: "c", to: "d", kind: "produces", label: "", broken: false,
      verification: "proposed", abstentionReason: "timestamp_inversion",
    },
    {
      id: "3", from: "e", to: "f", kind: "yields", label: "", broken: true,
      verification: "proposed", abstentionReason: "ungrounded_reference",
    },
    { id: "4", from: "g", to: "h", kind: "asserted-by", label: "", broken: false },
  ];
  const summary = summarizeCausalEdges(edges);
  assert.equal(summary.total, 3);
  assert.equal(summary.proven, 1);
  assert.equal(summary.proposed, 2);
  assert.equal(summary.byReason.timestamp_inversion, 1);
  assert.equal(summary.byReason.ungrounded_reference, 1);
  assert.equal(summary.byReason.missing_shared_artifact, 0);
});

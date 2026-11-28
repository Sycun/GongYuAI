import assert from "node:assert/strict";
import { test } from "node:test";
import {
  deriveEngagementAudit,
  formatEngagementAuditSummary,
  type EngagementAuditAsset,
  type EngagementAuditCredential,
  type EngagementAuditFinding,
  type EngagementAuditIntent,
} from "./engagement-audit.js";

const NOW = "2026-11-24T00:00:00.000Z";
const NOW_MS = Date.parse(NOW);
const ago = (minutesAgo: number) =>
  new Date(NOW_MS - minutesAgo * 60_000).toISOString();

const asset = (
  address: string,
  weight = 0,
  assetType: string | null = "domain",
  kind = "live",
): EngagementAuditAsset => ({ address, kind, weight, assetType });

const intent = (
  id: string,
  technique: string | null,
  assetRoot: string | null,
  status: string,
  minutesAgo = 10,
  updatedMinutesAgo = minutesAgo,
): EngagementAuditIntent => ({
  id,
  title: `${technique ?? "misc"} @ ${assetRoot ?? "none"}`,
  technique,
  assetRoot,
  status,
  createdAt: ago(minutesAgo),
  updatedAt: ago(updatedMinutesAgo),
  concludedAt: status === "failed" || status === "succeeded" ? ago(updatedMinutesAgo) : null,
});

const finding = (
  id: string,
  status: string,
  overrides: Partial<EngagementAuditFinding> = {},
): EngagementAuditFinding => ({
  id,
  asset: "lab.example.com",
  vulnClass: "CWE-89",
  status,
  severity: "high",
  createdAt: ago(10),
  verifiedAt: status === "verified" ? ago(5) : null,
  evidence: [],
  ...overrides,
});

test("healthy engagement: no observations, confirmed findings and no gaps", () => {
  const audit = deriveEngagementAudit({
    now: NOW,
    assets: [asset("lab.example.com"), asset("api.example.com", 4)],
    intents: [
      intent("i1", "CWE-89", "lab.example.com", "succeeded"),
      intent("i2", "AUTHZ-BOLA", "api.example.com", "succeeded"),
    ],
    findings: [finding("f1", "verified", { independentConfirmed: true })],
    credentials: [],
  });
  assert.deepEqual(audit.observations, []);
  assert.equal(audit.scorecard.assets.total, 2);
  assert.equal(audit.scorecard.assets.untouched, 0);
  assert.equal(audit.scorecard.findings.confirmationRate, 1);
  assert.equal(audit.scorecard.findings.independentlyConfirmed, 1);
  assert.equal(audit.scorecard.findings.independentRate, 1);
  assert.deepEqual(audit.scorecard.findings.gaps, []);
});

test("repeat failure: three trailing failures on one technique/asset root", () => {
  const audit = deriveEngagementAudit({
    now: NOW,
    assets: [asset("lab.example.com")],
    intents: [
      intent("ok", "CWE-89", "lab.example.com", "succeeded", 40),
      intent("f1", "CWE-89", "lab.example.com", "failed", 30),
      intent("f2", "CWE-89", "lab.example.com", "failed", 20),
      intent("f3", "CWE-89", "lab.example.com", "failed", 10),
    ],
    findings: [],
  });
  const repeat = audit.observations.find((item) => item.code === "repeat-failure");
  assert.ok(repeat, "repeat-failure should fire");
  assert.equal(repeat.severity, "warn");
  assert.deepEqual(repeat.refs, ["f1", "f2", "f3"]);
  assert.match(repeat.text, /连续失败 3 次/);
});

test("repeat failure does not fire after a success resets the trailing run", () => {
  const audit = deriveEngagementAudit({
    now: NOW,
    assets: [asset("lab.example.com")],
    intents: [
      intent("f1", "CWE-89", "lab.example.com", "failed", 40),
      intent("f2", "CWE-89", "lab.example.com", "failed", 30),
      intent("ok", "CWE-89", "lab.example.com", "succeeded", 20),
      intent("f3", "CWE-89", "lab.example.com", "failed", 10),
    ],
    findings: [],
  });
  assert.equal(
    audit.observations.some((item) => item.code === "repeat-failure"),
    false,
  );
});

test("duplicate open: two open Intents with the same technique and asset root", () => {
  const audit = deriveEngagementAudit({
    now: NOW,
    assets: [asset("lab.example.com")],
    intents: [
      intent("a", "CWE-79", "lab.example.com", "claimed", 10, 1),
      intent("b", "CWE-79", "lab.example.com", "proposed", 5, 1),
    ],
    findings: [],
  });
  const dup = audit.observations.find((item) => item.code === "duplicate-open");
  assert.ok(dup);
  assert.deepEqual(dup.refs.sort(), ["a", "b"]);
});

test("stalled intent: claimed with no update past the threshold", () => {
  const audit = deriveEngagementAudit({
    now: NOW,
    assets: [asset("lab.example.com")],
    intents: [intent("s", "CWE-89", "lab.example.com", "claimed", 90, 60)],
    findings: [],
  });
  const stalled = audit.observations.find((item) => item.code === "stalled-intent");
  assert.ok(stalled);
  assert.match(stalled.text, /60 分钟无更新/);
});

test("tentative backlog: three unverified leads are surfaced", () => {
  const audit = deriveEngagementAudit({
    now: NOW,
    assets: [asset("lab.example.com")],
    intents: [intent("i", "CWE-89", "lab.example.com", "succeeded")],
    findings: [
      finding("t1", "tentative"),
      finding("t2", "tentative"),
      finding("t3", "tentative"),
    ],
  });
  const backlog = audit.observations.find(
    (item) => item.code === "tentative-backlog",
  );
  assert.ok(backlog);
  assert.equal(audit.scorecard.findings.tentative, 3);
  assert.equal(audit.scorecard.findings.confirmed, 0);
  assert.equal(audit.scorecard.findings.confirmationRate, 0);
  assert.ok(
    audit.scorecard.findings.gaps.some((gap) => gap.includes("tentative")),
  );
});

test("unexplored high-weight host is named and counted as a gap", () => {
  const audit = deriveEngagementAudit({
    now: NOW,
    assets: [
      asset("lab.example.com"),
      asset("core.example.com", 5),
      asset("core.example.com/api", 5, "endpoint"),
    ],
    intents: [intent("i", "CWE-89", "lab.example.com", "succeeded")],
    findings: [],
  });
  const gap = audit.observations.find((item) => item.code === "unexplored-asset");
  assert.ok(gap);
  assert.equal(gap.severity, "warn");
  assert.deepEqual(gap.refs, ["core.example.com"]);
  assert.equal(audit.scorecard.assets.untouched, 1);
  assert.ok(
    audit.scorecard.findings.gaps.some((entry) => entry.includes("未测")),
  );
});

test("endpoint assets do not create phantom untouched hosts", () => {
  const audit = deriveEngagementAudit({
    now: NOW,
    assets: [
      asset("lab.example.com"),
      asset("lab.example.com/login", 0, "endpoint"),
    ],
    intents: [intent("i", "CWE-89", "lab.example.com", "succeeded")],
    findings: [],
  });
  assert.equal(
    audit.observations.some((item) => item.code === "unexplored-asset"),
    false,
  );
});

test("idle verified credential is a suggestion, not a warning", () => {
  const credentials: EngagementAuditCredential[] = [
    {
      id: "c1",
      asset: "lab.example.com",
      kind: "password",
      reuseCount: 0,
      verifiedAt: ago(20),
    },
  ];
  const audit = deriveEngagementAudit({
    now: NOW,
    assets: [asset("lab.example.com"), asset("api.example.com")],
    intents: [
      intent("i1", "CWE-89", "lab.example.com", "succeeded"),
      intent("i2", "AUTHZ-BOLA", "api.example.com", "succeeded"),
    ],
    findings: [finding("f1", "verified")],
    credentials,
  });
  const idle = audit.observations.find((item) => item.code === "idle-credential");
  assert.ok(idle);
  assert.equal(idle.severity, "info");
});

test("L1 unverified credentials are an info hint and do not replace idle-credential", () => {
  const credentials: EngagementAuditCredential[] = [
    {
      id: "c1",
      asset: "lab.example.com",
      kind: "password",
      reuseCount: 0,
      verifiedAt: ago(20),
      tier: "L2",
    },
    {
      id: "c2",
      asset: "api.example.com",
      kind: "token",
      reuseCount: 0,
      verifiedAt: null,
      tier: "L1",
    },
  ];
  const audit = deriveEngagementAudit({
    now: NOW,
    assets: [asset("lab.example.com"), asset("api.example.com")],
    intents: [
      intent("i1", "CWE-89", "lab.example.com", "succeeded"),
      intent("i2", "AUTHZ-BOLA", "api.example.com", "succeeded"),
    ],
    findings: [finding("f1", "verified")],
    credentials,
  });
  const idle = audit.observations.find((item) => item.code === "idle-credential");
  const unverified = audit.observations.find((item) => item.code === "l1-unverified");
  assert.ok(idle);
  assert.equal(idle.severity, "info");
  assert.ok(unverified);
  assert.equal(unverified.severity, "info");
  assert.deepEqual(unverified.refs, ["c2"]);
});

test("empty ledger is a gap, not a clean target", () => {
  const audit = deriveEngagementAudit({
    now: NOW,
    assets: [asset("lab.example.com")],
    intents: [intent("i", "CWE-89", "lab.example.com", "failed")],
    findings: [],
  });
  assert.equal(audit.scorecard.findings.total, 0);
  assert.equal(audit.scorecard.findings.confirmationRate, null);
  assert.ok(
    audit.scorecard.findings.gaps.some((gap) => gap.includes("空台账")),
  );
});

test("scorecard counts retracted findings and reports the confirmation rate", () => {
  const audit = deriveEngagementAudit({
    now: NOW,
    assets: [asset("lab.example.com")],
    intents: [intent("i", "CWE-89", "lab.example.com", "succeeded")],
    findings: [
      finding("v1", "verified"),
      finding("t1", "tentative"),
      finding("t2", "tentative"),
      finding("r1", "retracted", { vulnClass: "CWE-79" }),
    ],
  });
  assert.equal(audit.scorecard.findings.confirmed, 1);
  assert.equal(audit.scorecard.findings.tentative, 2);
  assert.equal(audit.scorecard.findings.contradicted, 1);
  assert.equal(audit.scorecard.findings.confirmationRate, 0.25);
  assert.ok(
    audit.scorecard.findings.gaps.some((gap) => gap.includes("已撤回")),
  );
});

test("formatEngagementAuditSummary renders counts, rate and gaps", () => {
  const audit = deriveEngagementAudit({
    now: NOW,
    assets: [asset("lab.example.com"), asset("core.example.com", 5)],
    intents: [intent("i", "CWE-89", "lab.example.com", "succeeded")],
    findings: [finding("v1", "verified")],
  });
  const text = formatEngagementAuditSummary(audit);
  assert.match(text, /资产 2/);
  assert.match(text, /确认率 100%/);
  assert.match(text, /缺口：1 个在范围主机未测/);
});

test("shallow-failure flags single-attempt failed surfaces abandoned while other targets advance", () => {
  const audit = deriveEngagementAudit({
    now: NOW,
    assets: [asset("edr.example.com", 5), asset("portal.example.com", 3)],
    intents: [
      intent("i-edr-1", "evasion-probe", "edr.example.com", "failed"),
      intent("i-portal-1", "ssrf", "portal.example.com", "succeeded"),
      intent("i-portal-2", "lateral", "portal.example.com", "failed"),
    ],
    findings: [finding("f-portal", "verified", { asset: "portal.example.com" })],
  });
  const shallow = audit.observations.find((item) => item.code === "shallow-failure");
  assert.ok(shallow, "expected shallow-failure observation");
  assert.equal(shallow.severity, "warn");
  assert.match(shallow.text, /edr\.example\.com/);
  assert.deepEqual(shallow.refs, ["i-edr-1"]);
});

import { linkSync, mkdtempSync, mkdirSync, readFileSync, symlinkSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import { ORIGIN_FACT_ID } from "@gongyuai/contracts";
import { openHistory, readEvidenceFile, writeEvidenceFile } from "./index.js";

test("evidence gate blocks pass without files", () => {
  const root = mkdtempSync(join(tmpdir(), "gy-hist-"));
  const evidenceDir = join(root, "evidence");
  mkdirSync(evidenceDir, { recursive: true });
  const store = openHistory({
    dbPath: join(root, "history.sqlite"),
    evidenceDir,
  });
  const taskId = "11111111-1111-4111-8111-111111111111";
  const initial = [
    {
      id: "recon",
      title: "Recon",
      description: "Collect banner",
      evidencePatterns: ["recon/*.txt"],
      passes: false,
      evidencePaths: [],
      assertedAt: null,
    },
  ];
  store.seedGoals(taskId, initial);

  const blocked = store.assertGoal(taskId, "recon", ["recon/banner.txt"]);
  assert.equal(blocked.ok, false);

  mkdirSync(join(evidenceDir, "recon"), { recursive: true });
  writeFileSync(join(evidenceDir, "recon", "banner.txt"), "nginx/1.0\n");

  const ok = store.assertGoal(taskId, "recon", ["recon/banner.txt"]);
  assert.equal(ok.ok, true);
  if (ok.ok) assert.equal(ok.goal.passes, true);
  assert.equal(store.allGoalsPass(taskId), true);
  assert.ok(ok.ok);

  // The control plane can re-seed from a stale task snapshot during shutdown.
  store.seedGoals(taskId, initial);
  const repeated = store.assertGoal(taskId, "recon", ["recon/different.txt"]);
  assert.deepEqual(repeated, ok);
  assert.equal(store.listEvents(taskId).filter((event) => event.kind === "goal_asserted").length, 1);

  store.close();
  rmSync(root, { recursive: true, force: true });
});

test("ALL_COMPLETE.json requires every is_completed=true", () => {
  const root = mkdtempSync(join(tmpdir(), "gy-hist-ac-"));
  const evidenceDir = join(root, "evidence");
  mkdirSync(join(evidenceDir, "tsec"), { recursive: true });
  const store = openHistory({
    dbPath: join(root, "history.sqlite"),
    evidenceDir,
  });
  const taskId = "22222222-2222-4222-8222-222222222222";
  store.seedGoals(taskId, [
    {
      id: "clear-board",
      title: "Clear board",
      description: "all done",
      evidencePatterns: ["tsec/ALL_COMPLETE.json"],
      boardGate: "tsecbench",
      passes: false,
      evidencePaths: [],
      assertedAt: null,
    },
  ]);

  writeFileSync(
    join(evidenceDir, "tsec", "ALL_COMPLETE.json"),
    JSON.stringify([
      { unique_code: "e1-01", is_completed: true },
      { unique_code: "e1-02", is_completed: false },
    ]),
  );
  const blocked = store.assertGoal(taskId, "clear-board", ["tsec/ALL_COMPLETE.json"]);
  assert.equal(blocked.ok, false);

  writeFileSync(
    join(evidenceDir, "tsec", "ALL_COMPLETE.json"),
    JSON.stringify([
      { unique_code: "e1-01", is_completed: true },
      { unique_code: "e1-02", is_completed: true },
    ]),
  );
  const ok = store.assertGoal(taskId, "clear-board", ["tsec/ALL_COMPLETE.json"]);
  assert.equal(ok.ok, true);

  store.close();
  rmSync(root, { recursive: true, force: true });
});

test("Goal and evidence readers reject paths and links outside evidence", (t) => {
  const root = mkdtempSync(join(tmpdir(), "gy-hist-boundary-"));
  const evidenceDir = join(root, "evidence");
  const store = openHistory({ dbPath: join(root, "history.sqlite"), evidenceDir });
  t.after(() => {
    store.close();
    rmSync(root, { recursive: true, force: true });
  });

  const taskId = "33333333-3333-4333-8333-333333333333";
  store.seedGoals(taskId, [{
    id: "board",
    title: "Board",
    description: "",
    evidencePatterns: ["**/ALL_COMPLETE.json"],
    passes: false,
    evidencePaths: [],
    assertedAt: null,
  }]);
  const proof = '[{"is_completed":true}]';
  const outsideDir = join(root, "evidence-other");
  const outsideFile = join(outsideDir, "ALL_COMPLETE.json");
  mkdirSync(outsideDir);
  writeFileSync(outsideFile, proof);
  symlinkSync(outsideDir, join(evidenceDir, "alias"), "dir");
  mkdirSync(join(evidenceDir, "links"));
  symlinkSync(outsideFile, join(evidenceDir, "links", "ALL_COMPLETE.json"));
  mkdirSync(join(evidenceDir, "hard"));
  linkSync(outsideFile, join(evidenceDir, "hard", "ALL_COMPLETE.json"));
  mkdirSync(join(evidenceDir, "dir", "ALL_COMPLETE.json"), { recursive: true });

  for (const path of [
    outsideFile,
    "../evidence-other/ALL_COMPLETE.json",
    "alias/ALL_COMPLETE.json",
    "links/ALL_COMPLETE.json",
    "hard/ALL_COMPLETE.json",
    "dir/ALL_COMPLETE.json",
  ]) {
    assert.equal(store.assertGoal(taskId, "board", [path]).ok, false, path);
    assert.throws(() => readEvidenceFile(evidenceDir, path), path);
    assert.throws(() => writeEvidenceFile(evidenceDir, path, "blocked"), path);
  }
  assert.equal(readFileSync(outsideFile, "utf8"), proof);
  const path = "./valid/ALL_COMPLETE.json";
  writeEvidenceFile(evidenceDir, path, "longer content to be replaced");
  assert.equal(writeEvidenceFile(evidenceDir, path, proof), "valid/ALL_COMPLETE.json");
  assert.equal(readEvidenceFile(evidenceDir, path), proof);
  assert.equal(store.assertGoal(taskId, "board", [path]).ok, true);
});

test("proposeIntent rejects empty sourceFactIds; origin allowed", () => {
  const root = mkdtempSync(join(tmpdir(), "gy-hist-src-"));
  const evidenceDir = join(root, "evidence");
  mkdirSync(evidenceDir, { recursive: true });
  const store = openHistory({
    dbPath: join(root, "history.sqlite"),
    evidenceDir,
  });
  const taskId = "33333333-3333-4333-8333-333333333333";

  assert.throws(
    () =>
      store.proposeIntent({
        taskId,
        title: "causeless",
        sourceFactIds: [],
      }),
    /sourceFactIds required/,
  );

  assert.throws(
    () =>
      store.proposeIntent({
        taskId,
        title: "unknown pred",
        sourceFactIds: ["00000000-0000-4000-8000-000000000000"],
      }),
    /unknown source fact/,
  );

  const proposed = store.proposeIntent({
    taskId,
    title: "from origin",
    sourceFactIds: [ORIGIN_FACT_ID],
  });
  assert.deepEqual(proposed.sourceFactIds, [ORIGIN_FACT_ID]);
  assert.equal(proposed.status, "proposed");

  store.close();
  rmSync(root, { recursive: true, force: true });
});

test("observe is title + open Intents only; summary/evidence on demand", () => {
  const root = mkdtempSync(join(tmpdir(), "gy-hist-obs-"));
  const evidenceDir = join(root, "evidence");
  mkdirSync(evidenceDir, { recursive: true });
  const store = openHistory({
    dbPath: join(root, "history.sqlite"),
    evidenceDir,
  });
  const taskId = "55555555-5555-4555-8555-555555555555";
  store.seedGoals(taskId, [
    {
      id: "g1",
      title: "Goal One",
      description: "d",
      evidencePatterns: ["x.txt"],
      passes: false,
      evidencePaths: [],
      assertedAt: null,
    },
  ]);

  const title = store.appendFact({
    taskId,
    layer: "title",
    title: "Visible title fact",
  });
  store.appendFact({
    taskId,
    layer: "summary",
    title: "Hidden summary fact",
    summary: "SECRET_SUMMARY_BODY_SHOULD_NOT_BE_IN_OBSERVE",
  });
  store.appendFact({
    taskId,
    layer: "evidence",
    title: "Hidden evidence fact",
    summary: "SECRET_EVIDENCE_BODY",
    evidencePath: "x.txt",
  });
  store.proposeIntent({
    taskId,
    title: "Open explore",
    sourceFactIds: [title.id],
  });

  const obs = store.observe(taskId);
  assert.match(obs, /Visible title fact/);
  assert.match(obs, /Open explore/);
  assert.match(obs, /Goal One/);
  assert.doesNotMatch(obs, /SECRET_SUMMARY_BODY_SHOULD_NOT_BE_IN_OBSERVE/);
  assert.doesNotMatch(obs, /SECRET_EVIDENCE_BODY/);
  assert.doesNotMatch(obs, /## 近期摘要/);

  const drilled = store.getFact(taskId, title.id);
  assert.ok(drilled);
  assert.equal(drilled!.title, "Visible title fact");

  const summaries = store.listFacts(taskId, "summary");
  assert.equal(summaries.length, 1);
  assert.match(summaries[0]!.summary, /SECRET_SUMMARY/);

  const full = store.overview(taskId);
  assert.match(full, /SECRET_SUMMARY_BODY_SHOULD_NOT_BE_IN_OBSERVE/);

  store.close();
  rmSync(root, { recursive: true, force: true });
});

test("getFactNeighborhood returns same-intent chain; no invent without intentId", () => {
  const root = mkdtempSync(join(tmpdir(), "gy-hist-nbr-"));
  const evidenceDir = join(root, "evidence");
  mkdirSync(evidenceDir, { recursive: true });
  const store = openHistory({
    dbPath: join(root, "history.sqlite"),
    evidenceDir,
  });
  const taskId = "77777777-7777-4777-8777-777777777777";
  const orphan = store.appendFact({
    taskId,
    layer: "title",
    title: "orphan no intent",
  });
  const emptyNbr = store.getFactNeighborhood(taskId, orphan.id);
  assert.equal(emptyNbr.before.length, 0);
  assert.equal(emptyNbr.after.length, 0);

  const intent = store.proposeIntent({
    taskId,
    title: "chain explore",
    sourceFactIds: [orphan.id],
  });
  const a = store.appendFact({
    taskId,
    layer: "title",
    title: "first",
    intentId: intent.id,
  });
  const b = store.appendFact({
    taskId,
    layer: "summary",
    title: "middle",
    summary: "mid body",
    intentId: intent.id,
  });
  const c = store.appendFact({
    taskId,
    layer: "title",
    title: "last",
    intentId: intent.id,
  });

  const mid = store.getFactNeighborhood(taskId, b.id, 2);
  assert.equal(mid.before.map((x) => x.id).join(","), a.id);
  assert.equal(mid.after.map((x) => x.id).join(","), c.id);
  assert.equal(mid.before[0]!.recordedAt, a.createdAt);

  const drill = store.formatFactDrill(taskId, b.id);
  assert.equal(drill.ok, true);
  const factPayload = drill.fact as { recordedAt: string; createdAt?: string };
  assert.equal(factPayload.recordedAt, b.createdAt);
  assert.equal(factPayload.createdAt, undefined);

  store.recordToolGate(taskId, {
    tool: "shell",
    ok: false,
    reason: "denied: test",
  });
  const events = store.listEvents(taskId).filter((e) => e.kind === "tool_gate");
  assert.equal(events.length, 1);
  assert.equal(events[0]!.payload.ok, false);

  store.close();
  rmSync(root, { recursive: true, force: true });
});

test("expireStaleIntents moves claimed to expired", () => {
  const root = mkdtempSync(join(tmpdir(), "gy-hist-exp-"));
  const evidenceDir = join(root, "evidence");
  mkdirSync(evidenceDir, { recursive: true });
  const store = openHistory({
    dbPath: join(root, "history.sqlite"),
    evidenceDir,
  });
  const taskId = "66666666-6666-4666-8666-666666666666";
  const intent = store.proposeIntent({
    taskId,
    title: "stale",
    sourceFactIds: [ORIGIN_FACT_ID],
  });
  store.claimIntent(taskId, intent.id, "w1");
  // maxAgeMs=0 ⇒ any claimed/running is stale
  const expired = store.expireStaleIntents(taskId, 0);
  assert.equal(expired.length, 1);
  assert.equal(expired[0]!.status, "expired");
  store.close();
  rmSync(root, { recursive: true, force: true });
});

test("claimIntent is CAS on proposed; succeed conclude requires Fact writeback", () => {
  const root = mkdtempSync(join(tmpdir(), "gy-hist-cas-"));
  const evidenceDir = join(root, "evidence");
  mkdirSync(evidenceDir, { recursive: true });
  const store = openHistory({
    dbPath: join(root, "history.sqlite"),
    evidenceDir,
  });
  const taskId = "44444444-4444-4444-8444-444444444444";

  const intent = store.proposeIntent({
    taskId,
    title: "probe",
    sourceFactIds: [ORIGIN_FACT_ID],
  });

  const claimed = store.claimIntent(taskId, intent.id, "worker-a");
  assert.ok(claimed);
  assert.equal(claimed!.status, "claimed");
  assert.equal(claimed!.claimedBy, "worker-a");

  const lost = store.claimIntent(taskId, intent.id, "worker-b");
  assert.equal(lost, null);

  assert.throws(
    () => store.concludeIntent(taskId, intent.id, "succeeded", "ok"),
    /requires ≥1 Fact/,
  );

  const done = store.concludeIntent(taskId, intent.id, "succeeded", "ok", {
    facts: [{ layer: "title", title: "probe result", summary: "found X" }],
  });
  assert.ok(done);
  assert.equal(done!.status, "succeeded");

  const facts = store.listFacts(taskId);
  assert.equal(facts.length, 1);
  assert.equal(facts[0]!.intentId, intent.id);
  assert.equal(facts[0]!.title, "probe result");

  store.close();
  rmSync(root, { recursive: true, force: true });
});

test("asset inventory seeds, auto-admits under CIDR, and observes", () => {
  const root = mkdtempSync(join(tmpdir(), "gy-hist-asset-"));
  const evidenceDir = join(root, "evidence");
  mkdirSync(evidenceDir, { recursive: true });
  const store = openHistory({
    dbPath: join(root, "history.sqlite"),
    evidenceDir,
  });
  const taskId = "55555555-5555-4555-8555-555555555555";
  const auth = { targets: ["10.0.0.0/8", "*.example.com"], outOfScope: ["admin.example.com"] };

  const seeded = store.seedAssetsFromAuth(taskId, auth);
  assert.equal(seeded.length, 2);
  assert.equal(store.seedAssetsFromAuth(taskId, auth).length, 0);

  const hit = store.recordAsset({
    taskId,
    address: "10.0.9.9",
    auth,
    summary: "fofa hit",
  });
  assert.equal(hit.created, true);
  assert.equal(hit.asset.kind, "admitted");

  const oos = store.recordAsset({
    taskId,
    address: "admin.example.com",
    auth,
  });
  assert.equal(oos.asset.kind, "oos");

  const live = store.recordAsset({
    taskId,
    address: "10.0.9.9",
    auth,
    live: true,
  });
  assert.equal(live.created, true);
  assert.equal(live.asset.kind, "live");

  const assets = store.listAssets(taskId);
  assert.equal(assets.length, 4);
  assert.ok(assets.some((a) => a.address === "10.0.0.0/8" && a.kind === "seed"));
  assert.ok(assets.some((a) => a.address === "10.0.9.9" && a.kind === "live"));

  const obs = store.observe(taskId);
  assert.match(obs, /资产清单（4）/);
  assert.match(obs, /10\.0\.9\.9/);

  store.close();
  rmSync(root, { recursive: true, force: true });
});

test("hint append appears in Observe", () => {
  const root = mkdtempSync(join(tmpdir(), "gy-hist-hint-"));
  const evidenceDir = join(root, "evidence");
  mkdirSync(evidenceDir, { recursive: true });
  const store = openHistory({
    dbPath: join(root, "history.sqlite"),
    evidenceDir,
  });
  const taskId = "66666666-6666-4666-8666-666666666666";
  const hint = store.appendHint({
    taskId,
    text: "优先测 /login 的 SQL 注入",
    source: "human",
  });
  assert.ok(hint.id);
  assert.equal(store.listHints(taskId).length, 1);
  const obs = store.observe(taskId);
  assert.match(obs, /Hint（战术注入）/);
  assert.match(obs, /SQL 注入/);
  store.close();
  rmSync(root, { recursive: true, force: true });
});

test("broadcastTechnique fans out intents to peer assets", () => {
  const root = mkdtempSync(join(tmpdir(), "gy-hist-xfer-"));
  const evidenceDir = join(root, "evidence");
  mkdirSync(evidenceDir, { recursive: true });
  const store = openHistory({
    dbPath: join(root, "history.sqlite"),
    evidenceDir,
  });
  const taskId = "77777777-7777-4777-8777-777777777777";
  const auth = { targets: ["*.example.com"], outOfScope: [] as string[] };
  store.seedAssetsFromAuth(taskId, { targets: ["a.example.com", "b.example.com"] });
  store.recordAsset({ taskId, address: "a.example.com", auth, live: true });
  store.recordAsset({ taskId, address: "b.example.com", auth, live: true });

  const source = store.appendFact({
    taskId,
    layer: "title",
    title: "WAF bypass confirmed on a.example.com",
    summary: "X-Forwarded-For: 127.0.0.1",
  });

  const out = store.broadcastTechnique({
    taskId,
    sourceFactIds: [source.id],
    title: "WAF bypass via XFF",
    summary: "X-Forwarded-For: 127.0.0.1 works",
    familyKey: "example-waf",
  });
  assert.ok(out.techniqueFact.tags.includes("transferable"));
  assert.ok(out.intents.length >= 2);
  assert.match(store.observe(taskId), /可迁移打法/);
  assert.match(store.observe(taskId), /同族迁移/);

  // Idempotent-ish: second broadcast skips same open titles
  const again = store.broadcastTechnique({
    taskId,
    sourceFactIds: [source.id],
    title: "WAF bypass via XFF",
    summary: "X-Forwarded-For: 127.0.0.1 works",
    familyKey: "example-waf",
  });
  assert.ok(again.skipped.length >= 1);
  assert.ok(out.familyKey === "example-waf" || out.familyKeyVia === "explicit");

  store.close();
  rmSync(root, { recursive: true, force: true });
});

test("proposeIntent rejects oos-only exploit predecessors", () => {
  const root = mkdtempSync(join(tmpdir(), "gy-hist-oos-"));
  const evidenceDir = join(root, "evidence");
  mkdirSync(evidenceDir, { recursive: true });
  const store = openHistory({
    dbPath: join(root, "history.sqlite"),
    evidenceDir,
  });
  const taskId = "88888888-8888-4888-8888-888888888888";
  const auth = { targets: ["in.example.com"], outOfScope: [] as string[] };
  store.seedAssetsFromAuth(taskId, { targets: ["in.example.com"] });
  const oos = store.recordAsset({
    taskId,
    address: "evil.other.com",
    auth,
  });
  assert.equal(oos.asset.kind, "oos");
  assert.throws(
    () =>
      store.proposeIntent({
        taskId,
        title: "exploit oos",
        sourceFactIds: [oos.fact.id],
      }),
    /oos-only/,
  );
  store.close();
  rmSync(root, { recursive: true, force: true });
});

test("Reason fanout caps open intents and same-root", () => {
  const root = mkdtempSync(join(tmpdir(), "gy-hist-fan-"));
  const evidenceDir = join(root, "evidence");
  mkdirSync(evidenceDir, { recursive: true });
  const store = openHistory({
    dbPath: join(root, "history.sqlite"),
    evidenceDir,
  });
  const taskId = "99999999-9999-4999-8999-999999999999";
  const auth = {
    targets: ["*.example.com", "*.other.org"],
    outOfScope: [] as string[],
  };
  const a = store.recordAsset({ taskId, address: "a.example.com", auth });
  const b = store.recordAsset({ taskId, address: "b.other.org", auth });
  const fanout = { maxIntentsPerReason: 2, maxIntentsPerAssetRoot: 1 };
  store.proposeIntent({
    taskId,
    title: "probe a",
    sourceFactIds: [a.fact.id],
    fanout,
  });
  assert.throws(
    () =>
      store.proposeIntent({
        taskId,
        title: "probe a2",
        sourceFactIds: [a.fact.id],
        fanout,
      }),
    /maxIntentsPerAssetRoot|fanout cap/,
  );
  // Different registrable root → allowed until maxIntentsPerReason
  store.proposeIntent({
    taskId,
    title: "probe b",
    sourceFactIds: [b.fact.id],
    fanout,
  });
  assert.throws(
    () =>
      store.proposeIntent({
        taskId,
        title: "probe more",
        sourceFactIds: [b.fact.id],
        fanout,
      }),
    /maxIntentsPerReason|fanout cap/,
  );
  store.close();
  rmSync(root, { recursive: true, force: true });
});

test("reason lease CAS and explore timeout partial conclude", () => {
  const root = mkdtempSync(join(tmpdir(), "gy-hist-lease-"));
  const evidenceDir = join(root, "evidence");
  mkdirSync(evidenceDir, { recursive: true });
  const store = openHistory({
    dbPath: join(root, "history.sqlite"),
    evidenceDir,
  });
  const taskId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const got = store.tryAcquireReasonLease(taskId, "w0", 60_000);
  assert.equal(got.ok, true);
  const denied = store.tryAcquireReasonLease(taskId, "w1", 60_000);
  assert.equal(denied.ok, false);
  assert.equal(store.releaseReasonLease(taskId, "w0"), true);
  assert.equal(store.tryAcquireReasonLease(taskId, "w1", 60_000).ok, true);

  const intent = store.proposeIntent({
    taskId,
    title: "slow explore",
    sourceFactIds: ["origin"],
  });
  store.claimIntent(taskId, intent.id, "w0");
  const done = store.forceConcludeExploreTimeout({
    taskId,
    intentId: intent.id,
    workerId: "w0",
  });
  assert.ok(done);
  assert.equal(done?.status, "failed");
  const facts = store.listFacts(taskId);
  assert.ok(facts.some((f) => f.tags.includes("partial")));
  store.close();
  rmSync(root, { recursive: true, force: true });
});

test("broadcastTechnique suggests familyKey when omitted", () => {
  const root = mkdtempSync(join(tmpdir(), "gy-hist-fam-"));
  const evidenceDir = join(root, "evidence");
  mkdirSync(evidenceDir, { recursive: true });
  const store = openHistory({
    dbPath: join(root, "history.sqlite"),
    evidenceDir,
  });
  const taskId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  const auth = { targets: ["*.example.com"], outOfScope: [] as string[] };
  store.recordAsset({ taskId, address: "a.example.com", auth, live: true });
  store.recordAsset({ taskId, address: "b.example.com", auth, live: true });
  const source = store.appendFact({
    taskId,
    layer: "title",
    title: "WordPress plugin RCE confirmed",
    summary: "wp-admin ajax endpoint",
  });
  const out = store.broadcastTechnique({
    taskId,
    sourceFactIds: [source.id],
    title: "WordPress plugin RCE",
    summary: "authenticated ajax RCE on wordpress",
    fanout: { maxIntentsPerReason: 4, maxIntentsPerAssetRoot: 2 },
  });
  assert.ok(out.familyKey);
  assert.ok(out.familyKeyVia === "stack" || out.familyKey === "wordpress");
  store.close();
  rmSync(root, { recursive: true, force: true });
});

// ── 第七轮：目标级核算条件（缺件不得判通过） ──────────────────────────────

function reconcileFixture(overrides: {
  name?: string;
  missingMaterials?: string[];
  unknown?: number;
  ambiguous?: number;
  totalKeys?: number;
  baselinePath?: string;
  currentPath?: string;
  baselineSha?: string | null;
  currentSha?: string | null;
} = {}) {
  const baselinePath = overrides.baselinePath ?? "assets/baseline.csv";
  const currentPath = overrides.currentPath ?? "assets/current.csv";
  return {
    version: 1,
    name: overrides.name ?? "asset-diff",
    keyField: "host",
    compareFields: ["version"],
    baseline: {
      path: baselinePath,
      format: "csv",
      rows: 2,
      sha256: overrides.baselineSha === undefined ? "a".repeat(64) : overrides.baselineSha,
    },
    current: {
      path: currentPath,
      format: "csv",
      rows: 2,
      sha256: overrides.currentSha === undefined ? "b".repeat(64) : overrides.currentSha,
    },
    missingMaterials: overrides.missingMaterials ?? [],
    counts: {
      added: 0,
      removed: 0,
      changed: 1,
      unchanged: 1,
      missing: 0,
      unknown: overrides.unknown ?? 0,
      ambiguous: overrides.ambiguous ?? 0,
      totalKeys: overrides.totalKeys ?? 2,
    },
    items: [
      { key: "app-a-1", status: "changed", baselineLine: 2, currentLine: 2, changes: [{ field: "version", before: "1", after: "2" }] },
      { key: "app-a-2", status: "unchanged", baselineLine: 3, currentLine: 3, changes: [] },
    ],
  };
}

function seedDiffGoal(store: ReturnType<typeof openHistory>, taskId: string) {
  store.seedGoals(taskId, [{
    id: "asset-baseline-diff",
    title: "原始资产清单差异",
    description: "按业务主键核对两份原始资产清单",
    evidencePatterns: ["reconcile/*.json"],
    reconcileGate: { pattern: "reconcile/*.json", maxUnknown: 0, maxAmbiguous: 0 },
    passes: false,
    evidencePaths: [],
    assertedAt: null,
  } as Parameters<typeof store.seedGoals>[1][number]]);
}

test("核算条件：只挂一份缺基线的差异 JSON 不能判通过，并点名缺哪份材料", () => {
  const root = mkdtempSync(join(tmpdir(), "gy-hist-gate-"));
  const evidenceDir = join(root, "evidence");
  mkdirSync(join(evidenceDir, "reconcile"), { recursive: true });
  const store = openHistory({ dbPath: join(root, "history.sqlite"), evidenceDir });
  const taskId = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa";
  try {
    seedDiffGoal(store, taskId);

    // 1) 只交当前清单：差异 JSON 存在，但整份基线材料缺失。
    writeFileSync(
      join(evidenceDir, "reconcile", "asset-diff-1.json"),
      JSON.stringify(reconcileFixture({
        missingMaterials: ["assets/baseline.csv"],
        unknown: 2,
        baselineSha: null,
      }), null, 2),
    );
    const rejected = store.assertGoal(taskId, "asset-baseline-diff", ["reconcile/asset-diff-1.json"]);
    assert.equal(rejected.ok, false, "缺基线不得判通过");
    if (!rejected.ok) {
      assert.match(rejected.reason, /缺少基线材料 assets\/baseline\.csv/);
    }
    const goals = store.listGoals(taskId);
    assert.equal(goals[0]!.passes, false);
    assert.deepEqual(store.listGoalProofs(taskId), [], "未通过就不该有首次通过依据");
    // 拒绝原因留在事件台账里，报告和控制台都读它。
    const rejections = store.listEvents(taskId).filter((event) => event.kind === "goal_assert_rejected");
    assert.equal(rejections.length, 1);
    assert.match(String((rejections[0]!.payload as { reason?: string }).reason), /缺少基线材料/);

    // 2) 两侧都缺：点名两份材料。
    writeFileSync(
      join(evidenceDir, "reconcile", "asset-diff-2.json"),
      JSON.stringify(reconcileFixture({
        name: "asset-diff-empty",
        missingMaterials: ["assets/baseline.csv", "assets/current.csv"],
        unknown: 2,
        baselineSha: null,
        currentSha: null,
      }), null, 2),
    );
    const both = store.assertGoal(taskId, "asset-baseline-diff", ["reconcile/asset-diff-2.json"]);
    assert.equal(both.ok, false);
    if (!both.ok) assert.match(both.reason, /缺少两侧材料/);
    assert.equal(store.listGoals(taskId)[0]!.passes, false);

    // 3) 补交基线后重新核算：合格结果首次通过，且只采用这一份核算文件。
    writeFileSync(
      join(evidenceDir, "reconcile", "asset-diff-3.json"),
      JSON.stringify(reconcileFixture(), null, 2),
    );
    const passed = store.assertGoal(taskId, "asset-baseline-diff", ["reconcile/asset-diff-3.json"]);
    assert.equal(passed.ok, true);
    const proofs = store.listGoalProofs(taskId);
    assert.equal(proofs.length, 1, "首次通过只记这一份核算文件");
    assert.equal(proofs[0]!.path, "reconcile/asset-diff-3.json");
    assert.match(proofs[0]!.sha256, /^[0-9a-f]{64}$/);
    const asserted = store.listEvents(taskId).filter((event) => event.kind === "goal_asserted");
    assert.equal(asserted.length, 1);
    const adopted = (asserted[0]!.payload as { adoptedReconcile?: { path: string; sha256: string } }).adoptedReconcile;
    assert.equal(adopted?.path, "reconcile/asset-diff-3.json");
    assert.equal(adopted?.sha256, proofs[0]!.sha256, "事件里的哈希等于首次通过依据的封存哈希");

    // 4) 重复提交不重复记账。
    const repeat = store.assertGoal(taskId, "asset-baseline-diff", ["reconcile/asset-diff-3.json"]);
    assert.equal(repeat.ok, true);
    assert.equal(store.listGoalProofs(taskId).length, 1, "重复提交不新增首次通过依据");
    assert.equal(
      store.listEvents(taskId).filter((event) => event.kind === "goal_asserted").length,
      1,
      "重复提交不重复记首次通过事件",
    );
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("核算条件：两份清单齐全时“两侧都不存在的约定项”是有效结论，不拦通过", () => {
  const root = mkdtempSync(join(tmpdir(), "gy-hist-gate2-"));
  const evidenceDir = join(root, "evidence");
  mkdirSync(join(evidenceDir, "reconcile"), { recursive: true });
  const store = openHistory({ dbPath: join(root, "history.sqlite"), evidenceDir });
  const taskId = "bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb";
  try {
    seedDiffGoal(store, taskId);
    const result = reconcileFixture();
    result.counts.missing = 1; // required-key-absent-in-both：两份清单里都没有该资产
    writeFileSync(join(evidenceDir, "reconcile", "asset-diff-both.json"), JSON.stringify(result, null, 2));
    const passed = store.assertGoal(taskId, "asset-baseline-diff", ["reconcile/asset-diff-both.json"]);
    assert.equal(passed.ok, true, "缺项是核查结论，不是材料缺失");
    assert.equal(store.listGoals(taskId)[0]!.passes, true);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("核算条件：重复主键歧义、未知项、非核算文件都不得判通过", () => {
  const root = mkdtempSync(join(tmpdir(), "gy-hist-gate3-"));
  const evidenceDir = join(root, "evidence");
  mkdirSync(join(evidenceDir, "reconcile"), { recursive: true });
  const store = openHistory({ dbPath: join(root, "history.sqlite"), evidenceDir });
  const taskId = "cccccccc-3333-4333-8333-cccccccccccc";
  try {
    seedDiffGoal(store, taskId);

    writeFileSync(
      join(evidenceDir, "reconcile", "ambiguous.json"),
      JSON.stringify(reconcileFixture({ ambiguous: 1 }), null, 2),
    );
    const ambiguous = store.assertGoal(taskId, "asset-baseline-diff", ["reconcile/ambiguous.json"]);
    assert.equal(ambiguous.ok, false);
    if (!ambiguous.ok) assert.match(ambiguous.reason, /歧义 1 项/);

    writeFileSync(
      join(evidenceDir, "reconcile", "unknown.json"),
      JSON.stringify(reconcileFixture({ unknown: 1 }), null, 2),
    );
    const unknown = store.assertGoal(taskId, "asset-baseline-diff", ["reconcile/unknown.json"]);
    assert.equal(unknown.ok, false);
    if (!unknown.ok) assert.match(unknown.reason, /未知项 1 项/);

    // 一份“长得像”的 JSON（占位/伪造）不算核算结果。
    writeFileSync(join(evidenceDir, "reconcile", "stub.json"), JSON.stringify({ ok: true }, null, 2));
    const stub = store.assertGoal(taskId, "asset-baseline-diff", ["reconcile/stub.json"]);
    assert.equal(stub.ok, false);
    if (!stub.ok) assert.match(stub.reason, /不是本平台的核算结果/);

    assert.equal(store.listGoals(taskId)[0]!.passes, false);
    assert.deepEqual(store.listGoalProofs(taskId), []);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

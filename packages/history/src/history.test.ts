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
    () => store.concludeIntent(taskId, intent.id, "succeeded", "ok", { workerId: "worker-a" }),
    /requires ≥1 Fact/,
  );

  const done = store.concludeIntent(taskId, intent.id, "succeeded", "ok", {
    workerId: "worker-a",
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

// ── 第七/八轮：目标级核算条件（缺件不得判通过；首次通过绑定输入版本） ──────

const BASELINE_CSV = [
  "host,role,version",
  "app-a-1,web,1.4",
  "app-a-2,db,2.1",
].join("\n");
const CURRENT_CSV = [
  "host,role,version",
  "app-a-1,web,1.5",
  "app-a-2,db,2.1",
].join("\n");

function writeMaterial(evidenceDir: string, path: string, content: string) {
  writeEvidenceFile(evidenceDir, path, content);
}

function seedDiffGoal(
  store: ReturnType<typeof openHistory>,
  taskId: string,
  options: { business?: boolean; requiredKeys?: string[] } = {},
) {
  const goal: Record<string, unknown> = {
    id: "asset-baseline-diff",
    title: "原始资产清单差异",
    description: "按业务主键核对两份原始资产清单",
  };
  if (options.business) {
    Object.assign(goal, {
      kind: "business-reconcile",
      business: {
        name: "asset-diff",
        keyField: "host",
        maxUnknown: 0,
        maxAmbiguous: 0,
        baseline: { path: "assets/baseline.csv" },
        current: { path: "assets/current.csv" },
        ...(options.requiredKeys?.length ? { requiredKeys: options.requiredKeys } : {}),
      },
      evidencePatterns: ["reconcile/asset-diff-*.json"],
      reconcileGate: { pattern: "reconcile/asset-diff-*.json", maxUnknown: 0, maxAmbiguous: 0 },
    });
  } else {
    Object.assign(goal, {
      evidencePatterns: ["reconcile/*.json"],
      reconcileGate: { pattern: "reconcile/*.json", maxUnknown: 0, maxAmbiguous: 0 },
    });
  }
  Object.assign(goal, { passes: false, evidencePaths: [], assertedAt: null });
  store.seedGoals(taskId, [goal as Parameters<typeof store.seedGoals>[1][number]]);
}

/** 走真实核算实现归档一次，返回本次的版本与结果文件。 */
function reconcile(store: ReturnType<typeof openHistory>, taskId: string, overrides: Record<string, unknown> = {}) {
  return store.archiveReconcile({
    taskId,
    request: {
      name: "asset-diff",
      baseline: { path: "assets/baseline.csv" },
      current: { path: "assets/current.csv" },
      keyField: "host",
      goalIds: ["asset-baseline-diff"],
      ...overrides,
    } as Parameters<typeof store.archiveReconcile>[0]["request"],
    goalIds: (overrides.goalIds as string[] | undefined) ?? ["asset-baseline-diff"],
  });
}

test("核算条件：缺基线时点名缺件，不判通过；补交后重新核算才首次通过", () => {
  const root = mkdtempSync(join(tmpdir(), "gy-hist-gate-"));
  const evidenceDir = join(root, "evidence");
  mkdirSync(join(evidenceDir, "reconcile"), { recursive: true });
  const store = openHistory({ dbPath: join(root, "history.sqlite"), evidenceDir });
  const taskId = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa";
  try {
    seedDiffGoal(store, taskId, { business: true });

    // 1) 只交当前清单：核算结果本身就是缺件结论。
    writeMaterial(evidenceDir, "assets/current.csv", CURRENT_CSV);
    const first = reconcile(store, taskId);
    assert.match(first.revision.id, /^r\d{13}-\d{4}$/);
    assert.equal(first.revision.baseline.present, false);
    assert.equal(first.revision.current.present, true);
    assert.equal(first.result.counts.unknown, 2);

    const rejected = store.assertGoal(taskId, "asset-baseline-diff", []);
    assert.equal(rejected.ok, false, "缺基线不得判通过");
    if (!rejected.ok) assert.match(rejected.reason, /缺少基线材料 assets\/baseline\.csv/);
    assert.equal(store.listGoals(taskId)[0]!.passes, false);
    assert.deepEqual(store.listGoalProofs(taskId), [], "未通过就不该有首次通过依据");
    const rejections = store.listEvents(taskId).filter((event) => event.kind === "goal_assert_rejected");
    assert.equal(rejections.length, 1);
    assert.match(String((rejections[0]!.payload as { reason?: string }).reason), /缺少基线材料/);

    // 2) 两侧都缺：点名两份材料。
    rmSync(join(evidenceDir, "assets/current.csv"));
    const both = reconcile(store, taskId);
    assert.deepEqual(both.result.missingMaterials, ["assets/baseline.csv", "assets/current.csv"]);
    const rejectedBoth = store.assertGoal(taskId, "asset-baseline-diff", []);
    assert.equal(rejectedBoth.ok, false);
    if (!rejectedBoth.ok) assert.match(rejectedBoth.reason, /缺少两侧材料/);
    assert.equal(store.listGoals(taskId)[0]!.passes, false);

    // 3) 补交两侧材料后重新核算：合格结果首次通过，只采用这一份核算文件。
    writeMaterial(evidenceDir, "assets/baseline.csv", BASELINE_CSV);
    writeMaterial(evidenceDir, "assets/current.csv", CURRENT_CSV);
    const good = reconcile(store, taskId);
    assert.equal(good.result.counts.unknown, 0);
    const passed = store.assertGoal(taskId, "asset-baseline-diff", []);
    assert.equal(passed.ok, true);
    const proofs = store.listGoalProofs(taskId);
    assert.equal(proofs.length, 1, "首次通过只记这一份核算文件");
    assert.equal(proofs[0]!.path, good.evidencePath);
    assert.equal(proofs[0]!.sha256, good.evidenceSha256);
    const asserted = store.listEvents(taskId).filter((event) => event.kind === "goal_asserted");
    assert.equal(asserted.length, 1);
    const adopted = (asserted[0]!.payload as {
      adoptedReconcile?: { path: string; sha256: string; revisionId: string; inputDigest: string };
    }).adoptedReconcile;
    assert.equal(adopted?.path, good.evidencePath);
    assert.equal(adopted?.sha256, proofs[0]!.sha256, "事件里的哈希等于首次通过依据的封存哈希");
    assert.equal(adopted?.revisionId, good.revision.id);
    assert.equal(adopted?.inputDigest, good.revision.inputDigest);

    // 4) 重复提交不重复记账。
    const repeat = store.assertGoal(taskId, "asset-baseline-diff", []);
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
    // 约定检查项属于核算口径：目标声明了，核算也必须按同一口径跑。
    seedDiffGoal(store, taskId, { business: true, requiredKeys: ["app-a-9"] });
    writeMaterial(evidenceDir, "assets/baseline.csv", BASELINE_CSV);
    writeMaterial(evidenceDir, "assets/current.csv", CURRENT_CSV);
    const archived = reconcile(store, taskId, { requiredKeys: ["app-a-9"] });
    assert.equal(archived.result.counts.missing, 1, "约定项两侧都没有 = 缺件结论");
    const passed = store.assertGoal(taskId, "asset-baseline-diff", []);
    assert.equal(passed.ok, true, "缺项是核查结论，不是材料缺失");
    assert.equal(store.listGoals(taskId)[0]!.passes, true);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("核算条件：重复主键歧义与未知项都不得判通过；非核算文件也冒充不了", () => {
  const root = mkdtempSync(join(tmpdir(), "gy-hist-gate3-"));
  const evidenceDir = join(root, "evidence");
  mkdirSync(join(evidenceDir, "reconcile"), { recursive: true });
  const store = openHistory({ dbPath: join(root, "history.sqlite"), evidenceDir });
  const taskId = "cccccccc-3333-4333-8333-cccccccccccc";
  try {
    seedDiffGoal(store, taskId, { business: true });

    // 1) 当前侧同名主键冲突 → 歧义，不判通过。
    writeMaterial(evidenceDir, "assets/baseline.csv", BASELINE_CSV);
    writeMaterial(evidenceDir, "assets/current.csv", [
      "host,role,version",
      "app-a-1,web,1.5",
      "app-a-1,web,9.9",
      "app-a-2,db,2.1",
    ].join("\n"));
    const ambiguous = reconcile(store, taskId);
    assert.equal(ambiguous.result.counts.ambiguous, 1);
    const rejectedAmbiguous = store.assertGoal(taskId, "asset-baseline-diff", []);
    assert.equal(rejectedAmbiguous.ok, false);
    if (!rejectedAmbiguous.ok) assert.match(rejectedAmbiguous.reason, /歧义 1 项/);

    // 2) 未知项（缺一侧材料）同样不通过。
    rmSync(join(evidenceDir, "assets/baseline.csv"));
    const unknown = reconcile(store, taskId);
    assert.equal(unknown.result.counts.unknown > 0, true);
    const rejectedUnknown = store.assertGoal(taskId, "asset-baseline-diff", []);
    assert.equal(rejectedUnknown.ok, false);

    // 3) 手写一份“长得像”的 JSON：不是核算实现产出的，也没有版本记录，冒充不了。
    writeMaterial(evidenceDir, "reconcile/asset-diff-fake.json", JSON.stringify({
      version: 1,
      name: "asset-diff",
      keyField: "host",
      compareFields: ["version"],
      baseline: { path: "assets/baseline.csv", format: "csv", rows: 2, sha256: "a".repeat(64) },
      current: { path: "assets/current.csv", format: "csv", rows: 2, sha256: "b".repeat(64) },
      missingMaterials: [],
      counts: { added: 0, removed: 0, changed: 1, unchanged: 1, missing: 0, unknown: 0, ambiguous: 0, totalKeys: 2 },
      items: [{ key: "app-a-1", status: "changed", baselineLine: 2, currentLine: 2, changes: [] }],
    }, null, 2));
    const fake = store.assertGoal(taskId, "asset-baseline-diff", ["reconcile/asset-diff-fake.json"]);
    assert.equal(fake.ok, false, "没有归档版本的结果不能支撑首次通过");
    if (!fake.ok) assert.match(fake.reason, /核算条件未满足/);

    assert.equal(store.listGoals(taskId)[0]!.passes, false);
    assert.deepEqual(store.listGoalProofs(taskId), []);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("observe preserves hot ancestor facts across >50 cold facts and bounds large asset inventories", () => {
  const root = mkdtempSync(join(tmpdir(), "gy-hist-hot-"));
  const evidenceDir = join(root, "evidence");
  mkdirSync(evidenceDir, { recursive: true });
  const store = openHistory({
    dbPath: join(root, "history.sqlite"),
    evidenceDir,
  });
  const taskId = "88888888-8888-4888-8888-888888888888";
  try {
    const auth = { targets: ["10.0.0.0/16"], outOfScope: [] as string[] };
    // Record 50 assets (45 admitted + 5 oos) to trigger bounded asset observe (>40).
    for (let i = 1; i <= 45; i++) {
      store.recordAsset({ taskId, address: `10.0.1.${i}`, auth, live: i <= 2 });
    }
    for (let i = 1; i <= 5; i++) {
      store.recordAsset({ taskId, address: `192.168.9.${i}`, auth });
    }

    // Early root fact (hour 1) that anchors a downstream chain, followed by 55 cold title facts.
    const earlyRoot = store.appendFact({
      taskId,
      layer: "title",
      title: "EARLY_PIVOT_SUBNET_172_16",
    });
    const bridgeIntent = store.proposeIntent({
      taskId,
      title: "pivot scan",
      sourceFactIds: [earlyRoot.id],
    });
    store.claimIntent(taskId, bridgeIntent.id, "w0");
    store.concludeIntent(taskId, bridgeIntent.id, "succeeded", "pivoted", {
      workerId: "w0",
      facts: [{ layer: "title", title: "MID_FOOTHOLD_FACT" }],
    });
    const midFact = store.listFacts(taskId, "title").find((f) => f.title === "MID_FOOTHOLD_FACT")!;

    for (let i = 0; i < 55; i++) {
      store.appendFact({
        taskId,
        layer: "title",
        title: `cold-noise-${i}`,
      });
    }
    // Open intent depends on midFact, whose parent intent depended on earlyRoot!
    store.proposeIntent({
      taskId,
      title: "deep internal check",
      sourceFactIds: [midFact.id],
    });

    const obs = store.observe(taskId);
    assert.match(obs, /EARLY_PIVOT_SUBNET_172_16/, "2-hop hot ancestor must survive sliding window");
    assert.match(obs, /\[热祖先\]/, "pinned older ancestor is marked as hot");
    assert.match(obs, /已折叠冷历史/, "cold noise facts are folded");
    assert.match(obs, /另有 10 个资产已折叠/, "assets beyond 40 are bounded with summary");
    assert.match(obs, /\[live\] 10\.0\.1\.1/, "live assets prioritized to top of bounded list");
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("heartbeatIntent and expireStaleIntents requeue with poison-pill cap", () => {
  const root = mkdtempSync(join(tmpdir(), "gy-hist-requeue-"));
  const evidenceDir = join(root, "evidence");
  mkdirSync(evidenceDir, { recursive: true });
  const store = openHistory({
    dbPath: join(root, "history.sqlite"),
    evidenceDir,
  });
  const taskId = "99999999-9999-4999-8999-999999999999";
  try {
    const intent = store.proposeIntent({
      taskId,
      title: "flaky target",
      sourceFactIds: [ORIGIN_FACT_ID],
    });
    store.claimIntent(taskId, intent.id, "w1");
    assert.equal(store.heartbeatIntent(taskId, intent.id, "w2"), false, "wrong worker cannot heartbeat");
    assert.equal(store.heartbeatIntent(taskId, intent.id, "w1"), true);

    // 1st stale sweep with requeue=true (maxRequeues=2) → back to proposed
    const r1 = store.expireStaleIntents(taskId, 0, { requeue: true, maxRequeues: 2 });
    assert.equal(r1.length, 1);
    assert.equal(r1[0]!.status, "proposed");
    assert.equal(r1[0]!.claimedBy, null);

    // Re-claim and 2nd stale sweep → back to proposed
    assert.ok(store.claimIntent(taskId, intent.id, "w2"));
    const r2 = store.expireStaleIntents(taskId, 0, { requeue: true, maxRequeues: 2 });
    assert.equal(r2[0]!.status, "proposed");

    // Re-claim and 3rd stale sweep → hits maxRequeues=2, transitions to expired (poison-pill guard)
    assert.ok(store.claimIntent(taskId, intent.id, "w3"));
    const r3 = store.expireStaleIntents(taskId, 0, { requeue: true, maxRequeues: 2 });
    assert.equal(r3[0]!.status, "expired");
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("same-/24 hosts fan out independently, intra-host orthogonal techniques allow up to cap, and untouched host bypasses stale plan step", () => {
  const root = mkdtempSync(join(tmpdir(), "gy-hist-subnet-fanout-"));
  const evidenceDir = join(root, "evidence");
  mkdirSync(evidenceDir, { recursive: true });
  const store = openHistory({
    dbPath: join(root, "history.sqlite"),
    evidenceDir,
  });
  const taskId = "99999999-9999-4999-8999-888888888888";
  const auth = { targets: ["10.0.160.0/24"], outOfScope: [] as string[] };
  try {
    const h1 = store.recordAsset({ taskId, address: "10.0.160.144", auth, live: true });
    const h2 = store.recordAsset({ taskId, address: "10.0.160.145", auth, live: true });
    const h3 = store.recordAsset({ taskId, address: "10.0.160.146", auth, live: true });
    const fanout = { maxIntentsPerReason: 6, maxIntentsPerAssetRoot: 3 };

    // 1) All 3 sibling containers in 10.0.160.0/24 can be proposed concurrently without /24 lock
    store.proposeIntent({ taskId, title: "probe .144", sourceFactIds: [h1.fact.id], assetRoot: "10.0.160.144", technique: "recon-ports", fanout });
    store.proposeIntent({ taskId, title: "probe .145", sourceFactIds: [h2.fact.id], assetRoot: "10.0.160.145", technique: "recon-ports", fanout });
    store.proposeIntent({ taskId, title: "probe .146", sourceFactIds: [h3.fact.id], assetRoot: "10.0.160.146", technique: "recon-ports", fanout });

    // 2) Intra-host orthogonal techniques on .144 succeed, while duplicate open technique on .144 is rejected
    assert.throws(
      () =>
        store.proposeIntent({
          taskId,
          title: "duplicate recon .144",
          sourceFactIds: [h1.fact.id],
          assetRoot: "10.0.160.144",
          technique: "recon-ports",
          fanout,
        }),
      /duplicate open technique/,
    );
    store.proposeIntent({
      taskId,
      title: "greybox login .144",
      sourceFactIds: [h1.fact.id],
      assetRoot: "10.0.160.144",
      technique: "auth-business-logic",
      fanout,
    });
    store.proposeIntent({
      taskId,
      title: "cve check .144",
      sourceFactIds: [h1.fact.id],
      assetRoot: "10.0.160.144",
      technique: "known-cve",
      fanout,
    });
    // 4th open Intent on .144 hits maxIntentsPerAssetRoot=3
    assert.throws(
      () =>
        store.proposeIntent({
          taskId,
          title: "4th on .144",
          sourceFactIds: [h1.fact.id],
          assetRoot: "10.0.160.144",
          technique: "fuzzing",
          fanout: { maxIntentsPerReason: 10, maxIntentsPerAssetRoot: 3 },
        }),
      /maxIntentsPerAssetRoot|fanout cap/,
    );

    // 3) Stale ready plan step on .144 does NOT block sliding-window first dispatch on untouched .147
    store.setPlan(taskId, [{ title: "follow-up on .144", needsFactIds: [h1.fact.id] }]);
    const h4 = store.recordAsset({ taskId, address: "10.0.160.147", auth, live: true });
    const freshDispatch = store.proposeIntent({
      taskId,
      title: "first probe on untouched .147",
      sourceFactIds: [h4.fact.id],
      assetRoot: "10.0.160.147",
    });
    assert.equal(freshDispatch.assetRoot, "10.0.160.147");
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

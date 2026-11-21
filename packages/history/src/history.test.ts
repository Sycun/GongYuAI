import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import { ORIGIN_FACT_ID } from "@gongyuai/contracts";
import { openHistory } from "./index.js";

test("evidence gate blocks pass without files", () => {
  const root = mkdtempSync(join(tmpdir(), "gy-hist-"));
  const evidenceDir = join(root, "evidence");
  mkdirSync(evidenceDir, { recursive: true });
  const store = openHistory({
    dbPath: join(root, "history.sqlite"),
    evidenceDir,
  });
  const taskId = "11111111-1111-4111-8111-111111111111";
  store.seedGoals(taskId, [
    {
      id: "recon",
      title: "Recon",
      description: "Collect banner",
      evidencePatterns: ["recon/*.txt"],
      passes: false,
      evidencePaths: [],
      assertedAt: null,
    },
  ]);

  const blocked = store.assertGoal(taskId, "recon", ["recon/banner.txt"]);
  assert.equal(blocked.ok, false);

  mkdirSync(join(evidenceDir, "recon"), { recursive: true });
  writeFileSync(join(evidenceDir, "recon", "banner.txt"), "nginx/1.0\n");

  const ok = store.assertGoal(taskId, "recon", ["recon/banner.txt"]);
  assert.equal(ok.ok, true);
  if (ok.ok) assert.equal(ok.goal.passes, true);
  assert.equal(store.allGoalsPass(taskId), true);

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

  store.close();
  rmSync(root, { recursive: true, force: true });
});

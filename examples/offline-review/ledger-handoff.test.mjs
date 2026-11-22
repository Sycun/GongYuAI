import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { ledgerNote, sixBatches } from "./ledger-handoff.mjs";

test("ledger handoff preserves the subject, notice and historical verdict independently", () => {
  const note = { memo: "", withdrawals: [{notice:"F4", subject:"F2", scope:"数量"}],
    history:[{goal:"G7", recorded:"passed", recheck:"unverifiable", source:"F1"}] };
  const known = new Set(["F1","F2","F4"]);
  const encode = (obj) => ledgerNote({finish:"stop", text:JSON.stringify(obj)}, known);
  assert.deepEqual(JSON.parse(encode(note).text), note);
  assert.equal(encode(note).valid, true);
  for (const bad of [{notice:"F4",subject:"F4",scope:"数量"}, {notice:"F9",subject:"F2",scope:"数量"}]) {
    assert.equal(encode({...note, withdrawals:[bad]}).valid, false);
  }
  assert.equal(encode({...note, history:[{...note.history[0], recorded:"verifiable"}]}).valid, false);
  assert.equal(ledgerNote({finish:"length",text:"{"},known).valid, false);
});

test("six batches preserve every supplied fact and its causal order, without future references", () => {
  const cases = JSON.parse(readFileSync(new URL("./cases.json", import.meta.url)));
  for (const c of cases) {
    const facts=[...c.phase1,...c.phase2], noise=Array.from({length:c.noise},(_,i)=>({id:"N"+i,parents:[]}));
    const batches = sixBatches(facts, noise);
    const seen = new Set();
    for (const batch of batches) {
      assert(batch.some((r) => r.id.startsWith("F")));
      for (const r of batch) {
        assert(!seen.has(r.id)); assert(r.parents.every((id) => seen.has(id))); seen.add(r.id);
      }
    }
    assert.deepEqual(batches.flat().filter((r) => r.id.startsWith("F")), facts);
    assert.deepEqual(batches.flat().filter((r) => r.id.startsWith("N")), noise);
  }
});

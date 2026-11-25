import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { CheckpointStore } from "./checkpoint.js";
import {
  AUTO_SKILL_CHECK_EVERY,
  LONG_TURN_NOTE_HEADER,
  appendNoteToToolResult,
  createLongTurnQueue,
  renderLongTurnNote,
  shouldCheckAutoSkill,
  takeLongTurnNotes,
} from "./long-turn.js";

test("long turn: pending soft-pace + queued skill notes are consumed once and the cleared state persists", () => {
  const root = mkdtempSync(join(tmpdir(), "gy-long-turn-"));
  const ckpt = new CheckpointStore(join(root, "c.sqlite"));
  try {
    const state = ckpt.load();
    state.pendingSoftPaceMessage = "软节奏：请更新 autonomous-progress.md 与 report.md";
    ckpt.save(state);
    const queue = createLongTurnQueue();
    queue.notes.push("## 自动注入 Skill：web-auth");

    const first = takeLongTurnNotes(state, queue);
    assert.equal(first.consumedSoftPace, true);
    assert.deepEqual(first.notes, ["软节奏：请更新 autonomous-progress.md 与 report.md", "## 自动注入 Skill：web-auth"]);
    assert.equal(state.pendingSoftPaceMessage, null);
    ckpt.save(state);
    assert.equal(ckpt.load().pendingSoftPaceMessage, null, "cleared message survives a restart");

    const second = takeLongTurnNotes(state, queue);
    assert.deepEqual(second, { notes: [], consumedSoftPace: false });
  } finally {
    ckpt.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("long turn: notes append to the last text part of a tool result without dropping content", () => {
  const note = renderLongTurnNote(["remember report.md"]);
  assert.match(note, /^\n\n---\n/);
  assert.ok(note.includes(LONG_TURN_NOTE_HEADER));
  assert.equal(renderLongTurnNote([]), "");

  assert.equal(appendNoteToToolResult("exit=0", note), `exit=0${note}`);

  const pi = { output: [{ type: "text", text: "first" }, { type: "image", data: "x" }, { type: "text", text: "last" }], details: { a: 1 } };
  const out = appendNoteToToolResult(pi, note);
  assert.equal(out.output[0]!.text, "first");
  assert.equal(out.output[2]!.text, `last${note}`);
  assert.deepEqual(out.details, { a: 1 });
  assert.equal(pi.output[2]!.text, "last", "input is not mutated");

  const noText = appendNoteToToolResult({ content: [{ type: "image", data: "x" }] }, note) as { content: Array<{ type: string; text?: string }> };
  assert.equal(noText.content.length, 2);
  assert.equal(noText.content[1]!.type, "text");

  const unknown = { weird: true };
  assert.equal(appendNoteToToolResult(unknown, note), unknown);
  assert.equal(appendNoteToToolResult("same", ""), "same");

  const long = renderLongTurnNote(["x".repeat(10_000)]);
  assert.ok(long.length < 4_200);
});

test("long turn: auto skill check runs on new Facts immediately and otherwise every N steps", () => {
  const queue = createLongTurnQueue();
  assert.equal(shouldCheckAutoSkill(queue, 3), true, "first step always checks");
  let checks = 0;
  for (let i = 0; i < AUTO_SKILL_CHECK_EVERY * 2; i += 1) {
    if (shouldCheckAutoSkill(queue, 3)) checks += 1;
  }
  assert.equal(checks, 2);
  assert.equal(shouldCheckAutoSkill(queue, 4), true, "a new Fact triggers right away");
  assert.equal(shouldCheckAutoSkill(queue, 4), false);
});

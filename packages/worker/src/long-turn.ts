import type { CheckpointState } from "./checkpoint.js";

/**
 * Long-turn delivery helpers.
 *
 * A healthy Pi session can run 1,000+ steps inside one `root.submit()`. Anything
 * that is only consumed at the top of the outer continue loop (soft-pace /
 * ledger reminders, auto skill injection) would never reach the model. These
 * helpers queue such notes and append them to the next top-level tool result,
 * without interrupting the turn.
 */

export const LONG_TURN_NOTE_HEADER = "[系统附注 · 不打断当前会话]";
/** Check auto skill injection at least every N tool steps. */
export const AUTO_SKILL_CHECK_EVERY = 5;
const MAX_NOTE_CHARS = 4000;

export type LongTurnQueue = {
  /** Notes waiting for the next top-level tool result (e.g. auto skill blocks). */
  notes: string[];
  stepsSinceSkillCheck: number;
  lastFactCount: number;
};

export function createLongTurnQueue(): LongTurnQueue {
  return { notes: [], stepsSinceSkillCheck: 0, lastFactCount: -1 };
}

/**
 * Take every pending note: the persisted soft-pace message (cleared on the
 * state; caller must save the checkpoint when `consumedSoftPace`) plus queued
 * in-memory notes.
 */
export function takeLongTurnNotes(
  state: CheckpointState,
  queue: LongTurnQueue,
): { notes: string[]; consumedSoftPace: boolean } {
  const notes: string[] = [];
  let consumedSoftPace = false;
  const soft = state.pendingSoftPaceMessage;
  if (soft && soft.trim()) {
    notes.push(soft.trim());
    state.pendingSoftPaceMessage = null;
    consumedSoftPace = true;
  }
  while (queue.notes.length) {
    const note = queue.notes.shift();
    if (note && note.trim()) notes.push(note.trim());
  }
  return { notes, consumedSoftPace };
}

export function renderLongTurnNote(notes: readonly string[]): string {
  if (!notes.length) return "";
  const body = notes.join("\n\n");
  const clipped = body.length > MAX_NOTE_CHARS ? `${body.slice(0, MAX_NOTE_CHARS)}…` : body;
  return `\n\n---\n${LONG_TURN_NOTE_HEADER}\n${clipped}`;
}

/**
 * Append a note to a tool result. Handles plain strings and the Pi result
 * shapes `{ output: [{type:"text",text}] }` / `{ content: [...] }`. Unknown
 * shapes are returned unchanged.
 */
export function appendNoteToToolResult<T>(result: T, note: string): T {
  if (!note) return result;
  if (typeof result === "string") return `${result}${note}` as T;
  if (!result || typeof result !== "object") return result;
  const obj = result as Record<string, unknown>;
  for (const field of ["output", "content"] as const) {
    const parts = obj[field];
    if (!Array.isArray(parts)) continue;
    const next = [...parts];
    for (let i = next.length - 1; i >= 0; i -= 1) {
      const part = next[i] as { type?: unknown; text?: unknown } | null;
      if (part && part.type === "text" && typeof part.text === "string") {
        next[i] = { ...part, text: `${part.text}${note}` };
        return { ...obj, [field]: next } as T;
      }
    }
    next.push({ type: "text", text: note.trimStart() });
    return { ...obj, [field]: next } as T;
  }
  return result;
}

/** Run the auto skill check every N steps, or right away when the Fact count changed. */
export function shouldCheckAutoSkill(queue: LongTurnQueue, factCount: number, every = AUTO_SKILL_CHECK_EVERY): boolean {
  queue.stepsSinceSkillCheck += 1;
  const factsChanged = factCount !== queue.lastFactCount;
  if (!factsChanged && queue.stepsSinceSkillCheck < every) return false;
  queue.stepsSinceSkillCheck = 0;
  queue.lastFactCount = factCount;
  return true;
}

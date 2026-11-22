import { randomUUID } from "node:crypto";
import { appendFileSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { goalsFromSpecs, type GoalSpec } from "@gongyuai/contracts";
import { openHistory, writeEvidenceFile } from "@gongyuai/history";

type Mode = "bare" | "history" | "relay";
type Field = "reference" | "reviewReceipt";
type Memory = Partial<Record<Field, string>>;
type Observation = { field: Field; value: string };
type Decision = { kind: "tool"; name: string } | { kind: "answer"; fields: Memory };
type Budget = { maxModelTurns: number; maxToolCalls: number };
type Status = "completed" | "incomplete" | "budget_exhausted" | "failed";

const SCENARIOS = [
  { id: "short", label: "Short task / one session", cutAfterTool: null, loseHandoff: false },
  { id: "after-reference", label: "Switch after catalog reference", cutAfterTool: 1, loseHandoff: false },
  { id: "after-receipt", label: "Switch after review receipt", cutAfterTool: 2, loseHandoff: false },
  { id: "handoff-lost", label: "Switch after receipt / handoff lost", cutAfterTool: 2, loseHandoff: true },
] as const;
type Scenario = (typeof SCENARIOS)[number];

const BUDGET: Readonly<Budget> = Object.freeze({ maxModelTurns: 3, maxToolCalls: 2 });
const RECORD_REFERENCE = "CATALOG-042";
const REVIEW_RECEIPT = "REVIEW-BLUE";
const RESULT_FILE = "answer.json";
const REFERENCE_TAG = "offline:catalog-reference";

// The only dispatchable tools are pure functions over synthetic data.
const toolStubs = new Map<string, () => Observation>([
  ["read_catalog_reference", () => ({ field: "reference", value: RECORD_REFERENCE })],
  ["read_review_receipt", () => ({ field: "reviewReceipt", value: REVIEW_RECEIPT })],
]);

const goalSpecs: readonly GoalSpec[] = [
  {
    id: "catalog-reference",
    title: "Catalog reference",
    description: "Reproduce the reference from the synthetic catalog record.",
    evidencePatterns: [RESULT_FILE],
    evidenceChecks: [{ pattern: RESULT_FILE, field: "reference", equals: RECORD_REFERENCE }],
  },
  {
    id: "review-receipt",
    title: "Review receipt",
    description: "Reproduce the receipt from the synthetic review note.",
    evidencePatterns: [RESULT_FILE],
    evidenceChecks: [{ pattern: RESULT_FILE, field: "reviewReceipt", equals: REVIEW_RECEIPT }],
  },
];

function modelStub(turn: number, visible: Memory): Decision {
  if (turn === 1) return { kind: "tool", name: "read_catalog_reference" };
  if (turn === 2) return { kind: "tool", name: "read_review_receipt" };
  return { kind: "answer", fields: { ...visible } };
}

function runArm(root: string, scenario: Scenario, mode: Mode, budget: Readonly<Budget>) {
  const dir = join(root, scenario.id, mode);
  const evidenceDir = join(dir, "evidence");
  const traceFile = join(scenario.id, mode, "trace.jsonl");
  const relayFile = join(dir, "relay.json");
  const taskId = randomUUID();
  mkdirSync(dir);
  const ledger = openHistory({ dbPath: join(dir, "history.sqlite"), evidenceDir });
  const trace = (event: Record<string, unknown>) => {
    appendFileSync(join(root, traceFile), `${JSON.stringify(event)}\n`, { mode: 0o600 });
  };

  let working: Memory = {};
  let session = 1;
  let modelTurns = 0;
  let toolAttempts = 0;
  let toolCalls = 0;
  let relayHandoffs = 0;
  let relayRestores = 0;
  let relayMisses = 0;
  let pendingHandoff = false;
  let handoff: Memory = {};
  let answer: Memory | undefined;
  let budgetLimit: keyof Budget | undefined;
  let deniedTool: string | undefined;

  try {
    ledger.seedGoals(taskId, goalsFromSpecs([...goalSpecs]));
    trace({ type: "configuration", scenario, mode, budget, allowedTools: [...toolStubs.keys()] });

    while (modelTurns < budget.maxModelTurns) {
      ++modelTurns;
      const reference = mode === "bare"
        ? undefined
        : ledger.listFacts(taskId).find((fact) => fact.tags.includes(REFERENCE_TAG))?.summary;
      const history: Memory = reference === undefined ? {} : { reference };
      if (pendingHandoff) {
        pendingHandoff = false;
        try {
          handoff = (JSON.parse(readFileSync(relayFile, "utf8")) as { working: Memory }).working;
          ++relayRestores;
          trace({ type: "relay_restored", session, handoff });
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          ++relayMisses;
          trace({ type: "relay_missing", session, continuedWith: "history" });
        }
      }
      const visible = { ...history, ...handoff, ...working };
      const decision = modelStub(modelTurns, visible);
      trace({ type: "model", turn: modelTurns, session, working, history, handoff, visible, decision });

      if (decision.kind === "answer") {
        answer = decision.fields;
        break;
      }

      ++toolAttempts;
      const tool = toolStubs.get(decision.name);
      const reason = !tool ? "tool_not_allowed" : toolCalls >= budget.maxToolCalls ? "maxToolCalls" : undefined;
      ledger.recordToolGate(taskId, {
        tool: decision.name,
        ok: reason === undefined,
        reason,
        detail: { turn: modelTurns, session },
      });
      if (reason || !tool) {
        trace({ type: "tool", turn: modelTurns, session, name: decision.name, allowed: false, reason });
        if (reason === "maxToolCalls") budgetLimit = reason;
        else deniedTool = decision.name;
        break;
      }

      ++toolCalls;
      const observation = tool();
      working[observation.field] = observation.value;
      trace({ type: "tool", turn: modelTurns, session, name: decision.name, allowed: true, observation });
      if (mode !== "bare" && observation.field === "reference") {
        ledger.appendFact({
          taskId,
          layer: "title",
          title: "Synthetic catalog reference observed",
          summary: observation.value,
          tags: [REFERENCE_TAG],
        });
      }

      // Cut at the same point in every arm. The receipt exists only in working
      // memory, while the catalog reference already has a History entry.
      if (toolCalls === scenario.cutAfterTool) {
        const receipt = working.reviewReceipt;
        if (mode === "relay" && receipt !== undefined) {
          const snapshot = { generation: 0, fromSession: session, working: { reviewReceipt: receipt } };
          writeFileSync(relayFile, JSON.stringify(snapshot, null, 2), { flag: "wx", mode: 0o600 });
          ledger.recordRelay(taskId, snapshot.generation, "fixture_boundary");
          ++relayHandoffs;
          pendingHandoff = true;
          trace({ type: "relay_written", session, snapshot });
          if (scenario.loseHandoff) {
            unlinkSync(relayFile);
            trace({ type: "relay_lost", session, generation: snapshot.generation });
          }
        }
        working = {};
        ++session;
        trace({ type: "session_boundary", turn: modelTurns, session, relayWritten: pendingHandoff });
      }
    }

    if (!answer && !budgetLimit && !deniedTool) budgetLimit = "maxModelTurns";
    const proof = answer ? writeEvidenceFile(evidenceDir, RESULT_FILE, JSON.stringify(answer, null, 2)) : undefined;
    const goals = goalSpecs.map(({ id }) => {
      if (!proof) return { id, passes: false, reason: "no final answer" };
      const verdict = ledger.assertGoal(taskId, id, [proof]);
      return { id, passes: verdict.ok, reason: verdict.ok ? undefined : verdict.reason };
    });
    const goalsPassed = goals.filter((goal) => goal.passes).length;
    let status: Status = "incomplete";
    if (budgetLimit) status = "budget_exhausted";
    else if (deniedTool) status = "failed";
    else if (goalsPassed === goals.length) status = "completed";
    const result = {
      mode, status, budgetLimit, deniedTool, modelTurns, toolAttempts, toolCalls,
      goalsPassed, goalsTotal: goals.length, goals, relayHandoffs, relayRestores, relayMisses, traceFile,
    };
    trace({ type: "terminal", ...result });
    return result;
  } finally {
    ledger.close();
  }
}

/** Offline fixture only. There are no provider, command or target inputs. */
export function runOfflineDifferential(root: string, budget: Readonly<Budget> = BUDGET) {
  mkdirSync(root, { recursive: true });
  return {
    fixture: "synthetic-catalog-review",
    budget,
    allowedTools: [...toolStubs.keys()],
    scenarios: SCENARIOS.map((scenario) => {
      mkdirSync(join(root, scenario.id));
      const bare = runArm(root, scenario, "bare", budget);
      const history = runArm(root, scenario, "history", budget);
      const relay = runArm(root, scenario, "relay", budget);
      return {
        ...scenario,
        rows: [bare, history, relay] as const,
        historyGain: history.goalsPassed - bare.goalsPassed,
        relayGain: relay.goalsPassed - history.goalsPassed,
      };
    }),
  };
}

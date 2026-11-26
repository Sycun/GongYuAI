import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { CreateTaskRequestSchema, type TaskRecord } from "@gongyuai/contracts";
import { CommandLedger, writeEvidenceFile } from "@gongyuai/history";
import { bootControlPlane, taskPaths } from "./index.js";
import { WorkerRunner } from "./runner.js";
import { SettingsStore } from "./settings.js";
import { ControlStore } from "./store.js";

function harness() {
  const root = mkdtempSync(join(tmpdir(), "gy-approval-"));
  const store = new ControlStore(root);
  const settings = new SettingsStore(root, root);
  const runner = new WorkerRunner(store, {
    ownerId: "approval-test",
    leaseMs: 10_000,
    mode: "local",
    workerImage: "",
  }, settings);
  const task = store.createTask(CreateTaskRequestSchema.parse({
    name: "approval branch",
    mock: true,
    auth: { authorizationNote: "local isolated fixture", targets: ["example.invalid"], capability: "scan" },
    goals: [{ id: "g", title: "local", description: "local", evidencePatterns: ["test.txt"] }],
  }));
  return {
    root,
    store,
    settings,
    runner,
    task,
    close() {
      store.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

function withLedger<T>(task: TaskRecord, fn: (ledger: CommandLedger) => T): T {
  const ledger = new CommandLedger(task.dataDir);
  try {
    return fn(ledger);
  } finally {
    ledger.close();
  }
}

function queue(task: TaskRecord, command: string) {
  return withLedger(task, (ledger) => {
    ledger.activate(task.id, task.fence);
    return ledger.request(task.id, task.fence, {
      tool: "shell",
      summary: command,
      digest: "",
      command,
    });
  });
}

test("auto confirmation allows an in-scope command without calling the review model", async () => {
  const h = harness();
  try {
    h.settings.saveChatApproval({ scope: "read-only", confirmation: "auto", reviewer: null });
    const ticket = queue(h.task, "uname -m");
    assert.equal(await h.runner.reconcileCommands(h.task), true);
    const settled = withLedger(h.task, (ledger) => {
      assert.equal(ledger.state(ticket.id), "allowed");
      return ledger.get(ticket.id);
    });
    assert.equal(settled?.receipt?.decision, "allow");
    assert.equal(settled?.receipt?.actor, "policy");
    assert.equal(settled?.receipt?.model, "");
    assert.match(settled?.receipt?.reason ?? "", /不调审批模型/);
    assert.equal(h.store.get(h.task.id)?.commandReview, undefined);
    assert.equal(h.store.get(h.task.id)?.status, "queued");
    assert.equal(await h.runner.reconcileCommands(h.store.get(h.task.id)!), false);
  } finally {
    h.close();
  }
});

test("manual confirmation waits for the operator and does not auto-allow", async () => {
  const h = harness();
  try {
    h.settings.saveChatApproval({ scope: "read-only", confirmation: "manual", reviewer: null });
    const ticket = queue(h.task, "uname -m");
    assert.equal(await h.runner.reconcileCommands(h.task), true);
    withLedger(h.task, (ledger) => {
      assert.equal(ledger.state(ticket.id), "awaiting_user");
      assert.equal(ledger.get(ticket.id)?.receipt, undefined);
    });
    const review = h.store.get(h.task.id)?.commandReview;
    assert.equal(review?.decision, "waiting");
    assert.equal(review?.mode, "manual");
    assert.equal(review?.id, ticket.id);
    assert.equal(h.store.get(h.task.id)?.status, "queued");
  } finally {
    h.close();
  }
});

test("out-of-scope commands are policy-blocked before auto or manual approval", async () => {
  for (const confirmation of ["auto", "manual"] as const) {
    const h = harness();
    try {
      h.settings.saveChatApproval({ scope: "local-validation", confirmation, reviewer: null });
      const ticket = queue(h.task, "curl -s http://evil.test/");
      assert.equal(await h.runner.reconcileCommands(h.task), true);
      const blocked = withLedger(h.task, (ledger) => {
        assert.equal(ledger.state(ticket.id), "held");
        return ledger.get(ticket.id);
      });
      assert.equal(blocked?.receipt?.actor, "policy");
      assert.equal(blocked?.receipt?.decision, "block");
      assert.match(blocked?.receipt?.reason ?? "", /evil\.test/);
      assert.equal(h.store.get(h.task.id)?.status, "queued");
      assert.notEqual(h.store.get(h.task.id)?.commandReview?.decision, "waiting");
      assert.equal(await h.runner.reconcileCommands(h.store.get(h.task.id)!), true);
      const paused = h.store.get(h.task.id)!;
      assert.equal(paused.status, "paused");
      assert.equal(paused.commandReview?.decision, "block");
      assert.match(paused.commandReview?.reason ?? "", /evil\.test/);
    } finally {
      h.close();
    }
  }
});

test("hostless MCP actions in auto mode are evaluated by reviewCommand instead of blindly auto-allowed", async () => {
  const h = harness();
  try {
    h.settings.saveChatApproval({ scope: "read-only", confirmation: "auto", reviewer: null });
    // 1) MCP WITH declared in-scope host is deterministically verified → auto-allowed
    const scopedMcp = withLedger(h.task, (ledger) => {
      ledger.activate(h.task.id, h.task.fence);
      return ledger.request(h.task.id, h.task.fence, {
        tool: "mcp",
        summary: "mcp_http_fetch example.invalid",
        digest: "",
        hosts: ["example.invalid"],
      });
    });
    assert.equal(await h.runner.reconcileCommands(h.task), true);
    withLedger(h.task, (ledger) => {
      assert.equal(ledger.state(scopedMcp.id), "allowed");
    });

    // 2) Hostless MCP has unverified local/external side-effects → goes to reviewCommand (fails closed to unavailable when unconfigured)
    const hostlessMcp = withLedger(h.task, (ledger) =>
      ledger.request(h.task.id, h.task.fence, {
        tool: "mcp",
        summary: "mcp_filesystem_delete",
        digest: "",
      }),
    );
    assert.equal(await h.runner.reconcileCommands(h.task), true);
    for (let i = 0; i < 30; i++) {
      const state = withLedger(h.task, (ledger) => ledger.state(hostlessMcp.id));
      if (state !== "pending") break;
      await new Promise((r) => setTimeout(r, 20));
    }
    const settled = withLedger(h.task, (ledger) => ledger.get(hostlessMcp.id));
    assert.equal(settled?.receipt?.decision, "unavailable");
  } finally {
    h.close();
  }
});

test("GET /tasks terminalListCache invalidates immediately when a goal is asserted on an incomplete task", async () => {
  const root = mkdtempSync(join(tmpdir(), "gy-list-cache-"));
  const plane = await bootControlPlane({ dataRoot: root, port: 0, isolated: true });
  try {
    const createRes = await fetch(`${plane.url}/tasks`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "terminal-cache-invalidation",
        mock: true,
        auth: { targets: ["cache.invalid"], capability: "scan" },
        goals: [{ id: "g1", title: "Proof", description: "proof", evidencePatterns: ["proof.txt"] }],
      }),
    });
    const { task: created } = (await createRes.json()) as { task: { id: string } };
    await plane.runner.stop(created.id);

    // Prime terminalListCache with passes=false
    const listBefore = (await (await fetch(`${plane.url}/tasks`)).json()) as {
      tasks: Array<{ id: string; goals: Array<{ id: string; passes: boolean }> }>;
    };
    assert.equal(listBefore.tasks.find((t) => t.id === created.id)?.goals[0]?.passes, false);

    // Write evidence & assert goal on the stopped (terminal) task
    const record = plane.store.get(created.id)!;
    writeEvidenceFile(taskPaths(record.dataDir).evidenceDir, "proof.txt", "verified");
    const assertRes = await fetch(`${plane.url}/tasks/${created.id}/goals/assert`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ goalId: "g1" }),
    });
    assert.equal(assertRes.status, 200);

    // GET /tasks must reflect passes=true immediately (not serve stale cached goals)
    const listAfter = (await (await fetch(`${plane.url}/tasks`)).json()) as {
      tasks: Array<{ id: string; goals: Array<{ id: string; passes: boolean }> }>;
    };
    assert.equal(listAfter.tasks.find((t) => t.id === created.id)?.goals[0]?.passes, true);
  } finally {
    await plane.close();
    rmSync(root, { recursive: true, force: true });
  }
});

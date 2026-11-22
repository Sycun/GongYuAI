import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { goalsFromSpecs, WorkerManifestSchema, type WorkerManifest } from "@gongyuai/contracts";
import { openHistory } from "@gongyuai/history";
import { runBareLoop } from "./bare-loop.js";
import { runMockLoop } from "./mock-loop.js";
import { listRelayProtocols } from "./relay.js";
import { workerStatusPath, type WorkerStatusFile } from "./status.js";

function fixture(dataDir: string, patterns: string[]): WorkerManifest {
  return WorkerManifestSchema.parse({
    taskId: "11111111-1111-4111-8111-111111111111",
    dataDir,
    workspaceDir: join(dataDir, "workspace"),
    historyDb: join(dataDir, "history.sqlite"),
    durableDb: join(dataDir, "durable.sqlite"),
    evidenceDir: join(dataDir, "evidence"),
    auth: { targets: ["example.invalid"], authorizationNote: "Synthetic local test" },
    budget: { relayMinToolCalls: 2 },
    goals: goalsFromSpecs([{ id: "fixture", title: "Synthetic proof", description: "Proof fixture", evidencePatterns: patterns }]),
    mock: true,
  });
}

test("all mock arms share fixture scoring and tool counts, with Relay only in the Relay arm", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "gy-p3-mock-"));
  const keys = ["GY_MOCK_RELAY", "GY_RELAY_MIN_TOOL_CALLS", "GY_RELAY_TOKEN_THRESHOLD", "GY_SMOKE_PAUSE_MS"] as const;
  const saved = keys.map((key) => process.env[key]);
  t.after(() => {
    for (const [i, key] of keys.entries()) {
      const value = saved[i];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(root, { recursive: true, force: true });
  });
  delete process.env.GY_SMOKE_PAUSE_MS;

  for (const mode of ["bare", "history", "relay"] as const) {
    const manifest = fixture(join(root, mode), ["recon/*.txt", "notes/*.md"]);
    process.env.GY_MOCK_RELAY = mode === "relay" ? "on" : "off";
    if (mode === "history") {
      // The mock's synthetic thresholds would otherwise permit both triggers.
      process.env.GY_RELAY_MIN_TOOL_CALLS = "1";
      process.env.GY_RELAY_TOKEN_THRESHOLD = "1";
    } else {
      delete process.env.GY_RELAY_MIN_TOOL_CALLS;
      delete process.env.GY_RELAY_TOKEN_THRESHOLD;
    }
    await (mode === "bare" ? runBareLoop(manifest) : runMockLoop(manifest));
    const status = JSON.parse(readFileSync(workerStatusPath(manifest.dataDir), "utf8")) as WorkerStatusFile;
    assert.equal(status.status, "completed", mode);
    assert.deepEqual(status.usage, { tokens: 0, toolCalls: 2, installs: 0 }, mode);
    const history = openHistory({ dbPath: manifest.historyDb, evidenceDir: manifest.evidenceDir });
    try {
      const [goal] = history.listGoals(manifest.taskId);
      assert.equal(goal?.passes, true, mode);
      assert.ok(history.integrationUsage(manifest.taskId).since);
      assert.deepEqual(history.integrationUsage(manifest.taskId).rows, []);
      assert.deepEqual(goal?.evidencePaths, ["recon/banner.txt", "notes/mock.md"], mode);
      const events = history.listEvents(manifest.taskId);
      assert.equal(events.filter((event) => event.kind === "tool_gate" && event.payload.ok).length, 2, mode);
      const expected = mode === "relay" ? 1 : 0;
      assert.equal(events.filter((event) => event.kind === "relay_written").length, expected, mode);
      assert.equal(listRelayProtocols(manifest.workspaceDir).length, expected, mode);
      if (mode === "bare") assert.equal(history.listIntents(manifest.taskId).length, 0);
    } finally {
      history.close();
    }
  }

  for (const [mode, run] of [["bare", runBareLoop], ["history", runMockLoop]] as const) {
    process.env.GY_MOCK_RELAY = "off";
    const manifest = fixture(join(root, `${mode}-incomplete`), ["board/ALL_COMPLETE.json"]);
    await run(manifest);
    const status = JSON.parse(readFileSync(workerStatusPath(manifest.dataDir), "utf8")) as WorkerStatusFile;
    assert.equal(status.status, "incomplete", mode);
    assert.equal(existsSync(join(manifest.evidenceDir, "board", "ALL_COMPLETE.json")), false, mode);
  }
});

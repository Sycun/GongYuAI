import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { goalsFromSpecs } from "@gongyuai/contracts";
import { coverageDigest } from "@gongyuai/control-plane";
import { openHistory, writeEvidenceFile } from "@gongyuai/history";
import { compareCommand, snapshotCommand } from "./coverage-audit.js";

test("snapshotCommand atomically writes coverage handoff and compareCommand sets exitCode=2 on mismatch", () => {
  const root = mkdtempSync(join(tmpdir(), "gy-cli-cov-"));
  const taskId = "90ae45d3-6406-4860-a494-395dcdac3007";
  const taskDir = join(root, "tasks", taskId);
  const evidenceDir = join(taskDir, "evidence");
  const h = openHistory({ dbPath: join(taskDir, "history.sqlite"), evidenceDir });

  const origLog = console.log;
  const prevExitCode = process.exitCode;
  const logs: string[] = [];
  console.log = (msg?: unknown) => logs.push(String(msg ?? ""));

  try {
    h.seedGoals(
      taskId,
      goalsFromSpecs([{ id: "g1", title: "Goal 1", description: "desc", evidencePatterns: ["proof.txt"] }]),
    );
    writeEvidenceFile(evidenceDir, "proof.txt", "verified-bytes");
    h.recordCoverage(taskId, {
      goalId: "g1",
      status: "tested",
      reason: "manual check",
      reviewer: "op",
      evidencePath: "proof.txt",
    });

    assert.throws(() => snapshotCommand([], root), /gy coverage-snapshot/);

    const snapPath = join(root, "snap.json");
    snapshotCommand([taskId, "--out", snapPath], root);
    const snapBytes = readFileSync(snapPath);
    const snapSha = coverageDigest(snapBytes);

    // Matching reference -> exitCode remains untouched
    const refMatchPath = join(root, "ref-match.json");
    const refMatchBytes = Buffer.from(
      JSON.stringify({
        version: 1,
        taskId,
        split: "development",
        goals: [{ goalId: "g1", status: "tested", evidenceSha256: coverageDigest(Buffer.from("verified-bytes")) }],
      }),
    );
    writeFileSync(refMatchPath, refMatchBytes);
    process.exitCode = 0;
    compareCommand([
      snapPath,
      refMatchPath,
      "--snapshot-sha256",
      snapSha,
      "--reference-sha256",
      coverageDigest(refMatchBytes),
    ]);
    assert.equal(process.exitCode, 0);

    // Mismatched reference -> exitCode becomes 2
    const refMismatchPath = join(root, "ref-mismatch.json");
    const refMismatchBytes = Buffer.from(
      JSON.stringify({
        version: 1,
        taskId,
        split: "development",
        goals: [{ goalId: "g1", status: "blocked" }],
      }),
    );
    writeFileSync(refMismatchPath, refMismatchBytes);
    compareCommand([
      snapPath,
      refMismatchPath,
      "--snapshot-sha256",
      snapSha,
      "--reference-sha256",
      coverageDigest(refMismatchBytes),
    ]);
    assert.equal(process.exitCode, 2);
  } finally {
    console.log = origLog;
    process.exitCode = prevExitCode;
    h.close();
    rmSync(root, { recursive: true, force: true });
  }
});

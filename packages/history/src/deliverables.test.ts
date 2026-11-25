import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { openHistory, writeEvidenceFile } from "./index.js";
import { materializeTaskDeliverables } from "./deliverables.js";

test("materializeTaskDeliverables creates ledger and report and preserves manual sections on re-run", () => {
  const root = mkdtempSync(join(tmpdir(), "gy-deliv-"));
  const evidenceDir = join(root, "evidence");
  const history = openHistory({ dbPath: join(root, "history.sqlite"), evidenceDir });
  try {
    const taskId = "33333333-3333-4333-8333-333333333333";
    const auth = {
      authorizationNote: "test auth",
      targets: ["10.0.0.5"],
      outOfScope: ["10.0.0.99"],
      capability: "full" as const,
    };
    history.seedAssetsFromAuth(taskId, auth);
    const { finding } = history.recordFinding({
      taskId,
      title: "Unauthenticated RCE",
      asset: "10.0.0.5",
      vulnClass: "CWE-94",
      severity: "critical",
      endpoint: "http://10.0.0.5:8080/eval",
      pocCurl: "curl -sS -X POST 'http://10.0.0.5:8080/eval'",
    });
    const ev = writeEvidenceFile(evidenceDir, "rce.txt", "uid=0(root)");
    history.verifyFinding(taskId, finding.id, {
      evidencePaths: [ev],
      repro: "POST /eval executes command",
      impact: "Full RCE",
      fix: "Disable eval endpoint",
      verifiedBy: "w0",
    });

    const first = materializeTaskDeliverables({ taskId, evidenceDir, auth }, history);
    assert.ok(first.ledgerPath);
    assert.ok(first.reportPath);
    const ledgerText = readFileSync(first.ledgerPath, "utf8");
    const reportText = readFileSync(first.reportPath, "utf8");
    assert.match(ledgerText, /Autonomous Engagement Progress Ledger/);
    assert.match(ledgerText, /Unauthenticated RCE/);
    assert.match(reportText, /Engagement Report/);
    assert.match(reportText, /curl -sS -X POST/);

    // Simulate model manually prepending custom executive narrative before the auto block.
    const manualHeader = "# Custom Executive Summary\n\nHand-crafted notes by analyst.\n\n";
    writeFileSync(first.reportPath, manualHeader + reportText, "utf8");

    // Re-running materializer must preserve manual narrative and refresh auto block cleanly.
    const second = materializeTaskDeliverables({ taskId, evidenceDir, auth }, history);
    assert.ok(second.reportPath);
    const merged = readFileSync(second.reportPath, "utf8");
    assert.match(merged, /Hand-crafted notes by analyst/);
    assert.equal((merged.match(/gongyuai:auto-deliverable:start/g) ?? []).length, 1);
  } finally {
    history.close();
    rmSync(root, { recursive: true, force: true });
  }
});

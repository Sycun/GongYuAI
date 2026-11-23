import assert from "node:assert/strict";
import { test } from "node:test";
import { deriveCoverageMatrix } from "./ops.js";

const base = {
  assets: ["app.lab.test"],
  endpoints: ["https://app.lab.test/login?x=1"],
  techniques: ["CWE-89", "CWE-79"],
  materials: [],
  intents: [],
  manual: [],
  findings: [
    {
      id: "f1",
      asset: "app.lab.test",
      vulnClass: "CWE-89",
      status: "verified",
      evidence: [{ path: "http:tx-1", sha256: "a".repeat(64) }],
      endpoint: "https://app.lab.test/login?x=1",
    },
  ],
};

test("endpoint-level coverage: verified endpoint row keeps path identity", () => {
  const cells = deriveCoverageMatrix(base);
  const endpointCell = cells.find(
    (cell) => cell.asset === "https://app.lab.test/login?x=1" && cell.technique === "CWE-89",
  );
  assert.ok(endpointCell);
  assert.equal(endpointCell!.state, "verified");
  assert.equal(endpointCell!.findingIds.length, 1);
  // Host cell is separate and still exists.
  assert.ok(cells.some((cell) => cell.asset === "app.lab.test" && cell.technique === "CWE-89"));
  // Untested technique at the endpoint produces no endpoint cell.
  assert.equal(
    cells.filter((cell) => cell.asset.startsWith("https://")).length,
    1,
  );
});

test("endpoint coverage: retracted evidence downgrades the endpoint row", () => {
  const cells = deriveCoverageMatrix({
    ...base,
    retractedEvidence: ["http:tx-1"],
  });
  const endpointCell = cells.find((cell) => cell.asset === "https://app.lab.test/login?x=1");
  assert.equal(endpointCell?.state, "retracted");
  assert.equal(endpointCell?.retractedOnly, true);
});

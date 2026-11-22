import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { runOfflineDifferential } from "../packages/worker/src/offline-differential.js";

const root = resolve(".gongyuai", "offline-diff", randomUUID());
const summary = runOfflineDifferential(root);
writeFileSync(join(root, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`, { mode: 0o600 });

console.log("| Scenario | Bare goals | History goals | History + Relay goals | History gain | Relay gain | Relay written / restored / missing |");
console.log("| --- | ---: | ---: | ---: | ---: | ---: | ---: |");
for (const scenario of summary.scenarios) {
  const scores = scenario.rows.map((row) => `${row.goalsPassed}/${row.goalsTotal}`).join(" | ");
  const relay = scenario.rows[2];
  const handoffs = `${relay.relayHandoffs} / ${relay.relayRestores} / ${relay.relayMisses}`;
  console.log(`| ${scenario.label} | ${scores} | ${scenario.historyGain} | ${scenario.relayGain} | ${handoffs} |`);
}
console.log(`Per-arm counters and traces: ${root}`);

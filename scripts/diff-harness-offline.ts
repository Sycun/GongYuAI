import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { runOfflineDifferential } from "../packages/worker/src/offline-differential.js";

const root = resolve(".gongyuai", "offline-diff", randomUUID());
const summary = runOfflineDifferential(root);
writeFileSync(join(root, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`, { mode: 0o600 });

console.log("| Mode | Status | Goals | Model turns | Tool attempts | Tool calls | Relay handoffs |");
console.log("| --- | --- | ---: | ---: | ---: | ---: | ---: |");
for (const row of summary.rows) {
  console.log(`| ${row.mode} | ${row.status} | ${row.goalsPassed}/${row.goalsTotal} | ${row.modelTurns} | ${row.toolAttempts} | ${row.toolCalls} | ${row.relayHandoffs} |`);
}
console.log(`Summary and per-mode traces: ${root}`);

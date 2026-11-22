import { randomUUID } from "node:crypto";
import { linkSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { captureCoverage, compareCoverage, coverageDigest } from "@gongyuai/control-plane";

export function snapshotCommand(args: string[], dataRoot: string): void {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: { out: { type: "string" } } });
  if (positionals.length !== 1 || !values.out) throw new Error("gy coverage-snapshot <taskId> --out FILE");
  const result = captureCoverage(dataRoot, positionals[0]!);
  const bytes = Buffer.from(JSON.stringify(result, null, 2) + "\n");
  const dest = resolve(values.out);
  const temp = join(dirname(dest), `.gy-snapshot-${randomUUID()}.tmp`);
  try {
    writeFileSync(temp, bytes, { flag: "wx", mode: 0o600 });
    // Publish complete bytes only; a previous handoff must survive a retry.
    linkSync(temp, dest);
  } finally {
    rmSync(temp, { force: true });
  }
  console.log(JSON.stringify({ file: dest, sha256: coverageDigest(bytes), goals: result.goals.length }));
}

export function compareCommand(args: string[]): void {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: {
    "snapshot-sha256": { type: "string" }, "reference-sha256": { type: "string" },
  } });
  if (positionals.length !== 2 || !values["snapshot-sha256"] || !values["reference-sha256"]) {
    throw new Error("gy coverage-compare SNAPSHOT REFERENCE --snapshot-sha256 HASH --reference-sha256 HASH");
  }
  const result = compareCoverage(readFileSync(positionals[0]!), readFileSync(positionals[1]!), {
    snapshot: values["snapshot-sha256"], reference: values["reference-sha256"],
  });
  console.log(JSON.stringify(result, null, 2));
  if (!result.wholeTaskMatch) process.exitCode = 2;
}

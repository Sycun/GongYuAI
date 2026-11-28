import { spawnSync } from "node:child_process";
import { mkdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const netdDir = join(repoRoot, "services", "netd");
const outBin = join(repoRoot, "bin", "gy-netd");

const probe = spawnSync("go", ["version"], { encoding: "utf8" });
if (probe.error || (probe.status ?? 1) !== 0) {
  console.log("[build:netd] go toolchain not found — skipping gy-netd build (TS fallback remains active).");
  process.exit(0);
}

mkdirSync(dirname(outBin), { recursive: true });
const build = spawnSync(
  "go",
  ["build", "-trimpath", "-ldflags=-s -w", "-o", outBin, "./cmd/gy-netd"],
  {
    cwd: netdDir,
    env: { ...process.env, CGO_ENABLED: "0" },
    stdio: "inherit",
  },
);
if ((build.status ?? 1) !== 0) {
  process.exit(build.status ?? 1);
}
const mb = (statSync(outBin).size / 1_048_576).toFixed(2);
console.log(`[build:netd] built ${outBin} (${mb} MiB, ${probe.stdout.trim()})`);

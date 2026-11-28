import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const netdDir = join(repoRoot, "services", "netd");

const probe = spawnSync("go", ["version"], { encoding: "utf8" });
if (probe.error || (probe.status ?? 1) !== 0) {
  if (process.env.GY_REQUIRE_GO === "1" || process.env.CI === "true") {
    console.error("[test:go] go toolchain is required in CI / GY_REQUIRE_GO=1 but was not found.");
    process.exit(1);
  }
  console.log("[test:go] go toolchain not found — skipping Go unit tests.");
  process.exit(0);
}

const extraArgs = process.argv.slice(2);
const args = ["test", "-race", "-cover", ...extraArgs, "./..."];
const run = spawnSync("go", args, {
  cwd: netdDir,
  stdio: "inherit",
});
process.exit(run.status ?? 1);

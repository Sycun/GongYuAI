#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { WorkerManifestSchema } from "@gongyuai/contracts";
import { runMockLoop } from "./mock-loop.js";
import { runPiLoop } from "./pi-loop.js";

function parseArgs(argv: string[]): { manifest: string } {
  const idx = argv.indexOf("--manifest");
  const fromEnv = process.env.GY_MANIFEST;
  if (idx >= 0 && argv[idx + 1]) return { manifest: argv[idx + 1]! };
  if (fromEnv) return { manifest: fromEnv };
  throw new Error("usage: gy-worker --manifest <path> (or GY_MANIFEST)");
}

async function main(): Promise<void> {
  const { manifest: path } = parseArgs(process.argv.slice(2));
  const raw = JSON.parse(readFileSync(path, "utf8"));
  const manifest = WorkerManifestSchema.parse(raw);

  // Rewrite paths when running inside Docker (/task mount)
  if (process.env.GY_MANIFEST?.startsWith("/task")) {
    manifest.dataDir = "/task";
    manifest.historyDb = "/task/history.sqlite";
    manifest.durableDb = "/task/durable.sqlite";
    manifest.evidenceDir = "/task/evidence";
    manifest.workspaceDir = "/task/workspace";
  }

  console.log(`[gy-worker] task=${manifest.taskId} mock=${manifest.mock}`);
  if (manifest.mock) {
    await runMockLoop(manifest);
  } else {
    await runPiLoop(manifest);
  }
  console.log(`[gy-worker] finished task=${manifest.taskId}`);
}

main().catch((err) => {
  console.error("[gy-worker] fatal", err);
  process.exit(1);
});

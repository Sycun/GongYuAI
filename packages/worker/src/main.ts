#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { WorkerManifestSchema } from "@gongyuai/contracts";
import { bindEvidencePaceManifest } from "./board-policy.js";
import { runBareLoop } from "./bare-loop.js";
import { runMockLoop } from "./mock-loop.js";
import { runPiLoop } from "./pi-loop.js";
import { closeExecRuntime } from "./exec-runtime.js";
import { closeOastListeners } from "./oast-tools.js";

function parseArgs(argv: string[]): { manifest: string } {
  const idx = argv.indexOf("--manifest");
  const fromEnv = process.env.GY_MANIFEST;
  if (idx >= 0 && argv[idx + 1]) return { manifest: argv[idx + 1]! };
  if (fromEnv) return { manifest: fromEnv };
  throw new Error("usage: gy-worker --manifest <path> (or GY_MANIFEST)");
}

function harnessMode(): "default" | "bare" {
  const raw = (process.env.GY_HARNESS ?? "default").trim().toLowerCase();
  return raw === "bare" ? "bare" : "default";
}

async function main(): Promise<void> {
  const { manifest: path } = parseArgs(process.argv.slice(2));
  const raw = JSON.parse(readFileSync(path, "utf8"));
  const manifest = WorkerManifestSchema.parse(raw);

  // Rewrite paths when running inside Docker (/task mount)
  if (process.env.GY_MANIFEST?.startsWith("/task")) {
    const slot = manifest.workerSlot ?? 0;
    manifest.dataDir = "/task";
    manifest.historyDb = "/task/history.sqlite";
    manifest.durableDb =
      slot <= 0 ? "/task/durable.sqlite" : `/task/durable-w${slot}.sqlite`;
    manifest.evidenceDir = "/task/evidence";
    manifest.workspaceDir = "/task/workspace";
  }

  bindEvidencePaceManifest(manifest);
  const harness = harnessMode();
  console.log(
    `[gy-worker] task=${manifest.taskId} slot=${manifest.workerSlot}/${manifest.workerCount} mock=${manifest.mock} harness=${harness}`,
  );
  let shuttingDown = false;
  const gracefulShutdown = (sig: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[gy-worker] received ${sig}, preserving detached sessions and closing listeners`);
    try {
      closeExecRuntime({ keepSessions: true });
    } catch {
      /* best-effort */
    }
    void closeOastListeners()
      .catch(() => {})
      .finally(() => {
        process.exit(0);
      });
  };
  process.once("SIGTERM", () => gracefulShutdown("SIGTERM"));
  process.once("SIGINT", () => gracefulShutdown("SIGINT"));

  try {
    if (harness === "bare") {
      await runBareLoop(manifest);
    } else if (manifest.mock) {
      await runMockLoop(manifest);
    } else {
      await runPiLoop(manifest);
    }
  } finally {
    // P14-B4: PTY sessions detach and survive restarts; only listeners are closed.
    // 后台作业按设计继续跑，等下一次 poll 收口。
    closeExecRuntime({ keepSessions: true });
    await closeOastListeners();
  }
  console.log(
    `[gy-worker] finished task=${manifest.taskId} slot=${manifest.workerSlot}`,
  );
}

main().catch((err) => {
  console.error("[gy-worker] fatal", err);
  process.exit(1);
});

import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { WorkerManifest } from "@gongyuai/contracts";
import { openHistory } from "@gongyuai/history";
import { CheckpointStore } from "./checkpoint.js";
import {
  appendProgress,
  installTool,
  runShell,
  writeEvidence,
  type ToolContext,
} from "./tools.js";
import { writeWorkerStatus } from "./status.js";

/**
 * Scripted closed-loop worker for smoke / CI without an LLM.
 * Exercises History, evidence gate, install_tool, checkpoint resume, report.
 */
export async function runMockLoop(manifest: WorkerManifest): Promise<void> {
  const history = openHistory({
    dbPath: manifest.historyDb,
    evidenceDir: manifest.evidenceDir,
  });
  const ckpt = new CheckpointStore(manifest.durableDb);
  let state = ckpt.load();

  const ctx: ToolContext = {
    manifest,
    history,
    usage: { toolCalls: state.toolCalls, installs: state.installs },
  };

  writeWorkerStatus(manifest.dataDir, {
    status: "running",
    usage: { tokens: state.tokens, toolCalls: ctx.usage.toolCalls, installs: ctx.usage.installs },
  });

  try {
    if (state.phase === "init") {
      mkdirSync(manifest.workspaceDir, { recursive: true });
      writeFileSync(
        join(manifest.workspaceDir, "PROGRESS.md"),
        `# Progress\n\nInitializer for task ${manifest.taskId}\n\n`,
      );
      history.appendFact({
        taskId: manifest.taskId,
        layer: "title",
        title: "Task initialized",
        summary: `Authorized targets: ${manifest.auth.targets.join(", ")}`,
      });
      history.appendFact({
        taskId: manifest.taskId,
        layer: "summary",
        title: "Auth scope loaded",
        summary: manifest.auth.authorizationNote.slice(0, 500),
      });
      appendProgress(manifest.workspaceDir, "initializer complete");
      state.phase = "loop";
      state.step = 0;
      ckpt.save(state);
    }

    const target = manifest.auth.targets[0] ?? "127.0.0.1";

    while (state.phase === "loop") {
      const pauseMs = Number(process.env.GY_SMOKE_PAUSE_MS ?? 0);
      if (pauseMs > 0) {
        await new Promise((r) => setTimeout(r, pauseMs));
      }
      if (!history.allGoalsPass(manifest.taskId)) {
        // Step 0: ensure curl exists (may stub-install)
        if (state.step === 0) {
          const intent = history.proposeIntent({
            taskId: manifest.taskId,
            title: "Ensure curl available",
            summary: "install_tool if missing",
          });
          history.claimIntent(manifest.taskId, intent.id, "mock-worker");
          const installed = installTool(ctx, { name: "curl" });
          history.concludeIntent(
            manifest.taskId,
            intent.id,
            installed.ok ? "succeeded" : "failed",
            installed.detail,
          );
          state.step = 1;
          state.toolCalls = ctx.usage.toolCalls;
          state.installs = ctx.usage.installs;
          ckpt.save(state);
          continue;
        }

        // Step 1: recon evidence
        if (state.step === 1) {
          const intent = history.proposeIntent({
            taskId: manifest.taskId,
            title: "Collect recon banner",
            summary: `Probe ${target}`,
          });
          history.claimIntent(manifest.taskId, intent.id, "mock-worker");

          let banner = "";
          try {
            const probe = runShell(
              ctx,
              `curl -sI --max-time 5 ${JSON.stringify(target)} | head -n 20 || true`,
            );
            banner = probe.stdout || probe.stderr || "no response";
          } catch (err) {
            banner = `probe error: ${err instanceof Error ? err.message : String(err)}`;
          }

          const evidencePath = writeEvidence(
            ctx,
            "recon/banner.txt",
            `target=${target}\n${banner}\n`,
          );
          history.appendFact({
            taskId: manifest.taskId,
            layer: "evidence",
            title: "HTTP banner captured",
            summary: banner.slice(0, 200),
            evidencePath,
            intentId: intent.id,
          });
          history.appendFact({
            taskId: manifest.taskId,
            layer: "title",
            title: `Recon done for ${target}`,
          });

          const goals = history.listGoals(manifest.taskId);
          const recon = goals.find((g) => g.id === "recon") ?? goals[0];
          if (recon) {
            const asserted = history.assertGoal(manifest.taskId, recon.id, [evidencePath]);
            if (!asserted.ok) {
              throw new Error(asserted.reason);
            }
          }

          history.concludeIntent(manifest.taskId, intent.id, "succeeded", "banner saved");
          appendProgress(manifest.workspaceDir, "recon goal passed");
          state.step = 2;
          state.toolCalls = ctx.usage.toolCalls;
          state.installs = ctx.usage.installs;
          ckpt.save(state);
          continue;
        }

        // Step 2: report goal if present
        if (state.step >= 2) {
          const goals = history.listGoals(manifest.taskId);
          const remaining = goals.filter((g) => !g.passes);
          if (remaining.length === 0) {
            state.phase = "report";
            ckpt.save(state);
            break;
          }
          for (const g of remaining) {
            const path = writeEvidence(
              ctx,
              `goals/${g.id}.md`,
              `# ${g.title}\n\n${g.description}\n\nMock evidence for ${g.id}.\n`,
            );
            const asserted = history.assertGoal(manifest.taskId, g.id, [path]);
            if (!asserted.ok) {
              // If patterns don't match goals/*.md, try first pattern filename
              const fallback = writeEvidence(
                ctx,
                g.evidencePatterns[0]!.replace(/\*/g, "mock"),
                `mock evidence for ${g.id}\n`,
              );
              const again = history.assertGoal(manifest.taskId, g.id, [fallback]);
              if (!again.ok) throw new Error(again.reason);
            } else {
              void path;
            }
          }
          state.phase = "report";
          ckpt.save(state);
        }
      } else {
        state.phase = "report";
        ckpt.save(state);
      }
    }

    if (state.phase === "report") {
      const report = buildReport(manifest, history.overview(manifest.taskId));
      writeFileSync(join(manifest.dataDir, "report.md"), report);
      history.recordReport(manifest.taskId, "report.md");
      appendProgress(manifest.workspaceDir, "report written");
      state.phase = "done";
      ckpt.save(state);
    }

    writeWorkerStatus(manifest.dataDir, {
      status: "completed",
      usage: {
        tokens: state.tokens,
        toolCalls: ctx.usage.toolCalls,
        installs: ctx.usage.installs,
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    state.lastError = message;
    ckpt.save(state);
    writeWorkerStatus(manifest.dataDir, {
      status: message.includes("maxWallMs") || message.includes("maxToolCalls")
        ? "budget_exhausted"
        : "failed",
      error: message,
      usage: {
        tokens: state.tokens,
        toolCalls: ctx.usage.toolCalls,
        installs: ctx.usage.installs,
      },
    });
    throw err;
  } finally {
    ckpt.close();
    history.close();
  }
}

function buildReport(manifest: WorkerManifest, overview: string): string {
  return `# GongYuAI Report

Task: ${manifest.taskId}
Targets: ${manifest.auth.targets.join(", ")}
Authorization: ${manifest.auth.authorizationNote}

## History overview

${overview}

## Notes

Generated by mock worker closed-loop for MVP verification.
`;
}

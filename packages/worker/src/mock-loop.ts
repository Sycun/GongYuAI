import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { isExploreLeader, ORIGIN_FACT_ID, type WorkerManifest } from "@gongyuai/contracts";
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
import {
  canRelay,
  formatRelayInjection,
  listRelayProtocols,
  writeRelayProtocol,
} from "./relay.js";

/** Follower mock slots wait for leader goals; avoids scripted propose/claim races. */
async function runMockFollower(manifest: WorkerManifest): Promise<void> {
  const history = openHistory({
    dbPath: manifest.historyDb,
    evidenceDir: manifest.evidenceDir,
  });
  const slot = manifest.workerSlot ?? 0;
  writeWorkerStatus(
    manifest.dataDir,
    {
      status: "running",
      usage: { tokens: 0, toolCalls: 0, installs: 0 },
      workerSlot: slot,
      workerId: manifest.workerId,
    },
    slot,
  );
  const start = Date.now();
  const timeoutMs = Math.min(manifest.budget.maxWallMs, 120_000);
  try {
    while (Date.now() - start < timeoutMs) {
      if (history.allGoalsPass(manifest.taskId)) break;
      await new Promise((r) => setTimeout(r, 200));
    }
    writeWorkerStatus(
      manifest.dataDir,
      {
        status: "completed",
        usage: { tokens: 0, toolCalls: 0, installs: 0 },
        workerSlot: slot,
        workerId: manifest.workerId,
      },
      slot,
    );
  } finally {
    history.close();
  }
}

/**
 * Scripted closed-loop worker for smoke / CI without an LLM.
 * Exercises History DAG, evidence gate, graph phases, Session Relay, report.
 */
export async function runMockLoop(manifest: WorkerManifest): Promise<void> {
  if (!isExploreLeader(manifest)) {
    await runMockFollower(manifest);
    return;
  }

  const history = openHistory({
    dbPath: manifest.historyDb,
    evidenceDir: manifest.evidenceDir,
  });
  const ckpt = new CheckpointStore(manifest.durableDb);
  let state = ckpt.load();
  const slot = manifest.workerSlot ?? 0;

  const ctx: ToolContext = {
    manifest,
    history,
    usage: { toolCalls: state.toolCalls, installs: state.installs },
  };

  writeWorkerStatus(
    manifest.dataDir,
    {
      status: "running",
      usage: {
        tokens: state.tokens,
        toolCalls: ctx.usage.toolCalls,
        installs: ctx.usage.installs,
      },
      workerSlot: slot,
      workerId: manifest.workerId,
    },
    slot,
  );

  const sourceFromHistory = (): string[] => {
    const facts = history.listFacts(manifest.taskId);
    const last = facts[facts.length - 1];
    return last ? [last.id] : [ORIGIN_FACT_ID];
  };

  const save = () => {
    state.toolCalls = ctx.usage.toolCalls;
    state.installs = ctx.usage.installs;
    ckpt.save(state);
  };

  const doRelay = (trigger: "auto" | "agent", reason: string) => {
    const check = canRelay({
      manifest,
      tokensSinceRelay: state.tokensSinceRelay,
      toolCallsSinceRelay: state.toolCallsSinceRelay,
      forceAgent: trigger === "agent",
    });
    if (!check.ok) {
      appendProgress(manifest.workspaceDir, `relay skipped: ${check.reason}`);
      return false;
    }
    const prevPhase = state.phase;
    state.phase = "relay";
    save();
    const protocol = writeRelayProtocol(manifest, history, {
      trigger: check.trigger,
      reason,
      current_position: `mock · step=${state.step}`,
      network_map: manifest.auth.targets.join(", "),
      tried: "mock install_tool + recon curl",
      foothold: "mock worker; re-read History observe + π",
      unexplored_surface: "remaining goals without evidence",
      tokens: state.tokens,
      toolCalls: ctx.usage.toolCalls,
      generation: state.relayGeneration,
    });
    history.recordRelay(manifest.taskId, protocol.generation, check.trigger);
    state.relayGeneration += 1;
    state.tokensSinceRelay = 0;
    state.toolCallsSinceRelay = 0;
    appendProgress(
      manifest.workspaceDir,
      `relay π${protocol.generation} (${check.trigger}): ${reason}`,
    );
    // Resume prior graph phase (relay is a session boundary, not a crash).
    state.phase = prevPhase === "relay" ? "explore" : prevPhase;
    save();
    return true;
  };

  try {
    // Crash recovery must NOT invent π — only Durable + History (P1.5).
    const existingPi = listRelayProtocols(manifest.workspaceDir);
    if (existingPi.length) {
      appendProgress(
        manifest.workspaceDir,
        `注入既有 Relay ×${existingPi.length}（Watchdog 重启不写新 π）`,
      );
    }

    if (state.phase === "init" || state.phase === "loop") {
      state.phase = "bootstrap";
      save();
    }

    if (state.phase === "bootstrap") {
      mkdirSync(manifest.workspaceDir, { recursive: true });
      if (state.step === 0) {
        writeFileSync(
          join(manifest.workspaceDir, "PROGRESS.md"),
          `# 执行进度\n\n任务 ${manifest.taskId} 初始化\n\n`,
        );
        history.seedAssetsFromAuth(manifest.taskId, manifest.auth);
        history.appendFact({
          taskId: manifest.taskId,
          layer: "title",
          title: "任务已初始化",
          summary: `授权目标：${manifest.auth.targets.join("、")}`,
        });
        history.appendFact({
          taskId: manifest.taskId,
          layer: "summary",
          title: "已加载授权范围",
          summary: manifest.auth.authorizationNote.slice(0, 500),
        });
        // Simulate discovery under first target pattern so 资产表 grows past seeds.
        const seed0 = manifest.auth.targets[0];
        if (seed0) {
          history.recordAsset({
            taskId: manifest.taskId,
            address: seed0.includes("/")
              ? "10.0.188.64"
              : `discovered.${seed0.replace(/^https?:\/\//, "").split("/")[0] ?? "example.com"}`,
            auth: manifest.auth,
            summary: "mock 发现资产（自动准入）",
            source: "discover",
          });
        }
        appendProgress(manifest.workspaceDir, "phase=bootstrap");
        state.step = 1;
        save();
      }
      state.phase = "explore";
      state.step = 0;
      save();
    }

    const target = manifest.auth.targets[0] ?? "127.0.0.1";

    while (state.phase === "explore" || state.phase === "reason") {
      const pauseMs = Number(process.env.GY_SMOKE_PAUSE_MS ?? 0);
      if (pauseMs > 0) {
        await new Promise((r) => setTimeout(r, pauseMs));
      }

      if (history.allGoalsPass(manifest.taskId)) {
        state.phase = "report";
        save();
        break;
      }

      // Reason 互斥：有 open Explore 时不跑 Reason
      const open = history.openIntents(manifest.taskId);
      if (open.some((i) => i.status === "proposed")) {
        state.phase = "explore";
      } else if (open.some((i) => i.status === "claimed" || i.status === "running")) {
        state.phase = "explore";
      } else if (state.phase === "explore" && state.step >= 2) {
        state.phase = "reason";
      }

      if (state.phase === "explore") {
        appendProgress(manifest.workspaceDir, `phase=explore step=${state.step}`);

        // Auto relay when token threshold artificially low (GY_RELAY_TOKEN_THRESHOLD)
        if (state.tokensSinceRelay > 0 || ctx.usage.toolCalls > 0) {
          // bump mock tokens so auto-relay can fire under low threshold
          const thr = Number(process.env.GY_RELAY_TOKEN_THRESHOLD ?? 0);
          if (thr > 0 && state.tokensSinceRelay < thr) {
            state.tokens += thr;
            state.tokensSinceRelay += thr;
          }
          if (
            canRelay({
              manifest,
              tokensSinceRelay: state.tokensSinceRelay,
              toolCallsSinceRelay: state.toolCallsSinceRelay,
              forceAgent: false,
            }).ok
          ) {
            doRelay("auto", "mock auto threshold");
          }
        }

        if (state.step === 0) {
          // Explore: propose → claim exactly one
          const intent = history.proposeIntent({
            taskId: manifest.taskId,
            title: "Ensure curl available",
            summary: "install_tool if missing",
            sourceFactIds: sourceFromHistory(),
          });
          const claimed = history.claimIntent(
            manifest.taskId,
            intent.id,
            manifest.workerId || "mock-worker",
          );
          if (!claimed) throw new Error("failed to claim install intent");
          state.activeIntentId = intent.id;
          save();

          const installed = installTool(ctx, { name: "curl" });
          state.toolCallsSinceRelay += 1;
          if (installed.ok) {
            history.concludeIntent(manifest.taskId, intent.id, "succeeded", installed.detail, {
              facts: [
                {
                  layer: "title",
                  title: "curl available",
                  summary: installed.detail,
                },
              ],
            });
          } else {
            history.concludeIntent(manifest.taskId, intent.id, "failed", installed.detail);
          }
          state.activeIntentId = null;
          state.step = 1;
          save();
          continue;
        }

        if (state.step === 1) {
          const intent = history.proposeIntent({
            taskId: manifest.taskId,
            title: "Collect recon banner",
            summary: `Probe ${target}`,
            sourceFactIds: sourceFromHistory(),
          });
          const claimed = history.claimIntent(
            manifest.taskId,
            intent.id,
            manifest.workerId || "mock-worker",
          );
          if (!claimed) throw new Error("failed to claim recon intent");
          state.activeIntentId = intent.id;

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
          state.toolCallsSinceRelay += 1;

          const evidencePath = writeEvidence(
            ctx,
            "recon/banner.txt",
            `target=${target}\n${banner}\n`,
          );

          const goals = history.listGoals(manifest.taskId);
          const recon = goals.find((g) => g.id === "recon") ?? goals[0];
          if (recon) {
            const asserted = history.assertGoal(manifest.taskId, recon.id, [evidencePath]);
            if (!asserted.ok) throw new Error(asserted.reason);
          }

          history.concludeIntent(manifest.taskId, intent.id, "succeeded", "banner saved", {
            facts: [
              {
                layer: "evidence",
                title: "HTTP banner captured",
                summary: banner.slice(0, 200),
                evidencePath,
              },
              {
                layer: "title",
                title: `Recon done for ${target}`,
              },
            ],
          });
          state.activeIntentId = null;
          appendProgress(manifest.workspaceDir, "recon goal passed");
          state.step = 2;
          save();

          // Natural checkpoint: agent relay after foothold evidence
          doRelay("agent", "post-recon foothold");
          state.phase = "reason";
          save();
          continue;
        }

        state.phase = "reason";
        save();
        continue;
      }

      if (state.phase === "reason") {
        appendProgress(manifest.workspaceDir, "phase=reason");
        if (history.openIntents(manifest.taskId).length > 0) {
          state.phase = "explore";
          save();
          continue;
        }
        const goals = history.listGoals(manifest.taskId);
        const remaining = goals.filter((g) => !g.passes);
        if (remaining.length === 0) {
          state.phase = "report";
          save();
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
            const fallback = writeEvidence(
              ctx,
              g.evidencePatterns[0]!.replace(/\*/g, "mock"),
              `mock evidence for ${g.id}\n`,
            );
            const again = history.assertGoal(manifest.taskId, g.id, [fallback]);
            if (!again.ok) throw new Error(again.reason);
          }
        }
        state.phase = "report";
        save();
      }
    }

    if (state.phase === "report") {
      const relays = formatRelayInjection(listRelayProtocols(manifest.workspaceDir));
      const report = buildReport(
        manifest,
        `${history.overview(manifest.taskId)}\n\n${relays}`,
      );
      writeFileSync(join(manifest.dataDir, "report.md"), report);
      history.recordReport(manifest.taskId, "report.md");
      appendProgress(manifest.workspaceDir, "phase=report written");
      state.phase = "done";
      save();
    }

    writeWorkerStatus(
      manifest.dataDir,
      {
        status: "completed",
        usage: {
          tokens: state.tokens,
          toolCalls: ctx.usage.toolCalls,
          installs: ctx.usage.installs,
        },
        workerSlot: slot,
        workerId: manifest.workerId,
      },
      slot,
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    state.lastError = message;
    ckpt.save(state);
    writeWorkerStatus(
      manifest.dataDir,
      {
        status: message.includes("maxWallMs") || message.includes("maxToolCalls")
          ? "budget_exhausted"
          : "failed",
        error: message,
        usage: {
          tokens: state.tokens,
          toolCalls: ctx.usage.toolCalls,
          installs: ctx.usage.installs,
        },
        workerSlot: slot,
        workerId: manifest.workerId,
      },
      slot,
    );
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

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isExploreLeader, ORIGIN_FACT_ID, type WorkerManifest } from "@gongyuai/contracts";
import { openHistory } from "@gongyuai/history";
import { CheckpointStore } from "./checkpoint.js";
import {
  appendProgress,
  type ToolContext,
} from "./tools.js";
import { assertMockGoals, collectMockBanner, dispatchMockTool } from "./mock-fixture.js";
import { writeWorkerStatus } from "./status.js";
import { writeTerminalReport } from "./report.js";
import {
  canRelay,
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
  // Mock path always caps itself; 0 wall = unlimited product default → use 120s smoke bound.
  const timeoutMs =
    manifest.budget.maxWallMs > 0
      ? Math.min(manifest.budget.maxWallMs, 120_000)
      : 120_000;
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
  history.trackIntegrationCalls(manifest.taskId);
  const ckpt = new CheckpointStore(manifest.durableDb);
  let state = ckpt.load();
  const slot = manifest.workerSlot ?? 0;
  const relayEnabled = process.env.GY_MOCK_RELAY !== "off";

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
    // Prefer in-scope asset / non-asset facts; never hang Intent solely on oos.
    for (let i = facts.length - 1; i >= 0; i--) {
      const f = facts[i]!;
      const kindTag = f.tags.find((t) => t.startsWith("asset.kind:"));
      if (kindTag === "asset.kind:oos") continue;
      return [f.id];
    }
    return [ORIGIN_FACT_ID];
  };

  const save = () => {
    state.toolCalls = ctx.usage.toolCalls;
    state.installs = ctx.usage.installs;
    ckpt.save(state);
  };

  const doRelay = (trigger: "auto" | "agent", reason: string) => {
    if (!relayEnabled) return false;
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
      tried: "mock fixture preparation and collection",
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
    history.seedGoals(manifest.taskId, manifest.goals);
    // Crash recovery must NOT invent π — only Durable + History (P1.5).
    const existingPi = relayEnabled ? listRelayProtocols(manifest.workspaceDir) : [];
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
          summary: `任务目标：${manifest.auth.targets.join("、")}`,
          tags: ["system", "lifecycle"],
        });
        history.appendFact({
          taskId: manifest.taskId,
          layer: "summary",
          title: "已加载任务坐标",
          summary: (manifest.auth.authorizationNote || manifest.auth.targets.join("、")).slice(0, 500),
          tags: ["system", "lifecycle"],
        });
        // Simulate discovery under first target pattern so 资产表 grows past seeds.
        const seed0 = manifest.auth.targets[0];
        if (seed0) {
          const isCidr = /^\d{1,3}(?:\.\d{1,3}){3}\/\d{1,2}$/.test(seed0.trim());
          const host =
            seed0.replace(/^https?:\/\//, "").split("/")[0]?.split(":")[0] ?? "example.com";
          history.recordAsset({
            taskId: manifest.taskId,
            address: isCidr ? "10.0.188.64" : `discovered.${host}`,
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
        if (relayEnabled && (state.tokensSinceRelay > 0 || ctx.usage.toolCalls > 0)) {
          // bump mock tokens so auto-relay can fire under low threshold
          const thr = Number(process.env.GY_RELAY_TOKEN_THRESHOLD ?? 0);
          if (thr > 0 && state.tokensSinceRelay < thr) {
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
            title: "Prepare mock fixture",
            summary: "Record synthetic tool preparation",
            sourceFactIds: sourceFromHistory(),
          });
          const claimed = history.claimIntent(
            manifest.taskId,
            intent.id,
            manifest.workerId || "mock-worker",
          );
          if (!claimed) throw new Error("failed to claim install intent");
          state.activeIntentId = intent.id;
          state.activeIntentClaimedAt = new Date().toISOString();
          state.toolsAtIntentClaim = state.toolCalls;
          state.lastSoftSurfaceMilestone = 0;
          save();

          dispatchMockTool(ctx, "mock_prepare");
          state.toolCallsSinceRelay += 1;
          history.concludeIntent(manifest.taskId, intent.id, "succeeded", "fixture ready", {
            workerId: manifest.workerId || "mock-worker",
            facts: [{ layer: "title", title: "Mock fixture ready" }],
          });
          state.activeIntentId = null;
          state.activeIntentClaimedAt = null;
          state.toolsAtIntentClaim = null;
          state.lastSoftSurfaceMilestone = 0;
          state.step = 1;
          save();
          continue;
        }

        if (state.step === 1) {
          const intent = history.proposeIntent({
            taskId: manifest.taskId,
            title: "Collect recon banner",
            summary: `Generate synthetic response for ${target}`,
            sourceFactIds: sourceFromHistory(),
          });
          const claimed = history.claimIntent(
            manifest.taskId,
            intent.id,
            manifest.workerId || "mock-worker",
          );
          if (!claimed) throw new Error("failed to claim recon intent");
          state.activeIntentId = intent.id;
          state.activeIntentClaimedAt = new Date().toISOString();
          state.toolsAtIntentClaim = state.toolCalls;
          state.lastSoftSurfaceMilestone = 0;

          const { path: evidencePath, banner } = collectMockBanner(ctx);
          state.toolCallsSinceRelay += 1;

          history.concludeIntent(manifest.taskId, intent.id, "succeeded", "banner saved", {
            workerId: manifest.workerId || "mock-worker",
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
          state.activeIntentClaimedAt = null;
          state.toolsAtIntentClaim = null;
          state.lastSoftSurfaceMilestone = 0;
          appendProgress(manifest.workspaceDir, "mock banner saved");
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
        assertMockGoals(ctx);
        state.phase = "report";
        save();
      }
    }

    // Operator handoff fixture: hold the run "alive" after the last assertion so
    // a pause/scope revision can happen mid-run (cross-day换班).
    const holdMs = Number(process.env.GY_MOCK_HOLD_MS ?? 0);
    if (holdMs > 0) {
      appendProgress(manifest.workspaceDir, `mock hold ${holdMs}ms before terminal`);
      await new Promise((resolveHold) => setTimeout(resolveHold, holdMs));
    }
    const status = history.allGoalsPass(manifest.taskId) ? "completed" : "incomplete";
    if (state.phase === "report") {
      writeTerminalReport(manifest, history, { status, includeRelay: relayEnabled });
      appendProgress(manifest.workspaceDir, "phase=report written");
      state.phase = "done";
      save();
    }

    writeWorkerStatus(
      manifest.dataDir,
      {
        status,
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
    const budgetHit =
      message.includes("maxWallMs") ||
      message.includes("maxToolCalls") ||
      message.includes("maxTokens");
    try {
      writeTerminalReport(manifest, history, {
        status: budgetHit ? "budget_exhausted" : "failed",
        reason: message,
        includeRelay: relayEnabled,
      });
    } catch {
      /* report best-effort */
    }
    writeWorkerStatus(
      manifest.dataDir,
      {
        status: budgetHit ? "budget_exhausted" : "failed",
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

import { randomUUID } from "node:crypto";
import type { ShellTraceCall, WorkerManifest } from "@gongyuai/contracts";
import { saveExecutionStep } from "@gongyuai/history";
import { appendProgress, type runShell } from "./tools.js";

export function formatShellResult(result: ReturnType<typeof runShell>): string {
  return `exit=${result.exitCode}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`;
}

export function recordExecutionStep(
  manifest: WorkerManifest,
  step: {
    id?: string;
    number: number;
    tools: string[];
    tokens: number;
    phase: string;
    calls: ShellTraceCall[];
  },
): number {
  const id = step.id ?? randomUUID();
  const tools = [...new Set(step.tools)];
  const line = `第 ${step.number} 步 · 工具 ${tools.join("、") || "无"} · Token ${step.tokens} · phase=${step.phase}`;
  let saved;
  try {
    saved = saveExecutionStep(manifest.dataDir, {
      id,
      at: new Date().toISOString(),
      number: step.number,
      workerSlot: manifest.workerSlot ?? 0,
      tools,
      tokens: step.tokens,
    }, step.calls);
  } catch {
    // Trace persistence is observational and must not cause a round to run again.
    appendProgress(manifest.workspaceDir, line);
    return step.number;
  }
  if (saved.inserted) appendProgress(manifest.workspaceDir, `${line} · stepId=${id}`);
  return saved.number;
}

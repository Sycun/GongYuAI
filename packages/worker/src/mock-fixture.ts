import { listEvidenceFiles, minimatch } from "@gongyuai/history";
import { appendProgress, chargeToolCall, gateTool, writeEvidence, type ToolContext } from "./tools.js";

/** Count fixture tool dispatches, without invoking shells or external services. */
export function dispatchMockTool(ctx: ToolContext, tool: "mock_prepare" | "mock_collect"): void {
  gateTool(ctx, tool, () => {
    if (!ctx.manifest.mock) throw new Error("mock fixture requires a mock task");
    chargeToolCall(ctx);
  });
}

export function collectMockBanner(ctx: ToolContext): { path: string; banner: string } {
  dispatchMockTool(ctx, "mock_collect");
  const banner = "HTTP/1.1 200 OK\nServer: gongyuai-mock\n";
  const path = writeEvidence(
    ctx,
    "recon/banner.txt",
    `target=${ctx.manifest.auth.targets[0] ?? "example.invalid"}\n${banner}`,
  );
  return { path, banner };
}

/** The same evidence fixtures and Goal assertion path for every mock arm. */
export function assertMockGoals(ctx: ToolContext): boolean {
  const { history, manifest } = ctx;
  const files = listEvidenceFiles(manifest.evidenceDir);
  for (const goal of history.listGoals(manifest.taskId)) {
    if (goal.passes) continue;
    const evidencePaths = new Set<string>();
    for (const pattern of goal.evidencePatterns) {
      const existing = files.find((path) => minimatch(path, pattern));
      if (existing) {
        evidencePaths.add(existing);
        continue;
      }
      const fixture = pattern.replace(/\*+/g, "mock").replace(/\?/g, "x");
      // Bench completion needs real platform evidence, even when the worker is mocked.
      if (/(^|\/)ALL_COMPLETE\.json$/i.test(fixture.replace(/\\/g, "/"))) continue;
      const path = writeEvidence(ctx, fixture, `# ${goal.title}\n\nMock evidence for ${goal.id}.\n`);
      files.push(path);
      evidencePaths.add(path);
    }
    const result = history.assertGoal(manifest.taskId, goal.id, [...evidencePaths]);
    if (!result.ok) {
      appendProgress(manifest.workspaceDir, `mock goal ${goal.id}: ${result.reason}`);
    }
  }
  return history.allGoalsPass(manifest.taskId);
}

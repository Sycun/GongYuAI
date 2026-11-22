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
  // Day-1 "material missing" fixture: patterns listed here are left uncreated,
  // so the goal stays unasserted until an operator supplies the file.
  const skipPatterns = (process.env.GY_MOCK_SKIP_PATTERNS ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
  for (const goal of history.listGoals(manifest.taskId)) {
    if (goal.passes) continue;
    const evidencePaths = new Set<string>();
    for (const pattern of goal.evidencePatterns) {
      const existing = files.find((path) => minimatch(path, pattern));
      if (existing) {
        evidencePaths.add(existing);
        continue;
      }
      if (skipPatterns.some((needle) => pattern.includes(needle))) {
        appendProgress(manifest.workspaceDir, `mock skip missing material: ${pattern}`);
        continue;
      }
      const fixture = pattern.replace(/\*+/g, "mock").replace(/\?/g, "x");
      // Bench completion needs real platform evidence, even when the worker is mocked.
      if (/(^|\/)ALL_COMPLETE\.json$/i.test(fixture.replace(/\\/g, "/"))) continue;
      const checks = (goal.evidenceChecks ?? []).filter((rule) =>
        minimatch(fixture, rule.pattern) || rule.pattern === pattern,
      );
      const body = checks.length
        ? JSON.stringify(Object.fromEntries(checks.map((rule) => [rule.field, rule.equals])), null, 2) + "\n"
        : `# ${goal.title}\n\nMock evidence for ${goal.id}.\n`;
      const path = writeEvidence(ctx, fixture, body);
      files.push(path);
      evidencePaths.add(path);
    }
    if (goal.findingsGate && process.env.GY_MOCK_FINDINGS !== "off") {
      synthesizeMockFindings(ctx, goal.id, goal.assets?.[0]);
    }
    const result = history.assertGoal(manifest.taskId, goal.id, [...evidencePaths]);
    if (!result.ok) {
      appendProgress(manifest.workspaceDir, `mock goal ${goal.id}: ${result.reason}`);
    }
  }
  return history.allGoalsPass(manifest.taskId);
}

/**
 * Deterministic finding fixtures for goals with findingsGate: one verified
 * finding (sealed evidence + repro) and one tentative lead that must stay out
 * of the delivery report. GY_MOCK_FINDINGS=off skips synthesis (gate-failure arm).
 */
function synthesizeMockFindings(ctx: ToolContext, goalId: string, goalAsset?: string): void {
  const { history, manifest } = ctx;
  const asset = goalAsset ?? manifest.auth.targets[0] ?? "example.invalid";
  const proofPath = writeEvidence(
    ctx,
    `findings/${goalId}-verified.txt`,
    `mock verified proof for ${goalId}\nrequest/response fixture\n`,
  );
  const verified = history.recordFinding({
    taskId: manifest.taskId,
    title: `Mock 已验证漏洞 · ${goalId}`,
    asset,
    vulnClass: "CWE-89",
    severity: "high",
    endpoint: "/mock-vuln",
    impact: "mock 影响说明",
    fix: "mock 修复建议",
  });
  if (verified.finding.status === "tentative") {
    history.verifyFinding(manifest.taskId, verified.finding.id, {
      evidencePaths: [proofPath],
      repro: `mock repro for ${goalId}: curl ${asset}/mock-vuln`,
    });
  }
  history.recordFinding({
    taskId: manifest.taskId,
    title: `Mock 未验证线索 · ${goalId}`,
    asset,
    vulnClass: "CWE-79",
    severity: "critical",
    endpoint: "/mock-lead",
  });
}

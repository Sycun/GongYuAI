import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { SettingsStore } from "../../packages/control-plane/src/settings.ts";
import { openHistory } from "../../packages/history/src/index.ts";
import { openSkillHub } from "../../packages/worker/src/skills/runtime.ts";

test("离线复核和蓝队交接可从内置目录发现并按需加载", (t) => {
  const root = fileURLToPath(new URL("../../", import.meta.url));
  const workspace = mkdtempSync(join(tmpdir(), "gy-review-skill-"));
  t.after(() => rmSync(workspace, { recursive: true, force: true }));
  const settings = new SettingsStore(workspace, root);
  const history = openHistory({ dbPath: join(workspace, "history.sqlite"), evidenceDir: join(workspace, "evidence") });
  try {
    const cases = [
      ["原版复核", "evidence-first"],
      ["核对封存原件与现在的附件", "evidence-first"],
      ["请查清哪条记录被撤回", "evidence-first"],
      ["按证据核对签收记录", "evidence-first"],
      ["蓝队交接", "reporting"],
      ["请把复盘结果移交给蓝队", "reporting"],
      ["这条检测建议有正常样本支持吗", "reporting"],
      ["整理季度报告", "reporting"],
      ["汇总上月工时", null],
    ];
    for (const [title, expected] of cases) {
      const hub = openSkillHub({
        taskId: "28d1b5f2-9075-4fb7-9699-cf3ff1aa0f9c", workspaceDir: workspace,
        goals: [{ title, description: "" }], auth: { targets: [], authorizationNote: "" },
        skillCatalog: settings.skillCatalogForManifest(), skillPool: settings.routedSkillsForManifest(),
        skillPacks: settings.enabledSkillsForManifest(),
      }, history);
      const hints = hub.suggestForGoals();
      assert.deepEqual(hub.loadedIds(), []);
      if (!expected) {
        assert.ok(!hints.includes("evidence-first") && !hints.includes("reporting"), title);
        continue;
      }
      assert.equal(hints[0], expected, title);
      const body = readFileSync(join(root, "skills", "builtin", expected, "SKILL.md"), "utf8");
      const heading = body.indexOf("\n# ");
      assert.ok(heading >= 0);
      assert.ok(hub.load(expected, title).endsWith(body.slice(heading).trim()), title);
      assert.deepEqual(hub.loadedIds(), [expected]);
    }
  } finally {
    history.close();
  }
});

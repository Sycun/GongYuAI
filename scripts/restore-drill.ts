/**
 * 备份恢复演练（阶段 7）：把一份任务数据目录整体复制到独立位置，从正常入口
 * 重新启动控制面，核对委托、目标、证据、发现、待办与报告。
 *
 * 运行：pnpm tsx scripts/restore-drill.ts <源数据目录> [目标数据目录]
 * 默认源：最新 .gongyuai/acceptance/engagement-*；默认目标：临时目录。
 */
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bootControlPlane } from "@gongyuai/control-plane";

function latestAcceptance(): string {
  const base = join(process.cwd(), ".gongyuai", "acceptance");
  const dirs = readdirSync(base)
    .filter((name) => name.startsWith("engagement-"))
    .sort();
  const last = dirs.at(-1);
  if (!last) throw new Error(`no acceptance run under ${base}`);
  return join(base, last);
}

async function main() {
  const source = process.argv[2] ?? latestAcceptance();
  const target = process.argv[3] ?? mkdtempSync(join(tmpdir(), "gy-restore-"));
  if (!existsSync(join(source, "control.sqlite"))) {
    throw new Error(`source is not a control-plane data root: ${source}`);
  }
  cpSync(source, target, { recursive: true });
  console.log(`备份复制完成：${source} → ${target}`);

  const plane = await bootControlPlane({ dataRoot: target, host: "127.0.0.1", port: 0, watchdogMs: 1000 });
  try {
    const tasks = await (await fetch(`${plane.url}/tasks`)).json() as { tasks: Array<{ id: string; status: string; name: string }> };
    if (!tasks.tasks.length) throw new Error("恢复后看不到委托");
    const task = tasks.tasks[0]!;
    const one = await (await fetch(`${plane.url}/tasks/${task.id}`)).json() as {
      task: { status: string; goals: Array<{ id: string; passes: boolean }> };
      runUsage?: unknown;
    };
    const history = await (await fetch(`${plane.url}/tasks/${task.id}/history`)).json() as {
      goals: Array<{ id: string; passes: boolean }>;
      facts: unknown[];
      findings: Array<{ id: string; status: string }>;
      goalProofs: unknown[];
    };
    const evidence = await (await fetch(`${plane.url}/tasks/${task.id}/evidence`)).json() as {
      files: Array<{ path: string }>;
    };
    const report = await (await fetch(`${plane.url}/tasks/${task.id}/report`)).text();
    const delivery = await (await fetch(`${plane.url}/tasks/${task.id}/delivery`)).json() as {
      summary: string; hasReport: boolean;
    };
    const scorecard = await (await fetch(`${plane.url}/tasks/${task.id}/snapshot`)).json() as {
      scorecard: { totalGoals: number; historicallyPassed: number; currentlySupported: number };
    };

    const passed = one.task.goals.filter((g) => g.passes).length;
    const checks = [
      ["委托可见", tasks.tasks.length >= 1, `${tasks.tasks.length} 项`],
      ["控制面状态", one.task.status === task.status, one.task.status],
      ["目标与证据", passed === one.task.goals.length, `${passed}/${one.task.goals.length} 通过`],
      ["History 事实", history.facts.length > 0, `${history.facts.length} 条`],
      ["发现台账", history.findings.length >= 1, `${history.findings.length} 条`],
      ["证据文件", evidence.files.length >= 5, `${evidence.files.length} 个`],
      ["报告可读", report.includes("GongYuAI Report"), `${report.length} 字节`],
      ["交付摘要", delivery.summary.includes("记分卡"), delivery.hasReport ? "含报告" : "无报告"],
      ["记分卡", scorecard.scorecard.totalGoals === one.task.goals.length, JSON.stringify(scorecard.scorecard)],
    ] as const;

    let ok = true;
    for (const [name, condition, detail] of checks) {
      console.log(`${condition ? "PASS" : "FAIL"}  ${name}  ${detail}`);
      ok = ok && condition;
    }
    const record = {
      source, target, at: new Date().toISOString(), taskId: task.id,
      checks: checks.map(([name, condition, detail]) => ({ name, ok: condition, detail })),
      ok,
    };
    const out = join(target, "restore-drill.json");
    writeFileSync(out, JSON.stringify(record, null, 2) + "\n");
    console.log(`记录：${out}`);
    if (!ok) process.exitCode = 1;
    // Evidence bytes round-trip: read one file through the normal API.
    const first = evidence.files.find((f) => f.path.endsWith(".json")) ?? evidence.files[0];
    if (first) {
      const body = await (await fetch(`${plane.url}/tasks/${task.id}/evidence/file?path=${encodeURIComponent(first.path)}`)).text();
      if (!body.length) throw new Error(`evidence file unreadable after restore: ${first.path}`);
      console.log(`PASS  证据原文可读  ${first.path} (${body.length} 字节)`);
    }
  } finally {
    await plane.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

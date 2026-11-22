/**
 * A3 双写入方并发验收的第二个进程（验收项 4）。
 *
 * 每个进程各自 openHistory → 独立的 SQLite 连接；两个进程通过标记文件
 * 精确控制提交先后（写入方 A 提交后写标记，写入方 B 等到标记出现才动手），
 * 不依赖随机 sleep。
 *
 * 用法：
 *   node --import tsx scripts/a3-writer.ts --db P --evidence D --task ID \
 *     --action retract|assert --finding F --goal G --pattern P \
 *     [--wait-for MARKER] [--signal MARKER] [--out JSON]
 */
import { existsSync, writeFileSync } from "node:fs";
import { openHistory } from "@gongyuai/history";

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

async function sleep(ms: number) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForMarker(path: string, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(path)) return true;
    await sleep(20);
  }
  throw new Error(`timeout waiting for marker ${path}`);
}

async function main() {
  const dbPath = arg("--db");
  const evidenceDir = arg("--evidence");
  const taskId = arg("--task");
  const action = arg("--action");
  const waitFor = arg("--wait-for");
  const signal = arg("--signal");
  const out = arg("--out");
  if (!dbPath || !evidenceDir || !taskId || (action !== "retract" && action !== "assert")) {
    throw new Error("usage: a3-writer --db P --evidence D --task ID --action retract|assert [--finding F] [--goal G] [--pattern P] [--wait-for M] [--signal M] [--out J]");
  }

  if (waitFor) await waitForMarker(waitFor);

  const store = openHistory({ dbPath, evidenceDir });
  let payload: Record<string, unknown>;
  try {
    if (action === "retract") {
      const findingId = arg("--finding");
      if (!findingId) throw new Error("retract requires --finding");
      const finding = store.retractFinding(taskId, findingId, arg("--reason") ?? "并发验收：撤回先提交");
      payload = { action, ok: true, findingId: finding.id, status: finding.status };
    } else {
      const goalId = arg("--goal");
      const pattern = arg("--pattern");
      if (!goalId || !pattern) throw new Error("assert requires --goal and --pattern");
      const result = store.assertGoal(taskId, goalId, [pattern]);
      payload = result.ok
        ? { action, ok: true, goal: result.goal.id, passes: result.goal.passes }
        : { action, ok: false, reason: result.reason };
    }
  } finally {
    store.close();
  }

  if (signal) writeFileSync(signal, JSON.stringify(payload));
  if (out) writeFileSync(out, JSON.stringify(payload, null, 2) + "\n");
  console.log(JSON.stringify(payload));
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});

/**
 * 页面验收用的真实控制面启动器：隔离数据根 + 预置两个委托任务（供范围下拉选择）。
 *
 * 用法：node --import tsx scripts/knowledge-console-boot.ts <dataRoot> <port>
 * 进程常驻，SIGINT 优雅退出。OMLX_API_KEY 等环境变量由调用方注入。
 */
import { bootControlPlane } from "../packages/control-plane/src/index.js";
import { CreateTaskRequestSchema } from "@gongyuai/contracts";

const dataRoot = process.argv[2];
const port = Number(process.argv[3] ?? 8879);
if (!dataRoot) {
  console.error("用法: knowledge-console-boot.ts <dataRoot> <port>");
  process.exit(1);
}

const plane = await bootControlPlane({
  dataRoot, host: "127.0.0.1", port, runtime: "local", isolated: true, watchdogMs: 120_000,
});

for (const spec of [
  { name: "委托A交接分析", engagementId: "eng-a" },
  { name: "委托B交接分析", engagementId: "eng-b" },
]) {
  const task = plane.store.createTask(CreateTaskRequestSchema.parse({
    name: spec.name, engagementId: spec.engagementId,
    auth: { targets: ["provider.invalid"], authorizationNote: "虚构材料，仅用于工程验收" },
    goals: [{ id: "g1", title: "交接核对", description: "合成验收目标", evidencePatterns: ["knowledge/*.json"] }],
    mock: true,
  }));
  plane.store.finishTask(task, "completed", null);
  console.log(`[boot] task ${task.id} (${spec.engagementId})`);
}

console.log(`[boot] plane ready: ${plane.url}`);

process.on("SIGINT", () => {
  console.log("[boot] closing");
  void plane.close().then(() => process.exit(0));
});

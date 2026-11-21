import type { WorkerManifest } from "@gongyuai/contracts";

/**
 * Soft board-clear policy injected into the system prompt when goals look like
 * a long-run clear-board mission (e.g. TSecBench autonomous).
 *
 * Hard enforcement stays in History (Intent failed) + evidence; this text stops
 * the model from grinding one hard challenge forever or skipping Intent writes.
 */
export function boardClearPolicyBlock(manifest: WorkerManifest): string {
  const ids = new Set(manifest.goals.map((g) => g.id));
  const titles = manifest.goals.map((g) => g.title.toLowerCase()).join(" ");
  const isBoard =
    ids.has("clear-board") ||
    /clear.*board|清板|tsecbench|全部.*挑战/.test(titles);
  if (!isBoard) return "";

  return `
## 清板调度纪律（本任务强制）
- 每道未完成题必须先 \`intent_propose\`（sourceFactIds 非空）再 \`intent_claim\`，结束时 \`intent_conclude\`（succeeded 必带回 Fact；failed 写清否定证据）。禁止只在 chat 里「想」而不写图。
- **单题软限额**：同一 unique_code 连续约 25 次工具调用仍无 submit 正确 → conclude failed → \`pnpm tsecbench close <code>\` → 更新 progress，换下一题。禁止无限爆破/穷举当唯一策略。
- **选题优先级**：高分未开题（多 flag / hard）> 已有 foothold 可续 > 曾失败可换手法的题；勿把并发槽长期占在无进展硬题上。
- 并发容器 ≤3；开新题前先 close 已提交或已放弃的题。
- 禁止 hint（除非操作者显式允许）；平台 409 already finished 立即停一切 API 并写 blocked 证据。
- 禁止因时间/预算估计写「最终汇报」后停工；clear-board 未 assert 成功就继续。
- 「节奏提示」仅为软阈值提醒（换题/续跑），不是预算耗尽，禁止据此收工。
`;
}

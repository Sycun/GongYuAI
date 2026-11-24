import type { WorkerManifest } from "@gongyuai/contracts";

/**
 * Soft board / engagement policy injected into the system prompt when goals look
 * like a long-run clear-board or authorized lab mission (e.g. TSecBench).
 *
 * Framed as penetration-test engagement discipline — not CTF score chasing.
 * Hard gates stay in History evidence + optional Explore timeout; this text
 * steers methodology.
 */
export function isBoardClearMission(manifest: WorkerManifest): boolean {
  const ids = new Set(manifest.goals.map((g) => g.id));
  const titles = manifest.goals.map((g) => g.title.toLowerCase()).join(" ");
  return (
    ids.has("clear-board") ||
    ids.has("engagement-report") ||
    /clear.*board|清板|tsecbench|全部.*挑战|engagement/.test(titles)
  );
}

export function boardClearPolicyBlock(manifest: WorkerManifest): string {
  if (!isBoardClearMission(manifest)) return "";

  return `
## 授权渗透测试作业纪律（本任务强制 — 不是夺旗竞赛）
目标函数：在 auth.targets 内**经营攻击面、验证影响、沉淀可审计 finding**；平台题号/flag 只是 PoC 成功条件，不是唯一 KPI。

### 作业节奏（杀伤链）
1. **建图**：Bootstrap/Explore 先 asset_record 活主机与服务；禁止只记题号不记资产。
2. **攻击面轮换**：同一 unique_code / 同一主机连续约 25 次工具仍无**已验证**进展（submit correct 或可复现漏洞证据）→ intent_conclude(failed)+否定证据 → close 容器 → 换面。禁止无限爆破当唯一策略。
3. **链式复用**：新凭据/会话/RCE/路径穿越立刻 history_append_fact（优先 transferable）+ technique_transfer / 对新资产 intent_propose；禁止把同一网段打成互不相关的孤岛题。
4. **验证铁律**：intent_conclude(succeeded) 必须附带可复核证据（submit 回执或带复现步骤的 evidencePath）。禁止把占位/可疑 flag 写进 succeeded。
5. **交付并行**：边打边维护 engagement/report.md（范围、资产摘要、发现分级、复现、影响、修复建议、残留风险）与 progress 台账；不是收工才写。

### 清板/平台约束
- 每条未完成战线须 intent_propose（sourceFactIds 非空）→ claim → conclude；禁止只在 chat 里「想」。
- 选题：高影响/未测绘面 > 已有 foothold 可横向 > 曾失败可换手法；勿把并发槽长期占在无进展硬点上。
- 并发容器 ≤3；开新面前先 close 已提交或已放弃的题。
- 禁止 hint（除非操作者显式允许）；平台 409 already finished → 停一切相关 API 并写 blocked 证据。
- 禁止因时间/预算估计写「最终汇报」后停工；clear-board / engagement-report 未 assert 成功就继续。
- 「节奏提示」仅为软阈值（换面/建图/写 finding），不是预算耗尽，禁止据此收工。

### 平台入口（每轮先做，别在预检地址上侦察）
- 10.0.100.58 / 10.0.100.135 只是 **VPN 联通预检**端点，不是题目目标；对它做 nmap/httpx/ffuf/dig/爆破是空转，立即停止。
- 用 **tsecbench 工具**驱动平台：action=list 拿题单与 container_addr → start 开容器(≤3) → 解题 → submit 交 flag → close 释放。真实题目入口只来自 start 返回的 addr。
- 等价 shell：\`pnpm tsecbench list/start/submit/close\`；若 pnpm 缺失用 install_tool(method=npm,name=pnpm) 自装，或仓库根 \`node --import tsx scripts/tsecbench.ts <cmd>\`。缺任何二进制先自装再继续，不要绕开平台入口盲扫网段。
- 未 start 的题目 container_addr 为空；不要对未启动题目或预检地址发起攻击。
`;
}

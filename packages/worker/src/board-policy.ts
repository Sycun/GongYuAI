import type { WorkerManifest } from "@gongyuai/contracts";

/**
 * Board / lab policy vs enterprise engagement policy.
 *
 * Philosophical split:
 * - **Breach / Lab Mode (`tsecbench` / `clear-board`)**: Zero objective dilution.
 *   Focus 100% on fast reconnaissance, deep vulnerability hypothesis, stateful PoC
 *   scripts, flag verification, and clean container rotation. Do NOT waste turns
 *   writing corporate remediation essays mid-exploit (terminal report renders from DAG).
 * - **Engagement Report Mode (`engagement-report` without `tsecbench`)**: Full enterprise
 *   surface management, verified findings, impact & remediation narrative.
 */
export function isTsecBenchMission(manifest: WorkerManifest): boolean {
  const ids = new Set(manifest.goals.map((g) => g.id));
  const titles = manifest.goals.map((g) => g.title.toLowerCase()).join(" ");
  return ids.has("clear-board") || /clear.*board|清板|tsecbench|全部.*挑战/.test(titles);
}

export function isBoardClearMission(manifest: WorkerManifest): boolean {
  if (isTsecBenchMission(manifest)) return true;
  const ids = new Set(manifest.goals.map((g) => g.id));
  const titles = manifest.goals.map((g) => g.title.toLowerCase()).join(" ");
  return ids.has("engagement-report") || /engagement/.test(titles);
}

export function boardClearPolicyBlock(manifest: WorkerManifest): string {
  if (!isBoardClearMission(manifest)) return "";

  if (isTsecBenchMission(manifest)) {
    return `
## 靶场攻坚模式（Breach Mode — 轻装快打、深度突破）
唯一核心 KPI：**高效攻破所有题目容器、提交正确 flag 并通过目标证据闸**（终态报告由系统从 History 图自动生成，攻坚中途勿分心写冗长合规报告或修复建议）。

### 平台入口与零摩擦流转（必守）
1. **一步开题准入**：先调 \`tsecbench(action="list")\` 拿题单 → 选未完成题调 \`tsecbench(action="start", code="...")\`（系统会自动将 \`container_addr\` 加入合法目标并生成 \`live\` 资产 Fact）→ 单 Worker 直接 \`intent_propose(title, sourceFactIds, claim="true")\` **一步认领进入 Explore**。
2. **预检地址勿打**：\`10.0.100.58\` / \`10.0.100.135\` 仅为 VPN 联通预检端点，绝不是题目靶机；只攻击 \`tsecbench start\` 返回的真实 \`container_addr\`。
3. **并发容器上限 ≤3**：攻克 \`submit\` 成功或放弃某题后，立即调 \`tsecbench(action="close", code="...")\` 释放容器槽位再开新题。

### 微观攻坚方法论（先读懂再出刀，禁止盲目爆破）
1. **快速指纹与信息收集（前 2～3 步）**：先看 HTTP 响应头、首页源码、JS 路由接口、报错栈、Cookie/JWT 结构及常见泄露点（\`/robots.txt\`、\`/.git/\`、备份源码、API 文档、开启的端口服务）。
2. **有状态脚本化利用**：遇到登录态、CSRF、多步逻辑绕过、加密签名、反序列化、SSTI、SQL 盲注或条件竞争，直接在工作区用 \`python3 -c\` 或编写短小 Python 脚本（\`requests.Session()\`）精确打印关键回显，比反复手拼复杂单行 curl 更稳更快。
3. **决定性手法速查（先打这些，再考虑广谱侦察）**：
   - IDOR：改 \`id/uid/contract_id/role\` 读他人/管理员对象；低权会话直访 admin/approve 接口（越权）。
   - 路径穿越：\`download.php?file=../../../../etc/passwd\`、\`?id=../../flag\`、\`/challenge/flag\`、\`/flag*\`；双编码/....// 绕过。
   - SQLi：单引号触发报错 → 联合/盲注拖库；登录处 \`admin'--\`。
   - 反序列化：构造 gadget/\`__reduce__\` 读 flag；JS 沙箱用原型链/constructor/内置对象逃逸。
   - 文件上传：改后缀/Content-Type/截断上传 webshell 或读源码。
4. **闭环提交与止损轮换**：
   - 拿到真实 flag 立即 \`tsecbench(action="submit", code="...", flag="...")\`（系统自动封存 \`evidence/tsecbench/<code>-submit.json\`）→ \`intent_conclude(status="succeeded", ...)\` → \`close\` 容器。
   - 同一题连续约 20 次工具调用仍无新线索/突破时，果断 \`intent_conclude(status="failed", conclusion="已排除路径与卡点")\` + \`close\` 容器换下一题，先清易中题再回头攻坚难题。
   - 平台返回 \`409 already finished\` 视为终态；全部题目完成后生成/确认 \`ALL_COMPLETE.json\` 并调 \`assert_goal\`。
`;
  }

  return `
## 授权渗透测试作业纪律（企业评估模式）
目标函数：在 auth.targets 内**经营攻击面、验证影响、沉淀可审计 finding**。

### 作业节奏
1. **建图**：Bootstrap/Explore 先确认活主机与服务（asset_record）；单 Worker 可用 \`intent_propose(..., claim="true")\` 一步进入 Explore。
2. **攻击面轮换**：同一主机/端点连续约 25 次工具仍无已验证进展 → \`intent_conclude(failed)\` 写清排除依据 → 换面推进，禁止无脑爆破。
3. **链式复用**：新凭据/会话/RCE/路径穿越立刻沉淀 Fact（优先 transferable）+ \`technique_transfer\` 横向扇出。
4. **验证与交付**：复现后用 \`finding_verify\`（附 \`evidence/\` 原件与 repro）提升为 verified；边打边推进目标要求的证据文件，未通过 \`assert_goal\` 前禁止提前收工。
`;
}

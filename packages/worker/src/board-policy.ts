import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import type { WorkerManifest } from "@gongyuai/contracts";

/**
 * Engagement & vulnerability discovery policy.
 *
 * Design invariant (Goodhart guard):
 * The system's objective function is ALWAYS real-world attack-surface understanding
 * and root-cause verified Findings (`finding_record` → control/test differential proof
 * → `finding_verify` with sealed `http:<id>` / `oast:<token>` / `evidence/` artifacts),
 * NEVER competition score chasing or unverified speculation.
 */
export function hasBenchmarkHarness(manifest: WorkerManifest): boolean {
  const ids = new Set((manifest.goals ?? []).map((g) => g.id));
  const titles = (manifest.goals ?? []).map((g) => g.title.toLowerCase()).join(" ");
  if (
    ids.has("clear-board") ||
    (manifest.goals ?? []).some((g) => g.boardGate === "tsecbench") ||
    /clear.*board|清板|tsecbench|全部.*挑战/.test(titles)
  ) {
    return true;
  }
  if (process.env.BENCHMARK_BASE_URL && process.env.BENCHMARK_TOKEN) return true;
  if (manifest.dataDir) {
    const envPath = join(dirname(dirname(manifest.dataDir)), "tsecbench", "env");
    if (existsSync(envPath)) return true;
  }
  return false;
}

export function isBoardClearMission(manifest: WorkerManifest): boolean {
  const ids = new Set((manifest.goals ?? []).map((g) => g.id));
  const titles = (manifest.goals ?? []).map((g) => g.title.toLowerCase()).join(" ");
  return (
    ids.has("clear-board") ||
    ids.has("engagement-report") ||
    /clear.*board|清板|tsecbench|全部.*挑战|engagement/.test(titles)
  );
}

export function boardClearPolicyBlock(manifest: WorkerManifest): string {
  if (!isBoardClearMission(manifest)) return "";

  const base = `
## 授权渗透测试与深度漏洞挖掘纪律（防异化原则）
目标函数：在授权坐标内**系统化建图攻击面、定位真实安全缺陷成因、产出经对照验证且可独立复核的 Finding**。任何外部回执或凭证仅作为漏洞影响证明（PoC），绝不能用猜测或无证据结论替代成因验证。

### 深度漏洞挖掘方法论
1. **业务与信任边界建图（先读懂再出刀）**：
   - 先梳理目标技术栈、路由端点、鉴权机制、角色状态流转与外部输入汇聚点（新主机/服务端点由工具自动或经 \`asset_record\` 建图）；
   - 单节点探索可用 \`intent_propose(..., claim="true")\` 一步将明确的漏洞假设转化为当前活跃验证单元。
2. **多角色会话与基线对照验证（排除误报）**：
   - 涉及越权、状态机绕过或多步业务逻辑缺陷时，使用 \`http_request\` 的命名 \`session\`（如 \`admin\` / \`user_a\` / \`anon\`）隔离维持各身份态；
   - 验证输入边界、访问控制或盲态差异时，用 \`http_request\` 的 \`compareWith="http:<baselineId>"\` 与正常基线事务做确定性响应差分，用对照组说话，禁止靠盲目字典爆破碰运气。
3. **证据闭环与同源横向迁移**：
   - 发现可疑线索先 \`finding_record\`（tentative）；完成复现后必须调用 \`finding_verify\` 绑定封存事务 \`http:<id>\`、带外命中 \`oast:<token>\` 或 \`evidence/\` 原件及精确复现步骤；
   - 确认有效成因、凭据或立足点后，提炼组件/架构特征通过 \`technique_transfer\` 对同族资产扇出验证；
   - 同一攻击面连续约 25 次工具调用无实质证据进展时，须 \`intent_conclude(status="failed", conclusion="已验证排除的假设与边界约束")\` 止损换面；交付报告（如 \`engagement/report.md\`）只纳入 \`verified\` 结论。
`;

  if (!hasBenchmarkHarness(manifest)) {
    return base;
  }

  return `${base}
### 外部靶场环境适配器说明（仅作靶机生命周期管理，不改变漏洞挖掘标准）
- 当前环境挂载了 \`tsecbench\` 靶机管理适配器：通过 \`tsecbench(action="list"|"start"|"submit"|"close")\` 获取并启停受测靶机实例（并发实例 ≤3，验证完毕及时 \`close\`）；系统会自动将启动实例的 \`container_addr\` 纳入目标范围并建档 \`live\` 资产。
- 联通性预检端点仅用于网络健康检查，并非受测业务实例；针对受测实例发现的漏洞仍须保留完整验证证据链，平台 \`409 already finished\` 视为环境终态。
`;
}

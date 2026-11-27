import { existsSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import type { WorkerManifest } from "@gongyuai/contracts";

export type EvidenceGoalLike = {
  id: string;
  title?: string;
  description?: string;
  evidencePatterns?: string[];
  passes?: boolean;
};

export type EvidenceDeliverableKind = "ledger" | "report";

export type EvidenceDeliverableSpec = {
  kind: EvidenceDeliverableKind;
  goalId: string;
  label: string;
  /** Path relative to evidenceDir, without a leading slash. */
  relativePath: string;
};

export type EvidenceDeliverableGap = EvidenceDeliverableSpec & {
  /** Workspace-facing path, always under evidence/. */
  evidencePath: string;
  reason: "missing" | "stale";
  ageMs: number | null;
};

const LEDGER_FALLBACK = "goals/autonomous-progress.md";
const REPORT_FALLBACK = "engagement/report.md";

function safeRelative(pattern: string | undefined, fallback: string): string {
  if (!pattern) return fallback;
  const norm = pattern.replace(/\\/g, "/").replace(/^\.\//, "");
  if (!norm || norm.startsWith("/") || norm.includes("..") || /[*?\0]/.test(norm)) return fallback;
  return norm;
}

function mentionsLedger(goal: EvidenceGoalLike): boolean {
  const blob = `${goal.id}\n${goal.title ?? ""}\n${goal.description ?? ""}\n${(goal.evidencePatterns ?? []).join("\n")}`;
  return goal.id === "progress-log"
    || /autonomous-progress\.md/i.test(blob)
    || /进度台账|engagement ledger/i.test(blob);
}

function mentionsReport(goal: EvidenceGoalLike): boolean {
  const blob = `${goal.id}\n${goal.title ?? ""}\n${goal.description ?? ""}\n${(goal.evidencePatterns ?? []).join("\n")}`;
  return goal.id === "engagement-report"
    || /engagement\/report\.md/i.test(blob)
    || /渗透报告|客户报告|engagement report/i.test(blob);
}

/** Goals that require a progress ledger or an engagement report, deduped by path. */
export function evidenceDeliverableSpecs(goals: readonly EvidenceGoalLike[]): EvidenceDeliverableSpec[] {
  const specs: EvidenceDeliverableSpec[] = [];
  const seen = new Set<string>();
  for (const goal of goals) {
    const patterns = goal.evidencePatterns ?? [];
    if (mentionsLedger(goal)) {
      const matched = patterns.find((pattern) => /autonomous-progress\.md|goals\/[^ *]*progress\.md/i.test(pattern));
      const relativePath = safeRelative(matched, LEDGER_FALLBACK);
      const key = `ledger:${relativePath}`;
      if (!seen.has(key)) {
        seen.add(key);
        specs.push({ kind: "ledger", goalId: goal.id, label: "进度台账", relativePath });
      }
    }
    if (mentionsReport(goal)) {
      const matched = patterns.find((pattern) => /engagement\/report\.md/i.test(pattern));
      const relativePath = safeRelative(matched, REPORT_FALLBACK);
      const key = `report:${relativePath}`;
      if (!seen.has(key)) {
        seen.add(key);
        specs.push({ kind: "report", goalId: goal.id, label: "渗透报告", relativePath });
      }
    }
  }
  return specs;
}

export function collectEvidenceGaps(opts: {
  evidenceDir: string;
  goals: readonly EvidenceGoalLike[];
  nowMs?: number;
  staleAfterMs?: number;
}): EvidenceDeliverableGap[] {
  const now = opts.nowMs ?? Date.now();
  const staleAfter = opts.staleAfterMs ?? 30 * 60_000;
  const gaps: EvidenceDeliverableGap[] = [];
  for (const spec of evidenceDeliverableSpecs(opts.goals)) {
    const abs = join(opts.evidenceDir, spec.relativePath);
    const evidencePath = `evidence/${spec.relativePath}`;
    if (!existsSync(abs)) {
      gaps.push({ ...spec, evidencePath, reason: "missing", ageMs: null });
      continue;
    }
    try {
      const st = statSync(abs);
      if (!st.isFile() || st.size <= 0) {
        gaps.push({ ...spec, evidencePath, reason: "missing", ageMs: null });
        continue;
      }
      const ageMs = Math.max(0, now - st.mtimeMs);
      if (ageMs >= staleAfter) {
        gaps.push({ ...spec, evidencePath, reason: "stale", ageMs });
      }
    } catch {
      gaps.push({ ...spec, evidencePath, reason: "missing", ageMs: null });
    }
  }
  return gaps;
}

export type EvidencePaceBinding = {
  evidenceDir: string;
  goals: EvidenceGoalLike[];
  historyDb?: string;
};

let evidencePaceBinding: EvidencePaceBinding | null = null;

/**
 * Called once from the worker entry so soft-pace can see evidence paths
 * without the Pi loop having to thread a new argument through checkpoint state.
 */
export function bindEvidencePaceManifest(manifest: {
  evidenceDir?: string;
  historyDb?: string;
  goals?: EvidenceGoalLike[];
  workerSlot?: number;
  workerCount?: number;
} | null): void {
  // Multi-worker followers (slot > 0) focus purely on vulnerability exploitation & structured
  // Findings/Facts; shared Markdown deliverables are materialized by control-plane & verified by slot 0 leader.
  if (!manifest?.evidenceDir || ((manifest.workerCount ?? 1) > 1 && (manifest.workerSlot ?? 0) > 0)) {
    evidencePaceBinding = null;
    return;
  }
  evidencePaceBinding = {
    evidenceDir: manifest.evidenceDir,
    goals: manifest.goals ?? [],
    ...(manifest.historyDb ? { historyDb: manifest.historyDb } : {}),
  };
}

export function currentEvidencePaceBinding(): EvidencePaceBinding | null {
  return evidencePaceBinding;
}

export function resetEvidencePaceBinding(): void {
  evidencePaceBinding = null;
}

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

export function systematicDiscoveryPolicyBlock(): string {
  return `
## 体系化漏洞搜索与反证纪律（防碰运气 / 防锚定 / 防误报）
1. **双轨并行搜索（防扫描器锚定）**：
   - **轨道 A（正向业务语义推演）**：从入口、身份、资源所有权、状态流转与业务动作出发，独立提出越权（IDOR/BOLA/BFLA）、认证绕过、状态跳过、竞态等假设；**扫描器零命中绝不阻断语义探索**，不要只盯着扫描器告警跑。
   - **轨道 B（确定性扫描兜底）**：用 \`nmap/httpx/nuclei/ffuf/aimy\` 等确定性工具覆盖已知特征、隐藏参数、指纹组件与危险点，作为下限兜底与轨道 A 汇合。
2. **漏洞大类缺口复查**：
   - 推进与收口前检查 Observe 中的「漏洞大类覆盖矩阵」；对标为\`未测\`且适用于当前目标的大类补跑定向探索，明确区分“测过无发现”与“未检查”。
3. **发现与验证解耦（主动反证优先）**：
   - **发现阶段求全**：接受弱线索并先 \`finding_record\`（tentative），不因暂缺完整利用链而过早放弃。
   - **验证阶段求真**：验证时优先寻找**反证**（普通反射而非执行、前置鉴权兜底、不可达或仅状态码波动）；必须用 \`http_request(compareWith="http:<baselineId>")\` 做正常基线 vs 攻击态差分对照，排除误报后才允许 \`finding_verify\`。
`;
}

export function boardClearPolicyBlock(manifest: WorkerManifest): string {
  if (!isBoardClearMission(manifest)) return "";

  const isFollower = (manifest.workerCount ?? 1) > 1 && (manifest.workerSlot ?? 0) > 0;
  if (isFollower) {
    const benchmarkLine = hasBenchmarkHarness(manifest)
      ? "\n- 靶场生命周期（`list/start/close`）由 Leader 统一调度；你仅在验证成因并取得受测实例影响回执时调用 `tsecbench(action=\"submit\")` 核验（`409 already finished` 视为环境终态）。"
      : "";
    return `
## 战术探索与延迟入账准则（Follower 零文书税）
- **平时轻装推进**：探索期不维护全局进度台账（\`autonomous-progress.md\`）或客户报告（\`engagement/report.md\`），中间进展仅用 \`fact_draft\` 轻量留痕，同目标并行写工作区临时文件按 \`<host>-<technique>-*\` 隔离。
- **验证阶段求真**：确认越权、认证绕过或注入成因时，用 \`http_request(compareWith="http:<baselineId>")\` 基线对照排除误报；仅在取得实质突破（可复现漏洞、凭据、立足点、内网新存活主机）或进入 3 步收尾保护窗时集中调用 \`finding_verify\` / \`credential_record\` / \`asset_record\` 入账。${benchmarkLine}
`;
  }

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
4. **过程材料落盘（不阻断攻击链）**：
   - 目标若要求进度台账或渗透报告，边打边写 \`evidence/goals/autonomous-progress.md\` 与 \`evidence/engagement/report.md\`；目录空着或长时间不更新时，软节奏会点名路径。缺文件不是收工理由。
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

/**
 * 角色分层（第九轮 P4）：规划者 / 复核者 / 事故辅助者。
 *
 * 本文件只做**确定性模拟**：不调用真实模型，输入输出全部落盘可复算。
 * 真实供应商表现单列「待验证」，不得把模拟结果写成省钱或增益证据。
 * 权限来自 contracts 的 ROLE_AUTHORITY：辅助者有 pause 权，无 stop / 扩 scope / 派单权。
 */
import {
  ROLE_AUTHORITY,
  enforceRoleAction,
  type RoleAuthority,
  type RoleKind,
} from "@gongyuai/contracts";

export type RoleSimOutput = {
  summary: string;
  proposals: Array<{ title: string; basis: string; intentHint: string | null }>;
  opinions: Array<{ claim: string; basis: string; verdict: "support" | "challenge" | "needs-evidence" }>;
  pauseRequested: boolean;
  pauseReason: string | null;
  authority: RoleAuthority;
  authenticity: "simulated";
};

type CoverageEntry = { asset?: unknown; technique?: unknown; state?: unknown };

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function text(value: unknown, fallback = ""): string {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : fallback;
}

export function simulateRoleWork(
  role: RoleKind,
  kind: "plan" | "review" | "incident",
  input: Record<string, unknown>,
): RoleSimOutput {
  const authority = ROLE_AUTHORITY[role];
  if (kind === "plan") {
    const check = enforceRoleAction(role, "propose");
    if (!check.allowed) throw new Error(check.reason ?? "role cannot propose");
  }
  if (kind === "review") {
    const check = enforceRoleAction(role, "review");
    if (!check.allowed) throw new Error(check.reason ?? "role cannot review");
  }

  const proposals: RoleSimOutput["proposals"] = [];
  const opinions: RoleSimOutput["opinions"] = [];
  let pauseRequested = false;
  let pauseReason: string | null = null;
  let summary = "";

  if (kind === "plan") {
    const assets = asArray(input.assets).map((entry) => text(entry)).filter(Boolean);
    const coverage = asArray(input.coverage) as CoverageEntry[];
    const gaps = coverage.filter((cell) => ["unknown", "material", "retracted"].includes(text(cell.state)));
    for (const gap of gaps.slice(0, 10)) {
      const asset = text(gap.asset, "unknown-asset");
      const technique = text(gap.technique, "unspecified-technique");
      proposals.push({
        title: `补测 ${asset} 的 ${technique}`,
        basis: `覆盖矩阵状态=${text(gap.state)}，尚无已证实结论`,
        intentHint: `对 ${asset} 执行 ${technique} 验证，前驱必须引用该资产事实`,
      });
    }
    const passed = asArray(input.goals).filter((goal) => (goal as { passes?: unknown }).passes === true).length;
    summary = `规划者：${assets.length} 个资产、${coverage.length} 个覆盖单元，其中 ${gaps.length} 个待补；目标已通过 ${passed} 个。本输出只是提案，派单仍需过 sourceFactIds 硬闸。`;
  } else if (kind === "review") {
    const claims = asArray(input.claims);
    for (const raw of claims.slice(0, 20)) {
      const claim = raw as { id?: unknown; text?: unknown; evidence?: unknown };
      const claimText = text(claim.text, text(claim.id, "unnamed-claim"));
      const evidence = asArray(claim.evidence).map((entry) => text(entry)).filter(Boolean);
      if (evidence.length === 0) {
        opinions.push({
          claim: claimText,
          basis: "没有可复验的证据路径",
          verdict: "needs-evidence",
        });
      } else {
        opinions.push({
          claim: claimText,
          basis: `证据：${evidence.join("、")}`,
          verdict: "support",
        });
      }
    }
    const missingCounter = input.counterEvidenceRequired === true && asArray(input.counterEvidence).length === 0;
    if (missingCounter) {
      opinions.push({
        claim: "报告缺少反证检查",
        basis: "已声明需要反证材料，但输入里没有反证证据",
        verdict: "challenge",
      });
    }
    summary = `复核者：核对 ${claims.length} 条主张，给出 ${opinions.length} 条可追溯意见（needs-evidence ${opinions.filter((entry) => entry.verdict === "needs-evidence").length} 条）。不改写事实。`;
  } else {
    const signals = asArray(input.signals) as Array<{ kind?: unknown; detail?: unknown; severity?: unknown }>;
    const serious = signals.filter((signal) => ["high", "critical"].includes(text(signal.severity)));
    if (serious.length > 0) {
      const check = enforceRoleAction(role, "pause");
      pauseRequested = check.allowed;
      pauseReason = pauseRequested
        ? `辅助者按既有权限请求暂停：${serious.map((signal) => text(signal.kind, "signal")).join("、")}`
        : null;
    }
    summary = `辅助者：收到 ${signals.length} 个信号，其中严重信号 ${serious.length} 个；${pauseRequested ? "已请求暂停（非终态，可逆），恢复决定留给操作员" : "未触发暂停"}。`;
  }

  return {
    summary,
    proposals,
    opinions,
    pauseRequested,
    pauseReason,
    authority,
    authenticity: "simulated",
  };
}

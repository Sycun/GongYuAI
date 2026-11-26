/**
 * Read-only Observe & Engagement Audit projection over `HistoryStore`.
 * Keeps prompt/markdown rendering separated from core DAG storage transactions.
 */
import {
  ORIGIN_FACT_ID,
  deriveEngagementAudit,
  formatEngagementAuditSummary,
  type AssetKind,
  type AssetRecord,
  type Credential,
  type EngagementAudit,
  type Fact,
  type Finding,
  type GoalState,
  type Hint,
  type HostProfile,
  type Intent,
  type PlanStep,
} from "@gongyuai/contracts";

export type ObserveRenderSource = {
  listGoals(taskId: string): GoalState[];
  listAssets(taskId: string): AssetRecord[];
  listFacts(taskId: string, layer?: "title" | "summary" | "evidence"): Fact[];
  listTransferableFacts(taskId: string): Fact[];
  listIntents(taskId: string): Intent[];
  listHints(taskId: string, limit?: number): Hint[];
  listFindings(taskId: string): Finding[];
  listCredentials(taskId: string): Credential[];
  listHostProfiles(taskId: string): HostProfile[];
  listPlan(taskId: string): PlanStep[];
  hasConfirmedValidation(taskId: string, findingId: string): boolean;
};

export function deriveHistoryEngagementAudit(
  src: ObserveRenderSource,
  taskId: string,
  nowIso = new Date().toISOString(),
): EngagementAudit {
  return deriveEngagementAudit({
    now: nowIso,
    assets: src.listAssets(taskId).map((asset) => ({
      address: asset.address,
      kind: asset.kind,
      weight: asset.weight,
      assetType: asset.assetType,
    })),
    intents: src.listIntents(taskId).map((intent) => ({
      id: intent.id,
      title: intent.title,
      technique: intent.technique,
      assetRoot: intent.assetRoot,
      status: intent.status,
      createdAt: intent.createdAt,
      updatedAt: intent.updatedAt,
      concludedAt: intent.concludedAt,
    })),
    findings: src.listFindings(taskId).map((finding) => ({
      id: finding.id,
      asset: finding.asset,
      endpoint: finding.endpoint,
      vulnClass: finding.vulnClass,
      status: finding.status,
      severity: finding.severity,
      createdAt: finding.createdAt,
      verifiedAt: finding.verifiedAt,
      evidence: finding.evidence.map((item) => ({
        path: item.path,
        ...(item.role ? { role: item.role } : {}),
      })),
      independentConfirmed: src.hasConfirmedValidation(taskId, finding.id),
    })),
    credentials: src.listCredentials(taskId).map((credential) => ({
      id: credential.id,
      asset: credential.asset,
      kind: credential.kind,
      reuseCount: credential.reuseCount,
      verifiedAt: credential.verifiedAt,
      tier: credential.tier,
    })),
  });
}

export function renderHistoryObserve(src: ObserveRenderSource, taskId: string): string {
  const lines = renderObserveCore(src, taskId);
  lines.push("", "（Observe 不含 summary/evidence；需要时用 history_read_fact / history_list_layer。）");
  return lines.join("\n");
}

export function renderHistoryOverview(src: ObserveRenderSource, taskId: string): string {
  const lines = renderObserveCore(src, taskId);
  const summaries = src.listFacts(taskId, "summary").slice(-20);
  lines.push("", "## 近期摘要");
  if (summaries.length === 0) {
    lines.push("- （无）");
  } else {
    for (const f of summaries) {
      lines.push(`- [${f.id}] ${f.title}: ${f.summary.slice(0, 240)}`);
    }
  }
  return lines.join("\n");
}

function renderObserveCore(src: ObserveRenderSource, taskId: string): string[] {
  const MAX_OBSERVE_ASSETS = 40;
  const MAX_HOT_FACTS = 25;
  const MAX_RECENT_TITLES = 40;
  const MAX_OPEN_INTENTS = 30;

  const goals = src.listGoals(taskId);
  const assets = src.listAssets(taskId);
  const allFacts = src.listFacts(taskId);
  const allTitleFacts = allFacts.filter((f) => f.layer === "title");
  const allIntents = src.listIntents(taskId);
  const open = allIntents.filter((i) => ["proposed", "claimed", "running"].includes(i.status));
  const hints = src.listHints(taskId, 20);
  const transferable = src.listTransferableFacts(taskId).slice(-20);
  const findings = src.listFindings(taskId).filter((f) => f.status !== "retracted");

  const factById = new Map(allFacts.map((f) => [f.id, f]));
  const intentById = new Map(allIntents.map((i) => [i.id, i]));
  const hotFactIds = new Set<string>();
  const factQueue: string[] = [];
  const enqueueFact = (id: string) => {
    if (!id || id === ORIGIN_FACT_ID || hotFactIds.has(id)) return;
    hotFactIds.add(id);
    factQueue.push(id);
  };
  for (const intent of open) {
    for (const id of intent.sourceFactIds) enqueueFact(id);
  }
  for (const finding of findings) {
    for (const id of finding.factIds ?? []) enqueueFact(id);
  }
  for (const f of transferable) enqueueFact(f.id);
  for (const f of allTitleFacts) {
    if (f.tags.some((t) => t === "foothold" || t === "credential" || t === "transferable")) {
      enqueueFact(f.id);
    }
  }
  let steps = 0;
  while (factQueue.length > 0 && steps < 64) {
    steps += 1;
    const fid = factQueue.shift()!;
    const f = factById.get(fid);
    if (!f?.intentId) continue;
    const parentIntent = intentById.get(f.intentId);
    if (!parentIntent) continue;
    for (const srcId of parentIntent.sourceFactIds) enqueueFact(srcId);
  }

  const recentTitles = allTitleFacts.slice(-MAX_RECENT_TITLES);
  const recentTitleSet = new Set(recentTitles.map((f) => f.id));
  const hotOlderTitles = allTitleFacts
    .filter((f) => hotFactIds.has(f.id) && !recentTitleSet.has(f.id))
    .slice(-MAX_HOT_FACTS);
  const titles = [...hotOlderTitles, ...recentTitles];
  const foldedTitleCount = Math.max(0, allTitleFacts.length - titles.length);

  const hotAssetSet = new Set<string>([
    ...open.map((i) => i.assetRoot).filter((x): x is string => Boolean(x)),
    ...findings.map((f) => f.asset),
  ]);
  const sortedAssets = [...assets].sort((a, b) => {
    const aHot = hotAssetSet.has(a.address) ? 1 : 0;
    const bHot = hotAssetSet.has(b.address) ? 1 : 0;
    if (aHot !== bHot) return bHot - aHot;
    const kindOrder: Record<AssetKind, number> = {
      live: 5,
      admitted: 4,
      seed: 3,
      candidate: 2,
      oos: 1,
    };
    if (kindOrder[a.kind] !== kindOrder[b.kind]) return kindOrder[b.kind] - kindOrder[a.kind];
    const aw = a.weight ?? 0;
    const bw = b.weight ?? 0;
    if (aw !== bw) return bw - aw;
    return a.address.localeCompare(b.address);
  });
  const shownAssets = sortedAssets.slice(0, MAX_OBSERVE_ASSETS);
  const omittedAssets = Math.max(0, sortedAssets.length - shownAssets.length);
  const omittedOos = sortedAssets.slice(MAX_OBSERVE_ASSETS).filter((a) => a.kind === "oos").length;

  const lines: string[] = [];
  lines.push("## 目标");
  for (const g of goals) {
    lines.push(`- [${g.passes ? "通过" : "未通过"}] ${g.id}: ${g.title}`);
  }
  lines.push("", `## 资产清单（${assets.length}）`);
  if (assets.length === 0) {
    lines.push("- （无；Bootstrap / seedAssetsFromAuth 应写入 auth.targets）");
  } else {
    for (const a of shownAssets) {
      lines.push(
        `- [${a.kind}] ${a.address} ←fact ${a.factId} · ${a.source}${a.intentId ? ` ←intent ${a.intentId}` : ""}`,
      );
    }
    if (omittedAssets > 0) {
      lines.push(
        `- … 另有 ${omittedAssets} 个资产已折叠（其中 oos=${omittedOos}）；需全量清单请调用 asset_list。`,
      );
    }
    lines.push(
      "（seed/admitted/live 可作 Intent 前驱继续测；oos 禁止作为利用 Intent 唯一前驱；Reason 扇出受 maxIntentsPerReason / 同根硬顶；发现用 asset_record。）",
    );
  }
  lines.push("", "## Hint（战术注入）");
  if (hints.length === 0) {
    lines.push("- （无）");
  } else {
    for (const h of hints) {
      lines.push(`- [${h.id}] (${h.source}) ${h.text.slice(0, 320)}`);
    }
    lines.push("（人类/同族 Hint 须吸收进下一轮 Explore/Reason；勿忽略。）");
  }
  lines.push("", "## 可迁移打法（同族）");
  if (transferable.length === 0) {
    lines.push("- （无；验证手法后用 technique_transfer 广播）");
  } else {
    for (const f of transferable) {
      lines.push(`- [${f.id}] ${f.title}${f.summary ? `: ${f.summary.slice(0, 160)}` : ""}`);
    }
  }
  lines.push("", `## Findings 台账（${findings.length}）`);
  if (findings.length === 0) {
    lines.push("- （无；发现线索即 finding_record，复现后 finding_verify 才可进交付）");
  } else {
    for (const f of findings.slice(-30)) {
      lines.push(
        `- [${f.id}] (${f.status}/${f.severity}) ${f.title} · ${f.asset}${f.endpoint ? ` · ${f.endpoint}` : ""} · ${f.vulnClass}`,
      );
    }
    lines.push("（tentative 不得写进交付叙述；verified 须附证据与 repro；同 dedupKey 幂等。）");
  }
  lines.push(
    "",
    foldedTitleCount > 0
      ? `## 事实标题（title 层 · 显示 ${titles.length}/${allTitleFacts.length}，已折叠冷历史 ${foldedTitleCount} 条）`
      : "## 事实标题（title 层）",
  );
  for (const f of titles) {
    const intent = f.intentId ? ` ←intent ${f.intentId}` : "";
    const hotPin = !recentTitleSet.has(f.id) ? " [热祖先]" : "";
    lines.push(`- [${f.id}]${hotPin} ${f.title}${intent}`);
  }
  lines.push("", `## 进行中意图（${open.length}）`);
  if (open.length === 0) {
    lines.push("- （无）");
  } else {
    for (const i of open.slice(0, MAX_OPEN_INTENTS)) {
      const srcIds = i.sourceFactIds.join(",");
      lines.push(`- [${i.id}] (${i.status}) ${i.title} ←facts ${srcIds}`);
    }
    if (open.length > MAX_OPEN_INTENTS) {
      lines.push(`- … 另有 ${open.length - MAX_OPEN_INTENTS} 条进行中意图未展开。`);
    }
  }
  const profiles = src.listHostProfiles(taskId);
  if (profiles.length) {
    lines.push("", "## Foothold 主机画像");
    for (const profile of profiles.slice(0, 10)) {
      lines.push(
        `- ${profile.asset} · ${profile.os ?? "os?"} · ${profile.domain ?? "domain?"} · users=${profile.users.length} priv=${profile.privileges.join("/") || "-"} svc=${profile.services.length} share=${profile.shares.length} av=${profile.av.join("/") || "-"}`,
      );
    }
  }
  const plan = src.listPlan(taskId);
  if (plan.length) {
    lines.push("", "## 作战计划（plan_step）");
    for (const step of plan.slice(0, 12)) {
      const needs = [
        ...step.needsFactIds.map((id) => `fact:${id}`),
        ...step.needsIntentIds.map((id) => `intent:${id}`),
        ...step.needsFindingIds.map((id) => `finding:${id}`),
      ];
      lines.push(
        `- [${step.id}] #${step.ord} (${step.status}) ${step.title}${needs.length ? ` ←${needs.join(",")}` : ""}`,
      );
    }
    lines.push("（ready 才是可派单的下一步；intent_propose 带 planStepId；计划≠授权。）");
  }

  const vulnClasses: Array<{ id: string; label: string; pattern: RegExp }> = [
    {
      id: "injection",
      label: "注入(SQLi/CMDi/SSTI/XXE)",
      pattern: /\b(sqli|sql|cmdi|rce|ssti|xxe|nosql|ldap|cwe-89|cwe-78|cwe-94|cwe-611)\b|注入|命令执行|模板注入/i,
    },
    {
      id: "authz",
      label: "越权(IDOR/BOLA/BFLA)",
      pattern: /\b(idor|bola|bfla|authz|rbac|acl|privilege|cwe-639|cwe-862|cwe-863)\b|越权|水平|垂直|权限绕过/i,
    },
    {
      id: "authn",
      label: "认证会话(AuthN/JWT/OAuth)",
      pattern: /\b(authn|jwt|oauth|oidc|session|cookie|login|reset|mfa|cwe-287|cwe-384)\b|认证|登录|令牌|会话|密码重置/i,
    },
    {
      id: "bizlogic",
      label: "业务逻辑(状态机/竞态/支付)",
      pattern: /\b(bizlogic|business|workflow|race|toctou|state|price|coupon|replay|cwe-362|cwe-840)\b|业务逻辑|状态机|竞态|重放|越步|金额/i,
    },
    {
      id: "ssrf-file",
      label: "SSRF/文件(穿越/LFI/上传)",
      pattern: /\b(ssrf|lfi|rfi|traversal|upload|file|path|cwe-918|cwe-22|cwe-434)\b|路径穿越|任意文件|文件读取|文件上传/i,
    },
    {
      id: "client-api",
      label: "前端与API(XSS/CORS/GraphQL)",
      pattern: /\b(xss|csrf|cors|graphql|proto|prototype|dom|cwe-79|cwe-352|cwe-942)\b|跨站|原型链/i,
    },
    {
      id: "deser-config",
      label: "反序列化/组件CVE/配置",
      pattern: /\b(deser|deserialize|cve-|config|misconfig|actuator|swagger|debug|cwe-502|cwe-200)\b|反序列化|信息泄露|弱配置|默认口令/i,
    },
  ];
  const verifiedVulnText = findings
    .filter((f) => f.status === "verified" || f.status === "retested" || f.status === "accepted")
    .map((f) => `${f.vulnClass} ${f.title}`)
    .join(" ");
  const tentativeVulnText = findings
    .filter((f) => f.status === "tentative")
    .map((f) => `${f.vulnClass} ${f.title}`)
    .join(" ");
  const testedText = [
    ...allIntents.map((i) => `${i.title} ${i.technique ?? ""} ${i.conclusion ?? ""}`),
    ...allTitleFacts.map((f) => `${f.title} ${f.tags.join(" ")}`),
  ].join(" ");
  const covParts: string[] = [];
  const untestedLabels: string[] = [];
  for (const vc of vulnClasses) {
    if (vc.pattern.test(verifiedVulnText)) {
      covParts.push(`${vc.label}=已证实`);
    } else if (vc.pattern.test(tentativeVulnText)) {
      covParts.push(`${vc.label}=待验证`);
    } else if (vc.pattern.test(testedText)) {
      covParts.push(`${vc.label}=已测无洞`);
    } else {
      covParts.push(`${vc.label}=未测`);
      untestedLabels.push(vc.label);
    }
  }
  lines.push("", "## 漏洞大类覆盖矩阵（防漏测 · 区分已测与未测）");
  lines.push(`- ${covParts.join(" · ")}`);
  if (untestedLabels.length > 0) {
    lines.push(
      `（尚有 ${untestedLabels.length} 类未测：${untestedLabels.join("、")}；收口前须核查是否适用于当前目标，避免把“未测”误当作“安全”。）`,
    );
  }

  const audit = deriveHistoryEngagementAudit(src, taskId);
  lines.push("", "## 观察员（只读自动派生）");
  if (audit.observations.length === 0) {
    lines.push("- （无重复失败 / 重复派单 / 停滞 / 未经营高权重资产）");
  } else {
    for (const item of audit.observations.slice(0, 4)) {
      lines.push(`- [${item.severity}] ${item.text}`);
    }
  }
  lines.push("", "## 作业记分卡");
  lines.push(formatEngagementAuditSummary(audit));
  lines.push("（观察员只给建议，不派单、不改授权；完整观察项用 engagement_audit。）");
  return lines;
}

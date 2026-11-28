/**
 * Read-only Observe & Engagement Audit projection over `HistoryStore`.
 * Keeps prompt/markdown rendering separated from core DAG storage transactions.
 */
import {
  ORIGIN_FACT_ID,
  deriveEngagementAudit,
  formatEngagementAuditSummary,
  sameAssetScope,
  type AssetKind,
  type AssetRecord,
  type Credential,
  type CredentialCheck,
  type EngagementAudit,
  type Fact,
  type Finding,
  type GoalState,
  type Hint,
  type HostProfile,
  type HttpTransaction,
  type Intent,
  type PlanStep,
} from "@gongyuai/contracts";

/** Cross-process tunnel summary injected by the prompt builder (no fs access here). */
export type ObserveActiveTunnel = {
  id: string;
  kind: string;
  localPort: number;
  targetHost: string;
  targetPort: number | null;
  via?: string;
};

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
  listHttpTransactions?(taskId: string, limit?: number): HttpTransaction[];
  hasConfirmedValidation(taskId: string, findingId: string): boolean;
  listCredentialChecks?(taskId: string): CredentialCheck[];
  /** Live `running` tunnels from `<dataDir>/exec/tunnels` (all worker slots share them). */
  listActiveTunnels?(): ObserveActiveTunnel[];
};

const ACTIVE_INTENT_STATUSES = new Set(["claimed", "running"]);

function formatDuration(ms: number): string {
  const minutes = Math.floor(Math.max(0, ms) / 60_000);
  if (minutes < 1) return "<1m";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h${minutes % 60}m`;
}

/** 简明运行脉搏：已运行时长 / claimed_by / 最近 HTTP 状态码统计或最新 Fact 标题。 */
function renderIntentPulse(
  intent: Intent,
  facts: readonly Fact[],
  transactions: readonly HttpTransaction[],
  nowMs: number,
): string {
  if (!ACTIVE_INTENT_STATUSES.has(intent.status)) return "";
  const parts: string[] = [];
  const startedMs = Date.parse(intent.claimedAt ?? intent.createdAt);
  if (Number.isFinite(startedMs)) {
    parts.push(`已运行 ${formatDuration(nowMs - startedMs)}`);
  }
  parts.push(`claimed_by=${intent.claimedBy ?? "—"}`);
  const ownTx = transactions.filter((tx) => tx.intentId === intent.id).slice(-12);
  if (ownTx.length > 0) {
    const counts = new Map<number, number>();
    for (const tx of ownTx) counts.set(tx.status, (counts.get(tx.status) ?? 0) + 1);
    const codes = [...counts.entries()]
      .map(([status, count]) => `${status === 0 ? "000" : status}×${count}`)
      .join("/");
    parts.push(`HTTP ${codes}`);
  } else {
    const ownFacts = facts.filter((fact) => fact.intentId === intent.id);
    const latest = ownFacts[ownFacts.length - 1];
    if (latest) parts.push(`最新事实: ${latest.title.slice(0, 60)}`);
  }
  return parts.join(" · ");
}

/**
 * 并发槽位子表面互斥声明：把同 assetRoot / 同 RFC1918 /24 的其他活跃 Intent
 * 的子表面与互斥说明显式呈现，避免并行槽位重复探测同一子路径。
 */
export function renderSurfaceMutexDeclaration(
  active: Pick<Intent, "id" | "title" | "assetRoot" | "assignedSurfaces" | "mutexNote">,
  peers: readonly Intent[],
): string | null {
  const activeRoot = active.assetRoot?.trim();
  if (!activeRoot) return null;
  const siblings = peers.filter(
    (peer) =>
      peer.id !== active.id &&
      ACTIVE_INTENT_STATUSES.has(peer.status) &&
      peer.assetRoot != null &&
      sameAssetScope(activeRoot, peer.assetRoot),
  );
  if (siblings.length === 0) return null;
  const lines: string[] = ["[并发槽位子表面互斥声明]"];
  const ownSurfaces = (active.assignedSurfaces ?? []).join(" / ") || "（未声明）";
  lines.push(
    `- 本槽位 @${activeRoot}「${active.title.slice(0, 80)}」负责子表面: ${ownSurfaces}${active.mutexNote ? ` · 互斥说明: ${active.mutexNote.slice(0, 200)}` : ""}`,
  );
  for (const peer of siblings.slice(0, 6)) {
    const surfaces = (peer.assignedSurfaces ?? []).join(" / ") || "（未声明）";
    lines.push(
      `- 友邻槽位 @${peer.assetRoot}「${peer.title.slice(0, 80)}」负责子表面: ${surfaces}${peer.mutexNote ? ` · 互斥说明: ${peer.mutexNote.slice(0, 200)}` : ""}`,
    );
  }
  lines.push(
    "（避免重复探测同一子路径/端口面；跨槽复用资源走 credential_list / tunnel_list 或 supervisor 督导，勿重复新建同类会话。）",
  );
  return lines.join("\n");
}

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
    credentialChecks: (src.listCredentialChecks?.(taskId) ?? []).map((check) => ({
      credentialId: check.credentialId,
      targetAsset: check.targetAsset,
      verdict: check.verdict,
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
  const credentials = src.listCredentials(taskId);
  const httpTransactions = src.listHttpTransactions
    ? src.listHttpTransactions(taskId, 200)
    : [];
  const nowMs = Date.now();

  const factById = new Map(allFacts.map((f) => [f.id, f]));
  const intentById = new Map(allIntents.map((i) => [i.id, i]));
  const factShortNo = new Map(allFacts.map((f, idx) => [f.id, `F${idx + 1}`]));
  const intentShortNo = new Map(allIntents.map((i, idx) => [i.id, `I${idx + 1}`]));
  const allFindingsByCreation = [...src.listFindings(taskId)].sort(
    (a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id),
  );
  const findingShortNo = new Map(allFindingsByCreation.map((f, idx) => [f.id, `V${idx + 1}`]));
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

  // Deterministic scope-brief debt tracker: surface commissioned targets (`challenge:<code>`)
  // that stalled/failed once and have 0 open/succeeded Intents so context compaction never drops them.
  const briefCodes = new Map<string, string>();
  for (const f of allFacts) {
    if (!f.tags.includes("scope-brief")) continue;
    const chTag = f.tags.find((t) => t.startsWith("challenge:"));
    const code = chTag ? chTag.slice("challenge:".length).trim() : "";
    if (code && !briefCodes.has(code)) {
      briefCodes.set(code, f.id);
    }
  }
  if (briefCodes.size > 0 && allIntents.length >= 3) {
    const shallowBriefs: string[] = [];
    for (const [code, briefId] of briefCodes) {
      const codeToken = code.toLowerCase();
      const matchingIntents = allIntents.filter((i) => {
        const hay = `${i.title} ${i.conclusion ?? ""}`.toLowerCase();
        return hay.includes(codeToken) || i.sourceFactIds.includes(briefId);
      });
      if (matchingIntents.length === 0) continue;
      const hasOpen = matchingIntents.some((i) => ["proposed", "claimed", "running"].includes(i.status));
      const hasSucceeded = matchingIntents.some((i) => i.status === "succeeded");
      const failedCount = matchingIntents.filter((i) => i.status === "failed" || i.status === "expired").length;
      if (!hasOpen && !hasSucceeded && failedCount >= 1 && failedCount <= 2) {
        shallowBriefs.push(`${code}（失败 ${failedCount} 次，0 成功 ←brief ${briefId}）`);
      }
    }
    if (shallowBriefs.length > 0) {
      lines.push("", `## 委托范围受挫待回补项（${shallowBriefs.length} · 防首探未果静默遗忘）`);
      for (const item of shallowBriefs.slice(0, 12)) {
        lines.push(`- ${item}`);
      }
      lines.push("（首探失败 ≠ 已验证穷尽；空闲槽位优先换正交 technique 回补上述目标，禁止仅凭压缩记忆臆断已完成。）");
    }
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
      const summaryLimit = f.tags.includes("scope-brief") ? 600 : 160;
      const fNo = factShortNo.get(f.id);
      lines.push(
        `- ${fNo ? `[${fNo}] ` : ""}[${f.id}] ${f.title}${f.summary ? `: ${f.summary.slice(0, summaryLimit)}` : ""}`,
      );
    }
  }
  lines.push("", `## Findings 台账（${findings.length}）`);
  if (findings.length === 0) {
    lines.push("- （无；发现线索即 finding_record，复现后 finding_verify 才可进交付）");
  } else {
    for (const f of findings.slice(-30)) {
      const vNo = findingShortNo.get(f.id);
      lines.push(
        `- ${vNo ? `[${vNo}] ` : ""}[${f.id}] (${f.status}/${f.severity}) ${f.title} · ${f.asset}${f.endpoint ? ` · ${f.endpoint}` : ""} · ${f.vulnClass}`,
      );
    }
    lines.push("（tentative 不得写进交付叙述；verified 须附证据与 repro；工具调用可直接传短号如 V1 或完整 UUID。）");
  }
  lines.push(
    "",
    foldedTitleCount > 0
      ? `## 事实标题（title 层 · 显示 ${titles.length}/${allTitleFacts.length}，已折叠冷历史 ${foldedTitleCount} 条）`
      : "## 事实标题（title 层）",
  );
  for (const f of titles) {
    const iNo = f.intentId ? intentShortNo.get(f.intentId) : undefined;
    const intent = f.intentId ? ` ←intent ${iNo ? `${iNo}/` : ""}${f.intentId}` : "";
    const hotPin = !recentTitleSet.has(f.id) ? " [热祖先]" : "";
    const fNo = factShortNo.get(f.id);
    lines.push(`- ${fNo ? `[${fNo}] ` : ""}[${f.id}]${hotPin} ${f.title}${intent}`);
  }
  lines.push("", `## 进行中意图（${open.length}）`);
  if (open.length === 0) {
    lines.push("- （无）");
  } else {
    for (const i of open.slice(0, MAX_OPEN_INTENTS)) {
      const srcIds = i.sourceFactIds.map((fid) => factShortNo.get(fid) ?? fid).join(",");
      const surfaces = i.assignedSurfaces?.length
        ? ` · surfaces=${i.assignedSurfaces.join(",")}`
        : "";
      const mutex = i.mutexNote ? ` · mutex=${i.mutexNote.slice(0, 120)}` : "";
      const pulse = renderIntentPulse(i, allFacts, httpTransactions, nowMs);
      const iNo = intentShortNo.get(i.id);
      lines.push(
        `- ${iNo ? `[${iNo}] ` : ""}[${i.id}] (${i.status}) ${i.title} ←facts ${srcIds}${surfaces}${mutex}${pulse ? ` · ${pulse}` : ""}`,
      );
    }
    if (open.length > MAX_OPEN_INTENTS) {
      lines.push(`- … 另有 ${open.length - MAX_OPEN_INTENTS} 条进行中意图未展开。`);
    }
    if (open.some((i) => ACTIVE_INTENT_STATUSES.has(i.status))) {
      lines.push(
        "（claimed/running 意图附运行脉搏：已运行时长、claimed_by、最近 HTTP 状态码统计或最新 Fact 标题；所有事实/意图/漏洞工具均支持短编号如 F1 / I1 / V1。）",
      );
    }
  }
  const concluded = allIntents
    .filter((i) => i.status === "succeeded" || i.status === "failed" || i.status === "expired")
    .sort((a, b) => (b.concludedAt ?? b.updatedAt).localeCompare(a.concludedAt ?? a.updatedAt))
    .slice(0, 12);
  lines.push("", "## 近期已结项意图（最近 12 条 · 供拆单与二探继承客观增量）");
  if (concluded.length === 0) {
    lines.push("- （无）");
  } else {
    for (const i of concluded) {
      const technique = i.technique ?? "—";
      const root = i.assetRoot ?? "—";
      const conclusion = (i.conclusion ?? "").slice(0, 240);
      const iNo = intentShortNo.get(i.id);
      lines.push(`- ${iNo ? `[${iNo}] ` : ""}[${i.id}] (${i.status} / ${technique} @${root}) ${i.title} — ${conclusion}`);
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
  if (credentials.length) {
    lines.push("", `## 凭据台账（${credentials.length} · 供跨主机与内网横向喷洒复用）`);
    for (const cred of credentials.slice(-20)) {
      const verifiedTag = cred.verifiedAt ? "verified" : "unverified";
      lines.push(
        `- [${cred.id}] (${cred.tier ?? "L1"}/${verifiedTag}) ${cred.kind} @${cred.asset} · user=${cred.username || "—"} · reuse=${cred.reuseCount} · ref=${cred.secretRef}`,
      );
    }
    lines.push("（内网横向或遇到新登录面时优先交叉复用已捕获凭据，盲爆字典前必先验证同源员工/管理员口令复用。）");
  }
  const activeTunnels = src.listActiveTunnels?.() ?? [];
  if (activeTunnels.length) {
    lines.push("", `## 活跃本地转发隧道（${activeTunnels.length} · 全进程共享）`);
    for (const tunnel of activeTunnels.slice(0, 20)) {
      const target =
        tunnel.targetPort == null
          ? tunnel.targetHost || "—"
          : `${tunnel.targetHost}:${tunnel.targetPort}`;
      lines.push(
        `- [${tunnel.id}] (${tunnel.kind}) 127.0.0.1:${tunnel.localPort} → ${target}${tunnel.via ? ` via ${tunnel.via}` : ""}`,
      );
    }
    lines.push(
      "（所有槽位直接复用上述 127.0.0.1:<localPort>，无需重复 tunnel_open；失效先 tunnel_list 复核。）",
    );
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

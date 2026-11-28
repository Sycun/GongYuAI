/**
 * P15 — 观察员（确定性审计）
 *
 * 上游对照：BreachWeave 的 Manager / Solver / Observer 三角色、AutoRedTeam
 * Orchestrator 的「确认率 + gaps」记分卡与重复执行上限、pentestcode 的 critic。
 * 本仓的取舍：观察员先做成**纯函数 + 只读投影**，不花模型 token、不派 Intent、
 * 不改 Goal / scope / capability。它只回答四个问题：
 *
 * 1. 有没有在同一手法上重复失败（女娲·自愈：换面而不是磨穿）；
 * 2. 有没有重复派单或长期挂起的 Intent（Super-agent·经济：别重复劳动）；
 * 3. 有没有未验证线索积压（DAG·真相：tentative 不进交付）；
 * 4. 有没有高权重资产从未被经营（Super-agent·经济：把力气花在刀刃上）。
 *
 * 「观察员说」是建议层：它能被忽略，但忽略要有理由。真正的授权、状态推进和
 * 证据闸仍在 History / gateTool / assert_goal 里。
 */

export type EngagementAuditAsset = {
  address: string;
  kind: string;
  weight: number;
  assetType?: string | null;
};

export type EngagementAuditIntent = {
  id: string;
  title: string;
  technique: string | null;
  assetRoot: string | null;
  status: string;
  createdAt: string;
  updatedAt: string;
  concludedAt: string | null;
};

export type EngagementAuditFinding = {
  id: string;
  asset: string;
  endpoint?: string | null;
  vulnClass: string;
  status: string;
  severity: string;
  createdAt: string;
  verifiedAt?: string | null;
  evidence?: ReadonlyArray<{ path: string; role?: string }>;
  /** P15-C1 — latest independent validation is confirmed. */
  independentConfirmed?: boolean;
};

export type EngagementAuditCredential = {
  id: string;
  asset: string;
  kind: string;
  reuseCount: number;
  verifiedAt: string | null;
  /** Absent on older projections; only an explicit L1 triggers the hint. */
  tier?: "L1" | "L2" | "L3";
};

/** P18 — one credential-verification matrix cell already probed by a worker. */
export type EngagementAuditCredentialCheck = {
  credentialId: string;
  targetAsset: string;
  verdict: "valid" | "invalid" | "error";
};

export type EngagementAuditInput = {
  now: string;
  assets: ReadonlyArray<EngagementAuditAsset>;
  intents: ReadonlyArray<EngagementAuditIntent>;
  findings: ReadonlyArray<EngagementAuditFinding>;
  credentials?: ReadonlyArray<EngagementAuditCredential>;
  /** Conclusive probes (valid/invalid) drop their (credential, live host) cell. */
  credentialChecks?: ReadonlyArray<EngagementAuditCredentialCheck>;
};

export type EngagementAuditObservationCode =
  | "repeat-failure"
  | "duplicate-open"
  | "stalled-intent"
  | "tentative-backlog"
  | "unexplored-asset"
  | "shallow-failure"
  | "idle-credential"
  | "l1-unverified";

export type EngagementAuditObservation = {
  code: EngagementAuditObservationCode;
  /** Stable key inside one code (asset/technique/intent id) for UI / tests. */
  key: string;
  severity: "info" | "warn";
  /** Action-oriented Chinese sentence; suggestions only. */
  text: string;
  /** Intent / finding / credential / asset ids that support the observation. */
  refs: string[];
};

export type EngagementAuditScorecard = {
  assets: {
    total: number;
    testable: number;
    highWeight: number;
    untouched: number;
  };
  intents: {
    total: number;
    open: number;
    failed: number;
    succeeded: number;
  };
  findings: {
    total: number;
    confirmed: number;
    /** P15-C1 — confirmed findings that also have an independent confirmation. */
    independentlyConfirmed: number;
    tentative: number;
    contradicted: number;
    /** confirmed / total; null when there is no finding yet. */
    confirmationRate: number | null;
    /** independentlyConfirmed / total; null when there is no finding yet. */
    independentRate: number | null;
    /** Delivery gaps — an empty ledger is not a clean target. */
    gaps: string[];
  };
  credentials: {
    total: number;
    verified: number;
    /**
     * P18 — remaining untested spray matrix: every (credential, live host) pair
     * except the credential's own host and pairs already probed (valid/invalid).
     */
    sprayBacklog: number;
  };
};

export type EngagementAudit = {
  observations: EngagementAuditObservation[];
  scorecard: EngagementAuditScorecard;
};

export const ENGAGEMENT_AUDIT_DEFAULTS = {
  /** Same technique + asset root, trailing failures before advising a pivot. */
  repeatFailureThreshold: 3,
  /** Same technique + asset root open Intents before advising a merge. */
  duplicateOpenThreshold: 2,
  /** tentative findings before advising verification. */
  tentativeBacklogThreshold: 3,
  /** A claimed/running Intent with no update this long is stalled. */
  stalledClaimedAgeMs: 45 * 60_000,
  /** A proposed Intent may wait for an Explore slot this long. */
  stalledProposedAgeMs: 120 * 60_000,
  /** Business weight (0-5) at/above which an untouched asset is worth naming. */
  highWeight: 3,
  /** Bound on returned observations (Observe injects a shorter slice). */
  maxObservations: 8,
} as const;

const TESTABLE_KINDS = new Set(["seed", "admitted", "live"]);
const HOST_LEVEL_TYPES = new Set(["domain", "ip"]);
const OPEN_STATUS = new Set(["proposed", "claimed", "running"]);
const CONFIRMED_STATUS = new Set(["verified", "retested", "accepted"]);

const CODE_RANK: Record<EngagementAuditObservationCode, number> = {
  "repeat-failure": 0,
  "duplicate-open": 1,
  "stalled-intent": 2,
  "tentative-backlog": 3,
  "unexplored-asset": 4,
  "shallow-failure": 5,
  "idle-credential": 6,
  "l1-unverified": 7,
};

const norm = (value: string | null | undefined): string =>
  (value ?? "").trim().toLowerCase();

const parseMs = (iso: string): number => {
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : Number.NaN;
};

const ageMs = (nowMs: number, iso: string): number => {
  const t = parseMs(iso);
  if (!Number.isFinite(t)) return 0;
  return Math.max(0, nowMs - t);
};

const minutes = (ms: number): number => Math.max(1, Math.round(ms / 60_000));

const intentKey = (intent: EngagementAuditIntent): string | null => {
  const technique = norm(intent.technique);
  const root = norm(intent.assetRoot);
  if (!technique || !root) return null;
  return `${technique}::${root}`;
};

const isHostLevel = (asset: EngagementAuditAsset): boolean =>
  asset.assetType == null ||
  asset.assetType === "" ||
  HOST_LEVEL_TYPES.has(norm(asset.assetType));

/**
 * Pure derivation. Deterministic ordering: severity, code, key.
 * No clock reads — callers pass `now` so fixtures and reports are reproducible.
 */
export function deriveEngagementAudit(
  input: EngagementAuditInput,
): EngagementAudit {
  const nowMs = parseMs(input.now);
  const now = Number.isFinite(nowMs) ? nowMs : Date.now();
  const assets = input.assets;
  const intents = input.intents;
  const findings = input.findings;
  const credentials = input.credentials ?? [];
  const credentialChecks = input.credentialChecks ?? [];

  // ---- 0. P18 credential spray matrix: conclusive probes retire their cell ----
  // `error` stays on the backlog: the login surface was never actually reached.
  const resolvedCells = new Set(
    credentialChecks
      .filter((check) => check.verdict === "valid" || check.verdict === "invalid")
      .map((check) => `${check.credentialId}::${norm(check.targetAsset)}`),
  );
  const liveHosts = [
    ...new Set(
      assets.filter((asset) => norm(asset.kind) === "live").map((asset) => norm(asset.address)),
    ),
  ].filter(Boolean);
  const sprayBacklogCells: Array<{ credentialId: string; asset: string }> = [];
  for (const credential of credentials) {
    const own = norm(credential.asset);
    for (const host of liveHosts) {
      if (host === own) continue;
      if (resolvedCells.has(`${credential.id}::${host}`)) continue;
      sprayBacklogCells.push({ credentialId: credential.id, asset: host });
    }
  }

  const observations: EngagementAuditObservation[] = [];

  // ---- 1. Same technique + asset root: trailing failures / duplicate open ----
  const byKey = new Map<string, EngagementAuditIntent[]>();
  for (const intent of intents) {
    const key = intentKey(intent);
    if (!key) continue;
    const list = byKey.get(key) ?? [];
    list.push(intent);
    byKey.set(key, list);
  }

  for (const [key, list] of byKey) {
    const ordered = [...list].sort(
      (a, b) => (parseMs(a.createdAt) || 0) - (parseMs(b.createdAt) || 0),
    );
    let trailingFailed = 0;
    for (let i = ordered.length - 1; i >= 0; i -= 1) {
      if (ordered[i]!.status !== "failed") break;
      trailingFailed += 1;
    }
    if (trailingFailed >= ENGAGEMENT_AUDIT_DEFAULTS.repeatFailureThreshold) {
      const technique = ordered[ordered.length - 1]!.technique ?? "unknown";
      const root = ordered[ordered.length - 1]!.assetRoot ?? "unknown";
      const recent = ordered.slice(-trailingFailed);
      observations.push({
        code: "repeat-failure",
        key,
        severity: "warn",
        text:
          `同一手法 ${technique} 在 ${root} 已连续失败 ${trailingFailed} 次；` +
          `换手法或换面（先写否定证据再 intent_conclude(failed)），不要重复同一条路径。`,
        refs: recent.map((intent) => intent.id).slice(-5),
      });
    }

    const open = ordered.filter((intent) => OPEN_STATUS.has(intent.status));
    if (open.length >= ENGAGEMENT_AUDIT_DEFAULTS.duplicateOpenThreshold) {
      const technique = open[0]!.technique ?? "unknown";
      const root = open[0]!.assetRoot ?? "unknown";
      observations.push({
        code: "duplicate-open",
        key,
        severity: "warn",
        text:
          `同一手法 ${technique} 在 ${root} 有 ${open.length} 个 open Intent；` +
          `合并或关闭重复项，避免两个 Explore 做同一件事。`,
        refs: open.map((intent) => intent.id),
      });
    }
  }

  // ---- 2. Stalled open Intents ----
  for (const intent of intents) {
    if (!OPEN_STATUS.has(intent.status)) continue;
    const limit =
      intent.status === "proposed"
        ? ENGAGEMENT_AUDIT_DEFAULTS.stalledProposedAgeMs
        : ENGAGEMENT_AUDIT_DEFAULTS.stalledClaimedAgeMs;
    const idle = ageMs(now, intent.updatedAt);
    if (idle < limit) continue;
    observations.push({
      code: "stalled-intent",
      key: intent.id,
      severity: "warn",
      text:
        `Intent ${intent.id}（${intent.status}）已 ${minutes(idle)} 分钟无更新；` +
        `先 intent_conclude(failed/expired) 留否定证据，或换面，不要让槽位空转。`,
      refs: [intent.id],
    });
  }

  // ---- 3. Tentative backlog ----
  const tentative = findings.filter((finding) => finding.status === "tentative");
  if (tentative.length >= ENGAGEMENT_AUDIT_DEFAULTS.tentativeBacklogThreshold) {
    const oldest = tentative.reduce(
      (min, finding) => {
        const t = parseMs(finding.createdAt);
        return Number.isFinite(t) && t < min ? t : min;
      },
      Number.POSITIVE_INFINITY,
    );
    observations.push({
      code: "tentative-backlog",
      key: "tentative",
      severity: "warn",
      text:
        `${tentative.length} 条 tentative 线索待验证` +
        `${Number.isFinite(oldest) ? `（最早 ${minutes(now - oldest)} 分钟前）` : ""}；` +
        `先 finding_verify（证据 + repro）或 finding_retract，再开新面。`,
      refs: tentative.map((finding) => finding.id).slice(0, 8),
    });
  }

  // ---- 4. Untouched host-level assets ----
  const testableAssets = assets.filter((asset) =>
    TESTABLE_KINDS.has(norm(asset.kind)),
  );
  const touched = new Set<string>();
  for (const intent of intents) {
    if (intent.assetRoot) touched.add(norm(intent.assetRoot));
  }
  for (const finding of findings) touched.add(norm(finding.asset));
  for (const credential of credentials) touched.add(norm(credential.asset));

  const untouched = testableAssets
    .filter((asset) => isHostLevel(asset))
    .filter((asset) => !touched.has(norm(asset.address)))
    .sort((a, b) => b.weight - a.weight || a.address.localeCompare(b.address));
  if (untouched.length > 0 && intents.length > 0) {
    const highWeight = untouched.filter(
      (asset) => asset.weight >= ENGAGEMENT_AUDIT_DEFAULTS.highWeight,
    );
    const starvedWhileGrinding = intents.length >= testableAssets.length;
    observations.push({
      code: "unexplored-asset",
      key: "untouched",
      severity: highWeight.length > 0 || starvedWhileGrinding ? "warn" : "info",
      text:
        `${untouched.length} 个在范围主机从未被经营（0 Intent）` +
        `${highWeight.length ? `（高权重 ${highWeight.length}）` : ""}` +
        `${starvedWhileGrinding ? "（已有资产被重复探索而该目标零派单）" : ""}：` +
        `${untouched.slice(0, 5).map((asset) => asset.address).join("、")}` +
        `；优先为未触达目标 intent_propose，勿只磨已测资产。`,
      refs: untouched.slice(0, 8).map((asset) => asset.address),
    });
  }

  // ---- 4b. Shallow-failed surfaces (1 failed attempt, 0 succeeded/open/confirmed, abandoned while grinding elsewhere) ----
  const confirmedAssetRoots = new Set(
    findings
      .filter((finding) => CONFIRMED_STATUS.has(finding.status))
      .map((finding) => norm(finding.asset)),
  );
  const byRoot = new Map<string, EngagementAuditIntent[]>();
  for (const intent of intents) {
    const root = norm(intent.assetRoot);
    if (!root) continue;
    const list = byRoot.get(root) ?? [];
    list.push(intent);
    byRoot.set(root, list);
  }
  const shallowFailedRoots: string[] = [];
  const shallowFailedIntentIds: string[] = [];
  for (const [root, list] of byRoot) {
    if (confirmedAssetRoots.has(root)) continue;
    const hasOpen = list.some((i) => OPEN_STATUS.has(i.status));
    const hasSucceeded = list.some((i) => i.status === "succeeded");
    const failedList = list.filter((i) => i.status === "failed" || i.status === "expired");
    if (!hasOpen && !hasSucceeded && failedList.length === 1 && list.length === 1) {
      shallowFailedRoots.push(root);
      shallowFailedIntentIds.push(failedList[0]!.id);
    }
  }
  if (shallowFailedRoots.length > 0 && intents.length >= 3) {
    shallowFailedRoots.sort((a, b) => a.localeCompare(b));
    observations.push({
      code: "shallow-failure",
      key: "shallow",
      severity: "warn",
      text:
        `${shallowFailedRoots.length} 个攻击面仅首探受挫 1 次且零确认战果即被搁置：${shallowFailedRoots.slice(0, 5).join("、")}；` +
        `首探时间盒仅覆盖浅层假设，优先换正交 technique 二探回补，严禁将单次未果视为已穷尽。`,
      refs: shallowFailedIntentIds.slice(0, 8),
    });
  }

  // ---- 5. Idle verified credentials ----
  const idleCredentials = credentials.filter(
    (credential) => credential.reuseCount === 0 && credential.verifiedAt,
  );
  if (idleCredentials.length > 0 && testableAssets.length > 1) {
    observations.push({
      code: "idle-credential",
      key: "reuse",
      severity: "info",
      text:
        `${idleCredentials.length} 条已验证凭据尚未复用；` +
        `横向前先 credential_list 核对适用范围，复用要留 attempt 证据。`,
      refs: idleCredentials.map((credential) => credential.id).slice(0, 8),
    });
  }

  // L1 and still unverified: a light hint. Does not replace idle-credential.
  const unverifiedL1 = credentials.filter(
    (credential) => credential.tier === "L1" && !credential.verifiedAt,
  );
  if (unverifiedL1.length > 0) {
    observations.push({
      code: "l1-unverified",
      key: "l1",
      severity: "info",
      text:
        `${unverifiedL1.length} 条凭据仍是 L1 且未验证；` +
        `由凭据所有者或其明确授权的人员提供认证证据后记为 L2，影响范围确认后记为 L3。`,
      refs: unverifiedL1.map((credential) => credential.id).slice(0, 8),
    });
  }

  observations.sort(
    (a, b) =>
      (a.severity === b.severity ? 0 : a.severity === "warn" ? -1 : 1) ||
      CODE_RANK[a.code] - CODE_RANK[b.code] ||
      a.key.localeCompare(b.key),
  );

  // ---- Scorecard ----
  const confirmedFindings = findings.filter((finding) =>
    CONFIRMED_STATUS.has(finding.status),
  );
  const contradicted = findings.filter(
    (finding) => finding.status === "retracted",
  );
  const openIntents = intents.filter((intent) => OPEN_STATUS.has(intent.status));
  const failedIntents = intents.filter((intent) => intent.status === "failed");
  const succeededIntents = intents.filter(
    (intent) => intent.status === "succeeded",
  );
  const highWeightAssets = testableAssets.filter(
    (asset) => asset.weight >= ENGAGEMENT_AUDIT_DEFAULTS.highWeight,
  );
  const untouchedCount = testableAssets
    .filter((asset) => isHostLevel(asset))
    .filter((asset) => !touched.has(norm(asset.address))).length;

  const independentlyConfirmedFindings = confirmedFindings.filter(
    (finding) => finding.independentConfirmed === true,
  );
  const totalFindings = findings.length;
  const gaps: string[] = [];
  if (testableAssets.length === 0) gaps.push("资产清单为空");
  if (untouchedCount > 0) gaps.push(`${untouchedCount} 个在范围主机未测`);
  if (totalFindings === 0) {
    gaps.push("空台账不等于干净目标：未登记任何 finding");
  } else {
    if (confirmedFindings.length === 0) gaps.push("尚未确认任何 finding");
    const unvalidated = confirmedFindings.length - independentlyConfirmedFindings.length;
    if (unvalidated > 0) gaps.push(`${unvalidated} 条已验证发现缺独立确认`);
    if (tentative.length > 0) gaps.push(`${tentative.length} 条 tentative 待确认`);
    if (contradicted.length > 0) {
      gaps.push(`${contradicted.length} 条已撤回（误报留痕）`);
    }
  }

  return {
    observations: observations.slice(
      0,
      ENGAGEMENT_AUDIT_DEFAULTS.maxObservations,
    ),
    scorecard: {
      assets: {
        total: assets.length,
        testable: testableAssets.length,
        highWeight: highWeightAssets.length,
        untouched: untouchedCount,
      },
      intents: {
        total: intents.length,
        open: openIntents.length,
        failed: failedIntents.length,
        succeeded: succeededIntents.length,
      },
      findings: {
        total: totalFindings,
        confirmed: confirmedFindings.length,
        independentlyConfirmed: independentlyConfirmedFindings.length,
        tentative: tentative.length,
        contradicted: contradicted.length,
        confirmationRate:
          totalFindings > 0
            ? Math.round((confirmedFindings.length / totalFindings) * 1000) / 1000
            : null,
        independentRate:
          totalFindings > 0
            ? Math.round((independentlyConfirmedFindings.length / totalFindings) * 1000) / 1000
            : null,
        gaps,
      },
      credentials: {
        total: credentials.length,
        verified: credentials.filter((credential) => Boolean(credential.verifiedAt)).length,
        sprayBacklog: sprayBacklogCells.length,
      },
    },
  };
}

/** One-line Observe / prompt rendering; keeps the audit visible without the full JSON. */
export function formatEngagementAuditSummary(audit: EngagementAudit): string {
  const { scorecard } = audit;
  const rate =
    scorecard.findings.confirmationRate == null
      ? "—"
      : `${Math.round(scorecard.findings.confirmationRate * 100)}%`;
  const lines = [
    `资产 ${scorecard.assets.total}（可测 ${scorecard.assets.testable} / 高权重 ${scorecard.assets.highWeight} / 未触碰 ${scorecard.assets.untouched}）` +
      ` · Intent ${scorecard.intents.total}（open ${scorecard.intents.open} / failed ${scorecard.intents.failed} / succeeded ${scorecard.intents.succeeded}）` +
      ` · Finding ${scorecard.findings.total}（确认 ${scorecard.findings.confirmed} / 独立 ${scorecard.findings.independentlyConfirmed} / 待验 ${scorecard.findings.tentative} / 撤回 ${scorecard.findings.contradicted}，确认率 ${rate}）` +
      ` · 凭据 ${scorecard.credentials.total}（已验证 ${scorecard.credentials.verified} / 待测矩阵 ${scorecard.credentials.sprayBacklog}）`,
  ];
  if (scorecard.findings.gaps.length) {
    lines.push(`缺口：${scorecard.findings.gaps.join("；")}`);
  }
  return lines.join("\n");
}

/**
 * Deterministic symbolic causal-edge verifier (DAG discipline, Lane D).
 *
 * 红线：本文件是 **100% 确定性纯函数规则**，不调用任何 LLM、不读时钟、不做 I/O、
 * 不访问数据库。同样的输入永远得到同样的判定与同样的证明/弃证理由。
 *
 * 一条因果边（前驱 → 后继）要标 `proven`，必须同时满足：
 * 1. 时序单调：前驱 `createdAt` ≤ 后继 `createdAt`（同一毫秒允许，append-only 记录
 *    的写入顺序本身就是因果方向）；
 * 2. 对象/指纹可传递：后继显式引用前驱 id（`sourceFactIds` / `factIds` /
 *    `intentId`），或两者在 **资产地址 / 端点路径 / 凭据 id / 证据 SHA-256 /
 *    `http:<id>` 事务 / 证据文件路径** 上有真实交集。
 *
 * 不满足就不许标 proven：`verification: "proposed"` + 确定性 `abstentionReason`。
 * 宁可诚实弃证（proposed），也不编造因果。
 */
import type { GraphEdge, DagEdgeVerification } from "@gongyuai/contracts";
import { normalizeHost } from "@gongyuai/contracts";

/** 四类受检因果边（与计划书一致）。 */
export type CausalEdgeKind =
  | "fact->intent"
  | "intent->fact"
  | "fact->finding"
  | "intent->finding"
  | "finding->finding";

/** 可参与「指纹传递」的对象类型。 */
export type CausalArtifactKind =
  | "asset"
  | "endpoint"
  | "credential"
  | "sha256"
  | "traffic"
  | "evidence";

export type CausalArtifact = {
  readonly kind: CausalArtifactKind;
  readonly value: string;
};

/** 弃证理由：确定性、可读、可直接进 `GraphEdge.abstentionReason`。 */
export type AbstentionReason =
  | "missing_shared_artifact"
  | "timestamp_inversion"
  | "ungrounded_reference"
  | "missing_timestamp";

/**
 * 因果边一端的最小投影。
 * - `references`：该对象显式引用的前驱 id（Intent.sourceFactIds / Finding.factIds /
 *   Finding.intentId / Fact.intentId 等）；
 * - `artifacts`：该对象自身携带的资产、端点、凭据、指纹、事务等对象标识。
 */
export type CausalNodeRef = {
  readonly id: string;
  readonly createdAt: string;
  readonly references?: readonly string[];
  readonly artifacts?: readonly CausalArtifact[];
};

export type CausalProof = {
  /** 证明规则：显式引用优先于对象交集；null = 未证明。 */
  readonly rule: "reference" | "shared-artifact" | null;
  readonly referenced: boolean;
  /** 排序去重后的共享指纹（`kind:value`），空数组表示无交集。 */
  readonly sharedArtifacts: readonly string[];
};

export type CausalEdgeVerdict = {
  readonly verification: DagEdgeVerification;
  readonly abstentionReason: AbstentionReason | null;
  readonly proof: CausalProof;
};

const SHA256 = /^[0-9a-f]{64}$/;

/**
 * 资产身份：URL 归约到主机，其余保留（CIDR / 通配符不与具体主机混同）。
 * 不用 `normalizeTargetPattern`，避免把 `10.0.0.0/24` 与 `10.0.0.0` 当成同一对象。
 */
export function normalizeAssetValue(raw: string): string {
  const value = raw.trim().toLowerCase();
  if (!value) return "";
  if (value.includes("://")) return normalizeHost(value);
  return value.replace(/\/+$/, "");
}

/** 端点身份：绝对 URL 只留 path+query；裸路径原样保留（大小写敏感）。 */
export function normalizeEndpointValue(raw: string): string {
  const value = raw.trim();
  if (!value) return "";
  if (!value.includes("://")) return value.replace(/\/+$/, "") || "/";
  try {
    const url = new URL(value);
    const path = `${url.pathname}${url.search}`;
    return path.replace(/\/+$/, "") || "/";
  } catch {
    return value;
  }
}

/** 证据文件身份：统一分隔符、去掉 `./`，路径大小写保持（文件系统语义）。 */
export function normalizeEvidencePath(raw: string): string {
  let value = raw.trim().replace(/\\/g, "/");
  while (value.startsWith("./")) value = value.slice(2);
  return value;
}

/** `http:<id>` / 裸事务 id 统一成 `traffic` 指纹。 */
export function normalizeTrafficValue(raw: string): string {
  const value = raw.trim().toLowerCase();
  return value.startsWith("http:") ? value.slice("http:".length) : value;
}

/** 构造一个规范化指纹；空值/非法值返回 null（不编造空指纹）。 */
export function artifact(kind: CausalArtifactKind, raw: string | null | undefined): CausalArtifact | null {
  if (raw === null || raw === undefined) return null;
  let value = raw.trim();
  if (!value) return null;
  switch (kind) {
    case "asset":
      value = normalizeAssetValue(value);
      break;
    case "endpoint":
      value = normalizeEndpointValue(value);
      break;
    case "credential":
      value = value.toLowerCase();
      break;
    case "sha256":
      value = value.toLowerCase();
      if (!SHA256.test(value)) return null;
      break;
    case "traffic":
      value = normalizeTrafficValue(value);
      break;
    case "evidence":
      value = normalizeEvidencePath(value);
      break;
  }
  if (!value) return null;
  return { kind, value };
}

/** 指纹键：`kind:value`，用于交集比较与证明输出。 */
export function artifactKey(entry: CausalArtifact): string {
  return `${entry.kind}:${entry.value}`;
}

/** 两个指纹集合的确定性交集：去重、按 `kind:value` 字典序。 */
export function sharedArtifacts(
  left: readonly CausalArtifact[],
  right: readonly CausalArtifact[],
): string[] {
  const rightKeys = new Set(right.map(artifactKey));
  const shared = new Set<string>();
  for (const entry of left) {
    const key = artifactKey(entry);
    if (rightKeys.has(key)) shared.add(key);
  }
  return [...shared].sort((a, b) => a.localeCompare(b));
}

/**
 * 从 Fact / 资产标签提取指纹。
 * 只认显式写入的标签，不猜：`asset.addr:`（URL 额外产 endpoint 指纹）、`credential.id:`。
 */
export function artifactsFromTags(tags: readonly string[]): CausalArtifact[] {
  const out: CausalArtifact[] = [];
  for (const tag of tags) {
    if (tag.startsWith("asset.addr:")) {
      const address = tag.slice("asset.addr:".length);
      const asset = artifact("asset", address);
      if (asset) out.push(asset);
      if (address.includes("://")) {
        const endpoint = artifact("endpoint", address);
        if (endpoint) out.push(endpoint);
      }
      continue;
    }
    if (tag.startsWith("credential.id:")) {
      const credential = artifact("credential", tag.slice("credential.id:".length));
      if (credential) out.push(credential);
    }
  }
  return out;
}

/**
 * 从证据引用提取指纹：`http:<id>` → traffic，`oast:<token>` → evidence（封存引用），
 * 其余按证据文件路径；带合法 SHA-256 时同时产 `sha256` 指纹。
 */
export function evidenceArtifacts(
  entries: readonly { path?: string | null; sha256?: string | null }[],
): CausalArtifact[] {
  const out: CausalArtifact[] = [];
  for (const entry of entries) {
    const path = entry.path?.trim();
    if (path) {
      const kind: CausalArtifactKind = path.startsWith("http:") ? "traffic" : "evidence";
      const ref = artifact(kind, path);
      if (ref) out.push(ref);
    }
    const sha = artifact("sha256", entry.sha256);
    if (sha) out.push(sha);
  }
  return out;
}

/** ISO 时间 → 毫秒；不可解析返回 null（不猜时间）。 */
export function parseIsoMs(value: string): number | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  const ms = Date.parse(trimmed);
  return Number.isFinite(ms) ? ms : null;
}

const PROVEN: (proof: CausalProof) => CausalEdgeVerdict = (proof) => ({
  verification: "proven",
  abstentionReason: null,
  proof,
});

const propose = (abstentionReason: AbstentionReason, proof: CausalProof): CausalEdgeVerdict => ({
  verification: "proposed",
  abstentionReason,
  proof,
});

const NO_PROOF: CausalProof = { rule: null, referenced: false, sharedArtifacts: [] };

/**
 * 校验一条因果边。纯函数：无时钟、无随机、无 I/O。
 *
 * 规则顺序（先命中先返回，保证确定性）：
 * 1. 端点缺失 / 自指 → `ungrounded_reference`
 * 2. 时间不可解析 → `missing_timestamp`
 * 3. 时间倒挂（前驱晚于后继） → `timestamp_inversion`
 * 4. 后继显式引用前驱 id → proven（rule=reference）
 * 5. 存在共享对象/指纹 → proven（rule=shared-artifact）
 * 6. 否则 → `missing_shared_artifact`
 *
 * 时间倒挂与引用/交集同时成立时，仍判 proposed：因果方向已经错了，不能靠引用洗白。
 */
export function verifyCausalEdge(input: {
  kind: CausalEdgeKind;
  from: CausalNodeRef | null;
  to: CausalNodeRef | null;
}): CausalEdgeVerdict {
  const { from, to } = input;
  if (!from || !to) return propose("ungrounded_reference", NO_PROOF);
  if (from.id === to.id) return propose("ungrounded_reference", NO_PROOF);

  const fromMs = parseIsoMs(from.createdAt);
  const toMs = parseIsoMs(to.createdAt);
  if (fromMs === null || toMs === null) return propose("missing_timestamp", NO_PROOF);

  const referenced = (to.references ?? []).includes(from.id);
  const shared = sharedArtifacts(from.artifacts ?? [], to.artifacts ?? []);
  const base: CausalProof = { rule: null, referenced, sharedArtifacts: shared };

  if (fromMs > toMs) return propose("timestamp_inversion", base);
  if (referenced) return PROVEN({ ...base, rule: "reference" });
  if (shared.length > 0) return PROVEN({ ...base, rule: "shared-artifact" });
  return propose("missing_shared_artifact", base);
}

/**
 * 把判定写回图谱边。
 * 只有 `ungrounded_reference` 会把边标 broken（端点/引用确实缺失）；
 * 时序与交集问题仍是「未证明」，不是「不存在」，所以 broken 保持原值。
 */
export function applyCausalVerdict(edge: GraphEdge, verdict: CausalEdgeVerdict): GraphEdge {
  return {
    ...edge,
    verification: verdict.verification,
    ...(verdict.abstentionReason ? { abstentionReason: verdict.abstentionReason } : {}),
    ...(verdict.abstentionReason === "ungrounded_reference" ? { broken: true } : {}),
  };
}

export type CausalEdgeSummary = {
  total: number;
  proven: number;
  proposed: number;
  byReason: Record<AbstentionReason, number>;
};

/** 图谱级确定性汇总（无时间戳、无顺序依赖）。 */
export function summarizeCausalEdges(edges: readonly GraphEdge[]): CausalEdgeSummary {
  const summary: CausalEdgeSummary = {
    total: 0,
    proven: 0,
    proposed: 0,
    byReason: {
      missing_shared_artifact: 0,
      timestamp_inversion: 0,
      ungrounded_reference: 0,
      missing_timestamp: 0,
    },
  };
  for (const edge of edges) {
    if (!edge.verification) continue;
    summary.total += 1;
    if (edge.verification === "proven") {
      summary.proven += 1;
      continue;
    }
    summary.proposed += 1;
    const reason = edge.abstentionReason as AbstentionReason | undefined;
    if (reason && reason in summary.byReason) summary.byReason[reason] += 1;
  }
  return summary;
}

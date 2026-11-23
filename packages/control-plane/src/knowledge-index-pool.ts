import type {
  KnowledgeEmbeddingProvider,
  KnowledgeEmbeddingServiceStatus,
  KnowledgeEmbeddingState,
  KnowledgeIndexStatus,
  KnowledgeVersionIndexState,
} from "@gongyuai/contracts";
import { EmbeddingClient, type EmbeddingRuntime } from "./knowledge-embed.js";
import { KnowledgeIndex, type IndexHost } from "./knowledge-index.js";

const PROVIDERS: KnowledgeEmbeddingProvider[] = ["local", "cloud"];

/** 资料版本归属哪套服务，由 KnowledgeStore 按资料范围与委托授权判定。 */
export type EmbeddingRoute = (versionId: string) => KnowledgeEmbeddingProvider;

export type IndexRuntimes = Record<KnowledgeEmbeddingProvider, EmbeddingRuntime>;

/**
 * 本地与云端两套索引。每份资料只由一套服务索引，归属由 route 决定：
 * 共享资料跟工作区选定的服务，委托专属资料默认本地。
 *
 * 查询同样按授权走：范围内未获授权的服务，既不发查询文本，也不取它的向量。
 */
export class KnowledgeIndexPool {
  readonly local: KnowledgeIndex;
  readonly cloud: KnowledgeIndex;

  constructor(
    host: IndexHost,
    runtimes: IndexRuntimes,
    chunkerVersion: number,
    private readonly route: EmbeddingRoute,
  ) {
    // 归属判定按当前配置实时计算：撤回委托云端授权或改选服务后，队列里尚未发送的批次立即改判。
    this.local = new KnowledgeIndex(host, new EmbeddingClient(runtimes.local), chunkerVersion,
      (versionId) => this.route(versionId) === "local");
    this.cloud = new KnowledgeIndex(host, new EmbeddingClient(runtimes.cloud), chunkerVersion,
      (versionId) => this.route(versionId) === "cloud");
  }

  index(provider: KnowledgeEmbeddingProvider): KnowledgeIndex {
    return provider === "cloud" ? this.cloud : this.local;
  }

  of(versionId: string): KnowledgeIndex {
    return this.index(this.route(versionId));
  }

  refresh(runtimes: IndexRuntimes): void {
    this.local.setClient(new EmbeddingClient(runtimes.local));
    this.cloud.setClient(new EmbeddingClient(runtimes.cloud));
  }

  private group(versionIds: string[]): Record<KnowledgeEmbeddingProvider, string[]> {
    const groups: Record<KnowledgeEmbeddingProvider, string[]> = { local: [], cloud: [] };
    for (const versionId of versionIds) groups[this.route(versionId)].push(versionId);
    return groups;
  }

  markPending(versionId: string, opts: { enqueue?: boolean } = {}): boolean {
    return this.of(versionId).markPending(versionId, opts);
  }

  versionState(versionId: string): KnowledgeVersionIndexState {
    return this.of(versionId).versionState(versionId);
  }

  rebuild(versionIds: string[]): void {
    const groups = this.group(versionIds);
    for (const provider of PROVIDERS) if (groups[provider].length) this.index(provider).rebuild(groups[provider]);
  }

  retry(versionIds: string[]): string[] {
    const groups = this.group(versionIds);
    return PROVIDERS.flatMap((provider) => this.index(provider).retry(groups[provider]));
  }

  vectorsFor(versionIds: string[], provider: KnowledgeEmbeddingProvider) {
    return this.index(provider).vectorsFor(versionIds.filter((id) => this.route(id) === provider));
  }

  queryVector(query: string, provider: KnowledgeEmbeddingProvider): Promise<Float32Array> {
    return this.index(provider).queryVector(query);
  }

  async idle(timeoutMs = 120_000): Promise<void> {
    await Promise.all(PROVIDERS.map((provider) => this.index(provider).idle(timeoutMs)));
  }

  /**
   * 范围内读数。selected 是工作区选定的服务；allowed 是本次读者范围获授权的服务集合。
   * 未获授权服务已建好的片段计入 blockedChunks，如实说明它们不参与本次语义召回。
   */
  status(versionIds: string[], opts: {
    selected: KnowledgeEmbeddingProvider; allowed: ReadonlySet<KnowledgeEmbeddingProvider>;
  }): KnowledgeIndexStatus {
    const groups = this.group(versionIds);
    const services: KnowledgeEmbeddingServiceStatus[] = [];
    for (const provider of PROVIDERS) {
      if (!groups[provider].length && provider !== opts.selected) continue;
      services.push(this.index(provider).serviceStatus(groups[provider], opts.allowed.has(provider)));
    }
    const primaryProvider = opts.allowed.has(opts.selected) ? opts.selected : "local";
    const primary = this.index(primaryProvider);
    const relevant = services.filter((service) => service.versions > 0);
    const states = relevant.map((service) => service.state);
    const state: KnowledgeEmbeddingState = !primary.enabled ? "disabled"
      : !states.length ? primary.serviceStatus([], opts.allowed.has(primaryProvider)).state
      : states.includes("indexing") ? "indexing"
      : states.includes("unavailable") ? "unavailable"
      : states.includes("error") ? "error"
      : states.includes("pending") ? "pending"
      : states.includes("unconfigured") ? "unconfigured"
      : states.includes("disabled") ? "disabled"
      : "ready";

    const totalChunks = services.reduce((sum, s) => sum + s.totalChunks, 0);
    const indexedChunks = services.reduce((sum, s) => sum + s.indexedChunks, 0);
    const failedChunks = services.reduce((sum, s) => sum + s.failedChunks, 0);
    const blockedChunks = services.filter((s) => !s.allowed).reduce((sum, s) => sum + s.indexedChunks, 0);
    const usable = PROVIDERS.filter((p) => opts.allowed.has(p)).map((p) => this.index(p));
    const semanticReady = usable.some((index) => index.semanticReady);
    const lastError = usable.map((index) => index.errorText).find(Boolean) ?? null;
    const lastIndexedAt = usable.map((index) => index.indexedAt).filter(Boolean).sort().at(-1) ?? null;

    return {
      state,
      model: primary.configured ? primary.runtime.model : null,
      modelDim: primary.configured ? primary.modelDim : null,
      provider: primary.configured ? primary.runtime.baseUrl : null,
      providerKind: primary.configured ? primaryProvider : null,
      chunkerVersion: primary.chunkerVersion,
      indexKey: primary.configured ? primary.indexKey : null,
      totalChunks,
      indexedChunks,
      pendingChunks: Math.max(0, totalChunks - indexedChunks - failedChunks),
      failedChunks,
      blockedChunks,
      services,
      degraded: !semanticReady,
      ...(semanticReady ? {} : { degradedReason: this.degradedReason(opts.allowed) }),
      ...(lastError ? { lastError } : {}),
      ...(lastIndexedAt ? { lastIndexedAt } : {}),
    };
  }

  degradedReason(allowed: ReadonlySet<KnowledgeEmbeddingProvider>): string {
    const usable = PROVIDERS.filter((p) => allowed.has(p)).map((p) => this.index(p));
    if (!usable.length) return "本次读者范围没有获授权的向量化服务，只用关键词";
    if (!usable.some((index) => index.enabled)) return "向量化已在设置中停用，本次检索只用关键词";
    const configured = usable.filter((index) => index.configured);
    if (!configured.length) return "未配置可用的 embedding 服务，本次检索只用关键词";
    return configured[0]!.degradedReason();
  }

  dispose(): void {
    for (const provider of PROVIDERS) this.index(provider).dispose();
  }
}
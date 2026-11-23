import type { DatabaseSync } from "node:sqlite";
import type {
  KnowledgeEmbeddingServiceStatus,
  KnowledgeEmbeddingState,
  KnowledgeSection,
  KnowledgeVersionIndexState,
} from "@gongyuai/contracts";
import {
  EmbeddingClient,
  EmbeddingDimMismatch,
  EmbeddingUnavailable,
  QueryVectorCache,
  decodeVector,
  encodeVector,
} from "./knowledge-embed.js";

export type IndexHost = {
  db: DatabaseSync;
  sectionsOf(versionId: string): KnowledgeSection[];
};

function sameRuntime(a: EmbeddingClient["runtime"], b: EmbeddingClient["runtime"]): boolean {
  return a.provider === b.provider && a.enabled === b.enabled && a.baseUrl === b.baseUrl
    && a.model === b.model && a.apiKey === b.apiKey && a.batchSize === b.batchSize
    && a.timeoutMs === b.timeoutMs;
}

type StateRow = {
  version_id: string;
  index_key: string;
  state: KnowledgeEmbeddingState;
  total: number;
  indexed: number;
  failed: number;
  last_error: string | null;
  updated_at: string;
};

/** 范围内的计数与待办分类，供上层聚合多服务读数。 */
export type IndexSummary = {
  totalChunks: number;
  indexedChunks: number;
  failedChunks: number;
  /** 有版本正在写入。 */
  indexing: boolean;
  /** 有版本登记待索引但没在队列里跑。 */
  pending: boolean;
  errored: boolean;
};

/** 向量化时带上标题路径，让片段在同义与跨语言召回里有章节语境。 */
function embeddingInput(section: KnowledgeSection): string {
  const prefix = section.headingPath.length ? `${section.headingPath.join(" > ")}\n` : "";
  return `${prefix}${section.text}`.slice(0, 6000);
}

const FAILURE_COOLDOWN_MS = 15_000;

/**
 * 一套服务的向量索引。与资料版本、原文范围完全解耦：
 * 重建索引只动 chunk_embeddings / chunk_index_state，不动版本行与内容 SHA-256，
 * 因此定版引用不受重切分、换模型、换服务商、重建的影响。
 */
export class KnowledgeIndex {
  private dim: number | null = null;
  private lastError: string | null = null;
  private lastIndexedAt: string | null = null;
  private cooldownUntil = 0;
  /** 换服务/换模型即递增；在途请求回来时用它判断自己是否已过期。 */
  private epoch = 0;
  private readonly queue: string[] = [];
  private running = false;
  private disposed = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private readonly waiters: Array<() => void> = [];
  readonly cache = new QueryVectorCache();

  constructor(
    private readonly host: IndexHost,
    private client: EmbeddingClient,
    readonly chunkerVersion: number,
    /** 该版本当前是否仍归本服务索引：出队与每批发送前都会重新判定（撤权/换选服务即失效）。 */
    private readonly owns: (versionId: string) => boolean = () => true,
    private readonly failureCooldownMs: number = FAILURE_COOLDOWN_MS,
  ) {
    this.host.db.exec(`
      CREATE TABLE IF NOT EXISTS chunk_embeddings (
        version_id TEXT NOT NULL,
        ordinal INTEGER NOT NULL,
        index_key TEXT NOT NULL,
        chunk_sha256 TEXT NOT NULL,
        dim INTEGER NOT NULL,
        vector BLOB NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (version_id, ordinal, index_key)
      );
      CREATE INDEX IF NOT EXISTS idx_chunk_embeddings_key ON chunk_embeddings(index_key, version_id);

      CREATE TABLE IF NOT EXISTS chunk_index_state (
        version_id TEXT PRIMARY KEY,
        index_key TEXT NOT NULL,
        state TEXT NOT NULL,
        total INTEGER NOT NULL DEFAULT 0,
        indexed INTEGER NOT NULL DEFAULT 0,
        failed INTEGER NOT NULL DEFAULT 0,
        last_error TEXT,
        updated_at TEXT NOT NULL
      );
    `);
  }

  private now(): string {
    return new Date().toISOString();
  }

  /**
   * 配置变化时更新客户端。语义完全一致（含密钥、批大小、超时）时**保持原对象不动**，
   * 页面轮询反复刷新配置也不会打断在途探测与查询。
   * 只有换服务地址/换模型/改启用状态才递增 epoch、清维度缓存：在途请求回来时用它判断自己是否已过期；
   * 仅改密钥等不影响索引身份的配置沿用 epoch 与已探测维度。
   */
  setClient(client: EmbeddingClient): void {
    if (sameRuntime(this.client.runtime, client.runtime)) return;
    const identityChanged = client.indexKey(this.chunkerVersion) !== this.client.indexKey(this.chunkerVersion)
      || client.runtime.enabled !== this.client.runtime.enabled;
    this.client = client;
    if (!identityChanged) return;
    this.epoch += 1;
    this.dim = null;
    this.lastError = null;
    this.cooldownUntil = 0;
    this.cache.clear();
  }

  get indexKey(): string {
    return this.client.indexKey(this.chunkerVersion);
  }

  get runtime(): EmbeddingClient["runtime"] {
    return this.client.runtime;
  }

  get modelDim(): number | null {
    return this.dim;
  }

  get errorText(): string | null {
    return this.lastError;
  }

  get indexedAt(): string | null {
    return this.lastIndexedAt;
  }

  get enabled(): boolean {
    return this.client.runtime.enabled;
  }

  get configured(): boolean {
    return this.client.configured;
  }

  /** 语义一路是否真的可用：已配置且已探测到维度。 */
  get semanticReady(): boolean {
    return this.configured && this.dim !== null;
  }

  private stateRow(versionId: string): StateRow | undefined {
    return this.host.db.prepare(`SELECT * FROM chunk_index_state WHERE version_id = ?`)
      .get(versionId) as StateRow | undefined;
  }

  private writeState(versionId: string, indexKey: string, state: KnowledgeEmbeddingState, total: number,
    indexed: number, failed: number, error: string | null): void {
    this.host.db.prepare(
      `INSERT INTO chunk_index_state (version_id, index_key, state, total, indexed, failed, last_error, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(version_id) DO UPDATE SET index_key = excluded.index_key, state = excluded.state,
         total = excluded.total, indexed = excluded.indexed, failed = excluded.failed,
         last_error = excluded.last_error, updated_at = excluded.updated_at`,
    ).run(versionId, indexKey, state, total, indexed, failed, error, this.now());
  }

  /** 只认本指纹、本维度的向量：维度未探测出来时一律算 0，不拿旧行数冒充就绪。 */
  private indexedCount(versionId: string, indexKey = this.indexKey, dim = this.dim): number {
    return Number((this.host.db.prepare(
      `SELECT COUNT(*) AS n FROM chunk_embeddings WHERE version_id = ? AND index_key = ? AND dim = ?`,
    ).get(versionId, indexKey, dim ?? -1) as { n: number }).n);
  }

  versionState(versionId: string): KnowledgeVersionIndexState {
    const row = this.stateRow(versionId);
    const total = this.host.sectionsOf(versionId).length;
    if (!this.configured) {
      return {
        versionId,
        state: this.client.runtime.enabled ? "unconfigured" : "disabled",
        totalChunks: total,
        indexedChunks: 0,
        failedChunks: 0,
        indexKey: null,
      };
    }
    const indexed = this.indexedCount(versionId);
    const stale = !row || row.index_key !== this.indexKey;
    // 登记 ready 但向量数不够（换服务后维度还没探测、写入被打断等）一律回到 pending，
    // 否则重试会认为无事可做，页面永远停在 0/N。
    const complete = total > 0 ? indexed >= total : Boolean(row && !stale && row.state === "ready");
    const queued = this.running || this.queue.includes(versionId);
    const state: KnowledgeEmbeddingState = complete ? "ready"
      : stale ? "pending"
      : row.state === "ready" ? "pending"
      : row.state === "indexing" && !queued ? "pending"
      : row.state;
    return {
      versionId,
      state,
      totalChunks: total,
      indexedChunks: indexed,
      failedChunks: stale || complete ? 0 : row.failed,
      indexKey: this.indexKey,
      ...(stale || complete ? {} : row.last_error ? { lastError: row.last_error } : {}),
      ...(stale ? {} : { updatedAt: row.updated_at }),
    };
  }

  /** 导入或重切分后登记待索引，并排入后台队列；导入本身不等待向量化。返回是否真的入队。 */
  markPending(versionId: string): boolean {
    const total = this.host.sectionsOf(versionId).length;
    if (!this.configured) {
      this.writeState(versionId, this.indexKey, this.client.runtime.enabled ? "unconfigured" : "disabled",
        total, 0, 0, null);
      return false;
    }
    const row = this.stateRow(versionId);
    if (row && row.index_key === this.indexKey && row.state === "ready" && this.indexedCount(versionId) >= total) {
      return false;
    }
    this.writeState(versionId, this.indexKey, "pending", total, this.indexedCount(versionId), 0, null);
    return this.enqueue(versionId);
  }

  enqueue(versionId: string): boolean {
    if (this.disposed || !this.configured) return false;
    if (!this.queue.includes(versionId)) this.queue.push(versionId);
    this.schedule();
    return true;
  }

  private schedule(): void {
    if (this.disposed || this.running || this.timer || !this.queue.length) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.drain();
    }, 0);
    this.timer.unref?.();
  }

  private async drain(): Promise<void> {
    if (this.running || this.disposed) return;
    this.running = true;
    try {
      while (this.queue.length && !this.disposed) {
        const versionId = this.queue.shift()!;
        await this.indexVersion(versionId);
        if (Date.now() < this.cooldownUntil) break;
      }
    } finally {
      this.running = false;
      if (!this.queue.length) {
        for (const resolve of this.waiters.splice(0)) resolve();
      } else if (Date.now() >= this.cooldownUntil) {
        this.schedule();
      } else {
        // 失败冷却期间队列未清空：冷却结束后自动恢复处理，否则队列会一直停摆，
        // 后续版本（包括仍获授权的）永远等不到执行。
        const delay = Math.max(0, this.cooldownUntil - Date.now());
        this.timer = setTimeout(() => {
          this.timer = null;
          this.schedule();
        }, delay);
        this.timer.unref?.();
      }
    }
  }

  /** 队列排空且没有正在写入时 resolve；验收用它等待真实向量化完成。 */
  async idle(timeoutMs = 120_000): Promise<void> {
    if (!this.queue.length && !this.running) return;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, timeoutMs);
      timer.unref?.();
      this.waiters.push(() => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  /**
   * 探测服务维度并缓存。有效性按 epoch 判断而非客户端对象引用：只要服务身份
   * （指纹 + 启用状态）没变，轮询刷新配置后回来的探测结果照样生效。
   */
  private async ensureDim(client: EmbeddingClient, epoch = this.epoch): Promise<number> {
    if (this.dim !== null && this.epoch === epoch) return this.dim;
    const dim = await client.probe();
    if (this.epoch === epoch) this.dim = dim;
    return dim;
  }

  private async indexVersion(versionId: string): Promise<void> {
    if (this.disposed) return;
    // 出队即重新判定归属：撤回云端授权或工作区改选服务后，本服务不再处理该版本。
    if (!this.owns(versionId)) return;
    // 指纹与客户端在这一轮开始时定住：切换服务后迟到的响应不得写进新索引。
    const client = this.client;
    const epoch = this.epoch;
    const indexKey = client.indexKey(this.chunkerVersion);
    const fresh = () => !this.disposed && this.epoch === epoch && this.owns(versionId);
    const sections = this.host.sectionsOf(versionId);
    if (!client.configured) {
      this.writeState(versionId, indexKey, client.runtime.enabled ? "unconfigured" : "disabled",
        sections.length, 0, 0, null);
      return;
    }
    if (!sections.length) {
      this.writeState(versionId, indexKey, "ready", 0, 0, 0, null);
      return;
    }
    this.writeState(versionId, indexKey, "indexing", sections.length, this.indexedCount(versionId, indexKey), 0, null);
    try {
      const dim = await this.ensureDim(client, epoch);
      if (!fresh()) return;
      const existing = new Map<number, string>();
      for (const row of this.host.db.prepare(
        `SELECT ordinal, chunk_sha256 FROM chunk_embeddings WHERE version_id = ? AND index_key = ? AND dim = ?`,
      ).all(versionId, indexKey, dim) as Array<{ ordinal: number; chunk_sha256: string }>) {
        existing.set(row.ordinal, row.chunk_sha256);
      }
      const missing = sections.filter((s) => existing.get(s.ordinal) !== s.chunkSha256);
      if (missing.length) {
        const insert = this.host.db.prepare(
          `INSERT INTO chunk_embeddings (version_id, ordinal, index_key, chunk_sha256, dim, vector, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(version_id, ordinal, index_key) DO UPDATE SET
             chunk_sha256 = excluded.chunk_sha256, dim = excluded.dim,
             vector = excluded.vector, created_at = excluded.created_at`,
        );
        // 逐批发送：每批前后都重新判定归属与指纹，撤权后未发送的批次不再外发，
        // 已在途批次回来也只写进仍然有效的索引。客户端逐条核对返回数量、实际维度
        // 与数值有效性，任何一项不符整批抛错、不落库。
        for (let at = 0; at < missing.length; at += client.runtime.batchSize) {
          const batch = missing.slice(at, at + client.runtime.batchSize);
          if (!fresh()) return;
          const vectors = await client.embed(batch.map(embeddingInput), dim);
          if (!fresh()) return;
          this.host.db.exec("BEGIN IMMEDIATE");
          try {
            for (const [index, section] of batch.entries()) {
              insert.run(versionId, section.ordinal, indexKey, section.chunkSha256, dim,
                encodeVector(vectors[index]!), this.now());
            }
            this.host.db.exec("COMMIT");
          } catch (err) {
            this.host.db.exec("ROLLBACK");
            throw err;
          }
        }
      }
      const indexed = this.indexedCount(versionId, indexKey, dim);
      this.writeState(versionId, indexKey, indexed >= sections.length ? "ready" : "pending",
        sections.length, indexed, sections.length - indexed, null);
      this.lastIndexedAt = this.now();
      this.lastError = null;
      this.cooldownUntil = 0;
    } catch (err) {
      if (!fresh()) return;
      // 维度与探测不一致：缓存维度已不可信，作废后重试会重新探测，服务恢复即可回到真实就绪。
      if (err instanceof EmbeddingDimMismatch) this.dim = null;
      const message = err instanceof Error ? err.message : String(err);
      this.lastError = message;
      this.cooldownUntil = Date.now() + this.failureCooldownMs;
      const state: KnowledgeEmbeddingState = err instanceof EmbeddingUnavailable ? "unavailable" : "error";
      const indexed = this.indexedCount(versionId, indexKey);
      this.writeState(versionId, indexKey, state, sections.length, indexed, sections.length - indexed, message);
    }
  }

  /** 只取传入版本的向量——调用方必须先按读者范围筛过版本，这里不做范围判断。 */
  vectorsFor(versionIds: string[]): Map<string, Array<{ ordinal: number; vector: Float32Array }>> {
    const out = new Map<string, Array<{ ordinal: number; vector: Float32Array }>>();
    if (!this.semanticReady || !versionIds.length) return out;
    const select = this.host.db.prepare(
      `SELECT ordinal, vector FROM chunk_embeddings WHERE version_id = ? AND index_key = ? AND dim = ?`,
    );
    for (const versionId of versionIds) {
      const rows = select.all(versionId, this.indexKey, this.dim!) as Array<{ ordinal: number; vector: Buffer }>;
      if (rows.length) out.set(versionId, rows.map((row) => ({ ordinal: row.ordinal, vector: decodeVector(row.vector) })));
    }
    return out;
  }

  async queryVector(query: string): Promise<Float32Array> {
    const client = this.client;
    const epoch = this.epoch;
    const indexKey = client.indexKey(this.chunkerVersion);
    const key = `${indexKey}|${query}`;
    const cached = this.cache.get(key);
    if (cached) return cached;
    const dim = await this.ensureDim(client, epoch);
    let vector: Float32Array | undefined;
    try {
      [vector] = await client.embed([query], dim);
    } catch (err) {
      if (err instanceof EmbeddingDimMismatch) this.dim = null;
      throw err;
    }
    // 服务身份已切换（换地址/模型/启停）时本次查询向量作废；同配置下的轮询刷新不算切换。
    if (this.epoch !== epoch) throw new EmbeddingUnavailable("向量化服务已切换，本次查询向量作废");
    if (!vector || vector.length !== dim) throw new EmbeddingUnavailable("查询向量维度与索引不一致");
    this.cache.set(key, vector);
    return vector;
  }

  /** 范围内计数与待办分类。versionIds 必须已按读者可见范围过滤，且都属于本服务。 */
  summary(versionIds: string[]): IndexSummary {
    let totalChunks = 0;
    let indexedChunks = 0;
    let failedChunks = 0;
    let indexing = false;
    let pending = false;
    let errored = false;
    for (const versionId of versionIds) {
      const state = this.versionState(versionId);
      totalChunks += state.totalChunks;
      indexedChunks += state.indexedChunks;
      failedChunks += state.failedChunks;
      if (state.state === "indexing") indexing = true;
      if (state.state === "pending") pending = true;
      if (state.state === "error" || state.state === "unavailable") errored = true;
    }
    return { totalChunks, indexedChunks, failedChunks, indexing, pending, errored };
  }

  private stateOf(summary: IndexSummary): KnowledgeEmbeddingState {
    if (!this.client.runtime.enabled) return "disabled";
    if (!this.configured) return "unconfigured";
    if (this.running || summary.indexing) return "indexing";
    if (summary.errored) return this.lastError && Date.now() < this.cooldownUntil ? "unavailable" : "error";
    if (summary.pending) return "pending";
    return summary.totalChunks === summary.indexedChunks ? "ready" : "pending";
  }

  /** 本服务在给定范围内的读数。allowed 由上层按读者范围判定。 */
  serviceStatus(versionIds: string[], allowed: boolean): KnowledgeEmbeddingServiceStatus {
    const summary = this.summary(versionIds);
    return {
      provider: this.client.runtime.provider,
      baseUrl: this.client.runtime.baseUrl,
      model: this.client.runtime.model,
      modelDim: this.dim,
      indexKey: this.indexKey,
      state: this.stateOf(summary),
      versions: versionIds.length,
      totalChunks: summary.totalChunks,
      indexedChunks: summary.indexedChunks,
      pendingChunks: Math.max(0, summary.totalChunks - summary.indexedChunks - summary.failedChunks),
      failedChunks: summary.failedChunks,
      allowed,
      ...(this.semanticReady ? {} : { degradedReason: this.degradedReason() }),
      ...(this.lastError ? { lastError: this.lastError } : {}),
    };
  }

  degradedReason(): string {
    const label = this.client.runtime.provider === "cloud" ? "云端向量化" : "本地向量化";
    if (!this.client.runtime.enabled) return "向量化已在设置中停用，本次检索只用关键词";
    if (!this.configured) return `未配置${label}模型，本次检索只用关键词`;
    if (this.lastError) return `${label}暂不可用，本次检索只用关键词：${this.lastError}`;
    return "向量索引尚未就绪，本次检索只用关键词";
  }

  /**
   * 重建：删掉这些版本在**本指纹**下的向量与状态，重新切分后的片段重新向量化。
   * 另一套服务已建好的向量留在盘上，切回去时不必重算。
   */
  rebuild(versionIds: string[]): void {
    const indexKey = this.indexKey;
    this.host.db.exec("BEGIN IMMEDIATE");
    try {
      const dropVectors = this.host.db.prepare(`DELETE FROM chunk_embeddings WHERE version_id = ? AND index_key = ?`);
      const dropState = this.host.db.prepare(`DELETE FROM chunk_index_state WHERE version_id = ?`);
      for (const versionId of versionIds) {
        dropVectors.run(versionId, indexKey);
        dropState.run(versionId);
      }
      this.host.db.exec("COMMIT");
    } catch (err) {
      this.host.db.exec("ROLLBACK");
      throw err;
    }
    this.cache.clear();
    this.cooldownUntil = 0;
    this.lastError = null;
    for (const versionId of versionIds) this.markPending(versionId);
  }

  /** 重试：只把失败/未就绪的版本重新排队，已就绪的不动。返回真的入队了的版本。 */
  retry(versionIds: string[]): string[] {
    this.cooldownUntil = 0;
    this.lastError = null;
    const queued: string[] = [];
    for (const versionId of versionIds) {
      const state = this.versionState(versionId);
      if (state.state === "ready") continue;
      if (this.markPending(versionId)) queued.push(versionId);
    }
    return queued;
  }

  dispose(): void {
    this.disposed = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.queue.length = 0;
    for (const resolve of this.waiters.splice(0)) resolve();
  }
}
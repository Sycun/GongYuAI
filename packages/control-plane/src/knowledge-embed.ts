import {
  KNOWLEDGE_EMBEDDING_PROBE_TEXT,
  knowledgeEmbeddingProviderLabels,
  type KnowledgeEmbeddingProvider,
  type KnowledgeEmbeddingSettings,
  type KnowledgeEmbeddingTestResult,
} from "@gongyuai/contracts";

/**
 * 一套 embedding 服务的运行时配置。凭据只从**本服务**的 apiKeyEnv / apiKey 取，
 * 因此切到云端时不会把本机 OMLX_API_KEY 发出去。
 */
export type EmbeddingRuntime = {
  provider: KnowledgeEmbeddingProvider;
  enabled: boolean;
  baseUrl: string;
  model: string;
  apiKey: string | null;
  batchSize: number;
  timeoutMs: number;
};

/**
 * 规范化服务地址：小写协议与主机、去掉默认端口 / 查询串 / 尾斜杠。
 * 索引指纹用它，避免同一服务写成两种写法就被当成两套索引。
 */
export function normalizeEmbeddingBaseUrl(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return "";
  try {
    const url = new URL(trimmed);
    url.protocol = url.protocol.toLowerCase();
    url.hostname = url.hostname.toLowerCase();
    url.hash = "";
    url.search = "";
    if ((url.protocol === "http:" && url.port === "80") || (url.protocol === "https:" && url.port === "443")) {
      url.port = "";
    }
    url.pathname = url.pathname.replace(/\/+$/, "");
    return url.toString().replace(/\/+$/, "");
  } catch {
    return trimmed.replace(/\/+$/, "");
  }
}

export function resolveEmbeddingRuntime(
  settings: KnowledgeEmbeddingSettings,
  provider: KnowledgeEmbeddingProvider,
  env: NodeJS.ProcessEnv = process.env,
): EmbeddingRuntime {
  const service = settings[provider];
  const fromEnv = service.apiKeyEnv ? env[service.apiKeyEnv]?.trim() : undefined;
  const apiKey = fromEnv || service.apiKey.trim() || null;
  return {
    provider,
    enabled: settings.enabled,
    baseUrl: normalizeEmbeddingBaseUrl(service.baseUrl),
    model: service.model,
    apiKey,
    batchSize: service.batchSize,
    timeoutMs: service.timeoutMs,
  };
}

/**
 * 服务「来源」：规范化地址的 origin（协议+主机+端口）。地址换到不同来源视作换了服务商，
 * 已存密钥与环境变量不得自动带到新来源；同一来源改路径（如 /v1 → /v2）仍算同一家。
 */
export function embeddingSourceOf(baseUrl: string): string {
  const normalized = normalizeEmbeddingBaseUrl(baseUrl);
  if (!normalized) return "";
  try {
    return new URL(normalized).origin;
  } catch {
    return normalized;
  }
}

/** 单位化后余弦相似度就是点积，检索时不必再算模长。 */
export function normalize(vector: Float32Array): Float32Array {
  let sum = 0;
  for (const value of vector) sum += value * value;
  const norm = Math.sqrt(sum);
  if (!Number.isFinite(norm) || norm === 0) return vector;
  const out = new Float32Array(vector.length);
  for (let i = 0; i < vector.length; i += 1) out[i] = vector[i]! / norm;
  return out;
}

export function dot(a: Float32Array, b: Float32Array): number {
  let sum = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i += 1) sum += a[i]! * b[i]!;
  return sum;
}

export function encodeVector(vector: Float32Array): Buffer {
  return Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength);
}

export function decodeVector(bytes: Buffer): Float32Array {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return new Float32Array(copy.buffer);
}

export class EmbeddingUnavailable extends Error {}

/** 服务返回的维度与预期（探测维度）不一致：维度缓存已不可信，需要重新探测。 */
export class EmbeddingDimMismatch extends EmbeddingUnavailable {
  constructor(message: string, readonly actualDim: number, readonly expectedDim: number) {
    super(message);
  }
}

/**
 * OpenAI 兼容 /embeddings 客户端。只做向量化，不做生成；
 * 失败一律抛 EmbeddingUnavailable，由调用方降级到关键词检索。
 */
export class EmbeddingClient {
  constructor(readonly runtime: EmbeddingRuntime) {}

  private get label(): string {
    return knowledgeEmbeddingProviderLabels[this.runtime.provider];
  }

  get configured(): boolean {
    return this.runtime.enabled && Boolean(this.runtime.baseUrl) && Boolean(this.runtime.model);
  }

  /**
   * 索引指纹：切分版本 + 服务商 + 规范化服务地址 + 模型。
   * 同名模型挂在不同服务上指纹不同，旧向量不与新向量混用。
   */
  indexKey(chunkerVersion: number): string {
    return `c${chunkerVersion}|${this.runtime.provider}|${this.runtime.baseUrl}|${this.runtime.model}`;
  }

  private async request(inputs: string[], expectedDim?: number): Promise<Float32Array[]> {
    if (!this.configured) throw new EmbeddingUnavailable(`${this.label}未启用或未配置模型`);
    let response: Response;
    try {
      response = await fetch(`${this.runtime.baseUrl}/embeddings`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(this.runtime.apiKey ? { authorization: `Bearer ${this.runtime.apiKey}` } : {}),
        },
        body: JSON.stringify({ model: this.runtime.model, input: inputs, encoding_format: "float" }),
        signal: AbortSignal.timeout(this.runtime.timeoutMs),
      });
    } catch (err) {
      throw new EmbeddingUnavailable(`${this.label}不可达：${err instanceof Error ? err.message : String(err)}`);
    }
    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      throw new EmbeddingUnavailable(`${this.label}返回 ${response.status}：${detail.slice(0, 300)}`);
    }
    const payload = await response.json().catch(() => null) as
      { data?: Array<{ index?: number; embedding?: number[] }> } | null;
    const items = payload?.data;
    if (!Array.isArray(items) || items.length !== inputs.length) {
      throw new EmbeddingUnavailable(`${this.label}返回的向量数量与输入不一致`);
    }
    const ordered = [...items].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
    return ordered.map((item) => {
      if (!Array.isArray(item.embedding) || !item.embedding.length) {
        throw new EmbeddingUnavailable(`${this.label}返回了空向量`);
      }
      if (expectedDim !== undefined && item.embedding.length !== expectedDim) {
        throw new EmbeddingDimMismatch(
          `${this.label}返回的向量维度 ${item.embedding.length} 与探测维度 ${expectedDim} 不一致`,
          item.embedding.length,
          expectedDim,
        );
      }
      const vector = normalize(Float32Array.from(item.embedding));
      for (const value of vector) {
        if (!Number.isFinite(value)) throw new EmbeddingUnavailable(`${this.label}返回了非有限数值`);
      }
      return vector;
    });
  }

  /**
   * 按批向量化；任一批失败即整体失败，不写入半截索引。
   * 给了 expectedDim 时逐条核对返回维度，探测与正文维度不一致的服务会被拒绝。
   */
  async embed(texts: string[], expectedDim?: number): Promise<Float32Array[]> {
    const out: Float32Array[] = [];
    for (let i = 0; i < texts.length; i += this.runtime.batchSize) {
      const batch = texts.slice(i, i + this.runtime.batchSize);
      out.push(...await this.request(batch, expectedDim));
    }
    return out;
  }

  async probe(): Promise<number> {
    const [vector] = await this.embed([KNOWLEDGE_EMBEDDING_PROBE_TEXT]);
    if (!vector) throw new EmbeddingUnavailable(`${this.label}探测未返回向量`);
    return vector.length;
  }
}

/**
 * 测试连接：只用固定合成短句请求所选服务，核对返回的是有效向量并报告实测维度。
 * 不写索引、不改维度缓存、不触发任何资料重建。
 */
export async function testEmbeddingConnection(runtime: EmbeddingRuntime): Promise<KnowledgeEmbeddingTestResult> {
  const base = {
    provider: runtime.provider,
    baseUrl: runtime.baseUrl,
    model: runtime.model,
    probeText: KNOWLEDGE_EMBEDDING_PROBE_TEXT,
  };
  const startedAt = Date.now();
  try {
    const [vector] = await new EmbeddingClient(runtime).embed([KNOWLEDGE_EMBEDDING_PROBE_TEXT]);
    if (!vector || !vector.length) throw new EmbeddingUnavailable("服务未返回向量");
    return { ...base, ok: true, dim: vector.length, durationMs: Date.now() - startedAt };
  } catch (err) {
    return {
      ...base,
      ok: false,
      durationMs: Date.now() - startedAt,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * 查询向量缓存。缓存里只有「查询串 → 向量」，不含任何资料正文，
 * 因此与读者范围无关；检索结果本身不缓存，每次都按当前范围重算。
 */
export class QueryVectorCache {
  private readonly entries = new Map<string, Float32Array>();
  constructor(private readonly limit = 256) {}

  get(key: string): Float32Array | undefined {
    const found = this.entries.get(key);
    if (found) {
      this.entries.delete(key);
      this.entries.set(key, found);
    }
    return found;
  }

  set(key: string, vector: Float32Array): void {
    if (this.entries.size >= this.limit) {
      const oldest = this.entries.keys().next().value;
      if (oldest !== undefined) this.entries.delete(oldest);
    }
    this.entries.set(key, vector);
  }

  clear(): void {
    this.entries.clear();
  }
}
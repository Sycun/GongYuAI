/**
 * 参考资料库（P8「知识与经验 → 参考资料」）的契约。
 *
 * 三类记录分工：本文件只覆盖**参考资料**——由人导入、按版本留存、按段落引用。
 * 委托事实与证据仍由任务 History 承担；项目经验图不在本模块范围。
 *
 * 检索是关键词 + 向量混合：关键词保住 `R-017`、`54/60`、`§6.4` 这类精确值，
 * 向量补中文同义与中英跨语言。索引与定版引用相互独立：重切分或换模型不影响旧引用。
 */
import { z } from "zod";

/** 原文 / 摘录 / 编辑导读：三者必须在接口与报告里可区分。 */
export const KnowledgeSourceKindSchema = z.enum(["original", "excerpt", "editorial"]);
export type KnowledgeSourceKind = z.infer<typeof KnowledgeSourceKindSchema>;

export const knowledgeSourceKindLabels: Record<KnowledgeSourceKind, string> = {
  original: "原文",
  excerpt: "摘录",
  editorial: "编辑导读",
};

/** 正文载体。网页摘录按粘贴进来的 markdown / text 解析，原链接单独登记。 */
export const KnowledgeBodyFormatSchema = z.enum(["markdown", "text", "pdf"]);
export type KnowledgeBodyFormat = z.infer<typeof KnowledgeBodyFormatSchema>;

/** 写入范围必须显式选择：团队共享，或指定委托。 */
export const KnowledgeScopeSchema = z.union([
  z.object({ kind: z.literal("shared") }),
  z.object({ kind: z.literal("engagement"), engagementId: z.string().trim().min(1).max(128) }),
]);
export type KnowledgeScope = z.infer<typeof KnowledgeScopeSchema>;

/** 范围的可比较字符串形式，用作去重主键的一部分。 */
export function knowledgeScopeKey(scope: KnowledgeScope): string {
  return scope.kind === "shared" ? "shared" : `engagement:${scope.engagementId}`;
}

const knowledgeImportBase = z.object({
  title: z.string().trim().min(1).max(300),
  publisher: z.string().trim().min(1).max(200),
  sourceKind: KnowledgeSourceKindSchema,
  format: KnowledgeBodyFormatSchema,
  /** 原始链接。网页摘录必填；仅登记链接时正文标记为待补。 */
  sourceUrl: z.string().trim().min(1).max(2000).optional(),
  /** 来源身份。缺省时由 sourceUrl 或 title+publisher 派生，决定“同一来源”的判定。 */
  sourceKey: z.string().trim().min(1).max(300).optional(),
  /** markdown / text 正文（UTF-8）。 */
  content: z.string().max(8 * 1024 * 1024).optional(),
  /** PDF 原始字节（base64）。 */
  contentBase64: z.string().max(24 * 1024 * 1024).optional(),
  /** 上游发布者版本，已知则登记。 */
  upstreamVersion: z.string().trim().min(1).max(120).optional(),
  /** 上游 Git commit，已知则登记。 */
  upstreamCommit: z.string().trim().min(1).max(64).optional(),
  /** 中文主题标签，例如「负责人换班」。仅标签命中时检索结果如实标识。 */
  tags: z.array(z.string().trim().min(1).max(60)).max(40).default([]),
  /** 导入者说明（编辑导读的导读理由等），不当作正文。 */
  note: z.string().trim().max(2000).optional(),
});

const hasAnyBody = (value: { content?: string; contentBase64?: string; sourceUrl?: string }) =>
  Boolean(value.content?.trim() || value.contentBase64?.trim() || value.sourceUrl?.trim());

/** 预览：不写盘，返回可确认的元数据、正文与章节定位。 */
export const KnowledgePreviewSchema = knowledgeImportBase.refine(hasAnyBody, {
  message: "content、contentBase64 或 sourceUrl 至少提供一项",
});
export type KnowledgePreviewInput = z.infer<typeof KnowledgePreviewSchema>;

/** 导入：在预览字段之上必须显式给出可见范围。 */
export const KnowledgeImportSchema = knowledgeImportBase
  .extend({ scope: KnowledgeScopeSchema })
  .refine(hasAnyBody, { message: "content、contentBase64 或 sourceUrl 至少提供一项" });
export type KnowledgeImportInput = z.infer<typeof KnowledgeImportSchema>;

/**
 * 页码依据。PDF 提取保留物理页边界时为 physical-page；
 * 早期版本按空行推算的页码无法确认，如实标为 legacy-paragraph。
 */
export type KnowledgePageBasis = "physical-page" | "legacy-paragraph";

/**
 * 检索片段（chunk）。charStart/charEnd 是相对版本正文的字符偏移，
 * 与索引无关：重切分、换 embedding 模型都不会改变这两个值指向的原文。
 */
export type KnowledgeSection = {
  ordinal: number;
  locator: string;
  heading: string | null;
  page: number | null;
  text: string;
  charStart: number;
  charEnd: number;
  /** 标题层级路径，从最外层到本片段的直接标题。 */
  headingPath: string[];
  /** 所属标题章节的定位；长章节被切成多片时用它回读整章。 */
  parentLocator: string;
  /** 片段原文的 SHA-256，用于定版引用的片段校验。 */
  chunkSha256: string;
  /** 在父章节内的片序（0 起）与父章节总片数。 */
  chunkIndex: number;
  chunkCount: number;
  /** 1 起、含端点的行号范围。 */
  lineStart: number;
  lineEnd: number;
  /** 仅 PDF 有值。 */
  pageBasis: KnowledgePageBasis | null;
};

/** 命中片段的上下文：同章相邻片段与整章原文，都从版本正文回读。 */
export type KnowledgeSectionContext = {
  headingPath: string[];
  parentLocator: string;
  parentCharStart: number;
  parentCharEnd: number;
  parentText: string;
  previous: { locator: string; text: string } | null;
  next: { locator: string; text: string } | null;
};

export type KnowledgeBodyStatus = "ready" | "pending_body";

export type KnowledgeVersionStatus = "active" | "deprecated";

export type KnowledgeVersion = {
  id: string;
  materialId: string;
  /** 本地导入版号，与上游版本分开显示。 */
  versionNo: number;
  versionLabel: string;
  contentSha256: string;
  byteSize: number;
  importedAt: string;
  format: KnowledgeBodyFormat;
  bodyStatus: KnowledgeBodyStatus;
  bodyStatusReason?: string;
  sectionCount: number;
  upstreamVersion?: string;
  upstreamCommit?: string;
  status: KnowledgeVersionStatus;
  deprecatedAt?: string;
  deprecatedReason?: string;
  /** 相对数据根的快照路径，内容寻址。 */
  snapshotPath: string;
  /** 切分算法版本。落后于当前实现时可重建，不影响版本号与内容 SHA-256。 */
  chunkerVersion: number;
  /** 正文提取实现版本。0 表示旧提取（PDF 页码按空行推算，无法确认）。 */
  extractionVersion: number;
};

export type KnowledgeMaterial = {
  id: string;
  scope: KnowledgeScope;
  scopeKey: string;
  sourceKey: string;
  title: string;
  publisher: string;
  sourceKind: KnowledgeSourceKind;
  sourceUrl?: string;
  note?: string;
  tags: string[];
  createdAt: string;
  updatedAt: string;
  /** 最近一次导入的版本。 */
  currentVersionId: string;
  /** 检索默认使用的版本：current 未停用时即 current，否则最新的未停用版本。 */
  effectiveVersionId: string | null;
  versionCount: number;
};

export type KnowledgePreview = {
  title: string;
  publisher: string;
  sourceKind: KnowledgeSourceKind;
  format: KnowledgeBodyFormat;
  sourceUrl?: string;
  sourceKey: string;
  tags: string[];
  note?: string;
  upstreamVersion?: string;
  upstreamCommit?: string;
  contentSha256: string;
  byteSize: number;
  bodyStatus: KnowledgeBodyStatus;
  bodyStatusReason?: string;
  sections: KnowledgeSection[];
};

export type KnowledgeImportResult = {
  material: KnowledgeMaterial;
  version: KnowledgeVersion;
  /** true 表示命中已有版本，未新增。 */
  reused: boolean;
  sections: KnowledgeSection[];
  /** 该版本的向量索引状态。导入不等待向量化完成。 */
  index: KnowledgeVersionIndexState;
};

/**
 * 命中字段。语义命中只标 semantic，绝不标 body——body 专指正文字面命中。
 * locator 表示按章节地址命中（查询 `§6.4` / `6.4`），也不是正文字面命中。
 * 纯标签命中时只有 tags，且 tagOnly=true。
 */
export type KnowledgeMatchField = "title" | "tags" | "body" | "semantic" | "locator";

/** 检索模式。hybrid 在向量不可用时自动降级为关键词，并在 index 里说明。 */
export type KnowledgeSearchMode = "keyword" | "hybrid";

/** 这一条命中是怎么召回的。 */
export type KnowledgeRetrieval = "keyword" | "semantic" | "hybrid";

export type KnowledgeSearchHit = {
  materialId: string;
  versionId: string;
  versionNo: number;
  versionLabel: string;
  versionStatus: KnowledgeVersionStatus;
  title: string;
  publisher: string;
  sourceKind: KnowledgeSourceKind;
  sourceUrl?: string;
  scope: KnowledgeScope;
  bodyStatus: KnowledgeBodyStatus;
  matchedFields: KnowledgeMatchField[];
  matchedTags: string[];
  tagOnly: boolean;
  /** 该版本内**关键词**命中的段落总数（不受 limit 影响）。 */
  matchCount: number;
  locator: string;
  heading: string | null;
  page: number | null;
  ordinal: number;
  context: string;
  /** 原文定位：与索引无关，可直接用于创建定版引用。 */
  headingPath: string[];
  parentLocator: string;
  charStart: number;
  charEnd: number;
  chunkSha256: string;
  lineStart: number;
  lineEnd: number;
  pageBasis: KnowledgePageBasis | null;
  /** 召回来源与可审计的分项得分。 */
  retrieval: KnowledgeRetrieval;
  score: number;
  keywordScore: number;
  /** 余弦相似度；未参与语义召回时为 null。 */
  semanticScore: number | null;
};

/** 向量索引状态。degraded=true 时检索仍可用，但只有关键词一路。 */
export type KnowledgeEmbeddingState =
  | "ready"
  | "indexing"
  | "pending"
  | "disabled"
  | "unconfigured"
  | "unavailable"
  | "error";

/** 向量化服务商。local 是本机推理服务，cloud 是远端 OpenAI 兼容服务。 */
export const KnowledgeEmbeddingProviderSchema = z.enum(["local", "cloud"]);
export type KnowledgeEmbeddingProvider = z.infer<typeof KnowledgeEmbeddingProviderSchema>;
export const knowledgeEmbeddingProviderLabels: Record<KnowledgeEmbeddingProvider, string> = {
  local: "本地服务",
  cloud: "云端服务",
};

/**
 * 连通性探测与「测试连接」用的固定合成短句。
 * 只发这一句，绝不带资料正文，也不触发任何索引写入。
 */
export const KNOWLEDGE_EMBEDDING_PROBE_TEXT = "GongYuAI 向量化连通性探测 synthetic embedding probe";

export type KnowledgeVersionIndexState = {
  versionId: string;
  state: KnowledgeEmbeddingState;
  totalChunks: number;
  indexedChunks: number;
  failedChunks: number;
  indexKey: string | null;
  lastError?: string;
  updatedAt?: string;
};

/** 单个服务商在当前读者范围内的索引读数。 */
export type KnowledgeEmbeddingServiceStatus = {
  provider: KnowledgeEmbeddingProvider;
  baseUrl: string;
  model: string;
  modelDim: number | null;
  indexKey: string;
  state: KnowledgeEmbeddingState;
  /** 该服务在本范围内负责的资料版本数。 */
  versions: number;
  totalChunks: number;
  indexedChunks: number;
  pendingChunks: number;
  failedChunks: number;
  /** 本次读者范围是否允许把正文与查询文本发给该服务。 */
  allowed: boolean;
  degradedReason?: string;
  lastError?: string;
};

export type KnowledgeIndexStatus = {
  state: KnowledgeEmbeddingState;
  /** 当前范围内实际生效的 embedding 模型；未配置时为 null。 */
  model: string | null;
  /** 向量维度，探测成功后记录。 */
  modelDim: number | null;
  /** 提供方 base URL（不含凭据）。 */
  provider: string | null;
  /** 生效服务商类型。工作区选云端但本委托未允许时，这里如实回落为 local。 */
  providerKind: KnowledgeEmbeddingProvider | null;
  /** 切分算法版本。 */
  chunkerVersion: number;
  /** 索引指纹：切分版本 + 服务商 + 规范化服务地址 + 模型。同名模型在不同服务上指纹不同。 */
  indexKey: string | null;
  /** 以下计数只统计当前读者可见范围内的版本。 */
  totalChunks: number;
  indexedChunks: number;
  pendingChunks: number;
  failedChunks: number;
  /** 已索引但所属服务未获本范围授权的片段数：它们不参与本次语义召回。 */
  blockedChunks: number;
  /** 按服务商分解的读数，只列出范围内有资料的服务与工作区选定的服务。 */
  services: KnowledgeEmbeddingServiceStatus[];
  /** true 表示本次检索实际只用了关键词。 */
  degraded: boolean;
  degradedReason?: string;
  lastError?: string;
  lastIndexedAt?: string;
};

/** 服务端解析出的读者可见范围。单操作者环境下这是声明上下文，不是已认证身份。 */
export type KnowledgeReaderScope = {
  engagementId: string | null;
  /** 范围从哪里定下来：任务归属优先于客户端声明。 */
  resolvedFrom: "task" | "declared" | "shared-only";
  operatorModel: "single-operator";
  /** 用户级权限是否已验证。本运行环境无认证层，恒为 false。 */
  userLevelPermissionVerified: false;
};

export type KnowledgeSearchResult = {
  query: string;
  scope: KnowledgeReaderScope;
  /** 请求的检索模式。 */
  mode: KnowledgeSearchMode;
  /** 命中段落总数（关键词 + 语义，去重后，不受 limit 影响）。 */
  total: number;
  /** 命中资料份数。 */
  materials: number;
  /** 实际参与检索的版本数（已按可见范围过滤）。 */
  searchedVersions: number;
  limit: number;
  truncated: boolean;
  hits: KnowledgeSearchHit[];
  /** 两路各自召回了多少条，便于对比关键词与混合。semanticCutoff 是本次实际生效的余弦门槛。 */
  recall: { keyword: number; semantic: number; semanticCutoff: number | null };
  index: KnowledgeIndexStatus;
};

export type KnowledgeSummary = {
  scope: KnowledgeReaderScope;
  materials: number;
  versions: number;
  pendingBody: number;
  deprecatedVersions: number;
  bySourceKind: Record<KnowledgeSourceKind, number>;
  byScope: { shared: number; engagement: number };
};

/**
 * 报告引用：绑定资料、固定版本、原文范围、片段校验值、快照 SHA-256 与它支持的表述。
 *
 * 给了 charStart/charEnd 即按**原文范围**定版（pinKind=range），回读与索引无关；
 * 只给 locator 是旧版写法（pinKind=locator），回读沿用旧切分，保证升级前后同一段。
 */
export const MaterialCitationSchema = z.object({
  materialId: z.string().trim().min(1).max(64),
  versionId: z.string().trim().min(1).max(64),
  locator: z.string().trim().min(1).max(300),
  /** 这条引用支持报告里的哪句话。 */
  claim: z.string().trim().min(1).max(2000),
  /** 仅用于定位；与服务端任务归属冲突时拒绝。 */
  engagementId: z.string().trim().min(1).max(128).optional(),
  /** 命中片段的原文范围，直接取自检索命中。两者必须同时给出。 */
  charStart: z.number().int().min(0).optional(),
  charEnd: z.number().int().min(1).optional(),
  /** 命中片段的 chunkSha256；给出即校验，防止定位与内容错配。 */
  chunkSha256: z.string().trim().regex(/^[a-f0-9]{64}$/).optional(),
}).refine((v) => (v.charStart === undefined) === (v.charEnd === undefined), {
  message: "charStart 与 charEnd 必须同时提供",
}).refine((v) => v.charStart === undefined || v.charEnd! > v.charStart, {
  message: "charEnd 必须大于 charStart",
});
export type MaterialCitationInput = z.infer<typeof MaterialCitationSchema>;

/** 定版方式：range 按原文范围，locator 是旧版按定位回读。 */
export type CitationPinKind = "range" | "locator";

export type MaterialCitation = {
  id: string;
  taskId: string;
  engagementId: string;
  materialId: string;
  versionId: string;
  locator: string;
  claim: string;
  /** 密封快照的 SHA-256，等于被引用版本的内容 SHA-256。 */
  snapshotSha256: string;
  bodyFormat: KnowledgeBodyFormat;
  /** 渲染报告用的标签，不是第二真相源；正文仍从密封快照回读。 */
  materialTitle: string;
  publisher: string;
  sourceKind: KnowledgeSourceKind;
  versionNo: number;
  versionLabel: string;
  sectionHeading: string | null;
  sectionPage: number | null;
  sectionOrdinal: number;
  createdAt: string;
  pinKind: CitationPinKind;
  /** range 定版时固定的原文范围；locator 定版时为 null。 */
  charStart: number | null;
  charEnd: number | null;
  /** 片段校验值；locator 定版时为 null。 */
  chunkSha256: string | null;
  headingPath: string[];
  pageBasis: KnowledgePageBasis | null;
};

export type CitationUnverifiableReason =
  | "snapshot_missing"
  | "sha256_mismatch"
  | "locator_not_found"
  | "body_pending"
  | "material_out_of_scope"
  | "range_out_of_bounds"
  | "chunk_sha_mismatch";

export type CitationVerification = {
  status: "verified" | "unverifiable";
  reason?: CitationUnverifiableReason;
  expectedSha256: string;
  recomputedSha256?: string;
  /** 复验读取的是任务侧密封件，因此不依赖知识库快照或上游网络。 */
  source: "task-seal";
  detail?: string;
};

export type ResolvedCitation = {
  citation: MaterialCitation;
  verification: CitationVerification;
  paragraph?: KnowledgeSection;
  /** 被引用版本当前是否已停用；停用不影响旧报告回读。 */
  versionStatus?: KnowledgeVersionStatus;
  /** 知识库侧快照是否仍在（与任务侧密封件分开报告）。 */
  librarySnapshotAvailable: boolean;
};

/** 导出实际打包的字节范围。full-version 是整份版本快照，paragraph 只有被引用片段。 */
export type ExportSnapshotScope = "full-version" | "paragraph" | "none";

export type KnowledgeReportExport = {
  version: 1;
  kind: "knowledge-report-export";
  taskId: string;
  engagementId: string;
  exportedAt: string;
  scope: KnowledgeReaderScope;
  /** 本次导出的 snapshot.bytesBase64 到底是整份快照还是引用片段。 */
  snapshotScope: ExportSnapshotScope;
  report: { path: string; sha256: string; markdown: string } | null;
  citations: Array<{
    citation: MaterialCitation;
    verification: CitationVerification;
    paragraph?: KnowledgeSection;
    /** 授权收件范围内才打包字节；范围由 snapshotScope 说明。 */
    snapshot?: { sha256: string; byteSize: number; bytesBase64: string };
  }>;
  /** 只给数量，不给范围外资料的 ID 或标题。 */
  withheld: { outOfScopeCitations: number };
};

/**
 * 一套 embedding 服务的接入配置。本地与云端各存一份，互不覆盖：
 * 密钥与密钥环境变量都按服务分开，切到云端时不会把本机密钥发出去。
 */
export const KnowledgeEmbeddingServiceSchema = z.object({
  /** OpenAI 兼容服务根地址，实际请求 {baseUrl}/embeddings。 */
  baseUrl: z.string().trim().max(400).default(""),
  /** embedding 模型 id，可手动填写。 */
  model: z.string().trim().max(200).default(""),
  /** 只从这个环境变量读密钥；留空表示不带 Authorization。 */
  apiKeyEnv: z.string().trim().max(120).default(""),
  /** 直接登记的密钥；公开视图里掩码。 */
  apiKey: z.string().max(400).default(""),
  batchSize: z.number().int().min(1).max(64).default(16),
  timeoutMs: z.number().int().min(500).max(120_000).default(30_000),
});
export type KnowledgeEmbeddingService = z.infer<typeof KnowledgeEmbeddingServiceSchema>;

/**
 * 服务配置的**真·部分**补丁：每个字段显式 optional 且不带默认值。
 * 不能直接用 `.partial()`——zod 会照样应用字段默认值，导致缺省字段把已存配置覆盖成默认，
 * 部分保存（例如只改超时）会清空地址与模型。
 */
export const KnowledgeEmbeddingServicePatchSchema = z.object({
  baseUrl: z.string().trim().max(400).optional(),
  model: z.string().trim().max(200).optional(),
  apiKeyEnv: z.string().trim().max(120).optional(),
  apiKey: z.string().max(400).optional(),
  batchSize: z.number().int().min(1).max(64).optional(),
  timeoutMs: z.number().int().min(500).max(120_000).optional(),
});
export type KnowledgeEmbeddingServicePatch = z.infer<typeof KnowledgeEmbeddingServicePatchSchema>;

const EMBEDDING_SERVICE_KEYS = ["baseUrl", "model", "apiKeyEnv", "apiKey", "batchSize", "timeoutMs"] as const;

/**
 * 升级迁移：首版只有扁平的一套本地配置，整体搬进 local，云端保持未配置。
 * 已经带 local/cloud 的新配置原样通过，未知字段由 zod 剥掉。
 */
function liftLegacyEmbedding(raw: unknown): unknown {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return raw;
  const value = { ...(raw as Record<string, unknown>) };
  if (value.local !== undefined || value.cloud !== undefined) return value;
  const legacy: Record<string, unknown> = {};
  for (const key of EMBEDDING_SERVICE_KEYS) {
    if (value[key] === undefined) continue;
    legacy[key] = value[key];
    delete value[key];
  }
  if (Object.keys(legacy).length) value.local = legacy;
  return value;
}

/**
 * 向量化配置。provider 是工作区选定的服务：团队共享资料按它走；
 * 委托专属资料一律本地，只有 cloudEngagements 里明确允许的委托才可发往云端。
 */
export const KnowledgeEmbeddingSettingsSchema = z.preprocess(liftLegacyEmbedding, z.object({
  enabled: z.boolean().default(true),
  provider: KnowledgeEmbeddingProviderSchema.default("local"),
  local: KnowledgeEmbeddingServiceSchema.default({
    baseUrl: "http://127.0.0.1:8000/v1",
    model: "bge-m3-mlx-4bit",
    apiKeyEnv: "OMLX_API_KEY",
    apiKey: "",
    batchSize: 16,
    timeoutMs: 30_000,
  }),
  cloud: KnowledgeEmbeddingServiceSchema.default({
    baseUrl: "",
    model: "",
    apiKeyEnv: "GY_CLOUD_EMBEDDING_API_KEY",
    apiKey: "",
    batchSize: 16,
    timeoutMs: 30_000,
  }),
  /** 明确允许把委托专属正文与查询发往云端的委托 id。空数组表示一个都不允许。 */
  cloudEngagements: z.array(z.string().trim().min(1).max(128)).max(200).default([]),
}));
export type KnowledgeEmbeddingSettings = z.infer<typeof KnowledgeEmbeddingSettingsSchema>;

export const KnowledgeEmbeddingPatchSchema = z.preprocess(liftLegacyEmbedding, z.object({
  enabled: z.boolean().optional(),
  provider: KnowledgeEmbeddingProviderSchema.optional(),
  local: KnowledgeEmbeddingServicePatchSchema.optional(),
  cloud: KnowledgeEmbeddingServicePatchSchema.optional(),
  cloudEngagements: z.array(z.string().trim().min(1).max(128)).max(200).optional(),
}));
export type KnowledgeEmbeddingPatch = z.infer<typeof KnowledgeEmbeddingPatchSchema>;

/** 公开视图：密钥只给「是否已配置」与掩码。 */
export type KnowledgeEmbeddingServiceView = Omit<KnowledgeEmbeddingService, "apiKey"> & {
  apiKeyConfigured: boolean;
  apiKeyMask: string;
};
export type KnowledgeEmbeddingView = {
  enabled: boolean;
  provider: KnowledgeEmbeddingProvider;
  cloudEngagements: string[];
  local: KnowledgeEmbeddingServiceView;
  cloud: KnowledgeEmbeddingServiceView;
};

/** 测试连接：可选草稿覆盖已存配置，密钥留空或掩码表示沿用已存密钥。 */
export const KnowledgeEmbeddingTestSchema = z.object({
  provider: KnowledgeEmbeddingProviderSchema.default("local"),
  service: KnowledgeEmbeddingServicePatchSchema.optional(),
});
export type KnowledgeEmbeddingTestInput = z.infer<typeof KnowledgeEmbeddingTestSchema>;

export type KnowledgeEmbeddingTestResult = {
  provider: KnowledgeEmbeddingProvider;
  baseUrl: string;
  model: string;
  /** 实际发出的固定合成短句，便于确认没有资料正文外发。 */
  probeText: string;
  ok: boolean;
  /** 实测向量维度。 */
  dim?: number;
  durationMs?: number;
  error?: string;
};
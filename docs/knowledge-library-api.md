# 参考资料库 · 控制面接口契约

资料导入、检索、报告引用和导出通过控制面 API 提供。「知识与经验 → 参考资料」页面接入范围选择、模型设置、索引进度、重试、重建和检索。[页面接入设计](./knowledge-library-console.md)

真实云端验收使用共享合成资料，本机 oMLX 返回 1024 维，硅基流动 Qwen/Qwen3-VL-Embedding-8B 返回 4096 维。两次切换均确认索引就绪，定版引用的段落和版本校验值一致。[脱敏验收记录](./evidence/knowledge-library/siliconflow-acceptance.json)

真实响应落盘（可直接对照）：
[检索 Q1 混合](./evidence/knowledge-library/knowledge-hybrid-1795411122521/search-Q1-hybrid.json) ·
[检索 Q1 关键词](./evidence/knowledge-library/knowledge-hybrid-1795411122521/search-Q1-keyword.json) ·
[索引状态](./evidence/knowledge-library/knowledge-hybrid-1795411122521/response-index-status.json) ·
[建引用](./evidence/knowledge-library/knowledge-hybrid-1795411122521/response-citation-created.json) ·
[重启后回读](./evidence/knowledge-library/knowledge-hybrid-1795411122521/response-resolve-after-restart.json) ·
[升级前旧引用回读](./evidence/knowledge-library/knowledge-hybrid-1795411122521/response-legacy-upgrade-resolve.json) ·
[无法复验](./evidence/knowledge-library/knowledge-hybrid-1795411122521/response-resolve-unverifiable.json) ·
[离线导出](./evidence/knowledge-library/knowledge-hybrid-1795411122521/offline-report-export.json) ·
[PDF 页码回归](./evidence/knowledge-library/knowledge-hybrid-1795411122521/pdf-page-regression.json) ·
[逐查询名次对比](./evidence/knowledge-library/knowledge-hybrid-1795411122521/query-comparison.json)

历史验收记录包括[混合检索](./evidence/knowledge-library/knowledge-hybrid-1795411122521/acceptance-record.md)和[关键词基线](./evidence/knowledge-library/knowledge-1795411271842/acceptance-record.md)。

类型定义由 `@gongyuai/contracts` 包根导出。[知识库类型](../packages/contracts/src/knowledge.ts)

---

## 0. 本轮范围与关键变化

**做**：整篇原文入库并按标题层级切片、关键词与向量混合检索、索引状态/重试/重建、按原文范围定版引用、旧报告离线回读与导出、服务端委托隔离、PDF 物理页码。

任务 History 保存本次委托的事实与证据，资料库为报告提供可复验的文献引用。

相对首版的四处关键变化，控制台必须体现：

1. **整篇入库是主路径。** 不再需要人工裁摘录。一次导入整篇文章，后端按标题层级切章、长章节继续切片，表格与围栏代码块尽量整块保留。
2. **检索默认是混合（`mode=hybrid`）。** 关键词保住 `R-017`、`54/60` 这类精确值与 `§6.4` 这类章节地址；向量补中文同义与中英跨语言。**语义命中不会标成正文字面命中。**
3. **索引与定版引用相互独立。** 重切分、换 embedding 模型、重建索引都不影响已有资料版本与报告引用。新引用固定「资料版本 + 原文范围 + 片段校验值 + 快照校验值」。
4. **PDF 页码按物理页。** 早期版本按空行推算的页码无法确认，如实标 `pageBasis: "legacy-paragraph"`。

---

## 1. 委托上下文怎样传递（与首版一致）

服务端决定读者可见范围，客户端不能替服务端决定归属。

| 场景 | 传法 | 服务端行为 |
| --- | --- | --- |
| 库级路由（`/knowledge/*`）声明当前委托 | 请求头 `x-gy-engagement: <id>`，或查询参数 `engagementId=<id>` | `scope.resolvedFrom = "declared"`；可见 = 共享资料 + 该委托专属资料 |
| 库级路由不声明委托 | 都不传 | `scope.resolvedFrom = "shared-only"`；**只**可见共享资料 |
| 库级路由按任务锚定 | 查询参数 `taskId=<任务ID>` | 以 `store` 里该任务的 `engagementId` 为准，`resolvedFrom = "task"`；同时传了 `engagementId` 且不一致 → **409** |
| 任务级路由（`/tasks/:id/citations*`、`/tasks/:id/report-export`） | 路径里的任务 ID | 一律以服务端任务归属为准；`engagementId`（查询参数、请求头或请求体）只能用于定位，不一致 → **409** |

`engagementId` 与 `x-gy-engagement` 同时给出时，查询参数优先。

**每个响应都回带 `scope`**，控制台应直接展示它：

```json
{
  "engagementId": "eng-knowledge-hybrid-1795410586564",
  "resolvedFrom": "declared",
  "operatorModel": "single-operator",
  "userLevelPermissionVerified": false
}
```

> **权限边界（必须如实呈现）**：当前运行环境是单操作者、无认证层。`declared` 是**声明上下文**，不是已认证身份。已验收的是**委托边界**（两路召回的范围校验、越界拒绝、导出不泄露）；**用户级权限**（谁有权声明哪个委托）未验证，`userLevelPermissionVerified` 恒为 `false`。控制台不要把它显示成"已鉴权"。

**混合检索的隔离**：关键词与语义两路都先按服务端可见范围筛出资料与版本，再召回、合并、计数、返回正文。索引计数（`/knowledge/index`）同样只统计范围内版本。查询向量缓存里只有「查询串 → 向量」，不含任何资料正文，因此与范围无关；**检索结果本身不缓存**，每次都按当前范围重算。

---

## 2. 路由总表

所有响应 `content-type: application/json`（`GET /tasks/:id/report` 除外，为 `text/markdown`）。

### 2.1 资料库与检索

| 方法 | 路径 | 用途 | 成功码 |
| --- | --- | --- | --- |
| POST | `/knowledge/preview` | 预览：解析正文与切片，**不写盘** | 200 |
| POST | `/knowledge/materials` | 导入整篇（必须显式给 `scope`） | 201 新建 / 200 复用已有版本 |
| GET | `/knowledge/materials` | 范围内资料清单 | 200 |
| GET | `/knowledge/materials/:materialId` | 资料详情 + 全部版本 | 200 |
| GET | `/knowledge/materials/:materialId/versions` | 版本列表 | 200 |
| GET | `/knowledge/materials/:materialId/versions/:versionId` | 版本详情 + 片段 + 快照状态 | 200 |
| GET | `/knowledge/materials/:materialId/versions/:versionId/section?locator=<enc>` | 读单个片段 **+ 上下文** | 200 |
| POST | `/knowledge/materials/:materialId/versions/:versionId/deprecate` | 停用某版本 | 200 |
| GET | `/knowledge/search?q=<enc>&mode=<hybrid\|keyword>&limit=<n>&versionId=<id>` | 混合检索 | 200 |
| GET | `/knowledge/summary` | 范围内计数摘要 | 200 |

### 2.2 向量索引（新增）

| 方法 | 路径 | 用途 | 成功码 |
| --- | --- | --- | --- |
| GET | `/knowledge/index` | 范围内索引状态、模型与索引版本、降级原因 | 200 |
| POST | `/knowledge/index/rebuild` | 重切分 + 重新向量化（可限定 `materialId` / `versionId`） | **202** |
| POST | `/knowledge/index/retry` | 只重试失败/未就绪的版本 | **202** |
| PUT | `/settings/knowledge-embedding` | 改向量化配置（启用/服务商/本地与云端两套地址模型密钥/云端授权委托） | 200 |
| POST | `/settings/knowledge-embedding/test` | 用固定合成短句测试所选服务，返回实测维度 | 200 |

`rebuild` / `retry` 是**异步**的：202 表示已排队，不代表索引已就绪。控制台应轮询 `GET /knowledge/index` 直到 `state === "ready"`，或直接在检索响应里读 `index`。

`queued` / `versions` 为空数组表示**确实没有待办**，控制台必须显示「没有需要重试的资料」，不得渲染成「已排队」。

### 2.3 报告引用与导出

| 方法 | 路径 | 用途 | 成功码 |
| --- | --- | --- | --- |
| GET | `/tasks/:taskId/citations` | 本任务的引用清单 | 200 |
| POST | `/tasks/:taskId/citations` | 新建定版引用（终态任务会重渲染报告） | 201 |
| GET | `/tasks/:taskId/citations/:citationId/resolve` | 回读并复验当时引用的段落 | 200 |
| GET | `/tasks/:taskId/report-export?snapshot=<full-version\|paragraph\|none>` | 离线导出 | 200 |
| GET | `/tasks/:taskId/report` | 既有报告入口，已含「## 参考资料引用（定版）」 | 200 |
| GET | `/tasks/:taskId/report-evidence/:sha256` | 既有密封件下载入口 | 200 |

`locator` 含 `§`、`~` 与中文，**必须 `encodeURIComponent`**。

---

## 3. 类型

以下与 `packages/contracts/src/knowledge.ts` 一致，可直接 import。

### 3.1 片段（检索与引用的最小单位）

```ts
type KnowledgePageBasis = "physical-page" | "legacy-paragraph";

type KnowledgeSection = {
  ordinal: number;          // 0 起，版本内稳定序号
  locator: string;          // "§6.4" / "§6.4~2" / "§六批、五次交接" / "¶0" / "p.5" / "p.5~2"
  heading: string | null;   // 直接所属标题
  page: number | null;      // 仅 PDF
  text: string;             // 原文，等于正文的 [charStart, charEnd) 切片
  charStart: number;        // 相对版本正文的字符偏移
  charEnd: number;
  headingPath: string[];    // 标题层级路径，例：["SapperLens","6. 架构设计","6.4 状态与连续性"]
  parentLocator: string;    // 所属标题章节定位；长章节被切片时用它回读整章
  chunkSha256: string;      // 片段原文的 SHA-256
  chunkIndex: number;       // 父章节内片序，0 起
  chunkCount: number;       // 父章节总片数
  lineStart: number;        // 1 起、含端点
  lineEnd: number;
  pageBasis: KnowledgePageBasis | null;  // 仅 PDF
};
```

**切片规则**（`chunkerVersion = 2`）：

- 按 ATX 标题（`#`…`######`）切章，围栏代码块里的 `#` 不算标题。
- 章内按块装片，目标 700 字符、硬上限 1400 字符；**表格与围栏代码块作为整块**参与装片，只有单块超过硬上限才按行拆开。
- 过短的尾片（< 150 字符）并回前一片，避免一行碎片。
- 片段偏小是刻意的：一段里混多个话题会稀释向量，实测同一段单独成片时相似度更高。上下文靠 §3.6 的 `parentText` / `previous` / `next` 补回，不靠把片段撑大。
- 定位命名：章节首片用章节定位（`§6.4`），后续片用 `§6.4~2`、`§6.4~3`。同名章节仍按首版的 `#2` 去重。
- 前言（第一个标题之前）为 `¶0`；纯文本为 `¶1`、`¶2`…；PDF 为 `p.N`（N 是**物理页号**）。
- `text` 一定是版本正文的精确切片：`body.slice(charStart, charEnd) === text`。验收逐片核对过。

### 3.2 资料与版本

```ts
type KnowledgeSourceKind = "original" | "excerpt" | "editorial";   // 原文 / 摘录 / 编辑导读
type KnowledgeBodyFormat = "markdown" | "text" | "pdf";
type KnowledgeScope = { kind: "shared" } | { kind: "engagement"; engagementId: string };
type KnowledgeBodyStatus = "ready" | "pending_body";
type KnowledgeVersionStatus = "active" | "deprecated";

type KnowledgeVersion = {
  id: string; materialId: string;
  versionNo: number;        // 本地导入版号
  versionLabel: string;     // "本地 v1"
  contentSha256: string;    // 正文 UTF-8 字节的 SHA-256
  byteSize: number; importedAt: string;
  format: KnowledgeBodyFormat;
  bodyStatus: KnowledgeBodyStatus; bodyStatusReason?: string;
  sectionCount: number;
  upstreamVersion?: string; upstreamCommit?: string;
  status: KnowledgeVersionStatus; deprecatedAt?: string; deprecatedReason?: string;
  snapshotPath: string;     // 相对数据根，内容寻址
  chunkerVersion: number;   // 新增：切分算法版本
  extractionVersion: number;// 新增：正文提取实现版本（0 = 旧 PDF 提取，页码不可确认）
};

type KnowledgeMaterial = {
  id: string; scope: KnowledgeScope; scopeKey: string; sourceKey: string;
  title: string; publisher: string; sourceKind: KnowledgeSourceKind;
  sourceUrl?: string; note?: string; tags: string[];
  createdAt: string; updatedAt: string;
  currentVersionId: string;
  effectiveVersionId: string | null;  // 检索默认版本 = 最新未停用版本；全停用则 null
  versionCount: number;
};
```

`chunkerVersion` / `extractionVersion` 落后于当前实现时，后端在启动或重建时**原地重切分**：只替换片段行，**不动版本号、`contentSha256`、快照与已有引用**。

### 3.3 导入请求与响应

```ts
type KnowledgeImportInput = {
  title: string;              // 必填，≤300
  publisher: string;          // 必填，≤200
  sourceKind: KnowledgeSourceKind;   // 必填
  format: KnowledgeBodyFormat;       // 必填
  scope: KnowledgeScope;             // 必填：显式选择共享或指定委托
  sourceUrl?: string;         // 原始链接
  sourceKey?: string;         // 来源身份，缺省由 sourceUrl（含 fragment）或 title|publisher 派生
  content?: string;           // 整篇 markdown / text 正文，≤8MiB
  contentBase64?: string;     // PDF 原始字节，≤24MiB
  upstreamVersion?: string; upstreamCommit?: string;
  tags?: string[];            // 主题标签，≤40 条，每条 ≤60 字
  note?: string;              // 导入者说明，不当作正文
};
// content / contentBase64 / sourceUrl 至少一项非空

type KnowledgeImportResult = {
  material: KnowledgeMaterial;
  version: KnowledgeVersion;
  reused: boolean;            // true = 命中已有版本，未新增
  sections: KnowledgeSection[];
  index: KnowledgeVersionIndexState;   // 新增：该版本的向量索引状态
};
```

**导入不等待向量化。** 响应里的 `index.state` 通常是 `"pending"`，片段与关键词检索**立即可用**；语义召回在索引灌满后生效。控制台导入成功后应展示"正在建立语义索引"，而不是报错或阻塞。

`POST /knowledge/preview` 用**同一份字段但去掉 `scope`**，返回 `KnowledgePreview`（元数据 + `contentSha256` + `sections`），不写盘、不建索引。

**去重键**：`(scopeKey, sourceKey)` 决定"同一份资料"，`(materialId, contentSha256)` 决定"同一个版本"。

- 相同范围 + 相同来源 + 相同正文 → 返回已有版本，`reused: true`，HTTP **200**，版本数不变。
- 正文变化 → 新版本 `versionNo + 1`，旧快照保留，HTTP **201**。
- 元数据（标题、发布者、标签）在首次导入时固定；重放不会改写。
- 并发与重试安全：`BEGIN IMMEDIATE` + 两个唯一索引收敛。

> **标签不再是召回的拐杖。** 语义召回靠正文，验收时四份整篇材料全部 `tags: []`。控制台不要引导用户"为了搜得到而挂同词标签"。

### 3.4 检索请求与响应

`GET /knowledge/search`

| 参数 | 默认 | 说明 |
| --- | --- | --- |
| `q` | `""` | 查询串。多词以空格分隔，关键词一路要求全部命中 |
| `mode` | `hybrid` | `hybrid` = 关键词 + 语义；`keyword` = 只用关键词。其他值 → 400 |
| `limit` | 20 | 1…200，非正整数 → 400 |
| `versionId` | 无 | 指定版本；缺省用各资料的 `effectiveVersionId` |

```ts
type KnowledgeMatchField = "title" | "tags" | "body" | "semantic" | "locator";
type KnowledgeRetrieval = "keyword" | "semantic" | "hybrid";

type KnowledgeSearchHit = {
  materialId: string; versionId: string; versionNo: number; versionLabel: string;
  versionStatus: KnowledgeVersionStatus;
  title: string; publisher: string; sourceKind: KnowledgeSourceKind; sourceUrl?: string;
  scope: KnowledgeScope; bodyStatus: KnowledgeBodyStatus;

  matchedFields: KnowledgeMatchField[];
  matchedTags: string[];
  tagOnly: boolean;         // true = 仅标签命中，正文与语义都没有支撑
  matchCount: number;       // 该版本内**关键词**命中的片段总数
  retrieval: KnowledgeRetrieval;
  score: number;            // 融合分，用于排序
  keywordScore: number;     // 0 表示没有关键词命中
  semanticScore: number | null;  // 余弦；null 表示未参与语义召回

  // ---- 原文定位：可直接拿去创建定版引用 ----
  locator: string; heading: string | null; page: number | null; ordinal: number;
  headingPath: string[]; parentLocator: string;
  charStart: number; charEnd: number; chunkSha256: string;
  lineStart: number; lineEnd: number;
  pageBasis: KnowledgePageBasis | null;

  context: string;          // 命中上下文摘要；仅标签命中时为说明文字
};

type KnowledgeSearchResult = {
  query: string; scope: KnowledgeReaderScope;
  mode: "keyword" | "hybrid";
  total: number;            // 关键词 + 语义去重后的命中片段总数（不受 limit 影响）
  materials: number;
  searchedVersions: number; // 实际参与检索的版本数（已按范围过滤）
  limit: number; truncated: boolean;
  hits: KnowledgeSearchHit[];
  recall: { keyword: number; semantic: number; semanticCutoff: number | null };
  index: KnowledgeIndexStatus;
};
```

**`matchedFields` 的五档语义（控制台必须区分，不能混为"全文命中"）**：

| 值 | 含义 | 建议呈现 |
| --- | --- | --- |
| `body` | 查询词**字面**出现在片段正文里 | "正文命中" |
| `locator` | 按章节地址命中（查询 `§6.4` / `6.4`）。原文里往往不写这个字面 | "章节定位命中"，**不要**说成正文命中 |
| `semantic` | 向量相似召回，正文里没有该字面 | "语义相近"，给出 `semanticScore` |
| `title` | 资料标题命中 | "标题命中" |
| `tags` | 主题标签命中 | "标签命中"；`tagOnly` 为 true 时必须显式标注 |

一条命中可以同时带多个字段（例：`["body","semantic"]` 表示既字面命中又语义相近，`retrieval: "hybrid"`）。
**`semantic` 与 `body` 不会互相冒充**：只有语义支撑时 `matchedFields` 里没有 `body`，`keywordScore` 为 0。

**排序与召回策略**（可审计，验收记录里有逐条实测分）：

- `score = keywordScore + 0.8 × max(0, semanticScore)`。
- 关键词分：正文字面命中基分 1.0，整串完全一致 +0.6，标题路径全词命中 +0.35，词密度最多 +0.5；**章节地址命中固定 1.6**（最强关键词信号）。
- 元数据命中显著折价：仅标题 0.30、仅标签 0.22。因此**语义命中的正文片段会排在仅标签命中之前**。
- 语义门槛：绝对下限 0.35，且只保留与本次最高分相差 ≤ 0.20 的候选（`recall.semanticCutoff` 是实际生效值）。跨语言配对的余弦普遍低于同语言，单一高阈值会整份英文资料都召不回来。
- 每份资料最多贡献 5 条语义候选，既防止一份长文档垄断召回，也不至于把该文档内的目标片段挤掉。

**已知召回边界（控制台不要承诺"一定在首屏"）**：本轮真实验收里，跨语言与跨文档的次要目标段落**能被召回但不在全局 Top 5**。实测（bge-m3，四份整篇材料共 175 片段）：

| 查询 | 主目标 | 次要目标 | 次要目标名次 | 目标片段余弦 | 同资料内最高分片段 |
| --- | --- | --- | ---: | ---: | --- |
| 负责人换班 | SapperLens `§6.4` **第 1** | nvwabase `§2`（英文） | 20 | 0.4237 | `§4` 0.4774 |
| 负责人换班 | 同上 | ledger `§六批、五次交接` | 13 | 0.4843 | `§两处交接改动` 0.5371 |
| 接任指挥后怎样续上进度 | SapperLens `§6.4` **第 1** | nvwabase `§2`（英文） | 19 | 0.4319 | `§4` 0.4669 |

原因是模型给中英跨语言配对的相似度普遍低于同语言，且同一份文档内另有话题更"泛交接"的片段得分更高。
控制台建议：命中列表默认展示 Top N 但**允许按资料筛选/分组**（`materialId` + `parentLocator` 足够做分组），并把 `semanticScore` 显示出来，让用户自己判断相关性；不要只给前 5 条就断言"没有相关资料"。

### 3.5 索引状态与降级行为

```ts
type KnowledgeEmbeddingState =
  | "ready" | "indexing" | "pending" | "disabled" | "unconfigured" | "unavailable" | "error";

type KnowledgeVersionIndexState = {
  versionId: string; state: KnowledgeEmbeddingState;
  totalChunks: number; indexedChunks: number; failedChunks: number;
  indexKey: string | null; lastError?: string; updatedAt?: string;
};

type KnowledgeEmbeddingProvider = "local" | "cloud";

type KnowledgeEmbeddingServiceStatus = {
  provider: KnowledgeEmbeddingProvider;
  baseUrl: string; model: string; modelDim: number | null; indexKey: string;
  state: KnowledgeEmbeddingState;
  versions: number;          // 该服务在本范围内负责的资料版本数
  totalChunks: number; indexedChunks: number; pendingChunks: number; failedChunks: number;
  allowed: boolean;          // 本次读者范围是否允许把正文与查询发给该服务
  degradedReason?: string; lastError?: string;
};

type KnowledgeIndexStatus = {
  state: KnowledgeEmbeddingState;
  model: string | null;      // 例 "bge-m3-mlx-4bit"
  modelDim: number | null;   // 例 1024
  provider: string | null;   // 例 "http://127.0.0.1:8000/v1"（不含凭据）
  providerKind: KnowledgeEmbeddingProvider | null;  // 本范围实际生效的服务商
  chunkerVersion: number;    // 例 2
  indexKey: string | null;   // 例 "c2|local|http://127.0.0.1:8000/v1|bge-m3-mlx-4bit"
  totalChunks: number; indexedChunks: number; pendingChunks: number; failedChunks: number;
  blockedChunks: number;     // 已索引但所属服务未获本范围授权，不参与语义召回
  services: KnowledgeEmbeddingServiceStatus[];
  degraded: boolean;         // true = 本次检索实际只用了关键词
  degradedReason?: string;   // 中文原因，直接展示
  lastError?: string; lastIndexedAt?: string;
};
```

**索引指纹**是 `c<切分版本>|<服务商>|<规范化服务地址>|<模型>`。服务地址按小写协议与主机、去默认端口/查询串/尾斜杠规范化，因此同一服务的两种写法不会产生两套索引；**同名模型挂在不同服务上指纹不同**，向量不混用。读写向量时还会核对实际维度，维度不符的行一律不算已索引。

**服务商与资料归属**：`provider` 是工作区选定的服务。团队共享资料按它走；委托专属资料**默认本地**，只有 `cloudEngagements` 里明确列出的委托才可发往云端。导入后的后台索引、重试、重建与查询都执行同一规则。未获授权的服务既收不到查询文本，它的向量也不参与该范围的语义召回，这部分片段计入 `blockedChunks`。

**降级矩阵（HTTP 一律 200，检索照常返回）**：

| 情况 | `index.state` | `degraded` | 控制台应当 |
| --- | --- | --- | --- |
| 索引灌满 | `ready` | false | 正常展示混合结果 |
| 刚导入 / 正在灌 | `indexing` / `pending` | true 直到探测到维度 | 展示"语义索引建立中（indexedChunks/totalChunks）"，结果标注只含关键词 |
| 设置里停用 | `disabled` | true | 展示"语义检索已关闭"，给去设置的入口 |
| 未配置模型/地址 | `unconfigured` | true | 引导配置本地 embedding |
| 本地/云端服务不可达 / 报错 | `unavailable` / `error` | true | 展示 `degradedReason` 与 `lastError`，给**重试**按钮 |
| 请求显式 `mode=keyword` | 不变 | true | 标注"本次只用关键词"，`degradedReason` 会这么写 |
| 范围内有未获授权服务的片段 | 不变 | 该路无命中时 true | 展示 `blockedChunks`，说明这些片段不参与语义召回 |

**降级不是错误**：关键词一路始终可用，精确值检索不受影响。控制台不要把它渲染成失败态或空结果。

**重试与重建**：

```bash
# 只重试失败/未就绪的版本
curl -sS -X POST "$BASE/knowledge/index/retry?engagementId=$ENG" \
  -H 'content-type: application/json' -d '{}'
# → 202 { scope, queued: ["<versionId>", ...], status: KnowledgeIndexStatus }

# 重切分 + 重新向量化（可限定资料或版本）
curl -sS -X POST "$BASE/knowledge/index/rebuild?engagementId=$ENG" \
  -H 'content-type: application/json' -d '{"materialId":"<mid>"}'
# → 202 { scope, versions: ["<versionId>", ...], status: KnowledgeIndexStatus }
```

- 两者都按服务端可见范围执行；`materialId` 越界 → **404**。
- **重建不改资料版本**：`versionNo`、`contentSha256`、快照、已有引用全部不变。控制台可以放心提供"重建索引"按钮，并说明"不影响已定版引用"。
- 重建只删**当前指纹**下的向量，另一套服务已建好的向量留在盘上，切回去不必重算。
- 换模型或换服务会换 `indexKey`，旧向量留在盘上但不与新指纹混用；需要重建才会灌新索引。
- **停用再启用同一模型**后维度需重新探测，此时版本状态是 `pending`（不是 `ready`），单击重试即恢复 `ready`，不需要整库重建。
- 切换服务/模型时在途请求的迟到响应按发起时的指纹判定，过期即丢弃，不写入新索引。

**向量化配置（本地与云端两套）**：

```bash
curl -sS -X PUT "$BASE/settings/knowledge-embedding" \
  -H 'content-type: application/json' -d '{
    "enabled": true,
    "provider": "local",
    "cloudEngagements": [],
    "local": {
      "baseUrl": "http://127.0.0.1:8000/v1",
      "model": "bge-m3-mlx-4bit",
      "apiKeyEnv": "OMLX_API_KEY",
      "batchSize": 16, "timeoutMs": 30000
    },
    "cloud": {
      "baseUrl": "https://api.example.com/v1",
      "model": "<embedding 模型 id>",
      "apiKeyEnv": "GY_CLOUD_EMBEDDING_API_KEY",
      "batchSize": 16, "timeoutMs": 30000
    }
  }'
```

- 两套配置**分别保存**，切回来恢复原配置；patch 是深合并，只传一套不会清掉另一套。
- `GET /settings` 的 `knowledgeEmbedding` 每套各回带 `apiKeyConfigured` / `apiKeyMask`，**不回明文密钥**；回传掩码或空串不覆盖该套已存密钥，也不影响另一套。
- 密钥优先从**该套自己的** `apiKeyEnv` 读，其次用该套登记的 `apiKey`。选云端时绝不读本机 `OMLX_API_KEY`。
- **升级迁移**：首版的扁平配置（`baseUrl`/`model`/`apiKeyEnv`/`apiKey`/`batchSize`/`timeoutMs` 直接挂在 `knowledgeEmbedding` 上）自动搬进 `local`，`provider` 保持 `local`，云端保持未配置。资料版本、原文快照与定版引用不受影响。

首次从空地址配置云端服务时，预填的密钥环境变量名可能被清空。可在控制台密钥框填写凭据，或显式指定另一个已配置的环境变量名。

**测试连接**

```bash
curl -sS -X POST "$BASE/settings/knowledge-embedding/test" \
  -H 'content-type: application/json' -d '{
    "provider": "cloud",
    "service": { "baseUrl": "https://api.example.com/v1", "model": "<id>", "apiKey": "<可选草稿密钥>" }
  }'
# → 200 { provider, baseUrl, model, probeText, ok: true, dim: 1024, durationMs: 22 }
# 失败 → 200 { ..., ok: false, error: "云端服务返回 404：..." }
```

`service` 是可选草稿，可在保存前试连接；同一来源下密钥留空或回传掩码会沿用已存密钥。更换来源需要登记相应凭据。后端只发固定合成短句
`GongYuAI 向量化连通性探测 synthetic embedding probe`，核对返回的是有效向量并报告**实测维度**；
不写索引、不改维度缓存、不触发任何重建。停用时也允许测试。

**本机模型准备（一次性）**：默认模型 `bge-m3-mlx-4bit` 是中英多语 embedding（XLM-RoBERTa，1024 维，8192 token 上下文），跑在本机 oMLX 上。若 `/v1/models` 里没有它：

```bash
# 1) 落到 oMLX 的模型目录（org/name 布局）
DEST=~/omlx-models/mlx-community/bge-m3-mlx-4bit
mkdir -p "$DEST"
BASE=https://huggingface.co/mlx-community/bge-m3-mlx-4bit/resolve/main
for f in config.json config_sentence_transformers.json model.safetensors.index.json \
         modules.json sentence_bert_config.json special_tokens_map.json \
         tokenizer.json tokenizer_config.json model.safetensors; do
  curl -sSL --fail -o "$DEST/$f" "$BASE/$f"
done

# 2) 让 oMLX 重新发现模型（admin 路由用主 API key，不是推理子 key）
KEY=$(python3 -c "import json;print(json.load(open('$HOME/.omlx/settings.json'))['auth']['api_key'])")
curl -sS -X POST -H "Authorization: Bearer $KEY" http://127.0.0.1:8000/admin/api/reload

# 3) 确认
curl -sS -H "Authorization: Bearer $(cat ~/.omlx/api-key)" http://127.0.0.1:8000/v1/models
```

换别的中英模型只需改 `settings.knowledge-embedding.local.model`，然后 `POST /knowledge/index/rebuild`。`indexKey` 会随模型变化，旧向量不与新模型混用。

### 3.6 命中片段的原文与上下文

`GET /knowledge/materials/:mid/versions/:vid/section?locator=<enc>`

```ts
type KnowledgeSectionContext = {
  headingPath: string[];
  parentLocator: string;
  parentCharStart: number; parentCharEnd: number;
  parentText: string;       // 所属整章原文（从版本快照回读）
  previous: { locator: string; text: string } | null;  // 同章上一片
  next: { locator: string; text: string } | null;      // 同章下一片
};

// 响应
{ material: KnowledgeMaterial, version: KnowledgeVersion,
  section: KnowledgeSection, context: KnowledgeSectionContext }
```

控制台命中详情页建议：`section.text` 作正文，`context.headingPath` 作面包屑，`context.previous/next` 作"上一段/下一段"，`context.parentText` 作"查看整章"。长章节被切片时，整章原文仍然一次取得到。

### 3.7 从命中片段创建定版引用（控制台主流程）

```ts
type MaterialCitationInput = {
  materialId: string; versionId: string;
  locator: string;          // 直接取 hit.locator
  claim: string;            // 这条引用支持报告里的哪句话，必填 ≤2000
  engagementId?: string;    // 仅用于定位；与服务端任务归属冲突 → 409
  charStart?: number;       // 取 hit.charStart
  charEnd?: number;         // 取 hit.charEnd
  chunkSha256?: string;     // 取 hit.chunkSha256
};
```

**推荐做法：把命中里的四个定位字段原样回传。**

```ts
const hit = searchResult.hits[0];
await POST(`/tasks/${taskId}/citations`, {
  materialId: hit.materialId,
  versionId: hit.versionId,
  locator: hit.locator,
  charStart: hit.charStart,
  charEnd: hit.charEnd,
  chunkSha256: hit.chunkSha256,
  claim: "独立分析从运行记录中追到了一次负责人换班（06:14 换任，靠 STATE 续接）",
});
```

服务端校验与保证：

- `charStart` / `charEnd` 必须**同时**给出，且 `charEnd > charStart`，否则 **400**。
- 给出的范围必须与 `locator` 指向的片段**完全一致**，否则 **409**（错误文案带两个范围，便于排查）。
- 给出的 `chunkSha256` 必须与该片段正文一致，否则 **409**（提示"请重新检索后再引用"）。
- **只传 `locator` 也可以**：服务端会自己解析出范围并补上片段校验值。也就是说**新引用一律是范围定版**，回读不依赖切分与索引。
- 待补正文版本不能建引用 → **409**；知识库快照缺失/校验失败 → **409**；资料越界 → **404**。

```ts
type CitationPinKind = "range" | "locator";

type MaterialCitation = {
  id: string; taskId: string; engagementId: string;
  materialId: string; versionId: string; locator: string; claim: string;
  snapshotSha256: string;   // = 被引用版本的 contentSha256
  bodyFormat: KnowledgeBodyFormat;
  materialTitle: string; publisher: string; sourceKind: KnowledgeSourceKind;
  versionNo: number; versionLabel: string;
  sectionHeading: string | null; sectionPage: number | null; sectionOrdinal: number;
  createdAt: string;
  pinKind: CitationPinKind;      // 新建恒为 "range"；"locator" 只出现在升级前的旧引用
  charStart: number | null; charEnd: number | null;
  chunkSha256: string | null;
  headingPath: string[];
  pageBasis: KnowledgePageBasis | null;
};
```

### 3.8 回读、复验与导出

```ts
type CitationUnverifiableReason =
  | "snapshot_missing" | "sha256_mismatch" | "locator_not_found"
  | "body_pending" | "material_out_of_scope"
  | "range_out_of_bounds"   // 新增：登记范围超出快照正文
  | "chunk_sha_mismatch";   // 新增：范围切出的片段与登记校验值不一致

type CitationVerification = {
  status: "verified" | "unverifiable";
  reason?: CitationUnverifiableReason;
  expectedSha256: string; recomputedSha256?: string;
  source: "task-seal";      // 复验读任务侧密封件，不依赖知识库快照、索引或上游
  detail?: string;
};

type ResolvedCitation = {
  citation: MaterialCitation;
  verification: CitationVerification;
  paragraph?: KnowledgeSection;   // 仅 verified 时给出
  versionStatus?: KnowledgeVersionStatus;
  librarySnapshotAvailable: boolean;
};
```

**回读路径**：

- `pinKind === "range"`：从密封快照按 `[charStart, charEnd)` 切片，复算片段 SHA-256 与登记值比对。**完全不查索引、不查片段表**，因此重切分、换模型、重建索引都不影响它。
- `pinKind === "locator"`（升级前的旧引用）：沿用**旧切分**回读，保证升级前后读到的是同一段。验收用上一轮真实的 SapperLens v1 引用证明了这一点（旧整章 1910 字符、范围 `[0,1910)`、片段校验值与快照校验值全部一致）。

```ts
type ExportSnapshotScope = "full-version" | "paragraph" | "none";

type KnowledgeReportExport = {
  version: 1; kind: "knowledge-report-export";
  taskId: string; engagementId: string; exportedAt: string;
  scope: KnowledgeReaderScope;
  snapshotScope: ExportSnapshotScope;   // 新增：说明本次打包的字节范围
  report: { path: string; sha256: string; markdown: string } | null;
  citations: Array<{
    citation: MaterialCitation;
    verification: CitationVerification;
    paragraph?: KnowledgeSection;
    snapshot?: { sha256: string; byteSize: number; bytesBase64: string };
  }>;
  withheld: { outOfScopeCitations: number };
};
```

**导出到底打包了什么（必须向用户说清）**：

| `?snapshot=` | `snapshot.bytesBase64` 内容 | `snapshot.sha256` |
| --- | --- | --- |
| `full-version`（默认） | **整份版本快照**（整篇文章的正文字节） | 版本的 `contentSha256` |
| `paragraph` | **只有被引用的那一段**原文字节 | 片段的 `chunkSha256` |
| `none` | 不打包字节（字段缺省） | — |

三种模式下 `paragraph` 字段都会给出被引用段落（verified 时），`citation` 与 `verification` 也都在。默认整份快照是为了让收件人能离线复算版本校验值；只给片段则包体小得多，但收件人无法复算整版本校验值——控制台应把这个取舍显示出来。

**收件范围校验覆盖到哪里（如实呈现，不要夸大）**：

- 覆盖：按**服务端任务归属**过滤资料，范围外资料不打包、不给 ID 与标题，只计入 `withheld.outOfScopeCitations`。
- **不覆盖**：收件人身份认证（本环境无认证层）、导出包离开本机后的流向、收件人是否有权阅读该委托。
- 控制台若要展示"有 N 条未打包"，不要尝试补出它们的 ID。

---

## 4. 关键状态与错误

| HTTP | 含义 | 控制台建议呈现 |
| --- | --- | --- |
| 200 | 成功；导入时表示**复用已有版本** | 区分"已存在"与"新版本" |
| 201 | 新建资料版本 / 新建引用 | |
| **202** | 索引重建/重试**已排队**，尚未完成 | 展示进度并轮询 `/knowledge/index` |
| 400 | 请求体校验失败（zod）、`limit` 非正整数、`mode` 非法、`snapshot` 非法、缺 `locator`、范围只给一半 | 展示 `error` 原文 |
| 404 | 不存在**或不在当前可见范围**（两者不区分，避免泄露存在性） | 统一文案"资料不存在或不在当前委托的可见范围" |
| 405 | 该路径不支持此方法 | |
| 409 | 委托上下文冲突；待补正文不能建引用；快照缺失/校验失败无法密封；**原文范围或片段校验值与定位不一致** | 展示 `error`，引导重新检索 |

错误体统一 `{ "error": "<中文说明>" }`。

**业务状态（HTTP 200，但需要在 UI 上区分）**：

| 状态 | 字段 | 含义与呈现 |
| --- | --- | --- |
| 待补正文 | `bodyStatus: "pending_body"` + `bodyStatusReason` | 只有链接或提取为空。**不得显示成全文命中**；片段列表为空 |
| 仅标签命中 | `tagOnly: true`，`matchedFields: ["tags"]` | 明确标注"仅标签命中，正文未出现该查询词" |
| 语义命中 | `matchedFields` 含 `semantic` 且不含 `body` | 标注"语义相近"，**不要**写成"正文命中" |
| 章节地址命中 | `matchedFields` 含 `locator` | 标注"章节定位命中" |
| 索引降级 | `index.degraded: true` + `degradedReason` | 明确提示本次只有关键词一路，给重试/配置入口 |
| 旧版停用 | `versionStatus: "deprecated"` | 检索默认给有效版；旧引用仍可回读，报告保留停用提示 |
| 无法复验 | `verification.status: "unverifiable"` + `reason` | 一等状态，给出 `expectedSha256` 与 `recomputedSha256`，不要静默跳过 |
| 快照健康度 | 版本详情 `snapshotState: "ok" \| "missing" \| "corrupt"` | 知识库侧，与任务侧密封件分开 |
| 历史页码不可确认 | `pageBasis: "legacy-paragraph"` | 标注"早期提取按空行推算，物理页码无法确认"；正文与校验值不受影响 |

---

## 5. 最小调用示例

服务地址以 `GY_HOST:GY_PORT` 为准（默认 `127.0.0.1:8787`）。

```bash
BASE=http://127.0.0.1:8787
ENG=eng-demo

# 1) 整篇导入（不挂同词标签）→ 201，index.state 通常是 pending
curl -sS "$BASE/knowledge/materials" -H 'content-type: application/json' -d '{
  "title":"SapperLens 独立运行分析（整篇 README）","publisher":"inwpu（独立运行分析）",
  "sourceKind":"original","format":"markdown",
  "sourceUrl":"https://raw.githubusercontent.com/inwpu/SapperLens/main/README.md",
  "content":"<整篇 markdown>",
  "tags":[],
  "upstreamCommit":"eebd7ce31c5d6620f1e760b80de774484568c94b",
  "scope":{"kind":"engagement","engagementId":"eng-demo"}}'

# 2) 等索引就绪
curl -sS "$BASE/knowledge/index?engagementId=$ENG"
# → { index: { state:"ready", model:"bge-m3-mlx-4bit", modelDim:1024,
#              indexKey:"c2|local|http://127.0.0.1:8000/v1|bge-m3-mlx-4bit", indexedChunks:136, totalChunks:136, degraded:false } }

# 3) 混合检索（默认）与关键词基线对比
curl -sS "$BASE/knowledge/search?q=%E8%B4%9F%E8%B4%A3%E4%BA%BA%E6%8D%A2%E7%8F%AD&engagementId=$ENG"
curl -sS "$BASE/knowledge/search?q=%E8%B4%9F%E8%B4%A3%E4%BA%BA%E6%8D%A2%E7%8F%AD&mode=keyword&engagementId=$ENG"
# 关键词 total=0（原文没有这个整词）；混合命中 §6.4，matchedFields=["semantic"]

# 4) 打开命中片段与上下文
curl -sS "$BASE/knowledge/materials/$MID/versions/$VID/section?locator=%C2%A76.4&engagementId=$ENG"

# 5) 用命中的定位字段建定版引用
curl -sS "$BASE/tasks/$TASK/citations" -H 'content-type: application/json' -d '{
  "materialId":"'$MID'","versionId":"'$VID'","locator":"§6.4~2",
  "charStart":32670,"charEnd":32899,
  "chunkSha256":"58649efc82a9417b33f7489302e9206ef44b4493719a22199791877d645d8293",
  "claim":"独立分析从运行记录中追到了一次负责人换班（06:14 换任，靠 STATE 续接）"}'
# → 201 { citation: { pinKind:"range", snapshotSha256:"...", chunkSha256:"..." } }

# 6) 重建索引后回读，仍是同一段
curl -sS -X POST "$BASE/knowledge/index/rebuild?engagementId=$ENG" -H 'content-type: application/json' -d '{}'
curl -sS "$BASE/tasks/$TASK/citations/$CID/resolve"

# 7) 离线导出：整份快照 / 只要引用片段
curl -sS "$BASE/tasks/$TASK/report-export"
curl -sS "$BASE/tasks/$TASK/report-export?snapshot=paragraph"
```

---

## 6. 控制台实现要点

1. **来源类型必须可见**：`original` 原文 / `excerpt` 摘录 / `editorial` 编辑导读。整篇导入默认 `original`。
2. **本地版号与上游版本分开显示**：`versionLabel`（本地 v1）与 `upstreamVersion` / `upstreamCommit` 是两件事。
3. **命中原因分五档**：见 §3.4 的表。`semantic` 不得显示成正文命中；`tagOnly` 必须显式标注。
4. **面包屑用 `headingPath`**，整章入口用 `parentLocator`；长章节被切片时不要让用户以为文章只有半段。
5. **索引状态是一等 UI**：`index.state` + `indexedChunks/totalChunks` + `degradedReason`。降级不是错误，给重试与配置入口，不要显示空结果。
6. **重建索引可以放心提供**：明确写"不影响已定版引用与资料版本"。
7. **建引用就回传命中的四个定位字段**（`locator` / `charStart` / `charEnd` / `chunkSha256`）。409 时提示"资料已更新，请重新检索"，不要自己改范围重试。
8. **待补正文**：只展示元数据与 `bodyStatusReason`，片段列表为空，不能建引用（409）。
9. **默认检索有效版**：不传 `versionId` 时后端只用 `effectiveVersionId`。看历史片段先取版本列表再按 `versionId` 读 `section`。
10. **旧版停用提示**：`resolve` 的 `versionStatus === "deprecated"` 时提示"该版本已停用，本引用仍按当时定版回读"。
11. **无法复验是一等状态**：展示 `reason`、期望与实算 SHA-256，不要隐藏或降级成空白。
12. **PDF 页码**：`pageBasis === "legacy-paragraph"` 必须标注页码不可确认；`physical-page` 才是可信物理页号。
13. **范围以响应里的 `scope` 为准**：切换委托时重新拉取清单/检索/摘要/索引状态，不要在前端缓存跨委托结果。
14. **越界统一 404**：不要根据错误文案推断"该资料存在于别的委托"。
15. **导出取舍要显示**：`snapshotScope` 决定打包整份快照还是只有引用片段；`withheld.outOfScopeCitations` 只给数量。

---

## 7. 后端落点与复现

| 能力 | 文件 |
| --- | --- |
| 契约类型 | `packages/contracts/src/knowledge.ts` |
| 整篇切片 / PDF 物理页 / 旧切分兼容 | `packages/control-plane/src/knowledge-parse.ts` |
| 本地/云端 embedding 客户端、服务商指纹、测试连接 | `packages/control-plane/src/knowledge-embed.ts` |
| 单服务向量索引存储、后台灌索引、重试/重建 | `packages/control-plane/src/knowledge-index.ts` |
| 双服务路由、按范围授权与读数聚合 | `packages/control-plane/src/knowledge-index-pool.ts` |
| 持久化 / 导入 / 混合检索 / 摘要 | `packages/control-plane/src/knowledge.ts` |
| 范围解析 / 引用 / 复验 / 导出 / 路由 | `packages/control-plane/src/knowledge-api.ts` |
| 引用密封与回读白名单 | `packages/history/src/index.ts`（`material_citations`、`recordMaterialCitation`、`readProofVersion`） |
| 报告渲染 | `packages/history/src/report.ts`（「## 参考资料引用（定版）」，含原文范围与页码依据） |
| 路由挂载 / 向量化设置入口 | `packages/control-plane/src/server.ts` |

存储布局（数据根内）：

```text
<dataRoot>/knowledge.sqlite                       资料 / 版本 / 片段 / chunk_embeddings / chunk_index_state
<dataRoot>/knowledge/snapshots/<sha256>           内容寻址快照（0600）
<dataRoot>/tasks/<taskId>/history.sqlite          material_citations + evidence_versions（密封件）
<dataRoot>/tasks/<taskId>/report-evidence/<sha>   报告离线附件
```

复现命令：

```bash
# 单元与隔离回归（隔离数据目录，向量走本机 stub HTTP 服务，确定性）
node --import tsx --test packages/control-plane/src/knowledge.test.ts \
  packages/control-plane/src/knowledge-isolation.test.ts \
  packages/control-plane/src/knowledge-hybrid.test.ts \
  packages/control-plane/src/knowledge-provider.test.ts

pnpm typecheck && pnpm test && pnpm build                 # 全仓 173 项测试

# 关键词基线验收（摘录导入，显式停用向量化）
pnpm knowledge:acceptance                                 # 40 项

# 整篇导入 + 真实本机 embedding 的混合检索验收
OMLX_API_KEY=$(cat ~/.omlx/api-key) pnpm knowledge:hybrid-acceptance   # 57 项
```

`knowledge:hybrid-acceptance` 的数据根隔离在 `out/knowledge-hybrid-<runId>/`，不触碰正式 `.gongyuai`；证据写入 `docs/evidence/knowledge-library/<runId>/`。它会把上一轮真实数据根**复制一份**再升级，用来验证旧引用回读一致性，不改动原始运行数据。断网阶段在子进程里清除环境代理、按主机名拒绝非回环出站，并**停用向量化**，证明定版回读连本地 embedding 服务都不需要。
文章验收脚本使用上游文章、本机模型以及两份 PDF。仓库中的验收样本为 `docs/2310.08560v2.pdf`（MemGPT v2）。升级验收还需要首轮保留的 `out/knowledge-1795404972071/` 数据根。知识库单元和 HTTP 回归测试使用隔离的合成样本。

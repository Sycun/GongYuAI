# 向量化设置四缺陷修复 · 页面验收记录

2026-11-23。运行号 `provider-fix-1795425396`（本机替身 + 真实 oMLX 两轮）。
数据根隔离在 `out/knowledge-provider-fix-1795425396/`，未触碰正式 `.gongyuai`。

**操作方式**：Qoder Browser Connector 驱动真实 Chrome 打开真实控制台页面（vite dev + 真实 `bootControlPlane`），
所有配置切换、测试连接、保存、撤权、重试、重建、检索都通过页面真实控件完成；
密钥类字段受浏览器敏感字段保护不代输，涉及密钥登记的步骤经控制面 API（值不回显、日志只记布尔）。
证据为页面读数、替身服务逐请求 JSONL（含 `held` 在途标记）、SQLite 行数与 SHA-256 复算、API 快照与一张页面截图。

## 环境

| 项 | 值 |
| --- | --- |
| 控制面（替身轮） | `http://127.0.0.1:8879`（隔离数据根 `data/`） |
| 控制面（oMLX 轮） | `http://127.0.0.1:8880`（隔离数据根 `data-omlx/`，注入 `OMLX_API_KEY`，不回显） |
| 控制台 | vite dev `5174` / `5175`，代理各自控制面 |
| 本地替身（慢） | `http://127.0.0.1:8898/v1` · `stub-local-8dim` · 8 维 · **2300ms/请求**（P1）后调 0 |
| 云端替身 A | `http://127.0.0.1:8899/v1` · `stub-cloud-12dim` · 12 维 · 期望密钥 `acc-key-A`（假密钥） |
| 云端替身 B | `http://127.0.0.1:8900/v1` · `stub-cloud-12dim` · 16 维 · 期望密钥 `acc-key-B`（假密钥） |
| 维度错配替身 | `http://127.0.0.1:8901/v1` · `stub-dim-broken` · 探测 12 维 / 正文 3 维（可恢复为一致 3 维） |
| 真实本机模型 | `http://127.0.0.1:8000/v1` · `bge-m3-mlx-4bit` · 实测 1024 维 · **真实 oMLX** |
| 真实云端（项目 `.env`） | `https://api.deepseek.com/v1` · `text-embedding-3-small` · `apiKeyEnv=OPENAI_API_KEY` |
| 替身控制 | `POST /__control`（维度/延迟/期望密钥/`holdCall` 悬挂第 N 个请求、`release` 放行），用于确定性制造「在途」窗口 |

替身日志只记录凭据**是否出现/是否符合期望**（布尔），绝不含密钥原文；公开视图同样只有掩码。

## 1 · 问题一：慢响应 + 页面轮询时重试卡死（已修复）

页面流程：索引就绪 → 停用并保存（`向量化已停用`，维度 `—`，0/2）→ 重新启用并保存（`等待索引`，`modelDim=null`，0/2）
→ **只点一次「重试失败/未就绪片段」**。

| 观察点 | 读数 |
| --- | --- |
| 重试受理 | 页面出现「已排队」标签，索引卡进入「正在索引」（后端 202，1 个版本入队） |
| 在途期间 | 替身 `local-slow` 收到探测请求（2300ms 延迟在途）；页面每 1.5s 轮询 |
| 终态 | **`索引就绪` · 实测维度 8 · 2/2 · 待索引 0**（替身时间线 `09:27:15` 探测→就绪，全程只有一次重试点击） |
| 再次点重试 | 页面 Banner + Toast「**没有需要重试的资料。**」，`queued=[]`，不出现假「已排队」 |

修复位置：`KnowledgeIndex.setClient`（配置语义未变时保持客户端对象不动，轮询刷新不再替换对象）；
`ensureDim`/`queryVector` 的有效性判定从对象引用改为 epoch（服务指纹 + 启用状态），同配置轮询不作废在途探测。

## 2 · 问题二：撤销云端授权后待发送正文仍外发（已修复）

页面流程：云端替身 A（batchSize=2）+ `cloudEngagements=[eng-a, eng-b]`；重建 A（4 片段=2 批）、B、共享索引；
用 `holdCall` 把 **A 的首批悬挂在途**（`09:47:41.380`，`held=true`，输入含 `gy-a-marker` 标记），
随后在页面「允许云端处理的委托」里移除 `eng-a` 并保存（撤权落盘 `cloudEngagements=['eng-b']`），再放行在途请求。

| 观察点 | 读数 |
| --- | --- |
| 撤权后云端请求数 | 自撤权起云端替身 A **零新增 A 正文请求**（`09:48` 后 embeddings 请求数=0，`calls` 停在 5） |
| 在途结果 | A 首批响应回来后**未写入**：A 版本在云端指纹下 `chunk_embeddings` 行数 = **0** |
| 未发送批次 | A 第二批（`gy-a-marker-3/4`）从未发出 |
| 共享资料与仍授权委托 | 共享 2/2 `ready`、委托 B 1/1 `ready`，其批次在撤权后照常发往云端 |
| A 回本地 | 页面切「指定委托」→ 显示 `等待索引` + 云端「本范围未授权」+ blockedChunks 提示 → 点重试 → 本地 `索引就绪 6/6`（8 维） |
| 后续查询 | 页面检索「负责人换班」命中 A 资料（语义相近 · 余弦 0.949，本地向量召回），检索后云端调用数仍为 5，**查询文本零外发** |

修复位置：`KnowledgeIndex` 注入 `owns(versionId)`（池按当前路由实时判定）；`indexVersion` 出队即判、
每批发送前与写库前都重判（`fresh()` 扩为 epoch + owns）。撤权后未发送批次不再外发、在途结果不写入。
连带修复：`drain()` 在失败冷却期内不再让队列永久停摆（冷却结束自动重排，见回归测试「失败冷却结束后队列自动恢复」）。

## 3 · 问题三：正文维度与探测不一致仍显示就绪（已修复）

页面流程：本地服务切到 `dim-broken` 替身（探测 12 维、正文 3 维）并保存，导入新合成资料。

| 观察点 | 读数 |
| --- | --- |
| 错配时页面 | **`索引出错`（红）** · 维度 `—` · 0/4 · 待索引/失败 2/2 · Banner「本地服务返回的向量维度 3 与探测维度 12 不一致」 |
| 落库 | 整批未写入（维度不符时 0 行落库；`EmbeddingDimMismatch` 抛出前不写） |
| 服务恢复（探测/正文一致 3 维） | 页面点一次「重试」→ **`索引就绪` · 实测维度 3 · 4/4**；落库向量 `dim=3`；语义检索命中（余弦 0.949） |

修复位置：`EmbeddingClient.request` 增加期望维度逐条校验（数量、维度、数值有限性），
`EmbeddingDimMismatch` 触发维度缓存作废，重试即重新探测；`KnowledgeIndex` 逐批写入、批内任一项无效整批不落库。

## 4 · 问题四：换云端地址沿用旧密钥（已修复）

两把假密钥 `acc-key-A` / `acc-key-B`，两个隔离替身。A 先经 API 登记密钥（浏览器不代输敏感字段），其余步骤全部页面操作。

| 步骤（页面） | 替身实收凭据（布尔） |
| --- | --- |
| A（已存密钥）测试连接 | cloud-A：`present=true, matchesExpected=true` |
| 草稿改地址到 B、密钥留空，「测试连接」 | cloud-B：`present=false`（**不继承 A 密钥**；Banner 同步提示「已换到不同来源，需重新登记密钥」） |
| 保存 B（密钥留空） | 视图 `apiKeyConfigured=false`；页面占位变为「可选，直接登记密钥」 |
| 刷新页面后用已存配置测试连接 | cloud-B：`present=false` |
| 切回 A（密钥留空）测试连接 | cloud-A：`present=false`（B 的保存已清掉旧密钥，**切回不复活**） |
| A 同来源改路径（/v1→/v2）留空保存、测试连接 | cloud-A：`present=true, matchesExpected=true`（**同来源留空保号**） |

真实密钥从未出现在日志、浏览器响应或本记录中（替身只记 `present/matchesExpected` 布尔）。

修复位置：`mergeEmbeddingService`（`settings.ts`）按「来源」（规范化地址 origin）判定：换来源时
留空/掩码密钥不再沿用、与旧地址相同的环境变量名被清空；同一来源维持保号。草稿「测试连接」走同一合并逻辑。
连带修复：zod `.partial()` 与字段默认值叠加导致**部分补丁把已存配置覆盖成默认值**（只改超时即清空地址/模型）——
契约层新增无默认值的 `KnowledgeEmbeddingServicePatchSchema`，见回归测试「部分补丁只覆盖给出的字段」。

## 5 · 真实本机模型（oMLX）轮

新数据根 + 独立控制面（8880），`OMLX_API_KEY` 注入进程环境（值不回显）。

| 步骤 | 读数 |
| --- | --- |
| 页面「测试连接」 | **连接成功 · `bge-m3-mlx-4bit` · 实测维度 1024 · 42ms · `http://127.0.0.1:8000/v1`** |
| 保存 + 导入合成资料 | 索引 `ready 2/2`，`modelDim=1024`，指纹 `c2\|local\|http://127.0.0.1:8000/v1\|bge-m3-mlx-4bit` |
| 页面语义检索「负责人换班」 | 命中 2 段 · 语义召回 2 · 余弦 **0.706** / 0.609（真实模型质量） |
| 定版引用与回读 | range 定版 [36,75)，resolve `verified`；段落「## 值班交接\n\n负责人换班按 STATE 文件执行…」 |
| SHA-256 复算 | 复算值与登记 `chunkSha256` **一致**（`omlx-resolve.json`）；`report-export?snapshot=paragraph` 打包同段，sha256 一致 |

## 6 · 真实云端缺项（与上一轮结论一致）

页面用项目 `.env` 的云端配置（`https://api.deepseek.com/v1` + `text-embedding-3-small` + `OPENAI_API_KEY`）
实测「测试连接」：**连接失败：云端服务返回 404 `not_found_error`**（DeepSeek 不提供 `/embeddings`）。
缺的是「支持 OpenAI 兼容 `/embeddings` 的云端地址与 embedding 模型 ID」，不是代码或凭据。
因此「真实本地 → 真实云端 → 本地」整环未执行，如实记为缺项；本机替身完整覆盖了该环（本地慢速替身 ↔ 云端 A 替身互切，见第 1、2 节），
真实本地（oMLX）单独成环验收（第 5 节）。补齐云端地址与模型 ID 后按第 5 节同样步骤即可复跑。

## 证据文件

- `local-slow.jsonl` / `cloud-A.jsonl` / `cloud-B.jsonl` / `dim-broken.jsonl`：逐请求时间线（n、dim、held、凭据布尔、输入正文）
- `stub-summary.json`：四个替身的请求数/维度/凭据布尔汇总
- `p1-final-index.json`、`stubrun-final-{settings,index}.json`：替身轮终态
- `omlx-final-{settings,index,page.png}`、`omlx-hit.json`、`omlx-resolve.json`、`omlx-report-export.json`、`omlx-run-meta.txt`：真实 oMLX 轮证据
- 自动化回归：`packages/control-plane/src/knowledge-provider.test.ts`（13 项全绿，覆盖四个问题 + 冷却恢复 + 部分补丁保字段）

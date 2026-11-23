# 整篇导入 + 混合检索后端验收记录

运行编号：knowledge-hybrid-1795411122521　生成时间：2026-11-23T05:19:16.825Z

数据根（隔离）：`/Users/sycpro/GongYuAI/out/knowledge-hybrid-1795411122521`　服务：真实进程 + 回环 HTTP

结果：55/57 通过，2 未通过。

复现：`OMLX_API_KEY=$(cat ~/.omlx/api-key) pnpm knowledge:hybrid-acceptance`

## 向量化模型

- 服务：`http://127.0.0.1:8000/v1`（本机 oMLX，OpenAI 兼容 `/v1/embeddings`）
- 模型：`bge-m3-mlx-4bit`　维度：1024　可用：是
- 委托专属资料一律在本地向量化，不发往云端。

## 整篇导入的材料

| 键 | 标题 | 字节 | 片段数 | 内容 SHA-256 | 上游 commit |
| --- | --- | ---: | ---: | --- | --- |
| nvwabase | nvwabase — The Nüwa Foundation（整篇 README） | 6700 | 13 | `bf3588b34491440f1a28cd0229027680551c004d44268cc86af350ee63cad1c1` | `c9ec790a99c01641d566e38d8d7d7e6c63a24bcc` |
| sapperlens | SapperLens 独立运行分析（整篇 README） | 86899 | 136 | `7d95a450fa690281a9503b794268398bd162e7f7c66d866b1849edf3c0a721aa` | `eebd7ce31c5d6620f1e760b80de774484568c94b` |
| ledger | Relay 台账交接六批复核实验（整篇 README） | 7078 | 9 | `ec950b4f3f8527eb2cda7d06ea50dd1a58a2fd578d24977690d85f12561f2999` | `f0e80d23caea58942edbe1165dc1521283861dff` |
| r017 | GongYuAI Super-agent 设计与验收（含 R-017 用例全文） | 16465 | 17 | `0dbddfb699becb4f96ab73a68a9d7bb2b6ca2a81e7e3ab73deda3dd2c4d033a6` | `f0e80d23caea58942edbe1165dc1521283861dff` |

全部材料 `tags: []`——**没有与测试查询同词的人工标签**。

## 查询目标段落与名次对比

| 编号 | 查询 | 类型 | 目标段落 | 关键词名次 | 混合名次 | 进 Top 5 |
| --- | --- | --- | --- | ---: | ---: | --- |
| Q1 | 负责人换班 | 语义 | sapperlens `§6.4` | 未命中 | 1 | 是 |
| Q1 | 负责人换班 | 语义 | nvwabase `§2` | 未命中 | 20 | 否 |
| Q1 | 负责人换班 | 语义 | ledger `§六批、五次交接` | 未命中 | 13 | 否 |
| Q2 | 接任指挥后怎样续上进度 | 语义 | sapperlens `§6.4` | 未命中 | 1 | 是 |
| Q2 | 接任指挥后怎样续上进度 | 语义 | nvwabase `§2` | 未命中 | 19 | 否 |
| Q3 | R-017 | 精确 | r017 `§报告交付后收到更正凭据` | 1 | 1 | 是 |
| Q4 | 54/60 | 精确 | ledger `§六批、五次交接` | 3 | 1 | 是 |
| Q5 | §6.4 | 精确 | sapperlens `§6.4` | 1 | 1 | 是 |
| Q6 | 换任 | 精确 | sapperlens `§6.4` | 1 | 1 | 是 |

### 目标段落的标注依据

- **Q1「负责人换班」**：三份原文都不含「负责人换班」整词：SapperLens 写「换任」「Commander 交接」，女娲 README 是英文 successor takes over mid-campaign，实验写「每个边界换班」。目标段落分别是 §6.4 状态与连续性、§2 The Three-Capability Foundation、§六批、五次交接。
- **Q2「接任指挥后怎样续上进度」**：SapperLens §6.4 明确写「下一任指挥官读取该文件，接着调度」「换任通过读 STATE 文件继续」；女娲 §2 写继任者读图接手。两处都是同义表达，不是字面命中。
- **Q3「R-017」**：R-017 用例在 docs/absorb-super-agent.md 的「报告交付后收到更正凭据」一节，字面含 R-017。
- **Q4「54/60」**：54/60 是六批实验的正确字段数，结果表在「六批、五次交接」一节。前言与「准确率差在哪里」也字面含该值，一并记录名次。
- **Q5「§6.4」**：章节地址查询。SapperLens 原文正文并不写「§6.4」这个字面，因此按定位精确命中，如实标为 locator 命中而非正文字面命中。
- **Q6「换任」**：上一轮的问题查询：字面「换任」在多处出现，首条却是 §0。目标段落是 §6.4 状态与连续性。

### 退步项

无。所有目标段落在混合检索中的名次都不劣于关键词检索。

### 已召回但未进 Top 5 的目标（实测语义分）

- Q1「负责人换班」→ nvwabase `§2`：名次 20，目标片段余弦 0.4237；同一资料内最高分片段是 `§4`（0.4774）。混合首条余弦 0.5586。
- Q1「负责人换班」→ ledger `§六批、五次交接`：名次 13，目标片段余弦 0.4843；同一资料内最高分片段是 `§两处交接改动`（0.5371）。混合首条余弦 0.5586。
- Q2「接任指挥后怎样续上进度」→ nvwabase `§2`：名次 19，目标片段余弦 0.4319；同一资料内最高分片段是 `§4`（0.4669）。混合首条余弦 0.6133。

## PDF 物理页码回归

| 样本 | 文件 SHA-256 | API 页数 | 物理页数 | 页码依据 |
| --- | --- | ---: | ---: | --- |
| memgpt | `9f674bcff69c86f11c813dcfad613d8841f5f8ed17979e3c4df06a91df7762e0` | 13 | 13 | physical-page |
| attackpath | `eaa2be59c2055d2188a77731b6ee820cc2d83c04b4d8f3eccd7ef5317b048ab5` | 17 | 17 | physical-page |

## 逐项结果

| 编号 | 验收动作 | 结果 | 观察 |
| --- | --- | --- | --- |
| 0.1 | 本机真实 embedding 模型可用（bge-m3-mlx-4bit） | 通过 | baseUrl=http://127.0.0.1:8000/v1 dim=1024 密钥来源=OMLX_API_KEY 环境变量 |
| 1.nvwabase | 取整篇上游原文 nvwabase | 通过 | bytes=6619 commit=c9ec790a99c01641d566e38d8d7d7e6c63a24bcc |
| 1.sapperlens | 取整篇上游原文 sapperlens | 通过 | bytes=66325 commit=eebd7ce31c5d6620f1e760b80de774484568c94b |
| 1.ledger | 取本项目整篇材料 ledger | 通过 | bytes=4024 path=docs/experiments/2026-11-22-ledger-relay/README.md |
| 1.r017 | 取本项目整篇材料 r017 | 通过 | bytes=8473 path=docs/absorb-super-agent.md |
| 2.nvwabase | 整篇导入 nvwabase 并按标题层级切片 | 通过 | chunks=13 byteSize=6700 原文范围精确=true 被继续切分的片段数=11 sha256=bf3588b34491440f1a28cd0229027680551c004d44268cc86af350ee63cad1c1 |
| 2.sapperlens | 整篇导入 sapperlens 并按标题层级切片 | 通过 | chunks=136 byteSize=86899 原文范围精确=true 被继续切分的片段数=98 sha256=7d95a450fa690281a9503b794268398bd162e7f7c66d866b1849edf3c0a721aa |
| 2.ledger | 整篇导入 ledger 并按标题层级切片 | 通过 | chunks=9 byteSize=7078 原文范围精确=true 被继续切分的片段数=6 sha256=ec950b4f3f8527eb2cda7d06ea50dd1a58a2fd578d24977690d85f12561f2999 |
| 2.r017 | 整篇导入 r017 并按标题层级切片 | 通过 | chunks=17 byteSize=16465 原文范围精确=true 被继续切分的片段数=14 sha256=0dbddfb699becb4f96ab73a68a9d7bb2b6ca2a81e7e3ab73deda3dd2c4d033a6 |
| 2.tags | 已移除与测试查询同词的人工标签 | 通过 | 各资料 tags=nvwabase:[] sapperlens:[] ledger:[] r017:[] |
| 2.summary | 四份整篇材料均已导入 | 通过 | 已导入 4/4：nvwabase,sapperlens,ledger,r017 |
| 3.1 | 整篇材料的向量索引灌满（真实模型） | 通过 | state=ready model=bge-m3-mlx-4bit dim=1024 indexKey=c2:bge-m3-mlx-4bit chunks=175/175 lastIndexedAt=2026-11-23T05:18:50.873Z |
| 4.Q1 | 语义查询「负责人换班」召回全部目标段落（无标签、无字面命中） | 通过 | sapperlens §6.4: 关键词 未命中 → 混合 1；nvwabase §2: 关键词 未命中 → 混合 20；ledger §六批、五次交接: 关键词 未命中 → 混合 13；关键词 total=0，混合 total=20（语义召回 20，余弦门槛 0.3586）；主目标 sapperlens 名次 1；退步项=无 |
| 4.Q1.top5 | 语义查询「负责人换班」全部目标段落进 Top 5 | **未通过** | 未进 Top 5：nvwabase §2 名次 20；ledger §六批、五次交接 名次 13（已召回但名次靠后，逐条名次见 query-comparison.json） |
| 4.Q2 | 语义查询「接任指挥后怎样续上进度」召回全部目标段落（无标签、无字面命中） | 通过 | sapperlens §6.4: 关键词 未命中 → 混合 1；nvwabase §2: 关键词 未命中 → 混合 19；关键词 total=0，混合 total=20（语义召回 20，余弦门槛 0.4133）；主目标 sapperlens 名次 1；退步项=无 |
| 4.Q2.top5 | 语义查询「接任指挥后怎样续上进度」全部目标段落进 Top 5 | **未通过** | 未进 Top 5：nvwabase §2 名次 19（已召回但名次靠后，逐条名次见 query-comparison.json） |
| 4.Q3 | 精确查询「R-017」目标段落名次 | 通过 | r017 §报告交付后收到更正凭据: 关键词 1 → 混合 1；混合首条=§报告交付后收到更正凭据~2（body+title+semantic）；退步项=无 |
| 4.Q4 | 精确查询「54/60」目标段落名次 | 通过 | ledger §六批、五次交接: 关键词 3 → 混合 1；混合首条=§六批、五次交接（body+semantic）；退步项=无 |
| 4.Q5 | 精确查询「§6.4」目标段落名次 | 通过 | sapperlens §6.4: 关键词 1 → 混合 1；混合首条=§6.4（locator+semantic）；退步项=无 |
| 4.Q6 | 精确查询「换任」目标段落名次 | 通过 | sapperlens §6.4: 关键词 1 → 混合 1；混合首条=§6.4~2（body+semantic）；退步项=无 |
| 4.regress | 「换任」不再以 §0 摘要为首条（上一轮问题） | 通过 | SapperLens首个命中=§6.4~2（父章节 §6.4），命中字段=body+semantic |
| 5.memgpt | PDF 物理页码回归 memgpt：应为 13 页 | 通过 | API 页数=13（不同页号 13 个）期望=13；独立核对 /Type/Page=13 /Count=13；首段 p.1 末段 p.13；chunks=81 |
| 5.memgpt.search | PDF 正文可检索且页码不超过物理页数 memgpt | 通过 | locator=p.2~7 page=2 pageBasis=physical-page matchedFields=body+title |
| 5.attackpath | PDF 物理页码回归 attackpath：应为 17 页 | 通过 | API 页数=17（不同页号 17 个）期望=17；独立核对 /Type/Page=压缩对象流，见 /Count /Count=无；首段 p.1 末段 p.17；chunks=151 |
| 5.attackpath.search | PDF 正文可检索且页码不超过物理页数 attackpath | 通过 | locator=p.12~4 page=12 pageBasis=physical-page matchedFields=body+title |
| 6.1 | 前端可直接用命中片段的定位字段创建定版引用 | 通过 | citationId=c77c63fc-41a9-4c9f-85d2-f25a21335019 pinKind=range range=[32670,32899) chunkSha=58649efc82a9417b33f7489302e9206ef44b4493719a22199791877d645d8293 locator=§6.4~2 |
| 6.2 | 定版引用立即回读命中段落原文 | 通过 | verification=verified chars=[32670,32899) length=229 与原文切片一致=true |
| 6.3 | 重建索引后引用回读同一段、片段校验值一致 | 通过 | chunkSha一致=true length=229 |
| 6.4 | 导入整篇 v2 并保留 v1 快照 | 通过 | v2Id=f3ef2c5a-8efe-4c10-8cc3-2c9c83a85e51 v2Sha=75b31ae47b24943bd7147a854fe1f54233d8bd155d847aa77e4c9e7f3369532c v1SnapshotStillPresent=true |
| 6.5 | 停用 v1 | 通过 | status=deprecated deprecatedAt=2026-11-23T05:18:59.867Z |
| 6.6 | v1 停用后默认检索只返回有效版 v2 | 通过 | 命中 7 条，全部 versionNo=2 |
| 6.7 | v2 生效后旧引用仍离线复验 v1 同一段 | 通过 | versionStatus=deprecated chunkSha一致=true |
| 7.1 | 关键词与语义两路双向不泄露，共享资料两边可见，计数按范围 | 通过 | [{"reader":"eng-knowledge-hybrid-1795411122521-alpha","kwOwn":1,"kwOther":0,"sharedKw":1,"sharedHybrid":2,"sharedLeak":false,"materials":2,"semTotal":2,"semLeaked":false,"searchedVersions":2,"indexChunks":2},{"reader":"eng-knowledge-hybrid-1795411122521-beta","kwOwn":1,"kwOther":0,"sharedKw":1,"sharedHybrid":2,"sharedLeak":false,"materials":2,"semTotal":2,"semLeaked":false,"searchedVersions":2,"indexChunks":2}] |
| 7.2 | 已知 ID 直读资料/版本/段落与越界重建一律 404，且不泄露标题 | 通过 | [{"reader":"eng-knowledge-hybrid-1795411122521-beta","detail":404,"versions":404,"version":404,"section":404,"rebuild":404,"leakedTitle":false},{"reader":"eng-knowledge-hybrid-1795411122521-alpha","detail":404,"versions":404,"version":404,"section":404,"rebuild":404,"leakedTitle":false}] |
| 7.3 | 跨委托创建引用双向被拒 | 通过 | B→A=404 A→B=404 |
| 7.4 | 报告导出双向不泄露另一委托的材料 ID 与关键词 | 通过 | A citations=2 B citations=2 snapshotScope=full-version |
| 7.5 | 客户端 engagementId 只能定位：冲突拒绝，任务归属以服务端为准 | 通过 | 冲突=409/409；taskId 锚定 resolvedFrom=task |
| 7.6 | 单操作者环境的权限验证边界已如实记录 | 通过 | 本运行环境无认证层：已验收委托边界（两路范围校验、越界 404、导出不泄露）；用户级权限（谁能声明哪个委托）未验证。 |
| 8.run | 断网且停用向量化的子进程重启服务 | 通过 | exit=0 |
| 8.0 | 正对照：本阶段出站访问确实被拒，且向量化已停用 | 通过 | 上游 fetch 失败：OFFLINE: 拒绝出站 fetch raw.githubusercontent.com |
| 8.1 | 断网 + 无向量重启后，按原文范围回读同一段且校验值一致 | 通过 | verification=verified snapshotSha=一致 chunkSha=一致 range=[32670,32899) versionStatus=deprecated |
| 8.2 | 无向量时关键词检索仍可用并如实标降级 | 通过 | total=7 degraded=true reason=向量化已在设置中停用，本次检索只用关键词 |
| 8.3 | v1 停用后默认检索返回有效版 v2 | 通过 | topVersionNo=2 versionId=f3ef2c5a-8efe-4c10-8cc3-2c9c83a85e51 expectedV2=f3ef2c5a-8efe-4c10-8cc3-2c9c83a85e51 |
| 8.4 | 旧报告仍含 v1 快照校验值与停用提示 | 通过 | reportBytes=1263 containsV1Sha=true |
| 8.5 | 离线导出打包整份定版快照，校验值可复算 | 通过 | snapshotScope=full-version bytes=86899 recomputedMatches=true |
| 8.6 | 只打包引用片段的导出：字节等于被引用段落，校验值等于片段校验值 | 通过 | bytes=443 chunkShaMatches=true |
| 8.7 | 知识库快照缺失时旧引用仍可由任务侧密封件复验 | 通过 | verification=verified librarySnapshotAvailable=false |
| 8.8 | 密封快照损坏时返回 sha256_mismatch 无法复验 | 通过 | reason=sha256_mismatch |
| 8.9 | 密封快照缺失时返回 snapshot_missing 无法复验 | 通过 | reason=snapshot_missing |
| 9.1 | 取到升级前 v1 原文字节（上一轮报告附件） | 通过 | bytes=2456 sha256=f8d78d0ffe8c0b8b2b2f4a5a8215d31550574e7ef7f049d8816c0ad12487cd59 与引用登记值一致=true |
| 9.2 | 记录升级前 §6.4 回读基准（旧切分整章） | 通过 | chars=[0,1910) length=1910 chunkSha=f8d78d0ffe8c0b8b2b2f4a5a8215d31550574e7ef7f049d8816c0ad12487cd59 |
| 9.3 | 确认这条引用来自升级前的库结构（没有原文范围与片段元数据列） | 通过 | material_citations 列=id,task_id,engagement_id,material_id,version_id,locator,claim,body_format,material_title,publisher,source_kind,version_no,version_label,section_heading,section_page,section_ordinal,sha256,created_at；含 pin_kind=false 含 char_start=false |
| 9.4 | 新代码在旧数据根上原地迁移：版本号与内容 SHA-256 不变 | 通过 | versions=2 chunkerVersions=2,2 v1ShaStillPresent=true |
| 9.3b | 迁移后这条引用仍是 locator 定版（未被改写成范围定版） | 通过 | pinKind=locator charStart=null chunkSha256=null |
| 9.5 | 升级后旧 locator 引用回读的是同一段，原文范围与校验值完全一致 | 通过 | verification=verified pinKind=locator chars=[0,1910) length=1910 chunkSha一致=true |
| 9.6 | 重建索引后旧引用仍回读同一段 | 通过 | chunkSha一致=true length=1910 |
| 9.7 | 新切分确实改变了库内片段，但旧引用不受影响 | 通过 | 新 §6.4 首片长度=695 旧整章长度=1910 旧引用仍读整章=true |

## 未通过或未执行的事项

- **控制台页面与交互**：本轮不实现，由控制台侧另行交付；接口契约见 [knowledge-library-api.md](../../../knowledge-library-api.md)。
- **用户级权限**：单操作者、无认证层。已验收委托边界；`scope.userLevelPermissionVerified` 恒为 `false`。
- **离线导出的收件范围**：按服务端任务归属过滤资料，`withheld.outOfScopeCitations` 只给数量。**不校验收件人身份**（无认证层），也不校验导出包离开本机后的流向。
- **断网前提的实现方式**：子进程清除环境代理并按主机名拒绝非回环出站，且停用向量化。这是进程级阻断，不是物理断网。

# 知识库首版后端验收记录

运行编号：knowledge-1795404972071　生成时间：2026-11-23T03:36:20.343Z

数据根（隔离）：`/Users/sycpro/GongYuAI/out/knowledge-1795404972071`　服务：真实进程 + 回环 HTTP

结果：40/40 通过，0 未通过。

复现：`pnpm knowledge:acceptance`（数据根隔离在 `out/`，不触碰正式 `.gongyuai`）。

## 上游来源与 commit

| 来源 | 原文地址 | commit | 字节 |
| --- | --- | --- | ---: |
| nvwabase | https://raw.githubusercontent.com/N1nEmAn/nvwabase/master/README.md | `c9ec790a99c01641d566e38d8d7d7e6c63a24bcc` | 6619 |
| sapperlens | https://raw.githubusercontent.com/inwpu/SapperLens/main/README.md | `eebd7ce31c5d6620f1e760b80de774484568c94b` | 66325 |
| dsh | https://raw.githubusercontent.com/deepseek-ai/dsh-superagent-prototype/main/docs/001-domain.md | `8c32a9dc5d72c033816c6a8110b37f40cf94fba4` | 12223 |

本项目材料上游 commit：`f0e80d23caea58942edbe1165dc1521283861dff`（六批交接实验 README、R-017 用例）。

## 实际导入的资料与内容 SHA-256

| 键 | 标题 | 来源类型 | 内容 SHA-256 | 上游 commit |
| --- | --- | --- | --- | --- |
| nvwabase | 女娲底座 README · History 分层说明 | excerpt | `e6468119f014c738c6cd70eeccf5caed09e24c805bd4b2ca3083be5f15ad8d41` | `c9ec790a99c01641d566e38d8d7d7e6c63a24bcc` |
| sapperlens | SapperLens §6.4 状态与连续性 | excerpt | `f8d78d0ffe8c0b8b2b2f4a5a8215d31550574e7ef7f049d8816c0ad12487cd59` | `eebd7ce31c5d6620f1e760b80de774484568c94b` |
| ledger | 本项目六批交接实验 · 六批、五次交接 | excerpt | `188f17c84994d2afdaee92dc09a8b64a2faf55bbf620ab7759511dc827e696f0` | 本项目材料 |
| dsh | DeepSeek Super-agent 原型 · 领域模型与术语表 | excerpt | `c21da8eda06d00b551a350a5756fd635be655216be17e8e37216f53bb02ae888` | `8c32a9dc5d72c033816c6a8110b37f40cf94fba4` |
| r017 | 本项目 R-017 补证用例 · 报告交付后收到更正凭据 | excerpt | `4b6c0158549cf4b3c8da0a6c1d51f357017f10652f924e648a7da7a0100ea1de` | 本项目材料 |

编辑导读单独成条（`sourceKind=editorial`），**不计入真实文章验收**。

## 定版引用的 v1 / v2 校验值

资料 ID：`4a3bb9ea-08d8-4df7-800e-5599d1899f40`　引用 ID：`a49dd90e-550c-45aa-80aa-7af66e4a5c3b`　段落定位：`§6.4`

| 版本 | 版本 ID | 内容 SHA-256 |
| --- | --- | --- |
| 本地 v1（已停用，旧报告仍按此回读） | `7d2fd3ea-b2b7-4c14-bf8e-1f2fa7d05ca1` | `f8d78d0ffe8c0b8b2b2f4a5a8215d31550574e7ef7f049d8816c0ad12487cd59` |
| 本地 v2（验收修订，当前有效版） | `ebd21a37-0ef3-4d4e-acd5-09348e6f3e0b` | `72ee09b33dbcbb5f54bb99a70ac93ccb60b9486ccd0e30ffc996761baaabce7d` |

v1 快照路径：`knowledge/snapshots/f8d78d0ffe8c0b8b2b2f4a5a8215d31550574e7ef7f049d8816c0ad12487cd59`；断网重启后复算值与 v1 原值相等（见 6.1）。

## 隔离测试入口

| 入口 | 覆盖 | 命令 |
| --- | --- | --- |
| `packages/control-plane/src/knowledge.test.ts` | 预览/待补正文/幂等重放/并发成版/中文检索与命中字段/定版回读/快照缺失损坏/PDF/三类来源/历史段落/失败不留半写入（11 项） | `node --import tsx --test packages/control-plane/src/knowledge.test.ts` |
| `packages/control-plane/src/knowledge-isolation.test.ts` | 委托 A/B 双向：检索计数、已知 ID 直读、跨委托引用、engagementId 冲突、报告导出、同来源跨委托各自成库（6 项） | `node --import tsx --test packages/control-plane/src/knowledge-isolation.test.ts` |

实际响应落盘：`response-search-handover.json`、`response-material-detail.json`、`response-resolve-verified.json`、`response-resolve-unverifiable.json`、`offline-report-export.json`、`offline-export-snapshot.md`。

## 未通过或未执行的事项

- **控制台导航、页面与交互**：本轮不实现，由控制台侧另行交付；接口契约见 [knowledge-library-api.md](../../../knowledge-library-api.md)。
- **用户级权限**：当前运行环境单操作者、无认证层。已验收的是委托边界（范围校验、越界 404、导出不泄露）；“谁有权声明哪个委托”未验证，`scope.userLevelPermissionVerified` 恒为 `false`。
- **项目经验图、向量/语义检索、自动蒸馏**：不在首版范围，未执行。
- **「负责人换班」的正文命中**：三份真实原文正文均不含该整词（SapperLens 写「换任」、实验写「换班」、女娲 README 为英文），因此全部为**标签命中**并如实标识；正文字面命中另用「换任」「换班 54/60」验证（3.3）。编辑导读一条为正文命中，但不计入真实文章验收。
- **PDF 页面定位**：按页面对象树顺序给出 `p.N`；扫描件、加密或字体无 ToUnicode 映射的 PDF 标记为待补正文，不编造内容。已用仓库内两份真实 PDF 验证可提取（57 页 / 70 页）。
- **断网前提的实现方式**：子进程清除环境代理并按主机名拒绝非回环出站（fetch/TLS/HTTP/DNS），正对照确认上游 fetch 被拒（6.0a）。这是进程级阻断，不是物理断网。
- **真实跨周交接与独立人员盲读**：沿用既有边界，本轮未执行。

## 逐项结果

| 编号 | 验收动作 | 结果 | 观察 |
| --- | --- | --- | --- |
| 1.nvwabase | 取上游原文 nvwabase | 通过 | bytes=6619 commit=c9ec790a99c01641d566e38d8d7d7e6c63a24bcc |
| 1.sapperlens | 取上游原文 sapperlens | 通过 | bytes=66325 commit=eebd7ce31c5d6620f1e760b80de774484568c94b |
| 1.dsh | 取上游原文 dsh | 通过 | bytes=12223 commit=8c32a9dc5d72c033816c6a8110b37f40cf94fba4 |
| 1.local | 取本项目真实材料（六批交接实验 / R-017 用例） | 通过 | ledgerBytes=4024 r017Bytes=8473 upstreamCommit=f0e80d23caea58942edbe1165dc1521283861dff |
| 2.nvwabase | 导入女娲底座 README 的 History 段 | 通过 | materialId=ae7a602f-2eed-4fa2-98e0-884f9f3bdc82 versionId=d92cdccf-6bc5-4c72-a603-0cee4987f751 sha256=e6468119f014c738c6cd70eeccf5caed09e24c805bd4b2ca3083be5f15ad8d41 sections=1 |
| 2.sapperlens | 导入 SapperLens §6.4「状态与连续性」 | 通过 | materialId=4a3bb9ea-08d8-4df7-800e-5599d1899f40 versionId=7d2fd3ea-b2b7-4c14-bf8e-1f2fa7d05ca1 sha256=f8d78d0ffe8c0b8b2b2f4a5a8215d31550574e7ef7f049d8816c0ad12487cd59 locators=§6.4 |
| 2.ledger | 导入六批交接实验的「六批、五次交接」 | 通过 | materialId=338c9f08-72ec-4d71-96d3-ed668bfb1305 sha256=188f17c84994d2afdaee92dc09a8b64a2faf55bbf620ab7759511dc827e696f0 含54/60=true |
| 2.dsh | 导入 DeepSeek 原型领域模型（工作项/派工/授权） | 通过 | materialId=60fc0471-dcf3-4f86-829d-00984e8df7fe sha256=c21da8eda06d00b551a350a5756fd635be655216be17e8e37216f53bb02ae888 含Ticket=true 含派工=true |
| 2.r017 | 导入本项目 R-017 补证用例 | 通过 | materialId=86b8b90a-69c9-403a-b5e2-e1b39396bd4b sha256=4b6c0158549cf4b3c8da0a6c1d51f357017f10652f924e648a7da7a0100ea1de 含更正回函=true |
| 2.editorial | 编辑导读单独成条并标明来源类型 | 通过 | sourceKind=editorial（不计入真实文章验收） |
| 2.summary | 三份必需真实资料均已导入 | 通过 | 已导入 3/3；缺项见各条 FAIL |
| 2.pdf.memgpt | 真实 PDF 正文提取 memgpt | 通过 | status=201 bodyStatus=ready pages=57 firstLocator=p.1 fileSha256=9f674bcff69c86f11c813dcfad613d8841f5f8ed17979e3c4df06a91df7762e0 |
| 2.pdf.memgpt.search | PDF 正文可检索并按页定位 memgpt | 通过 | total=36 matchedFields=title,body locator=p.1 page=1 |
| 2.pdf.attackpath | 真实 PDF 正文提取 attackpath | 通过 | status=201 bodyStatus=ready pages=70 firstLocator=p.1 fileSha256=eaa2be59c2055d2188a77731b6ee820cc2d83c04b4d8f3eccd7ef5317b048ab5 |
| 2.pdf.attackpath.search | PDF 正文可检索并按页定位 attackpath | 通过 | total=9 matchedFields=title,body locator=p.1 page=1 |
| 3.1 | 搜「负责人换班」命中三种真实来源并可逐条打开 | 通过 | total=4 materials=4 真实来源命中=3（另有编辑导读 1 条） |
| 3.2 | 命中字段如实标识：正文未出现该词时只标标签命中 | 通过 | 三份真实原文正文均不含「负责人换班」整词（SapperLens 用「换任」、实验用「换班」），故全部为标签命中；编辑导读为正文字面命中 |
| 3.3 | 正文字面命中可验证：换任 → SapperLens，换班 54/60 → 本项目实验 | 通过 | 换任 total=2 fields=body；换班 54/60 total=1 title=本项目六批交接实验 · 六批、五次交接 |
| 4.1 | 搜「更正回函」：本项目用例定位到 R-017 验收，原型定位到工作项定义 | 通过 | total=2；R-017 命中字段=body,tags（正文字面含「更正回函」），原型命中字段=tags（标签命中，正文为英文 Ticket/工单） |
| 4.2 | 原型可下钻到工作项（Ticket/工单）、派工、授权定义 | 通过 | locator=§Glossary status=200 含工单=true 含派工=true 含授权=true |
| 5.1 | 重放相同导入（含 3 次并发）版本数不增加 | 通过 | reused=true,true,true versionCount=1 |
| 5.2 | 通过报告引用 API 固定 §6.4 到 v1 | 通过 | citationId=a49dd90e-550c-45aa-80aa-7af66e4a5c3b snapshotSha256=f8d78d0ffe8c0b8b2b2f4a5a8215d31550574e7ef7f049d8816c0ad12487cd59 versionLabel=本地 v1 |
| 5.3 | 导入明确标记为验收修订的 v2 并保留 v1 快照 | 通过 | v2Id=ebd21a37-0ef3-4d4e-acd5-09348e6f3e0b v2Sha=72ee09b33dbcbb5f54bb99a70ac93ccb60b9486ccd0e30ffc996761baaabce7d v1Sha=f8d78d0ffe8c0b8b2b2f4a5a8215d31550574e7ef7f049d8816c0ad12487cd59 v1SnapshotStillPresent=true |
| 5.4 | 停用 v1 | 通过 | status=deprecated deprecatedAt=2026-11-23T03:36:20.058Z |
| 6.0 | 断网子进程重启服务（出站连接一律抛错） | 通过 | exit=0 |
| 6.0a | 正对照：本阶段出站访问确实被拒 | 通过 | 上游 fetch 失败：OFFLINE: 拒绝出站 fetch raw.githubusercontent.com |
| 6.1 | 断网重启后按引用回读 v1 段落并复算原 SHA-256 | 通过 | status=200 verification=verified recomputed=f8d78d0ffe8c0b8b2b2f4a5a8215d31550574e7ef7f049d8816c0ad12487cd59 expected=f8d78d0ffe8c0b8b2b2f4a5a8215d31550574e7ef7f049d8816c0ad12487cd59 versionStatus=deprecated |
| 6.2 | 断网下检索默认返回有效版 v2 | 通过 | total=2 topVersionNo=2 topVersionId=ebd21a37-0ef3-4d4e-acd5-09348e6f3e0b |
| 6.3 | 断网下旧报告仍含 v1 SHA-256 与停用提示 | 通过 | reportBytes=1149 containsV1Sha=true |
| 7.1 | 离线导出打包定版快照与校验信息 | 通过 | citations=1 snapshotBytes=2456 recomputed=f8d78d0ffe8c0b8b2b2f4a5a8215d31550574e7ef7f049d8816c0ad12487cd59 |
| 7.2 | 知识库快照缺失时旧报告仍可由任务侧密封件复验 | 通过 | verification=verified librarySnapshotAvailable=false |
| 7.3 | 密封快照损坏时返回 sha256_mismatch 无法复验 | 通过 | reason=sha256_mismatch expected=f8d78d0ffe8c0b8b2b2f4a5a8215d31550574e7ef7f049d8816c0ad12487cd59 recomputed=208ded743e42a963280c0178f6f571d496eeab7a17980afd5bfe24d06b734689 |
| 7.4 | 损坏快照的离线导出同样标记无法复验 | 通过 | exportReason=sha256_mismatch |
| 7.5 | 密封快照缺失时返回 snapshot_missing 无法复验 | 通过 | reason=snapshot_missing |
| 8.1 | 检索与计数双向不泄露，共享资料两边可见 | 通过 | [{"reader":"eng-knowledge-1795404972071-alpha","ownTotal":1,"otherTotal":0,"sharedTotal":1,"materials":2},{"reader":"eng-knowledge-1795404972071-beta","ownTotal":1,"otherTotal":0,"sharedTotal":1,"materials":2}] |
| 8.2 | 已知 ID 直接读取资料/版本/段落一律 404，且不泄露标题 | 通过 | [{"reader":"eng-knowledge-1795404972071-beta","detail":404,"versions":404,"version":404,"section":404,"leakedTitle":false},{"reader":"eng-knowledge-1795404972071-alpha","detail":404,"versions":404,"version":404,"section":404,"leakedTitle":false}] |
| 8.3 | 跨委托创建引用双向被拒 | 通过 | B→A=404 A→B=404 |
| 8.4 | 报告导出双向不泄露另一委托的材料 ID 与关键词 | 通过 | A citations=2 B citations=2；A 含 B 关键词=false；B 含 A 关键词=false |
| 8.5 | 客户端 engagementId 只能定位：冲突拒绝，任务归属以服务端为准 | 通过 | 冲突=409/409；taskId 锚定 resolvedFrom=task engagementId=eng-knowledge-1795404972071-alpha |
| 9.1 | 单操作者环境的权限验证边界已如实记录 | 通过 | 本运行环境无认证层：委托边界按服务端任务归属与声明上下文验收；用户级权限（谁能声明哪个委托）未验证，已在契约与本记录中标明。 |

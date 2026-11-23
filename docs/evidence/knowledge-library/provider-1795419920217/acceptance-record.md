# 向量化服务切换与重试缺陷修复 · 页面验收记录

2026-11-23。运行号 `provider-1795419920217`（本机兼容测试服务）与 `provider-omlx-1795420440432`（真实本机模型 oMLX）。
数据根隔离在 `out/knowledge-provider-console-<runId>/`，未触碰正式 `.gongyuai`。

**操作方式说明**：Qoder 内置浏览器面板未显示，指针点击与截图不可用（`NATIVE_BROWSER_VIEWPORT_UNAVAILABLE`）。
本轮改用页面内真实 DOM 事件驱动真实控制台页面（`element.click()`、原生 value setter + `input` 事件），
走的仍是真实 React 处理函数与真实 HTTP 请求。证据为无障碍树快照、页面请求/响应原文、后端索引读数与逐请求 JSONL 日志，**没有截图**。

## 环境

| 项 | 值 |
| --- | --- |
| 控制面 | `http://127.0.0.1:8879`（真实 `bootControlPlane`，隔离数据根） |
| 控制台 | `http://127.0.0.1:5174/#/knowledge`（vite dev，代理指向 8879） |
| 本地服务（run 1） | `http://127.0.0.1:8898/v1` · `stub-local-8dim` · 8 维 · **本机兼容测试服务** |
| 云端服务（两轮） | `http://127.0.0.1:8899/v1` · `stub-cloud-12dim` · 12 维 · **本机兼容测试服务（云端替身）** |
| 本地服务（run 2） | `http://127.0.0.1:8000/v1` · `bge-m3-mlx-4bit` · 1024 维 · **真实本机模型（oMLX）** |
| 合成资料 | 共享《团队共享运行分析》4 片段；委托 A《委托A专属交接记录》2 片段；委托 B《委托B专属交接记录》2 片段 |

云端替身与本地替身都逐请求记录 `model` / `authorization` / `inputs`，用于核对「哪些范围真的发生了调用」。

## 1 · 停用 → 重新启用 → 只点重试（缺陷复现与修复）

按用户给定顺序在页面上操作，`PATCH` 全部经 `PUT /settings/knowledge-embedding`。

| 步骤 | 页面/接口实际读数 |
| --- | --- |
| 索引就绪 | `state=ready`，`modelDim=8`，4/4 |
| 停用并保存 | `state=disabled`，`modelDim=null`，`degradedReason=向量化已在设置中停用…` |
| 重新启用同一模型并保存 | `state=pending`，`modelDim=null`，`indexedChunks=0`，`totalChunks=4`，`pendingChunks=4` |
| 点「重试失败/未就绪片段」 | **HTTP 202**，`queued=["8f682c66-984a-4b3f-99e2-f7a479a5c68f"]`（1 个版本），Toast「已排队：重试共享资料失败/未就绪片段（1 个版本）」 |
| 页面轮询 | `pending 0/4 dim=null` → `pending 0/4` → `pending 0/4` → **`ready 4/4 dim=8`** |
| 再点一次重试 | HTTP 202，`queued=[]`，页面 Banner + Toast「**没有需要重试的资料**」，不再出现「已排队」标签 |

修复前同样操作得到 `queued: []` + `pending 0/1` + `modelDim: null`，页面却显示「已排队」。
根因：`versionState` 在维度未探测（`dim=null`）时把登记的 `ready` 直接采信，`indexedCount` 又因 `dim=-1` 返回 0，
于是重试判定「无事可做」。修复后 `ready` 必须由实际向量数核对，未达标回落 `pending`；
聚合状态区分「正在写入」与「登记待办」，重试按钮不再被误禁用。**未使用整库重建绕过**。

真实本机模型（run 2）同样复现通过：停用→启用→只点重试，Toast「已排队…（1 个版本）」，终态 `ready`、`modelDim=1024`、4/4。

## 2 · 服务暂时不可用 → 恢复后仅靠重试

在委托 A 范围（云端）用文件开关让云端替身返回 503：

- 重建后页面：`服务不可用`，0/6，`待索引/失败 = 2/4`，
  `最近错误：云端服务返回 503：{"error":{"message":"cloud stub temporarily unavailable"}}`（JSONL 第 8 条 `fail:true`）。
- 恢复服务后**只点重试**：Toast「已排队：重试委托 eng-a失败/未就绪片段（2 个版本）」，页面 `索引就绪`，6/6，`0/0`。

## 3 · 本地 → 云端 → 本地互切

| 阶段 | 服务 | 模型 | 维度 | 索引指纹 | 语义检索 |
| --- | --- | --- | --- | --- | --- |
| 初始（run 1） | 本地 `…:8898/v1` | stub-local-8dim | 8 | `c2\|local\|http://127.0.0.1:8898/v1\|stub-local-8dim` | 「负责人换班」关键词 0 / 语义 1，首条 §6.4 |
| 切云端 + 重建 | 云端 `…:8899/v1` | stub-cloud-12dim | 12 | `c2\|cloud\|http://127.0.0.1:8899/v1\|stub-cloud-12dim` | 关键词 0 / 语义 1，首条 §6.4，余弦 0.707 |
| 切回本地 | 本地 `…:8898/v1` | stub-local-8dim | 8 | 同初始指纹 | 关键词 0 / 语义 1，首条 §6.4 |
| 初始（run 2，真实模型） | 本地 `…:8000/v1` | bge-m3-mlx-4bit | **1024** | `c2\|local\|http://127.0.0.1:8000/v1\|bge-m3-mlx-4bit` | 「负责人换班」关键词 0 / 语义 4，首条 §6.4 余弦 0.580；「接任指挥后怎样续上进度」首条 §6.4 余弦 0.623 |
| run 2 切云端 + 重建 | 云端 `…:8899/v1` | stub-cloud-12dim | 12 | `c2\|cloud\|…\|stub-cloud-12dim` | 关键词 0 / 语义 1，§6.4 余弦 0.707 |
| run 2 切回真实本地 + 重建 | 本地 `…:8000/v1` | bge-m3-mlx-4bit | **1024** | 同上真实指纹 | 关键词 0 / 语义 2，首条 §6.4 余弦 0.623 |

- 两套配置各自留存：切云端后 `local.baseUrl` 仍是本地地址、`local.apiKeyEnv` 不变；切回本地后 `cloud.apiKeyConfigured=true`、`cloud.model` 不变。
- **刷新后配置仍在**：整页 reload 后 radio 选中 `本地服务`，表单显示 `…:8898/v1` / `stub-local-8dim` / `timeout=120000`；切到云端页签显示 `…:8899/v1` / `stub-cloud-12dim` / `timeout=30000`。
- **凭据互不串用**：run 1 全程本地替身的 9 次请求和云端替身的 12 次请求均匹配各自的测试凭据。归档调用日志保留凭据存在与匹配结果。
- 公开视图不含明文密钥：`GET /settings` 的 `local`/`cloud` 只有 `apiKeyConfigured` 与掩码（`loca••••••••-key` / `clou••••••••-key`）。
- 切回本地时旧向量仍在盘上，页面立即 `ready 4/4`，再点重试如实返回「没有需要重试的资料」。

**两个有效模型互切**：真实本机 bge-m3（1024 维）与本机兼容测试服务（12 维）双向切换均成功返回向量并完成语义召回。
**真实云端 ↔ 真实本机互切未执行**，原因见第 6 节。

## 4 · 测试连接

| 目标 | 请求 | 结果 |
| --- | --- | --- |
| 云端替身（已存配置） | `POST /settings/knowledge-embedding/test` `{provider:"cloud", service:{…apiKey:""}}` | 200 `ok:true`，`model=stub-cloud-12dim`，`dim=12`，`durationMs=2`；页面 Banner「连接成功：模型 stub-cloud-12dim · 实测维度 12 · 耗时 2ms」 |
| 真实本机 oMLX（页面草稿） | 同上，`provider:"local"`，`baseUrl=http://127.0.0.1:8000/v1`，`model=bge-m3-mlx-4bit`，`apiKeyEnv=OMLX_API_KEY` | 200 `ok:true`，`dim=1024`，`durationMs=22`；Banner「连接成功：模型 bge-m3-mlx-4bit · 实测维度 1024 · 耗时 22ms」 |
| 真实云端（项目已配置地址） | 同上，`provider:"cloud"`，`baseUrl=https://api.deepseek.com/v1`，`model=text-embedding-3-small`，`apiKeyEnv=OPENAI_API_KEY` | 200 `ok:false`，Banner「连接失败：云端服务返回 404：{"error":{"message":"Not Found (request_id: fa5cca90-51fe-4f70-a32a-4c3793908fef)","type":"not_found_error",…}}」 |

- 云端替身日志确认测试连接**只发固定合成短句** `GongYuAI 向量化连通性探测 synthetic embedding probe`，且本地替身零调用。
- 真实云端探测走的是**未保存草稿**：探测后 `GET /settings` 仍为 `provider=local`、`cloud.baseUrl=…:8899/v1`，索引仍 `ready 1024 维 4/4`，未被改动。
- 密钥经 `apiKeyEnv` 由后端读取，明文未经浏览器、未写入任何证据文件。

## 5 · A / B 委托与共享资料的授权隔离

配置：`provider=cloud`，`cloudEngagements=["eng-a"]`。

| 范围 | 生效服务 | 分服务读数 | blockedChunks |
| --- | --- | --- | --- |
| 共享 | 云端 12 维 | local 0/0 · cloud 4/4（allowed） | 0 |
| 委托 A | 云端 12 维 | cloud 6/6（allowed，含共享 4 + 专属 2） | 0 |
| 委托 B | **本地 8 维** | local 2/2（allowed） · cloud 4/4（**allowed=false**） | **4** |

页面在 B 范围显示：

```
本地服务  stub-local-8dim · 8 维 · 2/2 片段 · 索引就绪
云端服务  stub-cloud-12dim · 12 维 · 4/4 片段 · 索引就绪 · 本范围未授权
本范围有 4 个已索引片段属于未获授权的向量化服务，不参与语义召回，也不会把查询文本发给该服务。
```

逐请求核对（JSONL 时间戳）：

| 时刻 | 动作 | 云端调用 | 本地调用 |
| --- | --- | --- | --- |
| 07:50:51 | A 范围检索「负责人换班」 | **#7 发生**，inputs=`["负责人换班"]` | — |
| 07:51:0x–07:51:27 | B 范围检索「负责人换班」「接任指挥后怎样续上进度」 | **零次**（计数停在 7） | #7 发生，inputs=`["接任指挥后怎样续上进度"]` |
| 07:52:31 / 07:52:39 | A 范围建引用前的两次检索 | #11 / #12 发生 | — |

- 库里确实存在云端索引的共享资料（4 片段），B 的查询仍**零次云端请求**。
- 云端日志中**从未出现**委托 B 的正文（`grep 委托B` = 0）；B 的正文只在初始 `provider=local` 时进过本地替身。
- B 的命中只来自自己的资料，共享资料的云端向量未参与其语义召回。
- 自动化回归另外验证了撤销 A 授权后其专属资料回落本地、查询不再外发。

## 6 · 真实云端缺项

本项目 `.env` 里唯一配置的云端服务是 `https://api.deepseek.com/v1`（聊天模型 `deepseek-flash`），凭据齐备。
从页面用该地址 + 项目凭据实测 `/embeddings` 返回 **404 not_found_error**——DeepSeek 不提供 embeddings 接口。

**缺的是「支持 OpenAI 兼容 `/embeddings` 的云端服务地址与 embedding 模型 ID」**，不是代码或凭据。
因此本轮：

- 真实本机模型 ↔ 本机兼容测试服务：双向互切**已验收**（两边都成功返回向量）。
- 真实云端 ↔ 真实本机：**未执行**，如实记为缺项。补齐云端地址与模型 ID 后，按第 3 节同样步骤即可复跑。

## 7 · 切换服务并重建后旧报告回读

在云端索引下给委托 A 的任务建两条 `pinKind=range` 引用，再切回本地并重建，然后回读：

| 引用 | 定位 | 原文范围 | 片段 SHA-256 | 回读 |
| --- | --- | --- | --- | --- |
| `b10d664e-3099-4ac7-b86d-0545f44724e9` | §委托A专属交接记录 | [0, 11) | `d8d61b4f22c196e605849e277d9bba2a68f134abb0127d64901d41cf704fadd6` | `verified`，正文 `# 委托A专属交接记录` |
| `6180dbc0-5453-496f-8078-41737ffe6315` | §现场交接 | [13, 70) | `487a1dc7060d809e7f4826c174b44ffbcb6d9efd965143916aba8a90feb39e11` | `verified`，正文 `## 现场交接\n\n06:14 换任，继任者读 STATE 文件续接进度。R-017 要求把更正回函并入既有证据链。` |

- 版本全文 SHA-256 复算 `e208e039abc3ce9cda99c24b4233c3099130bc21aebc99a63e295e67b0380e75`，与切换前一致。
- 独立复算（不依赖被测代码）：对原始合成正文取 `[0,11)` 与 `[13,70)` 的 SHA-256，与上表逐字节相符。
- `report-export?snapshot=paragraph` 打包的字节解码后与上表正文相同，`sha256` 等于片段校验值。
- `librarySnapshotAvailable=true`，资料版本数仍为 1。

## 8 · 过程中发现并修掉的另一个页面缺陷

设置抽屉原先常挂载，只在首次 mount 读一次 `GET /settings`。跨运行复用同一页面时，
它拿旧草稿覆盖保存，把真实 oMLX 本地配置写成了上一轮的替身地址（实测已发生）。
改为**每次打开重新挂载**后不再复现。这也是「切换回来能恢复之前的配置」的前置条件。

## 9 · 回归、类型检查与构建

| 命令 | 结果 |
| --- | --- |
| `pnpm -r run test` | exit 0；contracts 51、console 20、history 57、worker 35、control-plane 97，合计 **260 通过 / 0 失败** |
| `pnpm typecheck` | exit 0 |
| `pnpm build` | exit 0（含 console vite build） |

新增回归 `packages/control-plane/src/knowledge-provider.test.ts`（8 例，全部真实 HTTP）：
重试缺陷复现与修复、服务不可用后仅靠重试、本地↔云端互切与凭据隔离、
委托授权隔离与撤销、测试连接只发合成句、切换后旧引用回读、迟到响应不写新指纹、旧扁平配置迁移。

## 证据文件

- `provider-1795419920217/`：`session.json`、`local-calls.jsonl`、`cloud-calls.jsonl`、`final-index-{shared,eng-a,eng-b}.json`、`session-summary.json`
- `provider-omlx-1795420440432/`：`session.json`、`cloud-calls.jsonl`、`session-realcloud-probe.json`、`final-index-shared.json`、`final-settings.json`

复现命令：

```bash
# 本机兼容测试服务（两套都是替身，可观测调用）
pnpm knowledge:provider-console --local=stub
# 真实本机模型（需 oMLX 上有 bge-m3-mlx-4bit）
OMLX_API_KEY=$(cat ~/.omlx/api-key) pnpm knowledge:provider-console --local=omlx
# 另开控制台，代理指向该控制面
GY_CONSOLE_API=http://127.0.0.1:8879 pnpm --filter @gongyuai/console exec vite --port 5174 --strictPort
```
# 吸收对照：Cairn（oritera/Cairn）

调研日：2026-11-21。  
仓库：[oritera/Cairn](https://github.com/oritera/Cairn) · 标签 v0.2.1 · **AGPL-3.0** · Python ≥3.12。  
权威信仰层：[theory-fact-intent-dag.md](./theory-fact-intent-dag.md)；总映射：[architecture.md](./architecture.md)。

## 结论（先读这四句）

1. Cairn 是 GongYuAI **Fact–Intent–Hint 黑板 + Bootstrap/Reason/Explore** 的工程祖先；主骨架你们已经吸收完，不是「新理论源」。
2. **只学机制，代码不进仓**（与 ARIA-X 同条 AGPL 红线）。
3. 其赛事实绩（腾讯云黑客松智能渗透第 2 届 **54/54 AK、总第 3**）支撑「外置图 + 无固定角色」；**不**支撑「零 MCP / 零 RAG」当信仰——你们明确 MCP/Skill 是弹药。
4. 仍可对照的缺口主要是 **调度纪律**：双阶段 conclude 收尾、Reason 项目级 lease、单次 Reason 的 Intent 硬顶、Fact「洞见+文件引用」写法。

## 仓库事实

| 项 | 内容 |
| --- | --- |
| 定位 | 通用状态空间搜索引擎；渗透是已验证的第一域 |
| 许可 | AGPL-3.0（另宣商业许可可谈） |
| 规模 | ~5.5k★ / ~1.2k forks（2026-11-21 API）；末推约 2026-09 |
| 结构 | `cairn serve`（图一致性）+ `cairn dispatch`（唯一协议写入者）+ Worker（Claude Code / Codex / Pi） |
| 运行 | Docker 每项目一容器，或 `runtime.execution: local` 复用本机 CLI |
| 规格 | `docs/specs/server-protocol.md`、`docs/specs/dispatcher-design.md` |
| 相关论文 | 工程协议之上有 Intentest（[arXiv:2609.07344](https://arxiv.org/abs/2609.07344)）等形式化延伸 |

## 核心机制（对照你们）

| Cairn | GongYuAI 现状 | 差额 |
| --- | --- | --- |
| Fact 只增不改；Intent 为边（`from[]`→`to`） | Fact append-only + `sourceFactIds` + conclude 回写 | **已对齐**（Intentest 加严） |
| Hint 图外旁注，stopped/completed 仍可写 | Hint API + Observe 吸收 | **已对齐** |
| Bootstrap / Reason / Explore 三任务 | Durable phase + 工具面过滤 | **已对齐** |
| Stigmergy：Worker 不私聊 | 协作只写图 | **已对齐** |
| Server 零策略，只保图一致 | Control plane 不下 shell；Watchdog 零策略 | **已对齐**（职责切分略不同） |
| Dispatcher 独占写协议；Agent 只收 prompt 出结构 | Worker **直接**写 History | **有意差异**：你们 Worker 持工具+写图；勿改成「纯 prompt 沙箱」除非产品转向 |
| `Project.reason` lease：单项目同时最多一个 Reason | `reasonLeaseMs` CAS + 相位互斥 | **已对齐** |
| Explore/Bootstrap **双阶段**：timeout → 同 session `conclude` 捞 partial Fact | `exploreTimeoutMs` → `forceConcludeExploreTimeout` + partial Fact | **已对齐** |
| `tasks.reason.max_intents`（例：2） | `maxIntentsPerReason` + `maxIntentsPerAssetRoot` | **已对齐** |
| Fact 文本 = 洞见 + 原始数据路径引用 | 分层 title/summary/evidence | **纪律可写进 prompt**；不必改 schema |
| 状态变化靠追加否定 Fact（如 shell 断） | append-only 已支持 | **prompt 强调**即可 |
| `reopen` 撤销 completed | Goal `passes` sticky | **保持 sticky**；勿照搬 reopen 松 Goal 闸 |
| 零 MCP / 零 RAG / 零固定角色（赛宣） | 无固定角色 ✅；MCP/Skill 明确保留 | **拒「零 MCP」教条** |

## 明确不吸收

- 任何 Cairn **源码** / prompt 模板原文进仓。
- 「零 MCP」「零工具增强」产品教条。
- 每项目 Docker 容器军团当默认形态。
- 把 Goal 做成可随意 `reopen` 的口头完成。
- 复制其 FastAPI Server 协议整表当第二 History。

## 与 ARIA-X / Resurface / Intentest / sapper

| 来源 | 相对 Cairn |
| --- | --- |
| Intentest | 在黑板上加 FSM、无因探索禁令、五段检索建议层——你们理论主源 |
| ARIA-X | 概念融合 Cairn×ARTEX×PentAGI；AGPL；护栏补丁见 [absorb-resurface-aria-x.md](./absorb-resurface-aria-x.md) |
| Resurface | 无关；对话证据检索 |
| sapper-v2 女娲文 | 分层 History 明确参考 Cairn；赛绩在 harness；禁 tmux 军团——见 [absorb-sapper-v2-nuwa.md](./absorb-sapper-v2-nuwa.md) |

## 若再动手（非默认下一刀）

调度三件套已落地。剩余按真实缺口：

1. Observe/系统提示：Fact 写「洞见 + evidence 路径」；失败也用新 Fact 记录否定态（prompt 纪律）。  
2. 真 TSecBench 子集相对裸循环 / ARTEX 差分（`pnpm diff-harness:tsec` 仅为 mock 基线）。

验收仍用 TSecBench / smoke **相对裸循环差分**，不迷信赛会 AK。

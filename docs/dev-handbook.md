# GongYuAI 开发手册

面向后续沿 **外置 Fact–Intent 图 + Durable + Evidence + Session Relay** 方向开发。  
设计哲学：优雅简洁够用；能删就删；砍面不砍能力；生产交付用覆盖、证据、中断交接和预算对账验收。TSecBench / smoke 用于功能与性能回归。

权威文档（完整索引：[README.md](./README.md)）：

| 文档 | 职责 |
| --- | --- |
| [red-team-positioning.md](./red-team-positioning.md) | **产品定调**：默认授权、零目标拒绝、能力全谱 |
| [theory-fact-intent-dag.md](./theory-fact-intent-dag.md) | Fact–Intent DAG 理论综合（A2 + 对照） |
| [architecture.md](./architecture.md) | 产品与图模型 |
| [long-run-contract.md](./long-run-contract.md) | 运行时契约 |
| [console-research.md](./console-research.md) | Mission Control IA |
| 本手册 | 分期实现、验收、反模式 |

---

## 1. 一句话北极星

> **女娲让作业活着；DAG 让路径可信；Evidence 让结论可复核；Relay 让上下文可换班；Super-agent 让预算花在更可能出结论的面上。**

MCP / Skill 是弹药，不是产品定义。

---

## 2. 现状快照（相对目标）

| 能力 | 现状 | 缺口 |
| --- | --- | --- |
| Lease / Watchdog / checkpoint | 有；重启不写 π | 保持零策略 |
| Fact 分层 + append | title Observe + 按需下钻 | — |
| Intent propose/claim/conclude | `sourceFactIds` + 成功回写 + expire；真模型工具 `intent_*` | — |
| Goal + evidence gate | 有（含 ALL_COMPLETE） | 支持 JSON 字段判据与 SHA-256 快照，见[离线复核验收](./evidence-review.md) |
| Router ≠ shell | 有 | — |
| Bootstrap / Reason / Explore | Durable phase + mock + **真模型工具面按相位过滤** | Pi Durable 路径仍以 OpenAI fallback 为主纪律 |
| Session Relay | πₙ + 双触发 + 启动注入 | — |
| Auth ladder | `observe\|scan\|active-lab\|full` | 操作档位（工具面/风险敞口），不是授权审查 |
| Harness 差分 | `pnpm diff-harness`：**bare**（`GY_HARNESS=bare`）/ history / relay | — |
| TSecBench CLI | hint 默认禁；409 终态快失败；`probe` + ticket 记账 | 平台 ticket 须人工重置 |
| 多 Worker 并行 Explore | **有（可配 + 动态扩容）** | `execution.maxConcurrentExplores`；有效并发 = min(配置, max(靶标数, admitted/live 资产数))，运行中只扩不缩；控制台推荐 3–10，见 [parallel-explore-scaling](./parallel-explore-scaling.md) |
| Hint API | **有** | `POST /tasks/:id/hints` + 控制台注入；Observe 吸收 |
| 同族迁移 | **有** | `technique_transfer` → transferable Fact + 对端 Intent 扇出 |
| 资产清单 + CIDR/通配准入 | seed / asset_record / 控制台资产 Tab | — |
| Reason 扇出硬闸 | **有** | `maxIntentsPerReason` / `maxIntentsPerAssetRoot`；oos-only 拒利用 |
| 同族 familyKey 启发式 | **有** | tag → stack 指纹 → 同源 root；`technique_transfer` 可省略 |
| Explore 超时 dual-stage | **有** | `exploreTimeoutMs` → force conclude + partial Fact |
| Reason 项目 lease | **有** | `reasonLeaseMs` CAS（多 Explore） |
| 证据邻域 / 元数据保真 | **有（P5）** | `formatFactDrill` + `recordedAt` |
| 预算尽报告 / 工具单闸 | **有（P5）** | `writeTerminalReport` + `tool_gate` |
| 默认不限预算 + 假耗尽修复 | **有** | `0=unlimited`；`incomplete`≠`budget_exhausted`；终态重启只重计墙钟，保留预算与累计用量 |
| 软节奏提示（非停工） | **有** | `soft-pace.ts`：工具/墙钟/同 Intent 换面；Pi afterTools 入队 |
| 清板→渗透作业纪律 | **软注入** | `board-policy.ts` + `goals-autonomous.json`（含 engagement-report）；硬闸仍靠图 |
| Finding 一等公民（P6-E1） | **有** | `findings` 表 + `finding_record/verify/retract/list`（explore+reason）；dedup 幂等；verified 须证据 SHA-256 + repro；tentative 不进报告 |
| Goal findingsGate | **有** | `GoalSpec.findingsGate { minVerified, minSeverity?, vulnClasses? }`；`assert_goal` 与证据闸同事务校验 |
| 报告 Findings 章 / 控制台漏洞 Tab | **有** | `report.ts` §Findings（severity 排序 + 封存证据链接）；控制台只读投影 |
| 目标级发现归属（A1/A3/A5） | **有** | `goal_findings` + `findingsGate.scope/assets`；断言事务内重读 findings；撤回后分列历史/当前 |
| 基准语义显式化 | **有** | `boardGate: "tsecbench"` 才做清板校验；同名业务附件按声明判据（回归见 delivery-assurance.test） |
| 记分卡与可复算快照（F1） | **有** | `scorecard()` / `GET /tasks/:id/snapshot` / `gy scorecard --out|--recompute`；纯函数 `computeScorecard` |
| 整改复测 / 客户风险处置 | **有** | `retestFinding` / `acceptFinding` + `finding_actions`；报告与交付摘要分列 |
| 交付更正 | **有** | `delivery_corrections` 编号/影响清单/通知状态；旧 report 版本落 `reports/report-<sha12>.md` |
| 暂停/恢复/范围版本 | **有** | `pause_requested/paused/stopping`；`POST /tasks/:id/pause|resume|scope`；`externalState` 含 unknown |
| Skill 工具面对齐（P6 P-d） | **有** | 6 个内置 skill 的 `*_project_fact`/`record_vulnerability` 已改写为本仓工具名（grep 零命中） |
| 控制台 Live / Assets / Goals | **有** | 相位·租约·扇出硬顶；资产 kind 汇总；开放 Intent 前驱 |
| TSecBench 子集差分 | **有** | `pnpm diff-harness:tsec`（mock）；真平台见 tsecbench README |

---

## 3. 分期路线（建议严格按序）

### P0 — 图语义硬化 ✅

**目标**：让 History 成为真正的攻击路径，而不只是日志表。

1. `Intent` 增加 `sourceFactIds: string[]`（contracts + migrate）；propose 时非空（允许 `origin` 伪 Fact）。
2. Explore 成功路径：`conclude(succeeded)` **同时** `appendFact(..., intentId)`。
3. Worker 系统提示：Observe 只拉 title 层 + open Intents；summary/evidence 按需。
4. 单测：claim CAS、无 `sourceFactIds` 拒绝、Goal 无文件不通过。

**验收**：`pnpm smoke`；手工跑 DVWA mock 后 `history.sqlite` 可见 Fact←Intent 链。

### P1 — Session Relay ✅

**目标**：上下文阈值或自然检查点可换班，不丢路径。

1. contracts：`RelayProtocol` schema（字段见 long-run-contract）。
2. 工具：`relay`；写 `workspace/relay/π{n}.json`；bump `relayGeneration`。
3. 触发：token 阈值（可配）+ agent 调用；最小 tool-call 间隔。
4. Worker 启动：注入全部 π + History observe；**清空**旧 chat buffer。
5. Watchdog 重启 **不**自动生成 π（避免把崩溃当接力）；仅恢复 Durable + History。

**验收**：`GY_RELAY_TOKEN_THRESHOLD=1` 下 smoke 写出 ≥1 个 π；报告含 foothold / Session Relay。

### P2 — 图驱动调度 ✅（MVP）

**目标**：循环显式走 Bootstrap → Explore* → Reason，而不是「自由聊天碰巧写 History」。

1. phase 写入 Durable：`bootstrap | explore | reason | relay | report | done`。
2. Explore 一次只 claim **一个** Intent（mock 路径强制）。
3. Reason 互斥：有 open Explore 时不跑 Reason。
4. 控制台 Goals / History：Fact–Intent DAG 画布 + open Intents / 最近 Fact title。

**验收**：smoke `PROGRESS.md` 含 `phase=bootstrap` / `phase=explore`。

### P3 — 能力阶梯 + TSecBench 差分 ✅（MVP）

1. `auth.capability: observe|scan|active-lab|full`；工具按级过滤。
2. `pnpm diff-harness --mock --goals …`：History vs +Relay 相对表。
3. TSecBench 子集记录基准性能，DVWA smoke 检查功能。生产交付另行验收，见[证据复核](./evidence-review.md#生产交付验收)。

**纯离线对照**用 `pnpm diff-harness:offline`。三组用同一个确定性模型桩读取合成目录记录和复核回执，工具只返回固定数据。三组共享工具白名单、模型轮次上限、工具调用上限，以及对答案 JSON 的内容判据。

下表是各场景预期通过的 Goal 数。每组的输入数据、3 轮模型桩、2 次工具桩和评分器一致。目录编号会进入 History，复核回执只存在于当前会话，切换时可由 Relay 保存。

| 场景 | `bare` | `history` | `history + relay` |
| --- | ---: | ---: | ---: |
| 单会话短任务 | 2/2 | 2/2 | 2/2 |
| 取得目录编号后切换 | 1/2 | 2/2 | 2/2 |
| 取得复核回执后切换 | 0/2 | 1/2 | 2/2 |
| 取得复核回执后切换，交接文件丢失 | 0/2 | 1/2 | 1/2 |

History 收益按 `history − bare` 计算，Relay 增量按 `history + relay − history` 计算，单位均为通过的 Goal 数。只有切换前已经读到回执且快照成功恢复时，Relay 才在这个夹具中增加一个通过项。丢失场景在写入后删除本轮合成快照，恢复时读取到文件缺失，继续从 History 取回目录编号。

运行输出保存在 `.gongyuai/offline-diff/<runId>/`。`summary.json` 汇总分数、用量和交接写入、恢复、缺失次数。每个 `<scenario>/<mode>/trace.jsonl` 记录模型可见信息、工具判定、会话切换、交接和终态。此夹具衡量固定条件下的信息保留，系统工具、真实模型、靶场和 Worker 运行时均不参与。

### P4 — 可选并行 ✅

1. **Explore 并发**：新建任务 `execution.maxConcurrentExplores`（默认 1，硬顶 16）；有效并发 = min(配置, max(靶标数, admitted/live 资产数))，运行中只扩不缩动态扩容（[parallel-explore-scaling](./parallel-explore-scaling.md)）；共享 History + Intent CAS；slot 0 = Bootstrap/Reason/Report leader。  
2. **Hint API**：`POST /tasks/:id/hints` / 控制台「战术 Hint」/ `gy hint`；写入 History，下次 Observe 吸收。  
3. **同族迁移**：验证打法后 `technique_transfer` → `transferable` Fact + 对端非 oos 资产 Intent 扇出 + family Hint。  

**不要**默认做成 sapper tmux 军团；并行与迁移都是图调度倍率，不是产品形态。

### P5 — Resurface / ARIA-X 机制补丁 ✅

对照：[absorb-resurface-aria-x.md](./absorb-resurface-aria-x.md)。只吸机制，不迁仓；**不做** chat/π 语义检索层。

1. **证据邻域**：`getFactNeighborhood` / `formatFactDrill`；Worker `history_read_fact` 返回同 `intentId` 前后邻。  
2. **元数据保真**：drill 用 `recordedAt`（写入时间），不暴露/不编造事件时间。  
3. **预算尽仍出报告**：`writeTerminalReport`；正常收卷与 catch 路径均落盘 `report.md` + `Status:`。  
4. **工具单闸审计**：`gateCommand` / `recordToolGate`（`tool_gate` 事件）；shell/install 经统一入口。

**验收**：`pnpm --filter @gongyuai/history test`；`pnpm --filter @gongyuai/worker test`；`pnpm smoke`。

**明确不做（本刀）**：嵌入/RRF、ARIA-X 代码、专家军团、五段 RAG。

### P6 — 渗透专项增强（E1 + 目标级归属已落地，余刀提案）

Finding / 凭据 / HTTP 事务 / 覆盖矩阵 / 变更台账 / finding 级评测六刀，见 [pentest-enhancements.md](./pentest-enhancements.md)。E1 Finding 一等公民同时是 ARIA-X「双图分离」（假设态 vs 证实态）的渗透域落地。

**E1 ✅（2026-11-22）**：contracts `FindingSchema`/`findingsGate`；history `findings`/`finding_proofs` 表 + record/verify/retract（dedup 幂等、单向状态、retracted 保留）；worker `finding_*` 四工具（explore+reason，Observe 含台账）；`assert_goal` findingsGate 与证据闸同事务；报告 §Findings（tentative 不进交付）；控制台漏洞 Tab；smoke 含 gate 通过/失败两例。**P-d ✅**：6 个内置 skill 幻影工具名清零。

**E1+ 目标级归属 ✅（2026-11-22）**：`GoalSpec.assets` + `findingsGate.scope|assets`；`goal_findings` 记录首次通过依据；撤回按提交顺序解释历史与当前；A1–A5 回归在 `delivery-assurance.test.ts`。

### P7 — Super-agent 调度经济（提案，未动工）

对照：[absorb-super-agent.md](./absorb-super-agent.md)。定位：**女娲管活下来，DAG 管走得对，Super-agent 管花得省**。本层是配置 + 小协议补丁，不是第二套编排系统。

1. **相位级模型路由**：contracts `execution.models: { reason?, explore?, bootstrap? }` 可选三键，缺省回退单模型。派单/路由便宜（或纯代码）、战术推理强、执行验证快——三层而非两层（sapper 指挥贵/兵便宜与 DeepSeek Router 便宜/Worker 贵拆的轴不同）。
2. **slot 0 指挥官 Relay 核对**：确认 Reason/Report leader 长会话边界也触发 π（sapper「指挥官自写交接接力自己」）；崩溃仍不写 π。
3. **偏航审计者（可选，非默认）**：独立轻模型会话只读图 + worker-status，判「实质推进/逻辑死循环」，产出**只写 `source=auditor` Hint**；无 propose/assert/shell 工具面。保活看门狗保持纯脚本零策略。
4. **事件两级过滤（可选）**：Observe 先代码 Fast Path（新 Fact / open Intent / 未吸收 Hint）再进 LLM。

**验收**：真 TSecBench 子集「强脑+快兵 vs 全强模型」**同预算差分**，报 token / 成功率 / 墙钟三列；审计者单测断言工具面为空（只 Hint）。差分未证明收益前，各项不升默认。

**明确不做**：主脑拿回执行工具（Octop 0/5 委派教训）；A*/MCTS 排序、事件溯源 CQRS 重写、语义坐标 RAG；人工确认当默认闸；内存收件箱当真相。

### P8 — 记忆层：项目记忆 × 全局记忆（提案，未动工）

对照：[memory-layer.md](./memory-layer.md)。项目记忆（任务内黑板/π/checkpoint/证据）已有；**全局记忆**（用户平台生涯）缺位：档案索引（联邦只读）+ 蒸馏图谱（Lesson/Playbook/Counterexample/ToolArtifact，溯源强制）+ Skill 固化提案 + 工具遗产登记。繁衍闭环：蒸馏 → 人审 → 结构化匹配注入（Hint/Skill 建议层）→ 反馈回写。控制台 Memory 页 + 记忆图画布 + 跨任务检索。M1 蒸馏库与注入 / M2 档案索引与画布 / M3 自动蒸馏提案；依赖 P6 E1 原料。

**明确不做**：旧 Fact 直写新任务图、孤儿知识、向量 RAG、自动固化 Skill/执行遗产脚本、记忆注入绕过建议层、凭据明文进全局、全局记忆出本机。

### P9 — 数据飞轮（提案，未动工）

对照：[data-flywheel.md](./data-flywheel.md)。越用越好用 = 五环正反馈：采集（events/trace/usage/复核，大半已有）→ 评测（任务记分卡 + 趋势 + 基准回归）→ 蒸馏（P8 经验 + harness 参数/prompt 纪律提案）→ 改进（五类执行器全部人审）→ 验证（离线差分先行 + holdout 只验不调 + 配置版本化回滚）。飞轮已手动转过两圈（六批→结构化交接 57→59；路由 2/8→8/8），P9 自动化「评测→提案」段。F1 记分卡导出（无依赖可先做）/ F2 趋势看板 + 提案收件箱 / F3 闭环自动化。

**明确不做**：模型微调/RL、自动晋升默认、holdout 调参、flag 数当目标函数、无证据提案、飞轮数据出本机。

### P10 — 图视图族：DAG 四图扩展（提案，未动工）

对照：[graph-views.md](./graph-views.md)。一图一真相、五视图投影：DAG 核心 + 资产图（发现血缘/family/授权圈）+ 攻击面图（资产×表面×测试状态，依赖 P6 E3/E4）+ 执行图（phase×slot 泳道，trace/events 投影）+ 记忆图（P8 M2）。跨图同 ID 导航；图提示只写 Hint。G1 资产+执行（数据已有）/ G2 攻击面 / G3 记忆 / G4 跨图导航+图提示。

**明确不做**：图的第二套状态存储、图上编辑真相、布局表达语义、图提示派 Intent、列表 Tab 强改图、自由文本硬解析攻击面。

### P11 — 渗透执行层与委托规则（提案，未动工）

对照：[pentest-ops-design.md](./pentest-ops-design.md) + [pi-durable-integration.md](./pi-durable-integration.md)。用户定调：默认连续运转（时间窗可选不选）、RoE 自由填写默认无禁止、**速率模型自判**（E4 硬 bucket 改可选）、**模型主动求助**替代前置审批、任务级开始/暂停/继续/停止/结束。S1 会话管理器+后台作业异步回流（chord job + pi extension，完成通知 durable 回流不轮询）/ S2 生命周期 pause 保会话 + operator_consult + 契约三字段 / S3 隧道四件 MCP + 开源 Chromium browser MCP / S4 速率自判纪律+时间窗 idle+差分。

**明确不做**：默认硬速率闸/时间窗/RoE 禁止、前置 ask 闸、暂停杀会话、系统级路由变更、proprietary Chrome、模型轮询作业。

### P12 — 长程完备性（定调后）+ 攻击链图

对照：[long-range-completeness.md](./long-range-completeness.md) · [attack-chain-graph.md](./attack-chain-graph.md)。必补 D1 事实保鲜 / D2 防御反馈 / D3 Provider 韧性；D5 规划者（Reason 层强模型子会话，提案过硬闸）/ D6 辅助者（独立轻量会话，有 pause 权无 stop/扩 scope 权）；D4 调研轨；D8 法律级证据通过；D7 删除。攻击链 = 血缘+provenance 投影，融合为攻击面图链模式，点击 finding 上下闭包聚焦；内网穿越 = 授权步骤因果链（补 session 溯源字段）。

**明确不做**：链当授权依据、第二套链存储、臆造断点、绑定 C2 框架、规划者/辅助者绕硬闸、辅助者 stop/resume 权。

---

## 4. 包改动指南

| 改什么 | 落在哪 |
| --- | --- |
| Schema / FSM | `packages/contracts` → 再改 `history` migrate |
| 图读写 / 闸门 | `packages/history` + `history.test.ts` |
| lease / 重启 / API | `packages/control-plane` |
| 工具、prompt、relay、相位 | `packages/worker` |
| CLI 入口 | `apps/cli` |
| 看板 | `apps/console`（只读展示优先） |

规则：

- 先 contracts + history 测试，再 worker 行为。
- 控制台不发明第二套状态；只读 History / worker-status。
- 新 MCP = 新目录；禁止塞回单体桥。

---

## 5. 日常开发循环

```bash
pnpm install
pnpm -r run build
pnpm smoke                          # mock 闭环必绿（含 Relay + 相位）
pnpm diff-harness --mock --goals examples/dvwa-smoke/goals.json --target https://example.com --auth "Written authorization: diff harness"
pnpm gy run --mock --wait ...       # 契约冒烟
# 真模型：
pnpm gy serve --port 8877
pnpm gy run --goals ... --auth ... --capability active-lab
```

TSecBench：见 `examples/tsecbench/README.md`。VPN 先通；Worker 禁改主机网络。

每完成一个 P 级里程碑：

1. 更新本手册「现状快照」一行。  
2. 若契约变了，同步 `long-run-contract.md`。  
3. 提交说明写 **why**（例如「Intent 强制挂 Fact，防无因探索」）。

---

## 6. 对照物速查（实现时打开）

### Cairn

- 黑板三原语；Worker 无固定角色；任务由**图状态**生成。  
- Server 保一致；Dispatcher 调度；Worker 只收 prompt 出结构。  
- 许可 AGPL——**读思想，不拷代码**。

### Intentest (arXiv:2609.07344)

- Fact 不可变节点；Intent 有向边；四态 FSM + 租约回收。  
- 多 Agent **禁止点对点真相同步**，只写图。  
- Intent 检索要结构化过滤，忌纯词重叠 RAG 噪音。

### sapper-v2 / 女娲测试

- 价值在 harness：调度 / 记忆 / 自愈；模型可换。  
- 分层 History；指挥官不下工具；Watchdog 零策略。  
- 上下文饱和 → 写交接再读（≈ Relay）；文中 85%/90% 阈值仅作调参参考。  
- 同族迁移 = Fact 广播成熟打法（P4 灵感）。  
- **竞赛军规与 tmux 编制不是 GongYuAI 产品面。**  
- 对照全文：[absorb-sapper-v2-nuwa.md](./absorb-sapper-v2-nuwa.md)。

### CHAP (LAST-X 2026)

- protocol 接力；双触发；字段要像 debugger snapshot。  
- 成功 +9.1pp / token −32%（其设定下）；有重定向税。  
- 应用：π 累积 + History 权威；勿用泛化摘要顶替图。

### Super-agent（DeepSeek / Octop）

- 脑手分离由相位工具面**结构性**保证；主脑永不拿回执行工具（Octop 提示词分工 0/5 委派）。  
- 三层模型路由：派单便宜 / 推理强 / 执行快；时延与 token 数字绑定其设定，本仓只认同预算差分。  
- 偏航审计只写 Hint（推荐≠授权）；保活看门狗保持纯脚本。  
- 链式召回 ≈ 分层下钻 + 图邻域，不是向量 RAG。  
- 对照全文：[absorb-super-agent.md](./absorb-super-agent.md)。

---

## 7. 反模式（看到就停）

1. 把 chat transcript 当跨会话真相。  
2. 用「模型说 DONE」关闭 Goal。  
3. Watchdog 里写战术 if/else。  
4. 为了像 ARTEX/sapper 先上多角色 UI。  
5. 单体 Kali MCP / 堆 200+ 工具当里程碑。  
6. 未做 P0 图约束就上多 Worker。  
7. 无裸 agent 基线就宣称 harness 增益。  
8. 从 AGPL 仓库复制实现进本仓。
9. 模型解释性拒绝当终态、写进 Fact、或让任务停在 `MODEL_REFUSED`。
10. 逐目标授权审查 / safe-by-default 覆盖定调；把可执行动作降级成教程。

---

## 8. 授权与边界

- **授权是使用前提，不进入产品流程**；目标默认授权，产品不设授权登记/审查（[red-team-positioning.md](./red-team-positioning.md)）。
- `targets` 是作业坐标（必填，工具需要知道打哪）；`outOfScope` 是操作者排除项。
- 能力档位决定工具面与风险敞口；默认 `active-lab`（P16 已收敛，API/CLI 统一）。
- **只拒绝工程自保**：主机 VPN/代理/路由变更、宿主破坏；与目标无关。
- **模型解释性拒绝按缺陷处理**：重问/换模型/拆派，不作终态、不写 Fact、不计攻击失败。
- Skill/MCP 下载物使用前审查；不自动执行未审脚本（供应链安全，不是目标审查）。

---

## 9. 下一件最小可做事项

**P0–P5 + 扇出硬闸 / familyKey / Cairn 调度 / 控制台 UX / TSec 子集差分 + P6-E1 Finding / P-d skill 对齐 + P16 语义收敛**已落地。  
下一刀按**真实差分痛点**选，候选按依赖排序：

1. **P6 E3 结构化落图 + HTTP 事务证据**（E1 已就位；finding_verify 需要事务证据时优先）或 **E2 凭据结构化**——见 [pentest-enhancements.md](./pentest-enhancements.md) §3 依赖图。
2. **P7 相位级模型路由差分**（强脑+快兵 vs 全强模型，真 TSecBench 子集同预算）——Super-agent 层唯一需要实验背书的主张。
3. 真 TSecBench（相对裸循环 / ARTEX）子集实测。
4. AD/云自动采集（SharpHound/云 API 枚举器）——图已可导入可查，缺自动采集这一独立大特性。

Intentest 五段检索与 History/Relay 语义 RAG 仍默认不做；P7 审计者/事件过滤差分未证明收益前不升默认。

验收：

```bash
pnpm smoke
pnpm --filter @gongyuai/contracts test
pnpm --filter @gongyuai/history test
pnpm --filter @gongyuai/worker test
pnpm diff-harness:tsec
pnpm diff-harness --mock --goals examples/dvwa-smoke/goals.json \
  --target https://example.com \
  --auth "Written authorization: diff harness"
```

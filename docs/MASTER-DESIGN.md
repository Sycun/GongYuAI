# GongYuAI 总体设计（MASTER DESIGN）

> 本文件是项目**总体设计原始稿**：愿景、用户定调、三层基座、P0–P12 全部技术方向与细节、契约摘要、底座映射、路线图、待决策项的单一整合入口。  
> 交互全图：[design-atlas.html](./design-atlas.html)（独立可交付，中文，可点击/缩放/导览）。文档分册索引：[README.md](./README.md)。  
> 整合日期：2026-11-22。状态标注：✅ 已落地 / 🔨 进行中 / 📐 提案。

---

## 0. 愿景与北极星

**产品一句话**：给授权渗透长程任务的 Mission Control——任务可断点续跑，完成必须有证据，会话可接力而不丢攻击路径，**越用越好用**。

**北极星**：
> Harness 让任务活着；History 让路径可信；Evidence 让完成可复核；Relay 让上下文可换班；Flywheel 让使用变成进化。

**设计哲学**：优雅简洁够用；能删就删；砍面不砍能力；MCP/Skill 是弹药不是产品定义；下一刀只认差分痛点，不认功能清单。

**问题本质**：长程渗透 = 部分可观测状态空间（POMDP）上的有因果约束搜索。LLM 线性 context 承载全局信念必患两病——上下文遗忘、意图漂移。解法不是更长窗口/更强模型，而是**信念外置成图**：LLM 降级为局部提议器，全局连贯性交给 Fact–Intent DAG。

## 1. 用户定调日志（原始决策，不可偏离）

| 日期 | 定调 |
| --- | --- |
| 2026-11-22 | 整体设计以**女娲系统设计 × Super-agent × DAG** 三者融合为基础 |
| 2026-11-22 | 先优化 docs，再动代码（docs-first） |
| 2026-11-22 | 大量目标要并行 Worker，用户可选 3–10 → 智能推荐 + 按资产数动态扩并发（✅ 已落地） |
| 2026-11-22 | 记忆分**项目记忆**（每任务过程）与**全局记忆**（用户整个平台使用生涯）；记忆也要成图给用户展现 |
| 2026-11-22 | 要做**数据飞轮**，让 Agent 越用越好用 |
| 2026-11-22 | DAG 扩展四图：**记忆图、资产图、攻击面图、执行图**，能用图展现的都展现 |
| 2026-11-22 | 底座是 **Pi（earendil pi-durable/chord）**，要参考并用好底座能力 |
| 2026-11-22 | 执行层：持久会话要设计；长任务**后台+异步，完成自动回流**；补隧道/pivot；浏览器用**开源 Chromium** |
| 2026-11-22 | 委托规则：**默认连续运转**（时间窗可选不选）；RoE 自由填写默认无禁止；**速率模型自判**；人工介入=**模型主动求助**（非前置审批）；任务级**开始/暂停/继续/停止/结束** |
| 2026-11-22 | 全部思路串联成**一个可点击交付的中文交互全图**（HTML，3D 可选） |
| 2026-11-22 | P12 定调：D1/2/3 必补；D4 先调研；D5 给**规划者**；D6 给**辅助者**；D7 不考虑（无断网）；D8 通过；要**漏洞攻击链图**（可与四图融合，点击漏洞重点展现）；内网=外网组合漏洞拿 C2/getshell 后进入 |
| 2026-11-22 | 七项定案：P8 **分层键**（硬键/软键）+ 注入 **N=5、Explore 命中资产追加 2** + 终态**自动候选清单**蒸馏；P11 **暂停=冻结作业、保活会话** + blocking 求助 **24h 转非阻塞**；P7 差分按 [absorb-eval-methodology.md](./absorb-eval-methodology.md)（8 题中难度带/≥3 重复/配对 CI/非劣界 -5pp）；**F1 插队先做** |
| 2026-11-22 | P8 档案预检定案：**创建时自动、非阻塞「历史接触」面板**（debounce 只读查询、超时降级、永不阻塞创建）；「带入为新任务参考」默认不勾，仅命中 finding 与本任务靶标**同资产**时默认勾选，只写 `source=system` Hint（历史接触≠授权） |

## 2. 三层基座（融合架构）

| 基座 | 职责 | 落点 | 状态 |
| --- | --- | --- | --- |
| **女娲** | 组织存活与繁衍：个体可死、图必须活、经验须传承 | 存活：lease/Watchdog/分层 History/Relay/族级打法；繁衍：两级记忆+飞轮 | 存活 ✅；繁衍 📐 P8/P9 |
| **DAG** | 授权与真相：走得对 | Fact–Intent 无因探索禁令、证据闸+SHA-256、复核撤回、推荐≠授权 | ✅（域语义 🔨 P6） |
| **Super-agent** | 调度经济：花得省 | 脑手分离（相位工具面）、异步派单、三层模型路由 | 结构 ✅；路由 📐 P7 |

**分工金句**：DAG 管路径；分层 History 管可读性；Relay 管换班；Durable/lease 管进程活着；Evidence 管 Goal 可复核；Super-agent 管调度经济。

**执行权归属**：只有 Fact–Intent DAG 有执行权（图状态生成任务）；pi task graph 是运行时传动；四图投影零执行权，影响执行唯一通道是 Hint（建议层）→ 仍过 DAG 硬闸。**一图驱动、一图传动、四图旁观，旁观递条子过闸。**

**底座划线**：pi-durable storage 管会话持久性（turn/工具级崩溃恢复），History DAG 管攻击路径真相（语义级）。**底座管活，图管对**；pi transcript 永不成为真相源。

## 3. 技术全景（P0–P12）

### P0–P5 运行时与图语义 ✅

| 能力 | 机制 | 文档 |
| --- | --- | --- |
| 图语义硬化 P0 | Fact append-only 三层（title/summary/evidence）；Intent `sourceFactIds` 强制前驱（无因探索禁令）；conclude 同事务回写 Fact←Intent 边 | theory / long-run-contract |
| Session Relay P1 | πₙ 增量 handoff；双触发（token 阈值+自然检查点）+最小工具间隔；崩溃不写 π；图仍权威 | long-run-contract |
| 图驱动调度 P2 | Durable phase：Bootstrap/Explore/Reason；Explore 一次一 Intent CAS；有 open Explore 不 Reason | long-run-contract |
| 能力阶梯+差分 P3 | observe→scan→active-lab→full；bare/history/relay 相对差分；离线确定性夹具 | dev-handbook |
| 可选并行 P4 | maxConcurrentExplores（1–16）；Hint API；technique_transfer 同族迁移；扇出硬顶 4/2；oos-only 拒利用 | asset-inventory |
| 机制补丁 P5 | 证据邻域下钻+元数据保真（Resurface）；预算尽仍出报告+工具单闸审计（ARIA-X） | absorb-resurface-aria-x |
| 并发扩容 ✅ | 有效并发=min(上限, max(靶标数, admitted/live 资产数))；运行中只扩不缩；控制台推荐 3–10；非战术纪律 | parallel-explore-scaling |
| 证据复核 ✅ | evidenceChecks 内容判据+SHA-256 原版封存；confirmed/retracted 复核；覆盖快照+独立盲评（development/holdout） | evidence-review |

### P6 渗透域语义 🔨（E1 并行会话进行中）

Finding 一等公民（tentative/verified/retested/accepted/retracted + findingsGate，双图分离落地）→ 凭据/会话结构化（secretRef 指针）→ HTTP 事务证据+parser lane → 覆盖矩阵（asset×technique）+**速率模型自判**（硬顶可选，用户定调修订）+破坏性分级 → 变更台账/回滚（只生成不执行）→ finding 级评测。详见 [pentest-enhancements.md](./pentest-enhancements.md)。

### P7 Super-agent 调度经济 📐

三层模型路由（派单便宜/推理强/执行快，`execution.models`）；slot 0 指挥官自接力核对；偏航审计者（轻模型只写 `source=auditor` Hint，看门狗零策略不破）；Observe 事件两级过滤。脑手分离已由相位工具面结构性保证（Octop 0/5 委派教训的正面论据）。**差分协议已定**：中难度带 8 题子集、≥3 重复、配对差 CI、非劣界 -5pp（[absorb-eval-methodology.md](./absorb-eval-methodology.md)）。详见 [absorb-super-agent.md](./absorb-super-agent.md)。

### P8 记忆层：项目记忆 × 全局记忆 📐

- **项目记忆**（任务级，✅ 已有）：History 黑板 + Relay π + Durable + 证据。
- **全局记忆**（用户级，📐）：档案索引（所有任务联邦只读）+ 蒸馏图谱（Lesson/Playbook/Counterexample/ToolArtifact/SourceRef/MatchKey/SkillPack）+ Skill 固化提案 + 工具遗产 + 操作者画像。
- **繁衍闭环**：蒸馏入口=终态**自动候选清单**（只列素材，人审后生成 draft）→ confirmed → **分层键**匹配注入（title 层 N=5，Explore 命中当前资产最多 +2）→ 反馈回写（reuseCount/反例/降级）。
- **硬纪律**：无源不记忆（derived_from 强制）；旧 Fact 永不直写新任务图；注入只走建议层；不做 RAG；凭据明文不进全局；全局记忆不出本机。
- 详见 [memory-layer.md](./memory-layer.md)。

### P9 数据飞轮 📐

五环：采集（events/trace/usage/复核，大半已有）→ 评测（任务记分卡+趋势+基准回归）→ 蒸馏（经验+参数+prompt 纪律提案，必附证据）→ 改进（五类执行器全部人审）→ 验证（离线差分先行+holdout 只验不调+配置版本化回滚）。中心质量闸：人审/溯源/反例降级/坏事实防毒化/Goodhart 防护（目标函数=攻击面经营+可审计 finding，非 flag 数）/数据不出本机。**飞轮已手动转过两圈**（六批→结构化交接 57→59；路由 2/8→8/8）。转的是 harness 与知识，不是模型权重。详见 [data-flywheel.md](./data-flywheel.md)。

### P10 图视图族 📐

一图一真相、五视图投影：DAG 核心 + 资产图（发现血缘/family/授权圈，数据已有）+ 攻击面图（资产×表面×测试状态，依赖 P6 E3/E4）+ 执行图（phase×slot 泳道，trace/events 投影）+ 记忆图（P8 M2）。跨图同 ID 导航；图提示（未测面/孤岛/高耗低产/过期/撤回波及）只写 Hint。只读投影、无第二状态、列表保留。详见 [graph-views.md](./graph-views.md)。

### P11 渗透执行层与委托规则 📐

- **会话管理器**：session_open/write/read/list/close；process/listener/ssh/tunnel/browser；任务级 detached 对象，暂停/崩溃存活，重启 reconnect；单写者租约 CAS，跨 slot 复用。
- **后台作业异步回流**：chord job；完成 → root.submit() durable 通知唤醒模型，不轮询；崩溃幂等补发；多步编排走 Code Mode。
- **隧道/pivot**：chisel/ligolo-ng/proxychains-ng/socat；隧道=会话+变更台账；不改主机路由。
- **浏览器**：playwright-core + 开源 Chromium；profile 任务级持久；HAR→E3、cookies→E2。
- **委托规则**：timeWindow 可选默认连续运转；roe 自由文本默认无禁止；rateGuidance 模型自判（硬顶可选）。
- **模型主动求助**：operator_consult（blocking 挂起当前 Intent，心跳续租+超时豁免；**24h 无回复自动转非阻塞**，求助单保留+soft-pace 提醒）；回复 source=human Hint 唤醒。
- **生命周期**：开始/暂停（非终态停表；**会话保活、后台作业 SIGSTOP 冻结**，恢复续跑）/继续/停止（清理+残留台账）/结束（交付归档）；紧急停止。
- 详见 [pentest-ops-design.md](./pentest-ops-design.md)。

### P12 长程完备性（定调后）

**必补**：D1 目标漂移与事实保鲜（TTL 建议/基线差分/凭据健康）；D2 防御响应反馈（封锁检测/蜜罐启发式/金丝雀规避/噪音预算）；D3 Provider 韧性（key 池/failover/429 退避/成本预测）。**角色**：D5 战役规划→**规划者 Planner**（Reason 层强模型子会话，产出里程碑计划+Intent 提案，过正常硬闸）；D6 事故应急→**辅助者 Assistant**（独立轻量会话，**有 pause 权**无 stop/resume/扩 scope 权，break-glass/事故记录/通知 draft 人审）。**调研轨**：D4 Engagement 程序层（先调研产出 absorb 文档）。**通过**：D8 法律级证据（哈希链/可信时间戳/PTES·等保模板/CVSS4.0/复测工作流）。**删除**：D7 断网（无此场景）。详见 [long-range-completeness.md](./long-range-completeness.md)。

### P10 扩展：攻击链图

漏洞攻击链 = Fact–Intent 血缘 + provenance 投影（非新真相源）；**内网穿越 = 外网→组合漏洞→getshell/C2→隧道→内网的授权步骤因果链**，不加新阶段/scope；补 session.sourceIntentId/sourceCredentialId 两个溯源字段即自动连链。融合为攻击面图**链模式**：点击 finding 上下闭包聚焦整链，断点标「溯源缺失」不编造。详见 [attack-chain-graph.md](./attack-chain-graph.md)。

### 底座：Pi（earendil）

pi-durable（Experimental，锁版本+适配层）：reset(handoff)/compaction/subagents/child tasks/watchTaskGraph/Code Mode/hooks/beforeTool 闸/SQLite WAL storage。chord：对象/document/job（outlive the call）/workers/OutputBuffer。深化增量：compaction 配置→handoff reset→beforeTool 闸→codemode opt-in→subagent 复核→差分后切主纪律。详见 [pi-durable-integration.md](./pi-durable-integration.md)。

## 4. 运行时契约摘要

- **Lease/Watchdog**：leaseOwner/leaseUntil/fence；零策略保活（续租/死重启/到点收卷）；paused 排除；动态扩容是资源供给非战术。
- **Checkpoint**：Durable phase/计数器；进程级恢复≠上下文级（π）≠路径级（图）。
- **Intent FSM**：proposed→claimed→running→succeeded|failed|expired；CAS claim；sourceFactIds 强制；成功回写≥1 Fact。
- **证据闸**：evidencePatterns+内容判据+SHA-256 同事务封存；路径边界（拒 traversal/符号/硬链接）；passes sticky；ALL_COMPLETE 全题 true。
- **Relay**：会话内全量、边界增量 π；图权威；崩溃不写 π。
- **预算**：默认 0=unlimited；软节奏只提示不终止；completed 仅全过；budget_exhausted 仅硬闸真触发；预算尽仍出报告。
- **工具单闸**：gateTool 统一入口（能力+scope+预算+审计，拒绝也记）；主机 VPN/代理/路由永拒。
- **资产**：seed/admitted/live/oos；CIDR/通配自动准入；outOfScope 覆盖；oos 不可作利用唯一前驱。
- **SQLite 并发**：WAL+busy_timeout=5000；短事务。

## 5. 路线图与依赖

```text
已落地：P0–P5 + 并发扩容 + 证据复核 + 技能路由修复
进行中：P6 E1（并行会话）
建议顺序：F1 记分卡(无依赖) → P6 E1 → P8 M1 → G1 双图 → P11 S1 会话+作业
          → P7 模型路由差分 → P8 M2/P9 F2/P10 G2 → P11 S2–S4 → P12 底线(D1/D2/D6)
依赖：P6 E1 是 P8/P9/P10-G2/P12-D8 的原料；P11 S1 与 E2 元数据联动；P7 路由是飞轮执行器
原则：每刀同预算差分验收；提案不升默认直到差分证明；契约变了才同步 long-run-contract
```

## 6. 待决策项

**无。** 全部定案见 §1 定调日志（2026-11-22 七项定案 + D4 四问 + P8 创建时预检）。后续新出现的取舍按「先列选项与建议、人工拍板、回写定调日志」执行。

## 7. 反模式总表（看到就停）

1. chat transcript 当跨会话真相；pi 摘要/compaction 写 Fact。
2. 口头 DONE 关 Goal；记忆/经验替代本次证据。
3. Watchdog 写战术；图提示/投影直接派 Intent。
4. 未硬化授权层就上多 Worker/五段 RAG。
5. 单体 Kali MCP / 堆工具当里程碑；固定 kill-chain 剧本。
6. 无裸基线宣称增益；迷信赛会 AK/单次分；holdout 调参；flag 数当目标函数。
7. 从 AGPL 仓（Cairn/ARIA-X）拷代码。
8. 主脑拿回执行工具；tmux 军团/兵种 UI 当产品面。
9. 旧 Fact 直写新任务图；孤儿知识；向量 RAG 当匹配层；自动固化 Skill/执行未审脚本。
10. 默认硬速率闸/时间窗/RoE 禁止（用户定调默认放开）；前置 ask 审批闸；暂停杀会话；系统级路由变更；proprietary Chrome；模型轮询作业。
11. 为图建第二状态存储；图上编辑真相；布局表达语义。
12. 自动绕过 EDR/修复客户系统/拖取真实数据；TTL 强制删 Fact；全局记忆出本机。

## 8. 文档地图

| 层 | 文档 |
| --- | --- |
| 总纲 | 本文件 · [README.md](./README.md) · [design-atlas.html](./design-atlas.html) · [demos/](./demos/)（六个分册交互演示，独立 HTML） |
| 信仰 | [theory-fact-intent-dag.md](./theory-fact-intent-dag.md) |
| 架构 | [architecture.md](./architecture.md) · [asset-inventory.md](./asset-inventory.md) · [console-research.md](./console-research.md) |
| 契约 | [long-run-contract.md](./long-run-contract.md) · [evidence-review.md](./evidence-review.md) |
| 手册 | [dev-handbook.md](./dev-handbook.md) |
| 对照吸收 | absorb-cairn / absorb-resurface-aria-x / absorb-sapper-v2-nuwa / absorb-super-agent / absorb-cyber-monster / absorb-engagement-team / absorb-eval-methodology |
| 提案 | pentest-enhancements(P6) · parallel-explore-scaling(✅) · memory-layer(P8) · data-flywheel(P9) · graph-views(P10) · attack-chain-graph(P10扩展) · pentest-ops-design(P11) · long-range-completeness(P12) · pi-durable-integration(底座) |
| 实验 | experiments/2026-11-22-offline-review · experiments/2026-11-22-ledger-relay |
| 本地材料 | Staying on the Attack Path（A2 原文+译本）· 女娲测试 CCF 厦门 PPT（机制在演讲备注；28MB 本地参考，未入库） |
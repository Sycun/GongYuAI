# GongYuAI 总体设计（MASTER DESIGN）

> 本文件是项目**总体设计原始稿**：愿景、用户定调、三层基座、P0–P16 全部技术方向与细节、契约摘要、底座映射、路线图、待决策项的单一整合入口。  
> 交互全图：[design-atlas.html](./design-atlas.html)（独立可交付，中文，可点击/缩放/导览）。文档分册索引：[README.md](./README.md)。  
> 整合日期：2026-11-22；2026-11-24 追加红队定调（[red-team-positioning.md](./red-team-positioning.md)）与 P15/P16。状态标注：✅ 已落地 / 🔨 进行中 / 📐 提案。

---

## 0. 愿景与北极星

**产品一句话**：面向授权红队作业的长时运行渗透工作台——目标进入任务即视为授权，运行中不审查目标、不拒绝目标；任务可断点续跑，完成必须有证据，会话可接力而不丢攻击路径，**越用越好用**。

**北极星**：
> 女娲让作业活着；DAG 让路径可信；Evidence 让结论可复核；Relay 让上下文可换班；Super-agent 让预算花在更可能出结论的面上；Flywheel 让使用变成进化。

**产品语义权威**：[red-team-positioning.md](./red-team-positioning.md)（授权模型、零目标拒绝、能力全谱、全量吸收矩阵）。与本文冲突时以该文为准。

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
| 2026-11-24 | **目标默认授权，不设授权层**：授权是使用前提；工具不登记/不验证/不询问；`targets/outOfScope/roe` 是作业坐标不是授权闸（[red-team-positioning.md](./red-team-positioning.md)） |
| 2026-11-24 | **零目标拒绝**：拒绝唯一形态是工程自保（本机路由/VPN/宿主安全）；模型解释性拒绝按缺陷处理（重问/换模型/拆派），永不作终态、不写 Fact、不计攻击失败 |
| 2026-11-24 | **完全红队化**：技术不设类别禁令（规避/持久化/凭据/横向/C2）；纪律=证据最小化+变更台账+可复现；上游优秀机制全量吸收（矩阵见 red-team-positioning §7）；上游的授权/合规闸不复制进本仓 |
| 2026-11-26 | **「一主两辅」收敛瘦身**：以 `Fact–Intent–Goal + Evidence` DAG 为唯一主核；Super-agent 收敛为 `Leader 派单验卷 + Follower 单 Intent 隔离短会话` 并统一双循环工具目录；女娲压回纯进程保活与长会话 Relay；冻结全局记忆蒸馏/自动飞轮/多角色戏等远期支线 |

## 2. 三层基座（融合架构）

| 基座 | 职责 | 落点 | 状态 |
| --- | --- | --- | --- |
| **女娲** | 组织存活与繁衍：个体可死、图必须活、经验须传承 | 存活：lease/Watchdog/分层 History/Relay/族级打法；繁衍：两级记忆+飞轮 | 存活 ✅；繁衍 📐 P8/P9 |
| **DAG** | 路径与真相：走得对（授权在委托前提，不在运行时审查） | Fact–Intent 无因探索禁令（路径合法性）、证据闸+SHA-256、复核撤回、推荐≠授权 | ✅（域语义 🔨 P6） |
| **Super-agent** | 调度经济：花得省 | 脑手分离（相位工具面）、异步派单、三层模型路由 | 结构 ✅；路由 📐 P7 |

**分工金句**：DAG 管路径；分层 History 管可读性；Relay 管换班；Durable/lease 管进程活着；Evidence 管 Goal 可复核；Super-agent 管调度经济。

**执行权归属**：只有 Fact–Intent DAG 有执行权（图状态生成任务）；pi task graph 是运行时传动；四图投影零执行权，影响执行唯一通道是 Hint（建议层）→ 仍过 DAG 硬闸。**一图驱动、一图传动、四图旁观，旁观递条子过闸。**

**底座划线**：pi-durable storage 管会话持久性（turn/工具级崩溃恢复），History DAG 管攻击路径真相（语义级）。**底座管活，图管对**；pi transcript 永不成为真相源。

## 3. 技术全景（P0–P16）

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

### P6 渗透域语义 🔨（E1 已完成；E2–E6 第九轮后端部分落地）

Finding 一等公民（tentative/verified/retested/accepted/retracted + findingsGate，双图分离落地）→ 凭据/会话结构化（secretRef 指针）→ HTTP 事务证据+parser lane → 覆盖矩阵（asset×technique）+**速率模型自判**（硬顶可选，用户定调修订）+破坏性分级 → 变更台账/回滚（只生成不执行）→ finding 级评测。详见 [pentest-enhancements.md](./pentest-enhancements.md)。

### P7 Super-agent 调度经济 🔨（第九轮：角色分层与供应商韧性契约级落地，真实路由待验证）

报告交付后，带任务和记录编号的来件已有人工指定归属的入口。自动识别来件应归哪项工作，要用误挂率和节省的人工查找时间检验。模型选择要在相同材料上另测正确率、费用和耗时。两篇 DeepSeek 架构解读讨论同一项设计，公开原型与路由论文分别提供领域模型和实验假设。[来源与验证边界](./absorb-super-agent.md)

三层模型路由（派单便宜/推理强/执行快，`execution.models`）；slot 0 指挥官自接力核对；偏航审计者（轻模型只写 `source=auditor` Hint，看门狗零策略不破）；Observe 事件两级过滤。脑手分离已由相位工具面结构性保证（Octop 0/5 委派教训的正面论据）。**差分协议已定**：中难度带 8 题子集、≥3 重复、配对差 CI、非劣界 -5pp（[absorb-eval-methodology.md](./absorb-eval-methodology.md)）。详见 [absorb-super-agent.md](./absorb-super-agent.md)。

### P8 记忆层：项目记忆 × 全局记忆 🔨（第九轮：全局记忆/档案索引/注入后端 + 记忆图 API；控制台与自动蒸馏未做）

- **项目记忆**（任务级，✅ 已有）：History 黑板 + Relay π + Durable + 证据。
- **全局记忆**（用户级，📐）：档案索引（所有任务联邦只读）+ 蒸馏图谱（Lesson/Playbook/Counterexample/ToolArtifact/SourceRef/MatchKey/SkillPack）+ Skill 固化提案 + 工具遗产 + 操作者画像。
- **繁衍闭环**：蒸馏入口=终态**自动候选清单**（只列素材，人审后生成 draft）→ confirmed → **分层键**匹配注入（title 层 N=5，Explore 命中当前资产最多 +2）→ 反馈回写（reuseCount/反例/降级）。
- **硬纪律**：无源不记忆（derived_from 强制）；旧 Fact 永不直写新任务图；注入只走建议层；不做 RAG；凭据明文不进全局；全局记忆不出本机。
- 详见 [memory-layer.md](./memory-layer.md)。

### P9 数据飞轮 🔨（第九轮：F2/F3 后端落地；无真夹具与自动晋升）

五环：采集（events/trace/usage/复核，大半已有）→ 评测（任务记分卡+趋势+基准回归）→ 蒸馏（经验+参数+prompt 纪律提案，必附证据）→ 改进（五类执行器全部人审）→ 验证（离线差分先行+holdout 只验不调+配置版本化回滚）。中心质量闸：人审/溯源/反例降级/坏事实防毒化/Goodhart 防护（目标函数=攻击面经营+可审计 finding，非 flag 数）/数据不出本机。**飞轮已手动转过两圈**（六批→结构化交接 57→59；路由 2/8→8/8）。转的是 harness 与知识，不是模型权重。详见 [data-flywheel.md](./data-flywheel.md)。

### P10 图视图族 🔨（第九轮：四图只读 API + 今日工作已落地；前端画布待做）

一图一真相、五视图投影：DAG 核心 + 资产图（发现血缘/family/授权圈，数据已有）+ 攻击面图（资产×表面×测试状态，依赖 P6 E3/E4）+ 执行图（phase×slot 泳道，trace/events 投影）+ 记忆图（P8 M2）。跨图同 ID 导航；图提示（未测面/孤岛/高耗低产/过期/撤回波及）只写 Hint。只读投影、无第二状态、列表保留。详见 [graph-views.md](./graph-views.md)。

### P11 渗透执行层与委托规则 🔨（第九轮：持久资料作业、operator_consult 24h、handoff 已落地；会话/隧道/浏览器未做）

- **会话管理器**：session_open/write/read/list/close；process/listener/ssh/tunnel/browser；任务级 detached 对象，暂停/崩溃存活，重启 reconnect；单写者租约 CAS，跨 slot 复用。
- **后台作业异步回流**：chord job；完成 → root.submit() durable 通知唤醒模型，不轮询；崩溃幂等补发；多步编排走 Code Mode。
- **隧道/pivot**：chisel/ligolo-ng/proxychains-ng/socat；隧道=会话+变更台账；不改主机路由。
- **浏览器**：playwright-core + 开源 Chromium；profile 任务级持久；HAR→E3、cookies→E2。
- **委托规则**：timeWindow 可选默认连续运转；roe 自由文本默认无禁止；rateGuidance 模型自判（硬顶可选）。
- **模型主动求助**：operator_consult（blocking 挂起当前 Intent，心跳续租+超时豁免；**24h 无回复自动转非阻塞**，求助单保留+soft-pace 提醒）；回复 source=human Hint 唤醒。
- **生命周期**：开始/暂停（非终态停表；**会话保活、后台作业 SIGSTOP 冻结**，恢复续跑）/继续/停止（清理+残留台账）/结束（交付归档）；紧急停止。
- 详见 [pentest-ops-design.md](./pentest-ops-design.md)。

### P12 长程完备性（定调后）🔨（第九轮：D1 时效、D3 韧性契约、D5/D6 模拟角色；D8 哈希链未做）

**必补**：D1 目标漂移与事实保鲜（TTL 建议/基线差分/凭据健康）；D2 防御响应反馈（封锁检测/蜜罐启发式/金丝雀规避/噪音预算）；D3 Provider 韧性（key 池/failover/429 退避/成本预测）。**角色**：D5 战役规划→**规划者 Planner**（Reason 层强模型子会话，产出里程碑计划+Intent 提案，过正常硬闸）；D6 事故应急→**辅助者 Assistant**（独立轻量会话，**有 pause 权**无 stop/resume/扩 scope 权，break-glass/事故记录/通知 draft 人审）。**调研轨**：D4 Engagement 程序层（先调研产出 absorb 文档）。**通过**：D8 法律级证据（哈希链/可信时间戳/PTES·等保模板/CVSS4.0/复测工作流）。**删除**：D7 断网（无此场景）。详见 [long-range-completeness.md](./long-range-completeness.md)。

### P10 扩展：攻击链图

漏洞攻击链 = Fact–Intent 血缘 + provenance 投影（非新真相源）；**内网穿越 = 外网→组合漏洞→getshell/C2→隧道→内网的授权步骤因果链**，不加新阶段/scope；补 session.sourceIntentId/sourceCredentialId 两个溯源字段即自动连链。融合为攻击面图**链模式**：点击 finding 上下闭包聚焦整链，断点标「溯源缺失」不编造。详见 [attack-chain-graph.md](./attack-chain-graph.md)。

### P13 长跑自适应 📐（第十轮提案：把「能打进去」升级成「能跑完」）

执行面补完后（第十轮 shell/作业/PTY/C2 已落地），长跑的真实瓶颈从「有没有手」变成「手跑偏了怎么办、图太大了怎么读、被拒了怎么辨、证据能不能分角色」。七刀对应三基座各一个缺角：

| 刀 | 缺角 | 机制 | 文档 |
| --- | --- | --- | --- |
| A4 | DAG·授权 | 拦截话术「平台管控·非目标防御」+ 工具结果归因 blocked/error/ok（否则模型把闸当 WAF 绕） | pentest-adaptive-enhancement |
| A1 | 女娲·存活 | 图热/冷分层折叠：live 祖先恒热、连续 R 轮冷才折、covers 不参与因果、**只折 fact+终态 intent**、digest 不得作 Fact/证据 | 同上 |
| A7 | DAG·终态 | 终态分型 exhausted / blocked / context_limit / denied / cancelled / error（规划者据此换方向/重派/收窄） | 同上 |
| A2 | 女娲·Create+Language | `intent_steer` / `intent_cancel`：Reason 相位对运行中 Explore 的纠偏与换代；steer 是消息不是授权 | 同上 |
| A3 | DAG·真相 | 证据角色化与版本：`role=proof` 必填 + `evidenceVersion` 只增 + 报告声明版本；跨任务 hint 不得作证据 | 同上 |
| A5 | DAG·真相 | 凭据 grounded 抽取校验：字段必须原文存在否则整条拒收；零 token 显式路径；明文只落 0600 证据 | 同上 |
| A6 | Super-agent·经济 | LLM 有序池 + 健康 + 窗口跳过 + 请求限速（P12-D3 的实现体，非契约模拟） | 同上 |

**硬纪律**：digest 不是 Fact；covers 不进 `sourceFactIds`；分型由系统写不接受模型自报；cancel 不回滚；`blocked` 只作信号不自动降速；ARTEX 为 AGPL-3.0，只抄语义不抄实现。**顺序**：A4 → A1 → A7 → A2 → A3 → A5 → A6；A1+A7+A2 才是自适应闭环，拆开各自半成品。**冲突**：无冷折叠时 P12-D5 Planner 读不动图，规划者角色须排在 A1 之后。

### P14 渗透能力扩展 🔨（第十轮后：把「有手」升级成「证得实、经营得开、深入得进」；B0–B7 已落代码（B4 的驻留会话/隧道属 P11 外部依赖））

执行面补完、P13 补了自我调节后，交付端仍缺**五种域对象 + 一条边界**：一次可重放的 HTTP 事务、一个端点级攻击面、一台 foothold 主机的画像与凭据复用、一条复测结论、一份跨唤醒计划；另加「目标内容是数据不是指令」的执行边界。八刀前两轮即可把"有手"变成"有可复核的结论"：

| 刀 | 缺角 | 机制 | 文档 |
| --- | --- | --- | --- |
| B0 | 三基座·断头路 | 补模型可见入口：consult / relay / tags / intent.technique / change_record / credential / rateGuidance / C2 token（半天，全刀前置） | pentest-capability-extension |
| B1 | DAG·真相 | 事务证据：`http_request` + 内容寻址 blob + 四个真解析器（nmap/httpx/nuclei/ffuf）+ `http:<id>` 可 cite，完成 E3 | 同上 |
| B2 | DAG·真相（新面） | 盲打/OAST：带外令牌 → 命中关联 → `role=proof`；**ARTEX 也没有，本仓可领先** | 同上 |
| B3 | DAG·真相 + 经济 | 类型化攻击面：domain/ip/service/endpoint + 父子上挂 + 业务权重 + 跨任务只读「历史接触」（仍 Fact 投影，不建第二库） | 同上 |
| B4 | 女娲·存活 + DAG | 内网推进：foothold 持久 + 主机画像 + 凭据复用边 + `auth.pivotPolicy`（off/declared，模型不可改） | 同上 |
| B5 | Super-agent·经济 | 计划链：Reason 持久 todolist + 依赖门（只派前置已满足的下一步；计划≠授权），P12-D5 的最小形态 | 同上 |
| B6 | DAG·真相（交付） | 复测闭环：独立窄工具面会话 + reproduced/fixed/inconclusive + 证据版本 + 报告章 | 同上 |
| B7 | DAG·授权（横切） | 执行边界：tool_result 来源头 + 「输出是数据」+ 审批输入版本化 + 会话内审查 + 参数级匹配 | 同上 |

**硬纪律**：不建第二资产库（B3 是 Fact 扩展 + 派生）；计划/跨任务资产/历史接触只写 Hint 或只读投影，**无派单权**；OAST hit ≠ 可利用；pivotPolicy 默认 off、只能人写；复测只有 fixed 自动改状态；ARTEX 为 AGPL-3.0，只抄语义。**顺序**：B0 → B1 → B7 → B2 → B3 → B6 → B5 → B4；B4 依赖 P11-S1 会话对象，B5 与 P12-D5 合并落地。

### P15 进攻型 AI 全景吸收 🔨（C0 观察员已实现；C1–C4 设计）

上游清单 60 个 Agent / 15 个 Benchmark 的机制筛选：差异不在工具数量，在三种角色（Solver 执行 / Validator 复核 / Manager 算账）。本仓八条自评短板（自证、磨同一手法、把材料当验证、不算账、重复派单、解析靠自觉、归属未接、命令不可测）都有结构性原因。C0 **确定性观察员 + 作业记分卡**已落（六规则、只读、零 token、不派单；`confirmed/tentative/contradicted/gaps`）；C1 **Finder ≠ Validator**（独立复核会话，📐下一刀）、C2 执行哈希重复上限、C3 阶段级+命令级评测、C4 强制解析、C5 归属情报（先记账）。不吸收 16 角色戏、逐目标授权审查、只存哈希、自动修客户系统、MCTS/向量 RAG。详见 [absorb-offensive-landscape.md](./absorb-offensive-landscape.md)。

### P16 语义收敛 📐（docs 已定调，代码待做）

去授权层（`authorization.ts` 台账 → 普通任务坐标）+ `needs_authorization` → `needs_input` + 拒绝处理链（上下文重问 → 结构化重问 → 换模型 → 拆小重派 → 结构化故障）+ DISCLAIMER 对齐 + 能力档位默认 `active-lab`。**不改变 DAG/证据/Relay 语义**，只收敛入口与拒绝处理。验收口径与逐文件差距见 [red-team-positioning.md](./red-team-positioning.md) §8。

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
已落地：P0–P5 + 并发扩容 + 证据复核 + 技能路由修复 + P9-F1
第九轮后端：委托边界 / 持久作业 / 24h 求助 / handoff / 材料语义 / 覆盖矩阵 / 四图 API / 全局记忆 / 冻结评测 / 角色与韧性（契约级）
仍未做：会话管理器、隧道/浏览器、凭据表、parser lane 真格式、速率硬闸、事件哈希链、真实供应商与真实生产盲评
建议顺序：F1 记分卡(无依赖) → P6 E1 → 知识库首版（导入、检索、引用）✅ 后端 → P8 M1 → G1 双图 → P11 S1 会话+作业
          → P7 模型路由差分 → P8 M2/P9 F2/P10 G2 → P11 S2–S4 → P12 底线(D1/D2/D6)
第十轮：执行面 shell/作业/PTY/C2 + 授权台账 ✅ → P13 七刀（A4 → A1 → A7 → A2 → A3 → A5 → A6）
P13 插入点：A1 冷折叠必须早于 P12-D5 Planner（否则规划者读不动图）；A6 是 P12-D3 的实现体
第十轮后：P14 八刀（B0 断头路 → B1 事务 → B7 边界 → B2 盲打 → B3 类型化 → B6 复测 → B5 计划 → B4 内网）
P14 插入点：B0 修 consult/relay/tags/technique/change/credential/rate 入口；B1 完成 E3；B5 是 D5 Planner 最小形态；B4 等 P11-S1
P15 观察员（C0 ✅）→ C1 独立确认 → C2 执行哈希 → C3 阶段/命令评测 → C4 强制解析
P16 语义收敛（docs 已定调，代码待做）：去授权层（authorization → 任务坐标）+ `needs_authorization` → `needs_input` + 拒绝处理链（重问/换模型/拆派）+ DISCLAIMER 对齐（[red-team-positioning.md](./red-team-positioning.md) §8）
依赖：P6 E1 是 P8/P9/P10-G2/P12-D8 的原料；P11 S1 与 E2 元数据联动；P7 路由是飞轮执行器；P14 B4 依赖 P11-S1、B5 依赖 P13-A1/A7；P16 不改变 DAG/证据/Relay 语义，只收敛入口与拒绝处理
原则：每刀同预算差分验收；提案不升默认直到差分证明；契约变了才同步 long-run-contract
```

## 6. 待决策项

需要人工拍板的三项（P13，其余全部定案见 §1 定调日志）：

| # | 取舍 | 建议 | 影响面 |
| --- | --- | --- | --- |
| 1 | 冷折叠是否默认开、初值取多少 | 默认开，R=6 / K=2 起步，用本仓夹具标定后回写 | Observe 注入量与 planner 可读性；不改变任何既有语义（纯派生） |
| 2 | `exhausted` 是否算失败 | **不算**（对齐「达到步数/墙钟上限是换方向而非失败」），记分卡单列 `exhaustedRate` | failed 率口径、报告「受阻项」分组 |
| 3 | Reason 相位的 steer/cancel 是否默认开 | 默认开；但 `cancel` 保留人可撤销窗口（同一 Intent 30s 内可恢复为 running） | 与「暂停=冻结」不冲突；关掉会退化成只能等租约过期 |

其余取舍按「先列选项与建议、人工拍板、回写定调日志」执行。

P14 待拍板三项（其余按 §3「P14 渗透能力扩展」硬纪律执行）：

| # | 取舍 | 建议 | 影响面 |
| --- | --- | --- | --- |
| 1 | 盲打通道拓扑：本仓自建监听 vs 接外部 interactsh | **自建**（`auth.oast.{baseUrl,listenHost,listenPort}`，默认关） | 无配置时降级不可用；不自造公网服务 |
| 2 | `auth.pivotPolicy` 默认值 | **off**（内网发现一律 oos，链可展示利用被拒）；`declared` 只准入 RoE 写明网段 | 内网推进的授权语义；模型不可改 |
| 3 | 事务证据是否默认存全量响应体 | 只存有界正文 + 分段读（`offset/maxBytes`），完整流量留到 P11-S3 记录代理 | 证据体积 vs 可复现性；`truncated` 必须可见 |

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
12. 自动修复客户系统/打补丁；批量拖取客户生产数据（证据最小化即可）；TTL 强制删 Fact；全局记忆出本机；把上游的授权/合规闸复制进本仓。
13. **模型解释性拒绝**（「我不能协助」「无权执行」）当作行为或终态；逐目标授权审查 / safe-by-default 覆盖定调；把拒绝写成 Fact、计入攻击失败或让任务因此停在 `MODEL_REFUSED`。
14. 以「安全」为名把可执行动作降级成教程/建议；要求操作员逐目标"证明授权"；在 RoE 默认无禁止时叠加产品级禁令。

## 8. 文档地图

| 层 | 文档 |
| --- | --- |
| **定调（最高权威）** | [red-team-positioning.md](./red-team-positioning.md)（授权模型 / 零目标拒绝 / 能力全谱 / 吸收矩阵） |
| 总纲 | 本文件 · [README.md](./README.md) · [design-atlas.html](./design-atlas.html)（单文件离线设计导览） |
| 信仰 | [theory-fact-intent-dag.md](./theory-fact-intent-dag.md) |
| 架构 | [architecture.md](./architecture.md) · [asset-inventory.md](./asset-inventory.md) · [console-research.md](./console-research.md) |
| 契约 | [long-run-contract.md](./long-run-contract.md) · [evidence-review.md](./evidence-review.md) |
| 手册 | [dev-handbook.md](./dev-handbook.md) |
| 对照吸收 | absorb-cairn / absorb-resurface-aria-x / absorb-sapper-v2-nuwa / absorb-super-agent / absorb-cyber-monster / absorb-engagement-team / absorb-eval-methodology |
| 提案 | pentest-enhancements(P6) · parallel-explore-scaling(✅) · memory-layer(P8) · data-flywheel(P9) · graph-views(P10) · attack-chain-graph(P10扩展) · pentest-ops-design(P11) · long-range-completeness(P12) · pentest-adaptive-enhancement(P13) · pentest-capability-extension(P14) · pentest-completeness(完备性) · pi-durable-integration(底座) |
| 实验 | experiments/2026-11-22-offline-review · experiments/2026-11-22-ledger-relay |
| 本地材料 | Staying on the Attack Path（A2 原文+译本）· 女娲测试 CCF 厦门 PPT（机制在演讲备注；28MB 本地参考，未入库） |
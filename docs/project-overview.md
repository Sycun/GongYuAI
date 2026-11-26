# GongYuAI 项目说明

> 这份文件回答三个问题：**为什么做 GongYuAI、它采用什么框架、各个部分如何协作。**
> 产品语义以 [red-team-positioning.md](./red-team-positioning.md) 为最高权威；运行流程见 [project-flow.html](./project-flow.html)；实际操作与开发见 [project-guide.md](./project-guide.md)。
> 状态口径：✅ 已有代码与测试；🔨 部分实现；📐 设计或待接线。具体验收读数以 [implementation-ledger.md](./implementation-ledger.md) 与 [delivery-record.md](./delivery-record.md) 为准。

---

## 1. 为什么做这个项目

长时运行的红队作业不是“让模型多聊几轮”，而是要在一个部分可观测、不断变化、充满副作用的环境里持续搜索，并把结论交付到可复核的程度。传统聊天式 Agent 会在四个地方失败：

| 真实问题 | 典型表现 | GongYuAI 的应对 |
| --- | --- | --- |
| 上下文遗忘 | 换会话后忘记已试手法、当前立足点、未结任务 | 外置 History 图 + Session Relay |
| 进程中断 | Worker 崩溃、控制面重启、机器休眠后作业失踪 | Lease + Watchdog + Durable checkpoint |
| 路径漂移 | 无因扫描、重复派单、把猜测当事实、在同一手法上磨 | Fact–Intent DAG + 因果继承 + 观察员 |
| 结论不可交付 | 模型说“完成”但没有证据，报告无法复现，误报混入结论 | Evidence Gate + Finding 状态机 + 独立复核 |

因此 GongYuAI 的产品定义不是：

- 一个把多个安全工具包在一起的聊天壳；
- 一个固定 kill-chain 脚本；
- 一个靠堆 MCP/Skill 数量证明能力的扫描器；
- 一个把可执行动作降级成教程的“安全建议生成器”。

它是：

> **面向授权红队作业的单用户长时运行渗透工作台：目标进入任务即默认授权，运行中不审查目标、不拒绝目标；任务可断点续跑，完成必须有证据，会话可接力而不丢攻击路径，经验可跨任务繁衍。**

---

## 2. 三条不可偏离的产品语义

1. **授权是使用前提，不是运行时功能。** 部署者或使用者在工具之外取得授权；产品不设授权登记、目标白名单审查或授权版本。`targets`、`outOfScope`、`roe`、`rateGuidance`、`timeWindow` 是作业坐标与操作配置。
2. **目标拒绝不存在。** 模型对目标本身的解释性拒绝属于模型缺陷，按“上下文重问 → 结构化重问 → 换模型 → 拆小重派 → 结构化故障”处理，不写成 Fact、不进入终态、不计攻击失败。
3. **只保留工程自保。** 修改运行主机路由/VPN/代理、破坏宿主、逃离执行边界等确定性动作仍会被拒绝，并给出机器可读原因。这是保护运行环境，与目标合法性无关。

同时，完全红队化不意味着乱打：路径仍受 DAG 因果继承与证据闸约束，交付仍遵守证据最小化、变更台账、可复现与“不自动替客户修复”的纪律。

---

## 3. 架构收敛：一主两辅（DAG 主核 × 薄调度 × 薄保活）

项目早期分别吸收了女娲、Fact–Intent DAG 与 Super-agent 三条思路；在 2026-11-26 收敛后，不再平行扩张三套大系统，而是定型为**「一主两辅」**：

| 层级 | 治什么病 | 核心机制与落点 |
| --- | --- | --- |
| **主核：Fact–Intent–Goal DAG + 证据封存** | 路走歪、无因探索、猜测当事实、报告无据可查 | 唯一状态真相源：无因探索禁令、Intent CAS、证据 SHA-256 封存、Finding 状态机、复核撤回 |
| **辅 1：薄调度层（Super-agent 角色定型）** | 脑手混用、跨靶标上下文污染、双循环维护漂移 | 统一工具目录 `tool-catalog.ts`；默认 `1 Leader + 3 Followers`：Leader 物理剥离执行工具专职拆单/验卷，Follower 领单 `Intent` 跑干净短会话，`intent_conclude` 即终止并重置本地上下文 |
| **辅 2：薄保活层（女娲基础设施）** | 进程崩溃中断、Leader 超长会话窗口饱和 | 控制面租约 + Watchdog 指数退避重启 + Checkpoint + Leader/Solo 边界 Session Relay |

**执行权归属与冻结边界：** 只有 Fact–Intent DAG 有执行权；Pi Durable 是运行时传动；其余图视图与统计均为只读投影（建议只走 Hint 过闸）。跨任务全局记忆蒸馏（P8）、飞轮自动晋升（P9）与多角色子会话模拟已列入**冻结支线**，主航道专注单次长程作业的稳定性与可复核交付。

---

## 4. 技术框架

### 4.1 技术栈

- **语言与包管理：** TypeScript、Node.js ≥ 22.19、pnpm workspace。
- **状态存储：** SQLite WAL；任务 History 与 Worker Durable checkpoint 分离。
- **运行时底座：** Pi Durable / Chord，负责会话、工具与持久作业传动；不替代 History 的语义真相。
- **执行形态：** 本机 Node Worker 或 Docker Worker；控制面不直接执行 shell。
- **控制台：** React + Vite + Semi Design，图视图使用 XYFlow / Dagre。
- **扩展层：** MCP 提供工具连接，Skill 提供方法论；两者都是可插拔弹药，不是产品定义。

### 4.2 控制面与 Worker

```text
┌─────────────────────────────────────────────┐
│ Control plane / Mission Control             │
│ 任务 FSM · lease/fence · Watchdog · HTTP API │
│ 工具目录发现 · 设置 · 只读投影 · 不下发 shell  │
└───────────────────┬─────────────────────────┘
                    │ manifest + volumes
┌───────────────────▼─────────────────────────┐
│ Worker（local / docker，可并行 Explore）      │
│ Observe History → Orient → Decide Intent     │
│ → Act(tools) → Evidence → Conclude/Fact      │
│ budget · checkpoint · optional Relay         │
└─────────────────────────────────────────────┘
```

Watchdog 是零策略保活器：只续租、重启死进程、在硬闸触发时收卷，不读攻击路径、不派 Intent、不改 Goal。

### 4.3 包职责

| 包 | 职责 |
| --- | --- |
| `@gongyuai/contracts` | Task、Goal、Fact、Intent、Finding、Relay、攻击图、评测等共享契约 |
| `@gongyuai/history` | SQLite History、证据闸、Finding、复测、事件链、报告与快照 |
| `@gongyuai/control-plane` | 任务状态机、Runner、Watchdog、API、作业回流、平台记忆 |
| `@gongyuai/exec` | Shell、PTY、HTTP 事务、OAST、隧道、C2 与确定性执行边界 |
| `@gongyuai/worker` | Pi Durable / 模型循环、相位工具面、MCP/Skill、Relay、Observe |
| `@gongyuai/cli` | `gy` 单用户命令行入口 |
| `apps/console` | Mission Control 页面与只读图投影 |

### 4.4 每任务数据布局

```text
.gongyuai/tasks/<taskId>/
  manifest.json          # 作业坐标、目标、预算、执行配置
  history.sqlite         # Fact / Intent / Goal / Finding / events，跨会话真相
  durable.sqlite         # Worker phase/step checkpoint
  evidence/              # 原始证据与内容寻址 blob
  workspace/
    PROGRESS.md
    relay/               # π₀…πₙ，边界交接工作记忆
  worker.log
  worker-status.json
  report.md
```

---

## 5. 核心领域模型

| 对象 | 作用 | 关键约束 |
| --- | --- | --- |
| **Fact** | 一条可追溯观察 | append-only；title / summary / evidence 三层；可追加复核撤回 |
| **Intent** | 基于已有 Fact 的探索承诺 | 必须有 `sourceFactIds`；CAS claim；成功必须回写 Fact |
| **Goal** | 可验收的终态契约 | 证据文件、内容判据、Finding 闸全部满足才通过 |
| **Finding** | 漏洞结论，而非聊天叙述 | tentative → verified → retested → accepted；撤回保留 |
| **Evidence** | 支撑结论的原始字节 | 路径边界、SHA-256 封存、版本与角色可追溯 |
| **Hint** | 人类、系统或审计者的战术建议 | 只进建议层，不直接派 Intent、不成为 Fact |
| **Relay π** | 会话边界的工作记忆 | 图权威；崩溃恢复不写 π |
| **Asset** | 资产投影 | seed / admitted / live / oos；不建第二资产库 |
| **Plan** | Reason 的持久待办与依赖门 | 计划不是授权，不满足前置不派单 |
| **Validation** | Finder 之外的独立确认 | confirmed / refuted / inconclusive / out-of-scope |

核心因果边：

```text
Fact ──front──▶ Intent ──back──▶ Fact'
                   │
                   ├─ claim / heartbeat / conclude
                   └─ evidence / finding / validation
```

---

## 6. 一次任务如何运转

1. **建档：** 输入作业坐标、排除项、能力档位、节奏建议、Goal 与证据判据；目标进入任务即生效。
2. **Bootstrap：** 只有 origin 与 Goal 时，生成首批 Fact 与候选 Intent。
3. **Explore：** 每个 Follower（或单节点 Worker）一次 claim 一个 Intent，调用 shell/MCP/Skill，留存证据，`intent_conclude` 后同事务回写 Fact（多节点 Follower 随即终止本轮并在下一题前重置干净上下文）。
4. **Reason：** Leader 在槽位空闲或无 open Explore 时判断是否完成、滑动补单或换面，提出下一批独立 Intent。
5. **Finding 与独立复核：** 漏洞先记 tentative，满足证据与复现条件才 verified；独立 Validator 可确认、反驳或标记不确定。
6. **Goal Gate：** 证据、内容判据、Finding 门槛与资产归属在同一事务里核对；不满足则继续探索，不以模型自述完成。
7. **交付：** 从 History 渲染报告，生成可复算快照与记分卡；撤回、更正、复测、客户处置分别留痕。
8. **经验归档（远期支线 · 已冻结自动扩面）：** 跨任务全局记忆与飞轮提案保留人工复核入口，旧 Fact 永不直写新任务图。

相位工具面从结构上保证脑手分离：Bootstrap/Reason 没有 shell 与 MCP 执行权，Explore 才持有执行工具。

---

## 7. 长时运行能力

| 能力 | 解决的问题 | 关键规则 |
| --- | --- | --- |
| Lease / Watchdog | 进程死亡 | 同任务卷恢复；看门狗零策略 |
| Durable checkpoint | 循环相位丢失 | 进程级恢复，不等于上下文恢复 |
| Session Relay | 上下文饱和或主动换班 | 会话内全量、边界增量；π 不是真相 |
| 异步作业 | 长命令阻塞主循环 | 完成通知回流，不轮询；回执幂等 |
| 人工求助 | 模型遇到缺件或决策输入 | blocking 可挂起当前 Intent；24h 无回复转非阻塞 |
| 暂停 / 恢复 | 操作员临时接管 | 保留 History、证据、checkpoint；恢复读最新操作配置 |
| 软节奏 | 同一手法空转 | 只提示换面，不终止、不谎报预算耗尽 |
| 默认无限预算 | 长任务过早收口 | `0 = unlimited`；只有显式正数才启用硬闸 |
| 工程自保 | 作业破坏运行宿主 | 主机路由/VPN/代理变更永拒；只读状态查询放行 |

---

## 8. 当前能力边界

### 8.1 已形成主链

- Fact–Intent 图语义、Intent CAS、证据闸、Relay、并行 Explore、同族迁移与只读四图 API。
- Finding 台账、目标级归属、独立确认、复测、交付更正、记分卡与可复算快照。
- Shell、PTY、后台作业、C2、驻留会话、隧道/pivot、HTTP 事务、OAST、端点覆盖与主机画像。
- 持久资料作业、24h 人工求助、跨班 handoff、材料语义、全局记忆后端、趋势/提案/冻结评测。
- P17：主机枚举解析、事件哈希链、AD/云攻击图与 BloodHound 导入、启动期三层模型路由、阶段/命令级离线评测。

### 8.2 仍有边界

- **P16 遗留命名清理：** Worker 侧解释性拒绝重问与模型切换链已落地；契约侧 `authorization.ts` 与控制面多租户边界头等历史命名仍可进一步收敛为纯单用户任务坐标。
- **真实供应商与生产效果未证明：** 契约模拟不等于真实 429/余额/账单；合成验收不等于真实客户委托盲评。
- **Provider 热切换未接：** 当前为启动期 tier 路由与 fallback 链，Pi root model 进程内固定。
- **部分前端与运行时接线未闭环：** 记录代理、Chromium、自动蒸馏、部分 Worker 自动注入/求助/唤醒仍需按台账推进。
- **外部 RFC3161 TSA、云 API 自动采集、AD 全量边类型、真实阶段级基准**仍缺外部服务或真实材料。
- **AD/云/提权依赖外部弹药与人判的程度在下降，但不能把“有图和解析器”等同于“所有环境都已自动验证”。**

---

## 9. 上游优秀机制如何被吸收

| 来源 | 吸收到本仓的机制 |
| --- | --- |
| 女娲 / sapper-V2 / SapperLens | 分层 History、指挥官不下工具、Watchdog 零策略、上下文交接、同族迁移、Key 池思想 |
| A2 / Intentest / Cairn | Fact–Intent DAG、无因探索禁令、Intent FSM/CAS、Hint、stigmergy |
| CHAP | 结构化 protocol 接力、双触发、会话内全量与边界压缩 |
| DeepSeek Super-agent / Octop | 脑手分离、异步派单、三层模型路由、链式召回、审计者只写 Hint |
| ARTEX / CyberStrikeAI | 双图记忆、MITM 留痕、五层重试、用量账本、覆盖图、更新回滚、长期无人值守 |
| BreachWeave / Cain / AutoRedTeam | 观察员旁路、Finder ≠ Validator、四态裁决、确认来源、重复执行断路 |
| pentestcode / Strix / Decepticon | 强制解析、PoC 实测、critic、每目标新上下文、模型分层 |
| KaliBench / PentestEval | NL→CLI 精确命令、阶段覆盖、成本一等公民 |
| Resurface / ARIA-X / Cyber-Monster | 证据邻域、元数据保真、预算尽仍出报告、工具单闸、误报对照 |

完整矩阵、状态与“不吸收项”见 [red-team-positioning.md §7](./red-team-positioning.md)。原则是只吸收机制语义，不复制 AGPL 代码；上游的授权/合规闸不进入本仓。

---

## 10. 设计边界与反模式

### 10.1 一图一真相

- History 图是跨会话权威；聊天、Relay、记忆、报告都不是第二真相源。
- 记忆节点必须溯源；旧任务 Fact 不直接写入新任务。
- 四图与控制台只读投影，不创建第二套状态存储。
- 向量 RAG 不当 Fact 语义；图邻域是结构化邻接，不是语义召回。

### 10.2 看到就停

- 用模型说“DONE”关闭 Goal。
- 把解释性拒绝当终态、写进 Fact 或解释成“目标无漏洞”。
- 逐目标授权审查，或把可执行动作降级成教程。
- Watchdog 里写战术 if/else。
- 未完成图约束就上多 Worker。
- 从 AGPL 仓库复制实现。
- 自动修复客户系统、自动执行未审工具遗产、自动扩作业坐标。
- 把工具数量、角色数量或公开 benchmark 分数当能力证明。

---

## 11. 三份总览如何配合

| 文件 | 用途 | 推荐读者 |
| --- | --- | --- |
| [project-overview.md](./project-overview.md) | 理解项目原因、框架、架构与能力边界 | 新成员、项目评审、合作方 |
| [project-flow.html](./project-flow.html) | 可视化理解一次任务如何流转与异常如何恢复 | 操作员、架构评审、培训讲解 |
| [project-guide.md](./project-guide.md) | 实际启动、作业、开发、验收与排障 | 操作员、开发者、复核人 |

需要深入某一机制时，再从 [docs/README.md](./README.md) 进入理论、架构、长跑契约、P13–P17、吸收文档与验收证据。

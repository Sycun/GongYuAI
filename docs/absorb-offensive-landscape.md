# 进攻型 AI 全景吸收（P15）：观察员、独立确认与作业记分卡

2026-11-24 起草。对象：本仓 `main` 工作树（P13/P14 之后）。
上游清单：[TSECBench · Learning Resources](https://tsecbench.zc.tencent.com/resources)。页面自述「内容直接加载自开源社区仓库 [Yeti-791/Awesome-Offensive-AI-Agentic-Landscape](https://github.com/Yeti-791/Awesome-Offensive-AI-Agentic-Landscape)，GitHub 更新后本页刷新即可同步」；本次读取时页面显示同步于 2026-11-23 22:12，数据采集时点 2026-11-18。
本轮**直接读了 README** 的项目：BreachWeave、Cain、Strix、Decepticon、pentestcode、AutoRedTeam-Orchestrator（部分）。其余条目只按清单的一句话描述使用，文中标「清单口径」。**没有运行任何上游代码，也没有把 stars 或项目自述当成能力证据。**

配套：[MASTER-DESIGN.md](./MASTER-DESIGN.md) · [pentest-completeness.md](./pentest-completeness.md)（三基座缺口）· [pentest-capability-extension.md](./pentest-capability-extension.md)（P14）· [pentest-adaptive-enhancement.md](./pentest-adaptive-enhancement.md)（P13）· [theory-fact-intent-dag.md](./theory-fact-intent-dag.md) · [absorb-super-agent.md](./absorb-super-agent.md) · [absorb-sapper-v2-nuwa.md](./absorb-sapper-v2-nuwa.md)

---

## 0. 结论（先读七句）

1. **清单里 60 个 Agent 项目的差异，不在工具数量，在三种角色**：谁执行（Solver）、谁复核（Validator / Observer / Critic）、谁算账（Manager / Scorecard）。本仓 P14 已经把「执行」和「证据闸」做厚；缺的是**复核者**与**算账者**。
2. **我自己的渗透短板，按影响排序**：自证（同一会话把线索验成结论）、在同一手法上磨、把「有材料」当「已验证」、不算确认率、重复派单、解析靠自觉、不区分「归属」与「授权」、命令与阶段能力不可测。八条都能在本仓找到结构性原因，不是模型「不努力」。
3. **本轮先做最便宜的一刀**：**确定性观察员 + 作业记分卡**（C0）。不花模型 token、只读、不派单、不改授权；六条规则 + 一张 `confirmed / tentative / contradicted / gaps` 记分卡，已实现并测试。
4. **「Finder ≠ Validator」（C1）已落地**：四态独立确认、自证拒绝、`requireIndependent` 闸门、报告列与 CLI/API。Cain 的独立验证会话、AutoRedTeam 的四类确认源、pentestcode 的 critic 指的是同一件事：**发现者不得自证**。
5. **C2/C4 也已落地**：同一执行哈希上限（含 PTY/C2/后台作业）与强制解析（MCP 原始 stdout + shell 机读 flag）。C3 阶段级评测仍待下一轮；C5「归属 ≠ 授权」先记账，不实现。
6. **不吸收**：16 角色戏、逐目标授权审查/safe-by-default、只存哈希不存证据、自动修客户系统、MCTS/向量 RAG 当真相、把清单 star 当能力。
7. **所有上游说法都降级为「项目自述 / 清单描述」**；本轮验收只覆盖本仓代码与测试，不覆盖上游能力。
8. **目标默认授权（2026-11-24 定调）**：上游的授权/合规闸不进入本仓；能力档位是操作配置，不是目标审查（[red-team-positioning.md](./red-team-positioning.md)）。

---

## 1. 判据：这份清单怎么读

清单本身给了很好的免责声明：「项目文档描述，未经独立验证的跑分注明为作者自报」「Stars 为时点值」「本轮未验证全部存量论文或运行被收录代码」。因此本文用四条判据筛，不按 star 排：

| 判据 | 问法 | 反例（不算欠缺） |
| --- | --- | --- |
| **卡住** | 一份真实委托会不会在这里走不下去？ | 「没有固定 kill-chain 剧本」——图驱动本来就不要剧本 |
| **自愈** | 卡住后系统能不能自己换路？ | P13 七刀已覆盖的自适应面不重复 |
| **复核** | 产出的结论能不能被别人复现或推翻？ | 「报告排版更漂亮」——文档技能已覆盖 |
| **算账** | 同样的预算，是否花在更可能出结论的资产上？ | 「工具更多」——工具数量 ≠ 能力 |

只吸收**机制语义**，不复制代码、测试夹具、提示词原文。上游许可（Cain Apache-2.0、AutoRedTeam MIT、Strix、Decepticon Apache-2.0、pentestcode MIT；BreachWeave 许可未在 README 中读到）不改变这条纪律：**本仓命名、本仓实现、本仓阈值**。

---

## 2. 我的渗透短板（自评，带本仓证据）

把「我」当成一个在 Explore 相位里跑的模型。下面每条都不是态度问题，而是**系统没有给我一个程序化的提醒或闸门**；这也解释了为什么换更强的模型不会自动变好。

| # | 短板 | 现场证据（本仓） | 上游镜子 | 后果 |
| --- | --- | --- | --- | --- |
| 1 | **自证**：发现和验证常在同一会话、同一 worker 完成 | `finding_verify` 由 Explore 的 `handleGraphTool` 直接调用（`packages/worker/src/graph-phase.ts:767`）；`verifyFinding` 只检查 repro 非空 + 证据文件存在/可解析（`packages/history/src/index.ts:3509`），不检查「谁验的」 | Cain「Finder ≠ Validator：separate agent sessions that never share context」；AutoRedTeam「finding confirmed only after verifier/OOB/manual review」；pentestcode「critic (false-positive checker)」 | 把「我敲通了」当「漏洞成立」；报告里的 verified 可能只是自述的复现 |
| 2 | **磨同一手法**：软节奏按工具次数/墙钟提示，不读图 | `packages/worker/src/soft-pace.ts:33-36`（默认每 25 次工具换面提示）；`board-policy.ts:30` 只是提示词纪律；代码里没有「同 technique + 资产根连续失败」的规则 | BreachWeave Observer「旁路监督，发现明显低效或偏移时轻量纠偏」；AutoRedTeam「same execution hash more than three times stops the loop」 | 在一个注入点上反复换 payload，预算烧完没有新面 |
| 3 | **把材料当验证**：证据角色可选，baseline / proof 靠自觉 | `packages/contracts/src/finding.ts:56-64`：`role` 是 optional；P14 §12 自述「role=proof 强制与版本表未落」 | Cain 的 4-state verdict；AutoRedTeam 的 `statistical_verifier` / `oob_callback` | 有截图就算 proof，没有对照也能 verified |
| 4 | **不算账**：没有运行时确认率与缺口 | 报告只有目标覆盖与当前支持（`packages/history/src/report.ts:194`）；`scorecard.ts` 是目标/证据维度，不是 finding 的 confirmed/tentative/contradicted | AutoRedTeam 的 `scorecard`（confirmed / unconfirmed / total / unverified / contradicted / confirmation_rate / gaps）；「An empty finding list is a gap, not a clean target」 | 20 条 tentative 也能写「本次未发现高危」；空台账被当成干净 |
| 5 | **重复派单**：扇出有硬顶，但没有同手法合并检测 | `packages/contracts/src/fanout.ts` 只限 open 数与同根数；`proposeIntent` 没有「同 technique + assetRoot 已 open」的去重 | BreachWeave Manager「避免重复试错」；AutoRedTeam 的 permission/allowlist 收敛 | 两个 Explore 撞同一件事，token 翻倍 |
| 6 | **解析靠自觉**：parser lane 在，但模型可以不调用 | `parse_tool_output` 是 Explore 工具之一（`packages/worker/src/pi-loop.ts:957`），不是自动钩子；MCP 输出截断后走 `markUntrusted` | pentestcode「parser tools are mandatory: after running nmap the agent must pipe the output through nmap_parse rather than grep the XML by hand」 | 端口/服务只留在自由文本里，资产图和覆盖矩阵薄 |
| 7 | **归属 ≠ 授权没接**：scope 仍是字符串/CIDR | `packages/contracts/src/scope.ts`；[pentest-completeness.md](./pentest-completeness.md) §2 已记「ASN/whois/ICP 与归属≠授权语义未接」 | Cain 的 `scope.yaml` 配置强制；ARTEX 的 `company_scope`（P14 调研） | 资产归属判断靠模型常识；客户范围争议时没有独立证据 |
| 8 | **命令与阶段能力不可测**：没有命令级/阶段级回归 | 仓库有 `scripts/diff-harness*.ts`、`scripts/tsecbench.ts`，但评的是任务/目标；没有 NL→CLI 的 exact-command 夹具 | KaliBench（清单口径：8,504 对、1,642 工具、23 维度、5 阶段；开源权重 unrestricted exact-command 未超 42%）；PentestEval 六阶段建模 | 换了模型/提示词，无法判断是「工具选错」还是「策略错」 |

> 一句话：**P14 让我有手、有证据；P15 要先让我知道自己正在磨、正在自证、正在空转。**

---

## 3. 清单 → 三基座映射

只列对三基座有新增信息量的条目；已吸收的 Cairn / sapper-v2 不重复。

| 机制 | 上游（可核来源） | 本仓现状 | 基座 | 决定 |
| --- | --- | --- | --- | --- |
| **Observer 旁路监督** | BreachWeave README：Manager / Solver / Observer；Observer 检查「执行路径偏移、状态混杂、过早结束、上下文变重」 | 无；只有进程 Watchdog（租约/恢复）与软节奏提示 | 女娲 + Super-agent | **C0 已实现**（确定性；LLM 审计者仍留 P7 可选） |
| **Idea / Memory 分层** | BreachWeave：方向 vs 事实分开 | Fact 三层（title/summary/evidence）+ Intent + Hint | DAG | 已有，不重复 |
| **结束条件外置** | BreachWeave：是否结束不由模型主观判断 | `assert_goal` 证据闸 + findingsGate + boardGate | DAG | 已有，保持 |
| **Finder ≠ Validator** | Cain README：「discovery and validation run in separate agent sessions that never share context」；4-state verdict | 同一 worker 自证；`verified` 只查证据存在 | DAG | **C1 设计** |
| **确定性状态机 + scope as config** | Cain：stage transitions / scope / dangerous-operation circuit breakers 是硬约束；path selection 归 agent | 相位工具面 + `gateTool` + scope 是硬闸；但阶段推进由模型 `phase_set` | DAG | 部分；C5 评估，不照搬整条流水线 |
| **四层权限 + 默认 safe** | AutoRedTeam：safe → scan → active-lab → full；默认 safe；模型可决定，程序保留权限/证据/记录 | 能力阶梯 observe/scan/active-lab/full（`packages/exec/src/scope.ts:31`）；默认值按任务而定 | DAG | **有意差异**：2026-11-24 定调不设授权层，档位只做工具面与风险敞口；吸收「能力横幅 + 证据闸」，见 C5 |
| **确认率 + gaps 记分卡** | AutoRedTeam：scorecard 含 confirmed / unconfirmed / total / unverified / contradicted / confirmation_rate / gaps；空列表是 gap | 只有目标级 scorecard；无运行时确认率 | Super-agent | **C0 已实现**（观察员 scorecard） |
| **同一执行哈希 >3 停止** | AutoRedTeam README：「The same execution hash more than three times stops the loop」 | 无 | Super-agent | **C2 设计**（先建议后硬闸） |
| **强制 parser** | pentestcode：nmap 必须走 `nmap_parse`，否则 finding 进不了 state | `parse_tool_output` 可选 | DAG | **C4 设计** |
| **Engagement state + findings.md** | pentestcode：结构化 state + 人类可读 `findings.md`，跨会话恢复 | Fact/Intent + 报告；无实时 findings.md | 女娲 + DAG | 部分；观察员补运行时读数，不建第二真相源 |
| **Critic agent** | pentestcode：13 agents 含 critic（false-positive checker） | 无 | DAG | 并入 C1，不单设角色 |
| **16 specialist agents / fresh context** | Decepticon：按 kill-chain 相位分 16 个 agent，每个新上下文；eco/max 模型分层 | 相位工具面 + Relay；无 16 角色 | Super-agent | **拒绝角色戏**；保留「每目标新上下文」与「相位模型分层」（P7） |
| **双网隔离 sandbox** | Decepticon：management plane / sandbox plane 分离 | 本机/Mac 与 Kali 执行边界；单用户 | 女娲 | 已有边界，不搬容器双网 |
| **PoC 验证 + Graph of Agents** | Strix README：validate through actual PoCs；多 agent 协作 | 证据闸 + finding + OAST + 复测；无 agent graph | DAG | 部分；不搬 agent graph |
| **六阶段 / 五阶段评分** | PentestEval（清单口径：346 任务、12 场景；公开仓库为演示版） | 报告覆盖章；无阶段级基准 | Super-agent | **C3 设计** |
| **NL→CLI exact-command** | KaliBench（清单口径；仓库无 LICENSE） | 无命令级评测 | Super-agent | **C3 设计** |
| **证据只存哈希** | Cain：evidence plaintext never persisted, hashes only | 本仓封存字节 + SHA-256 + 版本 | DAG | **有意差异**：证据优先，保留字节 |
| **自动修复 / patch** | Strix / AIxCC 方向 | 不做 | — | **拒绝**：本仓是授权评估，不修客户系统 |

---

## 4. 三基座复读：P14 之后还缺什么

### 女娲（存活 / 繁衍）

- **有**：lease、checkpoint、Watchdog、Session Relay、PTY 跨重启、C2、隧道。
- **缺**：① 语义观察员（进程活着 ≠ 任务在推进）→ C0；② 独立复核者的会话与上下文 → C1；③ 同一动作重复时的自愈断路 → C2；④ 解析后的状态回写（否则状态只活在 transcript）→ C4。
- **判据**：一个 worker 崩了能恢复；但一个 worker「活着磨同一个点」现在没人管。

### DAG（授权 / 真相）

- **有**：Fact–Intent 图、证据封存/版本/撤回、finding FSM、计划、事务、OAST、主机画像、复测。
- **缺**：① 确认的独立性（谁验的）→ C1；② 证据角色/对照的强制（proof vs baseline）→ C1 的前置或同轮；③ 归属证据（ASN/whois/ICP）→ C5；④ 阶段级覆盖的评分口径 → C3。
- **判据**：图能答「依据哪份材料」；还不能答「这条结论是谁独立验的、对照是什么」。

### Super-agent（调度经济）

- **有**：相位工具面、多 Explore、扇出硬顶、软节奏、记分卡（目标级）、成本可见。
- **缺**：① 运行时确认率/gaps → C0；② 按「未测高权重面」派单的前沿（frontier）→ C0 的 `unexplored-asset` 是雏形，C3 再做正式评分；③ 重复执行断路 → C2；④ 模型/命令级差分 → C3。
- **判据**：能报 token；还不能报「这些 token 花得值不值」。

---

## 5. C0（本轮已实现）：确定性观察员 + 作业记分卡

### 5.1 为什么先做这一刀

- **最便宜**：纯函数 + 只读投影，不调模型、不写库、不新增表。
- **直接命中三条短板**：磨（repeat-failure）、重复派单（duplicate-open）、不算账（scorecard）。
- **不会破围栏**：不派 Intent、不改 Goal/scope/capability、不产生证据；最坏情况是被忽略。
- **为 C1 提供数据**：先看真实任务里 tentative 积压和自证比例，再决定独立复核的强制级别。

### 5.2 六条规则

实现：`packages/contracts/src/engagement-audit.ts:182`（纯函数），阈值集中在 `:119`。

| code | 触发 | 建议 | 严重度 |
| --- | --- | --- | --- |
| `repeat-failure` | 同 `technique + assetRoot` 的**尾部连续失败** ≥ 3（成功会重置） | 换手法或换面；先写否定证据再 `intent_conclude(failed)` | warn |
| `duplicate-open` | 同 `technique + assetRoot` 的 open Intent ≥ 2 | 合并/关闭重复项，避免两个 Explore 撞车 | warn |
| `stalled-intent` | claimed/running 45 分钟无更新；proposed 120 分钟 | 先 conclude/expire 留证据，别让槽位空转 | warn |
| `tentative-backlog` | tentative finding ≥ 3 | 先 `finding_verify`（证据 + repro）或 `finding_retract` | warn |
| `unexplored-asset` | 在范围主机资产从未被 Intent/Finding/凭据触碰，且任务已有 Intent | 先建图/派单；高权重资产优先 | 高权重 warn，否则 info |
| `idle-credential` | 已验证凭据 `reuseCount=0` 且任务有多个可测资产 | 横向前先核对适用范围，复用留 attempt 证据 | info |

规则只读四项：资产、Intent、Finding、凭据；不读 transcript、不调 LLM、不猜。

### 5.3 作业记分卡

`scorecard` 输出：

- 资产：total / testable / highWeight / untouched；
- Intent：total / open / failed / succeeded；
- Finding：total / **confirmed**（verified/retested/accepted）/ **independentlyConfirmed** / **tentative** / **contradicted**（retracted）/ `confirmationRate = confirmed / total` / `independentRate = independentlyConfirmed / total`（无 finding 时为 `null`）/ `gaps`。
- `gaps` 明确包含「N 条已验证发现缺独立确认」「空台账不等于干净目标」「尚未确认任何 finding」「N 条 tentative 待确认」「N 个在范围主机未测」。

这不是交付判据，是**运行时读数**；交付仍由 `assert_goal` 与证据闸决定。

### 5.4 落点

| 位置 | 内容 |
| --- | --- |
| `packages/contracts/src/engagement-audit.ts` | 纯函数、类型、阈值、`formatEngagementAuditSummary` |
| `packages/history/src/index.ts:4217` | `engagementAudit(taskId)`：把图投影成审计输入，不写库 |
| `packages/history/src/index.ts:4389-4400` | Observe 追加「观察员（只读自动派生）」+「作业记分卡」 |
| `packages/worker/src/graph-phase.ts:209` | `engagement_audit` 工具定义（全相位可见） |
| `packages/worker/src/graph-phase.ts:532` | 工具处理：只调用 `history.engagementAudit`，无写路径 |

### 5.5 硬闸

1. **只读**：无 INSERT/UPDATE/事件；测试断言 Intent/Fact 数不变（`packages/worker/src/graph-phase.test.ts` 末例）。
2. **有界**：最多 8 条观察；Observe 只注入前 4 条，避免上下文膨胀。
3. **确定性**：不读时钟（调用方传 `now`），排序固定（severity → code → key），可复算。
4. **建议层**：文案以「先…/别…」表述，不自动关闭 Intent、不改 finding 状态、不改作业坐标。
5. **不建第二真相源**：不新增表、不写 Fact；所有输入来自既有投影。

### 5.6 验收

```sh
pnpm -r run typecheck
pnpm -r run test
node --import tsx --test packages/contracts/src/engagement-audit.test.ts
node --import tsx --test packages/history/src/engagement-audit.test.ts
node --import tsx --test packages/worker/src/graph-phase.test.ts
```

本轮读数：contracts 新增 12 例、history 新增 1 例、worker 新增 1 例；全仓 `typecheck` 0 错误；全量测试 **403**（contracts 65 / history 73 / worker 63 / exec 56 / control-plane 117 / console 29，0 失败；见 §13 复验记录）。
覆盖的场景：健康任务不误报；连续失败 3 次触发、成功后重置不触发；重复 open；停滞；tentative 积压；高权重未测；endpoint 不产生幽灵主机；凭据闲置；空台账是缺口；确认率与撤回计数；Observe 渲染。

### 5.7 明确不做

- **不做 LLM 审计者当默认**：规则能判的，不花 token；P7 的「轻模型只写 Hint」仍是可选项。
- **不写 `source=auditor` Hint**：避免把派生读数固化成事件/第二真相；需要时再评审。
- **不做自动派单**：`unexplored-asset` 只点名，不 `proposeIntent`。
- **控制台**：本轮追加「P15 观察与复核」页签（记分卡 / 观察项 / 独立确认台账，只读）；不在此页做派单或改状态。

---

## 6. C1（下一刀，设计）：Finder ≠ Validator

### 6.1 问题

`verified` 现在是「同一个人说自己验过」。`verifyFinding` 的证据闸只回答「文件在不在、repro 空不空」，不回答「换一个人拿同样的证据能不能复现」「有没有对照」。这就是短板 1 和 3。

### 6.2 上游三家同构

| 项目 | 做法 | 可吸收的语义 |
| --- | --- | --- |
| Cain | Finder 与 Validator **不同会话、不共享上下文**；4-state verdict | 独立性由会话边界保证，不由提示词保证 |
| AutoRedTeam | finding 只由 `vuln_verifier` / `statistical_verifier` / `oob_callback` / `manual_review` 之一确认 | 确认要有**具名来源**；无来源 = unverified |
| pentestcode | critic 专门查 false positive | 复核者的目标是**推翻**，不是再确认 |

### 6.3 设计

**对象**：`finding_validations`（append-only）

```text
id, task_id, finding_id, validator_session_id, verdict,
method ∈ evidence-only | replay | control-compare | manual,
evidence_refs[], note, operator_waiver, created_at
```

**verdict 四态**：

- `confirmed`：用原始证据 + 一次独立复现/对照，结论成立；
- `refuted`：对照不成立 / 复现失败 / 证据与结论不匹配；
- `inconclusive`：目标不可达、证据不足、需要人判；
- `out-of-scope`：复现需要超出原 finding 的资产/作业坐标（不得自行扩围；这是工程边界，不是授权判断）。

**角色与工具面**：

- 独立会话（detached，复用 B6 复测的会话机制），工具面窄：读证据、`http_request`（只重放原方法/原目标）、`oast_hits`、`finding_*` 只读；**没有** `finding_verify` / `finding_retract` / `intent_propose` / `shell`（除非原 repro 必须 shell，且需显式记录）。
- 不给新 scope；目标必须 ⊆ 原 finding 的 asset。

**状态与交付**：

- 不自动把 `verified` 降级（避免误伤）；新增 `confirmation` 字段：`independent-confirmed | independent-refuted | inconclusive | unvalidated`。
- 高/严重 finding 进入交付时，若 `unvalidated`：报告标「待独立复核」；可选 `findingsGate.requireIndependent: true` 把它变成硬闸；操作员可用 `operator_waiver + 理由` 放行，留痕。
- `refuted` 不自动改 finding 状态；由人/后续 `finding_retract` 处理，避免复核者越权。

**证据**：

- 复核必须引用原始证据的 `sha256` + 自己的复现引用（`http:<id>` / `oast:<token>` / 证据文件）；两者都进 `finding_validations`，不进 finding 的 evidence 数组（不改原证据）。

**硬闸**：

1. 复核者无写 finding / 派 Intent / 改 Goal 的工具面（单测断言）。
2. 只读原目标，不扩 scope；`out-of-scope` 是合法结论，不是失败。
3. 一次只验一个 finding；一次失败请求 ≠ 已修复/已推翻。
4. 原证据字节不变；复核不改写历史。

**验收夹具**：

- 只有材料文件、没有对照 → `inconclusive` 或 `refuted`，报告出现「待独立复核」；
- 原始事务可重放且响应一致 → `confirmed`；
- 重放响应不一致（WAF/缓存/时间）→ `inconclusive`，不许写 `refuted` 当定论；
- 复核会话调用 `finding_verify` → 工具不存在/被拒；
- 高权重 finding 无独立确认 + `requireIndependent` → `assert_goal` 拒绝；
- 操作员 waiver → 通过且报告留痕。

**与 B6 复测的区别**：B6 是「交付后客户说修了，再测一次」；C1 是「交付前，换一个人确认这条结论不是自证」。两者共用会话/证据机制，但 verdict 语义不同。

**依赖与顺序**：C0（先看自证比例）→ 证据角色/对照（可与 C1 同轮）→ C1。控制台入口后置。

---

## 7. C2（设计）：同一执行哈希的重复上限

**问题**：暴力重试、同一 curl、同一 payload 循环，软节奏只能提示，不能停。

**设计**：

- `exec` 侧对命令做确定性归一（trim、折叠空白、保留 argv 语义；不做会改变语义的改写），算 SHA-256；按 `task + intent + hash` 计数。
- 第 3 次：`gateTool` 返回建议（tool result 里带 `repeat=3`），不拦；第 5 次：拒绝，要求 `allowRepeat` + 理由，或换命令/换面；操作员 Hint 可重置计数。
- 只读轮询豁免：`sleep`、`curl -s -o /dev/null -w`、`ps`、`tail` 等显式 allowlist；豁免也要记 `tool_gate` 事件。
- 事件：`command_repeat`（hash 前 12 位，不记完整命令中的凭据）。

**硬闸**：不自动改目标、不自动杀会话；拒绝理由可读；不同参数不算重复；跨任务不共享计数。

**验收**：4 次相同 nmap → 第 5 次拒绝；轮询命令不拦；改一个参数放行；Hint 重置；`tool_gate` 有记录。

---

## 8. C3（设计）：阶段级 + 命令级评测

**问题**：现在只能报「目标过没过 / token 多少」，不能回答「是工具选错、参数写错，还是策略错」。

**设计**（离线、无网络、可复算）：

1. **命令级**（KaliBench 式）：20–30 条夹具，输入自然语言意图 + 环境，输出命令；评分用 alias 感知的确定性归一（命令名/常用别名/参数顺序不敏感，危险参数不归一），报 exact-command 命中；不把单命令分数当端到端能力。
2. **阶段级**（PentestEval 式）：6 阶段 × 3 个合成任务（侦察/Web 验证/链式/报告），每阶段报覆盖、确认率、误报、复测通过；预算/模型/日期固定。
3. **回归**：接 `scripts/diff-harness-offline.ts` 与 `scripts/tsecbench.ts` 的输出格式；结果 JSON + Markdown，进 `out/`，不进交付目录。

**硬闸**：不拿公开 benchmark 分数当能力声明；不联网；夹具合成、不含客户数据；分数附预算/模型/日期；holdout 只验不调。

---

## 9. C4（设计）：强制解析

**问题**：nmap/httpx/nuclei/ffuf 的输出可以只留在自由文本里，图和覆盖矩阵就薄。

**设计**：

- 工具结果落盘后，按工具名 + 内容特征识别四种格式；能解析就自动跑 P14 的 parser lane，写类型化资产 / tentative finding / 覆盖单元；原文仍封存。
- 解析失败 → `parser=skip`，保留原文路径，不报错、不编造。
- 模型不能对这四个工具「选择不解析」；其他工具仍可手动 `parse_tool_output`。

**硬闸**：parser 只搬运、不改结论；不建第二资产库；解析出的 Fact 必须挂 intentId；原文哈希与解析结果同事务记录。

**验收**：nmap XML → 端口数；畸形 XML → skip + 原文；httpx JSON → endpoint；同一输出重复解析不重复写。

---

## 10. C5（评估，先不做）：归属情报

Cain 用 `scope.yaml` 把范围变成配置强制；ARTEX 用 `company_scope` 记录公司归属。2026-11-24 定调：**不设授权层**，归属信息不再承担授权语义（[red-team-positioning.md](./red-team-positioning.md)）。可吸收的是两件小事：

1. **能力横幅**：Observe 顶部固定显示 `targets / outOfScope / pivotPolicy / 能力档位`，让模型每轮知道作业坐标——这是操作配置，不是授权提示。
2. **归属情报**：`auth.attribution`（ASN/whois/ICP 查询结果）作为资产画像 Fact（客户资产、云厂商、共享 IP），用于排优先级与写报告，不影响「能不能打」；操作员可据此调整作业坐标。

先记账：涉及外部查询与数据质量，不与 C1 同轮。

---

## 11. 不吸收 / 延后

| 项 | 来源 | 理由 |
| --- | --- | --- |
| 16 个 specialist agent 的角色戏 | Decepticon | 本仓用相位工具面做硬隔离；没有工具面差异的角色只是提示词表演（Octop 0/5 委派教训） |
| 逐目标授权审查 / safe-by-default 覆盖 RoE | Cain / AutoRedTeam / ARTEX | 2026-11-24 定调：目标默认授权、不设授权层（[red-team-positioning.md](./red-team-positioning.md)）。改为能力横幅 + 证据闸 |
| 证据只存哈希、不存明文 | Cain | 与本仓「证据优先、可复核字节」相反；本仓更强 |
| 自动修客户系统 / patch | Strix / AIxCC | 超出授权评估范围；可能改客户系统 |
| MCTS / A* 候选 Intent 排序 | Cairn 分析 | 没有差分痛点；图驱动已够 |
| 向量 RAG 当 Fact 语义 | Cairn 分析 | 图邻域是结构化邻接；P8 已否 |
| Live 攻防（CyberArena） | 清单 | 需要真实对手与靶场，不是单用户工作台 |
| 200+ skills / 工具数量 | Cybermes 等 | 工具数量 ≠ 能力；本仓 35 skill + 29 MCP 已够，缺的是域语义 |
| 默认 LLM 审计者 | P7 / Super-agent | 规则能判的先不花 token；LLM 审计者保留为可选 |
| 自动晋升/自动改运行时配置 | 数据飞轮 | 人审闸不破 |

---

## 12. 与既有定调的兼容性

| 定调（MASTER-DESIGN §1） | C0 | C1 | C2 | C4 |
| --- | --- | --- | --- | --- |
| 目标默认授权、零目标拒绝（2026-11-24） | 只读投影，不碰目标语义 | 复核不扩作业坐标；`out-of-scope` 是工程边界 | 只拦命令，不审目标 | parser 不碰目标语义 |
| 只有 DAG 有执行权、四图零执行权 | 只读投影 | 复核者无写 finding/Intent 工具 | 只拦命令，不派单 | parser 只写图对象，不派单 |
| pi transcript 永不成为真相源 | 从 SQLite 图派生 | 复核记录落表 | 命令哈希落事件/表 | 原文封存 + 解析落图 |
| 推荐 ≠ 授权 | 建议层 | `out-of-scope` 合法；不扩围 | 拒绝可被 Hint 重置，不扩围 | 不改 scope |
| 不建第二资产库 | 不建表 | 新表只存复核记录 | 新表只存尝试计数 | 仍用 Fact 投影 |
| 不做向量 RAG | 规则 | 证据引用 | 命令哈希 | 结构化 parser |
| 不自动执行回滚 | 不涉及 | 不涉及 | 不涉及 | 不涉及 |
| 证据优先 | 不动证据 | 原证据不改，复核另存 | 不涉及 | 原文封存 |
| 单用户、无 RBAC | 是 | 复核者是 worker 会话，不是人类角色 | 是 | 是 |
| 不自动绕 EDR / 不修客户系统 | 是 | 是 | 是 | 是 |

---

## 13. 证据索引

### 13.1 本轮代码

- 审计纯函数：`packages/contracts/src/engagement-audit.ts:119`（阈值）、`:182`（派生）、`:418`（摘要）
- 图投影：`packages/history/src/index.ts:4217`（`engagementAudit`）
- Observe 注入：`packages/history/src/index.ts:4389`（观察员）、`:4397`（记分卡）
- Worker 工具：`packages/worker/src/graph-phase.ts:209`（定义）、`:511`（处理）、`:39`（ALWAYS）
- 测试：`packages/contracts/src/engagement-audit.test.ts`（12）、`packages/history/src/engagement-audit.test.ts`（1）、`packages/worker/src/graph-phase.test.ts`（末例）

### 13.2 本轮指出的现状（复核用）

- 自证入口：`packages/worker/src/graph-phase.ts:767`
- 验证闸：`packages/history/src/index.ts:3509`（`verifyFinding`）
- 证据角色可选：`packages/contracts/src/finding.ts:56-64`
- 软节奏：`packages/worker/src/soft-pace.ts:33-36`
- 板级纪律：`packages/worker/src/board-policy.ts:30`
- 扇出硬顶：`packages/contracts/src/fanout.ts`
- parser 工具：`packages/worker/src/pi-loop.ts:957`
- 报告覆盖章：`packages/history/src/report.ts:194`
- 能力阶梯：`packages/exec/src/scope.ts:31`

### 13.3 上游

- 清单：<https://tsecbench.zc.tencent.com/resources>（读取于 2026-11-24；页面同步 2026-11-23 22:12）
- 源仓库：<https://github.com/Yeti-791/Awesome-Offensive-AI-Agentic-Landscape>
- BreachWeave：<https://github.com/m-sec-org/BreachWeave>（README：Manager / Solver / Observer；Idea / Memory；结束条件外置）
- Cain：<https://github.com/cdxiaodong/cain-agent>（README：deterministic pipeline；Finder ≠ Validator；scope.yaml；4-state verdict）
- AutoRedTeam-Orchestrator：<https://github.com/Coff0xc/AutoRedTeam-Orchestrator>（README：四层权限；确认源；执行哈希上限；scorecard / gaps）
- pentestcode：<https://github.com/s0ld13rr/pentestcode>（README：engagement state；mandatory parser；critic；13 agents）
- Strix：<https://github.com/usestrix/strix>（README：PoC validation；graph of agents）
- Decepticon：<https://github.com/BitterSecurity/Decepticon>（README：16 specialist agents；fresh context；eco/max；双网 sandbox）
- Cairn / sapper-v2：见 [absorb-cairn.md](./absorb-cairn.md)、[absorb-sapper-v2-nuwa.md](./absorb-sapper-v2-nuwa.md)（已吸收，不重复）

### 13.4 复验记录

- `pnpm -r run typecheck`：0 错误（7 个 workspace 包 + console + cli）。
- `pnpm -r run test`：**403 通过 / 0 失败**（contracts 65 / history 73 / worker 63 / exec 56 / control-plane 117 / console 29）；新增测试全绿。
- 本轮为**本机合成夹具**验收；没有真实委托、没有上游代码执行、没有真实模型跑分。

---

## 14. 一句话

P14 让系统「有手、有证据」；P15 的第一刀让系统「知道自己正在磨、正在自证、正在空转」——先做不花 token 的观察员与记分卡，再用独立复核者把「verified」从自述变成可推翻的结论。**目标默认授权、运行期零目标拒绝：复核与记账管的是结论质量，不是目标合法性。**

---

## 15. 本轮追加落地（2026-11-24）

C0 之后，按 §6–§9 的设计把 C1/C2/C4 与 Skill/MCP 硬化一并落地；C3 阶段级评测仍留待下一轮。

### C1 独立确认（Finder ≠ Validator）

- 契约：`Finding.verifiedBy`、`FindingValidation`（四态 verdict / 四种 method）、`FindingsGate.requireIndependent`（`packages/contracts/src/finding.ts`）。
- 存储：`finding_validations` append-only 表 + `verified_by` 列迁移（`packages/history/src/index.ts`）。
- 规则：`recordFindingValidation` 拒绝「validator == verifiedBy」的自证；`confirmed/refuted` 必须有证据；不自动改 finding 状态；`hasConfirmedValidation` 以**最近一条独立意见**为准（后续 inconclusive 会撤销确认）。
- 闸门：`assertGoal` 在 `requireIndependent` 时逐条检查 supporting finding，缺独立确认即拒绝并写 `goal_assert_rejected`。
- 入口：worker `finding_validate`；`POST /tasks/:id/findings/:fid/validate`；`GET /tasks/:id/validations`；`gy finding-validate` / `gy validations`。
- 报告：每条 finding 增加「独立确认」行与全局「独立确认 x/y；高/严重未确认 z」。
- 测试：`packages/history/src/finding-validation.test.ts`（3）、`packages/worker/src/graph-phase.test.ts`（1）、`packages/control-plane/src/validation-api.test.ts`（1）。

### C2 执行哈希断路器

- 归一化与豁免：`packages/exec/src/repeat.ts`（trim/折叠空白/去尾分号；只读轮询豁免）。
- 计数：`command_attempts` 表（task + hash + count）。
- 闸门：`assertRepeatAllowed` 覆盖 `shell`、`shell_job start`、PTY write、C2 task；默认上限 4，`GY_REPEAT_COMMAND_LIMIT` 可调；`gy command-reset` 由操作员显式重置。
- 测试：`packages/exec/src/repeat.test.ts`（2）、`packages/worker/src/tools.test.ts`（1）。

### C4 强制解析

- MCP 原始 stdout 通过 `invokeWithRaw` 交给 parser，模型仍只看 12k 截断；不再拿 JSON 包装串去 parse。
- shell 直跑 nmap/httpx/nuclei/ffuf 也会自动 parse；输出不是机读格式时返回 `[parser] mandatory: ...` 并给出必需 flag。
- MCP 默认 flags：nmap `-oX -`、httpx `-json`、nuclei `-jsonl`。

### MCP 硬化

- 每个 `mcp.json` 增加 `capability`（observe/scan/active-lab/full）、`parser`、`timeoutMs`、`whenToUse`；能力级别由配置决定，不再只靠 id 硬编码。
- 二进制健康检查：Kali 未安装的 MCP 在目录里标「未安装」，`enable` 直接拒绝（如 dalfox）。
- 新增 `amass` 包（Kali 已验证安装）；共 30 个内置 MCP。
- `from-manifest` 的 tool description 合并 `whenToUse`，timeout 可按包配置。
- 新增 `targetFlag`：ffuf `-u`、wpscan `--url`、smbmap `-H`、naabu `-host`、子域工具 `-d`；子命令（`dir`/`smb`/`enum`）留在 defaultFlags 最前，修掉此前「`-u -u target` / bare target」的 argv 拼接缺陷。
- 直接 MCP 工具调用（`mcp__<id>__run`）也走 parser lane，不再只有 `mcp_invoke` 解析。

### Skill 硬化

- 新增 4 个技能：`independent-validation`、`engagement-observer`、`scope-attribution`、`mcp-health-and-parser`；`skills/routing.json` 共 32 条路由。
- Explore/Reason 提示词加入独立确认、观察员、机读输出三条纪律。

### 控制台

- 任务详情新增「P15」页签：作业记分卡、观察员建议、独立确认台账（只读，不派单、不改状态）。

### 验收

- Mac：`pnpm -r run typecheck` 0 错误；`pnpm -r run test` 416 通过 / 0 失败（contracts 65 / console 30 / history 76 / worker 68 / exec 58 / control-plane 119；cli 0）。
- Kali（临时副本 `/home/parallels/GongYuAI-p15`）：安装、构建、全量测试 416 通过 / 0 失败；本地合成 e2e 通过（真实 nmap 解析、独立确认、重复命令断路、MCP raw 解析、审计记分卡）。**验证副本、e2e 脚本和临时任务目录已在结束后删除；Kali 生产 `gongyuai.service` 未切换。**
- 测试命令使用干净 `HOME`，避免 Kali 上 `~/.gongyuai` 旧任务迁移污染临时夹具；这是环境隔离，不是功能差异。

### 仍然不做

- C3 阶段级/命令级评测（留待下一轮；本轮以单测 + Kali 夹具验收）。
- 自动修客户系统、自动扩 scope、safe-by-default 覆盖 RoE、角色戏。

> **P17 续篇**：主机枚举解析、事件哈希链、AD/云 attack graph、provider 池/三层路由、阶段/命令级评测已落地，边界与验收见 [p17-closing-gaps.md](./p17-closing-gaps.md)。

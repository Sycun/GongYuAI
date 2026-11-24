# GongYuAI Architecture

理论信仰层见 [theory-fact-intent-dag.md](./theory-fact-intent-dag.md)；开发分期见 [dev-handbook.md](./dev-handbook.md)；文档索引见 [README.md](./README.md)。

## Problem

Long-running authorized pentest agents fail for four reasons: context windows fill, processes die, side effects are not idempotent, and models mark goals done without evidence.

赛道对照（2026）：Cairn / Intentest、sapper-v2、CHAP 分别从 **Fact–Intent 图、分层历史 + 自恢复、会话接力** 三条线验证了同一结论——**跨崩溃与跨上下文窗口唯一可信的是外置结构化状态，不是聊天 transcript**。

## Solution (MVP →  hardening)

1. **Durable Run** — Worker checkpoints phase/step to SQLite; control-plane lease + Watchdog restarts dead workers onto the same History/Durable volumes.
2. **External History（黑板）** — Layered Fact (title / summary / evidence) + Intent + Goal 图是跨会话唯一真相；个体可死，图必须活。
3. **Router / Worker split** — Control plane never executes shell. Workers own tools.（对应 sapper「指挥官永不亲手执行」）
4. **Evidence gate** — Goals stay `passes:false` until matching files exist under `evidence/`.
5. **AI-native policy** — Human supplies target coordinates, budget, and goal contracts. Targets are authorized by definition: the agent never judges, questions, or refuses a target ([red-team-positioning.md](./red-team-positioning.md)). Exploration path is model-driven (or mock script for CI).
6. **Session Relay** — 会话边界写入结构化 handoff protocol（πₙ），再启新会话；会话内保留完整工具输出，只在边界压缩。Watchdog 崩溃恢复不写 π。
7. **Harness differential** — `bare`（无 History/Relay）vs History vs +Relay，只报相对差分。

## 三层基座（女娲 × DAG × Super-agent）

| 基座 | 职责 | 本仓落点 | 状态 |
| --- | --- | --- | --- |
| **女娲** | 组织存活与繁衍：个体可死、图必须活、经验须传承 | 项目记忆（lease/Watchdog 接班、分层 History、Relay π、族级打法）已硬化；全局记忆（档案索引 + 蒸馏图谱 + 工具遗产，P8 提案，见 [memory-layer.md](./memory-layer.md)） | 存活已硬化；繁衍缺位 |
| **DAG** | 路径与真相：走得对（授权在委托前提，不在运行时审查） | Fact–Intent 无因探索禁令（路径合法性）、证据闸 + SHA-256 封存、复核撤回、确定性符号因果边校验（proven/proposed） | 已硬化；渗透域语义见 P6；因果边校验单测已验证 |
| **Super-agent** | 调度经济：花得省 | 脑手分离（相位工具面）、多 Explore 异步派单、三层模型路由（提案） | 结构已有；模型分层/偏航审计见 P7 |

细则：[absorb-super-agent.md](./absorb-super-agent.md)。Super-agent 是配置 + 小协议补丁，不是第二套编排系统；主脑永不拿回执行工具（Octop 0/5 委派教训）。执行权落到工具闸：Explore 执行必须绑定已认领 Intent，conclude 校验认领人；多 worker leader 不执行（见 [long-run-contract.md](./long-run-contract.md)）。

繁衍动力学：[数据飞轮](./data-flywheel.md)（P9 提案）——采集→评测→蒸馏→改进→验证五环，让使用变成进化；转的是 harness 与知识，不是模型权重，每环过人审/差分/holdout 质量闸。

产品图面：[图视图族](./graph-views.md)（P10 提案）——一图一真相、五视图投影（DAG + 资产/攻击面/执行/记忆四图），跨图同 ID 导航，图提示只走建议层。

渗透执行层：[pentest-ops-design.md](./pentest-ops-design.md)（P11 提案）——任务级持久会话、后台作业异步回流、隧道/Chromium 工具、委托规则（时间窗/RoE/速率自判均默认放开）、模型主动求助、开始/暂停/继续/停止/结束生命周期；底座能力映射见 [pi-durable-integration.md](./pi-durable-integration.md)（底座管活，图管对）。

## Core graph: Fact–Intent–Goal

渗透被建模为 **部分可观测状态空间上的有向搜索**（Cairn / Intentest 同构）：

| 原语 | 含义 | GongYuAI 落地 |
| --- | --- | --- |
| **Fact** | 只追加的观察记录，可追溯复核状态 | `facts` 表；`layer ∈ {title, summary, evidence}`；append-only |
| **Intent** | 基于既有 Fact 的探索承诺（尚未完成） | `intents` 表；CAS claim；`proposed → claimed → running → succeeded\|failed` |
| **Goal** | 宏观终态契约 | `goals` + `evidencePatterns`；证据文件闸门，不可口头完成 |
| **Hint**（可选） | 人类战术注入 | 控制台 / API 写入，下次 Observe 吸收（对应 Cairn Hint / Intentest prompt 表） |
| **Asset**（投影） | 测试资产清单 | 带 `asset` 标签的 Fact；控制台「资产」与 Observe 同表；见 [asset-inventory.md](./asset-inventory.md) |

因果边（Intentest 形式化，GongYuAI 目标语义）：

```text
Fact  ──front──▶  Intent  ──back──▶  Fact'
                      │
                      └── claim / heartbeat / conclude
```

约束：

- 新 Intent **必须**挂在已有 Fact（或 origin）上，禁止无因探索。
- Fact 保留原始记录。复核按目标追加确认或撤回意见，撤回可指向同一任务的更正 Fact。证据路径和当时的内容版本随复核一起保存。见[复核设计](./evidence-review.md)。
- 协作只通过图（stigmergy），禁止 Worker 间私聊成为真相源。
- 运行中发现的子域/主机经 `asset_record` 写入资产投影；**自动**按 `auth.targets`（含 IPv4 CIDR / `*.domain`）准入，不另开资产库、不静默改作业坐标列表。

### 因果边校验与 DAG 导出（Lane D）

**符号边校验（`packages/history/src/edge-verifier.ts`）** —— 100% 确定性纯函数：不读时钟、不做 I/O、不调 LLM。每条因果边（`Fact → Intent`、`Intent → Fact`、`Fact/Intent → Finding`、`Finding → Finding`）按固定顺序判定：

1. 端点缺失 / 自指 → `proposed` + `ungrounded_reference`；
2. 时间不可解析 → `proposed` + `missing_timestamp`；
3. 前驱 `createdAt` 晚于后继 → `proposed` + `timestamp_inversion`（引用再多也不洗白）；
4. 后继显式引用前驱 id（`sourceFactIds` / `factIds` / `intentId`）→ `proven`；
5. 对象/指纹真实交集（asset / endpoint / credential / 证据 SHA-256 / `http:<id>` / 证据文件路径）→ `proven`；
6. 以上皆无 → `proposed` + `missing_shared_artifact`。

`proven` 只表示「规则可证明」，不表示漏洞结论正确。判定写回 `GraphEdge.verification` / `abstentionReason`（Phase 0 冻结契约）。

**DAG 导出（`packages/history/src/dag.ts` + `HistoryStore.dagExport()`）** —— 只读投影，资产 → 事实 → 意图 → 漏洞 全链路；`findings` 稳定暴露 `intentId / factIds / trafficIds / qualification / evidence / validations`，前端图谱与漏洞表共用一份字段口径；缺依据的边标 `proposed` / `broken`，不编造父节点与时间。

**因果绑定（治本 Fact 断链）** —— `HistoryStore.bindActiveIntent` / `resolveActiveIntentId`：`claimIntent` / `heartbeatIntent` 的成功 CAS 即绑定（relay 重启后第一轮 heartbeat 恢复），`concludeIntent` / `expireStaleIntents` 即解绑。Explore 内 `history_append_fact` / `asset_record` / `credential_record` / `finding_record` 未显式传 `intentId` 时自动继承；显式 `null` 表示「明确不挂父节点」。控制面进程从不 claim/heartbeat，因此操作员写入的事实不会被误挂。`Intent.assetRoot` 经 `groundedAssetRoot` 边界校验：只接受前驱 Fact 已确认或资产清单已登记的资产，拒绝 oos / 通配 / CIDR。

**状态**：以上条目单测实跑（泳道 D 提交树：history 108 / worker 96，`typecheck` 0 错误；共享工作区全仓 `pnpm -r run test` 515 通过 / 0 失败，含并行泳道未提交改动）；真实委托联调（MITM 录制 → DAG 投影 → 控制台 6 Tab）**待联调验证**。Phase 0 已冻结的 `TrafficRecord`（MITM 流量录制）、`FindingValidateRun*`（独立复核）、`FindingQualification`（三档定级）与本轮控制台 6 Tab 收敛，实现侧在各自泳道实跑验收前一律标「待联调验证」。

### Worker 任务原语（Cairn 三件套 → GongYuAI）

同一 Worker 执行三类图驱动任务（不是固定渗透阶段流水线）：

| 任务 | 触发 | 产出 |
| --- | --- | --- |
| **Bootstrap** | 任务仅有 origin + goals | 首批 Fact + 候选 Intent |
| **Explore** | 存在未 claim 的 Intent | 单 Intent → 验证 → 0..n 新 Fact |
| **Reason** | 有新 Fact / Hint，且无待 Explore | Complete 判定 / 新 Intent / no-op |

默认单 Worker；任务创建时可设 `execution.maxConcurrentExplores`（1–16，控制台按靶标数智能推荐 3–10）。有效并发 = min(配置, max(靶标数, admitted/live 资产数))，运行中**只扩不缩**动态扩容；共享 History（Intent claim CAS），slot 0 任 Bootstrap/Reason/Report leader。细则：[parallel-explore-scaling.md](./parallel-explore-scaling.md)。

## Control plane vs Worker

```text
┌─────────────────────────────────────────┐
│  Control plane（Mission Control API）     │
│  Task FSM · lease/fence · Watchdog        │
│  发现 MCP/Skill · 不下发 shell             │
└──────────────────┬──────────────────────┘
                   │ manifest + volumes
┌──────────────────▼──────────────────────┐
│  Worker（local / docker）                 │
│  Observe History → Orient → Decide Intent │
│  → Act(tools) → write Fact/evidence       │
│  budget · checkpoint · optional Relay     │
└─────────────────────────────────────────┘
```

Watchdog **零策略**：只保活（续租、死进程重启、预算截止收卷）。战术决策一律走 History / Worker，不混进看门狗（sapper 经验 7）。

## Packages

| Package | Responsibility |
| --- | --- |
| `@gongyuai/contracts` | Shared schemas (Task, Goal, Fact, Intent, Manifest, Relay*) |
| `@gongyuai/history` | SQLite History store (`node:sqlite`) + evidence gate |
| `@gongyuai/control-plane` | Task state machine, Docker/local runner, Watchdog, HTTP API |
| `@gongyuai/worker` | Pi Durable / OpenAI / mock loop + tools + relay hooks |
| `@gongyuai/cli` | `gy` single-user CLI |

\* Relay / 图相位 / bare harness 见 [long-run-contract.md](./long-run-contract.md) 与 [dev-handbook.md](./dev-handbook.md)。

## Data layout (per task)

```text
.gongyuai/tasks/<taskId>/
  manifest.json
  history.sqlite          # Fact / Intent / Goal / events（跨会话真相）
  durable.sqlite          # worker phase checkpoint
  durable.sqlite.ckpt.sqlite
  evidence/               # 证据闸门根目录
  workspace/
    PROGRESS.md
    relay/                # 规划：π0.md, π1.md, … 累积 handoff
  worker.log
  worker-status.json
  report.md
```

## Runtime

- `GY_RUNTIME=local` — spawn worker Node process (dev / smoke).
- `GY_RUNTIME=docker` — one container per task (`gongyuai-worker` image).

## Tools enhancement (MCP + Skill)

- Repo folders: `mcp/builtin|user`, `skills/builtin|user` (plus `.gongyuai/.../user` overlay). Platform **discovers** packs on boot / 「重扫目录」.
- Console：**设置 → 工具增强 → MCP / Skill**。开关 = 执行模型是否可见。
- Built-in MCP：一工具一目录，**禁止**单体 `kali-mcp`。工具数量 ≠ Agent 能力。
- Built-in Skill：方法论按需加载；数量 ≠ 质量。

## Research mapping（吸收什么 / 不抄什么）

| 来源 | 吸收 | 明确不抄 |
| --- | --- | --- |
| [Cairn](https://github.com/oritera/Cairn) | Fact/Intent/Hint 黑板；Bootstrap/Reason/Explore；stigmergy | AGPL 代码；「零 MCP」教条；细则 [absorb-cairn.md](./absorb-cairn.md) |
| [Intentest / A2](https://arxiv.org/abs/2609.07344) | Fact–Intent DAG；Intent FSM；无因探索禁令；Intent 检索过滤思路 | 照搬五段 RAG 算法细节 |
| [sapper-v2](https://github.com/N1nEmAn/sapper-v2) + [女娲测试文](https://mp.weixin.qq.com/s/nibHYWmDTf6TkNhPhtvFdw) | 分层 History；指挥官不下工具；Watchdog 零策略；上下文饱和写交接；hint 同构迁移 | tmux 军团 / 兵种涌现当产品面；「零 MCP」教条；示踪剂未开源臆造 |
| [CHAP / A22](https://www.ndss-symposium.org/wp-content/uploads/lastx2026-42.pdf) | 结构化 protocol 接力；双触发（阈值阈值阈值阈值 / 自然检查点）；会话内全量、边界压缩 | 把 History 整表扔进摘要代替图 |
| [Resurface](https://github.com/lilysttail/Resurface) | 证据邻域下钻；缺元数据不编造；写入幂等；检索只交证据不答 | 对话记忆服务当地二真相；chat/π 向量 RAG |
| [ARIA-X](https://github.com/01NGVI-QINGYI/ARIA-X) | 预算尽仍出报告；工具单闸审计；报告从图渲染；双图分离（→P6 E1） | AGPL 源码；专家军团；其工具目录整迁；Planner 垄断写图 |
| [DeepSeek Super-agent](https://mp.weixin.qq.com/s/zoS7GlReWPhfCjENGxXCdg) / [Octop](https://mp.weixin.qq.com/s/5r_EhRzdgRgzg8kWmZDyRQ) | 脑手分离正面论据；三层模型路由；链式召回≈分层下钻；偏航审计只写 Hint | 主脑保留执行工具；人工确认当默认闸；内存收件箱；细则 [absorb-super-agent.md](./absorb-super-agent.md) |

细则与 P5 验收：[absorb-resurface-aria-x.md](./absorb-resurface-aria-x.md)。

**History/Relay 检索层默认不做**：跨会话权威是 Fact–Intent 图；π 只是工作记忆。结构化图邻域 ≠ 语义检索。有窗口压力或 TSecBench 差分痛点再开建议层。

## Differentiation

Not a HexStrike-style tool catalog, not a fixed PentestGPT stage pipeline, not a tmux legion.  
**Harness + History DAG + evidence contracts + optional session relay**；MCP/Skill 是可插拔执行层。

产品一句话：

> 面向授权红队作业的长时运行渗透工作台：目标默认授权、运行期零目标拒绝；任务可断点续跑，完成必须有证据，会话可接力而不丢攻击路径。

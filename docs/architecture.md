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
5. **AI-native policy** — Human supplies auth scope, budget, and goal contracts. Exploration path is model-driven (or mock script for CI).
6. **Session Relay** — 会话边界写入结构化 handoff protocol（πₙ），再启新会话；会话内保留完整工具输出，只在边界压缩。Watchdog 崩溃恢复不写 π。
7. **Harness differential** — `bare`（无 History/Relay）vs History vs +Relay，只报相对差分。

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
- 运行中发现的子域/主机经 `asset_record` 写入资产投影；**自动**按 `auth.targets`（含 IPv4 CIDR / `*.domain`）准入，不另开资产库、不静默改授权列表。

### Worker 任务原语（Cairn 三件套 → GongYuAI）

同一 Worker 执行三类图驱动任务（不是固定渗透阶段流水线）：

| 任务 | 触发 | 产出 |
| --- | --- | --- |
| **Bootstrap** | 任务仅有 origin + goals | 首批 Fact + 候选 Intent |
| **Explore** | 存在未 claim 的 Intent | 单 Intent → 验证 → 0..n 新 Fact |
| **Reason** | 有新 Fact / Hint，且无待 Explore | Complete 判定 / 新 Intent / no-op |

默认单 Worker；任务创建时可设 `execution.maxConcurrentExplores`（1–16），控制面按 min(配置, 靶标数) 拉起多 Explore 进程，共享 History（Intent claim CAS），slot 0 任 Bootstrap/Reason/Report leader。

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
| [ARIA-X](https://github.com/01NGVI-QINGYI/ARIA-X) | 预算尽仍出报告；工具单闸审计；报告从图渲染 | AGPL 源码；专家军团；其工具目录整迁 |

细则与 P5 验收：[absorb-resurface-aria-x.md](./absorb-resurface-aria-x.md)。

**History/Relay 检索层默认不做**：跨会话权威是 Fact–Intent 图；π 只是工作记忆。结构化图邻域 ≠ 语义检索。有窗口压力或 TSecBench 差分痛点再开建议层。

## Differentiation

Not a HexStrike-style tool catalog, not a fixed PentestGPT stage pipeline, not a tmux legion.  
**Harness + History DAG + evidence contracts + optional session relay**；MCP/Skill 是可插拔执行层。

产品一句话：

> 给授权渗透长程任务的 Mission Control：任务可断点续跑，完成必须有证据，会话可接力而不丢攻击路径。

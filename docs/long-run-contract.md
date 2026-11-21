# Long-run contract

长跑契约 = **租约保活** + **检查点恢复** + **图状态一致性** + **证据闸门** + **会话接力**。  
对照：Cairn/Intentest（图 FSM）、sapper（分层史 + 自恢复）、CHAP（protocol 接力）；  
机制补丁：[Resurface](https://github.com/lilysttail/Resurface)（证据邻域 / 不编造）、[ARIA-X](https://github.com/01NGVI-QINGYI/ARIA-X)（收卷报告 / 工具单闸）——细则 [absorb-resurface-aria-x.md](./absorb-resurface-aria-x.md)。  
理论展开：[theory-fact-intent-dag.md](./theory-fact-intent-dag.md)；分期落地：[dev-handbook.md](./dev-handbook.md)。

## Lease

- Control plane owner acquires lease (`leaseOwner`, `leaseUntil`, monotonic `fence`).
- Watchdog renews while worker is alive.
- Expired lease + dead worker ⇒ restart with same task volumes（History / evidence / relay 不变）。
- Watchdog **零策略**：不读攻击路径、不派 Intent、不改 Goal。

## Checkpoint

Worker persists `{ phase, step, toolCalls, installs, tokens, relayGeneration? }` before advancing.  
After crash, resume from last phase (`init → loop → report → done`)。

进程级恢复 ≠ 上下文级恢复：

| 层 | 存什么 | 谁读 |
| --- | --- | --- |
| Durable checkpoint | 循环相位、计数器 | 同 Worker 重启 |
| History graph | Fact / Intent / Goal | 任意继任 Worker |
| Relay protocol | 会话压缩快照 πₙ | 新会话首轮注入 |

## Fact–Intent consistency

### Fact

- Append-only；`layer`：`title`（索引）→ `summary`（可进 prompt）→ `evidence`（路径指向 `evidence/`）。
- **Worker Observe**：默认只注入 Goals + title 层 + open Intents；summary/evidence 经 `history_read_fact` / `history_list_layer` 按需下钻。
- **证据邻域（P5）**：`history_read_fact` 返回目标 Fact 时附带同 `intentId` 链上的前后邻 Fact（title 层摘要）；无邻域则空列表，**不编造**。
- **元数据保真（P5）**：事件时间 / 缺字段不得用「现在」或占位文案填假；未知即省略。
- 报告 / 控制台可用 `overview`（Observe + 近期 summary）。
- 写 Fact 时应带 `intentId`（若由某 Intent 产生），形成 Intent→Fact 回边。
- **禁止**把 chat / Relay π 的语义检索结果直接写成 Fact；图邻域是结构化邻接，不是 RAG。

### Intent FSM

现状 schema：`proposed → claimed → running → succeeded | failed | expired`。

与 Intentest 对齐的语义：

| 事件 | 转移 | 规则 |
| --- | --- | --- |
| propose | → `proposed` | **强制** `sourceFactIds[]` 非空；每项为已有 Fact id 或伪 Fact `origin` |
| claim | `proposed` → `claimed` | CAS；绑定 `claimedBy` |
| start | `claimed` → `running` | 可选；可合并进 claim |
| conclude ok | → `succeeded` | 必须附 conclusion + **≥1** 新 Fact（同调用写回，`intentId` 绑定） |
| conclude fail | → `failed` | conclusion 写清否定证据 / 约束；Fact 可选 |
| heartbeat timeout | → `expired` 或回 `proposed` | 允许被重新 claim |

幂等：

- Intent claim = compare-and-swap on `proposed`。
- Goal assert sticky（`passes` 永不回退）。
- Facts append-only。

### 禁止无因探索

Worker 在提出新 Intent 前必须能指出「基于哪些 Fact」。  
**已硬化**：`proposeIntent` 拒绝空 / 未知 `sourceFactIds`；允许伪 Fact id `origin`（`ORIGIN_FACT_ID`）。  
Explore 成功：`concludeIntent(succeeded, …, { facts })` 同事务写回 Fact←Intent 边。

### 资产清单与范围匹配

- 创建任务即 `seedAssetsFromAuth`：每条 `auth.targets` → 一行 seed 资产（控制台立刻可见）。  
- 发现物经 `asset_record` 写入；`admitAddress` **自动**判定 admitted / oos（IPv4 CIDR、`*.domain`、裸域后缀、`*`）。  
- `outOfScope` 覆盖 targets。  
- Observe 注入「资产清单」；`GET /tasks/:id/assets` 供控制台轮询。  
- 细则：[asset-inventory.md](./asset-inventory.md)；匹配实现：`packages/contracts/src/scope.ts`。

## Evidence gate

`assertGoal(goalId, paths)` succeeds only when:

1. Each `evidencePatterns` entry matches at least one provided relative path.
2. Every provided path exists under `evidence/`.
3. If a path is `**/ALL_COMPLETE.json`, the JSON must be a non-empty challenge array and **every** `is_completed` must be `true`（TSecBench 清板）。

No file ⇒ no pass. Model self-report / verbal DONE is insufficient.

## Session Relay（CHAP 对齐，GongYuAI 化）

目标：缓解 context rot，而不用「整段聊天摘要」替换 History 图。

### 原则

1. **会话内**：保留完整工具输出（高保真调试态）。
2. **会话边界**：只把增量压成 protocol πₙ，累积注入下一实例。
3. **图仍是权威**：πₙ 是面向 LLM 的工作记忆；冲突时以 History Fact 为准。
4. **Relay ≠ 崩溃恢复**：崩溃走 lease/checkpoint；Relay 走「主动换脑 / 上下文阈值」。

### 双触发

| 触发 | 条件 |
| --- | --- |
| Auto | `tokens` 或估算上下文超过阈值（建议可配，默认偏保守；CHAP 实验用 30k） |
| Agent | Worker 调用 `relay` 工具：立足点、提权、横移、卡死、噪音过大等自然检查点 |
| Guard | 两次 Relay 之间至少 N 次 tool call，避免空转接力 |

### Protocol 字段（最小集）

写入 `workspace/relay/π<n>.md`（或 `.json`），内容只追加**相对已有 π 的增量**：

```text
- current_position: user / host / shell / privileges
- network_map: hosts / services touched
- tried: successes + failures that reveal constraints
- active_sessions: named shells / tmux（若有）
- foothold: exact command sequence to re-obtain state
- unexplored_surface: *untried* hosts/ports/endpoints/creds（禁止臆测）
- open_intents: ids still proposed/claimed（指向 History）
- budget_spent: tokens / toolCalls / wall
```

下一 Worker 启动顺序：

1. 加载 manifest + Goals  
2. `history.overview`（title 层）  
3. 注入 π₀…πₙ  
4. 从 open Intents / 未完成 Goals 继续  

### 已知代价（CHAP 结果）

- 接力后需重新定向，成功题可能多耗若干轮。
- 大上下文模型上增益变小；小窗口 / 长攻击链上更有价值。
- pass@k 多跑可能收敛——应用 **同预算相对裸 agent 差分** 验收，不迷信单次分。

## Graph phase tool protocol（真模型）

Worker OpenAI loop 按 Durable `phase` 过滤工具面：

| phase | 允许（摘要） |
| --- | --- |
| bootstrap | History 读写、`intent_propose`、`phase_set`、Skill；无 shell/MCP 执行 |
| explore | claim/conclude + shell/MCP/install/`assert_goal`/`technique_transfer`；**每 worker** 一次一个 `activeIntentId`；多 worker 靠 Intent CAS 并行 |
| reason | propose / assert / History / `technique_transfer`；**有 open Intent 时强制回 explore**；吸收 Hint |

## Hint（P4）

- `POST /tasks/:id/hints` `{ text, source?, tags? }` 写入 History `hints` 表（事件 `hint_appended`）。
- Observe 含「Hint（战术注入）」；Worker 下一轮吸收，不另开私聊通道。
- CLI：`gy hint <taskId> "<text>"`；控制台任务「运行态」可注入。

## 同族迁移（P4）

- 工具 `technique_transfer`：已验证手法 → `transferable` Fact（可选 `family:<key>`）→ 对端非 oos 资产各提出一条 Intent → 附带 `source=family` Hint。
- 协作只写图；重复广播对同标题 open Intent 幂等跳过。

`GY_HARNESS=bare` 关闭 History DAG 与 Relay，仅作差分基线。

## Worker budget

**默认不设硬预算**：`maxWallMs` / `maxToolCalls` / `maxTokens` / `maxInstalls` 为 **0 = unlimited**。Worker 一直跑到目标全过、致命错误或操作者停止。仅当 CLI/API 显式传入正数 `--max-*` 时才启用对应闸门。

Prompt **禁止**把预算说成倒计时，禁止「还剩 N 分钟 / 本轮收口」提前停工。清板类任务另注入单题软限额与 Intent 纪律（见 `board-policy.ts`）。

**软节奏提示**（`soft-pace.ts`）：默认每 50 次工具调用、每 2 小时墙钟注入一次用户侧提醒（换题/续跑）。**只提示，从不终止循环**，绝不写成 `budget_exhausted`。可用 `GY_SOFT_TOOL_STEP` / `GY_SOFT_WALL_MS` 调整。

Loop exits on any of: all goals pass, optional hard gate, fatal error, or operator stop.

- `completed` only when all goals pass.
- `budget_exhausted` **only** when a finite hard gate actually fired.
- `incomplete` when the loop ended without all goals **and** without hitting a gate; Pi path **re-kicks** while goals remain.
- `failed` / `stopped` for errors / operator stop.
- 重启任务必须重置 `startedAt`，并把预算恢复为 unlimited（避免旧墙钟秒杀）。
- **预算尽仍出报告（P5）**：硬闸或 incomplete 收卷仍落盘 `report.md`，禁止静默退出无报告。
- Tool results are truncated for the chat buffer；权威细节在 evidence + History。
- Host network / VPN / proxy mutations are denied even if `auth.targets` contains `*`.

## Tool single gate（P5）

- Worker 侧工具执行经**统一入口**（现有 `runTool` / 等价分发）：能力阶梯、禁主机网络变更、预算计数、结果截断、History 审计事件同一路径完成。
- 拒绝（缺权 / 策略 / 预算）也写审计事件，禁止旁路 `exec` 绕过入口。
- 不引入第二套审批产品面；人工 `ask` 闸属后续可选，非本刀。

## Auth capability ladder

在 prompt 白名单之上，工程化阶梯（对照 AutoRedTeam-Orchestrator）：

`observe → scan → active-lab → full`

| 级别 | 允许 |
| --- | --- |
| observe | History / evidence / assert / relay；无 shell / install / MCP |
| scan | + shell、install、recon 类 MCP（nmap/httpx/…） |
| active-lab | + 主动利用类 MCP |
| full | 全部 Worker 工具面（仍禁主机 VPN/代理变更） |

新任务 schema 默认 `observe`；`gy run` 默认传 `active-lab`。VPN/代理变更永远拒绝。

## Idempotency

- History facts are append-only.
- Intent claim is compare-and-swap on `proposed`.
- Goal assert is sticky (`passes` never reverts).
- Tool installs record History events.
- Relay 文件按 generation 追加，不覆盖旧 π。

## Termination

`completed` | `failed` | `budget_exhausted` | `stopped` written to `worker-status.json`; Watchdog promotes TaskRecord.

# Long-run contract

长跑契约 = **租约保活** + **检查点恢复** + **图状态一致性** + **证据闸门** + **会话接力**。  
对照：Cairn/Intentest（图 FSM）、sapper（分层史 + 自恢复）、CHAP（protocol 接力）。  
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
- 报告 / 控制台可用 `overview`（Observe + 近期 summary）。
- 写 Fact 时应带 `intentId`（若由某 Intent 产生），形成 Intent→Fact 回边。

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

## Worker budget

Loop exits on any of: all goals pass, `maxToolCalls`, `maxTokens`, `maxWallMs`, or fatal error.

- `completed` only when all goals pass.
- Otherwise terminal status is `budget_exhausted` (or `failed` / `stopped`).
- Tool results are truncated for the chat buffer；权威细节在 evidence + History。
- Host network / VPN / proxy mutations are denied even if `auth.targets` contains `*`.

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

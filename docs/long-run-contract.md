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
| conclude ok | → `succeeded` | 必须附 conclusion + **≥1** 新 Fact（同调用写回，`intentId` 绑定）；**必须由 `claimedBy` 本人提交** |
| conclude fail | → `failed` | conclusion 写清否定证据 / 约束；Fact 可选；**必须由 `claimedBy` 本人提交** |
| heartbeat timeout | → `expired` 或回 `proposed` | 允许被重新 claim |

幂等：

- Intent claim = compare-and-swap on `proposed`。
- Intent conclude = 认领人校验；非 `claimedBy` 拒绝。系统超时收卷（`forceConcludeExploreTimeout`）是唯一例外，写 partial Fact，不发明战术。
- Goal assert sticky（`passes` 永不回退）。重新初始化目标只补缺失记录，首次通过时的证据路径和审计事件保留。
- Facts append-only。

### 禁止无因探索

Worker 在提出新 Intent 前必须能指出「基于哪些 Fact」。  
**已硬化**：`proposeIntent` 拒绝空 / 未知 `sourceFactIds`；允许伪 Fact id `origin`（`ORIGIN_FACT_ID`）。  
Explore 成功：`concludeIntent(succeeded, …, { facts })` 同事务写回 Fact←Intent 边。

### 资产清单与范围匹配

- 创建任务即 `seedAssetsFromAuth`：每条 `auth.targets`（作业坐标）→ 一行 seed 资产（控制台立刻可见）。  
- 发现物经 `asset_record` 写入；`admitAddress` **自动**判定 admitted / oos（IPv4 CIDR、`*.domain`、裸域后缀、`*`）。  
- `outOfScope` 覆盖 targets。  
- Observe 注入「资产清单」；`GET /tasks/:id/assets` 供控制台轮询。  
- Reason / `technique_transfer` 扇出硬顶：`execution.maxIntentsPerReason`（默认 4）、`maxIntentsPerAssetRoot`（默认 2）；oos-only 前驱拒利用。  
- Explore 墙钟：`exploreTimeoutMs`（默认 15min）超时强制 conclude + partial Fact；Reason 多 slot：`reasonLeaseMs` CAS。  
- 细则：[asset-inventory.md](./asset-inventory.md)；匹配实现：`packages/contracts/src/scope.ts`。

### Explore 并发与动态扩容

- 有效并发 = `min(maxConcurrentExplores, max(seed靶标数, admitted/live 资产数))`；硬顶 16，下限 1。启动与崩溃重启均按此解析。
- 运行中 Watchdog 存活分支调 `runner.reconcileWorkers`：**只扩不缩**、永不超用户上限、只读资产计数不读 Fact 内容（资源供给，非战术；零策略军规不破）。每任务检查节流 ≥10s。
- 新 slot 为 follower（leader 判定只看 `slot===0`）；独立 Durable checkpoint；预算口径与聚合闸不变；扩容写 `explore_scaled` 事件。
- 细则与验收：[parallel-explore-scaling.md](./parallel-explore-scaling.md)。

## Evidence gate

`assertGoal(goalId, paths)` succeeds only when:

1. Each `evidencePatterns` entry matches at least one provided relative path.
2. Every provided path is relative to `evidence/` and resolves to a regular file there. Parent traversal, symbolic links and hard-linked files are rejected. The same boundary applies to Worker evidence writes and console reads.
3. If a path is `**/ALL_COMPLETE.json`, the JSON must be a non-empty challenge array and **every** `is_completed` must be `true`（TSecBench 清板）。

普通目标至少需要非空材料。可配置 `evidenceChecks` 精确匹配 JSON 顶层字段；证据哈希与首次通过在同一事务保存，原始字节在事务前采集并在写入时按 SHA-256 校验。旧记录缺少原版时报告标明未知。见[事实复核与离线验收](./evidence-review.md)。

**基准语义必须显式选择**：只有目标声明 `boardGate: "tsecbench"` 时，名为 `ALL_COMPLETE.json` 的文件才按清板数组校验（非空、每条 `is_completed === true`）。普通委托附一份同名业务材料，只按该目标声明的 `evidencePatterns` / `evidenceChecks` 判读；交付摘要也不得以文件名推断"做过内容检查"。基准样例（`examples/tsecbench/goals-autonomous.json`）在目标里显式写入 `boardGate`。

可配置 `findingsGate { minVerified, minSeverity?, vulnClasses?, scope?, assets? }`（P6-E1）：
- `scope: "goal"`（默认）只计**本目标声明资产**（`assets`，或 `findingsGate.assets`）上的发现；未声明资产即拒绝断言，禁止退化为全任务累计（A1）。
- `scope: "task"` 是显式的全委托汇总口径，只有汇总目标可以用。
- 只计 `verified` / `retested` / `accepted`；severity 与 vulnClass 可收窄；不满足即拒绝，与证据闸同等硬。
- 首次通过时把支持该目标的 `findingId`、当时状态与封存证据写入 `goal_findings`（A3/A5）。归属在首次通过时冻结；之后撤回不抹掉首次通过，但当前交付会显示"唯一依据已撤回"或"部分依据已撤回"，也不会把断言后新增的发现自动补进首次依据。
- 记分卡分列"曾通过"与"当前证据足以支持"；旧档归属未知保留历史结果，但不计入当前支持（A4）。收集口径的资产必须在目标级闸里具体声明，`assets:["*"]` 被拒绝，等价需求走 `scope:"task"`。

**提交顺序（A3）**：findings 查询与首次通过写在同一个 `BEGIN IMMEDIATE` 事务里。撤回先提交 → 本次断言看不到该发现；断言先提交 → 历史通过保留，当前核对按最新状态重算。

## Finding ledger（P6-E1）

漏洞是图对象，不是聊天叙述。`findings` 表 + `finding_proofs`（证据 SHA-256 封存，同 `evidence_versions`）。

- **状态单向**：`tentative → verified → retested → accepted`；`retracted` 为终态，任何非终态可撤回。行永不删除（append-only 语义）。
- **处置分列**：技术确认（`finding_verify`）、整改复测（`finding_actions.action=retest`，结果 fixed/still-present/partially-fixed，逐轮留存）、客户风险处置（`action=accept`，须客户决定文件）分别记录；复测/处置不覆盖原始验证证据。
- **record**：`finding_record` 一律从 `tentative` 起步；`dedupKey`（缺省 asset|vulnClass|endpoint）唯一，重复记录幂等返回已有行。
- **verify 硬闸**：≥1 个 `evidence/` 内 regular file（当场 SHA-256 封存）+ 非空 `repro`；缺一拒绝。verified 后 confidence=firm。
- **交付边界**：报告 §Findings 只渲染 verified/retested/accepted；tentative 只计数提示，retracted 保留可查不进交付。
- **工具相位**：`finding_record/verify/retract` 在 explore+reason；`finding_list` 全相位可读。Observe 注入 Findings 台账（近 30 条，含状态/severity）。
- **事件**：`finding_recorded` / `finding_verified` / `finding_retracted` 入 `history_events`。
- 不做：自动 CVSS 算分当结论（只存 vector 原文）；口头改状态；finding 级向量检索。

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

## Unified role & phase tool protocol（统一工具目录与门禁）

Pi Durable 主循环与 OpenAI 回退循环共用单一工具目录（`packages/worker/src/tool-catalog.ts`）与确定性门禁（`evaluateWorkerToolGate`），按静态角色 `WorkerRole`（`solo | leader | follower`）与图相位过滤工具面：

| 角色 / 相位 | 工具面与运行契约 |
| --- | --- |
| **Leader**（`slot 0, workerCount > 1`） | 纯规划/验卷角色（`bootstrap / reason / report`）：**物理剥离**全部重型执行工具（`shell`、`shell_job`、`shell_session`、`c2`、`http_request`、`tunnel_open/close`、`mcp_invoke`、`mcp__*`）；只负责开题、扇出 `Intent`、审计与 `assert_goal`。槽位排满后通过 `YIELD` 零 Token 驻留，支持滑动窗口补单。 |
| **Follower**（`slot 1..N`） | **单 Intent 隔离短会话角色**（固定 `explore`）：物理剥离 `assert_goal`；每次 `intent_claim` 单个 `proposed` Intent 独立取证验证；调用 `intent_conclude` 时通过 `control: { terminate: true }` 立即结束当前轮，并在认领下一条 Intent 前执行 `root.reset()` 重置本地会话上下文（所有有效事实/漏洞/凭据已落入 History SQLite），彻底消除跨目标上下文污染，且免除后台 `π` 快照刷盘与全局软节奏弹窗。 |
| **Solo**（`workerCount = 1`） | 单进程兼任 `bootstrap → explore → reason → report`；支持 `intent_propose(claim="true")` 一步认领进入 Explore。 |

**确定性三条硬门禁（`evaluateWorkerToolGate`，零动态锁套娃）**：

1. **求助永不拦截**：`operator_consult` 在任何相位与角色下均畅通放行。
2. **静态角色与相位白名单**：`roleAllowedToolNames` 强制脑手物理隔离；`phase_set(explore)` 拒绝零 open Intent。
3. **执行工具强制绑定活跃 Intent**：执行类工具（`shell`、`http_request`、`mcp_invoke`/动态 MCP、`c2` 写操作、`tunnel_open/close`、`install_*`、`oast_issue`、`shell_job/session` 写动作）必须持有当前 worker 本人 `claimed/running` 的 `activeIntentId`，通过时自动 `heartbeatIntent`；拒绝统一记入 `tool_gate` 事件。
4. **证据耗尽换面不锁死工具面**：`maybeForceEvidenceStall` 超时结项旧 Intent 后，仅通过 `longTurn.notes` 注入换面提示，不再在 `beforeTool` 设置全量阻塞旗标。

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

**软节奏提示**（`soft-pace.ts`）：默认每 50 次工具调用、每 2 小时墙钟、以及**同一 Intent 每 25 次工具**注入提醒（建图 / 验证影响 / 换面）。**只提示，从不终止循环**，绝不写成 `budget_exhausted`。Pi 长会话在 `afterTools` 入队，续跑时注入。可用 `GY_SOFT_TOOL_STEP` / `GY_SOFT_WALL_MS` / `GY_SOFT_SURFACE_STEP` 调整。

**渗透作业视角**（清板/engagement 任务）：`board-policy.ts` + `goals-autonomous.json` 把目标函数定为攻击面经营与可审计 finding；flag/题号只是 PoC 条件。交付并行维护 `engagement/report.md`。

Loop exits on any of: all goals pass, optional hard gate, fatal error, or operator stop.

- `completed` only when all goals pass.
- `budget_exhausted` **only** when a finite hard gate actually fired.
- `incomplete` when the loop ended without all goals **and** without hitting a gate; Pi path **re-kicks** while goals remain.
- `failed` / `stopped` for errors / operator stop.
- 从终态重新开始时重新计墙钟，保留操作者设定的四项预算。Token、调用和安装沿用任务累计口径。详情 API 同时返回本轮增量 `runUsage` 和累计 `usage`。
- **预算尽仍出报告（P5）**：硬闸或 incomplete 收卷仍落盘 `report.md`。控制面墙钟截止时停止 Worker，用当前 History 写报告，再发布 `budget_exhausted`。如果收卷写盘失败，任务记为 `failed` 并保留错误原因。
- Tool results are truncated for the chat buffer；权威细节在 evidence + History。
- Host network / VPN / proxy mutations are denied even if `auth.targets` contains `*`；只读状态查询放行（`scutil --nc list|status|probe`、`networksetup -get*/-list*`，任何能力级可查）。这是**工程自保**（保护运行主机），不是目标审查。

## Tool single gate（P5）

- Worker 的 shell、安装、资产收集和 MCP 通过 `gateTool` 记录调度前的 `tool_gate` 判定。判定覆盖能力阶梯、各工具的授权检查和适用的预算。相位拒绝与 Intent 绑定拒绝也写同类事件。
- Explore 执行工具在相位闸之后再过 Intent 闸：无 active claimed Intent 不得执行；多 worker leader 不执行。该闸不替代能力/范围/预算闸。
- MCP 初始化和启用应用同一能力策略。直接调用与别名调用共享启用状态、工具注册、显式目标及预算检查。外部适配器需要对其自身的网络动作落实隔离和授权。
- 不引入第二套审批产品面；人工 `ask` 闸属后续可选，非本刀。

## Capability ladder（操作档位）

> 档位决定工具面可见性与风险敞口，是**操作配置**，不是目标合法性审查。目标进入任务即视为授权；拒绝只有工程自保（[red-team-positioning.md](./red-team-positioning.md)）。

在 prompt 白名单之上，工程化阶梯（对照 AutoRedTeam-Orchestrator）：

`observe → scan → active-lab → full`

| 级别 | 允许 |
| --- | --- |
| observe | History / evidence / assert / relay；无 shell / install / MCP |
| scan | + shell、install、asset_search、recon 类 MCP（nmap/httpx/…） |
| active-lab | + 主动利用类 MCP |
| full | 全部 Worker 工具面（仍禁主机 VPN/代理变更） |

新任务 schema 默认 `active-lab`（P16 已收敛，2026-11-24）：`full` 由操作者显式选择；档位是操作配置，不是授权审查。`authorizationNote` 为可选操作备注（不再是必填授权证明），`roe` 为可选操作者意图自由文本。VPN/代理变更永远拒绝（只读状态查询除外）——这是工程自保，与目标无关。

## Pause / resume / scope revision（阶段 2）

- **状态分层**：`pause_requested`（已请求、worker 收尾中）与 `stopping` 是活动过渡态；`paused` 非活动、非终态；`stopped` 才是终态。看门狗不重启也不提升过渡态。
- **暂停确认**：`pause` 先写请求，再向 worker 发 SIGTERM，轮询确认进程消失后才写 `paused`。超时未确认则回 `recovering` 并报错——不发布"假暂停"。Checkpoint / History / 证据 / 用量全部保留；不写终态报告。
- **恢复**：`resume` 从最新控制面记录重建 manifest，因此**恢复即读取最新操作配置**；范围更新（`POST /tasks/:id/scope`）只能在无 worker 运行时进行，`scopeVersion` 递增并写一条 summary Fact。旧的 π/图事实不会恢复旧范围。`scopeVersion` 只表示作业坐标变更，不是授权版本。
- **外部状态**：`GET /runtime` 返回 `externalState = running | pause_requested | stopping | paused | stopped | unknown` 与 `lastConfirmedAt`。活动记录但无存活 worker、无新心跳时如实报 `unknown`，不以进程启动或端口监听冒充健康。
- **人工求助已闭环**：`operator_consult` 与「24h 无回复自动转非阻塞（保留 open 状态）」已在 `ops-tools.ts` / `handoff.ts` 落地，且在 `evaluateWorkerToolGate` 中享有最高放行优先级。

## Idempotency

- History facts are append-only.
- History SQLite 并发纪律：WAL + `busy_timeout=5000`；多 Explore 共享写，事务保持短（Intent CAS / conclude 回写均单事务）。控制面读资产计数用短开只读连接。
- Intent claim is compare-and-swap on `proposed`.
- Goal assert is sticky (`passes` never reverts).
- Tool installs record History events.
- Relay 文件按 generation 追加，不覆盖旧 π。

## Termination

`completed` | `failed` | `budget_exhausted` | `stopped` written to `worker-status.json`; Watchdog promotes TaskRecord.


## 9. 第九轮新增契约（运营状态层）

> 只写**已经进代码**的契约；类型定义在 `packages/contracts/src/ops.ts`，存储见 `packages/history/src/ops.ts`（任务级）与 `packages/control-plane/src/platform.ts`（平台级 `platform.sqlite`）。

### 9.1 可见性

- `VisibilityContext { tenantId, engagementId?, operator?, role }`。
- `visibilityDenial(ctx, task)`：租户不等 → `tenant-mismatch`；显式委托不等 → `engagement-mismatch`；任务缺 `engagementId` 时自成一委托。
- 新入口一律先过边界再读写；越界返回 403，不得静默返回空列表。
- 资产身份：`assetIdentity(engagementId, address) = "<engagementId>::<normalizeHost(address)>"`；跨委托同名资产不得互相命中。

### 9.2 持久作业

- 表 `background_jobs`（每任务）：`id, task_id, engagement_id, kind, label, status, scope_version, asset, submitted_by, options_json, inputs_json, progress_json, artifacts_json, error, receipt_key, delivered_at, attempt, boot_id, pause_state, started_at, finished_at, created_at, updated_at, late_result, result_json`。
- 状态：`queued|running|paused|draining|succeeded|failed|canceled|unknown`；`pause_state ∈ none|stopped|draining|unknown`。
- 暂停：执行中 → `draining`；未开始 → `paused(stopped)`；重启后上一代 `running` → `unknown`（`reconcileJobAfterBoot`）。
- 完成回流：`material-check` 完成后按目标声明的材料图案调用 `assertGoal`（与操作员入口同一实现）；任务已终态时重渲染报告。
- 迟到结果：`lateResult = 完成时 scopeVersion > 提交时 scopeVersion`；结果保留，不自动计入当前结论。
- 回执：`job_receipts(job_id, delivery_key)` 主键唯一；重复投递 `duplicate=true`，事件只记一次。

### 9.3 人工求助

- 表 `consultations`：`blocking` 与 `status` 分离；`dueAt = createdAt + 24h`。
- `sweepConsult` 只把 `blocking=false` 并写 `releasedAt`，`status` 保持 `open`；**问题仍须明确答复**。
- 答复写 `answeredAt/answeredBy/answer`；可回注 `source=human` Hint（`tags` 含 `consult:<id>`）。

### 9.4 材料与证据语义

- `EvidenceImport { kind, status, source, parser{name,version}, importedAt, observedAt, asset, materialPath, sha256, locator, sensitivity, secretRef, reason, scopeVersion }`。
- `status ∈ accepted|unsupported|unknown-owner|expired`；**导入成功永不等于"已验证"**。
- 疑似明文凭据必须走 `secretRef`（受控引用），落盘只有指针与原文摘要。
- 材料 TTL：asset-inventory/config-check 14d、http-transaction 7d、manual-retest 30d。

### 9.5 覆盖矩阵与时效

- `CoverageState ∈ unknown|material|attempted|manual|verified|retracted`；优先级 `verified > manual > attempted > retracted > material > unknown`。
- `retractedOnly`：唯一依据被撤回；`independentSupport`：未被撤回的依据条数。
- 证据身份以**路径为主、sha 为辅**：撤回 `evidence_removed{path,sha256}` 后，引用该路径的结论失去依据。
- `freshnessOf(fact, now)`：TTL 派生 `fresh|needs-review`，**不改写/不删除原 Fact**。
- 报告新增 `## 证据撤回影响`：受影响结论与"仍有独立依据/唯一依据已撤回"分开写。

### 9.6 图视图

- 四个只读视图共用 `GraphView { taskId, engagementId, view, generatedAt, empty, emptyReason, nodes[{id,kind,label,badge,data}], edges[{id,from,to,kind,label,broken}], notes }`。
- 稳定 ID：`asset:<engagementId>::<host>`、`fact:<id>`、`intent:<id>`、`finding:<id>`、`step:<id>`、`memory:<id>`、`source:<taskId>:<refId>`、`job:<id>`。
- 缺依据的边必须 `broken=true` 并在 label/`broken[]` 说明缺什么；不建第二状态存储。

### 9.7 记忆

- 节点 `lesson|playbook|counterexample|tool-artifact`；状态 `draft|confirmed|retracted|superseded`。
- `provenance` 至少一条（无源不记忆）；`contradicts`/`supersedes` 只追加不删除。
- 注入：只取 `confirmed`；硬键命中正常注入，仅 ≥2 软键算参考；标题层 N=5，命中当前资产追加 ≤2；只写 `source=system` Hint，不写 Fact。
- 注入事件 `memory_injections{memoryId,taskId,engagementId,hintId,layer,matchedKeys,injectedAt}` 可回查"哪些任务引用过它"。
- 档案索引 `/archive/contact` 只回指针，非阻塞，`历史接触 ≠ 本次作业坐标`。

### 9.8 飞轮与角色

- 提案：`evidence` 至少一条（无证据不提案）；`draft → approved|rejected → promoted → rolled-back`；晋升要求真实评测且 `metrics.adjudicated>0`；回退保留 `promotedAt`/`evaluationRunId`。
- 评测：同 suite 组顺序由首次运行定义；新组只能追加；`isolatedFrom` 必须覆盖已完成的其他组；冻结 `suite+group+seed` 不可替换；`pending` 不进 FP/FN，`recall = tp/(tp+fn)`。
- 角色权限：Planner 可提案、Reviewer 可复核、Assistant 可请求/触发暂停；三者都不可 stop/扩 scope/派单（`ROLE_AUTHORITY`）。
- 供应商：`rate-limit` 退避后切换；`timeout` 重试一次后切换；`insufficient-balance` 直接切换；`egress-denied` 或备用未获准 → `blocked`，**不得换通道**；`billing:"none"` 时成本不可见。

### 9.9 明确不做（本轮）

- 不把作业做成 chord detached 进程（进程死 → `unknown`，由人 retry）。
- 不让记忆/经验成为任务 Fact，不让图提示派单。
- 不改 Watchdog 策略；暂停不杀会话（当前也还没有会话对象）。
- 不做自动晋升、不自动执行回滚脚本、不自动修复客户系统。

# 理论综合：Fact–Intent DAG 与长程渗透状态

本文综合论文 **A2** [Staying on the Attack Path](https://arxiv.org/abs/2609.07344)（Intentest）的核心理论，并与 Cairn、sapper-v2、CHAP 对齐，落成 GongYuAI 的信仰层说明。

本地 PDF：[`Staying on the Attack Path.pdf`](./Staying%20on%20the%20Attack%20Path.pdf)

配套工程文档：

| 文档 | 关系 |
| --- | --- |
| [architecture.md](./architecture.md) | 产品架构如何实现本理论 |
| [long-run-contract.md](./long-run-contract.md) | 运行时契约（FSM / Relay / 闸门） |
| [dev-handbook.md](./dev-handbook.md) | 分期落地顺序 |

---

## 1. 问题：长程渗透为什么会「掉路径」

自动化渗透可建模为 **POMDP**：真实网络状态 \(\mathcal{S}\) 不可全知，Agent 只能通过动作 \(\mathcal{A}\) 获得观测，再更新信念 \(b_t\)。

若把 \(b_t\) 放在 LLM 的线性 context 里，长跑会出现两类病：

1. **Context forgetting（上下文遗忘）**  
   早期微事实（内网段、凭据、隐藏参数）被截断或注意力稀释；后续决策像失忆。
2. **Intent drift（意图漂移）**  
   宏观 Goal 仍是「拿 shell / 清板」，局部行为却变成无目标重试、扫无关面。

论文判断：这不是单靠「更强模型 / 更长窗口」能消掉的。只要全局信念仍活在对话里，长尾因果链就会断。

经验对照：

| 路线 | 局限 |
| --- | --- |
| 纯聊天记忆 | 窗口一截，早期事实没了 |
| 自然语言任务树（PentestGPT 类） | 碎片一多即爆窗，仍易漂 |
| 多 Agent 共享纯文本 memory | 减负，跨步因果不硬 |
| 经典规划器（PDDL 等） | 缺谓词 / 0day / 非标 Web 易死锁 |
| 裸 RAG | 词重叠引噪声，诱发因果幻觉 |

---

## 2. 核心翻牌：信念外置成 Fact–Intent DAG

Intentest 建立在 Cairn 的黑板上，用 BDI 映射攻防：

| BDI | 攻防含义 | 图原语 |
| --- | --- | --- |
| Belief | 已核实的网络状态 | **Fact**（不可变节点） |
| Desire / Goal | 授权终态 | **Goal**（任务级契约） |
| Intention | 基于当前信念的战术承诺 | **Intent**（有前驱的边 / 工作单元） |
| Action | 具体工具命令 | Worker 执行层（不进全局真理） |

### 2.1 形式化（论文 Definition 1）

\[
\mathcal{G}=(\mathcal{F},\mathcal{I},E_{f\to i},E_{i\to f})
\]

- \(\mathcal{F}\)：已验证、不可变的 Fact 集合  
- \(\mathcal{I}\)：Intent 集合  
- \(E_{f\to i}\)：前向边 — 已知事实 **触发** 探索意图  
- \(E_{i\to f}\)：回边 — 意图成功后 **产出** 新事实  
- 路径在 Fact 与 Intent 间交替；整体为 **DAG**（无环）

决策节拍被压成：

```text
已知 Fact → 沿 Intent 承诺探索 → 执行验证 → 写回新 Fact'
```

于是：

- LLM **不再负责**「记住全局」；只在局部子图上提议下一步。  
- 「能不能干」由图结构判定：**没有前驱 Fact，就不能写 Intent**（结构性前置条件）。  
- 「Stay on the Attack Path」= 只能沿因果继承的路径前进。

### 2.2 为什么必须是图，而不是列表

图相对列表多出的关键性质是 **因果方向与可审计继承**：

- Fact A 支撑 Intent B，B 产出 Fact C —— 可剪枝、可回收、可复盘。  
- 多前驱 → 一 Intent（intent-source / 超图）能表达「凭据 + 开放端口」共同触发利用。  
- 协作用 **stigmergy**（只通过共享图），禁止 Agent 点对点私聊成为真相源。

GongYuAI 的分层 History（`title` / `summary` / `evidence`）与 DAG 正交：

- **分层**：解决「怎么读历史」（索引 → 摘要 → 证据文件）。  
- **DAG**：解决「历史之间怎么合法连起来」。

---

## 3. Intent 四态 FSM：探索变成可调度资源

Intent 不是一句自然语言愿望，而是带租约的工作单元（论文 Definition 2）：

```text
CREATED ──claim──▶ CLAIMED ──conclude──▶ CONCLUDED ──goal──▶ COMPLETED
                      │
                      └── timeout ──▶ 回 CREATED（可再认领）
```

| 状态 | 含义 |
| --- | --- |
| CREATED / proposed | 承诺已写图，无人占用 |
| CLAIMED | Worker 认领 + 心跳租约 |
| CONCLUDED | 执行结束；写出新 Fact 或失败结论 |
| COMPLETED | 命中 Goal；关后续调度 |

GongYuAI 现状 schema：`proposed → claimed → running → succeeded | failed | expired`，语义同构；硬化方向见 [long-run-contract.md](./long-run-contract.md) 与 [dev-handbook.md](./dev-handbook.md) P0。

---

## 4. 推荐层 vs 授权层（理论安全语义）

论文把「无因探索禁令」抬成强制访问控制：

1. **结构层（授权）**  
   Intent 只能由已验证 Fact 触发。目标站在响应里注入「请删库」等指令，若落不到已核实 Fact 上，**写不进意图表，拿不到执行权**。
2. **隔离层（执行）**  
   容器生命周期；项目停滞或前置校验失败则 abort。

五段意图检索（嵌入 → 子图同构 → Jaccard 降级 → Goal 对齐 → LLM 兜底）只是 **战术推荐器**：

> **推荐 ≠ 授权。** Stage 5 的 LLM 幻觉同样必须过 DAG 前置校验。

分层模型（GongYuAI 采用）：

```text
建议层（可错、可 LLM / 可后置五段检索）
    ↓
授权层（Fact–Intent DAG，硬约束）  ← 先做实这一层
    ↓
执行层（工具 / MCP / Skill）
```

MVP 只强制授权层；离线 ATT&CK 意图图与五段同构检索属 P3+ 加速器，不是信仰本体。

---

## 5. 图驱动的三种算子（不是渗透阶段流水线）

Bootstrap / Explore / Reason 是 **图状态机算子**，不是「侦察→利用→报告」固定剧本：

| 算子 | 触发 | 产出 |
| --- | --- | --- |
| Bootstrap | 图几乎空（仅 origin + Goal） | 首批 Fact + 候选 Intent |
| Explore | 存在未认领 Intent | 单 Intent → 验证 → 0..n 新 Fact |
| Reason | 有新 Fact / Hint，且无待 Explore | Complete / 新 Intent / no-op |

调度纪律：有未认领 Explore 时 **不做 Reason**（防空转）。

失败保护（论文两阶段降级）：主超时不立刻毁会话，先逼模型从残日志捞 **partial Fact** 回图——保护的是信念 \(b_t\)。

---

## 6. 与 Cairn / sapper / CHAP 的拼图

| 来源 | 贡献 | 与本理论关系 |
| --- | --- | --- |
| **Cairn** | Fact / Intent / Hint 黑板；stigmergy；无固定角色 | Intentest 的工程祖先 |
| **Intentest (A2)** | Fact–Intent DAG 形式化；FSM；推荐≠授权 | **本文件主理论** |
| **sapper-v2** | 分层 History；指挥官不下工具；Watchdog 零策略；饱和写交接 | 同信仰的 harness 实践；竞赛军规非产品面 |
| **CHAP (A22)** | 会话边界结构化 protocol 接力 | 压缩的是 **会话工作记忆**；**跨会话攻击路径权威仍是 DAG** |

一句话分工：

> **DAG 管路径；分层 History 管可读性；Relay 管换班；Durable/lease 管进程活着；Evidence 管 Goal 可复核。**

---

## 7. 实验在支撑哪句理论

同模型（DeepSeek V4 Pro）对比（论文 Table 1）：

| | Intentest | VulnBot（基线最高） |
| --- | --- | --- |
| Overall | 88.2% | 44.1% |
| Hard | 75.0% | 25.0% |

- Hard 上 Claude Code / PentestGPT 归零 → 支撑「长尾靠窗口会挂」。  
- 消融关掉意图检索、保留 DAG+调度：中/难题成功轮次约降 33% / 48% → **图本身**已在治遗忘；检索是加速器。

注意：成绩绑定其 CTF 集与设定，不作跨基准绝对排名；GongYuAI 验收仍用 TSecBench / smoke **相对裸循环差分**（见开发手册）。

---

## 8. GongYuAI 落地映射

| 理论 | 仓库落点 | 分期 |
| --- | --- | --- |
| Fact 不可变、分层 | `packages/history` facts + `evidence/` | 已有 → 提高 title 优先注入 |
| Intent FSM + CAS claim | intents 表 | 已有 → P0 加 `sourceFactIds` |
| 无因探索禁令 | propose 强制前驱 Fact | **P0** |
| Explore 回写 Fact 绑 Intent | worker conclude 路径 | **P0** |
| Bootstrap / Reason / Explore | Durable phase | P2 |
| Hint | 控制台 / API 注入 | **P4 已落地** |
| 同族迁移 | transferable Fact + Intent 扇出 | **P4 已落地** |
| Session Relay πₙ | `workspace/relay/` | P1 |
| 资产投影（发现回流） | Fact tags + `asset_record`；见 asset-inventory | 已落地 |
| 五段检索 / 离线意图图 | 可选建议层 | P3+，非默认 |
| 图邻域下钻（非向量） | `history_read_fact` 同 Intent 邻 Fact | P5（Resurface 纪律） |
| 预算尽仍报告 / 工具单闸 | Worker 收卷 + 统一入口审计 | P5（ARIA-X 纪律） |

对照备忘：[absorb-resurface-aria-x.md](./absorb-resurface-aria-x.md)。**图邻域 ≠ 五段 RAG**；chat/π 语义检索默认不开。

反模式（与本理论冲突则停）：

1. 把 chat transcript 当跨会话真相。  
2. 口头 DONE 关闭 Goal。  
3. Watchdog 写战术。  
4. 未硬化授权层就上多 Worker / 五段 RAG。  
5. 从 AGPL 仓（Cairn / ARIA-X）拷代码进本仓。

---

## 9. 理论金句

> 长程渗透不是更长的对话，而是在未知状态空间里做**有因果约束的搜索**。  
> Fact–Intent DAG 把 LLM 从「失忆的决策者」降级为「局部提议器」，把全局连贯性交给图。

北极星（与开发手册一致）：

> **Harness 让任务活着；History 让路径可信；Evidence 让完成可复核；Relay 让上下文可换班。**

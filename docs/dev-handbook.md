# GongYuAI 开发手册

面向后续沿 **外置 Fact–Intent 图 + Durable + Evidence + Session Relay** 方向开发。  
设计哲学：优雅简洁够用；能删就删；砍面不砍能力；改动用 TSecBench / smoke **相对裸循环**验收。

权威文档（完整索引：[README.md](./README.md)）：

| 文档 | 职责 |
| --- | --- |
| [theory-fact-intent-dag.md](./theory-fact-intent-dag.md) | Fact–Intent DAG 理论综合（A2 + 对照） |
| [architecture.md](./architecture.md) | 产品与图模型 |
| [long-run-contract.md](./long-run-contract.md) | 运行时契约 |
| [console-research.md](./console-research.md) | Mission Control IA |
| 本手册 | 分期实现、验收、反模式 |

---

## 1. 一句话北极星

> **Harness 让任务活着；History 让路径可信；Evidence 让完成可复核；Relay 让上下文可换班。**

MCP / Skill 是弹药，不是产品定义。

---

## 2. 现状快照（相对目标）

| 能力 | 现状 | 缺口 |
| --- | --- | --- |
| Lease / Watchdog / checkpoint | 有 | 保持零策略 |
| Fact 分层 + append | title Observe + 按需下钻 | Intent 回边使用率继续抬 |
| Intent propose/claim/conclude | `sourceFactIds` + 成功回写 Fact | heartbeat → expire |
| Goal + evidence gate | 有 | 语义断言扩展（除 ALL_COMPLETE） |
| Router ≠ shell | 有 | 控制台展示图前沿即可 |
| Bootstrap / Reason / Explore | 弱（单 loop） | 图驱动调度显式化 |
| Session Relay | 无 | πₙ 文件 + 双触发 + 启动注入 |
| Auth ladder | 白名单 + 禁 VPN | 阶梯枚举 |
| 多 Worker 并行 Explore | 无 | MVP 后置 |

---

## 3. 分期路线（建议严格按序）

### P0 — 图语义硬化（先做，不并行开花）

**目标**：让 History 成为真正的攻击路径，而不只是日志表。

1. `Intent` 增加 `sourceFactIds: string[]`（contracts + migrate）；propose 时非空（允许 `origin` 伪 Fact）。
2. Explore 成功路径：`conclude(succeeded)` **同时** `appendFact(..., intentId)`。
3. Worker 系统提示：Observe 只拉 title 层 + open Intents；summary/evidence 按需。
4. 单测：claim CAS、无 `sourceFactIds` 拒绝、Goal 无文件不通过。

**验收**：`pnpm smoke`；手工跑 DVWA mock 后 `history.sqlite` 可见 Fact←Intent 链。

### P1 — Session Relay

**目标**：上下文阈值或自然检查点可换班，不丢路径。

1. contracts：`RelayProtocol` schema（字段见 long-run-contract）。
2. 工具：`relay`；写 `workspace/relay/π{n}.json`；bump `relayGeneration`。
3. 触发：token 阈值（可配）+ agent 调用；最小 tool-call 间隔。
4. Worker 启动：注入全部 π + History overview；**清空**旧 chat buffer。
5. Watchdog 重启 **不**自动生成 π（避免把崩溃当接力）；仅恢复 Durable + History。

**验收**：人为压低 token 阈值，同一 task 出现 ≥1 次 relay；继任实例能复述 foothold / unexplored；Goals 不丢。

### P2 — 图驱动调度（仍可单 Worker）

**目标**：循环显式走 Bootstrap → Explore* → Reason，而不是「自由聊天碰巧写 History」。

1. phase 写入 Durable：`bootstrap | explore | reason | relay | report`。
2. Explore 一次只 claim **一个** Intent。
3. Reason 互斥：有 open Explore 时不跑 Reason；新 Fact/Hint 唤醒 Reason。
4. 控制台 Goals / History：显示 open Intents 与最近 Fact title。

**验收**：mock 路径日志可见相位序列；失败 Intent 可被重新 propose，不污染已成功 Fact。

### P3 — 能力阶梯 + TSecBench 差分

1. `auth.capability: observe|scan|active-lab|full`；工具按级过滤。
2. 固定预算下对比：`裸 OpenAI loop` vs `GongYuAI(+History)` vs `+Relay`。
3. 主尺：TSecBench 清板或子集；辅尺：DVWA smoke。只报差分，不报绝对神话分。

### P4 — 可选并行（明确后置）

多 Explore Worker / 同族迁移提示 / Hint API。  
**不要**默认做成 sapper tmux 军团；并行是图调度的倍率，不是产品形态。

---

## 4. 包改动指南

| 改什么 | 落在哪 |
| --- | --- |
| Schema / FSM | `packages/contracts` → 再改 `history` migrate |
| 图读写 / 闸门 | `packages/history` + `history.test.ts` |
| lease / 重启 / API | `packages/control-plane` |
| 工具、prompt、relay、相位 | `packages/worker` |
| CLI 入口 | `apps/cli` |
| 看板 | `apps/console`（只读展示优先） |

规则：

- 先 contracts + history 测试，再 worker 行为。
- 控制台不发明第二套状态；只读 History / worker-status。
- 新 MCP = 新目录；禁止塞回单体桥。

---

## 5. 日常开发循环

```bash
pnpm install
pnpm -r run build
pnpm smoke                          # mock 闭环必绿
pnpm gy run --mock --wait ...       # 契约冒烟
# 真模型：
pnpm gy serve --port 8877
pnpm gy run --goals ... --auth ...  # 见 examples/
```

TSecBench：见 `examples/tsecbench/README.md`。VPN 先通；Worker 禁改主机网络。

每完成一个 P 级里程碑：

1. 更新本手册「现状快照」一行。  
2. 若契约变了，同步 `long-run-contract.md`。  
3. 提交说明写 **why**（例如「Intent 强制挂 Fact，防无因探索」）。

---

## 6. 对照物速查（实现时打开）

### Cairn

- 黑板三原语；Worker 无固定角色；任务由**图状态**生成。  
- Server 保一致；Dispatcher 调度；Worker 只收 prompt 出结构。  
- 许可 AGPL——**读思想，不拷代码**。

### Intentest (arXiv:2609.07344)

- Fact 不可变节点；Intent 有向边；四态 FSM + 租约回收。  
- 多 Agent **禁止点对点真相同步**，只写图。  
- Intent 检索要结构化过滤，忌纯词重叠 RAG 噪音。

### sapper-v2

- 价值在 harness：调度 / 记忆 / 自愈；模型可换。  
- 分层 History；指挥官不下工具；watchdog 零策略。  
- 上下文饱和 → 写交接再读（≈ Relay）。  
- 同族迁移 = Fact 广播成熟打法（P4 灵感）。  
- **竞赛军规与 tmux 编制不是 GongYuAI 产品面。**

### CHAP (LAST-X 2026)

- protocol 接力；双触发；字段要像 debugger snapshot。  
- 成功 +9.1pp / token −32%（其设定下）；有重定向税。  
- 应用：π 累积 + History 权威；勿用泛化摘要顶替图。

---

## 7. 反模式（看到就停）

1. 把 chat transcript 当跨会话真相。  
2. 用「模型说 DONE」关闭 Goal。  
3. Watchdog 里写战术 if/else。  
4. 为了像 ARTEX/sapper 先上多角色 UI。  
5. 单体 Kali MCP / 堆 200+ 工具当里程碑。  
6. 未做 P0 图约束就上多 Worker。  
7. 无裸 agent 基线就宣称 harness 增益。  
8. 从 AGPL 仓库复制实现进本仓。

---

## 8. 安全与授权

- 仅授权目标；`authorizationNote` + `targets` 必填。  
- 默认拒绝对主机 VPN/代理/路由的变更。  
- Skill/MCP 下载物使用前审查；不自动执行未审脚本。

---

## 9. 下一件最小可做事项

**P0 已完成**（图语义硬化：`sourceFactIds`、成功回写、Observe title 优先、单测）。  

下一里程碑只做 **P1 — Session Relay**（勿并行开 P2+）：

1. contracts：`RelayProtocol` schema（字段见 long-run-contract）。  
2. 工具：`relay`；写 `workspace/relay/π{n}.json`；bump `relayGeneration`。  

验收见上文 P1；做完再开 P2 图驱动调度。

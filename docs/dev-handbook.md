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
| Lease / Watchdog / checkpoint | 有；重启不写 π | 保持零策略 |
| Fact 分层 + append | title Observe + 按需下钻 | — |
| Intent propose/claim/conclude | `sourceFactIds` + 成功回写 + expire；真模型工具 `intent_*` | — |
| Goal + evidence gate | 有（含 ALL_COMPLETE） | 更多语义断言可按需加 |
| Router ≠ shell | 有 | — |
| Bootstrap / Reason / Explore | Durable phase + mock + **真模型工具面按相位过滤** | Pi Durable 路径仍以 OpenAI fallback 为主纪律 |
| Session Relay | πₙ + 双触发 + 启动注入 | — |
| Auth ladder | `observe\|scan\|active-lab\|full` | — |
| Harness 差分 | `pnpm diff-harness`：**bare**（`GY_HARNESS=bare`）/ history / relay | — |
| TSecBench CLI | hint 默认禁；409 终态快失败；`probe` + ticket 记账 | 平台 ticket 须人工重置 |
| 多 Worker 并行 Explore | **有（可配）** | 新建任务 `execution.maxConcurrentExplores`；有效并发 = min(配置, 靶标数) |
| Hint API | **有** | `POST /tasks/:id/hints` + 控制台注入；Observe 吸收 |
| 同族迁移 | **有** | `technique_transfer` → transferable Fact + 对端 Intent 扇出 |
| 资产清单 + CIDR/通配准入 | seed / asset_record / 控制台资产 Tab | 扇出预算可再收紧 |

---

## 3. 分期路线（建议严格按序）

### P0 — 图语义硬化 ✅

**目标**：让 History 成为真正的攻击路径，而不只是日志表。

1. `Intent` 增加 `sourceFactIds: string[]`（contracts + migrate）；propose 时非空（允许 `origin` 伪 Fact）。
2. Explore 成功路径：`conclude(succeeded)` **同时** `appendFact(..., intentId)`。
3. Worker 系统提示：Observe 只拉 title 层 + open Intents；summary/evidence 按需。
4. 单测：claim CAS、无 `sourceFactIds` 拒绝、Goal 无文件不通过。

**验收**：`pnpm smoke`；手工跑 DVWA mock 后 `history.sqlite` 可见 Fact←Intent 链。

### P1 — Session Relay ✅

**目标**：上下文阈值或自然检查点可换班，不丢路径。

1. contracts：`RelayProtocol` schema（字段见 long-run-contract）。
2. 工具：`relay`；写 `workspace/relay/π{n}.json`；bump `relayGeneration`。
3. 触发：token 阈值（可配）+ agent 调用；最小 tool-call 间隔。
4. Worker 启动：注入全部 π + History observe；**清空**旧 chat buffer。
5. Watchdog 重启 **不**自动生成 π（避免把崩溃当接力）；仅恢复 Durable + History。

**验收**：`GY_RELAY_TOKEN_THRESHOLD=1` 下 smoke 写出 ≥1 个 π；报告含 foothold / Session Relay。

### P2 — 图驱动调度 ✅（MVP）

**目标**：循环显式走 Bootstrap → Explore* → Reason，而不是「自由聊天碰巧写 History」。

1. phase 写入 Durable：`bootstrap | explore | reason | relay | report | done`。
2. Explore 一次只 claim **一个** Intent（mock 路径强制）。
3. Reason 互斥：有 open Explore 时不跑 Reason。
4. 控制台 Goals / History：Fact–Intent DAG 画布 + open Intents / 最近 Fact title。

**验收**：smoke `PROGRESS.md` 含 `phase=bootstrap` / `phase=explore`。

### P3 — 能力阶梯 + TSecBench 差分 ✅（MVP）

1. `auth.capability: observe|scan|active-lab|full`；工具按级过滤。
2. `pnpm diff-harness --mock --goals …`：History vs +Relay 相对表。
3. 主尺仍建议 TSecBench 子集；辅尺 DVWA smoke。只报差分。

### P4 — 可选并行 ✅

1. **Explore 并发**：新建任务 `execution.maxConcurrentExplores`（默认 1，硬顶 16）；有效并发 = min(配置, 靶标数)；共享 History + Intent CAS；slot 0 = Bootstrap/Reason/Report leader。  
2. **Hint API**：`POST /tasks/:id/hints` / 控制台「战术 Hint」/ `gy hint`；写入 History，下次 Observe 吸收。  
3. **同族迁移**：验证打法后 `technique_transfer` → `transferable` Fact + 对端非 oos 资产 Intent 扇出 + family Hint。  

**不要**默认做成 sapper tmux 军团；并行与迁移都是图调度倍率，不是产品形态。

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
pnpm smoke                          # mock 闭环必绿（含 Relay + 相位）
pnpm diff-harness --mock --goals examples/dvwa-smoke/goals.json --target https://example.com --auth "Written authorization: diff harness"
pnpm gy run --mock --wait ...       # 契约冒烟
# 真模型：
pnpm gy serve --port 8877
pnpm gy run --goals ... --auth ... --capability active-lab
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
- 分层 History；指挥官不下工具；Watchdog 零策略。  
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
- `auth.capability` 默认最低；`gy run` 显式抬权。  
- 默认拒绝对主机 VPN/代理/路由的变更。  
- Skill/MCP 下载物使用前审查；不自动执行未审脚本。

---

## 9. 下一件最小可做事项

**P0–P4 已落地**（含 Explore 并发、Hint API、同族迁移）。下一刀按真实缺口选：TSecBench 子集差分、控制台 UX、或同族 key 启发式增强。

验收：

```bash
pnpm smoke
pnpm --filter @gongyuai/history test
pnpm --filter @gongyuai/worker test
pnpm diff-harness --mock --goals examples/dvwa-smoke/goals.json \
  --target https://example.com \
  --auth "Written authorization: diff harness"
```

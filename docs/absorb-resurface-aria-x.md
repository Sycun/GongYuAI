# 吸收对照：Resurface × ARIA-X

调研日：2026-11-21。  
权威落地分期见 [dev-handbook.md](./dev-handbook.md) **P5**；运行硬约束见 [long-run-contract.md](./long-run-contract.md)；总映射见 [architecture.md](./architecture.md)。

## 结论（先读这三句）

1. **不迁入**整仓：Resurface 是对话记忆检索服务；ARIA-X 是 AGPL 安全研究引擎。GongYuAI 主骨架已在 Cairn / Intentest / sapper / CHAP。
2. **默认不做** History/Relay 语义检索层（chat/π 上的 Resurface 式 RAG）。图仍是跨会话权威；检索是建议层加速器，有差分痛点再开。
3. **已落地两刀（P5）**：① 证据邻域 + 不编造元数据（Resurface 纪律）；② 预算尽仍出报告 + 工具单闸审计（ARIA-X 纪律）。

## 仓库事实

| | [Resurface](https://github.com/lilysttail/Resurface) | [ARIA-X](https://github.com/01NGVI-QINGYI/ARIA-X) |
| --- | --- | --- |
| 问题域 | 多会话对话证据检索（AML Textual） | 本地状态空间安全研究编排 |
| 许可 | MIT | **AGPL-3.0-or-later**（概念参考 Cairn/ARTEX） |
| 可抄深度 | 机制 + 实现思路 | **只学机制，代码不进仓** |
| 与本仓关系 | 补分层 History 的保真与下钻 | 对照执行护栏 / 可复现收卷（图谱信仰已对齐） |

## 吸收表

### Resurface → GongYuAI

| 机制 | 落点 | 不做 |
| --- | --- | --- |
| Search 只交证据、服务自己不答 | Report / Goal：模型可叙述，断言必须挂 `evidence/` | 对话记忆服务当地二真相 |
| 命中带邻域 turn | `history_read_fact` / 下钻：附同 Intent 链前后 Fact | 对 chat / π 做向量 RAG |
| 缺时间戳不编造 | Fact / 报告渲染：未知字段留空 | 用「现在」填未知事件时间 |
| 写入幂等（request_id） | appendFact / 工具结果防重放双写（按需） | AML 榜面特化 |
| `core/` 与壳分离 | 保持 `@gongyuai/history` 零控制面依赖 | FastAPI / DashScope 栈 |

### ARIA-X → GongYuAI

| 机制 | 落点 | 不做 |
| --- | --- | --- |
| ToolRegistry 单入口（Scope + 策略 + 审计） | Worker 工具分发收口；旁路调用禁止 | 并入其 27 工具目录 |
| 预算耗尽仍出报告 | `budget_exhausted` 收卷必写 `report.md` + History 事件 | 堆角色配额当里程碑 |
| 报告只从图渲染 | Report：发现列表来自 History；LLM 只填叙述 | 专家角色戏 / specialist 军团 |
| 离线确定性 demo | 既有 mock / smoke；示例即回归 | 「零 MCP」教条 |
| 重定向逐跳 Scope | 请求类 Skill 按需再鉴权 | Docker `--network none` 当默认产品 |
| `ask` 审批门 | 能力阶梯之上可选（非本刀） | 复刻其 Web 控制面 |

## 明确不吸收

- History/Relay 上的嵌入 + RRF 整套（无窗口压力实测前）。
- 把 π / chat transcript 检索结果写成 Fact。
- ARIA-X / Cairn / ARTEX **任何源码**进仓。
- PTY session 军团、多专家 UI、五段 RAG 算法照搬。

## 与五段检索的关系

Intentest 五段意图检索仍是 **P3+ 可选建议层**（见 [theory-fact-intent-dag.md](./theory-fact-intent-dag.md)）。  
本文件的「邻域」是 **结构化图邻接**（同 `intentId` / `sourceFactIds`），不是词向量召回。

## 验收口径（P5）

```bash
pnpm --filter @gongyuai/history test
pnpm --filter @gongyuai/worker test
pnpm smoke
```

- 下钻 Fact 返回邻域（同 Intent 前后 Fact；无则空数组，不编造）。
- 渲染 / 序列化不把缺失时间填成「现在」。
- 任一预算闸触发 → 仍落盘 `report.md`，状态为 `budget_exhausted`（非静默退出）。
- 工具执行经统一入口记审计事件（拒绝路径也记）。

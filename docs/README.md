# GongYuAI Docs

本目录是项目**权威设计与开发入口**。后续沿 Fact–Intent 图 + Durable + Evidence + Relay 方向开发时，从这里读起。

## 文档地图

| 文档 | 职责 | 何时读 |
| --- | --- | --- |
| [theory-fact-intent-dag.md](./theory-fact-intent-dag.md) | **理论综合**：A2 Fact–Intent DAG、遗忘/漂移、推荐≠授权；对照 Cairn / sapper / CHAP | 理解「为什么这么建」 |
| [architecture.md](./architecture.md) | **架构**：问题、图原语、控制面/Worker、包职责、数据布局、差异化 | 改结构 / 对新人讲系统 |
| [asset-inventory.md](./asset-inventory.md) | **资产清单**：seed↔发现双向投影、CIDR/通配自动准入、控制台与 Observe 同表 | 靶标回流 / 资产 Tab / FOFA 发现 |
| [long-run-contract.md](./long-run-contract.md) | **长跑契约**：lease、checkpoint、FSM、证据闸、Session Relay、能力阶梯 | 改运行时行为前核对 |
| [dev-handbook.md](./dev-handbook.md) | **开发手册**：现状缺口、P0–P4 分期、验收、反模式、下一刀 | **动手写代码的默认入口** |
| [console-research.md](./console-research.md) | Mission Control 控制台 IA 调研与定案 | 改 Web 控制台 |

## 本地参考材料

| 文件 | 说明 |
| --- | --- |
| [Staying on the Attack Path.pdf](./Staying%20on%20the%20Attack%20Path.pdf) | 论文 A2 原文（Intentest / Fact–Intent DAG） |

## 推荐阅读顺序

1. [theory-fact-intent-dag.md](./theory-fact-intent-dag.md) — 信仰层  
2. [architecture.md](./architecture.md) — 怎么落成系统  
3. [long-run-contract.md](./long-run-contract.md) — 运行硬约束  
4. [dev-handbook.md](./dev-handbook.md) — 下一件做什么  

示例与跑法不在本目录：

- `examples/dvwa-smoke/`
- `examples/tsecbench/`

## 北极星

> Harness 让任务活着；History 让路径可信；Evidence 让完成可复核；Relay 让上下文可换班。

## 跨会话记忆

压缩版开发原则已写入个人 Agent store（避免新会话失忆）：

- 索引：`memory/MEMORY.md` → **GongYuAI 开发原则**
- 正文：`memory/gongyuai-dev-principles.md`

细则与分期仍以本目录文档为准；记忆只保留信仰层与反模式，防止和仓库漂移。

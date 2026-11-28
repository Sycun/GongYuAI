# GongYuAI Docs（分层导航）

本目录是项目的设计与契约文档库。按 **2026-11-26「一主两辅」架构瘦身**，全部文档收敛为三层：**日常开发与评审只需读第 1 层（5 篇核心权威）**，改动具体子系统时按需查第 2 层，第 3 层为已冻结支线与历史调研归档（未见主航道差分痛点前暂停扩面）。

---

## 1. 核心权威（必读 5 篇 · 理解与改代码的主干）

| 文档 | 核心职责 | 何时读 |
| --- | --- | --- |
| [red-team-positioning.md](./red-team-positioning.md) | **产品最高定调**：目标进入任务即默认授权、零目标拒绝、只留工程自保 | **一切设计讨论与边界裁决的起点** |
| [architecture.md](./architecture.md) | **一主两辅系统架构**：DAG 真相主核 + Leader/Follower 单 Intent 隔离调度 + Watchdog/Relay 薄保活 | 理解系统全貌、包边界与收敛红线 |
| [long-run-contract.md](./long-run-contract.md) | **运行时硬契约**：租约、检查点、Intent FSM、证据闸、统一工具目录与三条门禁铁律 | 修改 Worker / History / Control-plane 行为前 |
| [theory-fact-intent-dag.md](./theory-fact-intent-dag.md) | **理论基础**：为什么长程渗透必须靠外置 Fact–Intent DAG 解决遗忘与漂移 | 理解图原语与「推荐 ≠ 路径合法性」 |
| [dev-handbook.md](./dev-handbook.md) | **开发手册**：当前落地状态、日常验证命令、包改动规范与反模式清单 | **动手写代码前的默认入口** |

**快速导览入口（面向新成员/外部评审）：**
- [project-overview.md](./project-overview.md)（项目背景、一主两辅协作关系与当前能力边界）
- [project-guide.md](./project-guide.md)（启动、运行、接管、验收与排障操作手册）
- [project-flow.html](./project-flow.html) · [design-atlas.html](./design-atlas.html)（单文件离线可视化流程与交互导览）

---

## 2. 已落地子系统契约与实战复盘（按需查阅）

| 领域 | 文档 | 说明 |
| --- | --- | --- |
| **并发与单意图隔离** | [parallel-explore-scaling.md](./parallel-explore-scaling.md) · [optimization-plan-20261126.md](./optimization-plan-20261126.md) | 默认 `1 Leader + 3 Followers`、滑动窗口补单、按资产动态扩容（只扩不缩）、Follower 单 Intent 会话重置 |
| **靶场实战复盘** | [tsecbench-retro-20261126.md](./tsecbench-retro-20261126.md) · [pentest-evidence-rotation.md](./pentest-evidence-rotation.md) | 流量代理流容错、按资产面 `assetRoot` 判定证据停滞轮换、消除动态门禁死锁 |
| **渗透执行与域对象** | [pentest-exec-c2-enhancement.md](./pentest-exec-c2-enhancement.md) · [pentest-capability-extension.md](./pentest-capability-extension.md) · [p17-closing-gaps.md](./p17-closing-gaps.md) · [go-sidecar-architecture.md](./go-sidecar-architecture.md) | Shell/后台作业/PTY/C2、HTTP 事务证据、OAST、隧道、主机画像、AD/云图与混合 Go 执行底座（`gy-netd` 架构与性能基线） |
| **资产、证据与报告复核** | [asset-inventory.md](./asset-inventory.md) · [evidence-review.md](./evidence-review.md) · [delivery-record.md](./delivery-record.md) | 资产双向准入、证据 SHA-256 封存、撤回更正、R-017 离线复核与交付验收记录 |
| **参考资料库与控制台** | [knowledge-library-api.md](./knowledge-library-api.md) · [knowledge-library-console.md](./knowledge-library-console.md) · [console-logic.md](./console-logic.md) | 资料导入、两步向量化/混合检索、定版引用与 Mission Control 控制台逻辑 |
| **Pi 底座与实验数据** | [pi-durable-integration.md](./pi-durable-integration.md) · [experiments/](./experiments) · [implementation-ledger.md](./implementation-ledger.md) | `pi-durable` 原生 `terminate/reset/compaction` 映射、离线台账对照实验与实施台账 |

---

## 3. 冻结支线与历史调研归档（暂停扩面 · 只读参考）

> 以下方向保留设计文档与既有契约代码，但在**单任务长程渗透闭环与真实靶场差分痛点**充分打透前，**暂停继续扩写新表、新角色或新画布**：

- **远期演进提案（已冻结）**：[memory-layer.md](./memory-layer.md)（P8 跨任务全局记忆自动蒸馏与工具遗产） · [data-flywheel.md](./data-flywheel.md)（P9 数据飞轮自动晋升） · [graph-views.md](./graph-views.md) & [attack-chain-graph.md](./attack-chain-graph.md)（P10 多图画布扩展） · [pentest-ops-design.md](./pentest-ops-design.md) · [long-range-completeness.md](./long-range-completeness.md) · [pentest-adaptive-enhancement.md](./pentest-adaptive-enhancement.md) · [MASTER-DESIGN.md](./MASTER-DESIGN.md)（历史全景原始稿）
- **上游机制调研笔记**：[absorb-sapper-v2-nuwa.md](./absorb-sapper-v2-nuwa.md) · [absorb-super-agent.md](./absorb-super-agent.md) · [absorb-cairn.md](./absorb-cairn.md) · [absorb-resurface-aria-x.md](./absorb-resurface-aria-x.md) · [absorb-offensive-landscape.md](./absorb-offensive-landscape.md) · [absorb-cyber-monster.md](./absorb-cyber-monster.md) · [absorb-engagement-team.md](./absorb-engagement-team.md) · [absorb-eval-methodology.md](./absorb-eval-methodology.md) · [research-c2-csai-artex.md](./research-c2-csai-artex.md)
- **阶段性验收与历史盘点**：[round9-gap.md](./round9-gap.md) · [api-contract-r9.md](./api-contract-r9.md) · [review-checklist-r9.md](./review-checklist-r9.md) · [owner-unverified-r9.md](./owner-unverified-r9.md) · [pentest-enhancements.md](./pentest-enhancements.md) · [pentest-completeness.md](./pentest-completeness.md) · [console-research.md](./console-research.md)
- **本地论文与分享材料**：[Staying on the Attack Path.pdf](./Staying%20on%20the%20Attack%20Path.pdf)（及中文译本） · `女娲测试_CCF厦门分享_攻防迭代修订稿.pptx`

---

## 北极星（收敛版）

> **Fact–Intent DAG 与封存证据守住唯一真相；Leader 拆单验卷 + Follower 单意图干净短会话跑出并发吞吐；Watchdog 与检查点在幕后默默保活。**

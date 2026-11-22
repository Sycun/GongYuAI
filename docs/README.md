# GongYuAI Docs

本目录是项目**权威设计与开发入口**。后续沿 Fact–Intent 图 + Durable + Evidence + Relay 方向开发时，从这里读起。

> **实施台账**：[implementation-ledger.md](./implementation-ledger.md)（P0–P12→代码/入口/证据/差距，阶段 1–7 实际状态）。  
> **交付记录**：[delivery-record.md](./delivery-record.md)（发布提交/SHA、测试与验收、Kali 部署与一致性证据、复核清单）。
> **总体设计原始稿**：[MASTER-DESIGN.md](./MASTER-DESIGN.md)（愿景/用户定调/P0–P12 全景/契约/路线图/待决策）。  
> **交互全图（可独立交付）**：[design-atlas.html](./design-atlas.html)——中文、可点击/缩放/搜索/思路导览，全部思路串联一图，双击浏览器打开即可。  
> **分册交互演示**：[demos/](./demos/)——六个独立 HTML（零依赖、自带明暗主题），与下列提案文档一一对应。

## 交互演示索引（docs/demos/，均可双击独立打开）

| 演示 | 对应文档 | 看什么 |
| --- | --- | --- |
| [design-atlas.html](./design-atlas.html) | MASTER-DESIGN | 全部思路一图：65 节点、18 站导览、定调日志/路线图侧栏 |
| [demos/architecture-flow.html](./demos/architecture-flow.html) | architecture / long-run-contract | 三层基座 + 任务生命周期全链路，节点点开看规范 |
| [demos/memory-graph.html](./demos/memory-graph.html) | memory-layer（P8） | 项目记忆×全局记忆双层、溯源/注入/反馈边 |
| [demos/data-flywheel.html](./demos/data-flywheel.html) | data-flywheel（P9） | 五环飞轮 + 中心质量闸 |
| [demos/graph-views.html](./demos/graph-views.html) | graph-views（P10） | 资产/攻击面/执行/记忆四视图切换，同 ID 贯穿 |
| [demos/ops-lifecycle.html](./demos/ops-lifecycle.html) | pentest-ops-design（P11） | 生命周期状态机 + 暂停保活对象 + 模型求助回路 |
| [demos/attack-chain.html](./demos/attack-chain.html) | attack-chain-graph（P10 扩展） | 点击漏洞上下闭包聚焦整链；oos 链可见利用被拒 |

## 文档地图

| 文档 | 职责 | 何时读 |
| --- | --- | --- |
| [theory-fact-intent-dag.md](./theory-fact-intent-dag.md) | **理论综合**：A2 Fact–Intent DAG、遗忘/漂移、推荐≠授权；对照 Cairn / sapper / CHAP | 理解「为什么这么建」 |
| [architecture.md](./architecture.md) | **架构**：问题、图原语、控制面/Worker、包职责、数据布局、差异化 | 改结构 / 对新人讲系统 |
| [asset-inventory.md](./asset-inventory.md) | **资产清单**：seed↔发现双向投影、CIDR/通配自动准入、控制台与 Observe 同表 | 靶标回流 / 资产 Tab / FOFA 发现 |
| [parallel-explore-scaling.md](./parallel-explore-scaling.md) | **Explore 并发**：智能推荐 3–10、按资产数动态扩容（只扩不缩）、非战术纪律 | 改并发 / runner / watchdog 调度前读 |
| [memory-layer.md](./memory-layer.md) | **记忆层（P8 提案）**：项目记忆×全局记忆两级、繁衍闭环、记忆图溯源、档案索引、控制台 Memory 页 | 改记忆 / 经验传承 / Memory 画布前读 |
| [data-flywheel.md](./data-flywheel.md) | **数据飞轮（P9 提案）**：采集→评测→蒸馏→改进→验证五环、质量闸、提案收件箱、越用越好用 | 改记分卡 / 趋势 / 自动蒸馏 / 晋升闸前读 |
| [graph-views.md](./graph-views.md) | **图视图族（P10 提案）**：资产/攻击面/执行/记忆四图投影、跨图导航、图提示、Graph workspace | 改控制台图视图 / 投影 / 跨图跳转前读 |
| [pentest-ops-design.md](./pentest-ops-design.md) | **渗透执行层与委托规则（P11 提案）**：会话管理器、后台作业异步回流、隧道/Chromium、时间窗/RoE/速率自判/模型求助、任务生命周期 | 改会话 / 作业 / 生命周期 / 委托契约前读 |
| [pi-durable-integration.md](./pi-durable-integration.md) | **Pi 底座盘点**：pi-durable/chord 原生能力映射、深化增量、底座管活图管对 | 改 worker 主循环 / 用底座能力前读 |
| [long-range-completeness.md](./long-range-completeness.md) | **长程完备性（P12）**：D1/2/3 必补、D4 调研、D5 规划者、D6 辅助者、D8 通过、D7 删除 | 补长程时间维度缺口 / 角色设计前读 |
| [attack-chain-graph.md](./attack-chain-graph.md) | **攻击链图（P10 扩展）**：漏洞因果链投影、外网→组合漏洞→C2/getshell→内网建模、点击漏洞聚焦、链模式融合 | 改攻击链 / provenance / 链模式前读 |
| [long-run-contract.md](./long-run-contract.md) | **长跑契约**：lease、checkpoint、FSM、证据闸、Session Relay、能力阶梯 | 改运行时行为前核对 |
| [absorb-resurface-aria-x.md](./absorb-resurface-aria-x.md) | **对照吸收**：Resurface / ARIA-X 机制表；P5 两刀；禁语义 RAG 当真相 | 改 History 下钻 / 收卷报告 / 工具闸前读 |
| [absorb-cairn.md](./absorb-cairn.md) | **对照吸收**：Cairn 黑板祖先；已对齐 vs 可补（conclude 双阶段 / Reason lease） | 调度纪律对照；禁拷 AGPL 源码 |
| [absorb-sapper-v2-nuwa.md](./absorb-sapper-v2-nuwa.md) | **对照吸收**：女娲测试 / sapper-v2 文 + CCF 厦门 PPT 备注；分层史+交接+看门狗；禁 tmux 军团 | 读公众号叙事与产品取舍时 |
| [absorb-super-agent.md](./absorb-super-agent.md) | **对照吸收**：DeepSeek Super-agent / Octop / Cairn×ARTEX 分析；三层基座定位；P7 调度经济提案 | 改模型路由 / 主脑分工 / 偏航审计前读 |
| [absorb-cyber-monster.md](./absorb-cyber-monster.md) | **对照吸收**：Cyber-Monster 证据保全/误报对照/控制测试 → evidence-first / reporting 技能；路由前后对照 | 改技能路由 / 蓝队交接前读 |
| [absorb-engagement-team.md](./absorb-engagement-team.md) | **D4 调研**：Engagement 容器/三级访问/角色不授权/交接包/RoE 映射；授权与经验共享分离 | 做委托程序层 / 多人协作前读 |
| [absorb-eval-methodology.md](./absorb-eval-methodology.md) | **评测方法学（P7 基准）**：中难度带子集/多重复/配对 CI/脚手架指纹/成本一等公民 | 做模型路由或任何差分前读 |
| [dev-handbook.md](./dev-handbook.md) | **开发手册**：现状缺口、P0–P5 分期、验收、反模式、下一刀 | **动手写代码的默认入口** |
| [pentest-enhancements.md](./pentest-enhancements.md) | **渗透专项增强（P6）**：现状评估 + Finding/凭据/HTTP 事务/覆盖矩阵/变更台账/评测六刀 | 决定下一刀是否做渗透域语义时 |
| [console-research.md](./console-research.md) | Mission Control 控制台 IA 调研与定案 | 改 Web 控制台 |

## 本地参考材料

| 文件 | 说明 |
| --- | --- |
| [Staying on the Attack Path.pdf](./Staying%20on%20the%20Attack%20Path.pdf) | 论文 A2 原文（Intentest / Fact–Intent DAG） |
| [Staying on the Attack Path_translated.pdf](./Staying%20on%20the%20Attack%20Path_translated.pdf) | A2 中文译本 |
| 女娲测试_CCF厦门分享_攻防迭代修订稿.pptx | 女娲 / sapper-v2 CCF 分享（28 页；正文多为图片，**机制细节在演讲备注**，摘录见 absorb-sapper-v2-nuwa.md）。**本地参考，28MB 未入库** |

## 推荐阅读顺序

1. [theory-fact-intent-dag.md](./theory-fact-intent-dag.md) — 信仰层  
2. [architecture.md](./architecture.md) — 怎么落成系统  
3. [long-run-contract.md](./long-run-contract.md) — 运行硬约束  
4. [dev-handbook.md](./dev-handbook.md) — 下一件做什么  

示例与跑法不在本目录：

- `examples/dvwa-smoke/`
- `examples/tsecbench/`

## 第九轮后端（2026-11-22/23）

- [round9-gap.md](./round9-gap.md) — 开工前逐项盘点（代码/入口/测试）+ 实施后对照
- [api-contract-r9.md](./api-contract-r9.md) — 前端交接：可用 API、稳定 ID、样例、空值/错误语义
- [review-checklist-r9.md](./review-checklist-r9.md) — 独立复核最短路径、失败反例、三端读数
- [owner-unverified-r9.md](./owner-unverified-r9.md) — 未验证清单：工程缺项 / 缺真实供应商 / 缺真实材料

## 事实复核与验收

[女娲、DAG 与证据复核](./evidence-review.md)说明复核入口、证据版本、报告判读和离线验收用例。

[三组真模型对照](./experiments/2026-11-22-offline-review/README.md)记录同一批台账的字段准确率、实际 Token、逐题错答和复算方法。

[Relay 两批回归与六批对照](./experiments/2026-11-22-ledger-relay/README.md)比较五次交接后的准确率、交付格式与实际 Token。

[Cyber-Monster 与长任务交接](./absorb-cyber-monster.md)记录上游技能核对、证据复核与蓝队交接的融合，以及技能路由的前后对照。

## 北极星

> Harness 让任务活着；History 让路径可信；Evidence 让完成可复核；Relay 让上下文可换班。

## 跨会话记忆

压缩版开发原则已写入个人 Agent store（避免新会话失忆）：

- 索引：`memory/MEMORY.md` → **GongYuAI 开发原则**
- 正文：`memory/gongyuai-dev-principles.md`

细则与分期仍以本目录文档为准；记忆只保留信仰层与反模式，防止和仓库漂移。

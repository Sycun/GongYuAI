# 图视图族：DAG 的四图扩展（Graph Views，P10 提案）

2026-11-22 起草。状态：**提案，未动工**。用户定调：记忆图、资产图、攻击面图、执行图——能用图展现的都展现。  
配套：[console-research.md](./console-research.md) · [asset-inventory.md](./asset-inventory.md) · [memory-layer.md](./memory-layer.md) · [pentest-enhancements.md](./pentest-enhancements.md) · [data-flywheel.md](./data-flywheel.md)

## 结论（先读这四句）

1. **一图一真相，五视图投影**：Fact–Intent DAG 仍是唯一真相核心；四个新图（资产/攻击面/执行/记忆）全部是**既有数据的只读投影**，不建新真相源、不建第二套状态（控制台军规不变）。
2. **数据底座大半已有**：资产图 = 资产投影 + 发现血缘（fact.intentId → sourceFactIds）+ familyKey；执行图 = execution-trace（每步工具/token/相位/slot）+ events + Durable 相位。攻击面图依赖 P6 E3/E4 把表面元素结构化；记忆图是 P8 M2。
3. **跨图导航是杀手锏**：同一实体在所有图里用同一 ID（address / factId / intentId / findingId / stepId / memoryId）——点资产→看它的攻击面→看相关 Fact 邻域→看打过它的执行步→看注入过它的经验。
4. **图提示（graph hints）走建议层**：从投影派生的结构信号（未测面/孤岛资产/高耗低产 Intent/过期经验）生成 Hint 提案——推荐≠授权，硬闸不变。

## 一、统一原则

- **投影不是复制**：视图从 History / trace / memory 实时派生（或短缓存），源数据改了图跟着改；图里不存任何独有状态。
- **共享 ID 总线**：address、factId、intentId、findingId、stepId、memoryId 是跨图跳转与过滤的键；每个节点必须能回链到源记录。
- **只读 + 审批例外**：图交互只有导航/下钻/过滤；写操作一律走既有 API（复核、Hint、覆盖、提案审批）。
- **列表不废**：图是叠加视图，现有 Assets/Goals/History 列表保留——图看关系，列表看明细，各有所长。

## 二、四图定义

### 资产图（Asset Graph）——「范围内有什么、怎么发现的、谁和谁同族」

| 项 | 定义 |
| --- | --- |
| 节点 | 资产（kind 徽章：seed/admitted/live/oos）；授权边界圈（targets CIDR/通配可视化） |
| 边 | **发现血缘**：asset_record Fact 的 intentId → 该 Intent 的 sourceFactIds 资产（谁发现了谁）；**同族**：familyKey 相同（虚线）；seed→发现（实线） |
| 数据源 | `listAssets` + facts(tags=asset) + intents.sourceFactIds + familyKey 启发式 |
| 状态 | **数据全已有**（G1）；oos 节点灰显且不可连利用边（与硬闸同语义） |
| 回答 | 授权覆盖率、发现路径复盘、同族迁移候选、孤岛资产（无任何 Intent 触碰） |

### 攻击面图（Attack Surface Graph）——「每个资产暴露什么、测过什么、找到什么」

| 项 | 定义 |
| --- | --- |
| 节点 | 资产 → 表面元素（port/service/endpoint/param）→ 测试类（CWE/OWASP/ATT&CK）；finding 徽章（tentative 灰 / verified 亮 + severity） |
| 边 | 资产—暴露→表面；表面—测试状态→technique（untested/attempted/verified，派生自 finding 状态）；finding—命中→表面 |
| 数据源 | P6 E3 parser lane（nmap/httpx/nuclei/ffuf 结构化输出）+ E4 覆盖矩阵（asset×technique）+ findings 表 |
| 状态 | **依赖 P6 E3/E4**（G2）；落地前降级为「资产×Goal 覆盖」视图（coverage-audit 既有） |
| 回答 | 未测面清单（客户要的 coverage）、高危已复现分布、tentative 线索积压 |

**链模式（攻击链图融合，见 [attack-chain-graph.md](./attack-chain-graph.md)）**：攻击面图的第二模式——点击 finding 节点进链模式，上下闭包高亮整条攻击链（入口→组合漏洞→getshell/C2→隧道→内网资产→后续利用），其余淡出；链 = Fact–Intent 血缘 + provenance 投影，非第五张独立图。内网穿越 = 授权步骤因果链，不加新阶段/scope。

### 执行图（Execution Graph）——「Agent 怎么打的、花在哪、卡在哪」

| 项 | 定义 |
| --- | --- |
| 泳道 | phase（bootstrap/explore/reason/report）× workerSlot；Relay 边界竖线（π  generation） |
| 节点 | ExecutionStep（工具列表/token/shellCallCount）、Intent claim/conclude、tool_gate 拒绝（红）、超时 partial Fact（黄）、relay 写入 |
| 边 | 时序（同 slot 步序）+ 因果（step→产出的 Fact/Intent，经 events 关联） |
| 数据源 | execution-trace（saveExecutionStep 已落盘）+ events（tool_gate/intent_*/relay_written/explore_timeout_conclude/explore_scaled）+ Durable 相位 |
| 状态 | **数据全已有**（G1）；是飞轮记分卡（P9 F1）的可视化孪生 |
| 回答 | 成本归因（哪步烧 token）、卡死定位（同 Intent 反复换面）、拒绝审计、换班损失复盘 |

### 记忆图（Memory Graph）——「学到什么、从哪来、正在影响谁」

见 [memory-layer.md](./memory-layer.md) §三/五（P8 M2 = 本族 G3）。全局记忆图 + 任务「记忆」Tab；溯源边跨层连到源任务。

## 三、跨图导航（G4）

```text
资产图 点 api.example.com
  → 攻击面图（过滤该资产）：/login CWE-89 verified
    → DAG 视图：该 finding 的 Fact 邻域 + 前驱 Intent
      → 执行图（过滤相关 intentId/stepId）：哪几步、多少 token、谁打的
        → 记忆图：这条打法蒸馏成了哪个 Playbook、注入过哪些任务
```

- 每个节点右键/详情面板给「在其他图中查看」入口；URL 带视图+过滤键，可分享定位。
- 反向同样成立：执行图一步 → 它产出的 Fact → 所属资产 → 该资产全表面。

## 四、图提示（Graph Hints，G4）

投影派生的结构信号 → `source=system` Hint 提案（建议层，Observe 吸收）：

| 信号 | 来源图 | Hint 示例 |
| --- | --- | --- |
| 未测面 | 攻击面 | 「api.example.com 的 /upload 尚无 technique 覆盖」 |
| 孤岛资产 | 资产 | 「10.0.0.7 admitted 但无 Intent 触碰」 |
| 高耗低产 | 执行 | 「Intent X 已 40 次工具调用无新 Fact，建议换面」（与 soft-pace 同源，不终止） |
| 过期经验 | 记忆 | 「Lesson Y 的 stack 版本已漂移，注入降权」 |
| 撤回波及 | 记忆/DAG | 「Fact Z 被撤回，依赖它的 3 条结论待复核」 |

纪律：图提示**只写 Hint**，不派 Intent、不改 Goal、不终止循环；与偏航审计者（P7）共用建议层通道。

## 五、控制台 IA 增量

```text
任务深潜
  └ 图（Graph workspace，新增）
      视图切换：DAG（既有画布迁入）/ 资产 / 攻击面 / 执行 / 记忆（本任务投影）
      跨图过滤键 + 节点下钻 + 「在其他图中查看」
全局
  └ Memory 页（P8）：全局记忆图 + 档案检索 + 工具遗产
既有 Assets / Goals / History / Evidence / Report / Logs 列表视图保留
```

渲染统一复用 `@xyflow/react` + dagre（既有依赖）；布局按图类型选（资产=层级、攻击面=二分、执行=泳道时序、记忆=DAG）；深色操作台风格不变。

## 六、分期提案

| 刀 | 内容 | 依赖 | 验收 |
| --- | --- | --- | --- |
| **G1** | 资产图 + 执行图（数据已有，纯投影）+ Graph workspace 骨架 | 无 | 投影单测：图节点/边与源数据一致、无独有状态；控制台 build 绿 |
| **G2** | 攻击面图（含降级覆盖视图） | P6 E3/E4 | 表面元素来自 parser 产物；verified 只认 verified finding |
| **G3** | 记忆图视图 | P8 M1/M2 | 与 memory-layer 验收合并 |
| **G4** | 跨图导航 + 图提示 | G1–G3 | 同 ID 跨图跳转可达；图提示只写 Hint（单测断言无 propose/assert） |

## 七、明确不做

1. 为图建第二套状态存储（投影必须可丢弃可重建）。
2. 图上直接编辑真相（拖拽改 Fact/Goal/授权）——写走既有 API。
3. 用图布局表达语义（位置/距离不代表可信度或优先级，徽章才是语义）。
4. 图提示直接派 Intent / 终止循环。
5. 把所有列表 Tab 强改成图（明细场景列表更高效）。
6. 攻击面图在 E3/E4 前用自由文本 Fact 硬解析（缺元数据不编造，降级覆盖视图）。
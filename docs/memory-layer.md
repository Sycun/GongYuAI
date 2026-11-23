# 记忆层：项目记忆 × 全局记忆（Memory Graph，P8 提案）

2026-11-22 调研定案起草；同日按用户定调重构：**记忆分项目记忆与全局记忆两级**。状态：**知识库首版后端已落地（2026-11-23），控制台已接入检索、范围选择与向量服务设置；全局经验图仍为提案**。

配套：[theory-fact-intent-dag.md](./theory-fact-intent-dag.md) · [architecture.md](./architecture.md) · [evidence-review.md](./evidence-review.md) · [absorb-sapper-v2-nuwa.md](./absorb-sapper-v2-nuwa.md)

同一委托跨会话靠 History、Relay、运行检查点和封存证据接续，这些能力已有实现。P8 处理的是另开一项委托后，如何找到以前的材料，并判断哪条经验值得再用。计划在本机分别保存只读档案索引和经复核的经验图。原件留在源任务，索引保留记录编号和摘要哈希。[实施台账](./implementation-ledger.md) · [两级记忆交互图](./design-atlas.html#memory)

<a id="knowledge-library"></a>

## 知识与经验的三类记录

控制台执行模型从[首版接入与验收设计](./knowledge-library-console.md)开始，按操作员入口验证导入、检索、报告引用、旧版回读和委托隔离。

控制台拟以「知识与经验」提供**参考资料**和**项目经验**两个栏目。任务详情单独保留 **History**。参考资料库首版后端已交付（持久化、控制面 API、报告引用与导出），控制台已接入范围选择、检索和索引状态，报告引用从任务侧密封快照回读；全局经验图仍为提案。[接口契约](./knowledge-library-api.md) · [后端验收记录](./evidence/knowledge-library/knowledge-1795404972071/acceptance-record.md) · [单文件导览演示](./design-atlas.html#memory/find)

| 去哪里查 | 一条记录能回答什么 | 怎样写入或更正 |
| --- | --- | --- |
| 知识库 · 参考资料 | 女娲作者怎样描述接班？SapperLens 在哪一节观察到负责人换班？ | 人员导入原文或有出处的摘录，保存发布者、材料类型、可见范围、版本和定位。修订产生新版本，历史引用保留。 |
| 全局记忆 · 项目经验 | 经本项目复核，哪些交接做法值得在下一项委托参考，适用条件和反例是什么？ | 从项目材料中选候选，起草、署名确认，再以建议带入。失效时追加反例或撤回意见。 |
| 任务 History · 本次证据 | R-017 的首次归属为什么是 B？签收为什么仍待补件？ | 任务内记录事实、证据版本和按目标作出的复核意见。报告可附文献引用说明方法，归属和签收仍由本次原件分别支持。 |

### 第一批资料怎样导入

首版由操作员选取有权保存的 Markdown、文本、可提取正文的 PDF，或粘贴网页摘录并附原始链接。预览时核对标题、发布者、来源类型、可见范围及章节、页码或段落。摘录标明「摘录」并保存原文定位，编辑者写的中文导读单独标明。仅登记链接或 PDF 尚无可检索正文时显示「待补正文」，不得显示成全文命中。

| 这次采集的材料 | 导入时标记 | 它能支持的说法 |
| --- | --- | --- |
| [女娲底座 README](https://github.com/N1nEmAn/nvwabase) | 上游作者说明，定位到三项能力中的 History | 作者怎样组织标题、摘要和证据，让下一位按需阅读。 |
| [SapperLens §6.4](https://github.com/inwpu/SapperLens#64-状态与连续性) | 独立运行分析，定位到「状态与连续性」 | 分析者从运行记录中追到了一次负责人换班。 |
| [本项目六批交接实验](./experiments/2026-11-22-ledger-relay/README.md#六批五次交接) | 本项目实验，定位到「六批、五次交接」 | 在这一批合成材料上，Relay 组答对 54/60 个字段、整份全对 7/12，完整对话组分别为 49/60 和 9/12。 |
| [DeepSeek 原型领域模型](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/main/docs/001-domain.md)、[DeepSeekAgent.io 指南](https://deepseekagent.io/guides/deepseek-super-agent-architecture)及 [MacOpenClaw 解读](https://macopenclaw.com/super-agent/super-agent-architecture/) | 原型文档、两篇二手解读，各自一条，关联到同一原型 | 原型给出工作项、派工和授权定义。两篇解读可分别引用，评估依据时按同一上游设计归类。 |
| [Anthropic 长程 Agent 文章](https://www.anthropic.com/research/effective-harnesses-for-long-running-agents)与[本项目 R-017 补证用例](./absorb-super-agent.md#报告交付后收到更正凭据) | 前者归为作者研究，后者归为本项目合成验收 | 前者供查阅新会话接手的方法，后者回答 GongYuAI 是否验证过按原任务和记录编号补证。 |

### 第一版如何检索、引用和验收

1. **导入定版。** 经选定的团队规范、报告模板、技术文章和脱敏案例均可入库，导入者明确选择团队共享或指定委托可见。同一范围、同一来源、同一内容重复导入，返回已有版本。正文变化后创建新版本，保留旧快照、导入时间和内容 SHA-256。发布者的版本或 Git 提交若已知，另行登记。本地导入版号单独显示。
2. **检索并读段落。** 先按当前读者和委托筛选可用资料，再按标题、标签和正文做全文检索。结果显示来源类型、版本、命中原因、段落定位和上下文。英文材料可加中文主题标签，例如「负责人换班」。仅标签命中时应如实显示。
3. **在任务或报告中引用。** 人员选中具体段落，保存资料 ID、导入版本、章节或页段、所用快照的 SHA-256，以及这条引用支持的表述。重新打开报告时按此引用回读。新版可另选，旧版被停用时保留历史提示。任务事实的复核仍按原有证据入口办理。

| 验收动作 | 可观察的通过条件 |
| --- | --- |
| 导入女娲作者说明、SapperLens、本项目实验，重放相同导入，再导入一份修订样本 | 三种来源可区分。重放无重复版本，修订有独立版本。缺正文的条目只显示元数据。 |
| 搜「负责人换班」并打开三种来源 | 读者能指出哪段是作者设计，哪段记录实际换班，哪份实验只覆盖六批合成材料。页面区分标题、标签和正文命中。 |
| 搜「更正回函」 | 可从原型定位到工作项定义，从本项目用例定位到 R-017 验收。两篇架构解读的共同上游可见，项目行为的依据指向本项目用例。 |
| 用旧版 SapperLens §6.4 的摘录生成引用，再导入新版、停用旧版并离线重开旧报告 | 有权的读者仍能按引用读回旧段落并复算原哈希；当前检索默认给有效版。原件不可读或校验失败时，报告明确提示无法复验。 |
| 在委托 A 导入专属材料，再以委托 B 的读者查询、打开直接引用及导出报告 | B 的搜索、摘要、计数与导出均不泄露 A 的材料。直接按 ID 读取也须检查权限。共享资料只有在相应可见范围内可读。 |

HTML 自带短导读样本，可离线讲解来源辨别和旧版引用。例如，引用 `SL · 本地 v1 · §6.4` 支持“独立分析观察到一次负责人换班”，导读文本的 SHA-256 以 `1a4355a2abca` 开头。点击模拟修订后，检索会给出 v2，示例报告仍可读回 v1 的文本和完整校验值。产品验收还要验证真实文件解析、持久化、报告导出及委托权限。离线交付时按导出者和收件范围打包允许交付的定版材料。

<a id="memory-origins"></a>

## 设计来源与本项目的取舍

| 来源 | 借鉴的机制 | GongYuAI 自己负责的设计 |
| --- | --- | --- |
| Cairn 与 Intentest | Cairn 用 Fact、Intent 与 Hint 在会话外记录事实、待办和建议。Intentest 明确判断所依赖的前提。 | DAG 保存本任务的依据。P8 拟为每条经验保存源任务、记录和证据版本，通过独立的 Hint 引用到新项目。原项目的撤回意见仍可回查。[Cairn 对照](./absorb-cairn.md) · [Intentest 与证据复核](./evidence-review.md#receipt-weeks) |
| 女娲底座 nvwabase 与 sapper-v2 | 女娲的 History 按标题、摘要和证据阅读，底座也提供对既往工作的召回。sapper-v2 展示了交接教训和工具的实践。SapperLens 从运行记录还原了负责人换班，Agientry 提供架构解读。 | 女娲层承担经验传承。P8 将档案指针与可复用经验分开，分别登记经验、方法、反例和工具。哪些条目可以带入另一项委托，由本项目的来源、适用条件与署名复核规则决定。[女娲底座说明](https://github.com/N1nEmAn/nvwabase#3-whats-inside) · [项目对照与交接记录](./absorb-sapper-v2-nuwa.md) |
| DeepSeek Super-agent 原型及其架构解读 | 后续来件可回到同一工作项，派工和授权分别记录，长材料可按引用取回。Hybrid AI Routers 提供了另行评估模型选择的依据。 | 报告交付后的更正归原任务，由原任务保存报告版本和证据。结项时是否从中提炼经验，另走 P8 的选择与复核流程。自动归属和分层模型的收益待测。[Super-agent 设计与合成用例](./absorb-super-agent.md) |
| CHAP、Resurface 与 Anthropic 的长程 Agent 研究 | CHAP 提供结构化交接参照，Resurface 提供关联证据读取参照。Anthropic 的三篇文章分别启发按需读取、接手先复核已知结果、从读者入口验收。 | 同任务交接可以用空白会话验证。跨项目复用要另外保留来源样本、反例与验证记录，单独评估经验是否适用。五次换班实验只覆盖前一类问题。[运行时来源对照](./architecture.md) · [长程材料与验收范围](./evidence-review.md#receipt-weeks) |

**从 R-017 到下一项委托。** 已有合成用例里，更正回函归到原任务，旧抄件 A 被撤回，经独立复核的首次归属是 B。引用 A 的汇总待复核，签收仍缺有效凭据。这些都是原委托的记录。[原任务验收](./absorb-super-agent.md#报告交付后收到更正凭据)

按 P8 提案，结项时可把“收件归属与签收应分别验收”列为候选。操作员选择后生成草稿，复核人核对原件与撤回记录并署名确认。下个项目收到的是这条核对建议及其来源，当期归属和签收要读当期凭据。使用后记录有效、无关或出现反例。候选清单、人工确认、匹配条件和反馈规则均由 GongYuAI 在 P8 定案。[总体设计决策记录](./MASTER-DESIGN.md) · [交互示例](./design-atlas.html#memory)

## 一、两级记忆架构

```text
全局记忆（用户级 · data-root · 平台整个使用生涯）
  ├─ 档案索引（冷）：所有任务历史的联邦指针——资产指纹/CWE/family → 哪些任务碰过、结论与复核
  ├─ 蒸馏图谱（热）：Lesson / Playbook / Counterexample / ToolArtifact …（本文 §三）
  ├─ 程序记忆演进：Skill 固化提案（人审写盘）+ 路由反馈
  └─ 操作者画像：复核署名习惯、覆盖判定口径、预算/并发偏好（settings 既有，纳入记忆视图）
        │  蒸馏 ↑↓ 注入（建议层）+ 反馈回写
        ▼
项目记忆（任务级 · 每任务一份 · 既有，不改）
  ├─ 情景记忆：History Fact–Intent DAG + Hint + Finding + 复核（黑板本体）
  ├─ 换班记忆：Relay πₙ
  ├─ 进程记忆：Durable checkpoint
  └─ 证据记忆：evidence/ + SHA-256 原版封存
```

### 现状盘点（调研证据）

| 记忆 | 现状 | 证据 |
| --- | --- | --- |
| 项目 · 情景（黑板） | ✅ 14 表全 `task_id` 作用域，分层可下钻 | history schema |
| 项目 · 换班 / 进程 / 证据 | ✅ | relay.ts / checkpoint.ts / goal-evidence |
| 全局 · 档案索引 | ❌ control.sqlite 只有任务记录 JSON，无跨任务检索 | data-root.ts |
| 全局 · 蒸馏图谱 | ❌ `technique_transfer` 仅任务内；无知识/教训表 | history listTransferableFacts(taskId) |
| 全局 · 程序演进 | ⚠️ 35 静态 Skill + 路由，人写不生长 | skills/runtime.ts |
| 全局 · 工具遗产 | ❌ 任务 workspace 自建脚本（sapper 的 auto_pivot.py 类）随任务归档沉睡，无登记无传承 | — |

## 二、繁衍闭环（文明怎么活起来）

```text
项目记忆 ──结项列候选──▶ 操作员选择 ──▶ 全局经验草稿（draft）
                          │ 人工复核 confirmed
                          ▼
新任务 Bootstrap ◀──结构化匹配注入（title 层 + Hint source=system）
        │
        └──终态反馈──▶ reuseCount / 反例 / 降级 ──▶ 图谱演进（supersedes）
                          │ 成熟打法
                          ▼
                 Skill 固化提案 / 工具遗产登记（永远人审）
```

- 每一环都有既有机制可复用：蒸馏原料 = verified finding / transferable Fact / 复核撤回 / 超时 partial Fact；注入 = Hint 通道 + skill 路由；复核 = evidence-review 语义；反馈 = 终态收卷钩子。
- **繁衍的是经验与工具，不是授权与证据**：新任务的 scope、Goal、证据闸全部从头成立。

## 三、全局记忆图模型

### 节点

| 节点 | 含义 | 关键字段 |
| --- | --- | --- |
| **Lesson** | 经验规则（「X 情境下做 Y，因为 Z」） | text、status `draft\|confirmed\|retracted`、matchKeys[]、reviewer、reuseCount |
| **Playbook** | 已验证打法（可复现步骤） | repro 引用、来源 verified finding / transferable Fact |
| **Counterexample** | 反例（误报/失效情境） | contradicts 指向 Lesson；来源复核撤回 / 新任务失败 Fact |
| **ToolArtifact** | 工具遗产（任务中自建的脚本/用法文档） | 源任务 workspace 路径指针 + sha256 + 使用文档 + 人审状态；**未审不得执行**（沿用「不自动执行未审脚本」军规） |
| **SourceRef** | 溯源锚点（**指针不是拷贝**） | taskId + factId/findingId/路径 + sha256；原件归源任务 |
| **MatchKey** | 分层适用条件 | **硬键**：familyKey / stack 指纹；**软键**：CWE / 资产类 / 手法类。硬键命中=正常注入；仅 ≥2 软键命中=低置信「参考」注入（M1 可只开硬键）。与 technique_transfer 同族启发式同源 |
| **SkillPack** | 固化载体 | 既有 skill id；记忆图只引用不复制正文 |

### 边与约束

- `derived_from` **强制非空**——**无源不记忆**（「无因探索禁令」的记忆层同构）。
- `contradicts` / `supersedes` 只追加不删除；被反驳/取代的节点保留可查。
- `applies_to` → MatchKey；`carried_by` → SkillPack / ToolArtifact。
- `injected_as` 是**事件**不是真相边（memoryId → taskId hintId + 匹配键 + 时间），供审计与反馈。
- 记忆图节点**永不**直接成为任务图 Fact；跨图只有溯源指针与注入事件。

### 档案索引（冷层，不是图节点）

- 联邦查询，不搬数据：按资产指纹 / CWE / familyKey / 时间检索**所有任务**的 Fact title、Finding、复核结论，命中返回指针（taskId + id + sha256），下钻走源任务既有 API。
- 用途：新任务 Bootstrap 回答「这个资产/这类漏洞以前碰过吗、结论是什么、被撤回过吗」；控制台跨任务检索页。
- 纪律：索引只读；档案的撤回/更正语义沿用源任务复核链，索引不制造第二结论。

### 创建时预检（已定案：自动、非阻塞「历史接触」面板）

- 靶标输入 debounce 自动查询只读入口（如 `GET /archive/contact?targets=…`）；命中任务列表（时间/终态/finding 数/撤回标记）以**可折叠面板**展示；查询超时降级「暂不可用」，**永不阻塞创建**。
- 每个命中两动作：查看源任务深潜；「带入为新任务参考」→ 创建请求 `seedHints[]`（`source=system`）——只写 Hint 建议层，不写 Fact、不代授权。
- 「带入」默认**不勾选**；仅当命中 finding 与本任务靶标**同资产**时默认勾选（强相关才预注入）。
- 权限与诚实：D4 E-schema 落地后按 engagement 隔离；历史接触≠本次授权（scope 闸与凭据复用判定照常）；**不生成风险评分**，过期 finding 标「可能已漂移」（D1 联动）。

## 四、生命周期（蒸馏 → 复核 → 注入 → 反馈）

1. **蒸馏**：终态自动生成**候选清单**（verified finding 摘要/撤回/超时 partial Fact——只列素材不写正文），操作员一键选择后生成 draft；也可随时 `gy memory distill <taskId>` 手动触发。工具遗产同路：登记 workspace 产物 + 使用文档 → 候选 → draft。自动产物永远 draft，draft 永不自动 confirmed。
2. **复核**：沿用 evidence-review 语义（confirmed/retracted + 署名理由 + 原件 SHA-256）；`draft` 不得注入、不得执行。
3. **注入**：新任务 Bootstrap 按分层 MatchKey 匹配，只注入 confirmed 的 **title 层**——默认上限 **N=5**（配置项）；Explore 阶段命中当前资产时最多**追加 2 条**；`memory_read` 按需下钻全文与反例；以 `source=system` Hint 落任务图。N 的取值以「注入 vs 不注入」差分验证后再调。档案索引命中作 Observe 参考段（「历史接触」），同样只是建议。
4. **反馈**：终态回写注入效果（复用成功/反例/无关），reuseCount 与反例追加；低效 Lesson 复盘降级；成熟 Playbook 产 Skill 固化提案（人审）。

## 五、控制台展现（记忆给用户看）

- **「知识与经验」入口**分为参考资料、项目经验。首版参考资料提供导入预览、检索和段落引用。项目经验规划以下视图：
  - 记忆图画布（复用 `@xyflow/react` + dagre，与 Fact–Intent DAG 同渲染纪律）；节点按类型着色 + status 徽章；
  - 跨任务检索（档案索引）：资产 / CWE / family → 任务列表与结论指针；
  - 工具遗产库：登记、人审状态、使用文档、源任务链接。
- **节点下钻**：Lesson → 全文 + 反例 + 溯源链（SourceRef → 源任务报告/证据，SHA-256 可复验）+ 注入历史与反馈统计。
- **任务深潜「记忆」Tab**：本任务注入了哪些 Lesson / 历史接触了哪些档案、蒸馏出了哪些候选——双向可查。
- **双层视图**（可选）：全局记忆图在上、当前任务 DAG 在下，溯源边跨层连线。
- 纪律不变：控制台只读投影；复核/登记走 API 写记忆库。

## 六、硬纪律（看到就停）

1. 旧任务 Fact 直接写进新任务图（授权/时效/范围都变了）。
2. 无溯源的经验/工具条目（孤儿知识）。
3. 向量 RAG / chat 记忆服务当匹配层。
4. 未经人审自动固化 Skill、自动执行 ToolArtifact。
5. 记忆注入绕过 Hint/建议层直接派 Intent。
6. 删除被反驳/被取代的节点（append-only）。
7. 把源任务证据**拷贝**进全局库（只存指针 + SHA-256）。
8. 凭据明文进全局记忆（E2 secretRef 纪律沿用；全局层只存打法不存秘密）。
9. 全局档案命中当授权依据（scope 闸照常，历史接触≠本次授权）。
10. 全局记忆出用户本机（data-root 本地存储；跨设备同步是另一个授权决策，非本提案）。

## 七、分期提案

| 刀 | 内容 | 验收 |
| --- | --- | --- |
| **知识库首版** ✅ 后端 | 人工导入与版本留存、范围内全文检索、按段落引用及旧版回读。可先于完整经验图独立交付。 | 按上文五组用例，从人员导入到旧报告复验，并检查跨委托隔离。**已跑通 40/40**（真实原文 + 真实进程 + HTTP，含断网重启回读）；该轮验收覆盖后端。后续控制台与真实云端切换另有[验收记录](./evidence/knowledge-library/siliconflow-acceptance.json)。[契约](./knowledge-library-api.md) · [记录](./evidence/knowledge-library/knowledge-1795404972071/acceptance-record.md) |
| **M1** | memory.sqlite（七类节点 + 复核 + injected_as 事件）；`gy memory distill/list/review`；Bootstrap MatchKey 注入 title + `memory_read` 下钻 | 单测：无溯源拒绝、draft 不注入、撤回保留；smoke 注入一条 confirmed Lesson 可见 Hint |
| **M2** | 只读档案索引、「知识与经验」的项目经验栏、记忆图画布、任务「记忆」Tab 及工具登记 | 跨任务检索命中返回指针可复验 SHA-256；画布只读；ToolArtifact 未审不可执行 |
| **M3** | 结项自动列候选，操作员选择后生成草稿。记录复用反馈，允许提交 Skill 固化提案。 | 草稿经署名确认后才可复用。使用相同材料和预算比较有无记忆的结果，再决定默认设置。 |

依赖：P6 E1（verified finding 是 Playbook 主要原料）；与 P7 无耦合。

## 八、明确不做

- 嵌入/RRF/语义坐标检索（与 theory §4、absorb-super-agent 一致）。
- 全局记忆当第二真相源（任务内权威仍是图）。
- 自动写 Skill 正文、自动执行遗产脚本、自动扩授权。
- 跨任务共享凭据明文；全局记忆默认出本机。
- 把 sapper「文明公理」叙事写进产品文案（机制吸收，叙事不进壳）。

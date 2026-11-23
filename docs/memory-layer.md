# 记忆层：项目记忆 × 全局记忆（Memory Graph，P8 提案）

2026-11-22 调研定案起草；同日按用户定调重构：**记忆分项目记忆与全局记忆两级**。状态：**提案，未动工**。  
配套：[theory-fact-intent-dag.md](./theory-fact-intent-dag.md) · [architecture.md](./architecture.md) · [evidence-review.md](./evidence-review.md) · [absorb-sapper-v2-nuwa.md](./absorb-sapper-v2-nuwa.md)

<a id="knowledge-library"></a>

## 知识与经验 · 参考资料

「参考资料」按来源、版本和段落保存文档。控制台可配置本地或云端向量服务，按委托检索并查看索引进度。报告引用从任务侧密封快照回读。项目经验的提炼和本次任务事实的复核分别沿用各自流程。[参考资料接口](./knowledge-library-api.md) · [控制台接入](./knowledge-library-console.md)

## 结论（先读这四句）

1. **项目记忆已有且硬**：每个任务过程中的记忆 = History 黑板（Fact–Intent DAG）+ Relay π + Durable checkpoint + evidence，四件齐全。**缺的是全局记忆**——用户整个平台使用生涯产生的沉淀，目前代码零落地。
2. **全局记忆 = 档案索引 + 蒸馏图谱**，不是只有经验条目：所有任务历史联邦可查（冷档案），蒸馏复核后的知识图谱可注入（热经验），外加工具遗产与技能演进。**女娲「文明繁衍」的缺口由这一层补**。
3. **记忆也是图，给用户展现**：项目图（每任务一份，管真相）之上叠全局记忆图（用户级一份，管经验）；控制台 Memory 页 + 双层画布 + 跨任务检索。两图靠溯源边连接，禁止孤儿知识。
4. **职责归属女娲层（繁衍），不是 DAG 层（真相）**：全局记忆注入只走建议层（Hint / Skill 路由），新任务 Intent 仍必须挂新任务自己的 Fact。推荐≠授权；不做 RAG，匹配用结构化键。

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

对照女娲：sapper 文明级记忆四件（教训手册、工具遗产写 fact 交接、知识库 63 条、绩效复盘固化）对应本层四个子层。**任务会换班，文明不繁衍**——P8 补的就是后半句。

## 二、繁衍闭环（文明怎么活起来）

```text
项目记忆 ──终态蒸馏──▶ 全局 · 蒸馏图谱（draft）
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

- **全局 Memory 页**（新增一级导航）：
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
| **M1** | memory.sqlite（七类节点 + 复核 + injected_as 事件）；`gy memory distill/list/review`；Bootstrap MatchKey 注入 title + `memory_read` 下钻 | 单测：无溯源拒绝、draft 不注入、撤回保留；smoke 注入一条 confirmed Lesson 可见 Hint |
| **M2** | 档案索引（联邦只读）+ 控制台 Memory 页 + 记忆图画布 + 任务「记忆」Tab + 工具遗产登记 | 跨任务检索命中返回指针可复验 SHA-256；画布只读；ToolArtifact 未审不可执行 |
| **M3** | 终态自动蒸馏 draft + 反馈回写 + Skill 固化提案 | draft 永不自动 confirmed；同预算差分（bare vs +memory）证明注入收益后才升默认 |

依赖：P6 E1（verified finding 是 Playbook 主要原料）；与 P7 无耦合。

## 八、明确不做

- 嵌入/RRF/语义坐标检索（与 theory §4、absorb-super-agent 一致）。
- 全局记忆当第二真相源（任务内权威仍是图）。
- 自动写 Skill 正文、自动执行遗产脚本、自动扩授权。
- 跨任务共享凭据明文；全局记忆默认出本机。
- 把 sapper「文明公理」叙事写进产品文案（机制吸收，叙事不进壳）。
# GongYuAI 的 Super-agent 设计与验收

调研日：2026-11-22。  
早期设计材料见以下三篇。新增的两份 DeepSeek 原型解读与混合路由论文列在下文。

- [基于对 Cairn 和 ARTEX 的分析所产生的一些思考](https://mp.weixin.qq.com/s/0AVOqclcynj4lXbEF3Y4wg)（正文题「关于 Cairn 和 ARTEX 的一些分析」）
- [用 Super-agent 的理念，拆解 Octop 团队模式](https://mp.weixin.qq.com/s/5r_EhRzdgRgzg8kWmZDyRQ)（Jubaoliang，Octop 负责人）
- [Super-agent 设计探索：迈向更自主的 Agent 系统](https://mp.weixin.qq.com/s/zoS7GlReWPhfCjENGxXCdg)（DeepSeek Harness 团队，Yujia Qiao 执笔）

另：[sapper-v2 开源公告](https://mp.weixin.qq.com/s/f4k0WAQN8G62NlN3usuMWA)仅诗 + 仓库链接，无架构内容；原理见 [absorb-sapper-v2-nuwa.md](./absorb-sapper-v2-nuwa.md)。  
总映射：[architecture.md](./architecture.md)；信仰层：[theory-fact-intent-dag.md](./theory-fact-intent-dag.md)；分期：[dev-handbook.md](./dev-handbook.md) P7。

## 结论（先读这四句）

1. **Super-agent 同时降低人工协调和计算开销。** 女娲的 lease、checkpoint 和 Relay 支撑接班，Fact–Intent DAG 与证据判据保存每个结论的依据。Super-agent 还要解决一个操作者能感知的问题：报告交付后，能否凭任务和记录编号补交材料，在原任务里取回修订结果？[报告交付后收到更正凭据](#报告交付后收到更正凭据)
2. **Octop 教训是本仓相位隔离的正面论据**：主 Agent 保留执行工具时，提示词无法保证分工（其 5 次测试 0 次委派）。本仓 `graph-phase.ts` 在 reason/bootstrap 相位**物理没收 shell/MCP**，比提示词分工硬一个量级——保持，勿回退。
3. **任务归属、工作类型和模型选择是三个决定。** 已带任务编号的复核意见可由程序投递。需要识别意图时，再判断用户要补材料、查询还是申请新工作。某一步是否适合轻量模型，要在同样材料和预算下实测。
4. **Watchdog 零策略军规不破**：DeepSeek 的「独立 Watchdog Session 用模型查偏航」吸收为**可选审计者**——产出只写 Hint（建议层），不派 Intent、不改 Goal、不保活。推荐≠授权。

## 本轮三篇文章的结论

| 阅读材料 | 作者讨论的问题 | 对 GongYuAI 的取舍 |
| --- | --- | --- |
| DeepSeekAgent.io 架构指南 | 持续接收事件的系统要区分消息归属与授权。公开原型用 Ticket 保存工作项，Assignment 表示一次派工，Mandate 限定范围。订阅线程可把后续消息送回原工单，消息本身不扩大权限。 | 报告复核沿用原任务、原授权版本和证据引用。一次会话结束后，操作员仍能回到同一项工作。[指南](https://deepseekagent.io/guides/deepseek-super-agent-architecture) · [原型领域模型](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/main/docs/001-domain.md) · [授权规则](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/main/docs/002-authorization.md) |
| MacOpenClaw 架构拆解 | 已订阅的事件可以直达原工作项，耗时工作的结果可稍后返回。近期信息留在上下文，长材料保存在外部，按引用逐层读回（Inline & Spill、链式召回）。文章还讨论了云端状态、本地执行和判断偏航的 Watchdog。 | 任务摘要应指回原件；换班时保留记录编号、证据版本和待复核项。这篇与上一篇解读同一项 DeepSeek 设计。团队说明公开原型经过改编，部分设计尚未实现。[文章](https://macopenclaw.com/super-agent/super-agent-architecture/) · [原型说明](https://github.com/deepseek-ai/dsh-superagent-prototype) |
| *Toward Super Agent System with Hybrid AI Routers* | 意图路由选择处理哪类工作，模型路由在质量、延迟和费用约束下选择模型。端云选择还受数据可外发范围和设备资源约束。作者把端到端基准列为后续研究。 | 论文给 P7 提供了实验假设。一次明确指向原任务的更正不需要模型猜测归属。若采用端云分流，先按材料允许的处理位置筛选，再比较可用模型。[论文 §3–§5](https://arxiv.org/html/2504.10519v2) |

## 早期设计参照

| 篇 | 要点 |
| --- | --- |
| Cairn×ARTEX 分析 | 四条改造路线：A*/MCTS 候选 Intent 前瞻排序、POMDP 形式化（观测历史≠信念状态）、事件溯源+CQRS（Intent 生命周期改不可变事件重建）、State–Intent 二原语压缩。核心转向「以信息为本质」：Fact 加语义坐标（来源/时间/主体/情境/关系），区域/关联/语境切片「点亮」候选；**点亮≠证实，原始观测≠解释判断**；证据缺口生成下一轮 Intent；多前提共同支持结论不能拆成独立支持边 |
| Octop 团队模式 | 主持人 Agent 只有查看成员/派单/检索记忆等轻量工具；专家 Agent 独立目录/模型/记忆/会话流；**分派即返回、后台并发、成果异步回填**；长材料截断归档、主持人只读节选摘要；任务线增量直达原 Worker。教训：主脑留执行工具→0/5 委派；敏感操作人工确认（最长等 30 分钟）；内存收件箱重启丢任务（已知短板） |
| DeepSeek 团队设计探索 | Router 负责沟通和派工，Worker 保留任务上下文；团队讨论了订阅直通、链式召回、异步执行和独立偏航审计。原设计报告的 p50/p95 为 12.4/15.7 分钟，单 Session 的 p95 为 29.5 分钟；直通节省 37% Router Token。这些数字对应其消息负载。公开原型对主会话另有工具和后台作业约定。[原型执行说明](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/main/docs/003-execution.md) |

## 吸收表

| 机制 | 本仓落点 | 状态 |
| --- | --- | --- |
| 任务内补证与复核 | 通过任务 ID 和 Fact ID 向原任务提交署名复核；终态收到意见后重出报告，发布前保留旧版字节。复核引用的附件按 SHA-256 留存。[复核接口](../packages/control-plane/src/server.ts) · [报告发布](../packages/history/src/report.ts) | **已有**。操作员明确指定任务，首次交付和修订结果均可核对 |
| 后续消息归属与授权分开 | 已知任务和记录编号时直接定位；消息缺少归属或引用冲突时，请提交者明确任务。外部来件作为待核材料，范围变更沿用专门的授权入口。[任务范围管理](../packages/control-plane/src/runner.ts) | **值得吸收**。已有显式任务入口；跨渠道订阅、自动匹配和消息重放去重属于后续设计 |
| 脑手分离（主脑无执行工具） | `graph-phase.ts` 相位工具面：reason/bootstrap 无 shell/MCP | **已有**，结构性硬闸，勿回退成提示词分工 |
| 分派即返回 / 异步回填 | 多 Explore CAS claim + stigmergy：图就是异步回填通道，无内存收件箱 | **已有**；Octop 重启丢任务反衬 durable checkpoint 价值 |
| 链式召回与交接 | 从标题、摘要下钻到证据，沿图读回前驱；Session Relay 传递接班摘要。报告凭原始材料、保存的版本和复核意见支持结论。[证据复核](./evidence-review.md) | **已有项目内对应机制**。交接时分别保留撤回意见编号和被撤回的记录编号，便于下一班核实 |
| 主持人只读节选摘要 | Observe 只注入 Goals + title 层 + open Intents | **已有** |
| 相位级模型路由与端云选择 | Pi 主模型目前取任务配置。P7 提议按相位选模型。端云放置是另一项选择，涉及材料处理位置。[Pi 模型配置](../packages/worker/src/pi-loop.ts) · [实施台账](./implementation-ledger.md) | **待实验**。相位路由仍是提案；端云自动切换没有本仓效果数据 |
| 事件两级过滤 | Observe 先代码过滤（新 Fact/open Intent/未吸收 Hint）再进 LLM | **P7 可选**；现 Observe 已部分覆盖 |
| 独立偏航审计 | 可选审计者会话：轻模型读图判「实质推进/逻辑死循环」，产出**只写 Hint** | **P7 可选**，非默认；保活看门狗保持纯脚本 |
| 指挥官自写交接接力自己 | slot 0 Reason/Report leader 的会话边界也走 π（sapper 同款） | **P7 待核对**：现 Relay 文档只写 Worker 边界 |
| 「点亮≠证实」/ 双图分离 | P6 E1 `tentative/verified` finding 状态 + 既有复核撤回语义 | 见 [pentest-enhancements.md](./pentest-enhancements.md)；不另建第二张图 |
| 多前提共同支持结论 | `sourceFactIds[]` 已支持多前驱；报告渲染保持「共同支持」语义 | **已有**，prompt 纪律即可 |
| `ask` 人工审批门 | 能力阶梯之上可选（Octop 人工确认同族） | 非本刀；8h 无人值守路线不默认开 |

### 哪些收益仍需实验

六份合成台账各重复两次，分六批交付。只用 DAG 时，模型答对 34/60 个字段、6/12 道整题，用了 90,316 Token；加入 Relay 后是 54/60、7/12 和 71,017 Token。保留完整对话的基线有 9/12 道整题全对。三组使用同一个模型，缓存命中情况也不同。这组数据能衡量固定换班条件下的交付质量与 Token 用量。模型路由收益和实际账单还需单独测量。[实验条件、逐题结果与缓存计量](./experiments/2026-11-22-ledger-relay/README.md)

| 待判断的问题 | 对照与读数 |
| --- | --- |
| 自动判断消息归属能否节省人工 | 用已标注的单任务、跨任务同号、缺编号和重复来件回放。以操作员明确指定任务为对照，分别记录错误归入、需澄清数、人工查找次数和完成一次更正的时间。 |
| 模型路由能否降低费用并保住质量 | 同一批离线材料、同一提示、同一预算，在固定模型与候选路由之间逐题配对。分别报整题正确、撤回对象错误、耗时及包含缓存计价的费用。沿用 P7 既定的重复次数与非劣界，缺少账单时仅报告用量。[P7 差分协议](./absorb-eval-methodology.md) |
| 模型审计者能否找出值得复核的结论 | 对同一批已标注报告，比较仅用现有规则与附加只读审计提示。记录遗漏的撤回影响、误报和人工复核时间。现有 Watchdog 继续负责租约与进程恢复。[Watchdog](../packages/control-plane/src/watchdog.ts) |

## 报告交付后收到更正凭据

**验收目的。** 报告已交付、原会话已结束。操作员次日仅凭任务编号和回函修订原报告。另一位读者拿到修订报告及其附件后，应能指出哪条判断被撤回、哪条已另行复核、哪个目标仍缺材料，并能查回首次交付版本。

**初始材料。** 使用离线合成台账 R-017。任务状态为 `incomplete`，目标为收件归属 `ownership` 与签收人 `signature`。已封存的收件原件在 `archive/receipt.json`，归属栏为 B。初核员依据抄录件把归属 A 登记为已复核，一份汇总沿用了 A。历史中另有尚待独立复核的候选记录 B。`signoff.json` 的 `signed` 为 `false`。保存首次交付的 `report.md`、附件和报告完整 SHA-256。下表的 A、B 指两条不同的 Fact，实际提交使用各自的 UUID。

| 步骤 | 操作 | 预期结果与核对依据 |
| --- | --- | --- |
| 1. 定位原任务 | 操作员收到注明任务 ID 和 R-017 的更正回函。通过 `GET /tasks/<id>/history` 核对目标和 A、B 的记录编号，用 `gy evidence <id> --path review/R-017.json --file 回函.json` 导入。 | 回函写明 R-017 归属 B，未提供签收人。记录任务 ID、授权版本和终态。用另一任务的 Fact ID 提交本次复核，接口应返回 400，原任务复核条数不变；单号相同不能替代任务归属。 |
| 2. 撤回 A 并重放来件 | 对 `ownership` 提交署名复核，填 A 的 `factId`、`decision=retracted`、B 的 `replacementFactId`、误读理由及回函的 `evidencePath`。通过 `POST /tasks/<id>/reviews` 或 `gy review <id> --file review.json` 连续提交两次，保持字段与附件字节相同。 | 两次返回同一 `review.id`，仅新增一条撤回意见。报告中 A 已撤回，B 显示为更正指向，尚无独立确认。连续重复提交由复核存储去重；跨渠道消息去重须另测。[复核字段示例](./evidence-review.md) |
| 3. 独立确认 B | 复核员核对收件原件与回函中的单号和归属，再为 B 单独提交 `decision=confirmed`、署名、理由和回函路径。 | 修订报告保留初核依据及撤回理由，B 显示已另行复核。只依赖 A 的下游汇总显示“依据已撤回，待复核”。签收目标仍为“未验证”，列出所缺的有效签收材料。 |
| 4. 核验报告和附件版本 | 将工作区收件路径的内容改成 C，读回当前报告及两个证据链接。用首次交付摘要定位任务目录下的 `reports/report-<摘要前12位>.md`。 | 归档报告的完整 SHA-256 与首交值相等；从修订报告的 `report-evidence/<sha256>` 分别读回原件 B 与更正回函，字节摘要与链接相符。任务仍为同一终态，授权版本和累计执行用量保持首交值。[报告归档与证据发布](../packages/history/src/report.ts) |
| 5. 由另一位读者验收 | 交给读者修订版 `report.md` 与同目录的 `report-evidence/`。请其标出当前归属、已撤回记录、受影响汇总和签收缺口，并指出各结论的原始依据。 | 四项答案依次为 B、A、沿用 A 的汇总待复核、缺有效签收。读者能从相对链接打开 R-017 原件和回函。误挂任务、重复入账、丢失首交版本、独立复核前确认 B，或将缺凭据的签收记为通过，任一项均判失败。 |

**交付边界。** 此例更正的是 Fact，终态复核会重新发布任务报告。项目另有编号交付更正，适用于曾支撑已通过目标的 Finding 被撤回，可记录受影响的目标、报告摘要和通知状态。本例预期编号更正列表为空。报告生成也不能证明收件人已经收到修订版；如需验收送达，应另留收悉凭据。[交付更正规则](../packages/history/src/index.ts) · [交付验收设计](./delivery-assurance-plan.md)

**复验记录（2026-11-22）。** 已用临时任务库和本机回环 HTTP 接口串联核对首交归档、异任务引用拒绝、重复提交、独立确认、下游标记、签收缺口和两份附件的摘要。固定回归可在仓库根目录运行 `pnpm review:offline`（2 个测试，含 3 项读者断言）及 `node --import tsx --test packages/control-plane/src/review-api.test.ts`（1 个接口测试）。本次为合成材料验收，读者答案由断言校对；独立人员盲读、真实渠道投递和实际收悉仍待验证。[离线读者用例](../packages/history/src/review-acceptance.test.ts) · [控制面用例](../packages/control-plane/src/review-api.test.ts)

## 明确不吸收

- A*/MCTS 候选 Intent 排序、五段同构检索——建议层加速器，无差分痛点不开（与 theory §4 一致）。
- 事件溯源 + CQRS 重写 Intent 生命周期——现 FSM + append-only events 已够审计，重写无收益。
- Fact 语义坐标 + 区域/语境切片 RAG——图邻域是结构化邻接，不是向量召回。
- Octop 式人工确认当默认闸（最长等 30 分钟与无人值守长跑冲突）。
- 内存收件箱 / 进程内派单队列当真相——跨会话权威只有图。
- 把 DeepSeek/sapper 的时延与 token 数字当本仓预期——成绩绑定其设定，验收用 `pnpm diff-harness` 同预算相对差分。
- 主脑重新拿回执行工具（「全能 Super-agent」）——Octop 0/5 委派教训 + 本仓反模式 7。

## 若再动手（P7 提案，非默认下一刀）

顺序与验收见 [dev-handbook.md](./dev-handbook.md) P7。最小集：

1. **相位级模型路由**：contracts `execution.models` 可选三键；缺省回退单模型。真 TSecBench 子集跑「强脑+快兵 vs 全强模型」同预算差分，报 token/成功率/墙钟三列。
2. **slot 0 指挥官 Relay 核对**：确认 Reason leader 长会话触发 π；若未覆盖，补相位边界触发，崩溃仍不写 π。
3. **偏航审计者（可选）**：独立轻模型会话，只读图 + worker-status，产出 `source=auditor` Hint；单测断言其无 propose/assert/shell 工具面。

差分未证明收益前，三项都不升默认。

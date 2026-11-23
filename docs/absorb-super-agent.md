# 吸收对照：Super-agent（DeepSeek / Octop / Cairn×ARTEX 分析）

调研日：2026-11-22。  
原文三篇：
- [基于对 Cairn 和 ARTEX 的分析所产生的一些思考](https://mp.weixin.qq.com/s/0AVOqclcynj4lXbEF3Y4wg)（正文题「关于 Cairn 和 ARTEX 的一些分析」）
- [用 Super-agent 的理念，拆解 Octop 团队模式](https://mp.weixin.qq.com/s/5r_EhRzdgRgzg8kWmZDyRQ)（Jubaoliang，Octop 负责人）
- [Super-agent 设计探索：迈向更自主的 Agent 系统](https://mp.weixin.qq.com/s/zoS7GlReWPhfCjENGxXCdg)（DeepSeek Harness 团队，Yujia Qiao 执笔）

另：[sapper-v2 开源公告](https://mp.weixin.qq.com/s/f4k0WAQN8G62NlN3usuMWA)仅诗 + 仓库链接，无架构内容；原理见 [absorb-sapper-v2-nuwa.md](./absorb-sapper-v2-nuwa.md)。  
总映射：[architecture.md](./architecture.md)；信仰层：[theory-fact-intent-dag.md](./theory-fact-intent-dag.md)；分期：[dev-handbook.md](./dev-handbook.md) P7。

## 结论（先读这四句）

1. **Super-agent 是调度经济层，不是新图**。三层基座分工：女娲管活下来（lease/Relay/分层史），DAG 管走得对（无因探索禁令/证据闸），Super-agent 管花得省（脑手分离/模型分层/异步派单）。前两层本仓已硬化；第三层是配置 + 小协议补丁，不是重写。
2. **Octop 教训是本仓相位隔离的正面论据**：主 Agent 保留执行工具时，提示词无法保证分工（其 5 次测试 0 次委派）。本仓 `graph-phase.ts` 在 reason/bootstrap 相位**物理没收 shell/MCP**，比提示词分工硬一个量级——保持，勿回退。
3. **模型分层要拆三层，不是两层**：派单/路由便宜（甚至纯代码）、战术推理强（Reason/Bootstrap/收卷）、执行验证快（Explore）。sapper 指挥贵/兵便宜与 DeepSeek Router 便宜/Worker 贵并不矛盾——拆的轴不同。经济性主张须过本仓同预算差分才算数。
4. **Watchdog 零策略军规不破**：DeepSeek 的「独立 Watchdog Session 用模型查偏航」吸收为**可选审计者**——产出只写 Hint（建议层），不派 Intent、不改 Goal、不保活。推荐≠授权。

## 三篇文章在说什么

| 篇 | 要点 |
| --- | --- |
| Cairn×ARTEX 分析 | 四条改造路线：A*/MCTS 候选 Intent 前瞻排序、POMDP 形式化（观测历史≠信念状态）、事件溯源+CQRS（Intent 生命周期改不可变事件重建）、State–Intent 二原语压缩。核心转向「以信息为本质」：Fact 加语义坐标（来源/时间/主体/情境/关系），区域/关联/语境切片「点亮」候选；**点亮≠证实，原始观测≠解释判断**；证据缺口生成下一轮 Intent；多前提共同支持结论不能拆成独立支持边 |
| Octop 团队模式 | 主持人 Agent 只有查看成员/派单/检索记忆等轻量工具；专家 Agent 独立目录/模型/记忆/会话流；**分派即返回、后台并发、成果异步回填**；长材料截断归档、主持人只读节选摘要；任务线增量直达原 Worker。教训：主脑留执行工具→0/5 委派；敏感操作人工确认（最长等 30 分钟）；内存收件箱重启丢任务（已知短板） |
| DeepSeek Super-agent | Router（轻模型、无 Bash、全局序点）+ Worker（强模型、上下文隔离）；事件两级过滤（代码 Fast Path + LLM Slow Path）；Thread 订阅直通；**Inline & Spill 把上下文当 Cache 管理**；**链式召回**（对象带 ID 构成引用图，按需逐跳展开）；异步 start()/stop() 全双工；存算分离 + 脑手分离；独立 Watchdog Session 用模型判断实质推进/偏航（进程监控抓不到逻辑死循环）。数字（其设定）：p50/p95 = 12.4/15.7 分钟 vs 单 Session p95 29.5；直通省 Router 37% token；批处理单决定推理 6.4s→1.6s |

## 吸收表

| 机制 | 本仓落点 | 状态 |
| --- | --- | --- |
| 脑手分离（主脑无执行工具） | `graph-phase.ts` 相位工具面：reason/bootstrap 无 shell/MCP | **已有**，结构性硬闸，勿回退成提示词分工 |
| 分派即返回 / 异步回填 | 多 Explore CAS claim + stigmergy：图就是异步回填通道，无内存收件箱 | **已有**；Octop 重启丢任务反衬 durable checkpoint 价值 |
| 链式召回 / Inline & Spill | title→summary→evidence 按需下钻 + 同 Intent 邻域（P5）；上下文当 Cache ≈ 会话内全量、边界压 π | **已有**；不做 chat/π 向量 RAG |
| 主持人只读节选摘要 | Observe 只注入 Goals + title 层 + open Intents | **已有** |
| 三层模型路由 | `execution.models: { reason, explore, bootstrap }`（提案）；slot 0 leader 强模型、Explore 快模型 | **P7 提案**，配置项非架构改动 |
| 事件两级过滤 | Observe 先代码过滤（新 Fact/open Intent/未吸收 Hint）再进 LLM | **P7 可选**；现 Observe 已部分覆盖 |
| 独立偏航审计 | 可选审计者会话：轻模型读图判「实质推进/逻辑死循环」，产出**只写 Hint** | **P7 可选**，非默认；保活看门狗保持纯脚本 |
| 指挥官自写交接接力自己 | slot 0 Reason/Report leader 的会话边界也走 π（sapper 同款） | **P7 待核对**：现 Relay 文档只写 Worker 边界 |
| 「点亮≠证实」/ 双图分离 | P6 E1 `tentative/verified` finding 状态 + 既有复核撤回语义 | 见 [pentest-enhancements.md](./pentest-enhancements.md)；不另建第二张图 |
| 多前提共同支持结论 | `sourceFactIds[]` 已支持多前驱；报告渲染保持「共同支持」语义 | **已有**，prompt 纪律即可 |
| `ask` 人工审批门 | 能力阶梯之上可选（Octop 人工确认同族） | 非本刀；8h 无人值守路线不默认开 |

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
# Cyber-Monster 与 GongYuAI 的长任务交接

2026-11-22 核对。GongYuAI 已经能在新会话按需读取技能，也能让复核人取回目标首次通过时封存的附件。本次把 Cyber-Monster 关于证据保全、正常样本和控制有效性的做法写进现有的 `evidence-first` 与 `reporting`。交付时，接手人应能指出哪份原件还支持旧结论，以及哪些样本足以验证检测建议。

## 文章与上游的对应关系

华盟网这篇文章介绍的是 W4L33Dx 的 Cyber-Monster。核对当天，`v1` 和 `main` 指向同一提交 `19fbce7`。按标签源码包的路径统计，共 4,732 个 Markdown 文件，其中红队 10 个家族、571 个子技能，蓝队 9 个家族、214 个子技能。上游用一个根入口组织文件，并提供家族索引和配套材料。该版本未发现许可证文件，本项目保留固定版本的出处链接，用项目自身的术语编写说明。上游列出的 Token 减少 26%、速度提升 40% 来自作者的对比，GongYuAI 未复测这项基准。[公众号原文](https://mp.weixin.qq.com/s/ivQv4q9z7BRmzUMcKn388A) · [上游固定版本](https://github.com/W4L33Dx/Cyber-Monster/tree/19fbce7b1c8e23b8737295430ab3c105268cd5fa) · [v1 发布页](https://github.com/W4L33Dx/Cyber-Monster/releases/tag/v1)

从目录到正文的分层读取是 Agent Skills 的既有约定。Anthropic 的跨会话编码实验还指出，每班都需要留下下一班能独立检查的产物。GongYuAI 可以用路由测试检查技能是否可发现，再让接手人根据留存材料作答，检查跨会话的判断能否成立。[Agent Skills 规范](https://agentskills.io/specification) · [Anthropic 长程 Agent 实验](https://www.anthropic.com/research/effective-harnesses-for-long-running-agents)

## 现有机制能证明什么

| 要回答的问题 | 当前实现与证据 | 仍需实测的部分 |
| --- | --- | --- |
| 中断后任务状态在哪里？ | Watchdog 管理租约和 Worker 生命周期，checkpoint 持久化循环状态。 | 这次核查了实现和现有回归。生产环境长时间中断后的恢复时长未测。 |
| 换班后还能找回旧材料吗？ | History 保留图与复核意见，报告指向带 SHA-256 的封存附件。离线用例覆盖同路径被覆盖、撤回原判断、旧任务缺少原版等情形。 | 材料可以取回，接手人仍可能误读撤回对象或适用目标。 |
| 引入新知识要占多少目录空间？ | 当前有 35 个内置技能，28 个有集中配置的路由项，其余可从包元数据读取触发词。Worker 按目录提示，用 `load_skill` 读取所选包的根正文。本次复用两个入口。 | 建议采用字符串匹配。口语改写可能没有命中；模型也可能自行从目录选择。 |

实现与验收入口见[长任务契约](./long-run-contract.md)、[证据复核](./evidence-review.md)、[实际 Skill 加载器](../packages/worker/src/skills/runtime.ts)和[目录发现](../packages/control-plane/src/catalog-discover.ts)。

复算项目既有六批实验的 36 条记录，结果如下。六份合成台账各重复两次，Relay 组每题换班五次。此实验早于本次技能改动。

| 历史表示方式 | 正确字段 | 整题全对 | 总 Token |
| --- | ---: | ---: | ---: |
| 保留完整对话（bare） | 49/60 | 9/12 | 80,787 |
| 完整对话加 DAG 祖先 | 34/60 | 6/12 | 90,316 |
| DAG 加 Relay 交接 | 54/60 | 7/12 | 71,017 |

Relay 相对 DAG 少用 19,299 Token，且 12 次都按要求交齐五个字段。仅看三组都交齐字段的五个相同题次，三个组分别答对 25/25、24/25 和 22/25。这个事后子集很小。逐次记录给出了两种具体错答。在 LEGACY 中，模型把发布撤回意见的记录填成了被撤回的记录。在 SCOPE 中，抄件的姓名栏已复核、数量栏已撤回，模型却两次都把沿用旧数量的汇总判为有效。新版技能据此要求分别指明原记录、意见适用的目标，以及依赖该记录的结论。[实验与错答分析](./experiments/2026-11-22-ledger-relay/README.md) · [逐次记录](./experiments/2026-11-22-ledger-relay/six-batch/trials.jsonl)

## 哪些上游做法进入了项目

蓝队的 214 个子技能中，本次从事件响应（25）、检测与监控（29）、紫队与安全项目（12）三个家族各核读一篇正文，分别对应原件、误报对照和覆盖结论。其余六个家族按目录盘点，包括工具开发（32）、数字取证（27）、应用安全（25）、漏洞与加固（23）、恶意软件分析（22）、威胁情报与狩猎（19）。本次交付覆盖下表三项，后六类只有目录级核对。[上游家族目录](https://github.com/W4L33Dx/Cyber-Monster/tree/19fbce7b1c8e23b8737295430ab3c105268cd5fa/blue-team)

| 核读的上游子技能 | 本项目落点 | 接手人应拿到的内容 |
| --- | --- | --- |
| [证据保全与交接](https://github.com/W4L33Dx/Cyber-Monster/tree/19fbce7b1c8e23b8737295430ab3c105268cd5fa/blue-team/incident-response/evidence-handling-and-chain-of-custody) | [evidence-first](../skills/builtin/evidence-first/SKILL.md) | 目标、封存版本、撤回意见和原记录。旧账只有通过记录时，保留历史状态，同时注明原版无法复验。 |
| [告警调优与误报分析](https://github.com/W4L33Dx/Cyber-Monster/tree/19fbce7b1c8e23b8737295430ab3c105268cd5fa/blue-team/detection-and-monitoring/alert-tuning-and-false-positive-reduction) | [reporting](../skills/builtin/reporting/SKILL.md) | 检测所需的日志和字段、应命中的样本、容易误报的正常样本，以及已有回放结果。 |
| [控制测试与审计证据](https://github.com/W4L33Dx/Cyber-Monster/tree/19fbce7b1c8e23b8737295430ab3c105268cd5fa/blue-team/purple-team-and-program/control-testing-and-audit-evidence) | 同一份蓝队交接 | 给结论标明样本、规则版本和时段。只有规则草稿时，交付状态为「建议，待验证」。 |

例如，归档中只有规则 v3 对一条已标注异常事件的命中记录。交接可写「v3 在该样本上命中；同时间段的正常批处理样本尚缺，误报情况待核」。如果该记录后来被撤回，接手人可以按对应目标和原记录回查哪些判断需要重新复核。这个示例说明报告措辞；自动生成的 `report.md` 仍按 History 中已有的数据渲染上述复核状态，检测建议由使用 `reporting` 的读者或 Agent 撰写。

## 本次验证与下一轮评测

在临时目录还原 `ee143ea` 的两个技能和路由，与本次工作区对比。两组均有 35 个内置包，使用空授权备注和同一组标题，调用实际的目录发现和建议排序入口，另核对新版按需加载的正文。8 条相关请求中，正确技能排第一从 **2/8 到 8/8**。“汇总上月工时”两版均未提示这两个技能。8 条里有 6 条含新增触发词，2 条覆盖原有的“证据”和“报告”。额外尝试“上个班次的说法后来改了，帮我核实一下”，两版都未给出提示。这个数字衡量固定请求的路由命中，模型选择与最终报告准确率还需要独立测量。[固定用例](../examples/offline-review/skill-routing.test.mjs)

在 `ee143ea` 加本次技能和用例的隔离副本中，contracts 与 history 构建通过，路由、证据复核、台账交接、Watchdog 和 Relay 共 8 项离线回归通过。以下命令可以重跑路由、封存证据与台账交接检查，并复算历史实验。

```sh
pnpm --filter @gongyuai/contracts build
pnpm --filter @gongyuai/history build
node --import tsx --test examples/offline-review/skill-routing.test.mjs examples/offline-review/ledger-handoff.test.mjs
pnpm review:offline
node --import tsx scripts/review-model.mjs score docs/experiments/2026-11-22-ledger-relay/six-batch/trials.jsonl
```

下一轮可用未参与编写技能的脱敏材料做配对盲评。两组使用相同模型、预算、批次与换班位置，仅替换这两个技能的版本。让接手人只看交付件，指出撤回对象、适用目标、可复验原版、已验证的检测范围及缺失对照。分别统计字段正确率、整份交付全对率、把待验建议写成已验证的次数，以及实际 Token。另记是否加载了技能，便于区分选错入口和读后判断错误。

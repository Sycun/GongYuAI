# 女娲、DAG 与证据复核

女娲的接班机制让一个人或一个会话离开后，后来者仍能理解先前的工作。Fact–Intent DAG 保存单次任务里的观察、判断依据和派生记录。两者都依赖共享历史，因此一次误判也可能一路传到报告。GongYuAI 在同一份 History 中追加复核意见，让读者能回答三个问题：当时看到了什么，后来纠正了什么，还有什么缺材料。

## 哪些判断可以继承

Fact 保留最初的文字和来源。标题、摘要、证据三个层级决定怎么阅读材料。可信程度由另行记录的复核意见表达。每次复核注明任务内的 Fact、目标、复核人、时间、理由和证据版本。原判断与更正都能被引用。撤回旧判断不会自动确认新判断，新判断有自己的复核记录。

同一目标下，每条 Fact 采用最后一次复核意见，报告也保留先前意见。若另一个判断沿 DAG 引用了已经撤回的前驱，报告将其列为“依据已撤回，待复核”。读者可以检查受影响的后续结论；有独立复核的后续记录按自己的复核意见列示。不同目标的复核互相独立。复核人为单用户操作员填写的署名。

将一次任务中的经验写成下一版通用规则时，应随规则保留原始样本、已知反例和验证记录。接班、引入新规则和评价规则收益分别回答不同的问题。架构仍沿用现有的 Watchdog、共享 DAG 和 Session Relay。

## 如何给目标定义内容判据

以下目标要求收件凭据的归属栏指向 B。`field` 表示 JSON 顶层字段，按值和类型精确比较。每条规则至少要命中一个提交的文件，所有命中文件都须满足该规则。

```json
{
  "id": "ownership",
  "title": "核对收件归属",
  "description": "原始 R-017 收件凭据应指向资产 B。",
  "evidencePatterns": ["archive/receipt.json"],
  "evidenceChecks": [
    { "pattern": "archive/receipt.json", "field": "asset", "equals": "B" }
  ]
}
```

普通目标检查非空文件和路径模式。重要结论可像上例增加内容判据；材料的真实性仍需结合来源复核。首次通过时，系统将判据实际读取的字节、SHA-256、路径及其与目标的关联一起提交到 SQLite。同一份内容在任务数据库里只存一份。修改工作文件不会改变已存版本。旧任务若只有“通过”和路径，报告保留历史结果，并标记“原版证据未留存”。

## 操作入口与报告

在任务的 `evidence/` 中准备人工复核依据，通过 `GET /tasks/<taskId>/history` 查出原 Fact 和更正 Fact 的 ID。将以下字段写入本地 `review.json`，换成实际 ID 和署名后执行 `gy review <taskId> --file review.json`。同一接口也接受 `POST /tasks/<taskId>/reviews`。

```json
{
  "goalId": "ownership",
  "factId": "<原 Fact 的 UUID>",
  "decision": "retracted",
  "replacementFactId": "<更正 Fact 的 UUID>",
  "reviewer": "复核人姓名",
  "reason": "收件凭据上的资产编号为 B，原记录误读为 A。",
  "evidencePath": "archive/receipt.json"
}
```

确认一条记录时使用 `confirmed`，省略 `replacementFactId`。完全相同的重复提交复用上一条意见。终态任务收到意见后重新生成报告。每个目标列出判据、首次通过的材料、当前复核结论和撤回意见。未通过的目标列出缺少的材料。没有关联到已复核结论的历史记录留在附录。

与他人离线复核时，将 `report.md` 和同目录下的 `report-evidence/` 一起交付。报告链接使用相对路径，文件名就是原始字节的 SHA-256。控制面也在 `GET /tasks/<taskId>/report-evidence/<sha256>` 提供同一版本。报告和快照包含原始材料，交付范围沿用该任务的证据访问约定。

## 长任务预算

操作员从终态重新开始时，本轮墙钟重新计时，原四项预算保留。Token、工具调用和安装继续计入任务累计用量；已到达的累计上限会阻止此次重启。若旧状态文件中的用量高于恢复后的检查点，控制面将差额从本轮可用额度中扣除。任务详情 `GET /tasks/<taskId>` 返回 `task.usage`（累计）和 `task.runUsage`（从本轮开始的增量）。首次运行从零计。旧任务缺少历史轮次边界时，不能追溯拆分更早的轮次。

## 离线验收

运行 `pnpm review:offline`。用例创建临时 SQLite 库和虚构台账，写入收件凭据 R-017，再写入足够多的标题和摘要，让早期记录离开近期概览。随后撤回错误归属、复核更正、覆盖原路径并重新打开数据库。读者断言只读取生成的报告及其链接附件。

| 读者要回答的问题 | 用例的标准答案 | 判定依据 |
| --- | --- | --- |
| 最初的凭据说了什么 | 收件凭据是 R-017，归属 B | 从报告链接读取原字节并校验 SHA-256；工作副本此时已改为 C |
| 哪条结论被推翻 | 归属 A 已撤回，B 已独立复核 | 同一目标同时显示撤回、更正和受影响的下游台账 |
| 哪个目标仍缺材料 | 签收人未验证 | 虽有签收文件，`signed: false` 未满足判据，报告列出缺项 |

2026-11-22 离线验收结果为 **3/3**。另有回归覆盖旧断言缺少快照以及非文本附件。需要保留本次输出时，运行 `GY_REVIEW_OUTPUT=/path/to/output pnpm review:offline`，测试会打印新报告路径。

TSecBench 快捷差分的 mock 组使用相同的合成材料和计数口径，能检查对照开关是否生效。`history` 组关闭自动和主动 Relay，`relay` 组记录实际交接次数。目标通过数、交接文件数、Token 和工具调用用于解释组间差异。本次 mock 对照中，三组均通过 2/2 个合成目标，各计 2 次合成调用，交接文件数依次为 0、0、1。mock 未测量 Token 消耗。

上述 3/3 衡量读者从离线材料恢复结论的能力；模型成功率、DAG 的独立收益和跨任务经验的泛化需要各自的对照实验。[论文表 3 与实验边界](./theory-fact-intent-dag.md#7-实验在支撑哪句理论)

同一类台账的真模型实验已完成。六份材料各重复两次，bare、DAG、DAG + Relay 三组分别答对 59、60、57 个字段（满分 60）。[实测用量、错答分析与逐次记录](./experiments/2026-11-22-offline-review/README.md)

交接现在分开记录撤回意见与撤回对象、历史状态与原版可复验性。[两批回归与六批对照](./experiments/2026-11-22-ledger-relay/README.md)列出了五次换班后的逐题结果，以及可交付字段得分与内容判断之间的差异。

## 生产交付验收

控制台新任务由操作员填写授权依据和排除范围。每条自然语言目标分别留存一份材料。文件验收、内容判据、人工覆盖和事实撤回各有独立记录。

在目标页选择“记录覆盖”，填写署名和理由。已测与部分覆盖需要指定证据相对路径。提交时封存原件，重复提交相同意见复用原记录。未测与受阻允许没有文件。未填报时覆盖为未知。当前为单用户署名。HTTP 入口为 `POST /tasks/<id>/coverage`，字段为 `goalId`、`status`、`reviewer`、`reason` 和可选的 `evidencePath`。

报告页同时显示当前交付核对和留存的报告。交付核对可通过 `GET /tasks/<id>/delivery` 读取。旧任务没有报告时，`GET /tasks/<id>/report` 返回标明缺失的交接摘要。读取摘要保留旧库和旧文件。现场文件清单以及未验证目标可帮助人工交接。用量来自平台计数，计费以供应商账单为准。

离线回归使用 `pnpm --filter @gongyuai/control-plane test`。正式准入另选一份可脱敏、已人工结项的委托，保留范围变更和作业时间顺序，封存人工结论。中断时由另一名负责人根据交付物判断覆盖、受阻项和证据。终态对照人工结论分别记录漏报、误报和成本偏差。合成回归与这项盲评分别记录。

### 在交接时封存并独立复核覆盖

`gy coverage-snapshot` 在一个只读事务里读取每个目标的最新人工覆盖，按 SHA-256 核验库里留存的原件。快照只写目标 ID、覆盖状态、证据核验结果、摘要和捕获时间。没有人工记录的目标记为 `unknown`。交接时和终态可以各保存一份，命令拒绝覆盖同名文件。

另一位复核人用脱敏材料独立填写 JSON 底稿。在查看平台的覆盖判断前，将底稿及其 SHA-256 分开保存在任务工作区之外。以下示例核对一项已测目标和一项受阻目标。真实使用时替换任务 ID 和目标 ID。

```json
{
  "version": 1,
  "taskId": "90ae45d3-6406-4860-a494-395dcdac3007",
  "split": "development",
  "goals": [
    { "goalId": "inventory", "status": "tested" },
    { "goalId": "approval", "status": "blocked" }
  ]
}
```

`split` 取 `development`（调试）或 `holdout`（独立留出）。正式盲评需由复核人控制底稿访问；该字段记录分组约定。每项可指定 `evidenceSha256`，用于核对平台引用的原件与人工指定的版本。省略它时，只核验证据完整性；材料能否支持业务结论仍由复核人判断。

用实际任务 ID 和数据根目录设置 `TASK_ID`、`GY_DATA_DIR`，用两次封存时分别留存的摘要设置 `SNAPSHOT_SHA256`、`REFERENCE_SHA256`。

```sh
pnpm --silent gy coverage-snapshot "$TASK_ID" --data-dir "$GY_DATA_DIR" --out handoff.json
pnpm --silent gy coverage-compare handoff.json reference.json \
  --snapshot-sha256 "$SNAPSHOT_SHA256" --reference-sha256 "$REFERENCE_SHA256"
```

对照结果包含两个输入文件的摘要、样本分组、底稿目标数、状态相符数、逐项验收数和整项是否相符。明细区分覆盖夸大、低报、受阻与未测混淆、未知、缺项及底稿外目标。即使所有状态一致，所需原件缺失、内容摘要不符或引用版本错误，整项也无法通过。退出码 0 表示整项相符，2 表示成功比对并发现差异，1 表示输入或运行错误。该结果衡量覆盖登记与底稿的一致性；漏洞发现、严重性与预算应分别评测。

开发集与正式测试集分组借鉴 NYU CTF Bench，逐项目标和整项任务两种读数借鉴 Cybench。GongYuAI 使用自己的覆盖记录和封存证据评分。[TSecBench 资源目录](https://tsecbench.zc.tencent.com/resources) · [NYU CTF Bench 数据集划分](https://github.com/NYU-LLM-CTF/NYU_CTF_Bench#benchmark-structure) · [Cybench 论文](https://arxiv.org/abs/2408.08926)

# 第九轮验收记录：r9-flywheel

- 运行 ID：`r9-flywheel-1795364131957`
- 任务 ID：`95d4681d-e0f5-44f0-9bce-49df66cf434f`
- 数据根：`/private/tmp/gy-clean-r9f/.gongyuai/acceptance/r9-flywheel-1795364131957`
- 代码：`e93c159ad8b3c8de467ba39051ddb6fe7d9b4e66`（dirty=false）
- 时间：2026-11-22T16:15:31.957Z → 2026-11-22T16:15:33.452Z
- 步骤：57/57 通过，0 失败

## 步骤（命令 / 输入 / 预期 / 实际）

| # | 步骤 | 预期 | 实际 | 结果 |
| --- | --- | --- | --- | --- |
| 1 | 两个客户建档（同名资产） | [201,201] | [201,201] | PASS |
| 2 | A 的 finding 与证据落库（作为记忆溯源） | 证据 SHA | true | PASS |
| 3 | 记忆草稿：201 且状态 draft | [201,"draft"] | [201,"draft"] | PASS |
| 4 | 无源不记忆：空 provenance 被拒 400 | 400 | 400 | PASS |
| 5 | 草稿阶段：客户 B 看不到客户 A 的记忆节点 | 0 | 0 | PASS |
| 6 | draft 不可注入（0 条） | 0 | 0 | PASS |
| 7 | 人工确认：draft→confirmed | ["confirmed","op-a"] | ["confirmed","op-a"] | PASS |
| 8 | 分层匹配：硬键命中注入 1 条 | [1,"bootstrap"] | [1,"bootstrap"] | PASS |
| 9 | 注入只写 Hint（source=system），不当事实 | Hint 含 memory 标签 | true | PASS |
| 10 | 记忆引用可回查：列出引用过它的任务 | ["95d4681d-e0f5-44f0-9bce-49df66cf434f"] | ["95d4681d-e0f5-44f0-9bce-49df66cf434f"] | PASS |
| 11 | 客户 B：注入命中 0 条 | 0 | 0 | PASS |
| 12 | 客户 B：Hint 里没有 A 的专属标记 | false | false | PASS |
| 13 | 客户 B：历史接触不含客户 A 的任务 | false | false | PASS |
| 14 | 客户 B：历史接触命中自己的同名资产任务 | true | true | PASS |
| 15 | 客户 A：历史接触命中自己的任务并带 finding 计数 | 1 | 1 | PASS |
| 16 | 客户 B：模拟模型请求不含 A 的标记 | false | false | PASS |
| 17 | 模拟模型请求：声明 simulated + 无账单 | ["simulated","none"] | ["simulated","none"] | PASS |
| 18 | 反例节点：201 且指向被反驳的经验 | [201,"d09e04c1-4e02-487b-bb20-592d30de6a00"] | [201,"d09e04c1-4e02-487b-bb20-592d30de6a00"] | PASS |
| 19 | 记忆图：contradicts 边可见 | 含 contradicts 边 | true | PASS |
| 20 | 取代：新节点取代旧经验，旧节点标 superseded | "d09e04c1-4e02-487b-bb20-592d30de6a00" | "d09e04c1-4e02-487b-bb20-592d30de6a00" | PASS |
| 21 | 被取代节点仍可回查引用（append-only） | true | true | PASS |
| 22 | 撤回经验：节点保留且状态 retracted | ["retracted","op-b"] | ["retracted","op-b"] | PASS |
| 23 | 撤回后不再注入被撤回节点（原节点已被取代） | 0 | 0 | PASS |
| 24 | 撤回/取代后仍能列出引用过的任务 | ["95d4681d-e0f5-44f0-9bce-49df66cf434f"] | ["95d4681d-e0f5-44f0-9bce-49df66cf434f"] | PASS |
| 25 | 冻结评测：201 且记录 seed | [201,"seed-1"] | [201,"seed-1"] | PASS |
| 26 | Finding 级指标：误报 1 / 漏项 1 / 待裁决 1 分母单列 | [1,1,1,3] | [1,1,1,3] | PASS |
| 27 | Finding 级指标：precision/recall 只按已裁决样本算 | [0.5,0.5] | [0.5,0.5] | PASS |
| 28 | 组间隔离：第二组声明隔离后 201 | 201 | 201 | PASS |
| 29 | 交换组顺序的反例：缺隔离声明被拒 400 | 400 | 400 | PASS |
| 30 | 正确隔离下回跑同组：幂等返回同一评测 | "197cce1f-dcb7-4b43-8bd1-1dcbfd041277" | "197cce1f-dcb7-4b43-8bd1-1dcbfd041277" | PASS |
| 31 | 乱序新增组被拒 400 | 400 | 400 | PASS |
| 32 | 冻结用例被替换 → 400（不能拿先跑组的答案改题） | 400 | 400 | PASS |
| 33 | 无证据不提案：被拒 400 | 400 | 400 | PASS |
| 34 | 提案：201 且 draft | [201,"draft"] | [201,"draft"] | PASS |
| 35 | 未批准不可晋升：400 | 400 | 400 | PASS |
| 36 | 晋升必须有真实评测：404/400 | true | true | PASS |
| 37 | 晋升成功：status=promoted + 记录评测 | ["promoted","197cce1f-dcb7-4b43-8bd1-1dcbfd041277"] | ["promoted","197cce1f-dcb7-4b43-8bd1-1dcbfd041277"] | PASS |
| 38 | 回退：status=rolled-back，保留晋升时间与所用户评测 | ["rolled-back",true,"197cce1f-dcb7-4b43-8bd1-1dcbfd041277"] | ["rolled-back",true,"197cce1f-dcb7-4b43-8bd1-1dcbfd041277"] | PASS |
| 39 | 回退可复算：事件链 created→approved→promoted→rolled-back | ["created","approved","promoted","rolled-back"] | ["created","approved","promoted","rolled-back"] | PASS |
| 40 | 趋势：按批次列出 A 的目标与 finding 计数 | 含 taskA | true | PASS |
| 41 | 规划者作业：202 入队 | 202 | 202 | PASS |
| 42 | 规划者产出：有依据的提案（含 unknown 覆盖） | true | true | PASS |
| 43 | 角色输出标记 simulated + 无账单 | ["simulated","none"] | ["simulated","none"] | PASS |
| 44 | 复核者意见：支持/需补证据/反证缺失分别表达 | [true,true,true] | [true,true,true] | PASS |
| 45 | 辅助者：按既有权限请求暂停（非终态） | [true,true] | [true,true] | PASS |
| 46 | 辅助者：任务进入 paused，恢复留给操作员 | "paused" | "paused" | PASS |
| 47 | 操作员恢复：paused→运行态 | true | true | PASS |
| 48 | 429：退避重试，不切换 | ["retry",true] | ["retry",true] | PASS |
| 49 | 无账单时成本不可见（不把 Token 降低写成省钱） | false | false | PASS |
| 50 | 余额不足：切到获准的备用供应商 | ["failover","primary-fallback",true] | ["failover","primary-fallback",true] | PASS |
| 51 | 费用可见性：有 usage 计费时 costVisible=true | true | true | PASS |
| 52 | 故障恢复后的重复记账被识别（同一键第二次） | true | true | PASS |
| 53 | 外发受限：不得切换供应商，只能阻塞等人 | ["blocked",null] | ["blocked",null] | PASS |
| 54 | 超时且备用未获准：blocked | "blocked" | "blocked" | PASS |
| 55 | 无进展告警：连续工具调用无新事实 → alarm | [true,true] | [true,true] | PASS |
| 56 | 等待人工答复期间不报无进展 | [false,true] | [false,true] | PASS |
| 57 | 记录落盘 | acceptance-record.json | /private/tmp/gy-clean-r9f/docs/evidence/r9/r9-flywheel-1795364131957/acceptance-record.json | PASS |

## 汇总

```json
{
  "taskA": "95d4681d-e0f5-44f0-9bce-49df66cf434f",
  "taskB": "7cce6ac5-79f6-4aec-b9b8-d5690c035465",
  "memoryId": "d09e04c1-4e02-487b-bb20-592d30de6a00",
  "findingId": "97f3e9c8-c33e-4d44-a187-00a0e28bbb13",
  "evaluations": {
    "group1": "197cce1f-dcb7-4b43-8bd1-1dcbfd041277",
    "group2": "c601e2a1-8f21-471b-b2ee-f65f35c113a8"
  },
  "proposalId": "2aa8d8f2-7ef4-4658-97b5-c936863b1664",
  "scorecard": {
    "taskId": "95d4681d-e0f5-44f0-9bce-49df66cf434f",
    "capturedAt": "2026-11-22T16:15:33.410Z",
    "snapshotSha256": "fdbe24c8cc6eb044a5653b958c84fe6178f8f3711c88d4cf4a458080fa2939e3",
    "denominator": 1,
    "totalGoals": 1,
    "applicable": true,
    "historicallyPassed": 0,
    "currentlySupported": 0,
    "unknownAttribution": 0,
    "retractedReferences": 0,
    "coverage": {
      "untested": 0,
      "partial": 0,
      "tested": 0,
      "blocked": 0,
      "unregistered": 1
    },
    "findings": {
      "verified": 1,
      "tentative": 0,
      "retracted": 0,
      "other": 0
    },
    "goals": [
      {
        "goalId": "g-a",
        "title": "A 目标",
        "historicalPass": false,
        "currentSupported": false,
        "verdict": "not-passed",
        "proofCount": 0,
        "supportFindingIds": [],
        "retractedSupportFindingIds": [],
        "coverage": "unregistered",
        "missingAttribution": false
      }
    ]
  }
}
```

## 说明

- 角色规划/复核为确定性模拟适配器；真实供应商表现单列「待验证」，未用于任何收益结论。

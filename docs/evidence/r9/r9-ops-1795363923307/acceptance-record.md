# 第九轮验收记录：r9-ops

- 运行 ID：`r9-ops-1795363923307`
- 任务 ID：`d9f05da1-bab6-468b-af17-e84c933ddcae`
- 数据根：`/private/tmp/gy-clean-r9/.gongyuai/acceptance/r9-ops-1795363923307`
- 代码：`d6d32ae60974c366a6d70cf2506c1110a40d2025`（dirty=false）
- 时间：2026-11-22T16:12:03.306Z → 2026-11-22T16:12:09.766Z
- 步骤：67/67 通过，0 失败

## 步骤（命令 / 输入 / 预期 / 实际）

| # | 步骤 | 预期 | 实际 | 结果 |
| --- | --- | --- | --- | --- |
| 1 | A 建档：显式客户/委托 + 业务核算目标 | 201 | 201 | PASS |
| 2 | 材料导入：两份清单 accepted | ["accepted","accepted"] | ["accepted","accepted"] | PASS |
| 3 | 材料导入：原件 SHA-256 落台账 | ["d7bc7d6eee81592ece9dbbb486e6de2817dd9e5c6ce12c377e4c418a8ce5093c","e2ff471b94a255a8aea203e91ca0e300b27b75626deaa66bec65336b31fe0ac5"] | ["d7bc7d6eee81592ece9dbbb486e6de2817dd9e5c6ce12c377e4c418a8ce5093c","e2ff471b94a255a8aea203e91ca0e300b27b75626deaa66bec65336b31fe0ac5"] | PASS |
| 4 | 作业提交：202 + queued | [202,"queued"] | [202,"queued"] | PASS |
| 5 | 作业执行中：状态为 running 或已完成（记录中断前现场） | running | running | PASS |
| 6 | 服务被强制中断（SIGKILL） | 进程消失 | killed | PASS |
| 7 | 重启对账：上一代 running 作业标 unknown（不假装成功） | "unknown" | "unknown" | PASS |
| 8 | 重启对账：pauseState=unknown，状态三态可分 | "unknown" | "unknown" | PASS |
| 9 | CLI 接手：gy jobs 读到 unknown | 输出含 unknown | true | PASS |
| 10 | CLI 接管：job-retry 接受 | 0 | 0 | PASS |
| 11 | 重试后作业成功 | "succeeded" | "succeeded" | PASS |
| 12 | 作业产物：核算结果带 SHA-256 | true | true | PASS |
| 13 | 完成回流：业务目标首次通过 | true | true | PASS |
| 14 | 完成回流：GET /tasks 目标 passes=true | true | true | PASS |
| 15 | 产物哈希与落盘字节一致 | "95617d8bfac37977fed30a2717360952e1cae3ea756a0f9e474bf9cc49cdcfb8" | "95617d8bfac37977fed30a2717360952e1cae3ea756a0f9e474bf9cc49cdcfb8" | PASS |
| 16 | 范围收缩：scopeVersion 单调 +1 | 2 | 2 | PASS |
| 17 | 迟到结果：完成时范围已前移 → lateResult=true | true | true | PASS |
| 18 | 迟到结果：保留提交时的范围版本 | 1 | 1 | PASS |
| 19 | 范围收缩：job 完成事件进台账 | lateResult 标记 | true | PASS |
| 20 | 回执幂等：首次 duplicate=false | false | false | PASS |
| 21 | 回执幂等：重复投递 duplicate=true | true | true | PASS |
| 22 | 回执幂等：只留一条回执 | 1 | 1 | PASS |
| 23 | 人工求助：默认 24h 到期 | "2026-11-23T16:12:09.273Z" | "2026-11-23T16:12:09.273Z" | PASS |
| 24 | 24h 前半段：仍阻塞（released=0） | 0 | 0 | PASS |
| 25 | 24h 到期：只解除阻塞（released=1） | 1 | 1 | PASS |
| 26 | 24h 到期：问题仍 open，status 不变 | ["open",false] | ["open",false] | PASS |
| 27 | 交接包：范围版本为 v2 | 2 | 2 | PASS |
| 28 | 交接包：已完成目标含 g-diff | true | true | PASS |
| 29 | 交接包：待答问题保留（已转非阻塞仍需答复） | [1,false] | [1,false] | PASS |
| 30 | 交接包：下一责任人 | "op-b" | "op-b" | PASS |
| 31 | 交接包：列出后台作业（含迟到标记） | 含 lateResult 作业 | true | PASS |
| 32 | 另一位操作员从 CLI 答复 | 0 | 0 | PASS |
| 33 | 答复落库：status=answered + answeredBy | ["answered","op-b"] | ["answered","op-b"] | PASS |
| 34 | 答复以 human Hint 回注 | Hint 含 consult 标签 | true | PASS |
| 35 | 材料语义：配置核查/HTTP 事务/人工复测均 accepted | ["accepted","accepted","accepted"] | ["accepted","accepted","accepted"] | PASS |
| 36 | 材料语义：格式不支持 → unsupported（不静默转已验证） | ["unsupported",null] | ["unsupported",null] | PASS |
| 37 | 材料语义：归属不明 → unknown-owner | "unknown-owner" | "unknown-owner" | PASS |
| 38 | 材料语义：材料过期 → expired | "expired" | "expired" | PASS |
| 39 | 凭据材料：明文被拒（要求受控引用） | 422 | 422 | PASS |
| 40 | 凭据材料：受控引用 accepted + sensitivity | ["accepted","controlled-ref"] | ["accepted","controlled-ref"] | PASS |
| 41 | 凭据材料：落盘只有指针与摘要，无明文 | false | false | PASS |
| 42 | finding 播种：三条已证实现场 | 证据哈希一致 | true | PASS |
| 43 | 人工覆盖登记：201 | 201 | 201 | PASS |
| 44 | 矩阵（撤回前）：CWE-89 verified | "verified" | "verified" | PASS |
| 45 | 矩阵（撤回前）：CWE-79 verified | "verified" | "verified" | PASS |
| 46 | 矩阵（撤回前）：人工覆盖 AUTHZ-BOLA manual | "manual" | "manual" | PASS |
| 47 | 证据撤回：DELETE 成功 | 200 | 200 | PASS |
| 48 | 撤回后：CWE-89 仍有独立依据 → verified | ["verified",false] | ["verified",false] | PASS |
| 49 | 撤回后：CWE-79 唯一依据被撤回 → retracted | ["retracted",true] | ["retracted",true] | PASS |
| 50 | 撤回后：人工覆盖不受影响 | "manual" | "manual" | PASS |
| 51 | 图 API：CWE-79 覆盖边标 broken + 依据已撤回 | broken=true, label 含 retracted | true | PASS |
| 52 | 图 API：CWE-89 覆盖边仍为 verified 且不 broken | [true,false] | [true,false] | PASS |
| 53 | 终态留档：stop 成功 | 200 | 200 | PASS |
| 54 | 报告：新增「证据撤回影响」段 | 含撤回段 | true | PASS |
| 55 | 报告：受影响项区分「仍有独立依据」与「唯一依据已撤回」 | 两类都在 | true | PASS |
| 56 | 报告：CWE-79 结论被点名 | 含该 finding 标题 | true | PASS |
| 57 | 事实时效：可控时钟 40 天后出现待复核（原事实保留） | needsReview>0 | true | PASS |
| 58 | 事实时效：不改写/不删除原事实 | GET /history 200 | true | PASS |
| 59 | 反例建档：客户 B 同名资产 | 201 | 201 | PASS |
| 60 | 同名资产不串客户：两张资产图节点 ID 交集为空 | [] | [] | PASS |
| 61 | 同名资产不串客户：A 图节点带 eng-a | 含 eng-a | true | PASS |
| 62 | 同名资产不串客户：B 图节点带 eng-b | 含 eng-b | true | PASS |
| 63 | 越界读：带别的委托查询被拒 403 | 403 | 403 | PASS |
| 64 | 越界读：租户不匹配被拒 403 | 403 | 403 | PASS |
| 65 | 交付快照：内容封印存在 | true | true | PASS |
| 66 | 记分卡：与快照同源 | "fb662a9df1a5ea09453367774a2124ed007a0b56122293b618cff57dd97c765b" | "fb662a9df1a5ea09453367774a2124ed007a0b56122293b618cff57dd97c765b" | PASS |
| 67 | 记录与清单落盘（含逐文件 SHA-256） | 写入验收记录 | /private/tmp/gy-clean-r9/docs/evidence/r9/r9-ops-1795363923307/acceptance-record.json | PASS |

## 汇总

```json
{
  "taskA": "d9f05da1-bab6-468b-af17-e84c933ddcae",
  "taskB": "3681cff6-a5a2-49b5-b279-7fd63db77539",
  "job1": "87674cb2-c163-413e-b97a-b756ce024563",
  "job2": "4bb39dca-175d-4fa2-8c97-71bc3584e44b",
  "consultId": "d4b2944a-5c8d-4044-b5b1-28ead6811ec7",
  "findings": {
    "sqlLogin": "586a6a68-0da0-414f-9e56-5b527651bda1",
    "sqlSearch": "ffff8d9a-7695-4ef0-b424-c26954f875c8",
    "xss": "2f9ef53d-6c7e-40df-b1b9-09e85fb00555"
  },
  "scorecard": {
    "taskId": "d9f05da1-bab6-468b-af17-e84c933ddcae",
    "capturedAt": "2026-11-22T16:12:09.706Z",
    "snapshotSha256": "fb662a9df1a5ea09453367774a2124ed007a0b56122293b618cff57dd97c765b",
    "denominator": 1,
    "totalGoals": 1,
    "applicable": true,
    "historicallyPassed": 1,
    "currentlySupported": 1,
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
      "verified": 3,
      "tentative": 0,
      "retracted": 0,
      "other": 0
    },
    "goals": [
      {
        "goalId": "g-diff",
        "title": "两份清单差异核算",
        "historicalPass": true,
        "currentSupported": true,
        "verdict": "supported",
        "proofCount": 1,
        "supportFindingIds": [],
        "retractedSupportFindingIds": [],
        "coverage": "unregistered",
        "missingAttribution": false
      }
    ]
  },
  "materials": {
    "baselineSha": "d7bc7d6eee81592ece9dbbb486e6de2817dd9e5c6ce12c377e4c418a8ce5093c",
    "currentSha": "e2ff471b94a255a8aea203e91ca0e300b27b75626deaa66bec65336b31fe0ac5"
  },
  "serverPort": 19622
}
```

## 说明

- finding 由验收脚本按 worker 同一 History 写入路径播种（recordFinding + verifyFinding，证据落 evidence/ 并封存 SHA-256）；本场景验证后端投影与撤回语义，不验证 worker 自动发现。

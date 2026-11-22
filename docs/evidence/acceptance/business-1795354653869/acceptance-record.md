# 业务验收记录 — 从原始材料算差异

> 输入只有业务字段（两份资产清单 + 两份配置基线），通过 `POST /tasks/:id/evidence` 导入；
> 核算走 `POST /tasks/:id/reconcile`。预期差异由验收端预先封存，平台实现读不到。
> 材料是虚构的：本次通过只代表工程可认定，真实生产效果另行验收。

运行　business-1795354653869
任务　fa3a8d43-c007-49a0-b6bc-a57f42baa90a
委托　原始资产清单与配置基线差异核算（业务验收）
代码提交　d7c46d4956246ba448b565136683daf155af1c62
数据目录　/Users/sycpro/GongYuAI/.gongyuai/acceptance/business-1795354653869
完成时间　2026-11-22T13:37:34.795Z
校验清单　acceptance-manifest.json
封存预期　expected.json · SHA-256 9175379b936394c5e2b293b32bdc56556c83f8758d2b951e8d17f222c65eebe7

| 步骤 | 结果 | 证据 |
| --- | --- | --- |
| 0 封存哈希 | 通过 | expected.json 9175379b9363… |
| 0 封存哈希 | 通过 | baseline.csv 921a58126267… |
| 0 封存哈希 | 通过 | current.csv 1b5848c77599… |
| 0 封存哈希 | 通过 | current-mutated.csv cafbfeb1fd2e… |
| 0 封存哈希 | 通过 | config-baseline.json dffe7c3faabd… |
| 0 封存哈希 | 通过 | config-current.json 685bba707d6a… |
| 0 预期差异已封存 | 通过 | expected.json 9175379b9363…（平台看不到这一份） |
| 1 建档 | 通过 | POST /tasks → 201 |
| 1 委托标识 | 通过 | engagementId=fa3a8d43-c007-49a0-b6bc-a57f42baa90a |
| 1 暂停模拟 Worker | 通过 | status=paused |
| 2 导入原始材料 | 通过 | assets/baseline.csv ← baseline.csv（126 字节） |
| 2 导入原始材料 | 通过 | assets/current.csv ← current.csv（127 字节） |
| 3 差异核算 | 通过 | POST /reconcile → 201 |
| 3 逐项比对（原始输入） | 通过 | 全部一致 |
| 3 结果落成证据 | 通过 | reconcile/asset-diff-20261122133734.json · d82cb9303ffe… |
| 2 导入原始材料 | 通过 | assets/current-v2.csv ← current-mutated.csv（127 字节） |
| 4 单值变更核算 | 通过 | POST /reconcile → 201 |
| 4 逐项比对（改一个值） | 通过 | 全部一致 |
| 4 对应差异确实变化 | 通过 | app-a-2: unchanged → changed（[{"field":"version","before":"2.1","after":"2.2"}]） |
| 2 导入原始材料 | 通过 | config/baseline.json ← config-baseline.json（181 字节） |
| 2 导入原始材料 | 通过 | config/current.json ← config-current.json（200 字节） |
| 5 配置基线核算 | 通过 | POST /reconcile → 201 |
| 5 逐项比对（配置基线） | 通过 | 全部一致 |
| 5 恢复运行 | 通过 | status=initializing |
| 5 目标由核算结果满足 | 通过 | status=completed |
| 5 两个目标均通过 | 通过 | asset-baseline-diff=true、config-baseline-diff=true |
| 6 删除前材料存在 | 通过 | /Users/sycpro/GongYuAI/.gongyuai/acceptance/business-1795354653869/tasks/fa3a8d43-c007-49a0-b6bc-a57f42baa90a/evidence/assets/baseline.csv |
| 6 移除必要材料 | 通过 | assets/baseline.csv 已从 evidence/ 删除 |
| 6 缺件核算 | 通过 | POST /reconcile → 201 |
| 6 逐项比对（移除材料） | 通过 | 全部一致 |
| 6 缺件不是猜结论 | 通过 | unknown=5/5，changed=0 |
| 7 快照可复算 | 通过 | seal valid |
| 7 四次核算都留了凭据 | 通过 | 4 条 reconcile Fact |
| 7 记分卡历史分子 | 通过 | 2/2 |

## 逐项比对

| 用例 | 未命中项 |
| --- | --- |
| asset-diff（原始输入） | 无 |
| asset-diff-mutated（改一个值） | 无 |
| config-diff（配置基线） | 无 |
| asset-diff-missing（移除材料） | 无 |

记分卡：曾通过 2/2；当前证据足以支持 2/2；人工覆盖 未登记 2

快照内容封印　fcdc2dce438883ec5565bc9982fae9afc2aabfb74f7f4c3476fc4dfc83efb63a（文件字节哈希见清单）

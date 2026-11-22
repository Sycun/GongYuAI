# 业务验收记录 — 从原始材料算差异

> 输入只有业务字段（两份资产清单 + 两份配置基线），通过 `POST /tasks/:id/evidence` 导入；
> 核算走 `POST /tasks/:id/reconcile`。预期差异由验收端预先封存，平台实现读不到。
> 材料是虚构的：本次通过只代表工程可认定，真实生产效果另行验收。

运行　business-1795356691440
任务　c5b04fa7-d6c0-4d75-9b00-97a2cd12a7b4
委托　原始资产清单与配置基线差异核算（业务验收）
代码提交　f34cc032cd9c4061a9212758595b34cf8d5fc2e0
数据目录　/private/tmp/gy-clean-f34cc03/repo/.gongyuai/acceptance/business-1795356691440
完成时间　2026-11-22T14:11:33.020Z
校验清单　acceptance-manifest.json
封存预期　expected.json · SHA-256 da009a89f129f58a0af77742986403cd63ddf7feead6c1f6fd76e349cef2ce51

## 缺件 → 补交 → 首次通过

1. 只交当前清单：核算 missingMaterials=["assets/baseline.csv"]，unknown=5/5；任务 status=incomplete；当前支持 0/3。
2. 拒绝原因（事件台账）：核算条件未满足：reconcile/gated-missing-20261122141131.json：缺少基线材料 assets/baseline.csv；未知项 5 项 > 允许 0 项（本次核算没有得出结论）
3. 补交基线后重新核算：reconcile/gated-diff-20261122141132.json · SHA-256 1820cb5ec03860ec83f6643854c8884d4c1ed05d0009acbbf235b2c983552762
4. 首次通过采用的核算文件与上面这一份相同：true；首次通过依据 1 条（重复提交不重复记账）。

| 步骤 | 结果 | 证据 |
| --- | --- | --- |
| 0 封存哈希 | 通过 | expected.json da009a89f129… |
| 0 封存哈希 | 通过 | baseline-quoted.csv dd53de23a07c… |
| 0 封存哈希 | 通过 | baseline-dup-same.csv 0ec08175fdd0… |
| 0 封存哈希 | 通过 | baseline-dup.csv 985c924ec9ff… |
| 0 封存哈希 | 通过 | baseline-line3.csv 5b7834963f75… |
| 0 封存哈希 | 通过 | baseline.csv 921a58126267… |
| 0 封存哈希 | 通过 | config-baseline.json dffe7c3faabd… |
| 0 封存哈希 | 通过 | config-current.json 685bba707d6a… |
| 0 封存哈希 | 通过 | current-dup-same.csv 9733052b1292… |
| 0 封存哈希 | 通过 | current-dup.csv 948e6cd32692… |
| 0 封存哈希 | 通过 | current-line3.csv 45034e6c830d… |
| 0 封存哈希 | 通过 | current-mutated.csv cafbfeb1fd2e… |
| 0 封存哈希 | 通过 | current-quoted.csv 1331a081bba2… |
| 0 封存哈希 | 通过 | current.csv 1b5848c77599… |
| 0 预期差异已封存 | 通过 | expected.json da009a89f129…（平台看不到这一份） |
| 1 建档 | 通过 | POST /tasks → 201 |
| 1 委托标识 | 通过 | engagementId=c5b04fa7-d6c0-4d75-9b00-97a2cd12a7b4 |
| 1 暂停模拟 Worker | 通过 | status=paused |
| 2 导入原始材料 | 通过 | assets/current.csv ← current.csv（127 字节） |
| 3 缺基线核算被接受 | 通过 | POST /reconcile → 201 |
| 3 缺件结论逐项正确 | 通过 | 全部一致（unknown 5/5） |
| 3 任务恢复 | 通过 | status=initializing |
| 3 缺件运行没有判通过 | 通过 | 任务 status=incomplete（缺件只交一侧时不得 completed） |
| 3 该目标保持未通过 | 通过 | gated-both-lists passes=false |
| 3 未通过原因点名缺件材料 | 通过 | 核算条件未满足：reconcile/gated-missing-20261122141131.json：缺少基线材料 assets/baseline.csv；未知项 5 项 > 允许 0 项（本次核算没有得出结论） |
| 3 缺件阶段没有首次通过依据 | 通过 | goalProofs=0 |
| 3 记分卡当前支持为 0 | 通过 | 历史 0/3 · 当前 0/3 |
| 3 报告写出缺件与未通过 | 通过 | 报告含缺件原因，且没有首次通过核算文件 |
| 2 导入原始材料 | 通过 | assets/baseline.csv ← baseline.csv（126 字节） |
| 4 补交后差异核算 | 通过 | POST /reconcile → 201 |
| 4 逐项比对（原始输入） | 通过 | 全部一致 |
| 4 结果落成证据 | 通过 | reconcile/asset-diff-20261122141132.json · 9afde21f4662… |
| 4 合格核算（两份齐全） | 通过 | POST /reconcile → 201 |
| 4 合格核算两侧材料都有封存哈希 | 通过 | baseline 921a58126267… · current 1b5848c77599… |
| 2 导入原始材料 | 通过 | assets/current-v2.csv ← current-mutated.csv（127 字节） |
| 5 单值变更核算 | 通过 | POST /reconcile → 201 |
| 5 逐项比对（改一个值） | 通过 | 全部一致 |
| 5 对应差异确实变化 | 通过 | app-a-2: unchanged → changed（[{"field":"version","before":"2.1","after":"2.2"}]） |
| 2 导入原始材料 | 通过 | config/baseline.json ← config-baseline.json（181 字节） |
| 2 导入原始材料 | 通过 | config/current.json ← config-current.json（200 字节） |
| 6 配置基线核算 | 通过 | POST /reconcile → 201 |
| 6 逐项比对（配置基线） | 通过 | 全部一致 |
| 2 导入原始材料 | 通过 | assets/baseline-line3.csv ← baseline-line3.csv（50 字节） |
| 2 导入原始材料 | 通过 | assets/current-line3.csv ← current-line3.csv（50 字节） |
| 7 行号核算 | 通过 | POST /reconcile → 201 |
| 7 原文件第 3 行的变化报第 3 行 | 通过 | 全部一致 |
| 7 行号读数 | 通过 | app-a-1 基线第 3 行 / 当前第 3 行 |
| 2 导入原始材料 | 通过 | assets/baseline-dup.csv ← baseline-dup.csv（40 字节） |
| 2 导入原始材料 | 通过 | assets/current-dup.csv ← current-dup.csv（31 字节） |
| 8 重复主键核算 | 通过 | POST /reconcile → 201 |
| 8 冲突重复主键标为歧义而非未变 | 通过 | 全部一致 |
| 8 冲突项列出全部来源行 | 通过 | test-A ambiguous；出处 ["baseline:2","baseline:3"] |
| 2 导入原始材料 | 通过 | assets/baseline-dup-same.csv ← baseline-dup-same.csv（40 字节） |
| 2 导入原始材料 | 通过 | assets/current-dup-same.csv ← current-dup-same.csv（31 字节） |
| 9 相同重复行核算 | 通过 | POST /reconcile → 201 |
| 9 内容相同的重复行收敛为一行 | 通过 | 全部一致 |
| 2 导入原始材料 | 通过 | assets/baseline-quoted.csv ← baseline-quoted.csv（71 字节） |
| 2 导入原始材料 | 通过 | assets/current-quoted.csv ← current-quoted.csv（71 字节） |
| 10 CRLF+引号内逗号核算 | 通过 | POST /reconcile → 201 |
| 10 CRLF 与引号内逗号不影响行号与字段 | 通过 | 全部一致 |
| 11 补交后从正常入口重新判定 | 通过 | POST /resume → 200 status=initializing |
| 11 目标由核算结果满足 | 通过 | status=completed |
| 11 三个目标均通过 | 通过 | asset-baseline-diff=true、config-baseline-diff=true、gated-both-lists=true |
| 11 首次通过只指向一份核算文件 | 通过 | ["reconcile/gated-diff-20261122141132.json 1820cb5ec038…"] |
| 11 首次通过事件指向实际采用的核算文件 | 通过 | reconcile/gated-diff-20261122141132.json · 1820cb5ec038… |
| 11 采用的核算文件哈希与生成时一致 | 通过 | 生成时 1820cb5ec038… / 首次通过 1820cb5ec038… |
| 11 重复提交不重复记账 | 通过 | goal_asserted 只有一条 |
| 12 快照可复算 | 通过 | seal valid |
| 12 记分卡历史分子与当前支持 | 通过 | 历史 3/3 · 当前 3/3 |
| 12 报告引用采用的核算文件与哈希 | 通过 | reconcile/gated-diff-20261122141132.json · 1820cb5ec038… |
| 13 删除前材料存在 | 通过 | /private/tmp/gy-clean-f34cc03/repo/.gongyuai/acceptance/business-1795356691440/tasks/c5b04fa7-d6c0-4d75-9b00-97a2cd12a7b4/evidence/assets/baseline.csv |
| 13 移除必要材料 | 通过 | assets/baseline.csv 已从 evidence/ 删除 |
| 13 缺件核算 | 通过 | POST /reconcile → 201 |
| 13 逐项比对（移除材料） | 通过 | 全部一致 |
| 13 缺件不是猜结论 | 通过 | unknown=5/5，changed=0 |
| 13 历史通过记录保留 | 通过 | gated-both-lists passes=true（材料缺失不改写历史通过） |
| 14 每次核算都留了凭据 | 通过 | 10 条 reconcile Fact |

## 逐项比对

| 用例 | 未命中项 |
| --- | --- |
| gated-missing（只交一侧） | 无 |
| asset-diff（原始输入） | 无 |
| asset-diff-mutated（改一个值） | 无 |
| config-diff（配置基线） | 无 |
| line3-diff（空行占行号） | 无 |
| dup-diff（重复主键冲突） | 无 |
| dup-same-diff（重复行内容相同） | 无 |
| quoted-diff（CRLF + 引号内逗号） | 无 |
| asset-diff-missing（移除材料） | 无 |

记分卡：曾通过 3/3；当前证据足以支持 3/3；人工覆盖 未登记 3

快照内容封印　0b03c12f9f083d19fcae12f4bb3774dcc02cabfc4bc9dcb086ad0bcd0b026fab（文件字节哈希见清单）

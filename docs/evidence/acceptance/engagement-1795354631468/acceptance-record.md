# 普通 API 的模拟跨日流程 — 验收记录

> 本记录来自 mock worker：材料由模拟 Worker 按目标判据生成，用来验证建档、暂停、
> 恢复、交接、撤回、更正与覆盖登记这些流程语义。业务核算能力另见
> `scripts/business-acceptance.ts` 的原始材料差异验收。

运行　engagement-1795354631468
任务　d1d780b6-28ac-41a9-ba9a-5c75f43fe51d
委托　甲乙双系统资产与配置基线评估及整改复核
代码提交　d7c46d4956246ba448b565136683daf155af1c62
数据目录　/Users/sycpro/GongYuAI/.gongyuai/acceptance/engagement-1795354631468
完成时间　2026-11-22T13:37:23.056Z
授权版本　v2
校验清单　acceptance-manifest.json（记录/快照/两种哈希/运行 ID/任务 ID/代码提交）

| 步骤 | 结果 | 证据 |
| --- | --- | --- |
| 阶段1 建档 | 通过 | POST /tasks → 201 |
| 阶段1 授权版本 | 通过 | v1 |
| 阶段1 启动 | 通过 | 创建即进入运行：status=initializing |
| 阶段1 导入清单 | 通过 | inventory/sys-a.csv → 201 |
| 阶段1 导入清单 | 通过 | inventory/sys-b.csv → 201 |
| 阶段2 中断 | 通过 | 控制面关闭；worker 为 detached 进程继续运行 |
| 阶段2 恢复后读取任务 | 通过 | status=running |
| 阶段1 首日运行中交接 | 通过 | status=running |
| 阶段1 首日缺件 | 通过 | 3/4 目标已过（应 3/4：整改材料待补）；engagement-summary=true、remediation-a=false、sys-a-baseline=true、sys-b-diff=true |
| 阶段3 甲专项通过 | 通过 | 有本资产已验证发现 |
| 阶段3 覆盖型目标通过 | 通过 | 零发现可交付 |
| 阶段1 缺件保持未验证 | 通过 | 整改材料首日未齐 |
| 阶段3 汇总目标通过 | 通过 | 显式 task 范围 |
| 阶段2 无重复记账 | 通过 | [["sys-b-diff",1],["sys-a-baseline",1],["engagement-summary",1]] |
| 阶段2 事实只增不减 | 通过 | 8 → 8 |
| 阶段3 技术确认 | 通过 | verified=1 |
| 阶段3 线索保留 | 通过 | tentative=1 |
| 阶段3 记分卡历史分子 | 通过 | 3/4 |
| 阶段3 记分卡当前分子 | 通过 | 3/4 |
| 阶段2 暂停确认 | 通过 | status=paused |
| 阶段2 暂停后无存活 worker | 通过 | workerPids=[] |
| 阶段2 检查点保留 | 通过 | durable.sqlite 留存 |
| 阶段2 范围更新 | 通过 | scopeVersion=2 |
| 阶段2 授权版本递增 | 通过 | v2 |
| 阶段2 新范围生效 | 通过 | a.example.com |
| 阶段2 次日补交材料 | 通过 | remediation/sys-a/fix.json |
| 阶段2 次日补交材料 | 通过 | remediation/retest.txt |
| 阶段2 次日补交材料 | 通过 | findings/lead-proof.txt |
| 阶段2 次日补交材料 | 通过 | client/decision.md |
| 阶段2 恢复运行 | 通过 | status=initializing |
| 阶段1 跨日完成 | 通过 | status=completed |
| 阶段2 恢复读取最新授权 | 通过 | a.example.com |
| 阶段2 版本保持 | 通过 | v2 |
| 阶段2 跨日无重复通过 | 通过 | [["remediation-a",1],["sys-b-diff",1],["sys-a-baseline",1],["engagement-summary",1]] |
| 阶段2 范围修订入图 | 通过 | facts=1 |
| 阶段5 整改复测 | 通过 | retested |
| 阶段5 技术确认线索 | 通过 | verified |
| 阶段5 客户发起复测申请 | 通过 | 201 {"request":{"requester":"客户安全负责人","role":"客户方","findingIds":["3dcb1fa1-8587-40cf-88cb-9e93b8c4167b"],"reason":"整改窗口已到，请复测该越权结论","evidencePath":"client/decision.md","id":"274fc601-61d3-4abb-bf78-40e56a240285","status":"pending","createdAt":"2026-11-22T13:37:22.939Z","sha256":"8f4b28c9533f57ab20572c13 |
| 阶段5 申请依据留存哈希 | 通过 | 8f4b28c9533f |
| 阶段5 按申请复测 | 通过 | retested |
| 阶段5 申请转为已完成 | 通过 | [{"id":"274fc601-61d3-4abb-bf78-40e56a240285","requester":"客户安全负责人","role":"客户方","findingIds":["3dcb1fa1-8587-40cf-88cb-9e93b8c4167b"],"reason":"整改窗口已到，请复测该越权结论","evidencePath":"client/decision.md","sha256":"8f4b28c9533f57ab20572c13e81ff9f62e89c6819b0725ce2bc1f046bdeee3e9","status":"fulfilled","fulfilledAt":"2026-11-22T13:37:22.945Z","fulfilledResult":"partially-fixed","createdAt":"2026-11-22T13:37:22.939Z"}] |
| 阶段5 客户风险处置 | 通过 | accepted |
| 阶段3 结论撤回 | 通过 | retracted |
| 阶段5 更正生成 | 通过 | #1 |
| 阶段5 更正影响清单 | 通过 | ["engagement-summary","sys-a-baseline"] |
| 阶段5 通知状态 | 通过 | notified |
| 验收3 覆盖登记 | 通过 | sys-b-diff → 201 |
| 验收3 覆盖登记 | 通过 | remediation-a → 201 |
| 验收3 覆盖登记 | 通过 | engagement-summary → 201 |
| 验收3 覆盖意见留痕 | 通过 | 3 条 |
| 阶段3 历史通过保留 | 通过 | 4/4 |
| 阶段3 当前支持下降 | 通过 | 2/4 |
| 阶段3 撤回引用计数 | 通过 | 2 |
| 验收3 分母为约定目标总数 | 通过 | 4 |
| 验收3 覆盖五类互斥 | 通过 | {"untested":0,"partial":1,"tested":1,"blocked":1,"unregistered":1} |
| 阶段3 快照可复算 | 通过 | seal valid |
| 阶段3 独立复算一致 | 通过 | 4/4 · 2/4 |
| 验收3 同一快照重复复算一致 | 通过 | 两次逐字节相同 |
| 阶段5 交付摘要可核对 | 通过 | 更正与撤回提示 |
| 阶段3 交付摘要含记分卡 | 通过 | 分子/分母 |
| 阶段2 交付摘要含版本 | 通过 | v2 |
| 阶段5 报告分列处置 | 通过 | accepted 可见 |
| 阶段5 报告含更正 | 通过 | #1 |
| 验收3 报告含覆盖与支持 | 通过 | 分子/分母同段 |
| 验收3 报告当前支持 2/4 | 通过 | 2 / 4 |
| 验收3 报告含未登记 | 通过 | 未登记 1 |
| 验收3 零发现写成未检出 | 通过 | sys-b-diff |
| 验收3 交付摘要含未登记与统计时点 | 通过 | 一致 |
| 阶段5 报告含客户复测申请 | 通过 | fulfilled |
| 阶段5 交付摘要含客户复测申请 | 通过 | 一致 |
| 阶段5 同委托第二任务建档 | 通过 | engagementId=d1d780b6-28ac-41a9-ba9a-5c75f43fe51d |
| 阶段5 委托标识一致 | 通过 | 221c7e0a |
| 阶段5 另一委托建档 | 通过 | engagementId=engagement-foreign-1795354642997 |
| 阶段5 跨任务署名复核 | 通过 | 复核丙 → confirm |
| 阶段5 跨委托复核被拒绝 | 通过 | status=409 |
| 阶段5 被拒绝的复核未写入 | 通过 | 1 条 |
| 阶段5 报告含跨任务署名复核 | 通过 | 复核丙 |
| 阶段5 报告写出源任务 | 通过 | 221c7e0a |
| 阶段5 交付摘要含两个新入口 | 通过 | 一致 |
| 阶段5 工作项关闭 | 通过 | archived |

记分卡：曾通过 4/4；当前证据足以支持 2/4；撤回引用 2；归属未知 0；人工覆盖 已测 1、部分覆盖 1、受阻 1、未测 0、未登记 1

快照内容封印　f05327fc54a2cfc4313f461b632bde624adce98a43b84ac7659d99cf4e1cb2e9（canonical payload 的 sha256；文件字节哈希见清单 files.snapshot.bytesSha256）
快照采集时点　2026-11-22T13:37:22.986Z

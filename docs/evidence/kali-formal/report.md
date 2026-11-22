# GongYuAI Report

Task: 497126a0-93ac-4c9b-b293-acd380759f40
Status: completed
Targets: kali-fixture.invalid
Authorization: 虚构材料：Kali 正式入口工程验收，不代表任何真实客户或系统
排除范围　未列出

## 平台用量

- 累计 Token　用量 0，上限 不限
- 累计工具调用　用量 4，上限 不限
- 累计安装　用量 0，上限 不限
- 本轮墙钟（毫秒）　用量 4918，上限 不限

## Skill 与 MCP 调用

采集起点 2026-11-22T14:15:06.306Z。成功率按已知结果计算，未返回的调用列为待定。

| 类别 | 名称 | 调用 | 成功 | 失败 | 待定 | 成功率 |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| Skill | 合计 | 0 | 0 | 0 | 0 | — |
| MCP | 合计 | 0 | 0 | 0 | 0 | — |

## Findings

- （无已验证 finding；tentative 线索不进交付）



## 覆盖与当前支持

统计时点　2026-11-22T14:15:12.703Z（实时读数；不可变凭据以交付快照 SHA-256 为准）
分母　本次约定目标总数 1

- 历史通过　1 / 1
- 当前证据足以支持　1 / 1
- 原依据归属未知　0 / 1
- 已撤回依据引用（条数，非目标数）　0

人工覆盖（五类互斥，合计等于分母）

- 已测 0、部分覆盖 0、受阻 0、未测 0、未登记 1

说明：当前证据支持与人工覆盖是两个维度；覆盖充分不代表有发现，零发现也不证明覆盖。

## 原始材料差异核算

- 原始材料差异核算 · kali-eng-missing（fa30d73e-3aaa-4465-8ce4-8fb75692ad0f）　kali-eng-missing：共 5 项（主键 asset\_id）；新增 0、移除 0、变更 0、未变 0、缺件 0、未知 5；缺失材料 assets/yingji-baseline.csv
  核算结果　reconcile/kali-eng-missing-20261122141506.json
- 原始材料差异核算 · kali-eng-diff（56c8b153-123c-4d00-93b2-6e4ee3ca8872）　kali-eng-diff：共 6 项（主键 asset\_id）；新增 1、移除 1、变更 1、未变 2、缺件 1、未知 0
  核算结果　reconcile/kali-eng-diff-20261122141507.json


## 逐项目标复核

### 两份原始资产清单完成差异比对（kali-eng-asset-diff）· 已通过核算条件（首次通过依据＝实际采用的核算文件）

缺任一侧材料都不算完成比对；两份齐全后缺项本身是有效核查结论

- 人工覆盖记录　未登记（没有覆盖意见，不等于已验证覆盖）
- 核算条件：reconcile/kali-eng-\*.json 必须是一份满足条件的核算结果（未知项≤0、重复主键歧义≤0；只挂差异文件不算完成比对）
- 首次通过采用的核算文件：reconcile/kali-eng-diff-20261122141507.json · SHA-256 478da5dfc3d0873d2298ce9b22b64e9376085635b53dec06a5ab87915d80bdbf（核算名 kali-eng-diff；共 6 项，未知 0、歧义 0）
- 首次通过：2026-11-22T14:15:07.859Z
- 断言时证据：[reconcile/kali-eng-diff-20261122141507.json](report-evidence/478da5dfc3d0873d2298ce9b22b64e9376085635b53dec06a5ab87915d80bdbf) · SHA-256 478da5dfc3d0873d2298ce9b22b64e9376085635b53dec06a5ab87915d80bdbf
- 待复核记录：原始材料差异核算 · kali-eng-diff（56c8b153-123c-4d00-93b2-6e4ee3ca8872）。kali-eng-diff：共 6 项（主键 asset\_id）；新增 1、移除 1、变更 1、未变 2、缺件 1、未知 0

## 其余历史记录（未关联到已复核结论）

- 资产 · seed · kali-fixture.invalid（8f8ca35f-98fe-4633-b83e-f31af5aad220）。授权靶标（auth.targets）：kali-fixture.invalid
- 原始材料差异核算 · kali-eng-missing（fa30d73e-3aaa-4465-8ce4-8fb75692ad0f）。kali-eng-missing：共 5 项（主键 asset\_id）；新增 0、移除 0、变更 0、未变 0、缺件 0、未知 5；缺失材料 assets/yingji-baseline.csv · 记录路径：reconcile/kali-eng-missing-20261122141506.json
- 任务已初始化（3c249be3-24c6-4a50-a212-54bbcdbbede6）。授权目标：kali-fixture.invalid
- 已加载授权范围（ff7f61ec-0d24-422d-8b1f-1c0bafe190fd）。虚构材料：Kali 正式入口工程验收，不代表任何真实客户或系统
- 资产 · admitted · discovered.kali-fixture.invalid（f30d232b-bdae-4879-b5fb-efd06c939222）。mock 发现资产（自动准入）
- Mock fixture ready（f323a85f-35cc-4964-9086-4962517ef5ae）。
- HTTP banner captured（d8eac775-2fd0-4de9-bef6-30eb386df332）。HTTP/1.1 200 OK Server: gongyuai-mock  · 记录路径：recon/banner.txt
- Recon done for kali-fixture.invalid（a420e599-7c48-4eaa-9f8d-177278c68474）。

## Session Relay

已记录 1 次会话交接。

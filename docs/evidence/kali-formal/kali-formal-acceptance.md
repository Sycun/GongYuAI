# Kali 正式入口独立工程验收

任务　497126a0-93ac-4c9b-b293-acd380759f40

委托　kali-engineering-acceptance-1795356905

目标　kali-eng-asset-diff

数据根　/home/parallels/GongYuAI-f34cc032/.gongyuai

开始　2026-11-22T22:15:05+0800

结束　2026-11-22T22:15:12+0800

| 步骤 | 结果 | 说明 |
| --- | --- | --- |
| 0 正式入口健康 | 通过 | http://127.0.0.1:8877/health → 200 {"ok": true, "version": "0.1.0"} |
| 1 建档 | 通过 | POST /tasks → 201 task=497126a0-93ac-4c9b-b293-acd380759f40 |
| 1 暂停模拟 Worker | 通过 | status=paused |
| 2 导入当前清单（只交一侧） | 通过 | {'path': 'assets/yingji-current.csv'} |
| 2 缺件核算被接受 | 通过 | POST /reconcile → 201 reconcile/kali-eng-missing-20261122141506.json |
| 2 缺件结论点名基线材料 | 通过 | missingMaterials=["assets/yingji-baseline.csv"] |
| 2 缺件时全部为未知 | 通过 | counts={"added": 0, "removed": 0, "changed": 0, "unchanged": 0, "missing": 0, "unknown": 5, "ambiguous": 0, "totalKeys": 5} |
| 2 证据目录没有预置答案 | 通过 | 命中 0 个：[] |
| 3 任务恢复 | 通过 | status=initializing |
| 3 缺件运行没有判通过 | 通过 | 任务 status=incomplete（缺一侧材料不得 completed） |
| 3 目标保持未通过 | 通过 | kali-eng-asset-diff passes=False |
| 3 未通过原因点名缺件 | 通过 | 核算条件未满足：reconcile/kali-eng-missing-20261122141506.json：缺少基线材料 assets/yingji-baseline.csv；未知项 5 项 > 允许 0 项（本次核算没有得出结论） |
| 3 缺件阶段没有首次通过依据 | 通过 | goalProofs=0 |
| 3 记分卡当前支持为 0 | 通过 | 历史 0/1 · 当前 0/1 |
| 3 报告写出缺件与未通过 | 通过 | 报告 2300 字节 |
| 4 补交基线清单 | 通过 | assets/yingji-baseline.csv 已导入 |
| 4 合格核算 | 通过 | POST /reconcile → 201 reconcile/kali-eng-diff-20261122141507.json |
| 4 差异结论符合预期 | 通过 | counts={"added": 1, "removed": 1, "changed": 1, "unchanged": 2, "missing": 1, "unknown": 0, "ambiguous": 0, "totalKeys": 6} |
| 4 人工抽查 GY-SRV-02 | 通过 | {"key": "GY-SRV-02", "status": "changed", "baselineLine": 3, "currentLine": 3, "changes": [{"field": "risk", "before": "high", "after": "medium"}]} |
| 4 两侧都不存在的约定项是有效结论 | 通过 | {"key": "GY-SRV-09", "status": "missing", "baselineLine": null, "currentLine": null, "changes": [], "reason": "required-key-absent-in-both"} |
| 4 差异文件由本次实现产生 | 通过 | reconcile/kali-eng-diff-20261122141507.json mtime=2026-11-22T22:15:07+0800 sha256=478da5dfc3d0… |
| 5 补交后从正常入口重新判定 | 通过 | status=initializing |
| 5 目标由核算结果满足 | 通过 | status=completed |
| 5 目标首次通过 | 通过 | assertedAt=2026-11-22T14:15:07.859Z |
| 5 差异文件生成时间早于首次通过 | 通过 | 文件 mtime=2026-11-22T22:15:07+08:00（1795356907s） ≤ 首次通过 2026-11-22T14:15:07.859Z（1795356907s） |
| 5 首次通过只指向一份核算文件 | 通过 | [{"goalId": "kali-eng-asset-diff", "path": "reconcile/kali-eng-diff-20261122141507.json", "sha256": "478da5dfc3d0873d2298ce9b22b64e9376085635b53dec06a5ab87915d80bdbf"}] |
| 5 首次通过事件指向实际采用的核算文件 | 通过 | reconcile/kali-eng-diff-20261122141507.json · 478da5dfc3d0…（事件 1 条） |
| 5 报告引用采用的核算文件与哈希 | 通过 | 报告 2875 字节 |
| 6 交付快照已保存 | 通过 | /home/parallels/GongYuAI-f34cc032/out/kali-formal/delivery-snapshot.json |
| 6 记分卡历史与当前分列 | 通过 | 历史 1/1 · 当前 1/1 · 归属未知 0 · 人工覆盖 {"untested": 0, "partial": 0, "tested": 0, "blocked": 0, "unregistered": 1} |

## 首次通过采用的核算文件

- 路径　`reconcile/kali-eng-diff-20261122141507.json`
- SHA-256　`478da5dfc3d0873d2298ce9b22b64e9376085635b53dec06a5ab87915d80bdbf`
- 文件生成时间　2026-11-22T22:15:07+0800
- 首次通过时间　2026-11-22T14:15:07.859Z
- 快照内容封印　`0c2e7f4ae7824b2fd40e58be790276b904cb5f4d0efc5611948049a41aa75f11`

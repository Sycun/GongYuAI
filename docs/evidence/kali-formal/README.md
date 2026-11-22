# Kali 正式入口独立工程验收（第七轮）

正式入口：`http://10.211.55.5:8877`（Kali `kali-linux-2025-2`，程序目录 `/home/parallels/GongYuAI-f34cc032`，
运行版本 `f34cc032cd9c4061a9212758595b34cf8d5fc2e0`，systemd 单元 `gongyuai.service`）。

材料是**虚构**的：两份原始资产清单（`assets/yingji-baseline.csv` / `assets/yingji-current.csv`），
由本轮的核算实现现场产生差异文件，证据目录里没有 `*-mock.json`、`expected.json`、`answer.json`
（驱动脚本 `scripts/kali/formal-acceptance.py` 会逐项检查并打印命中数）。

## 1. 三段时间顺序

| 阶段 | 时间（Asia/Shanghai） | 事实 |
| --- | --- | --- |
| 只交当前清单，核算 | 2026-11-22 22:15:06 | `reconcile/kali-eng-missing-20261122141506.json`，`missingMaterials=["assets/yingji-baseline.csv"]`，`unknown 5/5`；任务 `incomplete`，目标未通过，当前支持 0/1，报告写出“缺少基线材料 assets/yingji-baseline.csv” |
| 补交基线，重新核算 | 2026-11-22 22:15:07 | `reconcile/kali-eng-diff-20261122141507.json`，新增 1、移除 1、变更 1、未变 2、缺件 1、未知 0、歧义 0，共 6 项 |
| 目标首次通过 | 2026-11-22 22:15:07.859Z（14:15:07.859Z） | 差异文件 mtime `22:15:07+08:00` 早于首次通过时间；`goal_asserted` 只有 1 条 |

人工抽查一条差异：`GY-SRV-02` 在基线第 **3** 行、当前第 **3** 行，字段 `risk` 由 `high` 变为 `medium`。
约定项 `GY-SRV-09` 两份清单都不存在 → `status=missing`、`reason=required-key-absent-in-both`（有效核查结论，
不等于整份输入缺失）。

## 2. 四处对应

| 位置 | 值 |
| --- | --- |
| 首次通过依据（`goal_proofs`） | `reconcile/kali-eng-diff-20261122141507.json` · `478da5dfc3d0873d2298ce9b22b64e9376085635b53dec06a5ab87915d80bdbf` |
| 首次通过事件 `goal_asserted.adoptedReconcile` | 同一路径、同一 SHA-256 |
| 报告（`/tasks/:id/report`） | 报告正文引用同一路径与同一 SHA-256（见 `report.md`） |
| 交付快照 | 文件字节 SHA-256 `72256e61f35db1ee434d207aed44514622b2e7a0cbba62c839e366cb60412389`；内容封印 `0c2e7f4ae7824b2fd40e58be790276b904cb5f4d0efc5611948049a41aa75f11` |

## 3. 历史通过 / 当前支持 / 人工覆盖

| 维度 | 读数 |
| --- | --- |
| 历史通过 | 1 / 1 |
| 当前证据支持 | 1 / 1 |
| 原依据归属未知 | 0 / 1 |
| 人工覆盖 | 已测 0 · 部分覆盖 0 · 受阻 0 · 未测 0 · **未登记 1** |

人工覆盖**未登记**是有意为之：附件存在不等于覆盖已知；登记覆盖需要另一次署名动作。

## 4. 浏览器与离线复算

- 正式浏览器（Mac 上的 ego-browser 指向 `http://10.211.55.5:8877`）打开任务 `497126a0` 的「目标」页，
  显示“已通过核算条件（首次通过依据＝实际采用的核算文件）”“核算条件：reconcile/kali-eng-*.json（未知项≤0、
  重复主键歧义≤0）”“首次通过采用的核算文件 … SHA-256 478da5df…”。截图：`console-goal-gate.png`。
- 离线复算（Mac，只读交付快照）：`pnpm gy scorecard --recompute docs/evidence/kali-formal/delivery-snapshot.json`
  → `sealValid: true`，分子/分母与上表一致。完整输出见 `offline-recompute.txt`。

## 5. 文件

| 文件 | 内容 |
| --- | --- |
| `kali-formal-acceptance.json` / `.md` | 驱动的逐步记录（每条断言带时间戳） |
| `snapshot-after-missing.json` | 缺件阶段的快照（历史 0/1、当前 0/1） |
| `delivery-snapshot.json` | 首次通过后的交付快照（离线复算的输入） |
| `report.md` | 正式入口导出的报告 |
| `offline-recompute.txt` | 离线复算命令与输出 |
| `console-goal-gate.png` | 正式浏览器里的目标页截图 |

任务编号：`497126a0-93ac-4c9b-b293-acd380759f40`（另有三次驱动自检被提前中断的运行
`2d193d11…`、`b31cc09f…`、`b9f69705…`，它们同样被正常恢复到 completed，但不作为本轮证据）。

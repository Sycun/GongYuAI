# Kali 备份隔离恢复验证（2026-11-22）

目的：用上次发布时**实际留下的**备份做一次隔离恢复，核对“备份时点能读到什么、读不到什么”，
并区分「原备份验证」与「新备份演练」。本次是**原备份验证**：恢复的是 2026-11-22 20:21:55 的真实
数据归档，不是新做的备份。

## 1. 被验证的备份

| 项 | 值 |
| --- | --- |
| 路径 | `/home/parallels/gongyuai-data-backup-20261122-202154.tar.gz` |
| 大小 | 21,217,525 字节 |
| mtime | 2026-11-22 20:21:55.404018651 +0800 |
| SHA-256 | `cef807d98dc0567b2ff8fa58764c9a295ae6965465bfc938c60d8e24a89d1925` |
| 归档顶层 | `.env`、`.gongyuai/`、`tmp/`（本次只解出 `.gongyuai/`，未解 `.env` 与 `tmp/`） |
| 条目数 | 5562 |
| 任务范围 | 备份时点 11 个任务（见 §3） |

## 2. 恢复方式（隔离、不碰正式实例）

- 解出目录：Kali `/tmp/gy-restore-ecec/.gongyuai`（94 MB，权限 0700 父目录）。
- 入口：**仅回环** `http://127.0.0.1:18877`（`--host 127.0.0.1`），与正式实例 `:8877` 分离。
- 禁止外发模型调用：启动前 `env -u OPENAI_API_KEY -u OPENAI_BASE_URL -u GY_MODEL`。
- 禁止任务自动续跑：`GY_WATCHDOG_MS=86400000`（看门狗一次 tick 需要 24h，演练期间不会重启或续跑任务）。
- 恢复所用代码：`04c798b344710ceefc38e49536aa90242838736d`（备份时点部署的版本）。
- 正式实例未受影响：`MainPID=1590964`、`readlink /proc/1590964/cwd = /home/parallels/GongYuAI`、
  `/health ok`、任务数仍 13、`systemctl is-active gongyuai.service = active`。

## 3. 备份时点的任务清单（11 个，来源：备份内 `control.sqlite`）

| # | 任务 ID | 名称 | 状态 |
| --- | --- | --- | --- |
| 1 | `e9d288f8-4580-4a42-813f-ec66c93d63a3` | kali-demo | completed |
| 2 | `387eecb4-ec8c-46c4-80b3-925cb905b3da` | tsecbench-e1-01 | stopped |
| 3 | `cb27aca9-6999-42b0-a44a-9155787e7d79` | tsecbench-e1-01-ds | stopped |
| 4 | `c90a41bb-b110-4a43-9f2f-de0ad3d6210c` | tsecbench-e1-flash | failed |
| 5 | `194f8f99-665e-4a16-a234-dc24b78531d2` | tsecbench-e1-vpn | stopped |
| 6 | `10ab8714-c03f-406a-9e85-16c3039f44be` | tsecbench-e1-02 | stopped |
| 7 | `8e7d7980-9ffa-4d72-a125-0e526dee8ffb` | tsecbench-auto | completed |
| 8 | `e99ac22c-3a25-4156-b4e1-161fd48ae2e0` | tsecbench-auto-2 | completed |
| 9 | `c04c5f1c-6daf-4124-a24f-5d17909cc299` | tsecbench-auto-3 | budget_exhausted |
| 10 | `94fb54bf-7950-4649-9329-0093d99a77a3` | tsecbench-auto-task-c8pnksin2v | budget_exhausted |
| 11 | `e73db2b2-d436-4c54-bdd3-837c0ef2800a` | tsecbench-auto-e0vvpw7026 | stopped |

恢复实例 `/tasks` 返回 **11 个任务，ID 集合与上表完全一致**。

## 4. 切换后新增、不在备份内的任务

| 任务 ID | 名称 | 创建时间（UTC） |
| --- | --- | --- |
| `9aa06c00-37e7-4c88-b78d-dbec8d497bf5` | kali-deploy-acceptance | 2026-11-22T12:22:40.109Z |
| `c459008e-421e-4bba-93d3-eb4b208ebfaf` | kali-pause-resume-acceptance | 2026-11-22T12:22:47.317Z |

两者都在备份（12:21:55Z）之后创建，因此只存在于正式实例，不属于“备份缺件”。

## 5. 抽查结果（有依据的逐项比对）

| 检查 | 期望 | 实际 | 结论 |
| --- | --- | --- | --- |
| 历史委托 `kali-demo` 可读 | 2 个目标、15 条事件 | `recon/report` 两个目标，5 条事实，15 条事件 | 通过 |
| 证据原件字节一致 | API 下载字节 = 盘上字节 | `recon/banner.txt` 0a6acaff…、`goals/report.md` 67e75606…，API 与磁盘相同 | 通过 |
| 历史报告一致 | API 报告 = 盘上 `report.md` | `df3b63ad417f7053830f9332d2388fd3b47e29c1698301349f54bd86e3d41d8f`（504 字节），两处相同 | 通过 |
| 快照同源 | 记分卡引用 = 快照内部封印 | 两者都是 `b827ac8301774906ef425eba0b44ab8735ed0dfe4173b1b28f544e68fbb25733` | 通过 |
| 离线复算 | 纯函数复算与快照一致 | `sealValid=true`，历史 2/2、当前支持 0、归属未知 2 | 通过 |
| 旧档归属 | 旧任务无首次通过依据 | `goals.passes=2`，但 `goal_proofs=0`、`goal_findings=0` → 判定 `unknown-attribution`，覆盖 `unregistered/unknown` | 与设计一致（A4） |

## 6. 验证上限（备份时点缺少什么）

- 备份内所有任务 `goal_proofs=0`、`evidence_versions=0`、`goal_findings=0`，也没有
  `report-evidence/` 目录。也就是说：**备份时点的历史任务早于“封存证据版本”特性**，
  无法核对“封存原件 ↔ 交付记录同源”这一层。
- 能证明的是：证据文件字节可读且 API 与磁盘一致、历史报告字节一致、快照封印可离线复算。
- 覆盖意见同样不存在（`coverage_reviews=0`），所以恢复出来的旧档一律显示“覆盖未登记”，
  这也正好复现 A4 的旧档语义。
- 因此本项结论是“**原备份恢复到可读、可复算、可抽查的程度**”，不是“封存证据链完整可验”。
  下一次真正的恢复演练应在新备份上做（含 `evidence_versions` 与 `report-evidence/`）。

## 7. 证据文件

- `drill.log`：本次在 Kali 上的原始命令输出（已过滤密钥类字段；不含 `.env`、不含客户材料正文）。
- 未落盘内容：`.env`、`settings.json` 内容、任何证据文件正文。仅记录路径名与 SHA-256。

# 交付记录（Release / Deployment Record）

日期：2026-11-22（Asia/Shanghai）  
实施与发布：DSH 实施会话（lead）  
状态口径见 [implementation-ledger.md](./implementation-ledger.md)。

## 1. 三个可验证结果

| # | 结果 | 状态 | 证据 |
| --- | --- | --- | --- |
| 1 | 普通操作员从正常入口完成一笔跨日生产委托 | ✅ | `scripts/engagement-e2e.ts` 53 项全过；验收记录 `.gongyuai/acceptance/engagement-1795350021687/acceptance-record.md`；控制台交付页（报告 Tab）可见记分卡/更正/撤回提示 |
| 2 | GitHub `Sycun/GongYuAI` 收到验收后的本次提交 | ✅ | `main` = `3a6b174bf544b61c58f28d631aa136a3c34b9e3a`（[提交](https://github.com/Sycun/GongYuAI/commit/3a6b174bf544b61c58f28d631aa136a3c34b9e3a)），远端 `git ls-remote` 复核一致 |
| 3 | Kali 用该提交完整替换旧项目、正式入口验收、旧程序目录删除 | ✅ | 服务 `gongyuai.service` active，`MainPID` cwd=`/home/parallels/GongYuAI`，HEAD=`3a6b174…`；旧目录 `GongYuAI.old-20261122-202221` 已删除 |

## 2. 发布提交

| 项 | 值 |
| --- | --- |
| 仓库 | https://github.com/Sycun/GongYuAI |
| 分支 | `main` |
| 发布提交（代码） | `3a6b174bf544b61c58f28d631aa136a3c34b9e3a` |
| 提交链接 | https://github.com/Sycun/GongYuAI/commit/3a6b174bf544b61c58f28d631aa136a3c34b9e3a |
| 父提交 | `8e0a641da62ea9048374bcd753a4803caf3a89d3` |
| 提交范围 | 106 个文件，+9299 / −354；源码、契约、控制台、测试、脚本、锁文件、文档 |
| 排除 | `.env`、`.gongyuai/`（任务库/证据/验收产物）、`node_modules/`、`dist/`、构建缓存、28MB 本地 PPTX |
| 推送方式 | 普通 `git push`，无 force |

发布前在**该提交的工作区**上依次执行：

| 检查 | 命令 | 结果 |
| --- | --- | --- |
| 构建 | `pnpm -r run build` | exit 0（7 项目） |
| 单测 | `pnpm -r run test` | 107 通过 / 0 失败（contracts 22、history 30、control-plane 20、worker 35） |
| 冒烟 | `pnpm smoke` | PASS（findings gate 失败臂、墙钟收卷、证据边界） |
| 贯穿样例 | `pnpm e2e:engagement` | 53/53 通过 |
| 恢复演练 | `pnpm drill:restore` | 委托/目标/证据/发现/报告/记分卡均可读，原文可读 |
| 控制台构建 | `pnpm --filter @gongyuai/console build` | 通过 |
| 浏览器验收 | 控制台交付页（Mac 验收数据 + Kali 正式入口） | 记分卡、发现依据、撤回提示、更正 #1、授权版本 v2/v1 均可见 |

## 3. 贯穿样例（跨日生产委托）

- 委托：`甲乙双系统资产与配置基线评估及整改复核`（任务 `d18e5e27…` / 复跑 `53f577f7…`）。
- 首日：甲基线（发现闸）、乙差异（覆盖型、零发现）、全委托汇总通过；整改材料缺件 → 3/4。
- 中断：关闭控制面后从同一数据目录恢复；无重复 `goal_asserted`（逐目标各 1 次），事实只增不减。
- 换班：`pause` → `paused`（workerPids=[]、checkpoint 留存）→ 范围修订 v2（乙移出）→ 补交材料 → `resume` → completed；恢复后 auth 只含甲，`scopeVersion=2`。
- 交付：复测 `fixed` → `retested`；线索确认 → `verified`；客户接受剩余风险 → `accepted`；撤回一条被两个目标引用的发现；更正 #1 影响 `engagement-summary`、`sys-a-baseline`，通知状态 `已通知`；归档关闭。
- 记分卡：曾通过 4/4；当前证据足以支持 2/4；撤回引用 2；快照 SHA-256 见验收记录。

独立复算一条结论：

```bash
pnpm gy scorecard <taskId> --out snapshot.json      # 正常入口导出不可变快照
pnpm gy scorecard --recompute snapshot.json         # 纯函数复算，sealValid=true
curl -s localhost:8877/tasks/<taskId>/history       # Fact/Intent/事件
curl -s "localhost:8877/tasks/<taskId>/evidence/file?path=baseline/sys-a/config.json"
```

## 4. Kali 完整替换部署

| 项 | 值 |
| --- | --- |
| 主机 | `10.211.55.5`（kali-linux-2025-2，aarch64，SSH 用户 `parallels`） |
| 正式目录 | `/home/parallels/GongYuAI`（完整新目录，非覆盖复制） |
| Git | HEAD `3a6b174bf544b61c58f28d631aa136a3c34b9e3a`，工作区干净 |
| 服务 | `gongyuai.service`（systemd，User=parallels，WorkingDirectory=/home/parallels/GongYuAI） |
| 启动命令 | `pnpm gy serve --host 0.0.0.0 --port 8877 --data-dir /home/parallels/GongYuAI/.gongyuai` |
| 持久数据 | `/home/parallels/GongYuAI/.gongyuai`（control.sqlite、tasks、settings、证据） |
| 依赖与构建 | Kali 本机 `pnpm install --frozen-lockfile` + `pnpm -r run build`（未复制 macOS 依赖） |
| 迁移验证 | 先对旧数据副本启动新版本：11 个委托可读、目标/事实/证据/报告正常；随后切换真实副本 |
| 切换 | 冻结旧进程 → 复制 `.gongyuai`/`.env` → 目录对调 → 终止旧主进程触发 `Restart=on-failure` → 6s 后新版本 active |
| 部署后验收 | 11 个历史委托保留；`kali-demo` 目标/证据/报告可读；CLI 新建 `kali-deploy-acceptance`（completed，记分卡 1/1）；`kali-pause-resume-acceptance` pause→paused（workerPids=0）→resume→completed；CLI `scorecard` 与离线 `--recompute` seal 一致；浏览器在 `http://10.211.55.5:8877` 读取交付页 |
| 旧程序目录 | `/home/parallels/GongYuAI.old-20261122-202221` → 已删除（删除前确认无进程 cwd、无 systemd 引用、无任务 dataDir 引用） |
| 保留备份 | `/home/parallels/gongyuai-data-backup-20261122-202154.tar.gz`（21MB，0600；含 `.gongyuai`、`.env`、切换前本地 diff 617 行） |
| 未处理 | `/home/parallels/GongYuAI-hosted-build`：旧静态构建副本，属主 UID 501、部分目录不可读；无进程/单元引用，未删除，待确认归属后处理 |

一致性证据：

```text
GitHub refs/heads/main : 3a6b174bf544b61c58f28d631aa136a3c34b9e3a
Kali git HEAD          : 3a6b174bf544b61c58f28d631aa136a3c34b9e3a
Kali MainPID cwd       : /home/parallels/GongYuAI
Kali health            : {"ok":true,"version":"0.1.0"}
Kali tasks             : 13（切换前 11 + 验收 2）
```

## 5. 阶段与 P0–P12

完整映射、入口、测试证据与差距见 [implementation-ledger.md](./implementation-ledger.md)。摘要：

- ✅ 阶段 1、3、5；P0–P5、P6-E1(+目标级归属)、P9-F1、阶段 2 暂停/恢复/范围版本。
- 🔨 阶段 2 后台作业回流与 24h 咨询、阶段 4 四图/今日首页、阶段 7 供应商故障演练。
- 📐 P7 模型路由、P8 全局记忆与隔离、P10 四图、P11 会话/作业/隧道/浏览器、P12 D1/D2/D3/D5/D6/D8/攻击链。
- ⏳ 生产盲评：缺已获准的脱敏历史委托与独立人工底稿，标记“生产盲评待验证”。

## 6. 独立复核清单

1. `git ls-remote origin refs/heads/main` 对照本文 SHA。
2. 在干净副本 `pnpm install --frozen-lockfile && pnpm -r run build && pnpm -r run test && pnpm smoke`。
3. `pnpm e2e:engagement`，读 `.gongyuai/acceptance/<run>/acceptance-record.md`。
4. 任选一条结论：`gy scorecard <id> --out` → `--recompute`，再下钻 `history` / `evidence/file` / `report-evidence/<sha>`。
5. SSH Kali：`systemctl show gongyuai.service -p MainPID -p ExecStart`、`readlink /proc/<pid>/cwd`、`git -C /home/parallels/GongYuAI rev-parse HEAD`。
6. 确认 `/home/parallels/GongYuAI.old-*` 不存在；备份 tar 权限 0600。
7. 浏览器 `http://10.211.55.5:8877`：任务列表、报告 Tab 的交付核对/记分卡/更正。

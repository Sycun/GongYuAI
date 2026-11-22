# 交付记录（Release / Deployment Record）

日期：2026-11-22（Asia/Shanghai）  
实施与发布：DSH 实施会话（lead）  
状态口径见 [implementation-ledger.md](./implementation-ledger.md)。

## 1. 三个可验证结果

| # | 结果 | 状态 | 证据 |
| --- | --- | --- | --- |
| 1 | 普通操作员从正常入口完成一笔跨日生产委托 | ✅ | `scripts/engagement-e2e.ts` 53 项全过；验收记录 `.gongyuai/acceptance/engagement-1795350021687/acceptance-record.md`；控制台交付页（报告 Tab）可见记分卡/更正/撤回提示 |
| 2 | GitHub `Sycun/GongYuAI` 收到验收后的本次提交 | ✅ | `main` = `3a6b174bf544b61c58f28d631aa136a3c34b9e3a`（[提交](https://github.com/Sycun/GongYuAI/commit/3a6b174bf544b61c58f28d631aa136a3c34b9e3a)），远端 `git ls-remote` 复核一致 |
| 3 | Kali 用该提交完整替换旧项目、正式入口验收、旧程序目录删除 | ✅ | 服务 `gongyuai.service` active，`MainPID` cwd=`/home/parallels/GongYuAI`，代码树=`3a6b174…`、HEAD=当前 `main`；旧目录 `GongYuAI.old-20261122-202221` 已删除 |

## 2. 发布提交

| 项 | 值 |
| --- | --- |
| 仓库 | https://github.com/Sycun/GongYuAI |
| 分支 | `main` |
| 代码发布提交 | `6c6bebd9f7aa0075d4378095230fa527b84a31ae`（含独立复核修复）；前序 `3a6b174`（首版）、`8e0a641`（基线） |
| 记录提交 | 本文件所在的当前 `main` HEAD（`git rev-parse HEAD`）；相对代码提交仅 docs 差异 |
| 提交链接 | https://github.com/Sycun/GongYuAI/commit/6c6bebd9f7aa0075d4378095230fa527b84a31ae |
| 父提交 | `907cb63df069119f6af9fd3855436b6c2b3be3bf`（首版发布 `3a6b174` 的文档后续） |
| 提交范围 | 首版 106 文件（+9299/−354）+ 复核修复 17 文件（+212/−30）；源码、契约、控制台、测试、脚本、锁文件、文档 |
| 排除 | `.env`、`.gongyuai/`（任务库/证据/验收产物）、`node_modules/`、`dist/`、构建缓存、28MB 本地 PPTX |
| 推送方式 | 普通 `git push`，无 force |

发布前在**该提交的工作区**上依次执行：

| 检查 | 命令 | 结果 |
| --- | --- | --- |
| 构建 | `pnpm -r run build` | exit 0（6 个含 build 脚本的 workspace 项目） |
| 单测 | `pnpm -r run test` | 111 通过 / 0 失败（contracts 22、history 31、control-plane 23、worker 35） |
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
- 记分卡：曾通过 4/4；当前证据足以支持 2/4；撤回引用 2；归属未知 0（旧档归属未知不计入当前支持）。
- 快照与发布 hash 同源：`delivery-snapshot.json` 的 `sha256` 与验收记录里的 `scorecard.snapshotSha256` 必须相等（本机 `6b299710…`，Kali `22b86de8…`），`gy scorecard --recompute` 输出 `sealValid=true`。
- 交付页（报告 Tab）里的“快照 SHA-256”是**实时读数**：每次请求会重新取 `capturedAt`，因此会变化；不可变凭据只认 `GET /tasks/:id/snapshot` 或 `gy scorecard --out` 落盘的那一份。

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
| 代码树 | `6c6bebd9f7aa0075d4378095230fa527b84a31ae`（非 docs 差异为空） |
| Git HEAD | 当前 `main`（含文档提交，`git diff --stat 6c6bebd HEAD -- ':!docs'` 为空），工作区干净 |
| 服务 | `gongyuai.service`（systemd，User=parallels，WorkingDirectory=/home/parallels/GongYuAI） |
| 启动命令 | `pnpm gy serve --host 0.0.0.0 --port 8877 --data-dir /home/parallels/GongYuAI/.gongyuai` |
| 持久数据 | `/home/parallels/GongYuAI/.gongyuai`（control.sqlite、tasks、settings、证据） |
| 依赖与构建 | Kali 本机 `pnpm install --frozen-lockfile` + `pnpm -r run build`（未复制 macOS 依赖） |
| 迁移验证 | 先对旧数据副本启动新版本：11 个委托可读、目标/事实/证据/报告正常；随后切换真实副本 |
| 切换 | 冻结旧进程 → 复制 `.gongyuai`/`.env` → 目录对调 → 终止旧主进程触发 `Restart=on-failure` → 6s 后新版本 active |
| 部署后验收 | 11 个历史委托保留；`kali-demo` 目标/证据/报告可读；CLI 新建 `kali-deploy-acceptance`（completed，记分卡 1/1）；`kali-pause-resume-acceptance` pause→paused（workerPids=0）→resume→completed；CLI `scorecard` 与离线 `--recompute` seal 一致；浏览器在 `http://10.211.55.5:8877` 读取交付页；复核后同步 `6c6bebd`、重建并重启，Kali 侧 `pnpm e2e:engagement` 53/53 通过（`.gongyuai/acceptance/engagement-1795350565377`），发布 hash 与快照文件一致（`22b86de8…`） |
| 旧程序目录 | `/home/parallels/GongYuAI.old-20261122-202221` → 已删除（删除前确认无进程 cwd、无 systemd 引用、无任务 dataDir 引用） |
| 保留备份 | `/home/parallels/gongyuai-data-backup-20261122-202154.tar.gz`（21MB，0600；含 `.gongyuai`、`.env`、切换前本地 diff 617 行） |
| 未处理 | `/home/parallels/GongYuAI-hosted-build`：旧静态构建副本，属主 UID 501、部分目录不可读；无进程/单元引用，未删除，待确认归属后处理 |

一致性证据：

```text
GitHub refs/heads/main : 当前 HEAD（与 Kali 相同；git ls-remote origin refs/heads/main）
Kali git HEAD          : 当前 HEAD（同上）
代码树（两端）         : 6c6bebd9f7aa0075d4378095230fa527b84a31ae（非 docs 文件差异为空）
Kali MainPID cwd       : /home/parallels/GongYuAI
Kali health            : {"ok":true,"version":"0.1.0"}
Kali tasks             : 13（切换前 11 + 验收 2）
```

## 5. 阶段与 P0–P12

完整映射、入口、测试证据与差距见 [implementation-ledger.md](./implementation-ledger.md)。摘要：

- ✅ 阶段 1、3、5；P0–P5、P6-E1(+目标级归属)、P9-F1、阶段 2 暂停/恢复/范围版本（`pause-scope.test.ts` 覆盖状态语义、看门狗跳 draining、范围修订门禁）。
- 🔨 阶段 2 后台作业回流与 24h 咨询、阶段 4 四图/今日首页、阶段 7 供应商故障演练。
- 📐 P7 模型路由、P8 全局记忆与隔离、P10 四图、P11 会话/作业/隧道/浏览器、P12 D1/D2/D3/D5/D6/D8/攻击链。
- ⏳ 生产盲评：缺已获准的脱敏历史委托与独立人工底稿，标记“生产盲评待验证”。

## 6. 独立复核清单

1. `git ls-remote origin refs/heads/main` 对照本文 SHA。
2. 在干净副本 `pnpm install --frozen-lockfile && pnpm -r run build && pnpm -r run test && pnpm smoke`。
3. `pnpm e2e:engagement`，读 `.gongyuai/acceptance/<run>/acceptance-record.md`。
4. 任选一条结论：`gy scorecard <id> --out` → `--recompute`（`sealValid=true`），核对发布 hash 与快照文件 `sha256` 相等；再下钻 `history` / `evidence/file` / `report-evidence/<sha>`。
5. SSH Kali：`systemctl show gongyuai.service -p MainPID -p ExecStart`、`readlink /proc/<pid>/cwd`、`git -C /home/parallels/GongYuAI rev-parse HEAD`。
6. 确认 `/home/parallels/GongYuAI.old-*` 不存在；备份 tar 权限 0600。`git diff --stat 6c6bebd origin/main -- ':!docs'` 为空。
7. 浏览器 `http://10.211.55.5:8877`：任务列表、报告 Tab 的交付核对/记分卡/更正。

## 7. 独立复核结论与处置（2026-11-22）

独立复核（只读）确认：GitHub 三方 SHA 一致、两端树 hash 相同（`df6286a5…`）、107 项测试通过、smoke 通过、A1–A5 与阶段 2 实现符合契约、Kali 服务/目录/备份/任务数/旧目录清理与记录一致。提出的 Important 项已处置：

| 项 | 处置 |
| --- | --- |
| I1 快照 hash 与交付件不对应 | `/snapshot` 改为对同一次快照做纯函数记分卡；e2e 只取一次 `/snapshot` 并落盘同一对象；复核后验收记录 `6b299710…` 与文件 hash 相等 |
| I2 交付记录 Kali HEAD 过期 | §1 与 §4 统一为“代码树 3a6b174 / HEAD=当前 main”，复核后 Kali 已同步 |
| I3 首次通过后无法重新归属 | 明确为**首次通过时冻结归属**；重新打开需新目标/重跑，文档不再暗示自动重归属 |
| I4 归属未知计入当前支持 | `unknown-attribution` 改为 `currentSupported=false`，记分卡与交付摘要分开报；A4 夹具断言 0 |
| I5 阶段 2 无单测 | 新增 `packages/control-plane/src/pause-scope.test.ts`（状态语义、看门狗不重启 draining、范围修订门禁） |
| M1/M6 | 构建项目数改为 6；Kali「代码树」「HEAD」拆行 |
| M4 | 删除未使用的 `validateAllCompleteEvidence` 导出 |
| M3 | 契约措辞改为“证据哈希与首次通过同事务；字节采集在事务前并经 SHA 校验” |
| M7 | `assets:["*"]` 在目标级发现闸中被拒绝，要求显式 `scope:"task"` |

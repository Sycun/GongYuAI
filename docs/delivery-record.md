# 交付记录（Release / Deployment Record）

累计记录：每轮复核整改都在同一份文件里留下可复核读数，历史章节保留备查。
本轮（第八轮 / 第四轮独立复核整改）的读数在 §0；上一轮的第七轮记录在 §0A；第六轮的章节从 §1 开始。

## 0. 本轮（第八轮）关键读数

日期：2026-11-22（Asia/Shanghai）　实施：DSH 实施会话（lead）
状态口径见 [implementation-ledger.md](./implementation-ledger.md) §0；复核最短路径见 [review-checklist.md](./review-checklist.md) §0。

### 0.1 两端读数（同一受验提交）

| 项 | 值 |
| --- | --- |
| 受验代码 | `77f8b8c2c526eb8106e63e40f0b01fb131c90e89`（tree `96ffb3222670a3b37299cf58ddc4ac847551a1fb`） |
| 上一轮受验 / 复核 | `f34cc03`（第三轮独立复核），当时 GitHub `main` = `c1d95e2` |
| 本轮起点 | `c1d95e2`（工作区另有他人未提交的控制台 / 聊天改动，未纳入本次提交） |
| GitHub `main` | `77f8b8c`（`git ls-remote origin refs/heads/main` 现场取值，与受验提交相同） |
| 干净副本回归 | `/tmp/gy-clean-77f8b8c`（`git clone` 自本地仓库，checkout 受验提交，0 条未提交改动）；日志 `/tmp/gy-clean-77f8b8c/clean-regression.log` |
| Kali 检出 | `/home/parallels/GongYuAI-77f8b8c2`，HEAD = 同一受验提交，tree 同 `96ffb32`，工作区 0 条改动 |
| Kali 实际运行 | 同一提交（systemd `gongyuai.service`，MainPID 1720624，监听 PID 1720656 在 `/system.slice/gongyuai.service`，cwd = 上述目录） |

### 0.2 干净副本回归读数（受验提交）

| 步骤 | 读数 |
| --- | --- |
| 冻结依赖安装 + 构建 | exit 0 |
| 全量单测 | **162 通过 / 0 失败**（contracts 41、history 49、control-plane 37、worker 35） |
| 验收校验器测试 | 8 通过 / 0 失败 |
| smoke | PASS |
| 跨日模拟流程 | `engagement-1795360108864`：80/80，快照封印 `966437660d6c…`，文件字节 `e43a08932e7d…` |
| 原始材料业务验收 | `business-1795360131311`：77/77，快照封印 `2f20073d8e5b…` |
| 首次通过绑定验收（本轮新增） | `firstpass-1795360133436`：**69/69**（A、B1、B2 与原反例逐条对应） |
| 恢复隔离自测 | 通过（含“源目录不可访问仍从副本读”负例） |
| 失败步骤计数 | 0 |

### 0.3 两项缺陷的修复位置与实测

| 缺陷 | 修复位置 | 正常入口 | 实测 |
| --- | --- | --- | --- |
| 一、控制台建档只生成文件目标，缺材料仍可能通过 | `packages/contracts/src/index.ts`（`GoalSpec.kind` + `business` + `normalizeGoalSpecs`，唯一边界派生 `evidencePatterns`/`reconcileGate`）；`packages/contracts/src/reconcile.ts`（`BusinessReconcileConfigSchema`、`reconcileGateFromConfig`）；`packages/history/src/index.ts`（`seedGoals`/`listGoals` 读写 `goal_kind`/`business_json`）；`apps/console/src/pages/TasksPage.tsx`、`apps/console/src/components/GoalReconcileCard.tsx` | 控制台「任务 → 新建任务 → 目标类型：业务核算」填两份材料与主键；无需手写 JSON | 建档后服务端返回 `kind=business-reconcile`、派生 `evidencePatterns=["reconcile/asset-diff-*.json"]`、`reconcileGate{maxUnknown:0,maxAmbiguous:0}`，`business` 原样落库；Kali 任务 `a0c5638d…` 经 UI 建档即为此形态 |
| 二、首次通过可被“曾经合格”的旧文件满足 | `packages/history/src/goal-evidence.ts`（`verifyRevisionInputs` / `selectAdoptedReconcile` / `describeReconcileState`）；`packages/history/src/index.ts`（`reconcile_revisions` 表、`archiveReconcile`、`assertGoal` 事务内二次核对）；`packages/control-plane/src/reconcile.ts`（目标级核算解析）；`packages/history/src/report.ts`（报告写入采用的输入版本） | 目标卡「运行核算」「触发判定」；证据页「导入/替换」「撤回」 | 撤走基线后两个时点均 0/1（Kali `bf6b3bac…`）；同路径冲突重复键歧义 0/1 且界面列出 `app-a-1` 与「当前第 2 行、第 3 行」（Kali `c8c451d3…`）；修正后各自 1/1，且只记一条首次通过事件 |

### 0.4 Kali 正式控制台复跑（虚构业务材料）

| 场景 | Kali 任务 ID | 首次通过采用的输入版本 | 结果文件 | 状态 |
| --- | --- | --- | --- | --- |
| A（只交当前→补交基线） | `a0c5638d-2e84-4581-b07f-23c738d6471a` | `r1795360324163-0001` | `reconcile/asset-diff-r1795360324163-0001.json`（SHA-256 `a02b86468ae2…`） | completed · 历史 1/1 · 当前 1/1 |
| B1（撤回基线两时点） | `bf6b3bac-b095-4399-9975-71c0dc914aaa` | `r1795360401215-0001` | `reconcile/asset-diff-r1795360401215-0001.json`（SHA-256 `652204a327ce…`） | completed · 1/1 |
| B2（同路径冲突重复键） | `c8c451d3-9bec-4484-b9a4-0ee65269f5a6` | `r1795360478812-0001` | `reconcile/asset-diff-r1795360478812-0001.json`（SHA-256 `821437c8fb48…`） | completed · 1/1 |

三笔任务的三次首次通过各只产生 1 条 `goal_asserted` 与 1 份 `goal_proofs`，报告均含「首次通过采用的核算文件」「首次通过采用的输入版本」「基线 / 当前材料 SHA-256」。完整读数（含全部核算版本、输入哈希、拒绝原因、材料审计事件）见
[`docs/evidence/round8/kali-console-acceptance.json`](./evidence/round8/kali-console-acceptance.json)；
本机控制台同场景见 [`docs/evidence/round8/console-browser-acceptance.json`](./evidence/round8/console-browser-acceptance.json)。

### 0.5 Kali 部署与托管核对

| 项 | 读数 |
| --- | --- |
| 保护备份 | `gongyuai-data-backup-20261122-231008.tar.gz`，21,420,362 字节，SHA-256 `b0ee2b48dd40…`，权限 0600 |
| 切换 | `prepare`（parallels 用户：备份 → clone 受验提交 → 本机 `pnpm install --frozen-lockfile` + 构建 → 迁移 `.gongyuai` 与 `.env`）→ `switch`（root：改写单元 `WorkingDirectory` → 重启 → 逐项核对） |
| 单元状态 | `ActiveState=active`、`SubState=running`、`UnitFileState=enabled`、`NRestarts=0` |
| 监听与归属 | `0.0.0.0:8877`，PID 1720656，`/proc/<pid>/cwd` = `/home/parallels/GongYuAI-77f8b8c2`，cgroup `0::/system.slice/gongyuai.service` |
| 实际构建产物 | 6 份编译产物（`control-plane/dist/{server,reconcile,store}.js`、`contracts/dist/reconcile.js`、`history/dist/{index,goal-evidence}.js`）与本机 / 干净副本**逐字节相同**；控制台 `web/index.html` 指向本机构建的 `assets/index-CkF6Raet.js`，`/assets/index-CkF6Raet.js` 返回 200 |
| 数据保留 | 切换前后任务数 18 → 18；复跑后 22；第七轮正式任务 `497126a0…` 的 `passes=true` 与 `goal_proofs`（`reconcile/kali-eng-diff-20261122141507.json`，`478da5dfc3d0…`）保留 |

### 0.6 提交差异（受验提交之后）

受验提交 `77f8b8c` 之后只有一次文档 / 证据提交 `fcd65f3`，改动清单：
`README.md`、`docs/delivery-record.md`、`docs/implementation-ledger.md`、`docs/review-checklist.md`、
`docs/evidence/round8/{kali-console-acceptance.json,console-browser-acceptance.json,kali-console-a-goal-card.png,kali-console-conflict-keys.png}`
（其中 `console-browser-acceptance.json` 已在受验提交内，其余随本次文档提交）。
**运行时源码（`packages/**`、`apps/**`、`scripts/**`）零差异**，复核命令：

```bash
git diff --stat 77f8b8c HEAD -- packages apps scripts    # 期望：空
git diff --stat 77f8b8c HEAD -- README.md docs          # 期望：只有上列文件
```

### 0.7 仍然未验证的（工程验收 ≠ 生产盲评）

- **真实生产效果待验证**：缺 (1) 一份获准用于本次验收的脱敏真实委托（含材料先后顺序、范围修订、撤回与实际覆盖、中途交接），(2) 客户对该材料用途的书面许可，(3) 平台结果产生前独立封存的人工底稿（预期差异、未验证项、已撤回结论、遗留事项）。
- 本轮全部材料为虚构样本（`diff.example.com` / `app-a-*` 主机名），不构成真实业务结论。
- 采用规则是**内容哈希绑定**而不是“时间上最新”：材料被换回与某次核算完全相同的字节时，该次核算重新具备采用资格（不需要重新生成），因为判定依据的是“判定时有效的那份输入”。材料内容一旦变化，旧结果即失去资格——两个反例都已固定成回归。

## 0A. 上一轮（第七轮）关键读数

日期：2026-11-22（Asia/Shanghai）　实施：DSH 实施会话（lead）
状态口径见 [implementation-ledger.md](./implementation-ledger.md) §0；复核最短路径见 [review-checklist.md](./review-checklist.md)。

### 0A.1 三个版本与两套运行

| 项 | 值 |
| --- | --- |
| 受验代码 | `f34cc032cd9c4061a9212758595b34cf8d5fc2e0`（tree `e9d564949804f8722de584e60d06cd4ad81331a3`） |
| GitHub `main` | 采样 `697ed68`（2026-11-22T22:20+08:00）→ `29ff96d`（22:21+08:00）。受验提交之后的非 docs 差异只有 `README.md`、`scripts/kali/{deploy,formal-acceptance.py}`、`scripts/restore-isolation.ts`（`git diff --stat f34cc03 HEAD -- ':!docs'`）；`packages/**`、`apps/**` 零差异 |
| Kali 检出 | `/home/parallels/GongYuAI-f34cc032`，HEAD = 同一受验提交，工作区 0 条改动 |
| Kali 实际运行 | 同一提交（systemd `gongyuai.service`，MainPID 1675967，监听进程在 `/system.slice/gongyuai.service`） |
| 跨日模拟运行 | `engagement-1795356668890`（80/80，快照封印 `d6f744c3356a…`，字节 `97ff33f3a146…`，历史 4/4、当前 2/4） |
| 业务验收运行 | `business-1795356691440`（77/77，快照封印 `0439db0cc133…`，字节 `5ef79202a6d5…`，历史 3/3、当前 3/3） |
| 正式入口验收任务 | `497126a0-93ac-4c9b-b293-acd380759f40`（配额 1，历史 1/1、当前 1/1、未登记 1） |

两套运行都在受验提交的**干净 clone** 上产生（`scripts/clean-regression.sh` 一条命令跑完安装、构建、
140 项单测、8 项校验器测试、smoke、80 步跨日流程、77 步业务验收、恢复隔离自测），清单里的
`code.commit` 就是上表受验提交、`dirty=false`，校验器各 30 项全过。

### 0A.2 七项复核反例的处置

| 复核项 | 本轮改动 | 证据 |
| --- | --- | --- |
| 缺件仍判通过 | 目标新增 `reconcileGate`：两侧材料都要真正读到、结论不得停在未知或重复主键歧义，缺哪份点名哪份；通过时首次通过依据收窄为实际采用的那份核算文件；拒绝原因进事件台账（`goal_assert_rejected`）；材料不齐导致的 `incomplete` 允许从 `/resume` 重新判定 | 业务验收第 3、11 段；`packages/history/src/history.test.ts` 三条核算条件用例；正式入口任务 `497126a0…` |
| 恢复副本读回正式目录 | 启动时把每条任务记录的 `dataDir` 收回本次数据根（先验证任务 ID 与目录边界），只改副本；读取路径由 `(dataRoot, taskId)` 派生；副本内 JSON 旧绝对路径同批改写；旧 worker/lease 指针清空；新增 `isolated` 启动 | `packages/control-plane/src/data-root.test.ts`（4 例）；`pnpm restore:selftest`（20 项）；Kali 两次演练 |
| 校验器三处遗漏 | 提交必须是真实 Git 对象且等于调用方给定/冻结记录的受验提交；`dirty=true` 不通过；每类覆盖数、分母、历史通过、当前支持、归属未知逐字段从快照复算并与记录/清单三方比对；自报失败步骤一律不通过 | `scripts/verify-acceptance.test.ts` 8 例；`docs/evidence/acceptance/validator-negatives.txt`（五例非零退出） |
| 重复主键与 CSV 行号 | 进入差异计算前处理重复键：冲突标 `ambiguous` 并列出材料/键/全部来源行，给不出“未变”；内容相同按固定规则收敛为一行；CSV 改为原文件物理行号（空行占行号、CRLF、引号内逗号、引号内换行记起止行、未闭合引号报错） | `packages/contracts/src/reconcile.test.ts`（13 例）；业务验收第 7–10 段 |
| Kali 服务未由 systemd 托管 | 受控切换：先记录现场，再停用户会话监听并交 systemd，单元起不来就回退；单元文件改成指向新目录（不用 drop-in）；重启与故障恢复分别实测 | `docs/evidence/service/`；回执 `kali.service` |
| GitHub 与 Kali 不同步 | 干净副本全量回归通过后普通 push（无 force），Kali 从同一提交准备新目录、本机安装构建、迁移配置与数据、切换、核对、清理旧程序目录 | 回执 `github` / `kali` 两节 |
| 文档与证据 | 本文件 + 台账 + 复核清单 + 回执 + 四类新证据（验收、恢复、服务、正式入口） | 本文件 §0；`docs/evidence/` |

### 0A.3 仍然未验证的

- **生产盲评待验证**：缺一份获准使用的脱敏历史委托、查看平台结果前独立封存的人工底稿、客户书面确认。
  缺任一项就不把工程夹具当作人工底稿，也不宣称真实生产效果已验证。
- 旧备份（`…202154.tar.gz`）里 11 个任务没有 `evidence_versions` / `goal_proofs` / `goal_findings`，
  封存链无法验证；本轮另用含封存原件的工程备份单独演练，两次结论分开记录。
- 正式入口的三次驱动自检中断运行（`2d193d11…`、`b31cc09f…`、`b9f69705…`）同样被正常恢复到 completed，
  但不作为本轮证据，只作过程记录。
- 本轮工作区里同时存在别人的未提交改动（`packages/control-plane/src/chat.ts`、控制台 chat 页面等），
  与本轮交付无关，未提交、未计入证据。

---

## 上一轮（第六轮）记录（保留备查）

## 1. 三个可验证结果

| # | 结果 | 状态 | 证据 |
| --- | --- | --- | --- |
| 1 | 普通操作员从正常入口完成一笔跨日委托（模拟流程），且业务差异可由原始材料算出 | ✅ | 运行 `engagement-1795354631468`（80 步，mock）；运行 `business-1795354653869`（34 步，非 mock 核算）；两份清单 `pnpm verify:acceptance` 全部通过 |
| 2 | GitHub `Sycun/GongYuAI` 收到本轮代码提交 | ✅ | 受验代码 `d7c46d4956246ba448b565136683daf155af1c62`（[提交](https://github.com/Sycun/GongYuAI/commit/d7c46d4956246ba448b565136683daf155af1c62)）；`git ls-remote origin refs/heads/main` 与推送结果一致（回执见 §8） |
| 3 | Kali 用该代码完整替换旧程序目录、正式入口验收、旧目录清理 | ✅ | `/home/parallels/GongYuAI`，运行版本 `d7c46d4`（HEAD 已随两个文档提交前进到 `aece9c7`，非 docs 差异为 0），14 个任务（13 历史 + 本轮验收 1）；旧目录 `GongYuAI.old-20261122-213828` 已删除；正式入口读数见 §8 |

## 2. 提交

| 项 | 值 |
| --- | --- |
| 仓库 | https://github.com/Sycun/GongYuAI |
| 分支 | `main` |
| **受验代码提交** | `d7c46d4956246ba448b565136683daf155af1c62`（本轮全部代码、测试、脚本、验收夹具；构建/单测/冒烟/两套验收/恢复演练都在这棵树上跑） |
| 记录提交（docs） | 本文件所在提交，父提交为受验代码；`git diff d7c46d4 HEAD -- ':!docs'` 为空 |
| 发布回执 | `docs/evidence/release/receipt.json`（三端读数 + 时间戳，独立提交追加） |
| 排除 | `.env`、`.gongyuai/`、`node_modules/`、`dist/`、`out/`、构建缓存、28MB 本地 PPTX（已加入 `.gitignore`） |
| 推送方式 | 普通 `git push`，无 force |

受验代码提交的文件范围：16 个修改 + 24 个新增（源码、契约、控制台、测试、脚本、验收夹具、证据），详见 `git show --stat d7c46d4`。

文档提交（相对受验代码只有 `docs/` 差异；完整序列以 `git log --oneline d7c46d4..HEAD` 为准，下表列关键两个）：

| 提交 | 角色 | 文件 |
| --- | --- | --- |
| `abc2485ce703f3695b8634c568e845aaa170c606` | 交付记录 + 台账 + 复核清单 + 验收证据 | 3 改 13 增 |
| `aece9c7374876d8d3aa72e9ba3fa4d2a26ca13fe` | 发布回执（`docs/evidence/release/receipt.json`）与 §8 读数 | 1 改 1 增 |

`git diff --stat d7c46d4 abc2485 -- ':!docs'`、`git diff --stat d7c46d4 aece9c7 -- ':!docs'` 与 `git diff --stat d7c46d4 HEAD -- ':!docs'` 均为空。

## 3. 验收运行与清单（可机器校验）

| 运行 | 类型 | 步骤 | 代码提交 | 记录字节哈希 | 快照字节哈希 | 快照内容封印 | 记分卡 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `engagement-1795354631468` | 普通 API 的**模拟**跨日流程 | 80/80 | `d7c46d4` | `acceptance-manifest.json` 的 `files.recordMd/recordJson` | `2e760951a13e…` | `f05327fc54a2…` | 历史 4/4、当前支持 2/4、归属未知 0、覆盖 已测 1/部分 1/受阻 1/未登记 1 |
| `business-1795354653869` | **业务差异核算**（原始材料） | 34/34 | `d7c46d4` | 同上 | `d4ea92c6e2c1…` | `fcdc2dce4388…` | 历史 2/2、当前 2/2、覆盖 未登记 2 |

- 证据包：`docs/evidence/acceptance/engagement-1795354631468/`、`docs/evidence/acceptance/business-1795354653869/`（记录 md/json、快照、清单、校验回执 `verification.json`）。
- 校验命令：`pnpm verify:acceptance docs/evidence/acceptance/<run>` → 22 项检查全过（见该目录 `verification.json`）。
- **两种哈希分开校验**：内容封印是快照去掉 `sha256` 字段后对 canonical payload 的 sha256；文件字节哈希是快照文件原始字节的 sha256。清单同时记录两者，校验器分别断言，并额外断言二者不相等。
- 反例（交叉配对必须失败）：`docs/evidence/acceptance/cross-pair-rejection.txt` —— 把 `business-1795354653869` 的记录配到 `engagement-1795354631468` 的清单与快照上，7 项失败（任务 ID、快照封印、运行 ID、记录字节哈希等）；两次运行单独都通过。

## 4. 业务验收：从原始材料算差异（输入 / 预期 / 实际 / 逐项比对）

材料只含业务字段，通过 `POST /tasks/:id/evidence` 导入；预期差异由验收端**预先封存**，平台实现全程读不到：

| 项 | 值 |
| --- | --- |
| 原始材料 | `docs/evidence/acceptance/business-fixtures/{baseline.csv,current.csv,current-mutated.csv,config-baseline.json,config-current.json}` |
| 封存预期 | `expected.json`（SHA-256 `9175379b936394c5e2b293b32bdc56556c83f8758d2b951e8d17f222c65eebe7`）+ `SHA256SUMS` |
| 核算入口 | `POST /tasks/:id/reconcile`（CLI `gy reconcile`、控制台「原始材料差异核算」面板同一实现） |

逐项比对结果（详见该运行 `acceptance-record.json` 的 `comparisons` 与 `actual` 字段）：

| 用例 | 预期 | 实际 | 未命中 |
| --- | --- | --- | --- |
| `asset-diff`（原始输入） | 新增 1、移除 1、变更 2、未变 1、缺件 1，共 6 项 | 同上；`app-a-1` 变更 `version 1.4→1.5`（基线第 2 行/当前第 2 行）、`app-a-2` 未变（3/3）、`app-a-3` 移除（第 4 行）、`app-a-5` 变更 `tls required→optional`（5/5）、`app-a-4` 新增（当前第 4 行）、`app-a-6` 缺件（两侧都没有） | 无 |
| `asset-diff-mutated`（只改一个值） | 变更 3、未变 0，`app-a-2` 变为 `version 2.1→2.2` | 同上 | 无 |
| `config-diff`（JSON 对象映射 vs 数组） | 变更 2、未变 1 | `tls.minVersion 1.2→1.3`、`audit.retention 90→180`、`session.timeout` 未变，行号 2/3/4 | 无 |
| `asset-diff-missing`（移除必要材料） | `missingMaterials=["assets/baseline.csv"]`、6 项→5 项全部 `unknown` | `unknown 5/5`、`changed 0`，原因 `baseline-material-missing` | 无 |

两项检验都成立：**只改一个值 → 对应差异随之变化**（`app-a-2` 由未变转为变更，其余项结论不变）；**移除必要材料 → 对应项显示缺件/未知**（不猜结论）。用虚构材料跑通，可认定工程通过；真实生产效果见 §9。

## 5. “当前证据支持”与“实际覆盖”分开

同一份快照在四个入口显示同一组数字（分母相同、采集时点写出）：

| 入口 | 历史通过 | 当前证据支持 | 归属未知 | 人工覆盖 | 采集时点 |
| --- | --- | --- | --- | --- | --- |
| API `GET /tasks/:id/scorecard`、`/snapshot` | 4 / 4 | 2 / 4 | 0 / 4 | 已测 1、部分 1、受阻 1、未测 0、未登记 1 | `capturedAt` 字段 |
| 控制台（报告 Tab「交付记分卡」） | 4 / 4 | 2 / 4 | 0 / 4 | 同上 | 统计时点行 + 实时快照 SHA |
| 导出报告 `/report`（`## 覆盖与当前支持`） | 4 / 4 | 2 / 4 | 0 / 4 | 同上 | 统计时点行 |
| 交付摘要 `/delivery`（`## 记分卡`） | 4 / 4 | 2 / 4 | 0 / 4 | 同上 | 统计时点行 |

- 覆盖意见全部从正常入口 `POST /tasks/:id/coverage` 登记（署名 + 依据 + 证据哈希）：已测、部分覆盖、受阻各 1 条；甲系统目标**故意不登记**，它已有附件（配置基线 + 发现证据）——四个入口都显示“未登记”，证明“有附件 ≠ 覆盖已知”。
- 另保留一例“覆盖充分、零发现”：乙系统 `tested` + 0 条发现，报告写成“在本次检查范围内未检出（人工覆盖：已测；关联发现 0 条……）”。
- 同一份快照重复复算逐字节相同（`coverage-support.test.ts` 与贯穿样例各断言一次）。
- 控制台视觉证据：`docs/evidence/ui/20261122-scorecard-card.png`。

## 6. A3 双写入方并发

`packages/history/src/a3-concurrency.test.ts`（4 例，全部通过），保留原有单 store 顺序用例作为对照：

| 用例 | 写入方 | 同步点 | 断言 |
| --- | --- | --- | --- |
| 并发 1 | 两个独立 `openHistory`（同一库文件） | 撤回事务提交后再断言 | 首次通过不成立；`goal_findings`/`goal_proofs`/`goal_asserted` 均为 0（没有半写入） |
| 并发 2 | 两个独立进程（`scripts/a3-writer.ts`） | 撤回进程写标记文件，断言进程等标记后才打开事务 | 跨进程同样不得通过；事件与归属行仍为 0 |
| 并发 3 | 两个独立进程 | 断言进程写标记，撤回进程等标记后才撤回 | 首次通过保留；冻结的 Finding ID 与证据版本完整；`readProofVersion` 可回读；当前结论变为 `supported-by-retracted-only`；重复断言不产生第二条通过记录 |
| 并发 4 | 另一连接撤回 | 断言后依次撤回两条独立依据 | 撤一条仍支持（`retractedReferences=1`）；撤两条才失守；归属行 2、事件各 1 |

## 7. Kali 真实备份的隔离恢复

详见 `docs/evidence/restore/20261122-kali-backup/README.md`（含 `drill.log`）。要点：

- 备份：`/home/parallels/gongyuai-data-backup-20261122-202154.tar.gz`，21,217,525 字节，SHA-256 `cef807d98dc0567b2ff8fa58764c9a295ae6965465bfc938c60d8e24a89d1925`；只解 `.gongyuai`，未解 `.env`/`tmp`。
- 隔离：`/tmp/gy-restore-ecec`，仅回环 `127.0.0.1:18877`，禁用模型外发（`env -u OPENAI_API_KEY -u OPENAI_BASE_URL -u GY_MODEL`）与自动续跑（`GY_WATCHDOG_MS=86400000`）；正式实例全程未受影响（MainPID、cwd、任务数不变）。
- 结果：11 个任务 ID 与备份内 `control.sqlite` 完全一致；`kali-demo` 2/2 历史通过；证据原件（`recon/banner.txt`、`goals/report.md`）API 字节 = 磁盘字节；历史报告 API 字节 = 磁盘字节（`df3b63ad…`）；快照封印与离线复算一致（`b827ac83…`，`sealValid=true`）。
- **验证上限**：备份时点所有任务 `goal_proofs=0`、`evidence_versions=0`、无 `report-evidence/`，因此“封存原件 ↔ 交付记录同源”这一层无法核对；能核对的是字节一致与可复算。这是“原备份验证”，不是新备份演练。
- 切换后新增、不在备份内的任务：`9aa06c00…`（kali-deploy-acceptance）、`c459008e…`（kali-pause-resume-acceptance），以及本轮 `59252500…`（kali-release-acceptance）。

## 8. Kali 正式入口复验（受验代码 `d7c46d4`）

| 项 | 值 |
| --- | --- |
| 主机 | `10.211.55.5`（kali-linux-2025-2，aarch64，SSH `parallels`） |
| 正式目录 | `/home/parallels/GongYuAI`（完整新目录，`git clone` 自 `git bundle`，SHA 一致） |
| 运行版本 | 运行代码 = `d7c46d4956246ba448b565136683daf155af1c62`（HEAD 随文档提交前进）；监听进程 cwd = `/home/parallels/GongYuAI` |
| 依赖与构建 | Kali 本机 `pnpm install --frozen-lockfile` + `pnpm -r run build`（未复制 macOS 依赖） |
| 数据与配置 | 切换前另取保护备份 `gongyuai-data-backup-20261122-213828.tar.gz`（21,305,901 字节，SHA-256 `b488916f…`），再复制 `.env` 与 `.gongyuai` 到新目录后切换 |
| 切换 | 目录对调 → 终止旧主进程 → 新目录起服务（本轮 sudo 需密码，`systemd` 单元由 `Restart=on-failure` 未能自动重启，改用 `setsid nohup pnpm gy serve`；单元 `enabled`，重启机器即回到 systemd 托管；恢复托管的命令见 §10） |
| 旧程序目录 | `GongYuAI.old-20261122-213828` → 已删除（删除前确认无进程 cwd、无单元引用、无 dataDir 引用） |
| 未触碰 | `/home/parallels/GongYuAI-hosted-build`（属主 UID 501，归属未确认，未删除）；`CyberStrikeAI` 未触碰 |
| 正式入口验收 | 历史任务 13 个可读（11 个备份时点任务 + 2 个切换后任务）；新建 `kali-release-acceptance`（`59252500…`）completed，2/2；原始清单差异：新增 1、移除 1、变更 2、未变 1、缺件 1，与封存预期逐项一致；覆盖登记 `tested`（证据 SHA `d82cb930…`），记分卡 `已测 1 · 未登记 1`；报告含 `## 覆盖与当前支持` 与“未检出”口径；离线复算 `sealValid=true`（封印 `9354f3ff…`）；浏览器在 `http://10.211.55.5:8877` 读取报告 Tab |
| 控制台资源 | 服务端返回 `assets/index-DgoApZO2.js`，对应文件存在于 `packages/control-plane/web/assets/` |

正式入口视觉证据：`docs/evidence/ui/20261122-kali-official-entry.png`。

**带时间戳的发布回执**：`docs/evidence/release/receipt.json`（采集时间 `2026-11-22T13:40:54Z` / 21:40:54+08:00）。三端读数：

| 端 | 读数 |
| --- | --- |
| 受验代码 | `d7c46d4956246ba448b565136683daf155af1c62`（构建/测试/两套验收/恢复演练都在此提交） |
| GitHub `main` | `abc2485ce703f3695b8634c568e845aaa170c606`（记录提交；相对受验代码非 docs 差异为 0） |
| Kali 实际运行 | 目录 `/home/parallels/GongYuAI`、运行版本 `d7c46d4…`；HEAD 在回执采集时为 `abc2485…`，随后拉到回执提交 `aece9c7…`（两次都只有 docs 差异）；监听进程 cwd 同目录、health `{"ok":true}`、任务 14 个 |

回执提交（本文件所在提交之后的第三个提交）只追加 `receipt.json` 与本节读数；两个文档提交相对受验代码都只有 `docs/` 差异（`git diff --stat d7c46d4 HEAD -- ':!docs'` 为空）。

## 9. 阶段签收摘要

七个阶段的用户操作、入口、预期、实际、证据与剩余差距见 [implementation-ledger.md](./implementation-ledger.md) §2。签收状态：

- **已验证**：阶段 5（含本轮补通的客户复测申请、同一委托内跨任务署名复核）。
- **部分验证**：阶段 1、2、3、4、7（逐条差距见台账 §2.1）。
- **未实现**：阶段 6（全局记忆、客户隔离、评测隔离）。
- **缺外部材料**：生产盲评 —— 需要获准的脱敏历史委托 + 独立人工底稿，缺任一项即写“生产盲评待验证”。

生产盲评具体缺件：

1. 一份已人工结项、已脱敏、并获准用于本次验收的历史委托（含材料先后顺序、范围修订、中途交接点）；
2. 该委托的独立人工底稿（覆盖、未验证项、已撤回结论、遗留事项）；
3. 客户对“用该委托做验收”的书面确认。

上述任一缺失时，不用工程夹具、演示页面或模型生成的答案替代人工底稿。

## 10. 独立复核（最短路径）

完整清单见 [review-checklist.md](./review-checklist.md)；本轮最小集：

1. `git ls-remote origin refs/heads/main` 对照受验代码与记录提交。
2. `pnpm install --frozen-lockfile && pnpm -r run build && pnpm -r run test && pnpm test:acceptance && pnpm smoke`（期望 126 + 2 通过、smoke PASS）。
3. `pnpm verify:acceptance docs/evidence/acceptance/engagement-1795354631468` 与 `…/business-1795354653869`（各 22 项全过）；再跑一次交叉配对（`--record` 指向另一次运行）必须失败。
4. `pnpm acceptance:business` 复跑业务验收：先核对 `expected.json` 封存哈希，再逐项比对。
5. `gy scorecard --recompute <snapshot>`：`sealValid=true`，分子分母与清单一致。
6. Kali：`readlink /proc/<pid>/cwd`、`git -C /home/parallels/GongYuAI rev-parse HEAD`、`curl :8877/health`、`curl :8877/tasks`（14 个）；确认 `GongYuAI.old-*` 不存在、两份备份 tar 权限 0600。
7. 恢复托管（需人工执行，sudo 需要密码）：
   ```bash
   pkill -f "gy serve --host 0.0.0.0 --port 8877" && sudo systemctl restart gongyuai.service
   ```

## 11. 独立复核结论与处置

### 第一轮（2026-11-22，基线 `907cb63`）

确认 GitHub 三方 SHA 一致、smoke 通过、A1–A5 与阶段 2 实现符合契约、Kali 服务/目录/备份/任务数/旧目录清理与记录一致。Important 项处置见下表（I1–I5、M1–M7），复验基线 `6e1db7a`。

| 项 | 处置 |
| --- | --- |
| I1 快照 hash 与交付件不对应 | `/snapshot` 改为对同一次快照做纯函数记分卡；本轮进一步用清单 + 校验器固定“记录↔快照↔记分卡”三者同源 |
| I2 交付记录 Kali HEAD 过期 | 本轮改为“受验代码 / 记录提交 / 实际运行版本”三行并附回执 |
| I3 首次通过后无法重新归属 | 明确为首次通过时冻结归属；`a3-concurrency.test.ts` 并发 3/4 复核该语义 |
| I4 归属未知计入当前支持 | `unknown-attribution` 为 `currentSupported=false`；A4 夹具断言 0 |
| I5 阶段 2 无单测 | `pause-scope.test.ts` |

### 第二轮（本轮，基线 `04c798b`）

复核指出：验收记录串用了不同运行；缺少从原始材料出发的业务验收；覆盖与支持未分列；A3 只有单写入方顺序用例；备份恢复未验证到真实备份；阶段签收与台账不符。逐项处置：

| 项 | 处置 | 证据 |
| --- | --- | --- |
| 验收记录串用不同运行 | 旧运行 `engagement-1795350021687` 的记分卡哈希 `027c4f06…` 与快照内哈希 `5989425c…` 不一致（两次 `/scorecard`、`/snapshot` 各自取时）——保留为回归对照；本轮 `/snapshot` 一次生成并落盘，清单 + 校验器固定同源，另加交叉配对反例 | §3；`scripts/acceptance-verify.ts` |
| 缺业务验收 | 新增 `reconcile` 纯函数与三个入口（API/CLI/控制台），业务验收 34 步 | §4 |
| 覆盖与支持未分列 | 记分卡加 `denominator` 与 `unregistered`，四入口同源，五类互斥 | §5 |
| A3 只有顺序用例 | 新增两个连接 + 两个进程的并发用例 | §6 |
| 备份未验到真实备份 | 用 Kali 真实备份做隔离恢复，写明上限 | §7 |
| 阶段签收不符 | 台账 §2 逐阶段列入口与实测，阶段 5 补通两个入口 | §9、台账 §2.1 |
### 第三轮（本轮，受验代码 `f34cc032…`）

复核记录：[`out/independent-review-6ef71f9-20261122-215318/review.md`](../out/independent-review-6ef71f9-20261122-215318/review.md)
（复核人在 126 项单测、80 步流程、34 步业务验收全绿之后仍找到的反例）。逐项处置：

| 复核项 | 反例（复核人实测） | 处置 | 本轮证据 |
| --- | --- | --- | --- |
| 缺件仍判通过 | 只交当前清单 → 核算 `unknown=1`，任务却 `completed`、当前支持 1/1 | 目标级 `reconcileGate`：两侧材料都要读到、未知/歧义不得超限、缺哪份点名哪份；通过只认实际采用的核算文件；拒绝进事件台账；`incomplete` 可从 `/resume` 重新判定 | 业务验收第 3、11 段（缺件阶段当前支持 0/3、报告写缺件、首次通过依据 1 条）；正式入口 `497126a0…` 同形复演 |
| 恢复副本读回正式目录 | 备份 11 个任务 dataDir 全指正式目录；副本启动后 API 读回正式 5/15 | `ControlStore` 启动时按 `(dataRoot, taskId)` 收回归属并改写副本；越界拒绝猜测；副本 JSON 旧路径同批改写；`isolated` 启动不导入旧根、不起 watchdog | `data-root.test.ts` 4 例；`pnpm restore:selftest` 20 项；Kali 原备份演练 4/14 vs 正式 5/15 |
| 校验器只做 40 位十六进制检查 | 改全零 SHA / 改 dirty / 改已测数，三次仍全部通过 | 提交要真实 Git 对象且等于受验提交或冻结记录；`dirty` 拦截；覆盖数逐字段复算；三向比对；失败步骤拦截 | `verify-acceptance.test.ts` 8 例；`validator-negatives.txt` 五例非零退出；`cross-pair-rejection.txt` 9 项失败 |
| 重复主键覆盖 + 行号偏移 | 冲突重复主键被压成“未变”；空行使来源行号偏移 | 重复键在差异计算前处理（冲突标歧义并列出全部来源行、内容相同收敛）；CSV 用物理行号，支持 CRLF/引号/跨行并拒绝未闭合引号 | `reconcile.test.ts` 13 例；业务验收第 7–10 段 |
| 服务未由 systemd 托管 | `gongyuai.service` inactive/dead、MainPID=0，8877 由用户会话进程持有 | 先核对现场 → 停用户监听并交 systemd（失败即回退）→ 单元文件改指新目录 → 重启与 kill -9 故障恢复各自验证 | `docs/evidence/service/`（切换 22:04、重启 22:05、故障恢复 22:13） |
| 发布与部署 | 上一轮 8877 在线但版本落后、旧程序目录与数据引用关系不清 | 干净副本全量回归 → 普通 push（无 force）→ Kali 新目录本机安装构建 → 迁移配置与数据 → 切换 → 核对为 0 引用后删除旧目录 | 回执 `github`/`kali` 两节；`deploy-prepare.txt`/`deploy-switch.txt` |
| 生产盲评 | — | 仍缺：脱敏历史委托、独立人工底稿、客户书面确认 | 回执 `productionBlindReview` |


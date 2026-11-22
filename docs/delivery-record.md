# 交付记录（Release / Deployment Record）

日期：2026-11-22（Asia/Shanghai）
实施与发布：DSH 实施会话（lead）
状态口径见 [implementation-ledger.md](./implementation-ledger.md) §0；复核最短路径见 [review-checklist.md](./review-checklist.md)。

## 1. 三个可验证结果

| # | 结果 | 状态 | 证据 |
| --- | --- | --- | --- |
| 1 | 普通操作员从正常入口完成一笔跨日委托（模拟流程），且业务差异可由原始材料算出 | ✅ | 运行 `engagement-1795354631468`（80 步，mock）；运行 `business-1795354653869`（34 步，非 mock 核算）；两份清单 `pnpm verify:acceptance` 全部通过 |
| 2 | GitHub `Sycun/GongYuAI` 收到本轮代码提交 | ✅ | 受验代码 `d7c46d4956246ba448b565136683daf155af1c62`（[提交](https://github.com/Sycun/GongYuAI/commit/d7c46d4956246ba448b565136683daf155af1c62)）；`git ls-remote origin refs/heads/main` 与推送结果一致（回执见 §8） |
| 3 | Kali 用该代码完整替换旧程序目录、正式入口验收、旧目录清理 | ✅ | `/home/parallels/GongYuAI`，HEAD `d7c46d4`，14 个任务（13 历史 + 本轮验收 1）；旧目录 `GongYuAI.old-20261122-213828` 已删除；正式入口读数见 §8 |

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

受验代码提交的文件范围：17 个修改 + 18 个新增（源码、契约、控制台、测试、脚本、验收夹具、证据），详见 `git show --stat d7c46d4`。

## 3. 验收运行与清单（可机器校验）

| 运行 | 类型 | 步骤 | 代码提交 | 记录字节哈希 | 快照字节哈希 | 快照内容封印 | 记分卡 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `engagement-1795354631468` | 普通 API 的**模拟**跨日流程 | 80/80 | `d7c46d4` | `acceptance-manifest.json` 的 `files.recordMd/recordJson` | `2e760951a13e…` | `f05327fc54a2…` | 历史 4/4、当前支持 2/4、归属未知 0、覆盖 已测 1/部分 1/受阻 1/未登记 1 |
| `business-1795354653869` | **业务差异核算**（原始材料） | 34/34 | `d7c46d4` | 同上 | `d4ea92c6e2c1…` | `fcdc2dce4388…` | 历史 2/2、当前 2/2、覆盖 未登记 2 |

- 证据包：`docs/evidence/acceptance/engagement-1795354631468/`、`docs/evidence/acceptance/business-1795354653869/`（记录 md/json、快照、清单、校验回执 `verification.json`）。
- 校验命令：`pnpm verify:acceptance docs/evidence/acceptance/<run>` → 23 项检查全过。
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
| 运行版本 | HEAD `d7c46d4956246ba448b565136683daf155af1c62`；监听进程 cwd = `/home/parallels/GongYuAI` |
| 依赖与构建 | Kali 本机 `pnpm install --frozen-lockfile` + `pnpm -r run build`（未复制 macOS 依赖） |
| 数据与配置 | 切换前另取保护备份 `gongyuai-data-backup-20261122-213828.tar.gz`（21,305,901 字节，SHA-256 `b488916f…`），再复制 `.env` 与 `.gongyuai` 到新目录后切换 |
| 切换 | 目录对调 → 终止旧主进程 → 新目录起服务（本轮 sudo 需密码，`systemd` 单元由 `Restart=on-failure` 未能自动重启，改用 `setsid nohup pnpm gy serve`；单元 `enabled`，重启机器即回到 systemd 托管；恢复托管的命令见 §10） |
| 旧程序目录 | `GongYuAI.old-20261122-213828` → 已删除（删除前确认无进程 cwd、无单元引用、无 dataDir 引用） |
| 未触碰 | `/home/parallels/GongYuAI-hosted-build`（属主 UID 501，归属未确认，未删除）；`CyberStrikeAI` 未触碰 |
| 正式入口验收 | 历史任务 13 个可读（11 个备份时点任务 + 2 个切换后任务）；新建 `kali-release-acceptance`（`59252500…`）completed，2/2；原始清单差异：新增 1、移除 1、变更 2、未变 1、缺件 1，与封存预期逐项一致；覆盖登记 `tested`（证据 SHA `d82cb930…`），记分卡 `已测 1 · 未登记 1`；报告含 `## 覆盖与当前支持` 与“未检出”口径；离线复算 `sealValid=true`（封印 `9354f3ff…`）；浏览器在 `http://10.211.55.5:8877` 读取报告 Tab |
| 控制台资源 | 服务端返回 `assets/index-DgoApZO2.js`，对应文件存在于 `packages/control-plane/web/assets/` |

正式入口视觉证据：`docs/evidence/ui/20261122-kali-official-entry.png`。
三端读数与时间戳：`docs/evidence/release/receipt.json`（受验代码 SHA、GitHub main SHA、Kali HEAD 与运行读数）。

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
3. `pnpm verify:acceptance docs/evidence/acceptance/engagement-1795354631468` 与 `…/business-1795354653869`（23 项全过）；再跑一次交叉配对（`--record` 指向另一次运行）必须失败。
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

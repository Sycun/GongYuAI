# 实施台账（Implementation Ledger）

> 面向独立复核人：本文件把 P0–P12 与七个阶段映射到**实际代码、正常用户入口、测试证据、本轮实际走查结果与剩余差距**，并区分「文档已设计 / 代码已实现 / 入口已走查 / 真实委托已验证 / 缺外部材料」。
> 本轮基线：上轮复核修复 `6c6bebd` + 文档 `04c798b`；本轮发布 `d7c46d4…`（代码）。验收运行与哈希见 [delivery-record.md](./delivery-record.md) 与 `docs/evidence/acceptance/`。

## 0. 签收状态口径（全文统一）

| 标记 | 含义 |
| --- | --- |
| **已验证** | 有代码，且本轮从正常入口实际走查通过，证据可回查 |
| **部分验证** | 主路径走查通过，但仍有必需功能未实现或未走查（逐条列出） |
| **未实现** | 尚无入口或实现 |
| **缺外部材料** | 工程侧就绪，但需要获准的脱敏委托 / 独立人工底稿才能判定 |

## 1. P0–P12 映射

| 级 | 能力 | 代码落点 | 正常入口 | 证据 | 状态 |
| --- | --- | --- | --- | --- | --- |
| P0 | Fact append-only / `sourceFactIds` / conclude 回写 | `packages/history/src/index.ts`、`packages/contracts/src/index.ts` | worker 工具、`GET /tasks/:id/history` | `history.test.ts`（claim CAS、无因拒绝、Goal 无文件不通过） | 已验证 |
| P1 | Session Relay πₙ + 双触发 | `packages/worker/src/relay.ts`、`pi-loop.ts` | `GY_RELAY_*`、smoke | `pnpm smoke` 写出 π；`relay.test.ts` | 已验证 |
| P2 | 图驱动调度 Bootstrap/Explore/Reason | `packages/worker/src/graph-phase.ts`、`checkpoint.ts` | mock/pi worker | `graph-phase.test.ts`、smoke 相位 | 已验证 |
| P3 | 能力阶梯 + 离线差分 | `packages/worker/src/tools.ts`、`offline-differential.ts` | `gy run --capability`、`pnpm diff-harness:offline` | `offline-differential.test.ts` | 已验证 |
| P4 | 可选并发 3–10 + Hint + 同族迁移 | `runner.ts`、`contracts/fanout.ts` | 建档 `execution.maxConcurrentExplores`、`gy hint` | `runner-scale.test.ts`；贯穿样例以 3 启动 | 已验证 |
| P5 | 证据邻域 / 预算尽报告 / 工具单闸 | history drill、`report.ts`、`tools.ts` gate | `history_read_fact`、报告、`tool_gate` 事件 | `tools.test.ts`、`soft-pace.test.ts` | 已验证 |
| P6-E1 | Finding 一等公民 + findingsGate | `contracts/finding.ts`、`history findings`、worker 工具 | worker `finding_*`、控制台漏洞 Tab | `findings.test.ts`、smoke gate 两例 | 已验证 |
| P6-E1+ | 目标级发现归属（A1/A3/A5） | `resolveGateAssets`/`findingAssetInScope`、`goal_findings` | 建档 `assets` + `findingsGate.scope/assets` | `delivery-assurance.test.ts` A1/A1+/A3/A5；`a3-concurrency.test.ts` | 已验证 |
| P6-E2/E3/E4 | 凭据结构、HTTP 事务证据、覆盖矩阵 | — | — | — | 未实现 |
| P7 | 三层模型路由 / 偏航审计者 | — | — | — | 未实现 |
| P8 | 项目记忆 ✅ / 全局记忆与隔离 | 项目记忆=`history`+Relay+证据；全局记忆无 | — | — | 未实现（仅项目层） |
| P9-F1 | 交付记分卡 + 可复算快照 + 覆盖五类 | `packages/history/src/scorecard.ts` | `GET /tasks/:id/scorecard|snapshot`、`gy scorecard --out/--recompute`、控制台交付记分卡 | A4/A5；`coverage-support.test.ts`；贯穿样例 4/4·2/4 | 已验证 |
| P9-F2/F3 | 趋势看板 / 提案收件箱 / 自动化 | — | — | — | 未实现 |
| P10 | DAG 控制台 ✅；资产/攻击面/执行/记忆四图 | `apps/console` DAG、assets Tab | 控制台任务详情 | 控制台构建 + 本轮报告页实跑 | 部分验证（仅 DAG+资产） |
| P11-S1/S2 | 会话保活、后台作业异步回流、`operator_consult` | 无作业/咨询；暂停恢复已实现 | — | `pause-scope.test.ts` | 部分验证（仅暂停/恢复/范围版本） |
| P11-S3/S4 | 隧道/pivot、开源 Chromium、速率自判 | — | — | — | 未实现 |
| P12 | D1/D2/D3/D5/D6/D8/攻击链图 | — | — | — | 未实现 |
| 交付可信度 | **A1–A5 + 同名附件 + 基准兼容** | 见 P6-E1+ / P9-F1 / 报告与更正 | 控制台交付页、`gy scorecard`、`gy correct` | `delivery-assurance.test.ts`、`a3-concurrency.test.ts` | 已验证 |
| 阶段 2 | **暂停/恢复/范围版本/未知外部状态** | `runner.pause/resume/setScope`、`TaskStatus`、`/runtime` | `POST /tasks/:id/pause|resume|scope`；控制台按钮 | 贯穿样例：暂停确认、检查点留存、v2 生效、跨日无重复通过；`pause-scope.test.ts` | 部分验证 |
| 阶段 5 | **整改复测 / 客户风险处置 / 交付更正 / 客户复测申请 / 跨任务署名复核** | `finding_actions`、`delivery_corrections`、`retest_requests`、`peer_reviews`、report 版本留存 | `gy retest`/`accept`/`correct`/`retest-request`/`peer-review`；控制台报告页 | 贯穿样例末段实跑；`api-entries.test.ts` | 已验证 |
| 本轮新增 | **原始材料差异核算** | `packages/contracts/src/reconcile.ts`、`packages/control-plane/src/reconcile.ts` | `POST/GET /tasks/:id/reconcile`、`gy reconcile`、控制台「原始材料差异核算」面板 | `reconcile.test.ts`、`business-acceptance.ts`（34 项）、控制台实跑 | 已验证（虚构材料） |
| 本轮新增 | **验收清单与校验器** | `scripts/acceptance-manifest.ts`、`scripts/acceptance-verify.ts` | `pnpm verify:acceptance <dir>` | `verify-acceptance.test.ts`（交叉配对反例）、两份清单校验通过 | 已验证 |

## 2. 阶段 1–7 签收

状态列按 §0 口径。入口列只写**普通用户能走的入口**；「实际」列是本轮真正执行过的结果，未执行的一律不计入已验证。

| 阶段 | 用户操作 | 正常入口 | 预期 | 实际（本轮执行） | 证据路径 | 剩余差距 | 状态 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 生产委托与实际作业 | 建档 → 导入原始材料 → 按判据验收 → 交付 | 控制台/`POST /tasks`、`POST /tasks/:id/evidence`、`POST /tasks/:id/reconcile`；worker 断言 | 材料满足判据才通过；缺件不通过；差异必须从原始记录算出 | 模拟跨日流程 80 步（首日 3/4 → 次日补齐）；业务验收 34 步：两份 CSV + 两份 JSON 算差异、单值变更改变差异、删材料降级为未知，两目标由核算结果满足 2/2 | `docs/evidence/acceptance/engagement-1795354631468/`、`docs/evidence/acceptance/business-1795354653869/`、`packages/contracts/src/reconcile.test.ts` | 真实客户材料下的判据设计与盲评（缺外部材料） | 部分验证 |
| 2 跨日/并发/接手 | 暂停 → 改范围 → 换班 → 恢复；并发写入 | `POST /tasks/:id/pause|resume|scope`；两个独立连接/进程同时写同一库 | 撤回先提交则首次结论不成立；首次通过先提交则依据保留；不重复记账 | 贯穿样例：暂停确认、检查点留存、v2 生效、跨日无重复通过；A3 并发 4 例（两连接 + 两进程 + 独立依据） | `packages/history/src/a3-concurrency.test.ts`、`packages/history/src/pause-scope.test.ts` | 后台作业异步回流、24h 咨询转非阻塞、外部状态“未知”的真实供应商故障演练（未实现） | 部分验证 |
| 3 证据/发现/复核 | 登记覆盖、看记分卡、撤回与更正、导出报告 | `POST /tasks/:id/coverage`、`GET /scorecard|snapshot|report`、`gy scorecard` | 历史通过 / 当前支持 / 人工覆盖分开报；同快照复算一致 | 四类覆盖意见（已测/部分覆盖/受阻/未登记）在 API、快照、报告、交付摘要、控制台逐处一致；同一快照重复复算逐字节相同；零发现且覆盖充分写成“未检出” | `packages/control-plane/src/coverage-support.test.ts`、`docs/evidence/ui/20261122-scorecard-card.png` | 真实委托盲评（缺外部材料） | 部分验证 |
| 4 日常控制台与图 | 在控制台看任务、目标、证据、报告、记分卡、跑差异 | 控制台任务详情 7 个 Tab | 交付指标与差异结果在控制台可见、可操作 | 报告 Tab 实跑：记分卡（分母 4、4/4、2/4、归属未知 0、覆盖 已测 1/部分 1/受阻 1/未登记 1、统计时点、快照 SHA-256）+ 差异面板实算 3 项（新增 2、移除 1，定位到来源行） | `docs/evidence/ui/20261122-console-report-tab.png` | “今天要做什么”首页、四图（资产/攻击面/执行/记忆）、因果链下钻（未实现） | 部分验证 |
| 5 整改/复测/交付 | 客户发起复测、操作员复测、客户风险处置、撤回→更正→通知、跨任务署名复核 | `gy retest`/`accept`/`correct`/`retest-request`/`peer-review`、控制台报告页、`POST /tasks/:id/retest-requests|peer-reviews` | 申请有署名与依据、复测后关闭；跨任务复核限同委托；历史只追加 | 贯穿样例实跑：客户复测申请（依据带 SHA-256）→ 复测 partially-fixed → 申请 fulfilled；同委托另一任务复核 201、跨委托 409、被拒记录不写入；报告与交付摘要刷新后含两段 | `scripts/engagement-e2e.ts`（80 步里 13 步属阶段 5）、`packages/control-plane/src/api-entries.test.ts` | 无（人工底稿由客户提供，不属于工程入口） | 已验证 |
| 6 两层记忆与飞轮 | 跨项目复用记忆 | — | 记忆隔离、留出集评测 | 仅项目级 History + F1 记分卡；全局记忆、客户隔离、历史接触面板、评测隔离均未实现 | `docs/memory-layer.md`、`docs/data-flywheel.md`（设计） | 全部（未实现） | 未实现 |
| 7 生产运维与准入 | 健康/看门狗/备份恢复/发布切换 | `systemd` 单元、`gy serve`、`scripts/parallels/redeploy.sh`、`pnpm drill:restore` | 备份可恢复、迁移可读、切换可回退 | 本地 `pnpm drill:restore` PASS；Kali 用真实备份隔离恢复（11 任务、证据/报告哈希一致、离线复算 sealValid）；新版本读取旧备份 11 任务全部可读 | `docs/evidence/restore/20261122-kali-backup/README.md`、`drill.log` | 供应商故障注入、容量/费用预测（未实现）；真实生产盲评（缺外部材料） | 部分验证 |

### 2.1 台账里“已完成但仍列有必需功能”的逐项处置

| 台账条目 | 原先写的必需功能 | 本轮处置 |
| --- | --- | --- |
| 阶段 5（原标 ✅） | 客户自助发起复测申请入口、跨任务署名 | **已补通**：`retest_requests` + `peer_reviews` 表与入口；贯穿样例实跑，含跨委托拒绝；状态改为“已验证” |
| 阶段 3（原标 ✅） | 真实委托盲评 | 盲评仍需外部材料，状态降为“部分验证”，并单列“生产盲评待验证” |
| 阶段 1（原标 ✅） | 客户真实材料 | 业务核算已可认定，但真实材料判据未验证；状态降为“部分验证” |
| 阶段 2（原标 🔨） | 作业回流、24h 咨询、供应商故障 | 仍未实现，状态保持“部分验证”，逐条列出 |
| 阶段 4（原标 🔨） | 今日首页、四图、因果链 | 仍未实现；本轮补了控制台交付记分卡与差异面板 |
| 阶段 6（原标 📐） | 全局记忆/隔离/评测 | 未实现 |
| 阶段 7（原标 🔨） | 故障注入、容量预测、生产盲评 | 故障注入/容量预测未实现；备份恢复本轮加深到真实备份；生产盲评缺外部材料 |

## 3. 本轮工程证据（受验代码 `d7c46d4956246ba448b565136683daf155af1c62`）

| 项 | 命令 | 结果 |
| --- | --- | --- |
| 构建 | `pnpm -r run build` | exit 0（6 个含 build 脚本的 workspace 项目 + 控制台） |
| 单测 | `pnpm -r run test` | **126 通过 / 0 失败**（contracts 28、history 35、control-plane 28、worker 35） |
| 校验器测试 | `pnpm test:acceptance` | 2 通过（交叉配对必须失败；改字节不改封印） |
| 冒烟 | `pnpm smoke` | PASS（findings gate 失败臂、墙钟收卷、证据边界） |
| 模拟跨日流程 | `pnpm e2e:engagement` | **80/80 通过**（运行 `engagement-1795354631468`） |
| 业务差异验收 | `pnpm acceptance:business` | **34/34 通过**（运行 `business-1795354653869`） |
| 清单校验 | `pnpm verify:acceptance <dir>` | 两次运行各自全部通过；交叉配对 7 项失败（反例成立） |
| 恢复演练（本机） | `pnpm drill:restore` | PASS（事实/发现/证据/报告/记分卡均可读） |
| 恢复演练（Kali 真实备份） | 见 `docs/evidence/restore/20261122-kali-backup/` | 11 个任务可读；证据/报告哈希一致；离线复算通过；封存版不可验（上限已写明） |

### 3.1 模拟跨日流程（明确标记为 mock）

- 该流程用 **mock worker**，材料由模拟 Worker 按目标判据生成；它证明的是**流程语义**（建档、首日缺件、控制面中断恢复、暂停换班、范围 v2、无重复记账、撤回→更正→通知、覆盖登记、归档），不证明业务核算能力。
- 业务核算能力由 `business-acceptance` 单独验收：材料只含业务字段，预期差异预先封存，实现在运行前读不到预期文件。

### 3.2 如何独立复算一条结论

1. 取 [delivery-record.md](./delivery-record.md) §3 的任务 ID 与验收运行目录。
2. `pnpm verify:acceptance docs/evidence/acceptance/<run>`：核对运行 ID / 任务 ID / 代码提交 / 记录字节哈希 / 快照字节哈希 / 快照内容封印 / 记分卡引用 / 复算数字。
3. `gy scorecard --recompute <snapshot.json>`：纯函数复算 `sealValid` 与分子分母。
4. 下钻：`GET /tasks/<id>/history`、`/evidence/file?path=`、`/report-evidence/<sha256>`；差异核算结果在 facts 里带 `reconcile` 标签。

## 4. 发布记录

| 项 | 值 |
| --- | --- |
| 受验代码提交 | `d7c46d4956246ba448b565136683daf155af1c62`（[GitHub](https://github.com/Sycun/GongYuAI/commit/d7c46d4956246ba448b565136683daf155af1c62)） |
| GitHub 远端 | `main`，推送后 `git ls-remote` 复核一致 |
| 文档提交 | 本文件所在的后续提交（受验代码之后，仅 docs/evidence 差异，见交付记录 §5） |
| Kali | `/home/parallels/GongYuAI`，实际运行版本见交付记录 §6 的发布回执 |
| 详细证据 | [delivery-record.md](./delivery-record.md)、[review-checklist.md](./review-checklist.md) |

## 5. 未纳入与明确排除

- `docs/女娲测试_CCF厦门分享_攻防迭代修订稿.pptx`（28MB）：本地参考材料，已加入 `.gitignore`，不入库。
- `.env`、`.gongyuai/`（任务库/证据/验收运行）、`out/`、`node_modules/`、构建产物：按 `.gitignore` 排除。
- 生产盲评：缺已获准的脱敏历史委托与独立人工底稿，标记「生产盲评待验证」，缺件见交付记录 §7。

# 实施台账（Implementation Ledger）

> 面向独立复核人：本文件把 P0–P12 映射到**实际代码、正常用户入口、测试证据与剩余差距**，并区分「文档已设计 / 代码已实现 / 用户入口已验证 / 真实委托已验证」。  
> 基线：`8e0a641` + 工作区未提交实现（发现契约、台账、文档）。本次实施与发布见文末「发布记录」。

## 0. 状态口径

| 标记 | 含义 |
| --- | --- |
| ✅ 已实现 + 入口已验证 | 有代码、有从正常入口跑的验收记录 |
| 🔨 已实现，入口部分验证 | 代码在，验收只覆盖部分路径 |
| 📐 仅设计 | 文档/提案，未动工 |
| ⏳ 待验证 | 需要真实脱敏委托或独立底稿，工程内无法完成 |

## 1. P0–P12 映射

| 级 | 能力 | 代码落点 | 正常入口 | 证据 | 状态 |
| --- | --- | --- | --- | --- | --- |
| P0 | Fact append-only / `sourceFactIds` / conclude 回写 | `packages/history/src/index.ts`、`packages/contracts/src/index.ts` | worker 工具、`GET /tasks/:id/history` | `history.test.ts`（claim CAS、无因拒绝、Goal 无文件不通过） | ✅ |
| P1 | Session Relay πₙ + 双触发 | `packages/worker/src/relay.ts`、`pi-loop.ts` | `GY_RELAY_*`、smoke | `pnpm smoke` 写出 π；`relay.test.ts` | ✅ |
| P2 | 图驱动调度 Bootstrap/Explore/Reason | `packages/worker/src/graph-phase.ts`、`checkpoint.ts` | mock/pi worker | `graph-phase.test.ts`、smoke 相位 | ✅ |
| P3 | 能力阶梯 + 离线差分 | `packages/worker/src/tools.ts`、`offline-differential.ts` | `gy run --capability`、`pnpm diff-harness:offline` | `offline-differential.test.ts` | ✅ |
| P4 | 可选并发 3–10 + Hint + 同族迁移 | `runner.ts`、`contracts/fanout.ts`、`parallel-explore-scaling.md` | 建档 `execution.maxConcurrentExplores`、`gy hint` | `runner-scale.test.ts`；贯穿样例以 3 启动并按资产收敛 | ✅ |
| P5 | 证据邻域 / 预算尽报告 / 工具单闸 | `history` drill、`report.ts`、`tools.ts` gate | `history_read_fact`、报告、`tool_gate` 事件 | `tools.test.ts`、`soft-pace.test.ts` | ✅ |
| P6-E1 | Finding 一等公民 + findingsGate | `contracts/finding.ts`、`history findings`、worker 工具 | worker `finding_*`、控制台漏洞 Tab | `findings.test.ts`、smoke gate 两例 | ✅ |
| P6-E1+ | **目标级发现归属（A1/A3/A5）** | `resolveGateAssets`/`findingAssetInScope`、`goal_findings`、事务内重读 | 建档 `assets` + `findingsGate.scope/assets` | `delivery-assurance.test.ts` A1/A1+/A3/A5；贯穿样例 4/4→2/4 | ✅ |
| P6-E2/E3/E4 | 凭据结构、HTTP 事务证据、覆盖矩阵 | — | — | — | 📐 |
| P7 | 三层模型路由 / 偏航审计者 | —（仅设计） | — | — | 📐 |
| P8 | 项目记忆 ✅ / 全局记忆与隔离 | 项目记忆=`history`+Relay+证据；全局记忆无 | — | — | 📐（仅项目层） |
| P9-F1 | **交付记分卡 + 可复算快照** | `packages/history/src/scorecard.ts` | `GET /tasks/:id/scorecard|snapshot`、`gy scorecard --out/--recompute` | A4/A5；贯穿样例 `4/4 · 2/4` 两次一致 | ✅ |
| P9-F2/F3 | 趋势看板 / 提案收件箱 / 自动化 | — | — | — | 📐 |
| P10 | DAG 控制台 ✅；资产/攻击面/执行/记忆四图 | `apps/console` DAG、assets Tab | 控制台任务详情 | 控制台构建 + 浏览器验收（见发布记录） | 🔨（仅 DAG+资产） |
| P11-S1/S2 | 会话保活、后台作业异步回流、`operator_consult` | 无作业/咨询；暂停恢复已实现 | — | — | 🔨（仅暂停/恢复/范围版本） |
| P11-S3/S4 | 隧道/pivot、开源 Chromium、速率自判 | — | — | — | 📐 |
| P12 | D1 事实保鲜 / D2 防御反馈 / D3 Provider 韧性 / D5 规划者 / D6 辅助者 / D8 法律级证据 / 攻击链图 | — | — | — | 📐 |
| 交付可信度 | **A1–A5 + 同名附件 + 基准兼容** | 见 P6-E1+ / P9-F1 / 报告与更正 | 控制台交付页、`gy scorecard`、`gy correct` | `delivery-assurance.test.ts`（30 项历史测试含 7 项新增） | ✅ |
| 阶段 2 | **暂停/恢复/范围版本/未知外部状态** | `runner.pause/resume/setScope`、`TaskStatus`、`/runtime` | `POST /tasks/:id/pause|resume|scope`；控制台按钮 | 贯穿样例：暂停确认、检查点留存、v2 生效、跨日无重复通过 | ✅ |
| 阶段 5 | **整改复测 / 客户风险处置 / 交付更正** | `finding_actions`、`delivery_corrections`、report 版本留存 | `gy retest`/`gy accept`/`gy correct`、控制台报告页 | 贯穿样例：retested → accepted → retracted → 更正 #1 → 已通知 | ✅ |

## 2. 阶段 1–7 实际状态

| 阶段 | 状态 | 已验证内容 | 仍缺 |
| --- | --- | --- | --- |
| 1 生产委托与实际作业 | ✅ | 建档、两套系统清单导入、配置基线内容判据、缺件、零发现覆盖目标、显式汇总目标 | 客户真实材料（盲评） |
| 2 跨日/并发/接手 | 🔨 | 控制面中断恢复、暂停确认、范围 v2、恢复读最新授权、无重复记账、3–10 并发配置 | 后台作业异步回流、24h 咨询转非阻塞、外部状态“未知”的真实供应商故障演练 |
| 3 证据/发现/复核 | ✅ | A1–A5、同名附件、基准兼容、撤回顺序、旧档只读、快照复算 | 真实委托盲评 |
| 4 日常控制台与图 | 🔨 | 任务页、资产 Tab、漏洞 Tab、目标/历史、暂停/恢复、交付记分卡 | “今天要做什么”首页、四图（资产/攻击面/执行/记忆）、因果链下钻 |
| 5 整改/复测/交付 | ✅ | 多轮复测记录结构、客户风险处置、更正编号/影响/通知、报告版本留存、归档关闭 | 客户自助发起复测申请入口、跨任务署名 |
| 6 两层记忆与飞轮 | 📐 | 项目记忆（任务级）已有；F1 记分卡已落地 | 全局记忆、客户隔离、历史接触面板、注入、评测隔离 |
| 7 生产运维与准入 | 🔨 | 健康/无进展/看门狗、控制面中断恢复、独立备份还原演练、迁移与回退脚本 | 供应商故障注入、容量/费用预测、真实生产盲评 |

## 3. 工程证据（本次运行）

| 项 | 命令 | 结果 |
| --- | --- | --- |
| 构建 | `pnpm -r run build` | exit 0（7 个 workspace 项目） |
| 单测 | `pnpm -r run test` | contracts 22、history 30、control-plane 20、worker 35，共 107，0 失败 |
| 冒烟 | `pnpm smoke` | PASS（含 findings gate 失败臂、墙钟收卷、证据边界） |
| 贯穿样例 | `GY_MOCK_HOLD_MS=9000 pnpm tsx scripts/engagement-e2e.ts` | 53 项全过；记录见 `.gongyuai/acceptance/<run>/acceptance-record.md` |
| 恢复演练 | `pnpm tsx scripts/restore-drill.ts <数据目录>` | 委托/目标/证据/发现/报告/记分卡全部可读；证据原文可读 |
| 离线差分 | `pnpm diff-harness:offline` | 三组夹具按文档预期 |
| 控制台 | `pnpm --filter @gongyuai/console build` + 浏览器验收 | 构建通过；浏览器见发布记录 |

### 3.1 贯穿样例（两套业务系统）

- 委托：甲乙双系统资产与配置基线评估及整改复核；甲/乙各一组目标，外加显式 task 范围汇总目标。
- 首日：甲专项（发现闸）、乙差异（覆盖型、零发现）、汇总目标通过；整改材料缺件 → 运行中交接。
- 中断与换班：控制面关闭后从同一数据目录恢复；暂停确认；乙系统移出授权（v2）；次日补交材料后恢复完成。
- 整改与交付：复测 `fixed`、线索技术确认、客户接受剩余风险、撤回一条被两个目标引用的发现、生成更正 #1 并置“已通知”、归档关闭。
- 记分卡：曾通过 4/4；当前证据足以支持 2/4；撤回引用 2；快照 SHA-256 见记录文件。

### 3.2 如何独立复算一条结论

1. 在交付记录里取任务 ID 与数据目录。
2. `GET /tasks/<id>/snapshot` 或 `gy scorecard <id> --out snapshot.json` 导出快照。
3. `gy scorecard --recompute snapshot.json`：输出 `sealValid` 与分子/分母；直接读快照里的 `goalFindings`、`findings[].status`、`goal_proofs` 可手工复算。
4. 任一条目下钻：`GET /tasks/<id>/history` 取 Fact/Intent/事件；`/evidence/file?path=` 取原件；`/report-evidence/<sha256>` 取封存版本。

## 4. 发布记录

| 项 | 值 |
| --- | --- |
| 发布提交 | 见 `docs/delivery-record.md`（本文件随发布提交更新） |
| GitHub 远端 | `github.com/Sycun/GongYuAI`，分支 `main` |
| Kali | 10.211.55.5，`/home/parallels/GongYuAI`，`gongyuai.service`，`:8877` |

## 5. 未纳入与明确排除

- 28MB `docs/女娲测试_CCF厦门分享_攻防迭代修订稿.pptx`：本地参考材料，未入库（README 已注明）；文字摘录见 `absorb-sapper-v2-nuwa.md`。
- `.env`、`.gongyuai/`（任务数据库、证据、验收运行）、`out/`、`node_modules/`、构建产物：按仓库 `.gitignore` 排除。
- 生产盲评：缺已获准的脱敏历史委托与独立人工底稿，标记“生产盲评待验证”。

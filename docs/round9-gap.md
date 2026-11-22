# 第九轮后端差距表（草稿）

> **本文分两段读**：§1–§5 是第九轮**开工前**的只读盘点（基线 `298440a`，保留原样，用于对照"当时没有"）；§6 是本轮**实施后**的逐项落点与剩余。两段合起来才是当前状态。
>
> 只读盘点基线：worktree `/Users/sycpro/gongyuai-r9`，分支 `backend/r9-boundary-jobs`，HEAD `298440a`（origin/main）。
> 全部行号取 **HEAD 298440a**（`git grep -n … HEAD`），不取工作树未提交版本。
> 审计期间工作树同时有并行会话在建的**未提交**文件，且交付时仍在增长（交付时 `git status --short` 的新增文件：`packages/contracts/src/ops.ts`、`packages/history/src/{ops.ts,ops.test.ts}`、`packages/control-plane/src/{jobs,handoff,graphs,platform,platform.test,roles,routes-ops}.ts`；修改文件：`apps/cli/src/index.ts`、`packages/contracts|history|control-plane` 的 `index.ts`、`server.ts`、`history/src/report.ts`）—— 本报告**不把它们算作"现有实现"**（未提交、无回归基线、CLI/控制台未接线）。回归读数因此改为在 `git archive HEAD` 的干净副本上取，避免并行写入污染。本报告只新建本文件，未改动其他文件，未提交。

**证据等级**：`已验证`＝代码+测试都在仓库且可跑；`部分验证`＝入口/数据在、但只覆盖设计的一小部分；`未实现`＝全仓 0 命中；`缺外部材料`＝代码在但判定需要仓库外材料。

**方法**：对每条设计项先 `git grep -n <关键词> HEAD -- packages apps`，命中后再读实现与调用点；路由取 `packages/control-plane/src/server.ts`；工具面取 `packages/worker/src/{graph-phase,tools,pi-loop}.ts`；命令取 `apps/cli/src/index.ts`。

---

## 1. 差距表

| 设计编号 | 现有入口（代码位置 + HTTP/CLI） | 现有测试 | 缺的行为（一句可实施） | 本轮阶段 | 通过条件（可执行断言） | 证据等级 |
| --- | --- | --- | --- | --- | --- | --- |
| **P6-E1** Finding 一等公民 | `contracts/src/finding.ts:60` FindingSchema、`:97` FindingsGateSchema；`history/src/index.ts:325` findings 表（`UNIQUE(task_id,dedup_key)`）、`:2220` recordFinding、`:2311` verifyFinding（evidence 目录 + sha256 现场封存 + repro 三闸）、`:2391` retestFinding、`:2448` acceptFinding、`:2498` retractFinding；工具 `worker/src/graph-phase.ts:250/275/295/311`；报告 `history/src/report.ts:118` `## Findings`；路由 `server.ts:431` `GET /tasks/:id/findings`、`:446` `POST …/findings/:id/{verify,retract}`、`:478` `POST …/findings/:id/{retest,accept}`；CLI `apps/cli/src/index.ts:365/391/404/429`；控制台 `apps/console/src/pages/TaskDetailPage.tsx:936` | `contracts/src/finding.test.ts`（生命周期单向/闸/去重键）；`history/src/findings.test.ts`（dedup 幂等、无证据拒 verified、撤回保留）；`scripts/smoke.ts:82-135`（闸拒双臂）、`:157-245`（tentative 不进交付）；`history/src/delivery-assurance.test.ts:259-300`（撤回使首过失效） | 无（唯一延伸项见 P12-D1 的 finding 待复核） | 本轮不做（已可用） | `node --import tsx --test packages/history/src/findings.test.ts` 全绿 + smoke findings-gate 两臂 PASS + 报告不含 tentative | 已验证 |
| **P6-E1+** 目标级归属 / 复核撤回 | `finding.ts:140` resolveGateAssets（缺资产/`assets:["*"]` 直接抛错）、`:163` findingAssetInScope；`history/src/index.ts:1292` assertGoal（`:1360` 取 gateAssets、`:1421` 写 goal_findings）、`:1692` listGoalFindings；跨委托拒绝 `server.ts:674-708`（`:683` 比较 engagementId） | `delivery-assurance.test.ts` A1/A1+/A3/A5；`history/src/a3-concurrency.test.ts`（两连接+两进程） | 撤回 finding 时只写 `finding_retracted`（`index.ts:2509`），**不**产生"目标失去依据/待复核"事件或队列；交付更正必须人工 `POST /tasks/:id/corrections`（`server.ts:579`）才生成 | P1 | 撤回一条曾支撑目标的 finding 后：`GET /tasks/:id/scorecard` 的 `retractedReferences` +1、该 goal verdict = `supported-by-retracted-only`，且 `GET /tasks/:id/history` 出现对应失效事件 | 部分验证 |
| **P6-E2** 凭据 secretRef / foothold 结构化 | 无。Relay 只有自由字符串 `worker/src/relay.ts:56-72`；无 CredentialSchema / `credential_record` / `session_close` | 无 | 加 CredentialSchema（kind/asset/secretRef 指针/expiresAt/reuseCount）+ `credential_record`/`credential_list`（只回元数据）+ `tool_gate`/事件只记 credentialId | P2 | 单测断言明文 secret 不出现在 Observe、π 文件、tool_gate payload；两 worker 场景下 B 能按 id 查到 A 写的凭据元数据 | 未实现 |
| **P6-E3** parser lane | 无。`mcp_invoke`/`shell` 输出只截断进 chat（`worker/src/tools.ts`）；`asset-collectors.ts` 只做 FOFA/鹰图资产收集，不产 finding | 无 | 为 nmap `-oX/-oJ`、httpx `-json`、nuclei `-jsonl`、ffuf `-json` 加旁路解析：命中→recordAsset + `finding_record(tentative)`，原文写 `evidence/tool/<tool>-<ts>.txt` 并封 SHA-256；不可解析记 `parser=skip` | P2 | 三份 fixture JSON → 断言资产行数、tentative finding 数、证据 sha256 可复验；无法解析的输入不报错且事件写 skip | 未实现 |
| **P6-E3** HTTP 事务证据 | 无 `http_request` 工具；证据＝任意文件 + glob（`contracts/src/index.ts:312` evidencePatterns、`history/src/minimatch.ts:2`） | 无 | 新增 `http_request`（method/url/headers/body，过现有 `gateTool`），落 `evidence/http/<id>.req.txt` / `.res.txt`，允许 `finding_verify` 直接 cite `http:<id>` | P2 | 单测：`http_request` 产生 req/res 两文件并进入 evidence_versions；cite `http:<id>` 后 finding.evidence 含两者 sha256；越界 URL 被 gateTool 拒 | 未实现 |
| **P6-E4** 覆盖矩阵 asset×technique | 只有 goal 级：`history/src/index.ts:282` coverage_reviews(`goal_id`)、`:1986` recordCoverage、`:1977` listCoverage；路由 `server.ts:772` `POST /tasks/:id/coverage`；Intent 无 technique/assetRoot（`contracts/src/index.ts:598`） | `control-plane/src/coverage-support.test.ts`、`coverage-audit.test.ts`（均 goal 级） | Intent 加 `technique`(+assetRoot 派生)，新增 (asset,technique)→`untested` / `attempted` / `verified` 派生态 + `GET /tasks/:id/coverage-matrix` | P2 | 同一 asset 两条 Intent（X/Y）+ 一条 verified finding → 矩阵 X=verified、Y=attempted；该 finding 撤回后 X 回落 attempted | 部分验证（粒度＝目标，不是 asset×technique） |
| **P6-E4** 速率 / 破坏性闸 | 软约束：`contracts/src/index.ts:209` maxConcurrentExplores + `worker/src/soft-pace.ts`（只提示不终止）；硬拒绝只有主机级 `worker/src/tools.ts:72` DESTRUCTIVE_DENY（`rm -rf /`、mkfs、shutdown 等）；AuthScope 无 rateGuidance/rateLimit/timeWindow/roe | `worker/src/soft-pace.test.ts`；`tools.test.ts`（主机网络/破坏性拒绝） | AuthScope 加 rateGuidance/rateLimit/timeWindow/roe；`gateTool` 内可选 token bucket（拒时写 `tool_gate{ok:false,reason:"rate"}`）；`shell` 加 `destructive` 参数（需 `full` + 任务级 `--allow-destructive`） | P3 | 显式 `rateLimit.perHostRps=2` 时并发不超发且被拒一次留 `reason:"rate"`；`destructive=true` 在 capability<full 时被拒 | 部分验证（只有主机级 denylist，无 HTTP 速率、无破坏性分级） |
| **P6-E5** 变更台账 / 回滚 | 无。无 ChangeSchema / `change_record` / `gy rollback`；`skills/builtin/pentest-output-standards/SKILL.md` 仍要求人肉记账 | 无 | ChangeSchema + `change_record`（先备份写 beforeSha256）/`change_list` + `gy rollback <taskId> --out rollback.sh`（逆序、只生成不执行）+ 报告 §Changes | P2 | 三条 change 逆序生成脚本顺序正确且不执行；报告含未回滚项表；零记录时输出"未登记改动"提示 | 未实现 |
| **P6-E6** finding 级评测 | 无 `examples/finding-bench/`（现有 `examples/{dvwa-smoke,offline-review,tsecbench}`）；`package.json` 无 `review:findings` | `worker/src/offline-differential.test.ts`（字段还原口径，与 finding 无关） | 建 finding-bench 夹具 + `pnpm review:findings`：finding precision/recall、severity 一致率、repro 可复现率、每 finding token | 本轮不做（缺夹具材料） | `pnpm review:findings` 离线输出四指标表 + 逐项错答可定位；重跑逐字节一致 | 未实现（缺外部材料：人工底稿） |
| **P8** 项目记忆 | History Fact–Intent（`history/src/index.ts:222/235`）+ Relay π（`worker/src/relay.ts:26-108`）+ checkpoint（`worker/src/checkpoint.ts`）+ 证据 SHA（`history/src/goal-evidence.ts`、`evidence_versions` `index.ts:258`） | `history.test.ts`、`relay.test.ts`、`execution-trace.test.ts` | 无结构性缺口；只需固定"项目记忆是全局记忆唯一原料"的口径 | 本轮不做 | 现有三文件测试全绿；`relay.test.ts` 断言 π 注入文本结构 | 已验证 |
| **P8** 全局记忆（memory 表 / 档案索引 / MatchKey / 记忆图） | 无。全仓 `memory` 关键词只命中注释与 `offline-differential.ts` 的局部变量；无 memory 表、无 MatchKey、无 `GET /archive/contact`、无记忆图投影 | 无 | 建 memory 表（Lesson/Playbook/Counterexample/ToolArtifact/SourceRef/MatchKey，`derived_from` 强制非空）+ 只读联邦档案索引（返回指针）+ 分层 MatchKey 注入（仅 confirmed，N=5，落 `source=system` Hint）+ 记忆图只读 DTO | P4（本轮只做表与注入，不做控制台页面） | draft 不被注入；同 familyKey 命中注入 ≤5 条 title；档案查询返回 `{taskId,id,sha256}` 指针而非拷贝；缺 `derived_from` 的写入被拒 | 未实现 |
| **P9-F1** 记分卡 / 快照 / 离线复算 | `history/src/scorecard.ts:150` computeScorecard、`:138` snapshotSha256、`:142` finalizeSnapshot、`:262` scorecardFromSnapshot；`history/src/index.ts:1714` deliverySnapshot、`:1760` scorecard；`server.ts:517` `GET /tasks/:id/snapshot`、`:534` `GET /tasks/:id/scorecard`；CLI `apps/cli/src/index.ts:478`（`--out` 导出快照 / `--recompute` 离线复算）；控制台 `components/DeliveryScorecard.tsx` | `coverage-support.test.ts:137`（两次复算一致）；`delivery-assurance.test.ts:351/403`（快照复算 + sealValid + retractedReferences）；`a3-concurrency.test.ts` | 记分卡缺成本维度：无 token/墙钟、超时率、幻影调用数、交接损失、技能路由命中（数据源 `execution-trace.ts` / `usage.ts` 都在，只是没进快照） | P1 | `gy scorecard <id> --out s.json` 后 `gy scorecard --recompute s.json` 得 `sealValid:true`，且新增 token/墙钟/超时率字段非 null；改一字节后 sealValid=false 且退出码 2 | 部分验证（结构/复算已验证，成本维度缺） |
| **P9-F2** 趋势 / 提案 | 无。无 `/trends`、`/proposals`、`/evaluations` 路由与表（`Proposal`/`TrendPoint` 仅出现在并行未提交契约文件） | 无 | 跨任务聚合趋势 API（按批次的成功率/成本/复用率）+ 提案收件箱（五类提案必附证据链接，无证据拒收，审批写事件） | P4 | 无 evidence 链接的提案 POST 返回 400；带链接提案 approved 后写审计事件，`GET /proposals` 可见状态链 | 未实现 |
| **P9-F3** 冻结评测 / 晋升 / 回退 | 无。只有字节封存（`goal_proofs` `index.ts:261`、`evidence_versions` `:258`）与报告版本归档（`report.ts:13-25` 归档 `report-<sha12>.md`） | 无 | 冻结评测运行（development/holdout 分组）+ 晋升闸（人批 + 差分通过）+ 配置版本链与回退命令 | 本轮不做 | 晋升请求缺差分报告被拒；回退后读到的配置版本号递减且事件台账有记录 | 未实现 |
| **P10** 四图 API | 无 `/graph/*`。数据侧齐全：`server.ts:889` `GET /tasks/:id/assets`、`:807` `/history`、`:1035` `/trace`、`:1044` `/trace/:stepId`；DAG 只有控制台（`TaskDetailPage.tsx:388` 挂 `components/dag/FactIntentDag.tsx`） | 无（`api-entries.test.ts` 未覆盖任何 /graph） | 四个只读投影 DTO（asset/attack-surface/execution/memory）+ `GET /tasks/:id/graph/:view?filter=`；攻击面图须等 E3/E4 | P3（只做资产图、执行图两个投影） | `GET …/graph/asset` 的 seed→发现边来源可追到 `intent.sourceFactIds`；`GET …/graph/execution` 按 phase×slot 分泳道且节点数等于 `/trace` 条数 | 未实现 |
| **P10** "今日工作"入口 | 只有 `server.ts:1177` `GET /overview`（total/byStatus/active/recent 8 条） | 无 | 聚合入口：待复核、待答 consult、未测面、预算燃烧四类待办（只读建议层，不新造状态） | 本轮不做 | `GET /today` 四类计数与 `/overview`+`/scorecard` 同源可对账 | 未实现 |
| **P11** 后台作业 | 无 `job_submit/job_status/job_cancel`、无 job 注册表；只有 runner 内 spawn worker 与 `PAUSE_DRAIN_MS` 收尾（`runner.ts:570-606`） | 无 | chord job 承载的 job 注册表（detached，日志落 `evidence/jobs/<id>.log`）+ 终态 durable 通知回流（不轮询）+ 重启后 pid 探活与幂等补发 | P2 | 提交 3s 作业后模型轮次不增加；完成时 `root.submit` 恰好一次；重启后已完成未通知的补发一次且按 jobId 去重 | 未实现 |
| **P11** operator_consult / 24h 转非阻塞 | 无。无 consult 表/工具/路由，CLI 无 `gy answer` | 无 | `operator_consult{question,options,blocking}`（blocking 挂起当前 Intent、exploreTimeout 豁免）+ 24h 无回复自动转非阻塞（配置项）+ 回复以 `source=human` Hint 注入并唤醒 + 报告"人工决策"附录 | P2 | blocking consult 挂起期间其他 Intent 仍可 claim；可控时钟 +24h 后 consult 变非阻塞且任务不终止；`gy answer` 后出现 human Hint | 未实现 |
| **P11** 跨班 handoff API / 会话保活 | 无 HTTP 入口；Relay 只写 `workspace/relay/πN.json`（`relay.ts:26-108`）。保活只有 Watchdog 对 worker 租约续期与重启（`watchdog.ts:15`、`:121-140`） | `relay.test.ts`（文件级）、`watchdog.test.ts` | 会话/交接一等 API（`GET /tasks/:id/sessions`、`POST /tasks/:id/handoff`）+ detached 会话对象（暂停/崩溃存活、重启 reconnect） | 本轮不做 | worker 重启后 `GET /sessions` 仍列出同一 sessionId 且 state=alive；`POST /handoff` 产出的交接包能被下一 worker 读取并校验 | 未实现 |
| **P11** 暂停语义 | `contracts/src/index.ts:89` `stopping`、`:102` TaskStatusSchema、`:124` isDrainingTaskStatus；`runner.ts:570` pause（drain 确认后才写 `paused`）、`:618` resume；`POST /tasks/:id/{pause,resume,stop}`（`server.ts:382-404`）；CLI `index.ts:448/560` | `control-plane/src/pause-scope.test.ts`（paused 非终态非活跃、draining 不重启） | 补两件：① 暂停停表（`resume` 继续沿用原 `startedAt`，`runner.ts:360/483` `startedAt ?? now`，暂停时长照算墙钟）② 外部状态 `unknown` 显式态（worker-status 缺失时 `/runtime` 仍报 running） | P1 | pause 30s 后 resume，预算墙钟读数不含这 30s；删除 worker-status 后 `/tasks/:id/runtime` 返回 `unknown` 而非 running | 部分验证（有 paused/stopping/draining，无停表、无 unknown） |
| **P12-D1** 事实时效 / 待复核 | 无。FactSchema（`contracts/src/index.ts:572`）无 freshness/ttl/expiresAt；只有 Intent 租约过期（`index.ts:1235` expireStaleIntents）与材料侧 reconcile stale（`goal-evidence.ts:326/488`） | `history.test.ts:327`（intent 过期，不是 fact 时效） | Fact freshness 派生态（按资产类/事实类 TTL）+ 过期标"待复核"+ 周期 revalidation Intent + 差异写新 Fact（不改旧 Fact） | P3 | 可控时钟越过 TTL 后 `GET /history` 的 fact 带 `needsReview:true` 且原 Fact 仍在库；revalidation 产出差异 Fact | 未实现 |
| **P12-D3** 供应商韧性 | 只有 `worker/src/pi-loop.ts:1710` `fetch(/chat/completions)` + `:1719-1735` 4 次网络异常重试（1s/2s/3s），`:1741` 非 2xx 直接抛错（429/5xx 不重试、不切 provider）；`control-plane/src/settings.ts:427-455` 单 key | `worker/src/pi-model.test.ts`（解析），无 429/failover 用例 | key 池 + 多 provider failover（429/5xx 指数退避后切换）+ 燃烧率/剩余预算预测 + 分层模型路由 | P3 | 第一 provider 返 429 → 自动切第二 provider 并写 `provider_fault_handled` 事件；预测读数与 usage 记账一致 | 未实现 |
| **P12-D5** Planner | 无。Goal 无 parentGoalId/milestone；phase 只有 bootstrap/explore/reason/report（`graph-phase.ts:163+`） | 无 | Goal 加 parentGoalId/milestone + 自底向上 rollup + 规划者子会话（产出走 `intent_propose` 硬闸，只写 draft Fact/Hint） | 本轮不做 | 规划者产出落 draft Fact/Hint；绕过 intent_propose 的派单被拒；Goals 树 rollup 与 goal 状态一致 | 未实现 |
| **P12-D6** Assistant（有 pause 无 stop） | 无独立角色；`runner.pause` 存在但无任何自动调用方 | 无 | 辅助者轻量会话 + 信号源（错误率/闸命中/consult 紧急/scope 漂移）+ 仅 pause 权限（stop/resume/扩 scope 一律拒）+ 事故记录 draft | 本轮不做 | 辅助者工具面只含 pause/draft 写；调用 stop 被拒；自动暂停后任务为 `paused` 且留痕可复盘 | 未实现 |
| **P12-D8** 版本化交付证明 | `evidence_versions`（`index.ts:258`）+ `goal_proofs`（`:261`）+ 报告版本归档（`report.ts:13-25`）+ `GET /tasks/:id/report?version`（`server.ts:759`）+ 交付更正 `delivery_corrections`（`:393`）+ `gy correct` | `delivery-assurance.test.ts` A4/A5（字节不变、复算一致、更正幂等） | 缺三件：events 表无 `prev_hash`（`index.ts:306` 只有 id/task_id/kind/payload/created_at）→ 无哈希链；无 TSA 锚定；无 PTES/等保模板映射与 CVSS 4.0 | P1（只做事件哈希链 + 导出校验清单） | 事件链校验器从首条重算到末条全部匹配；篡改任一行 payload 后校验失败并指认断点 | 部分验证 |
| **委托边界** tenantId / engagementId | 建档默认：`contracts/src/index.ts:439/445`、`store.ts:96/98/153`；**唯一**强制点：`server.ts:682-708` 跨委托署名复核 409 | `api-entries.test.ts:168-197`、`data-root.test.ts:89-91` | 把边界下沉到查询层：`GET /tasks`、`/overview`、`/report`、`/evidence/file`、`/findings`、`/scorecard`、`/snapshot`、`/delivery` 全部按 tenantId+engagementId 过滤；`systemPrompt`（`pi-loop.ts:1186`）注入 engagementId；导出（`report.ts`）写委托标识 | P1 | 两 tenant 各建一任务 → `GET /tasks` 只回本 tenant；用另一 engagement 的读取头访问 `/report` 返回 403/404；systemPrompt 单测含 engagementId | 部分验证（仅 peer-review 一处） |
| **既有回归** | 37 个 `*/src/*.test.ts`（contracts 7 / control-plane 12 / history 7 / worker 11） | 见附 B | 无代码缺口；但**全新 worktree 必须先 build 再 test**，否则 history 6 个测试文件全部 `ERR_MODULE_NOT_FOUND: contracts/dist/index.js` | 本轮不做 | `pnpm -r run build && pnpm -r run test` → 163 pass / 0 fail | 已验证 |

---

## 2. 附 A：路由与委托校验现状（`packages/control-plane/src/server.ts`）

`tenantId` / `engagementId` 目前只在**建档**（`store.ts:96/98`）和**跨委托署名复核**（`server.ts:683`）被使用；其余全部路由既不读也不校验二者。

| 行号 | 路由 | 委托校验 |
| --- | --- | --- |
| 154 / 158-304 | `GET /health`、`/settings` 全家族（model/update/tools/asset-collectors 共 20 处） | ✗ 平台级，无 tenant 概念 |
| 309 | `GET /tasks` | ✗ `store.list()` 全量返回，无 tenant 过滤 |
| 325 | `POST /tasks` | △ 只把 `tenantId/engagementId` 落库（`store.ts:96/98`），不校验 |
| 364 | `GET /tasks/:id` | ✗ 任一路径 id 可读 |
| 382/386/390/398 | `POST …/stop` `/start` `/pause` `/resume` | ✗ 无委托校验（能否操作他委托任务取决于是否知道 taskId） |
| 406 | `POST …/scope` | ✗ 同上 |
| 431 / 446 / 478 | `GET …/findings`、`POST …/findings/:id/{verify,retract,retest,accept}` | ✗ |
| 517 / 534 | `GET …/snapshot`、`GET …/scorecard` | ✗ 导出即全量交付数据 |
| 544/554/594 | `…/corrections`、`…/corrections/:n/notice` | ✗ |
| 618/628 | `…/reconcile` | ✗ |
| 648/664 | `…/retest-requests` | ✗ |
| **674-708** | `POST …/peer-reviews` | ✓ 唯一强制执行点（`engagementId` 不等 → 409，`:683-685`） |
| 717 | `GET …/peer-reviews` | ✗ |
| 727/735 | `…/archive`、`…/unarchive` | ✗ |
| 739-772 | `…/logs`、`…/delivery`、`…/report`、`…/report?version` | ✗ 导出面无委托字段（`report.ts` 全文无 engagement/tenant） |
| 772/789 | `POST …/coverage`、`POST …/reviews` | ✗ |
| 807/858/870 | `GET/POST …/history` `/hints` | ✗ |
| 889/916/952/1010/1022 | `…/assets`、`…/evidence`、`…/evidence/file` | ✗ 证据原文件只要路径即可取 |
| 980 | `POST …/goals/assert` | ✗ |
| 1035/1044/1051 | `…/trace`、`…/trace/:stepId`、`…/runtime` | ✗ |
| 1177 | `GET /overview` | ✗ 跨 tenant 统计 |

模型请求侧：`systemPrompt`（`worker/src/pi-loop.ts:1186-1250`）只注入 `authorizationNote/targets/outOfScope/预算/能力阶梯`，**不含 engagementId、tenantId、roe、rateGuidance**；worker manifest 也没有这两个字段。

---

## 3. 附 B：回归读数

测试文件基数：`git ls-tree -r --name-only HEAD | grep -E '/src/.*\.test\.ts$' | wc -l` → **37**。

**首次**（干净 worktree 直接跑 `pnpm -r run test && pnpm -r run build`）：test **失败**，唯一原因是 `packages/contracts/dist` 尚未生成（在 `/tmp/r9-base` 里 `rm -rf packages/contracts/dist` 后单跑即复现）：

```
packages/history test: Error [ERR_MODULE_NOT_FOUND]: Cannot find module
  '/Users/sycpro/gongyuai-r9/packages/history/node_modules/@gongyuai/contracts/dist/index.js'
packages/history test: ✖ src/findings.test.ts (158.193875ms)
…（a3-concurrency / delivery-assurance / history / reconcile-firstpass / review-acceptance 同因）
packages/history test: ℹ pass 1 / ℹ fail 6
ERR_PNPM_RECURSIVE_RUN_FIRST_FAIL  @gongyuai/history@0.1.0 test
```

**先 `build` 再 `test`**（`pnpm -r run build` → BUILD_EXIT=0；再跑 `pnpm -r run test`）→ **163 pass / 0 fail**（clean copy `/tmp/r9-base` 与工作树两次读数一致）：

```
packages/contracts test: ℹ tests 41    ℹ pass 41    ℹ fail 0
packages/history   test: ℹ tests 50    ℹ pass 50    ℹ fail 0
packages/worker    test: ℹ tests 35    ℹ pass 35    ℹ fail 0
packages/control-plane test: ℹ tests 37 ℹ pass 37   ℹ fail 0
apps/cli           test: ℹ tests 0     ℹ pass 0     ℹ fail 0
```

尾部 20 行（`pnpm -r run test`）：

```
packages/control-plane test: ✔ leader terminal status stops a remaining worker before clearing its runtime handles (95.424208ms)
packages/control-plane test: ℹ tests 37
packages/control-plane test: ℹ suites 1
packages/control-plane test: ℹ pass 37
packages/control-plane test: ℹ fail 0
packages/control-plane test: ℹ cancelled 0
packages/control-plane test: ℹ skipped 0
packages/control-plane test: ℹ todo 0
packages/control-plane test: ℹ duration_ms 1755.50725
packages/control-plane test: Done
apps/cli test$ node --import tsx --test src/*.test.ts
apps/cli test: ℹ tests 0
apps/cli test: ℹ suites 0
apps/cli test: ℹ pass 0
apps/cli test: ℹ fail 0
apps/cli test: ℹ cancelled 0
apps/cli test: ℹ skipped 0
apps/cli test: ℹ todo 0
apps/cli test: ℹ duration_ms 2.518375
apps/cli test: Done
```

尾部 20 行（`pnpm -r run build`，BUILD_EXIT=0）：

```
apps/console build: rendering chunks...
apps/console build: computing gzip size...
apps/console build: ../../packages/control-plane/web/index.html                             0.47 kB │ gzip:   0.34 kB
apps/console build: ../../packages/control-plane/web/assets/FactIntentDag-CGuSgA2m.css     15.14 kB │ gzip:   2.75 kB
apps/console build: ../../packages/control-plane/web/assets/index-DzihNY17.css            520.76 kB │ gzip:  59.23 kB
apps/console build: ../../packages/control-plane/web/assets/FactIntentDag-B1I4Dssq.js     308.69 kB │ gzip: 107.12 kB │ map: 1,029.70 kB
apps/console build: ../../packages/control-plane/web/assets/index-CkF6Raet.js           1,483.50 kB │ gzip: 420.17 kB │ map: 5,685.28 kB
apps/console build: ✓ built in 2.84s
apps/console build: (!) Some chunks are larger than 500 kB after minification. Consider:
apps/console build: - Using dynamic import() to code-split the application
apps/console build: - Use build.rollupOptions.output.manualChunks to improve chunking
apps/console build: - Adjust chunk size limit for this warning via build.chunkSizeWarningLimit.
apps/console build: Done
packages/worker build$ tsc -p tsconfig.json
packages/control-plane build$ tsc -p tsconfig.json
packages/control-plane build: Done
packages/worker build: Done
apps/cli build$ tsc -p tsconfig.json
apps/cli build: Done
```

> 注：`build` 会写 `packages/*/dist` 与 `packages/control-plane/web`（构建产物，非源码）。若本轮要求"零副作用"，可在报告复验时改用 `pnpm -r run typecheck` + 先构建的容器卷。

---

## 4. 附 C：文档过期清单（以代码为准）

| 位置 | 文档说法 | 代码事实 |
| --- | --- | --- |
| `docs/attack-chain-graph.md:37` | 「`change.intentId`（E5 台账已有）；`credential.sourceFindingId`（E2 已有）」 | 全仓 0 命中 `ChangeRecord`/`change_record`/`CredentialSchema`/`credential_record`；`implementation-ledger.md:28` 自己标 P6-E2/E3/E4「未实现」 |
| `docs/MASTER-DESIGN.md:99`（同款措辞 `docs/pentest-ops-design.md:121`） | 生命周期「暂停**停表**；**会话保活、后台作业 SIGSTOP 冻结**，恢复续跑」 | 只有 `paused/pause_requested/stopping` 状态机；`resume` 沿用原 `startedAt`（`runner.ts:360/483`）→ 不停表；无作业对象、无会话对象 |
| `docs/pentest-enhancements.md:33-43`（§1.2） | 「全仓 `grep -i finding` 无 schema/表/工具」「`report.ts` 全篇无 finding 段」「凭据只是 π 里一个字符串」 | 已被本仓实现推翻：`contracts/src/finding.ts:60`、`history/src/index.ts:325`、`report.ts:118`；同文件 `:69` 已标 E1 ✅ —— 文档内部自相矛盾 |
| `docs/memory-layer.md:30` | 「项目 · 情景（黑板）✅ **14 表**全 task_id 作用域」 | HEAD 实为 **19 张** task 域表（facts/intents/goals/goal_checks/evidence_versions/goal_proofs/reconcile_revisions/coverage_reviews/fact_reviews/events/hints/leases/findings/finding_proofs/goal_findings/finding_actions/delivery_corrections/retest_requests/peer_reviews） |
| `docs/implementation-ledger.md:74` | 「本轮工程证据（受验代码 `d7c46d4…`）」 | 该 sha 是 HEAD 的祖先且落后 **18 个提交**；台账是历史快照，第九轮需换新受验 sha |

---

## 5. 与设计文档的产品级差距

1. **委托边界只有一处落地。** `tenantId`/`engagementId` 仅在建档写入、在跨任务署名复核处校验（`server.ts:683`）；`GET /tasks`、`/overview`、`/report`、`/evidence/file`、`/scorecard`、`/snapshot`、`/findings` 全部无过滤，交付导出（`report.ts`）与模型系统提示（`pi-loop.ts:1186`）都不带委托标识 —— 多客户场景下这是数据越界，不是"待完善"。
2. **"完成语义"已硬，"证据形态"仍软。** E1 的 finding 三闸（evidence 目录 + sha256 + repro）是真闸；但 HTTP 事务、工具结构化输出两条都没有，所以 finding 的证据仍是"人类可读文件"，机器无法验证"这条 finding 真的打过这个请求"。
3. **覆盖粒度和设计差一个维度。** 现有 `coverage_reviews` 主键是 `(task_id, goal_id)`，E4 要的是 `(asset, technique)`；没有 `Intent.technique`，攻击面图与"未测面清单"因此没有数据源，P10 攻击面图必须等 E4。
4. **"节点数"是这轮的假进度来源。** 主表 27 行里 **17 行"未实现"、7 行"部分验证"、3 行"已验证"**（已验证的 3 行＝P6-E1、P8 项目记忆、既有回归）。未实现的 17 行覆盖 E2/E3/E5/E6、P8 全局、P9-F2/F3、P10 两行、P11 三行（作业/consult/handoff）、P12 D1/D3/D5/D6。仓库已有 163 个通过测试与 19 张表，但测试密度只约束既有语义，对"新能力"零约束。建议本轮只把 P1、P2 各切一刀。
5. **暂停是状态机，不是保活层。** `paused` 能把 worker drain 干净并保留 checkpoint（真实现），但没有作业可冻结、没有会话可保活、墙钟不停；P11 生命周期里"暂停=一切继续执行的都停"这句话目前只兑现了三分之一。
6. **模型侧没有边界也没有韧性。** 模型请求只带 targets/预算（无 engagement、无 roe、无 rateGuidance），429/5xx 直接抛错终止（`pi-loop.ts:1741`），无 key 池/failover；数日长跑的第一个现实故障点就在这里，而不是在规划能力。
7. **记忆与飞轮在代码里是 0，在文档里是 P4/P8/P9 的全部。** 全局记忆缺的不是"表"，是 `derived_from` 强制 + 只注入 confirmed + 注入事件可审计这条链；飞轮缺的不是看板，是无证据不提案的拒收闸。
8. **文档状态标注整体可信，但陈述句与提案混写。** `implementation-ledger.md` 的 P0–P12 状态列逐行核对（17 行）与代码一致，唯一的硬冲突是 `attack-chain-graph.md:37` 把 E2/E5 写成"已有"；问题主要出在 `MASTER-DESIGN`/`pentest-ops-design`/`attack-chain-graph` 用陈述句写未实现能力，容易被下一轮当成"已有入口"直接跳过。


---

## 6. 本轮实施后对照（第九轮）

> 结论先写：**17 项"未实现"里，11 项本轮产生可用后端入口；4 项仍缺外部材料/不在本轮；2 项只做了契约级模拟。** 数字口径见下表，全部有单测或验收步骤支撑。

| 原设计项 | 本轮落点（代码） | 正常入口 | 单测 / 验收 | 剩余 |
| --- | --- | --- | --- | --- |
| 委托边界（原"仅 peer-review 一处"） | `contracts/src/ops.ts`（`visibilityDenial`/`taskBoundary`）、`control-plane/src/routes-ops.ts`（`boundaryOf`/`memoryVisible`） | 所有 `/tasks/:id/{handoff,consults,jobs,materials,coverage-*,freshness,changes,rollback,graphs,causality,roles,provider,memory,model-request,alerts}`；`/today`、`/memory/*`、`/archive/contact` | `contracts/src/ops.test.ts`「可见性」；`r9-ops` 越界读 2 步；`r9-flywheel` 客户 B 5 步 | 旧路由（`/report`、`/tasks` 列表等）尚未逐个加边界，见 §7 |
| P6-E1+ 撤回的失效影响 | `history/src/report.ts`「证据撤回影响」、`contracts deriveCoverageMatrix` | `GET /tasks/:id/report`、`/coverage-matrix`、`/graphs/surface` | `r9-ops` 撤回三步 + 报告三步 | finding 撤回仍不写"目标失去依据"事件（scorecard 的 `retractedReferences` 已覆盖读数） |
| P6-E2 凭据 | 材料侧 `secretRef`：`routes-ops.ts /materials` + `ImportMaterialSchema` | `POST /tasks/:id/materials` | `r9-ops`「凭据材料」3 步（明文 422、落盘无明文） | 无 Credential 表/`credential_record`/`session_close`；跨 Worker 复用未做 |
| P6-E3 parser lane | `jobs.ts` `parse-import`（对已导入材料做类型/行数/SHA 摘要并按证据落盘） | `POST /tasks/:id/jobs {kind:"parse-import"}` | `packages/history/src/ops.test.ts` 作业用例；CLI 可跑 | 未接 nmap/httpx/nuclei/ffuf 原始输出，`parser=skip` 未做 |
| P6-E3 HTTP 事务 | 材料 kind=`http-transaction`，记录 locator/资产/SHA；`derivedCoverageMatrix` 用它表达"材料存在" | `POST /tasks/:id/materials` | `r9-ops` 材料语义 | 无内置 `http_request` 工具；不能由 finding 直接 cite `http:<id>` |
| P6-E4 覆盖矩阵 | `contracts deriveCoverageMatrix`（六态 + `retractedOnly` + `independentSupport`）、`Intent.technique/assetRoot` | `GET /tasks/:id/coverage-matrix`、`POST /tasks/:id/coverage-cells`、`gy matrix` | `contracts/src/ops.test.ts`「覆盖矩阵」；`r9-ops` 矩阵 9 步 | 速率/破坏性硬闸未做（仍软节奏 + 主机级 denylist） |
| P6-E5 变更台账 | `history/src/ops.ts` `change_ledger` + `rollbackScript` | `POST/GET /tasks/:id/changes`、`GET /tasks/:id/rollback`、`gy change|changes|rollback` | `history/src/ops.test.ts`「变更台账」；`r9-ops` 未直接跑 CLI（单测覆盖逆序） | 报告 `## Changes` 表未加；`change_record` 工具未接 worker |
| P6-E6 finding 级评测 | `contracts findingMetrics` + `PlatformStore.recordEvaluation`（冻结、组顺序、隔离） | `POST/GET /evaluations`、`gy eval-run|evals` | `platform.test.ts` 15 例；`r9-flywheel` 冻结评测 7 步 | 缺 `examples/finding-bench/` 真夹具与 `pnpm review:findings`；指标分母已单列 |
| P8 全局记忆 | `PlatformStore`（memory_nodes/injections/events）、`matchMemory`、`/memory/*`、`/archive/contact`、记忆图 | `gy memory list|draft|review|refs|inject`、`gy contact`、`GET /tasks/:id/graphs/memory` | `platform.test.ts`；`r9-flywheel` 记忆 10 步 | 终态自动蒸馏、ToolArtifact 审核执行、控制台记忆页未做 |
| P9-F2 趋势/提案 | `PlatformStore` proposals + `/proposals`、`/trends` | `gy proposals|proposal|proposal-create|proposal-decide` | `r9-flywheel` 提案 6 步、趋势 1 步 | 提案只到"批准/晋升/回退"记录，未自动改运行时配置 |
| P9-F3 冻结评测/晋升/回退 | `recordEvaluation`（组顺序/隔离/冻结去重）、`promoteProposal`/`rollbackProposal` | `POST /proposals/:id/{promote,rollback}` | `r9-flywheel` 评测 7 步 + 提案 6 步 | holdout 只做了"隔离声明"，没有独立 holdout 调度器 |
| P10 四图 API | `control-plane/src/graphs.ts`（资产/攻击面/执行/记忆 + 因果） | `GET /tasks/:id/graphs/{assets,surface,execution,memory}`、`/causality/:findingId` | `r9-ops` 资产/攻击面 8 步；`r9-flywheel` 记忆图 1 步 | 前端画布未做；执行图的事件→步归属用 slot 近似 |
| P10 今日工作 | `handoff.ts todayWork` | `GET /today` | `r9-ops` 交接包间接覆盖；CLI `gy today` | 未测多任务排序/容量 |
| P11 后台作业 | `history/src/ops.ts` jobs + `control-plane/src/jobs.ts`（boot 对账、暂停三态、幂等回执、迟到结果、重试） | `POST/GET /tasks/:id/jobs*`、`gy jobs|job-submit|job-retry|job-ack` | `history/src/ops.test.ts` 4 例；`r9-ops` 作业 13 步（含 SIGKILL） | chord/detached 进程模型未做：作业在控制面进程内异步跑，进程死则 unknown（不假装成功） |
| P11 operator_consult / 24h | `consultations` 表 + `sweepConsult` | `/tasks/:id/consults*`、`gy consult|answer|consult-sweep` | `history/src/ops.test.ts` 1 例；`r9-ops` 24h 5 步 | 尚未由 worker 自动发起（需 `operator_consult` 工具） |
| P11 跨班 handoff | `handoff.ts assembleHandoff` | `GET /tasks/:id/handoff`、`gy handoff` | `r9-ops` 交接包 5 步 | 会话对象/重连未做；`nextOwner` 目前是调用方传入 |
| P12-D1 事实时效 | `contracts freshnessOf` + `GET /tasks/:id/freshness` | `gy freshness <task>?now=` | `contracts/src/ops.test.ts`；`r9-ops` 2 步 | 无周期 revalidation Intent / 凭据健康 monitor |
| P12-D3 供应商韧性 | `planProviderAttempt` + `/tasks/:id/provider` + 事件 | `gy provider-fault` | `contracts/src/ops.test.ts`；`r9-flywheel` 7 步 | 仅契约级模拟；`pi-loop` 仍单 key、非 2xx 抛错 |
| P12-D5 Planner | `roles.ts simulateRoleWork(plan)` + 后台作业 | `POST /tasks/:id/roles`、`gy role` | `r9-flywheel` 角色 6 步 | 无 Goal 树/milestone；未接真实模型 |
| P12-D6 Assistant | `roles.ts simulateRoleWork(incident)`；`enforceRoleAction` 限权；调 `runner.pause` | `POST /tasks/:id/roles {kind:"incident"}` | `r9-flywheel` 3 步 + 契约单测 | 信号源（错误率/金丝雀）未接真实事件；事故记录未生成 draft |
| P12-D8 事件哈希链 | 未做 | — | — | 仍缺 `prev_hash`/TSA/合规模板 |

### 6.1 仍然"未实现"或"只到契约"的清单（不许算进已验证）

- 会话管理器、隧道/pivot、开源 Chromium 浏览器（P11 S1/S3）。
- 凭据结构化表与工具（P6-E2 的完整形态）。
- 工具输出 parser lane 的四种真实格式。
- 速率硬闸 / 时间窗 / RoE / 破坏性分级（P6-E4 风控部分）。
- 事件哈希链、TSA、PTES/等保模板、CVSS 4.0（P12-D8）。
- 真实供应商 key 池、真实 429/余额演练、成本预测。
- 前端页面与 worker 侧自动接入（`operator_consult`/`memory inject`/作业唤醒）。

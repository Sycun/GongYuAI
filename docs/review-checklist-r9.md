# 第九轮独立复核清单（最短路径）

> 给独立复核人。每项给：已实现到哪里、最短复验命令、失败反例（做了应该失败）、证据路径、三端读数。
> 受验代码 / 文档提交 / Kali 运行版本三行读数在 §5（发布后回填）。状态口径同 [implementation-ledger.md](./implementation-ledger.md) §0。

## 0. 五分钟版

```bash
# 1) 代码与环境（全新副本必须先 build 再 test）
git clone https://github.com/Sycun/GongYuAI.git /tmp/gy-r9 && cd /tmp/gy-r9
git checkout <受验提交>
pnpm install --frozen-lockfile && pnpm -r run build
pnpm -r run test                    # 期望 195 pass / 0 fail
pnpm test:acceptance                # 校验器自测 8 项
pnpm smoke                          # PASS

# 2) 本轮两套验收（各自起停控制面、走 HTTP/CLI）
pnpm acceptance:r9:ops              # 期望 67/67（约 40s）
pnpm acceptance:r9:flywheel         # 期望 57/57（约 30s）

# 3) 既有回归
pnpm acceptance:business            # 77/77
pnpm acceptance:firstpass           # 69/69
pnpm e2e:engagement                 # 80/80
pnpm restore:selftest               # PASS（含源目录不可访问负例）

# 4) 三端读数
git ls-remote origin refs/heads/main
ssh parallels@10.211.55.5 'git -C /home/parallels/GongYuAI rev-parse HEAD; systemctl is-active gongyuai.service; curl -s localhost:8877/health'
```

## 1. P1 委托边界 / 持久作业 / 人工接手

| 项 | 已实现 | 最短复验 | 失败反例 | 证据 |
| --- | --- | --- | --- | --- |
| 委托与租户边界 | 新入口统一 `boundaryOf`：显式 `tenantId/engagementId` 不匹配即 403；任务级不传则按任务自身委托解释 | `curl -s -o /dev/null -w '%{http_code}' "localhost:PORT/tasks/<A>/jobs?engagementId=<B委托>"` → 403 | 用 B 的 `engagementId` 读 A 的任务级入口，若 200 即边界失效 | `docs/evidence/r9/r9-ops-*/acceptance-record.md`「越界读」两步 |
| 作业持久化 | `background_jobs` / `job_receipts` 表（任务自己的 History 库）；输入版本、进度、产物、失败原因、范围版本、`lateResult`、`pauseState` 全落库 | `POST /tasks/:id/jobs` → `GET /tasks/:id/jobs/:id`；`gy jobs <task>` | 删掉行里的 `scope_version` 或把 `running` 在重启后仍显示 `running`，即不可复核 | 同上「作业提交/重启对账」 |
| 进程中断可恢复 | 控制面 SIGKILL 后重启：上一代 `running` → `unknown`（不假装成功），`retry` 才重新入队 | 见 §2 手工复演 | 重启后直接 `succeeded`，或 `unknown` 被计入"完成" | `r9-ops` 步骤 7–13 |
| 暂停三态 | `jobPauseDisposition`：执行中→`draining`，未开始→`paused(stopped)`；重启→`unknown` | 单测 `packages/history/src/ops.test.ts`「暂停三态」 | 把 `draining` 显示成"已停止"即语义丢失 | 单测 + `r9-ops` |
| 回执幂等 | `UNIQUE(job_id, delivery_key)`；重复投递 `duplicate=true`，事件只记一次 | `gy job-ack <task> <job> --key k` 两次 | 第二次仍新增回执行/事件 | `r9-ops`「回执幂等」3 步 |
| 24h 求助转非阻塞 | `consultations.dueAt=+24h`；`sweep` 只把 `blocking=false`，`status` 仍 `open` | `POST …/consults/sweep {"now": createdAt+24h+1s}` | 到期后 `status` 变 `answered/closed`，或任务被终止 | `r9-ops`「24h 前后」三步 |
| 跨班交接包 | `GET /tasks/:id/handoff`：范围版本、已完成、受阻、最新撤回、待答问题、作业（含迟到）、下一责任人 | `gy handoff <task> --next-owner op-b` | 交接包缺少 `openQuestions`/`jobs`/`scopeVersion`，或 `needsAnswer` 全为 false | `r9-ops`「交接包」5 步 |
| Watchdog 零策略 | 未改动 watchdog；作业/求助不参与租约续期判定 | `packages/control-plane/src/watchdog.test.ts` | Watchdog 触发 pause/停作业即越权 | 既有单测 |

## 2. 进程中断的十分钟手工复演（可选）

```bash
pnpm gy serve --data-dir /tmp/gy-r9-manual --port 18999 &
# 建档 + 导入两份 CSV（见 r9-ops 记录的命令序列）
curl -s -X POST localhost:18999/tasks/<id>/jobs -d '{"kind":"material-check",...,"options":{"goalId":"g-diff","paceMs":1500}}'
sleep 1; kill -9 %1
pnpm gy serve --data-dir /tmp/gy-r9-manual --port 18999 &
curl -s localhost:18999/tasks/<id>/jobs/<job>            # 期望 status=unknown, pauseState=unknown
pnpm gy job-retry <id> <job> --base-url http://127.0.0.1:18999
curl -s localhost:18999/tasks/<id>/jobs/<job>            # 期望 succeeded + artifacts[0].sha256
```

## 3. P2 证据语义 / 覆盖矩阵 / 四图

| 项 | 已实现 | 最短复验 | 失败反例 | 证据 |
| --- | --- | --- | --- | --- |
| 四类材料 | `POST /tasks/:id/materials`：资产清单 / 配置核查 / 脱敏 HTTP 事务 / 人工复测；记录来源、解析器版本、时间、资产、SHA-256、定位 | `gy material <task> --path P --file F --asset A` | 任意文件都被标 `accepted` | `r9-ops`「材料语义」9 步 |
| 三种异常 | `unsupported`（格式/解析器）、`unknown-owner`（资产不在范围）、`expired`（超 TTL）分别落库并给原因 | 同上 | 三者任一被静默转成 `accepted`/`verified` | 同上 |
| 凭据受控引用 | 明文疑似凭据 → 422；`secretRef` 才接受，落盘只有指针+摘要 | `POST …/materials` 带 password 内容 | 证据文件里能 `grep` 到明文 | 「凭据材料」3 步 |
| 覆盖矩阵六态 | `deriveCoverageMatrix`：verified > manual > attempted > retracted > material > unknown；`retractedOnly` 单列 | `gy matrix <task>` | `retracted` 被 `material` 盖住（本轮修过一次，见 §6） | 单测 + `r9-ops`「矩阵」6 步 |
| 证据撤回一致性 | 撤回写 `evidence_removed{path,sha256}`；矩阵按**路径**判失效，独立依据继续有效；图边 `broken`；报告新增「证据撤回影响」段 | `DELETE /tasks/:id/evidence?path=http/tx-1.txt` 后比 `/coverage-matrix`、`/graphs/surface`、`/report` | 三处结论不一致（矩阵 retracted 但图仍 verified），或独立依据被一起判死 | `r9-ops`「撤回前/后」+ 报告 3 步 |
| 事实时效 | `GET /tasks/:id/freshness?now=` 派生态；原 Fact 不动 | 传 +40 天 `now` | 过期 Fact 被删除/改写，或不出 `needs-review` | `r9-ops`「事实时效」2 步 |
| 变更台账 | `POST/GET /tasks/:id/changes`；`GET …/rollback` 逆序脚本（只生成不执行）；`confirm` 记确认人 | `gy change …`、`gy rollback <task> --out r.sh` | 脚本顺序不是逆序，或服务端执行了脚本 | 单测「变更台账」 |
| 四图 API | `GET /tasks/:id/graphs/{assets,surface,execution,memory}`；统一 DTO，稳定 ID，断点 `broken` | `gy graph <task> surface` | 图里出现第二套状态/无源节点；记忆库未建立却返回非空 | `r9-ops`（资产/攻击面）、`r9-flywheel`（记忆图） |
| 同名资产不串客户 | 资产节点 ID = `asset:<engagementId>::<host>`；矩阵/图/记忆均按委托过滤 | 两客户各建同名任务，比较节点 ID 交集 | 交集非空，或下钻指针指向另一客户 | `r9-ops`「同名资产」4 步 + `r9-flywheel`「客户 B」4 步 |

## 4. P3/P4 记忆、飞轮、角色、韧性

| 项 | 已实现 | 最短复验 | 失败反例 | 证据 |
| --- | --- | --- | --- | --- |
| 记忆生命周期 | 候选→`draft`→`confirm/retract`；`supersedes`/`contradicts`；`supportRetracted` 标记；节点永不删除 | `pnpm tsx scripts/acceptance-r9-flywheel.ts` | draft 被注入；无 `provenance` 也能写；retract 删行 | `r9-flywheel` 全部 + `platform.test.ts` 15 例 |
| 无源不记忆 | `CreateMemoryDraftSchema.parse` + `provenance.min(1)` | `POST /memory/nodes` 空 provenance | 空 provenance 返回 201 | 同上 |
| 分层注入 | 硬键正常注入；仅 ≥2 软键算参考；标题层 N=5；命中当前资产 +2；只写 `source=system` Hint | `POST /tasks/:id/memory/inject` | 注入超过 5+2；把经验写成 Fact | 单测「记忆匹配」+ `r9-flywheel` |
| 客户隔离 | `/memory/nodes`、`inject`、`archive/contact`、`model-request` 均按 tenant/engagement 过滤 | 用客户 B 的上下文查 A 的节点/注入/模型请求 | B 的 Hint/模型请求里出现 A 的专属 marker | `r9-flywheel`「客户 B」5 步 |
| 历史接触 | `GET /archive/contact`：非阻塞、只回指针、`sameAsset`/`mayHaveDrifted` | `gy contact --targets app-a-1.example.com` | 返回全量任务或拷贝证据 | 同上 |
| F2 趋势/提案 | `/trends`、`/proposals`；无证据拒绝；approve/reject；晋升需冻结评测；回退保留 `promotedAt`/`evaluationRunId` | `gy proposals`、`gy proposal-promote` | 无证据提案通过；未批准可晋升；回退后丢失评测引用 | `r9-flywheel`「提案」6 步 |
| F3 冻结评测 | 组顺序登记；乱序 400；`isolatedFrom` 缺失 400；冻结用例替换 400；`pending` 单列；`recall=tp/(tp+fn)` | `gy eval-run --file f.json` | 交换组顺序能读到先跑组答案；pending 计入 FP/FN | `r9-flywheel`「冻结评测」7 步 + `platform.test.ts` |
| 角色分层 | Planner/Reviewer/Assistant 确定性模拟；辅助者仅 pause；输出 `authenticity:"simulated"`、`billing:"none"` | `gy role <task> --role assistant --kind incident --file s.json` | 辅助者能 stop/扩 scope/派单；模拟结果被当成真实模型收益 | `r9-flywheel`「角色」6 步 + 契约单测 |
| 供应商韧性 | 429/超时退避；余额不足切换；**外发受限禁止切换**；成本可见性按 billing；重复记账识别 | `gy provider-fault <task> --provider primary --fault egress-denied` | `egress-denied` 时仍 failover；`billing:none` 时显示省钱 | `r9-flywheel`「韧性」7 步 |
| 无进展告警 | `GET /tasks/:id/alerts`：最新 Fact 之后的 `tool_gate` 计数；等待答复期间抑制 | `curl '/tasks/<id>/alerts?threshold=2'` | 等待人工答复时仍告警；或把告警当终止条件 | `r9-flywheel` 最后 2 步 |

## 5. 三端读数（发布后回填）

| 项 | 读数 |
| --- | --- |
| 受验代码提交 | `e93c159ad8b3c8de467ba39051ddb6fe7d9b4e66`（[GitHub](https://github.com/Sycun/GongYuAI/commit/e93c159ad8b3c8de467ba39051ddb6fe7d9b4e66)） |
| GitHub `main` | `43898a10d65904d59e6e138d0bd6a93b7c671325`（证据/文档提交；受验代码是其祖先） |
| Kali 检出 / 运行 | `/home/parallels/GongYuAI-f2719556`（unit 的 WorkingDirectory，原地升级）；HEAD = `e93c159`；`MainPID=1860126`、监听进程 `cgroup=0::/system.slice/gongyuai.service`；`NRestarts=2` |
| 本轮新增验收运行 | `r9-ops-1795364124610`（67/67）、`r9-flywheel-1795364131957`（57/57），目录 `docs/evidence/r9/` |

## 6. 本轮自查发现并修掉的问题（复核时可重点反打）

1. **证据身份只按 sha 判失效**：最初撤回 `tx-1` 后，引用同路径的结论仍显示 `verified`（sha 不在撤回集合）。改为按**路径为主、sha 为辅**；矩阵优先级也调整为 `retracted > material`。
2. **任务视图目标状态滞后**：作业在终态之后通过 `assertGoal` 改了 History，`GET /tasks/:id` 仍读建档时的副本 → 现在任务视图合并 History 目标（`withLiveGoals`）。
3. **记忆图只看 confirmed**：反例是 draft，图上看不到 `contradicts` 边 → 记忆图改为展示全部状态（带徽章），注入仍只认 confirmed。
4. **无进展窗口按事件顺序取**：`listEvents` 是倒序，原实现从尾部找最新 Fact 实际拿到最旧一条 → 改为按 `createdAt` 取最新 Fact 再计数。
5. **recall 分母把待裁决算成漏项** → 改为 `tp/(tp+fn)`，`pending` 单列。
6. **资产追加规则失效**：只命中 `asset-class` 软键的节点进不了候选池，`+2` 永远不会触发 → 独立收集资产命中并受 `assetExtra` 上限。

## 7. 明确未验证（不要替本轮签收）

- 真实供应商 429/5xx/余额不足的**实际**行为：只做了契约级故障注入（`simulated`），无真实 key 池与真实账单。
- 真实生产效果：缺获准使用的脱敏真实委托、客户书面许可、平台结果产生前独立封存的人工底稿（见 [owner-unverified-r9.md](./owner-unverified-r9.md)）。
- 控制台页面：本轮不交付前端；所有图/矩阵/记忆只有 JSON API。
- Worker 自动发现→finding 的链路本轮未改；验收里的 finding 由脚本按 worker 同一 History 写入路径播种（记录中已注明）。

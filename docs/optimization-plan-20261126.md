# 长程自治与默认 3 并发优化计划 · 2026-11-26

背景：基于 `task_202611mm7lq98a1a`（Qoder 监控会话 `10fd5d65-5a63-4ab2-9d7b-0ac8d95ce4ed`）跑批复盘与源码核查，系统性修复长程卡死、Relay 空转、证据轮换粒度失真、看门狗崩溃风暴，以及「默认 3 并发 Explore Worker 未落地且多节点冷启动/扩容存在死锁」等全部问题。

配套文档：[tsecbench-retro-20261126.md](./tsecbench-retro-20261126.md) · [parallel-explore-scaling.md](./parallel-explore-scaling.md) · [pentest-evidence-rotation.md](./pentest-evidence-rotation.md)

---

## 一、根因校准清单（对昨夜复盘的核实与修正）

| 编号 | 问题域 | 源码真实根因 | 修复目标 |
|---|---|---|---|
| **R1** | `rotatePending` 轮换闸死锁 | `maybeForceEvidenceStall` 已将旧 Intent 置 `failed`、`activeIntentId=null`、切回 `reason`，但 `pi-loop.ts` 的 `beforeTool` 仍用 `rotatePending` 拦截除 `intent_conclude`/`relay` 外的所有工具（连 `operator_consult`/`intent_propose`/`phase_set` 一并封死），而 `rotatePending` 只在长 turn 结束后清除 | 移除 `beforeTool` 中的冗余全量阻塞闸门；轮换提示改走 `longTurn.notes` 随下次工具结果无损注入，旧面执行工具由 `phaseToolDenial` 自然拦截 |
| **R2** | `relay` 高频空转刷屏（π8→π64） | ① `relayTool` 返回的 `control.handoff` 在 `pi-durable` 中并不结束长 turn；② `afterTools` 将被 `beforeTool` 拦截的失败调用也计入 `toolCallsSinceRelay`，导致「被拦 2 次 → 解锁 `relay` → 再被拦 2 次」每 15s 空烧一次 | 仅统计实际放行且非 `relay` 的工具调用计入 `toolCallsSinceRelay`；补齐 `beforeTool` 拒绝落盘（`worker.log` + `tool_gate`）与连续被拒自纠偏熔断 |
| **R3** | `consultations=0` 误判校准 | `ops-tools.ts` 的 `operator_consult` 落库链路完好，昨夜为 0 纯因被 `rotatePending` 在 `beforeTool` 拦死 | 确保任何运行期软闸门永不拦截 `operator_consult` |
| **R4** | 21 题共用单条 Intent（轮换粒度失真） | `lastVerifiedEvidenceAt` 按全任务统计而非按当前 Intent 的 `assetRoot` 锚定，跨资产产出的 verified 证据会无限续命旧面 Intent | `lastVerifiedEvidenceAt` 支持按当前 Intent（`intentId` / `assetRoot`）限定牵引信号；`tsecbench start` 切换新容器时提示结项旧面 Intent |
| **R5** | 默认 3 并发未落地 & 槽位少 1 路 | `contracts`、`apps/cli`、`apps/console` 默认均为 `1`，且 Console 对 `targetCount <= 2`（如单条 CIDR `10.0.0.0/8`）强制推荐 `1` 锁死扩容上限；同时多节点时 `slot 0` 为纯调度 Leader，`workerCount=3` 实际只有 2 个 Follower 执行 Explore | 全局默认 `DEFAULT_MAX_CONCURRENT_EXPLORES = 3`；Console 默认与单 CIDR 推荐保底 `3`；当有效并发 `E >= 2` 时分配 `1 Leader (slot 0) + E Followers (slots 1..E)`，保证真 `E` 路并发执行 |
| **R6** | 多 Worker 下 TSecBench 冷启动死锁 & 扩容饥饿 & 木桶屏障 | ① `"tsecbench"` 被误放入 `FOLLOWER_ONLY_EXEC_TOOLS`，多节点下 Leader 无法 `list/start` 开题；② `syncGraphPhase` 在 `openIntents > 0` 时把多节点 Leader 从 `bootstrap/reason` 强踢回 `explore`，导致 Leader 提完第 1 个 Intent 就无法继续扇出第 2、3 个；③ `waitForPoolTurn` 要求 `open.length === 0` 才唤醒 Leader，1 道慢题会阻塞所有空闲 Follower（木桶效应）；④ `1 → N` 动态扩容时运行中 Leader 不感知新池规模 | ① 将 `"tsecbench"` 移出 `FOLLOWER_ONLY_EXEC_TOOLS`（多节点下 Leader 统一控 `start/close` 槽位并扇出，Follower 领单做 Explore + `submit`）；② `syncGraphPhase` 保持多节点 Leader 留在 `bootstrap/reason` 完成批量扇出；③ `waitForPoolTurn` 支持滑动补单（当 `proposed === 0` 且活跃认领数 `< follower 数` 时唤醒 Leader 补齐空闲槽位，无新面时防空转节流）；④ 动态扩容时实时刷新 `readPoolSize()` 并通知 Leader 收束交接 |
| **R7** | 全池崩溃无退避（流量代理崩溃循环） | `proxy.ts` 流错误已在 `aca1a6c` 修复，但 `watchdog.ts` 对全池崩溃（单节点或全挂）立即无条件 `runner.start` 重启，无指数退避 | 在 `Watchdog` 增加任务级全池快速崩溃指数退避（首崩秒愈，60s 内连崩按 5s→10s→20s→40s→60s 退避并写入 `task.error` 可观测状态） |

---

## 二、分模块实施细则

### 1. 契约与默认并发（`packages/contracts`、`apps/cli`、`apps/console`、`packages/control-plane`）
- 新增并导出 `DEFAULT_MAX_CONCURRENT_EXPLORES = 3`。
- `ExecutionConfigSchema`、`CreateTaskRequestSchema`、`TaskRecordSchema`、`WorkerManifestSchema` 默认 `maxConcurrentExplores` 统一设为 `3`。
- `apps/cli/src/index.ts`：`gy run` 未传 `--concurrency` 时默认 `DEFAULT_MAX_CONCURRENT_EXPLORES`（`3`）。
- `apps/console/src/pages/TasksPage.tsx` & `TaskDetailPage.tsx`：新建任务初始并发设为 `3`；`recommendedConcurrency(targetCount)` 改为 `Math.min(10, Math.max(3, targetCount))`，消除单 CIDR / 单域名被压成 `1` 无法动态扩容的缺陷。
- `packages/control-plane/src/runner.ts`：
  - 新增 `resolveWorkerSlotCount(exploreCount)`：`exploreCount <= 1 ? 1 : exploreCount + 1`（`slot 0` 专职零 Token 驻留协调 + `exploreCount` 个真并发 Explore Follower）；
  - 对挂载 `boardGate === "tsecbench"` 的非 mock 清板任务，启动期按靶场并发槽位 `Math.min(configured, 3)` 计算初始有效并发，开局即就位 `1 Leader + 3 Followers` 流水线。

### 2. Worker 长程稳定性与多节点调度（`packages/worker`）
- **`pi-loop.ts` & `relay.ts`**：
  - 删除 `rotatePending` 在 `beforeTool` 的工具封锁逻辑；`runExploreTimeoutGate` 触发轮换时直接将提示推入 `longTurn.notes`，由既有 `phaseToolDenial` 拦截无活跃 Intent 的执行类工具。
  - `beforeTool` 任何拦截均写入 `appendProgress`（节流摘要）与 `history.recordToolGate`；`operator_consult` 永不被软闸拦截。
  - `state.toolCallsSinceRelay` 仅统计通过 `beforeTool` 且非 `relay` 的真实工具调用，彻底切断「被拒调用攒够次数触发 `relay`」的空转回路。
  - 增加连续门禁拒绝纠偏计数（连续 8 步全被拒时自动附带当前相位合法动作提示）。
  - `"tsecbench"` 从 `FOLLOWER_ONLY_EXEC_TOOLS` 移除；动态池大小 `readPoolSize()` 接入 `phaseToolDenial` 与 `afterTools`，`1 → N` 扩容发生时向 Leader 推送一次性交接提示。
  - `waitForPoolTurn` 支持**滑动窗口补单**：多节点 Leader 在 `open.length === 0` 或（`proposed === 0 && active < exploreFollowers` 且活跃集合较上次补单已变化）时唤醒进入 `Reason` 补齐新题 Intent，消除慢题阻塞快槽的木桶效应。
- **`graph-phase.ts` & `tsecbench-tools.ts`**：
  - `syncGraphPhase`：多节点 Leader（`leader && workerCount > 1`）在 `bootstrap`/`reason` 扇出期间不因已有 `proposed`/`claimed` Intent 被误踢入 `explore`；无个人活跃 Intent 时自动归位 `reason`。
  - `fanoutPolicyFromExecution`：`maxIntentsPerReason` 自动保底 `>= maxConcurrentExplores`。
  - 多节点模式下 `tsecbench` 角色协同：Follower 调用 `close`（非本面）时加以保护提示，Leader `start` 新题或单节点跨题 `start` 时若仍挂着其他资产面的旧 Intent 则附注提醒先 `intent_conclude` 换面。
- **`evidence-rotation.ts`**：
  - `lastVerifiedEvidenceAt` 增加可选 `intent` 作用域过滤：当活跃 Intent 绑定了具体 `assetRoot` 时，仅统计归属该 `intentId` 且落在同资产面的 verified Finding / Credential / Live Asset（跨资产面新证据不再错误续命已耗尽的旧面 Intent）。

### 3. 控制面看门狗退避（`packages/control-plane/src/watchdog.ts`）
- 为全池死重启路径增加 `crashBackoff` 状态表：连续存活满 `60s` 自动清零；首次崩溃立即重启保自愈速度；60s 内重复崩溃按 `5s → 10s → 20s → 40s → 60s` 指数退避并在 `task.error` 暴露崩溃退避原因。

### 4. 二期深度加固（4 进程真跑隔离与 Token 效率优化）
- **多节点长 Turn 零成本让出休眠（`poolTurnYieldDirective`）**：当 Leader 已排满全部 Follower 槽位（或尾盘连续 4 步无可派新面）、或 Follower 无活跃 Intent 且暂无 `proposed` Intent 时，门禁指示直接回复 `YIELD` 结束当前 `root.submit()` 回到 `waitForPoolTurn()` 物理零 Token 休眠，并防止首轮 `YIELD` 误触发 OpenAI fallback。
- **跨进程靶标与解题流量同步**：Worker 侧 `assertCommandAllowed` 与 `http_request` 动态同步 `admitted-targets.json`；控制面 `runner.ts` 自动放行统一使用合并后的 `effectiveAuth`；`tsecbench-tools.ts` 通过 `tsecbench-hosts.json` 跨进程同步 `code → hosts` 映射并在解题成功缺 verified Finding 时提醒补齐取证闭环。
- **多进程共享文件竞态消除**：`ensureTaskCa` 与 `leafFor` 采用原子目录锁 + 进程唯一临时文件重命名，消除 4 进程并发启动时 `openssl` 公私钥错配；`relay.ts` 按槽位隔离 `workspace/relay`（slot 0）与 `workspace/relay-w<slot>`（followers）。
- **免除 Follower 文书税 & 难度梯队派单**：`bindEvidencePaceManifest` 对多节点 Follower 关闭共享报告/台账软催促（避免多进程互相覆写 Markdown，统一由控制面物化 + Leader 终审）；Bootstrap / Reason 明确按 `easy → medium → hard` 梯队铺开，避免开局死磕硬题阻塞流水线。

---

## 三、验证标准
1. **契约测试**（`@gongyuai/contracts`）：默认 `maxConcurrentExplores === 3`、槽位换算与扩缩容公式全绿。
2. **Worker 回归测试**（`@gongyuai/worker`）：
   - `evidence_stall` force-conclude 后**同一长 turn 内**可正常调用 `intent_propose` / `phase_set` / `operator_consult`，不死锁；
   - 被门禁拦截的工具调用不计入 `toolCallsSinceRelay`，不会空刷 `relay`；
   - 跨资产面的 verified 证据不会续命带具体 `assetRoot` 的旧耗尽 Intent；
   - 多节点 Leader 在连续 `intent_propose` 扇出时保持 `bootstrap`/`reason` 相位且保留 `tsecbench` 工具，滑动窗口补单无空转。
3. **控制面测试**（`@gongyuai/control-plane`）：`1 Leader + N Followers` 扩容测试、全池快速崩溃指数退避测试全绿。
4. **全仓构建**：`contracts` / `exec` / `history` / `worker` / `control-plane` / `cli` / `console` 编译通过。

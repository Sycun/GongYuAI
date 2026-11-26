# TSecBench 跑批复盘 · 2026-11-26（票 task_202611mm7lq98a1a，21/63）

## 结论先行
- 本次在 `acf44d6` 上跑自主清板，暴露两个长程 bug：**① 流量黑盒崩溃循环**（已修+提交 `aca1a6c`）；**② evidence_stall force-conclude 轮换闸死锁**（已定位，未修，待拍板）。
- ①修复后 agent 正常自主清板 **21/63 / score 5100 / ~75.5M token**，首解后节奏 ~3.7min/题、对齐上次成功跑批；②在解完 21 题、回到硬题 a-05 force-conclude 后触发，永久卡死、空烧 ~14M token。
- 票在 `gy pause` 等用户回复期间（~3.5h）自然到期（409 already finished）；**pause 保活 gongyuai 任务，但不延长平台票总寿命**。
- 纪律不变：只调度+修长程 bug、不替解；watchdog 触发先多源核实再判停。

## 发现① 流量黑盒崩溃循环（已修，commit aca1a6c）
- **根因**：`packages/exec/src/traffic/proxy.ts` 的 `spool()`/`capture()` 的 `forward` PassThrough、以及 finding-window skip 路径 `upstreamRes.pipe(res)` 均无 `'error'` 监听。fuzz 时目标连接 ECONNRESET → `source.on("error")` 调 `forward.destroy(err)` → PassThrough 抛未处理 `'error'` → worker `exit 1`，控制面反复重启成崩溃循环。
- **修复**：3 处加 error 监听（`done` promise 已 reject 由 `handle().catch`→502 兜底，流上监听只防进程崩）。回归测试 `upstream abort mid-body`（finding-window + all 两模式），exec traffic 7/7 绿。
- **教训**：新增流式/代理代码必须覆盖 abort/error 路径测试，不能只测正常往返。

## 发现② force-conclude 轮换闸死锁（未修 · 核心）
**精确根因链：**
1. `maybeForceEvidenceStall`（evidence-rotation.ts）在 15min 无新 verified 证据时 force-conclude activeIntent：置 failed、`activeIntentId=null`、`phase=reason`，返回 msg → `rotatePending` 置位。
2. beforeTool 闸 [pi-loop.ts:1658](../packages/worker/src/pi-loop.ts) 在 `rotatePending` 时**只放行 `intent_conclude`/`relay`，其余工具族全拦**。
3. `rotatePending` 仅在每轮 round 开头（pi-loop.ts:1874）清除，需**长 turn 结束**才到得了。
4. **session-kept relay（commit 54907ce）使 relay 不再结束 turn**；`intent_conclude` 因 `activeIntentId=null` 必失败（「conclude only active Intent」）。
5. → agent 只能 relay（不结束 turn）→ 永到不了 round 开头 → `rotatePending` 永不清 → 闸永久全拦。**死锁**。

**关键判定**：`runExploreTimeoutGate` 只调 `maybeForceEvidenceStall`，后者返回 msg 时 `activeIntentId` 必已 null。故闸是在「轮换已完成之后」拦工具——**纯冗余且有害**，拦掉了重入 explore 所需的 `intent_propose`/`phase_set`。

**交互副作用**：54907ce（session-kept）× acf44d6（graded stall 闸）。session-kept 前 relay 会结束 turn → round 开头清 `rotatePending` → 可恢复；session-kept 后暴露死锁。两处单独看都"对"，组合才致命。

**agent 自诊断准确**（durable entries 5534）：「闸门不区分工具族（读图/观察员/派单/相位/落盘/平台/求助/C2/Skill/OAST/traffic/MCP），不随会话/相位/Intent/assetRoot 变化…请重置闸门并清除 95e9b4c5 force-conclude 派生锁」。穷举 59 轮 / 46 代会话仍出不去。

**修复方向（待用户拍板）：**
- **A（最小）**：闸条件加 `&& state.activeIntentId`——force-conclude 后 `activeIntentId=null` 即不拦。因 `maybeForceEvidenceStall` 返回 msg 时必已清空，等效去掉冗余 block，保留 `timeoutNote` 提示。
- **B**：force-conclude 后立即清 `rotatePending`（只留提示，不当阻塞旗）。
- **C**：闸放行轮换工具（`intent_propose`/`intent_claim`/`phase_set`/`technique_transfer`）。
- **推荐 A 或 B**（去冗余 block + 保留提示）+ 回归测试：force-conclude 后**同一长 turn 内**能 propose+claim 重入 explore（覆盖 session-kept relay 不结束 turn 的情形）。
- **根因校准与已落修复（2026-11-26 复核）**：
  - `consultations=0` 并非 P11 wiring 缺口，而是 `operator_consult` 同样被 `rotatePending` 在 `beforeTool` 拦死未进入执行器；
  - `relay` 高频刷屏（π8→π64）根因是 `pi-durable` 不消费 `control.handoff` 结束长 turn，且 `afterTools` 曾将被拒调用计入 `toolCallsSinceRelay`；
  - 21 题共用单条 Intent 根因是 `lastVerifiedEvidenceAt` 未按 Intent `assetRoot` 锚定；
  - 默认 3 并发未生效根因是契约/CLI/Console 默认值写死 `1`、多节点槽位未区分 `1 Leader + N Followers`、且 `"tsecbench"` 曾被误放入 `FOLLOWER_ONLY_EXEC_TOOLS`。
  - 以上全部修复与回归测试见 [optimization-plan-20261126.md](./optimization-plan-20261126.md)。

## 过程教训
- **pause 不延长平台票寿命**：长程自治跑避免长时间 pause 等回复；或 watcher 在票到期前预警/自动续跑。本次 pause 等拍板 ~3.5h 致 409。
- **多源核实区分三态**：崩溃循环（修）、健康硬题攻坚（explore 阶段 shell + force-conclude 轮换，不停）、reason 死锁（全 reason 相位 + 元工具空转 + consult，停+反思）。watchdog≠停滞，看相位/工具族/命令内容/verified 证据。
- **instrumentation 缺口**：长程 bug 的工具拒绝原文只在 durable `entries.record`，worker.log 只记工具名+成功落盘。建议把 `intent_propose`/`phase_set` 的拒绝也 `appendProgress`，诊断不必挖 pi 会话。

## 明确不做
- 不替 agent 解题；本次不实现②修复（待拍板方向）；不引外部赛绩/token 当预期。
- ①已提交 `aca1a6c`（仅 proxy.ts + traffic.test.ts，未动并行会话的 console 改动）；未 push，Kali 同步前需 push 或备份 src 防 `git reset` 冲掉。
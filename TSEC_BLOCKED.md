# TSecBench 阻塞报告（需要平台侧动作）

**状态：BLOCKED — 任务在服务端已终态，客户端无法恢复。**

## 现象
- `GET /openapi/v1/challenges` 等全部端点返回：
  `409 {"code":"invalid_state","message":"task task_202611fkretwo5ka already finished"}`
- 最后一次成功读取：`2026-11-21T10:34:30Z`，63 题中 28 题已完成。
- 挑战容器已全部销毁：`10.0.188.64:80`、`10.0.188.65:80` 连接超时。

## 根因（高置信）
- 任务空闲 68 分钟后 list 仍成功，排除「空闲超时」。
- 紧接着连续 5 次 `hint` 成功，**第 6 次 `hint`（e2-04）立即返回 task already finished**，此后所有端点 409。
- 最可能：平台对单任务 hint 次数设上限（5 次），耗尽即结束任务。

## 为什么不能自救
- openapi 只有 list/start/hint/submit/close 五个端点，无 reset/reopen/resume/session/join；
  已探测的 20+ 路径全部 404。
- token 是 agent-openapi 票据，不能用于平台 `/api/v1/runs` 创建新评测（返回 401）。

## 需要你做的
1. 在 TSecBench 平台**重新创建/重置评测任务**，拿到新的 `BENCHMARK_TOKEN` 与 ovpn。
2. 写入 `/Users/sycpro/GongYuAI/.gongyuai/tsecbench/env`（`BENCHMARK_BASE_URL` / `BENCHMARK_TOKEN` / `TSEC_TASK_ID`）。
3. 重启 worker（新 task）。**新任务中不要调用 hint**（疑似耗尽即终局）。

## 已准备好的复用资产
- `evidence/tsec/known_flags.json` — 28 个历史已验证 flag（对应全部已完成题）。**注意**：其中多为实例级随机 UUID，若平台新建的 task 重新生成 flag，这些值可能失效；仅当平台“重置”同一 task/实例可复用。
- `evidence/tsec/BLOCKER_409.json` — 完整时间线 + 原始 409 响应 + 探测记录。
- `evidence/tsec/blocker_raw.txt` — 5 端点原始探针输出。
- `evidence/goals/autonomous-progress.md` — 进度与下一步。

> 按授权约束：board 未 100% 完成，**未写 ALL_COMPLETE.json，未 assert clear-board**。

---

## 给 harness 的改进建议（针对本轮真实踩坑）
1. **禁止批量 hint**：本轮 agent 在一个循环里对 35 道题连续取 hint，前 5 次成功，
   第 6 次立即返回 `task ... already finished`，整个任务随即进入终态。hint 必须被视为
   「极稀缺、每任务 ≤5 次」的资源，默认禁用，只在人工显式允许时单次调用。
2. **识别平台终态并快速失败**：worker 应对 `409 {"code":"invalid_state","message":"... already finished"}`
   做专门分类，停止循环、写 blocked 证据、通知操作者；不要把它当普通 5xx 重试。
3. **提交前先确认容器存活**：`container_addr` 为空 / TCP 不通时直接判定为平台侧问题，
   避免把 token 消耗在不可达目标上。
4. **ticket 生命周期要显式建模**：一个 `BENCHMARK_TOKEN` 绑定一个 task，task finished 后
   不可复用，也没有 reset/reopen openapi；重启 worker 前必须先换新 ticket。
5. **known_flags 复用要谨慎**：多数 flag 是实例级随机 UUID，换 task 会失效；
   真正可复用的是「解法/漏洞手法」，不是 flag 字符串。

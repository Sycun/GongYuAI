---
name: engagement-observer
description: >-
  读观察员与作业记分卡：重复失败、重复派单、停滞 Intent、tentative 积压、未经营高权重资产、
  凭据闲置。观察员只给建议，不派单、不改授权；忽略建议要有理由。用于长跑偏航、预算花错地方、
  或不知道该换面还是继续时。
metadata:
  tags: [渗透测试, 调度, 观察员, 经济性]
---

## 何时读

- 每个 Reason 唤醒先看 Observe 的「观察员 / 作业记分卡」。
- `repeat-failure` ≥3、`duplicate-open` ≥2、`stalled-intent`、`tentative-backlog` ≥3 出现时。
- 不确定「继续磨」还是「换面/收口」时。

## 六个信号与动作

| 信号 | 含义 | 建议动作 |
| --- | --- | --- |
| repeat-failure | 同 technique + 资产根尾部连续失败 ≥3 | 写否定证据 → intent_conclude(failed) → 换手法/换面 |
| duplicate-open | 同手法同资产根 open Intent ≥2 | 合并或关闭重复项，别让两个 Explore 撞车 |
| stalled-intent | claimed/running 45 分钟无更新 | 先 conclude/expire 留证据，再换面 |
| tentative-backlog | tentative finding ≥3 | 先 finding_verify（证据+repro）或 retract，再开新面 |
| unexplored-asset | 在范围主机从未被经营 | 先 asset_record / intent_propose；高权重优先 |
| idle-credential | 已验证凭据未复用 | 横向前先 credential_list 核对适用范围 |

## 记分卡

- `confirmationRate = confirmed / total`；没有 finding 时是 `null`。
- `gaps` 里「空台账不等于干净目标」是硬提醒：零 finding 不能写成「未发现高危」。
- 高权重未测资产是 Super-agent 的「前沿」：优先派单，不是平均用力。

## 工具

- Worker：`engagement_audit`（只读，完整 JSON）。
- CLI：`gy audit <taskId>`。
- 观察员不产生 Fact、不派 Intent、不改 scope；它的文字是建议层。

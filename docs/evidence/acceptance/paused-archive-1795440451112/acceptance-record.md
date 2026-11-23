# 已暂停任务归档 — 验收记录

> mock worker 流程验收：验证「已暂停或终态可归档」的归档条件、归档只改标记、
> 取消归档不自动执行、只有用户点击「继续」才恢复，以及运行中任务仍被拒绝。

运行　paused-archive-1795440451112
任务　054fdf07-fa4d-459e-a521-f0236784a360
代码提交　5247b6987ca7c772e834b36159c914f4e26f4a5c（工作区有未提交改动）
数据目录　/Users/sycpro/GongYuAI/.gongyuai/acceptance/paused-archive-1795440451112
完成时间　2026-11-23T13:27:33.990Z

| 步骤 | 结果 | 证据 |
| --- | --- | --- |
| 建档 | 通过 | POST /tasks → 201 |
| 运行中 | 通过 | 任务进入 running |
| 暂停 | 通过 | status=paused |
| 检查点留存 | 通过 | durable.sqlite 存在 |
| 归档请求 | 通过 | POST /tasks/:id/archive → 200 |
| 归档不改状态 | 通过 | status=paused（仍为已暂停） |
| 归档标记 | 通过 | archivedAt=2026-11-23T13:27:32.289Z |
| 移入已归档 | 通过 | 列表已归档视图包含该任务 |
| 离开未归档 | 通过 | 列表未归档视图不含该任务 |
| 刷新后仍已暂停 | 通过 | status=paused，归档标记保留 |
| 归档保留检查点 | 通过 | durable.sqlite 未被归档改动 |
| 归档保留历史 | 通过 | events=16（前后一致） |
| 归档保留目标状态 | 通过 | goals 前后一致 |
| 取消归档请求 | 通过 | POST /tasks/:id/unarchive → 200 |
| 取消归档只清标记 | 通过 | archivedAt=null |
| 取消归档不恢复执行 | 通过 | status=paused（仍为已暂停） |
| 回到未归档 | 通过 | 列表未归档视图包含该任务 |
| 离开已归档 | 通过 | 列表已归档视图不含该任务 |
| 无自动恢复 | 通过 | watchdog 两个周期后 status=paused |
| 继续请求 | 通过 | POST /tasks/:id/resume → 200 |
| 点击继续才恢复执行 | 通过 | status=initializing |
| 反例建档 | 通过 | POST /tasks → 201 |
| 运行中归档被拒绝 | 通过 | → 400 |
| 拒绝原因 | 通过 | 仅已暂停或终态任务可归档 |
| 运行中未被打上归档标记 | 通过 | archivedAt=null |
| 收尾停止 | 通过 | 054fdf07 → stopped |
| 收尾停止 | 通过 | bb391216 → stopped |

快照　delivery-snapshot.json（各阶段任务记录；清单含字节哈希）

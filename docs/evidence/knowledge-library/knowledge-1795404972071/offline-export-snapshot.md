### 6.4 状态与连续性

| 机制 | 实现 | 观测证据 |
|---|---|---|
| 每题事实图 | `.sapper/facts/*.json`，typed facts + doc + hints + intents | 255 次 `sapper fact`、198 次 `sapper graph`、195 次 `sapper status` |
| 跨 pane 共享 | w2+ 挂 `.sapper` symlink | b-02 5 个 pane、a-03 16 个会话共享同一图 |
| Commander 交接 | `/work/runs/commander-state.md` <150 行 | 2 任 commander（1148 + 1153 步），06:14 换任，靠 STATE 续接 |
| Worker 上下文续接 | 续接会话 2577360 | a-03 决胜提交就在续接会话里（184 步，07:15:56 提交） |
| 看门狗 | key 轮换、pane `--continue` 重启、重发 mission、5 分钟冷却 | drive.log 的 `[watch]` 行（[`drive_log_watchdog_excerpt.txt`](prompts/drive_log_watchdog_excerpt.txt)） |
| 会话记忆 | `~/.claude/projects/-work-runs-<code>/memory/` | a-03-w3 写 `a03-solve.md` 并更新 `MEMORY.md` |

经与作者沟通确认，Commander 交接发生在指挥官与指挥官之间，用于处理 8 小时长时运行的上下文容量约束：系统设置 90% 自动压缩，指挥官在 85% 时主动写 `commander-state.md`，记录分配、弃置、队列、情报和下一步；下一任指挥官读取该文件，接着调度。

**STATE 文件示例（06:14 换任时，[`commander_state_0614.md`](prompts/commander_state_0614.md)）：**

```text
ITERATIONS: 112
DEADLINE: 02:30:04 (2026-10-18)  |  budget_left ~4h18m  |  CAPS: instances 2/3, panes 5/8, generals 2
SCORE: 61/63 codes, 81 flags. Left: a-03(0/1), b-02(4/6) = 3 flags outstanding.

## Allocation
| code | panes | state |
| a-03 | w1 GENERAL | session-forge cracker 412k/s... |
| b-02 | w2 GENERAL + w3,w4,w5 ds | 4/6. w5 = SSH-BRUTE PLAYBOOK from b-01 ... |

## b-01 SOLVED (1140pts) final chain
- LFI services.php?lang= ... -> log poisoning -> RCE webshell /p.php
- panel 172.19.0.3 operator:Password -> flag2 + core-zone intel
- jump 172.19.0.2 SSH devops:Admin123 -> flag3/flag4 in core zone

## CRITICAL MECHANICS
- `--general` ALONE does NOT upgrade model — ALWAYS --model "glm-5.3[1m]" + verify.
- w2+ panes share the code's graph via .sapper symlink. kill <code> --close in ONE call.
- Hints cost 10%. b-family = pivot chains. b-03 solved 4/4.
```

这份 STATE 同时是“架构的证据”：它记录了资源上限、比分、分配表、家族 playbook、以及一个工具 bug（`--general` 不自动升级模型）。**换任通过读 STATE 文件继续。**
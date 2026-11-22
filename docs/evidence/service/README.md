# Kali 正式实例的服务托管证据（第七轮）

| 文件 | 内容 |
| --- | --- |
| `systemd-switch.txt` | 22:04 受控切换：切换前单元 inactive/dead、MainPID=0、8877 由用户会话进程 1644897 持有；切换后 active/running、MainPID 1665169、监听进程 1665201 在 `/system.slice/gongyuai.service`、cwd 与数据目录正确 |
| `systemd-crash-recovery.txt` | 22:13 故障恢复：`kill -9` MainPID 1675680 后 systemd 自动拉起（NRestarts=1、MainPID 1675967），入口健康、14 个任务与 kali-demo 历史仍可读、监听进程在新目录且在同一 cgroup |
| `deploy-prepare.txt` | 从受验提交 `f34cc03` clone 新目录、本机安装构建、迁移配置与数据（14 个任务目录） |
| `deploy-switch.txt` | 切换单元到 `/home/parallels/GongYuAI-f34cc032`，逐项核对（active、MainPID、cgroup、cwd、数据目录参数、任务数、健康） |
| `gongyuai.service.txt` | 切换后的单元文件：`WorkingDirectory`、`EnvironmentFile`、`ExecStart` 全部指向新目录，没有任何旧目录引用 |
| `systemd-state.txt` | 22:16 现场读数（`systemctl show` + `ss -ltnp`） |

重启验证（受控 `systemctl restart`）：22:05 记录，MainPID 1665169 → 1665371，14 个任务、kali-demo 5 事实/15 事件仍可读。

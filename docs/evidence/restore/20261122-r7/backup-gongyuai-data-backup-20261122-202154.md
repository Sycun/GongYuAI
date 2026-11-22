# 恢复隔离演练 — backup-gongyuai-data-backup-20261122-202154
时间　2026-11-22T14:13:49.959Z
归档　/home/parallels/gongyuai-data-backup-20261122-202154.tar.gz
归档 SHA-256　cef807d98dc0567b2ff8fa58764c9a295ae6965465bfc938c60d8e24a89d1925（21217525 字节）
| 检查 | 结果 | 说明 |
| --- | --- | --- |
| archive.tasks | 通过 | 归档内 11 个任务 |
| archive.records-point-at-formal | 通过 | 11/11 条记录的 dataDir 指向正式目录 |
| archive.demo-counts | 通过 | kali-demo 归档读数：事实 4、事件 14 |
| tasks.ids | 通过 | 11 项，与副本目录一致（11 项） |
| restore.rehomed | 通过 | 改写目录归属 11 条（期望 11）（如 e9d288f8-4580-4a42-813f-ec66c93d63a3: /home/parallels/GongYuAI/.gongyuai/tasks/e9d288f8-4580-4a42-813f-ec66c93d63a3 → /tmp/gy-restore-backup-kKwxUp/extract/.gongyuai/tasks/e9d288f8-4580-4a42-813f-ec66c93d63a3） |
| tasks.dataDir-in-copy | 通过 | 全部任务 dataDir 在副本内 |
| port.loopback | 通过 | 隔离实例地址 http://127.0.0.1:34925 |
| isolated.no-watchdog | 通过 | isolated=true（不自动续跑、不导入旧数据根） |
| api.demo-counts-match-archive | 通过 | API 事实 4、事件 14；归档 4/14 |
| api.demo-report-bytes | 通过 | 报告字节哈希 df3b63ad417f… = 归档文件 df3b63ad417f… |
| api.evidence-bytes-match-archive | 通过 | 2/2 份证据字节一致 |
| formal.differs-from-backup | 通过 | 正式实例 5/15 vs 备份 4/14（隔离实例返回的是备份读数） |
| api.returns-backup-not-formal | 通过 | 隔离实例事实 4，既不等于正式 5，也等于归档 4 |
| seal.chain-absent | 通过 | evidence_versions=0、goal_proofs=0、goal_findings=0：旧备份没有封存原件，封存链无法验证（结论保留，不用新备份冒充） |
| snapshot.recompute | 通过 | 快照可复算：历史 2/2、当前 0/2、归属未知 2 |
| tasks.ids | 通过 | 11 项，与副本目录一致（11 项） |
| restore.rehomed | 通过 | 改写目录归属 1 条（期望 1）（如 e9d288f8-4580-4a42-813f-ec66c93d63a3: /tmp/gy-restore-backup-kKwxUp/decoy/tasks/e9d288f8-4580-4a42-813f-ec66c93d63a3 → /tmp/gy-restore-backup-kKwxUp/extract/.gongyuai/tasks/e9d288f8-4580-4a42-813f-ec66c93d63a3） |
| tasks.dataDir-in-copy | 通过 | 全部任务 dataDir 在副本内 |
| port.loopback | 通过 | 隔离实例地址 http://127.0.0.1:37145 |
| isolated.no-watchdog | 通过 | isolated=true（不自动续跑、不导入旧数据根） |
| decoy.copy-wins | 通过 | 把记录改指诱饵目录后，API 仍返回副本报告（df3b63ad417f…） |
| tasks.ids | 通过 | 11 项，与副本目录一致（11 项） |
| restore.rehomed | 通过 | 改写目录归属 0 条（期望 0） |
| tasks.dataDir-in-copy | 通过 | 全部任务 dataDir 在副本内 |
| port.loopback | 通过 | 隔离实例地址 http://127.0.0.1:36851 |
| isolated.no-watchdog | 通过 | isolated=true（不自动续跑、不导入旧数据根） |
| decoy.copy-wins-without-source | 通过 | 诱饵目录不可访问时同样成立 |
结论：隔离恢复读取全部留在副本内。

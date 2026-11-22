# 恢复隔离演练 — sealed-gongyuai-data-backup-20261122-221527-sealed
时间　2026-11-22T14:15:42.863Z
归档　/home/parallels/gongyuai-data-backup-20261122-221527-sealed.tar.gz
归档 SHA-256　1109faa35bcbcfb4a869b67a7d7c48b62731dd12d49daeae358754e6fc6e8197（21421622 字节）
| 检查 | 结果 | 说明 |
| --- | --- | --- |
| tasks.ids | 通过 | 18 项，与副本目录一致（18 项） |
| restore.rehomed | 通过 | 改写目录归属 18 条（期望 18）（如 e9d288f8-4580-4a42-813f-ec66c93d63a3: /home/parallels/GongYuAI-f34cc032/.gongyuai/tasks/e9d288f8-4580-4a42-813f-ec66c93d63a3 → /tmp/gy-restore-sealed-329NsE/extract/.gongyuai/tasks/e9d288f8-4580-4a42-813f-ec66c93d63a3） |
| tasks.dataDir-in-copy | 通过 | 全部任务 dataDir 在副本内 |
| port.loopback | 通过 | 隔离实例地址 http://127.0.0.1:44619 |
| isolated.no-watchdog | 通过 | isolated=true（不自动续跑、不导入旧数据根） |
| sealed.proofs-present | 通过 | 恢复出 8 条首次通过依据（封存原件） |
| sealed.version-readable | 通过 | 读取封存版本 kali/baseline.json（30 字节，哈希 beb9b648eb17…） |
| sealed.snapshot-offline-recompute | 通过 | 离线复算通过：封印 f4f70bbc2dec…，历史 1/1、当前 1/1 |
结论：隔离恢复读取全部留在副本内。

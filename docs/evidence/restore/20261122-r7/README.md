# 恢复隔离演练（第七轮，两次分开记录）

两套演练用的判定逻辑是同一份 `scripts/restore-isolation.ts`，都以 `isolated` 启动
（不导入 `~/.gongyuai`、不起 watchdog、不自动续跑），都用随机回环端口，正式实例全程未停。

命令（在程序目录里执行，`GY_FORMAL_BASE` 默认 `http://127.0.0.1:8877`）：

```bash
node --import tsx scripts/restore-isolation.ts backup <archive.tar.gz> --out out/restore-isolation
node --import tsx scripts/restore-isolation.ts sealed <archive.tar.gz> --task <taskId> --out out/restore-sealed
```

## 一、原备份的隔离恢复（`backup-gongyuai-data-backup-20261122-202154.md`）

- 归档：`/home/parallels/gongyuai-data-backup-20261122-202154.tar.gz`，
  21,217,525 字节，SHA-256 `cef807d98dc0567b2ff8fa58764c9a295ae6965465bfc938c60d8e24a89d1925`。
- **11 个任务**：归档里的 11 条记录 `dataDir` 全部指向正式目录 `/home/parallels/GongYuAI/.gongyuai/tasks/…`；
  隔离启动时逐条收回，改写条数 11/11（改写只发生在解出来的副本里）。
- **kali-demo（`e9d288f8…`）**：归档里 4 条事实、14 条事件；隔离实例 API 返回 **4/14**；
  同一时刻正式实例是 **5/15**。隔离实例既等于归档、又不等于正式实例——这正是上一轮反例的位置。
- 证据与报告字节哈希：`recon/banner.txt`、`goals/report.md` 两份证据 API 字节 = 归档字节；
  报告字节哈希 `df3b63ad417f…` = 归档文件。
- 诱饵反例：把副本记录改指一个可访问的诱饵目录（里面有 `DECOY-FORMAL-REPORT`），启动后 API 仍返回
  副本报告；把诱饵 `chmod 000` 再启动同样成立。
- **验证上限**：该备份的 11 个任务 `evidence_versions=0`、`goal_proofs=0`、`goal_findings=0`，
  所以“封存原件 ↔ 交付记录”这一层核对不了；能核对的是字节一致、计数一致与快照可复算
  （快照复算：历史 2/2、当前 0/2、归属未知 2）。这条结论保留，不用新备份冒充。

## 二、含封存原件的工程备份（`sealed-…-497126a0.md`）

- 归档：`/home/parallels/gongyuai-data-backup-20261122-221527-sealed.tar.gz`，
  21,421,622 字节，SHA-256 `1109faa35bcbcfb4a869b67a7d7c48b62731dd12d49daeae358754e6fc6e8197`（本轮正式实例的全量备份）。
- 恢复出 **18 个任务**、**8 条首次通过依据**（封存原件）。
- 指定本轮正式入口验收任务 `497126a0-93ac-4c9b-b293-acd380759f40`：读取封存版本
  `reconcile/kali-eng-diff-20261122141507.json`（1688 字节，SHA-256 `478da5dfc3d0…`，与首次通过依据一致），
  再从快照离线复算：封印 `84bca91a3ed5…`，历史 1/1、当前 1/1，`sealValid` 成立。
- 不指定任务的那一次（`sealed-…-sealed.md`）落在另一条旧任务的封存件 `kali/baseline.json` 上，
  同样通过（8 条依据都读得到）。

## 三、两次演练的区别

| 项 | 原备份（20:21:54） | 工程备份（22:15:27） |
| --- | --- | --- |
| 目的 | 证明“读的是副本不是正式目录” | 证明“恢复 → 读封存版本 → 离线复算” |
| 有封存原件 | 无（0 条） | 有（8 条） |
| 结论 | 隔离读取成立；封存链无法验证 | 封存链成立 |

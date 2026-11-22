# 复核清单（最短可执行路径）

给只拿到代码与证据包的复核人。每条都写清「命令 → 期望」，不依赖本机隐藏状态。
受验代码 `d7c46d4956246ba448b565136683daf155af1c62`；记录提交见 [delivery-record.md](./delivery-record.md) §2。

## 0. 版本与提交

```bash
git ls-remote origin refs/heads/main
git log --oneline -3
git diff --stat d7c46d4 HEAD -- ':!docs'     # 期望：空（记录/回执只改文档与证据）
```

## 1. 构建与测试（受验代码上）

```bash
pnpm install --frozen-lockfile
pnpm -r run build          # 期望 exit 0
pnpm -r run test           # 期望 126 通过 / 0 失败（contracts 28、history 35、control-plane 28、worker 35）
pnpm test:acceptance       # 期望 2 通过：交叉配对必须失败、改字节不改内容封印
pnpm smoke                 # 期望 PASS（含 findings gate 失败臂）
```

## 2. 哪次运行对应哪个版本（验收清单）

```bash
pnpm verify:acceptance docs/evidence/acceptance/engagement-1795354631468
pnpm verify:acceptance docs/evidence/acceptance/business-1795354653869
```

期望：两者均「全部通过」。关键断言与含义：

| 检查项 | 含义 |
| --- | --- |
| `manifest.code.commit` | 该运行对应的代码提交（应为 `d7c46d4…`，且 `dirty=false`） |
| `snapshot.seal` | 快照**内容封印**（去掉 `sha256` 字段后对 canonical payload 计算） |
| `snapshot.file.bytes` | 快照**文件字节哈希**（确认交付的就是这份文件） |
| `snapshot.distinct-from-bytes` | 两者必须不同，不能混用 |
| `scorecard.points-at-this-snapshot` | 记分卡引用的哈希 = 这份快照的封印 |
| `scorecard.numbers` | 纯函数复算的分子/分母 = 清单数字 |
| `record.json.taskId` / `record.json.runId` | 记录与清单是同一次运行 |

反例（必须失败）：

```bash
pnpm verify:acceptance docs/evidence/acceptance/engagement-1795354631468 \
  --record docs/evidence/acceptance/business-1795354653869
```

期望：`结论：存在失败项`，失败项含 `record.json.taskId`、`record.json.snapshotSha256`、`record.json.runId`、`record.md.bytes`。存档见 `docs/evidence/acceptance/cross-pair-rejection.txt`。

## 3. 独立复算一条业务差异

```bash
pnpm acceptance:business          # 34 步；先核对 expected.json 封存哈希，再四项逐项比对
```

或手工最小复算（不需要平台）：

```bash
node --import tsx -e '
import { parseMaterial, reconcileMaterials, ReconcileRequestSchema } from "@gongyuai/contracts";
import { readFileSync } from "node:fs";
const dir = "docs/evidence/acceptance/business-fixtures";
const req = ReconcileRequestSchema.parse({
  name: "asset-diff",
  baseline: { path: "assets/baseline.csv" }, current: { path: "assets/current.csv" },
  keyField: "host", requiredKeys: ["app-a-1","app-a-2","app-a-4","app-a-6"],
});
const baseline = parseMaterial({ path: req.baseline.path, content: readFileSync(`${dir}/baseline.csv`,"utf8"), keyField: "host" });
const current  = parseMaterial({ path: req.current.path,  content: readFileSync(`${dir}/current.csv`,"utf8"),  keyField: "host" });
const r = reconcileMaterials({ request: req, baseline, current });
console.log(r.counts, r.items.map(i => [i.key, i.status, i.baselineLine, i.currentLine, i.changes]));
'
```

期望：`added 1, removed 1, changed 2, unchanged 1, missing 1`，共 6 项；`app-a-1` 变更 `version 1.4→1.5`（行 2/2）。

## 4. 独立复算一条交付结论

```bash
# AS_OF=<记录里的 taskId>
pnpm gy scorecard <taskId> --out /tmp/snap.json
pnpm gy scorecard --recompute /tmp/snap.json | head -20
```

期望：`sealValid: true`；`historicallyPassed` / `currentlySupported` / `denominator` / `coverage` 与
`docs/evidence/acceptance/engagement-1795354631468/acceptance-manifest.json` 的 `scorecard` 字段一致
（4/4、2/4、分母 4、已测 1/部分 1/受阻 1/未登记 1）。

## 5. 备份恢复到了什么程度

阅读 `docs/evidence/restore/20261122-kali-backup/README.md` 与 `drill.log`，然后抽查：

- 备份文件仍在且哈希一致：`sha256sum /home/parallels/gongyuai-data-backup-20261122-202154.tar.gz`
  → `cef807d9…`。
- 恢复出的任务清单 = 备份内 `control.sqlite` 的 11 个任务（README §3 与恢复实例的 `/tasks` 一致）。
- 证据与报告字节一致、离线复算通过（README §5）。
- 上限：备份时点没有 `goal_proofs`/`evidence_versions`/`report-evidence/`，所以“封存原件 ↔ 记录同源”无法核对（README §6）。

## 6. Kali 正式入口

```bash
ssh parallels@10.211.55.5
readlink /proc/$(systemctl show gongyuai.service -p MainPID --value)/cwd   # 若 unit inactive，用 ss -ltnp 取 8877 的 pid
git -C /home/parallels/GongYuAI rev-parse HEAD
curl -s http://127.0.0.1:8877/health
curl -s http://127.0.0.1:8877/tasks | head -c 200
ls -d /home/parallels/GongYuAI* ; ls -l /home/parallels/gongyuai-data-backup-*.tar.gz
```

期望：HEAD = 受验代码（或记录提交，非 docs 差异为空）；`tasks` 14 个；`GongYuAI.old-*` 不存在；
两份备份 tar 权限 `-rw-------`；`/home/parallels/GongYuAI-hosted-build` 仍在且未被触碰。

## 7. 生产盲评仍缺什么

见 [delivery-record.md](./delivery-record.md) §9：需要获准的脱敏历史委托、独立人工底稿、客户书面确认。
缺任一项时报告与台账都写「生产盲评待验证」，不用夹具或模型输出替代。

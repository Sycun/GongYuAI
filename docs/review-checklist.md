# 复核清单（最短可执行路径）

给只拿到代码与证据包的复核人。每条都写清「命令 → 期望」，不依赖本机隐藏状态。

**本轮（第八轮）受验代码 `f2719556d19dc7c5d35063e45d78bed70c19f031`（tree `657929f`）**，
对应 [delivery-record.md](./delivery-record.md) §0。上一轮（第七轮，受验 `f34cc03`）的清单保留在 §0A。

## 0. 本轮（第八轮）最短路径

```bash
git ls-remote origin refs/heads/main                 # 期望 f271955…（其后只有 README.md 与 docs/** 提交）
git diff --stat f271955 HEAD -- packages apps scripts # 期望为空（只有 README.md 与 docs/** 变化）
bash scripts/clean-regression.sh f2719556d19dc7c5d35063e45d78bed70c19f031 /tmp/gy-clean
# 期望：163 单测通过、校验器 8 项、smoke PASS、跨日 80/80、业务 77/77、首次通过 69/69、失败步骤 0
```

```bash
pnpm --filter @gongyuai/history test        # 期望 50 通过（含 reconcile-firstpass 11 例）
pnpm --filter @gongyuai/contracts test      # 期望 41 通过
pnpm --filter @gongyuai/control-plane test  # 期望 37 通过（含 business-goal-api 5 例）
pnpm acceptance:firstpass                   # 期望 69 项全过
```

```bash
# 反例读数（不经 UI，直接读 Kali 现场归档的证据）
python3 -c "import json;r=json.load(open('docs/evidence/round8/kali-console-acceptance.json'));[print(k, v['taskId'], v['goal']['passes'], v['goalAssertedEvents'], len(v['firstPassProofs']), v['adoptedReconcile']['revisionId'], v['adoptedReconcile']['baseline']['sha256'][:12], v['adoptedReconcile']['current']['sha256'][:12]) for k,v in r['tasks'].items()]"
# 期望：三笔任务各 1 条首次通过事件、1 份 goal_proofs；adoptedReconcile 的两侧哈希等于该 revision 里记录的哈希
```

```bash
# Kali 现场核对
systemctl show -p ActiveState -p MainPID -p WorkingDirectory gongyuai.service   # active / 1735540 / GongYuAI-f2719556
readlink /proc/$(pgrep -f 'gy serve' | head -1)/cwd                              # 同一目录
git -C /home/parallels/GongYuAI-f2719556 rev-parse HEAD                          # f271955…
curl -s localhost:8877/health                                                    # {"ok":true}
curl -s localhost:8877/tasks | python3 -c 'import json,sys;print(len(json.load(sys.stdin)["tasks"]))'  # 22
```

界面复核：任务 `a0c5638d…` / `bf6b3bac…` / `c8c451d3…` 的目标页应显示「核算态 · 已通过」
「首次通过采用的输入版本：r…」「基线 … SHA-256 …」「当前 … SHA-256 …」「结果文件 … SHA-256 …」；
`c8c451d3…` 的历史里还能查到期中那版冲突重复键（`app-a-1`，当前第 2、3 行）的歧义结论与拒绝原因。
截图见 `docs/evidence/round8/`。

## 0A. 上一轮（第七轮）清单（保留备查）

受验代码 `f34cc032cd9c4061a9212758595b34cf8d5fc2e0`（tree `e9d5649`）；发布回执见
[`docs/evidence/release/receipt.json`](./evidence/release/receipt.json)。

### 0A.1 版本与提交

```bash
git ls-remote origin refs/heads/main                 # 与回执 github.mainAtReceipt 对照
git log --oneline -5
git diff --stat f34cc03 HEAD -- ':!docs'             # 期望：只有 scripts/kali/formal-acceptance.py
```

> 受验提交之后的提交只追加验收证据与 Kali 入口驱动脚本，不改运行时源码。
> 本地工作区若出现别人的未提交改动（例如 `packages/control-plane/src/chat.ts`），与本轮交付无关，不要混进证据。

## 1. 构建与测试（在受验提交的干净副本上）

```bash
git clone <repo> /tmp/gy-review && cd /tmp/gy-review && git checkout f34cc03
pnpm install --frozen-lockfile
pnpm -r run build          # 期望 exit 0
pnpm -r run test           # 期望 140 通过 / 0 失败（contracts 35、history 38、control-plane 32、worker 35）
pnpm test:acceptance       # 期望 8 通过：交叉配对 1 例 + 字节/封印分离 1 例 + 五个负例 + 发布记录 1 例
pnpm smoke                 # 期望 PASS
bash scripts/clean-regression.sh f34cc032cd9c4061a9212758595b34cf8d5fc2e0 /tmp/gy-clean
                           # 一条命令跑完：安装/构建/单测/校验器/smoke/80 步跨日/77 步业务验收/恢复自测
```

## 2. 哪次运行对应哪个版本（验收清单）

```bash
pnpm verify:acceptance docs/evidence/acceptance/engagement-1795356668890 \
  --expect-commit f34cc032cd9c4061a9212758595b34cf8d5fc2e0
pnpm verify:acceptance docs/evidence/acceptance/business-1795356691440 \
  --expect-commit f34cc032cd9c4061a9212758595b34cf8d5fc2e0
```

期望：两者均「全部通过」（各 30 项）。关键检查项：

| 检查项 | 含义 |
| --- | --- |
| `code.commit.object` | 运行时提交是本仓库里真实存在的 Git 对象（全零/自造串会在这里失败） |
| `code.commit.expected` | 该提交等于 `--expect-commit`，或冻结发布记录里该 runId 的 `codeCommit` |
| `code.clean` | 运行时 `dirty=false`；标为 dirty 的运行不能签“干净发布版本已验证” |
| `snapshot.seal` / `snapshot.file.bytes` / `snapshot.distinct-from-bytes` | 内容封印与文件字节哈希是两件事，且必须不相等 |
| `scorecard.numbers` | 分母、历史通过、当前支持、归属未知逐项等于快照复算 |
| `scorecard.coverage` | **每类覆盖数**逐字段等于快照复算（只改 `tested` 为 99 就会失败） |
| `record.json.scorecard` | 记录里的记分卡与快照复算三向一致 |
| `record.json.steps.failed` / `manifest.steps.failed` | 自报失败的运行不能汇总成通过 |
| `record.json.taskId` / `record.json.runId` | 记录与清单是同一次运行 |

负例（全部必须非零退出并指出失败字段，已存档）：

```bash
bash scripts/validator-negatives.sh docs/evidence/acceptance/engagement-1795356668890 \
  f34cc032cd9c4061a9212758595b34cf8d5fc2e0 /tmp/negatives.txt
cat docs/evidence/acceptance/validator-negatives.txt     # 五个负例 + 原件通过
pnpm verify:acceptance docs/evidence/acceptance/engagement-1795356668890 \
  --record docs/evidence/acceptance/business-1795356691440 \
  --expect-commit f34cc032cd9c4061a9212758595b34cf8d5fc2e0
# 期望：结论「存在失败项」，9 项失败（任务 ID、快照封印、记录字节、记分卡三向…）
# 存档：docs/evidence/acceptance/cross-pair-rejection.txt
```

## 3. 缺件不得判通过（本轮核心修复）

```bash
pnpm acceptance:business        # 77 步；先核对 expected.json 封存哈希，再逐项比对
```

该脚本里第三段就是完整状态变化，输出可直接核对：

1. 只交当前清单 → 核算 `missingMaterials=["assets/baseline.csv"]`、`unknown 5/5`；任务 `incomplete`；
   目标未通过；记分卡当前支持 **0/3**；报告写出“缺少基线材料 assets/baseline.csv”。
2. 事件台账里有 `goal_assert_rejected`，原因点名缺件材料。
3. 补交基线 → 重新核算 → 从 `/resume` 重新判定 → 目标 `gated-both-lists` 首次通过，
   首次通过依据只有一份 `reconcile/gated-diff-*.json`，事件 `adoptedReconcile.sha256` 与 `goal_proofs` 一致，
   重复提交不新增依据。

单元级最小复现（不需要平台）：

```bash
node --import tsx --test packages/history/src/history.test.ts     # 含三条核算条件用例
node --import tsx --test packages/contracts/src/reconcile.test.ts # 含重复主键与物理行号用例
```

## 4. 重复主键与 CSV 行号

业务验收第 7–10 段即正常入口实测：空行占行号的第 3 行变化、冲突重复主键标歧义并列出全部来源行、
内容相同的重复行收敛为一行、CRLF + 引号内逗号不偏移。预期值全部来自事先封存的
`docs/evidence/acceptance/business-fixtures/expected.json`。

## 5. 恢复副本不得读回正式目录

```bash
pnpm restore:selftest --out /tmp/restore    # 20 项：双胞胎反例 + 源目录不可访问后复验
```

Kali 上的两次演练记录（原备份 / 含封存原件的工程备份）见
[`docs/evidence/restore/20261122-r7/README.md`](./evidence/restore/20261122-r7/README.md)：

- 原备份：11 个任务，`kali-demo` 归档 4 事实/14 事件，隔离实例返回 **4/14**，同一时刻正式实例 5/15；
  11 条记录全部收回副本；诱饵目录与 `chmod 000` 两种反例都成立；封存链 0 条 → 上限保留。
- 工程备份：18 个任务、8 条封存依据；指定任务 `497126a0…` 读回封存版本并离线复算通过。

## 6. Kali 正式入口与 systemd

```bash
systemctl is-enabled gongyuai.service     # enabled
systemctl is-active gongyuai.service      # active
systemctl show -p MainPID -p WorkingDirectory -p SubState gongyuai.service
ss -ltnp 'sport = :8877'                  # 监听 PID
cat /proc/<listener-pid>/cgroup           # 期望含 /system.slice/gongyuai.service
readlink -f /proc/<listener-pid>/cwd      # 期望 /home/parallels/GongYuAI-f34cc032
curl -s http://127.0.0.1:8877/health
```

现场读数与重启/故障恢复记录：`docs/evidence/service/`（`systemd-switch.txt`、`systemd-crash-recovery.txt`、
`deploy-prepare.txt`、`deploy-switch.txt`、`gongyuai.service.txt`、`systemd-state.txt`）。

正式入口的独立工程验收任务：`497126a0-93ac-4c9b-b293-acd380759f40`，材料与断言见
[`docs/evidence/kali-formal/README.md`](./evidence/kali-formal/README.md)。

## 7. 离线复算交付快照

```bash
pnpm gy scorecard --recompute docs/evidence/kali-formal/delivery-snapshot.json
# 期望 sealValid=true；分母 1、历史 1/1、当前 1/1、归属未知 0、覆盖 未登记 1
```

## 8. 仍然缺的（不要用工程夹具替代）

生产盲评：需要一份获准使用的脱敏历史委托、查看平台结果前独立封存的人工底稿、客户书面确认。
三项缺任一项，本清单只支持“工程可认定”，不支持“真实生产效果已验证”。
